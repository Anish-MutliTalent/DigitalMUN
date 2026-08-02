/**
 * @mun/desktop — main-process backend orchestrator
 *
 * Owns the auth client, realtime WebSocket client, monitoring engine, crypto
 * client, and encrypted store. The IPC layer (ipc.ts) delegates every renderer
 * call here and forwards realtime/state updates to the window.
 *
 * Lifecycle:
 *  - init():         load persisted state; if tokens present, attempt refresh +
 *    reconnect (auto-resume after restart/crash).
 *  - login():        authenticate → persist → (delegate) register voting key →
 *    connect realtime → start monitoring.
 *  - logout():       stop monitoring → disconnect → revoke → clear store.
 *  - Server events:  monitoring_paused/resumed → engine pause/resume;
 *    rules_updated → engine + store; force_logout → logout.
 */

import { randomUUID } from 'node:crypto';
import { AuthClient } from './auth/client.js';
import { RealtimeClient, type WsState } from './realtime/client.js';
import { MonitoringEngine } from './monitor/engine.js';
import { cryptoClient } from './crypto/client.js';
import { store } from './store/encrypted.js';
import { APP_VERSION } from './config.js';
import { dialog, shell } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ServerEnvelope,
  type VoteChoice,
  type VoteCastAckPayload,
  type AiDetectionRule,
  type ConnectionStatus,
  type Submission,
  type SubmissionType,
} from '@mun/protocol';
import type { ConnectionInfo, MonitoringState, PersistedState, LoginResult } from '@shared/ipc';

export interface BackendCallbacks {
  sendToRenderer: (env: ServerEnvelope) => void;
  onConnection: (info: ConnectionInfo) => void;
  onMonitoring: (state: MonitoringState) => void;
}

export class MunBackend {
  private authClient: AuthClient;
  private realtime: RealtimeClient;
  private engine: MonitoringEngine;
  private pendingAcks = new Map<string, (ack: VoteCastAckPayload) => void>();
  private monitoringState: MonitoringState = {
    active: false,
    paused: false,
    currentAppName: null,
    away: false,
    flagged: false,
    lastEventAt: null,
  };
  private pausedReason: string | null = null;

  constructor(private cb: BackendCallbacks, private platform: 'windows' | 'macos') {
    store.load();
    this.authClient = new AuthClient(store.get().serverUrl);
    this.realtime = new RealtimeClient({
      getUrl: () => this.wsUrl(),
      getAccessToken: () => store.get().accessToken,
      platform: this.platform,
      clientVersion: APP_VERSION,
      onStateChange: (s) => this.handleWsState(s),
    });
    this.realtime.onMessage((env) => this.handleServerEnvelope(env));
    this.engine = new MonitoringEngine({
      delegateId: () => store.get().delegate?.id ?? null,
      committeeId: () => store.get().delegate?.committeeId ?? null,
      platform: this.platform,
      emit: (event) => this.realtime.sendMonitorEvent(event),
      onState: (s) => {
        this.monitoringState = {
          active: this.engine.isActive() && !this.engine.isPaused(),
          paused: this.engine.isPaused(),
          currentAppName: s.currentAppName,
          away: s.away,
          flagged: s.flagged,
          lastEventAt: s.lastEventAt,
        };
        this.cb.onMonitoring(this.monitoringState);
      },
    });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  async init(): Promise<void> {
    // Always start at the login screen. If a previous session is persisted,
    // revoke it server-side so the delegation/position is freed for re-join,
    // then clear the local store.
    const state = store.get();
    if (state.refreshToken) {
      const refreshed = await this.authClient.refresh(state.refreshToken).catch(() => null);
      if (refreshed) {
        await this.authClient.logout(refreshed.accessToken).catch(() => {});
      }
    }
    store.clear();
    this.cb.onConnection(this.getConnection());
  }

  async login(username: string, password: string): Promise<LoginResult> {
    const state = store.get();
    const result = await this.authClient.login(username, password, state.deviceId, this.platform);
    if (!result.ok) {
      if ('reloginRequired' in result) {
        return {
          ok: false,
          reloginRequired: true,
          requestId: result.requestId,
          message: result.message,
        };
      }
      return { ok: false, error: result.error };
    }
    await this.completeAuth(result.response);
    return { ok: true, response: result.response };
  }

  async join(committeeId: string, country: string): Promise<LoginResult> {
    const state = store.get();
    const result = await this.authClient.join(committeeId, country, state.deviceId, this.platform);
    if (!result.ok) {
      if ('reloginRequired' in result) {
        return {
          ok: false,
          reloginRequired: true,
          requestId: result.requestId,
          message: result.message,
        };
      }
      return { ok: false, error: result.error };
    }
    await this.completeAuth(result.response);
    return { ok: true, response: result.response };
  }

  async getJoinOptions(): Promise<
    Array<{ committeeId: string; committeeName: string; countries: Array<{ country: string; delegateId: string; taken: boolean }> }>
  > {
    return this.authClient.getJoinOptions();
  }

  /**
   * Shared post-auth setup: persist session, register the delegate voting key,
   * connect realtime, and start monitoring for delegates on an active committee.
   */
  private async completeAuth(response: import('@mun/protocol').LoginResponse): Promise<void> {
    store.update({
      user: response.user,
      delegate: response.delegate,
      committees: response.committees,
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      rules: response.rules,
    });
    this.engine.updateRules(response.rules);

    if (response.user.role === 'delegate' && response.delegate) {
      const pub = this.ensureDelegateKey();
      // Best-effort registration; ignore if already registered.
      await this.authClient.registerKey(response.accessToken, pub).catch(() => {});
    }

    this.realtime.connect();

    if (response.user.role === 'delegate' && response.monitoringActive) {
      this.engine.start();
    }
  }

  async logout(): Promise<void> {
    this.engine.stop();
    this.realtime.disconnect();
    const token = store.get().accessToken;
    if (token) await this.authClient.logout(token);
    store.clear();
    this.pendingAcks.clear();
  }

  async refreshSession(): Promise<boolean> {
    const state = store.get();
    if (!state.refreshToken) return false;
    const refreshed = await this.authClient.refresh(state.refreshToken);
    if (!refreshed) {
      // Refresh failed (session revoked/expired) — clear the user too so the
      // renderer returns to the login screen instead of a stuck offline state.
      store.clear();
      this.cb.onConnection(this.getConnection());
      return false;
    }
    store.update({ accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken });
    this.realtime.connect();
    if (state.delegate) {
      this.engine.updateRules(state.rules);
      this.engine.start();
    }
    return true;
  }

  // ─── Voting ────────────────────────────────────────────────────────────────

  async castVote(voteId: string, choice: VoteChoice): Promise<VoteCastAckPayload> {
    const delegate = store.get().delegate;
    if (!delegate) throw new Error('Not a delegate');
    const clientCastId = randomUUID();
    const publicKey = this.ensureDelegateKey();
    const signature = cryptoClient.signVote({ voteId, delegateId: delegate.id, choice, clientCastId });

    const ackPromise = new Promise<VoteCastAckPayload>((resolve) => {
      this.pendingAcks.set(clientCastId, resolve);
      // Timeout fallback.
      setTimeout(() => {
        const r = this.pendingAcks.get(clientCastId);
        if (r) {
          this.pendingAcks.delete(clientCastId);
          r({
            voteId,
            clientCastId,
            accepted: false,
            receipt: null,
            reason: 'Timeout waiting for server acknowledgement',
            submittedCount: 0,
            requiredCount: 0,
          });
        }
      }, 10000);
    });

    this.realtime.sendCastVote({ voteId, choice, signature, publicKey, clientCastId });
    return ackPromise;
  }

  async requestRelogin(reason: string): Promise<void> {
    // Re-login is driven by the login endpoint; here we just expose it so the
    // delegate can re-attempt login (which records the request server-side).
    void reason;
  }

  async cancelRelogin(requestId: string): Promise<void> {
    const token = store.get().accessToken;
    if (token) await this.authClient.cancelRelogin(token, requestId);
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  getState(): PersistedState {
    return store.get();
  }

  clearState(): void {
    store.clear();
  }

  async setServerUrl(url: string): Promise<void> {
    this.authClient.setServerUrl(url);
    store.update({ serverUrl: url });
  }

  getServerUrl(): string {
    return store.get().serverUrl;
  }

  async getServerPublicKey(): Promise<string> {
    return (await this.authClient.getServerPublicKey()) ?? '';
  }

  getConnection(): ConnectionInfo {
    const ws = this.realtime.getState();
    return {
      ws: ws === 'open' ? 'open' : ws === 'idle' || ws === 'closed' ? 'closed' : 'connecting',
      monitoring: this.engine.isActive() ? (this.engine.isPaused() ? 'paused' : 'active') : 'inactive',
      pausedReason: this.pausedReason,
    };
  }

  getMonitoring(): MonitoringState {
    return this.monitoringState;
  }

  async apiRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }> {
    const token = store.get().accessToken;
    try {
      const res = await fetch(`${store.get().serverUrl}${path}`, {
        method,
        headers: {
          // Only send a JSON content-type when there is a body — Fastify rejects
          // "Body cannot be empty when content-type is set to application/json".
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { status: res.status, data };
    } catch (err) {
      return { status: 0, data: { error: (err as Error).message } };
    }
  }

  // ─── Submissions (resolutions / directives) ─────────────────────────────────

  async submitLinkSubmission(
    committeeId: string,
    type: SubmissionType,
    title: string,
    url: string,
  ): Promise<{ ok: boolean; submission?: Submission; error?: string }> {
    const r = await this.apiRequest('POST', `/committee/${committeeId}/submissions`, { type, title, url });
    if (r.status === 200) return { ok: true, submission: (r.data as { submission: Submission }).submission };
    return { ok: false, error: (r.data as { message?: string }).message ?? `Error ${r.status}` };
  }

  async pickFile(): Promise<{ path: string; name: string } | null> {
    const result = await dialog.showOpenDialog({
      title: 'Choose a document',
      properties: ['openFile'],
      filters: [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const p = result.filePaths[0];
    return { path: p, name: p.split(/[\\/]/).pop() ?? 'document' };
  }

  async submitFileSubmission(
    committeeId: string,
    type: SubmissionType,
    title: string,
    filePath: string,
  ): Promise<{ ok: boolean; submission?: Submission; error?: string }> {
    const fileName = filePath.split(/[\\/]/).pop() ?? 'document';
    try {
      const buf = await readFile(filePath);
      if (buf.length > 25 * 1024 * 1024) {
        return { ok: false, error: 'File exceeds 25 MB.' };
      }
      // Send the file as base64 in a JSON body. This avoids multipart parsing
      // entirely (reliable for every upload — no parser/connection hangs).
      const r = await this.apiRequest('POST', `/committee/${committeeId}/submissions/upload`, {
        type,
        title,
        fileName,
        dataBase64: buf.toString('base64'),
      });
      if (r.status === 200) {
        return { ok: true, submission: (r.data as { submission: Submission }).submission };
      }
      return { ok: false, error: (r.data as { message?: string }).message ?? `Upload failed (${r.status})` };
    } catch (err) {
      return { ok: false, error: `Upload error: ${(err as Error).message}` };
    }
  }

  async listSubmissions(committeeId: string): Promise<Submission[]> {
    const r = await this.apiRequest('GET', `/committee/${committeeId}/submissions`);
    if (r.status === 200) return (r.data as { submissions: Submission[] }).submissions ?? [];
    return [];
  }

  async markSubmissionReviewed(committeeId: string, id: string): Promise<void> {
    await this.apiRequest('POST', `/committee/${committeeId}/submissions/${id}/reviewed`);
  }

  async deleteSubmission(committeeId: string, id: string): Promise<void> {
    await this.apiRequest('DELETE', `/committee/${committeeId}/submissions/${id}`);
  }

  async openSubmissionFile(committeeId: string, id: string, fileName: string): Promise<void> {
    const token = store.get().accessToken;
    try {
      const res = await fetch(`${store.get().serverUrl}/committee/${committeeId}/submissions/${id}/file`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) return;
      const buf = Buffer.from(await res.arrayBuffer());
      const safeName = fileName.replace(/[\\/]/g, '_');
      const tmp = join(tmpdir(), `safemun-${id}-${safeName}`);
      await writeFile(tmp, buf);
      await shell.openPath(tmp);
    } catch {
      /* ignore */
    }
  }

  async openSubmissionLink(url: string): Promise<void> {
    try {
      await shell.openExternal(url);
    } catch {
      /* ignore */
    }
  }


  dispose(): void {
    this.engine.dispose();
    this.realtime.disconnect();
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private ensureDelegateKey(): string {
    const pub = cryptoClient.getPublicKey();
    if (pub) return pub;
    return cryptoClient.ensureKeyPair();
  }

  private wsUrl(): string {
    const base = store.get().serverUrl.replace(/^http/, 'ws');
    return base.endsWith('/ws') ? base : `${base}/ws`;
  }

  private handleWsState(s: WsState): void {
    void s;
    this.cb.onConnection(this.getConnection());
  }

  private handleServerEnvelope(env: ServerEnvelope): void {
    // Forward everything to the renderer first.
    this.cb.sendToRenderer(env);

    switch (env.t) {
      case 'rules_updated': {
        const rules = (env.payload as { rules: AiDetectionRule[] }).rules;
        this.engine.updateRules(rules);
        store.update({ rules });
        break;
      }
      case 'monitoring_paused': {
        const p = env.payload as { reason: string; resumeAt: number | null };
        this.pausedReason = p.reason;
        this.engine.pause(p.reason);
        this.cb.onConnection(this.getConnection());
        break;
      }
      case 'monitoring_resumed': {
        this.pausedReason = null;
        this.engine.resume();
        this.cb.onConnection(this.getConnection());
        break;
      }
      case 'force_logout': {
        void this.logout();
        break;
      }
      case 'auth_error': {
        // Token invalid/expired mid-session — stop + clear so the renderer
        // returns to the login screen for re-authentication.
        this.engine.stop();
        this.realtime.disconnect();
        store.clear();
        this.pendingAcks.clear();
        this.cb.onConnection(this.getConnection());
        break;
      }
      case 'vote_cast_ack': {
        const ack = env.payload as VoteCastAckPayload;
        const r = this.pendingAcks.get(ack.clientCastId);
        if (r) {
          this.pendingAcks.delete(ack.clientCastId);
          r(ack);
        }
        break;
      }
      default:
        break;
    }
  }
}
