import type {
  LoginResult,
  JoinOptionCommittee,
  PersistedState,
  ConnectionInfo,
  MonitoringState,
  MunApi
} from '@shared/ipc';
import type {
  VoteChoice,
  VoteCastAckPayload,
  SubmissionType,
  Submission,
  ServerEnvelope,
  AiDetectionRule,
  MonitoringEventType,
  Severity,
  TitleScope,
} from '@mun/protocol';

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';

// ─── Persisted State ────────────────────────────────────────────────────────

function getStore(): PersistedState {
  const s = localStorage.getItem('mun_state');
  if (s) {
    try {
      const parsed = JSON.parse(s);
      if (!parsed.deviceId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed.deviceId)) {
        parsed.deviceId = crypto.randomUUID();
        localStorage.setItem('mun_state', JSON.stringify(parsed));
      }
      return parsed;
    } catch {}
  }
  return {
    user: null,
    delegate: null,
    committees: [],
    accessToken: null,
    refreshToken: null,
    deviceId: crypto.randomUUID(),
    rules: [],
    serverUrl: 'https://digitalmun.onrender.com'
  };
}

function updateStore(patch: Partial<PersistedState>) {
  const current = getStore();
  const next = { ...current, ...patch };
  localStorage.setItem('mun_state', JSON.stringify(next));
}

// ─── Realtime WebSocket ──────────────────────────────────────────────────────

let activeWs: WebSocket | null = null;
let eventListeners: Array<(env: ServerEnvelope) => void> = [];
let connectionListeners: Array<(info: ConnectionInfo) => void> = [];
let monitoringListeners: Array<(state: MonitoringState) => void> = [];
let reconnectTimer: any = null;
let heartbeatTimer: any = null;
let intentionallyClosed = false;

// ─── Vote Acknowledgment ─────────────────────────────────────────────────────

const pendingAcks = new Map<string, (ack: VoteCastAckPayload) => void>();

// ─── Monitoring Engine ───────────────────────────────────────────────────────

const MONITOR_POLL_MS = 400;
const IDLE_THRESHOLD_MS = 60_000;

const SELF_APP_NAMES = new Set([
  'mun guardian', 'mun-guardian', 'safe mun 2026', 'safe mun 2026.exe',
  'safe mun', 'safe-mun', 'safemun', 'safemun2026', 'app.exe',
]);

let monitorTimer: any = null;
let monitorActive = false;
let monitorPaused = false;
let pausedReason: string | null = null;
let cachedRules: AiDetectionRule[] = [];
let lastAppName: string | null = null;
let lastMatched = false;
let lastMatchedRuleId: string | null = null;
let monitorAway = false;
let awaySince = 0;
let idleActive = false;
let monitorFlagged = false;
let currentAppName: string | null = null;
let lastEventAt: number | null = null;

interface ForegroundSample {
  app_name: string | null;
  title: string | null;
  idle_ms: number;
}

function matchRulesLocal(
  rules: AiDetectionRule[],
  platform: string,
  appName: string | null,
  title: string | null
): { rule: AiDetectionRule; matchedOn: string } | null {
  if (!appName && !title) return null;
  const app = (appName ?? '').toLowerCase();
  const ttl = (title ?? '').toLowerCase();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.platform !== 'all' && rule.platform !== platform) continue;
    const field = rule.matchField;
    const testApp = field === 'app' || field === 'app_or_title';
    const testTitle = field === 'title' || field === 'app_or_title';
    if (testApp && matchesRule(rule, app)) return { rule, matchedOn: 'app' };
    if (testTitle && matchesRule(rule, ttl)) return { rule, matchedOn: 'title' };
  }
  return null;
}

function matchesRule(rule: AiDetectionRule, value: string): boolean {
  if (!value) return false;
  switch (rule.patternType) {
    case 'contains': return value.includes(rule.pattern.toLowerCase());
    case 'equals': return value === rule.pattern.toLowerCase();
    case 'regex':
      try { return new RegExp(rule.pattern, 'i').test(value); }
      catch { return false; }
  }
  return false;
}

function emitMonitorEvent(
  type: MonitoringEventType,
  appName: string | null,
  title: string | null,
  titleScope: TitleScope,
  ruleId: string | null,
  ruleName: string | null,
  severity: Severity,
  durationMs: number | null
) {
  const store = getStore();
  const delegateId = store.delegate?.id;
  const committeeId = store.delegate?.committeeId;
  if (!delegateId || !committeeId) return;

  const clientEventId = crypto.randomUUID();
  const ev = {
    clientEventId,
    delegateId,
    committeeId,
    type,
    clientTs: Date.now(),
    appName,
    title: titleScope === 'app_only' || titleScope === 'none' ? null : title,
    titleScope,
    matchedRuleId: ruleId,
    matchedRuleName: ruleName,
    severity,
    durationMs,
    fromAppName: null,
  };

  lastEventAt = ev.clientTs;

  // Send over WebSocket
  if (activeWs && activeWs.readyState === WebSocket.OPEN) {
    activeWs.send(JSON.stringify({
      v: 1, t: 'monitor_event', id: clientEventId, ts: Date.now(), payload: ev
    }));
  }

  pushMonitoringState();
}

function pushMonitoringState() {
  const state: MonitoringState = {
    active: monitorActive && !monitorPaused,
    paused: monitorPaused,
    currentAppName,
    away: monitorAway || idleActive,
    flagged: monitorFlagged,
    lastEventAt,
  };
  monitoringListeners.forEach(l => l(state));
}

async function monitorPoll() {
  if (monitorPaused) return;
  const store = getStore();
  if (!store.delegate) return;

  let sample: ForegroundSample | null = null;
  try {
    sample = await invoke<ForegroundSample | null>('sample_foreground');
  } catch {
    // Rust command not available (e.g. running in browser)
    return;
  }
  if (!sample) return;

  // Idle handling
  if (sample.idle_ms > IDLE_THRESHOLD_MS) {
    if (!idleActive) {
      idleActive = true;
      monitorAway = true;
      awaySince = Date.now();
      emitMonitorEvent('idle', sample.app_name, null, 'app_only', null, null, 'info', null);
    }
    currentAppName = sample.app_name;
    pushMonitoringState();
    return;
  } else if (idleActive) {
    idleActive = false;
    emitMonitorEvent('return', sample.app_name, null, 'app_only', null, null, 'info', Date.now() - awaySince);
    monitorAway = false;
  }

  const appNameLower = (sample.app_name ?? '').toLowerCase();
  const isSelf = SELF_APP_NAMES.has(appNameLower) || appNameLower.includes('safe mun') || appNameLower.includes('mun guardian');
  const matched = matchRulesLocal(cachedRules, 'windows', sample.app_name, sample.title);
  const matchedRule = matched?.rule ?? null;
  const nowMatched = !!matchedRule;
  const ruleChanged = (matchedRule?.id ?? null) !== lastMatchedRuleId;
  const appChanged = appNameLower !== lastAppName;

  if (nowMatched && (!lastMatched || ruleChanged || appChanged)) {
    const sev = matchedRule!.severity as Severity;
    emitMonitorEvent('ai_detected', sample.app_name, sample.title, 'matched',
      matchedRule!.id, matchedRule!.name, sev, null);
    monitorFlagged = true;
    if (!monitorAway) { monitorAway = true; awaySince = Date.now(); }
  } else if (!nowMatched && lastMatched) {
    monitorFlagged = false;
    if (isSelf) {
      if (monitorAway) {
        emitMonitorEvent('return', sample.app_name, sample.title, 'self', null, null, 'info', Date.now() - awaySince);
        monitorAway = false;
      } else {
        emitMonitorEvent('focus_change', sample.app_name, sample.title, 'self', null, null, 'info', null);
      }
    } else {
      emitMonitorEvent('focus_change', sample.app_name, null, 'app_only', null, null, 'info', null);
      if (!monitorAway) { monitorAway = true; awaySince = Date.now(); }
    }
  } else if (appChanged) {
    if (isSelf) {
      if (monitorAway) {
        emitMonitorEvent('return', sample.app_name, sample.title, 'self', null, null, 'info', Date.now() - awaySince);
        monitorAway = false;
      } else {
        emitMonitorEvent('focus_change', sample.app_name, sample.title, 'self', null, null, 'info', null);
      }
      monitorFlagged = false;
    } else {
      emitMonitorEvent('focus_change', sample.app_name, null, 'app_only', null, null, 'info', null);
      monitorFlagged = false;
      if (!monitorAway) { monitorAway = true; awaySince = Date.now(); }
    }
  }

  lastAppName = appNameLower;
  lastMatched = nowMatched;
  lastMatchedRuleId = matchedRule?.id ?? null;
  currentAppName = sample.app_name;
  pushMonitoringState();
}

function startMonitoring() {
  if (monitorActive) return;
  monitorActive = true;
  monitorPaused = false;
  lastAppName = null;
  lastMatched = false;
  lastMatchedRuleId = null;
  monitorAway = false;
  idleActive = false;
  monitorFlagged = false;
  emitMonitorEvent('session_start', null, null, 'none', null, null, 'info', null);
  monitorPoll(); // immediate first sample
  monitorTimer = setInterval(monitorPoll, MONITOR_POLL_MS);
}

function stopMonitoring() {
  if (!monitorActive) return;
  monitorActive = false;
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  emitMonitorEvent('session_end', null, null, 'none', null, null, 'info', null);
  pushMonitoringState();
}

function pauseMonitoring(reason: string) {
  monitorPaused = true;
  pausedReason = reason;
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  pushMonitoringState();
  notifyConnection();
}

function resumeMonitoring() {
  if (!monitorActive || !monitorPaused) return;
  monitorPaused = false;
  pausedReason = null;
  lastAppName = null;
  lastMatched = false;
  lastMatchedRuleId = null;
  monitorPoll();
  monitorTimer = setInterval(monitorPoll, MONITOR_POLL_MS);
  notifyConnection();
}

// ─── Connection Info ─────────────────────────────────────────────────────────

function getConnectionInfo(): ConnectionInfo {
  const wsState = activeWs
    ? (activeWs.readyState === WebSocket.OPEN ? 'open' : 'connecting')
    : 'closed';
  const monState = monitorActive
    ? (monitorPaused ? 'paused' : 'active')
    : 'inactive';
  return {
    ws: wsState as ConnectionInfo['ws'],
    monitoring: monState as ConnectionInfo['monitoring'],
    pausedReason,
  };
}

function notifyConnection() {
  const info = getConnectionInfo();
  connectionListeners.forEach(l => l(info));
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

function connectRealtime() {
  const store = getStore();
  if (!store.accessToken) return;

  intentionallyClosed = false;

  if (activeWs) {
    try { activeWs.close(); } catch {}
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  const wsUrl = store.serverUrl.replace(/^http/, 'ws') + '/ws?token=' + store.accessToken;
  activeWs = new WebSocket(wsUrl);

  notifyConnection();

  activeWs.onopen = () => {
    activeWs?.send(JSON.stringify({
      v: 1, t: 'hello', id: 'hello', ts: Date.now(),
      payload: {
        accessToken: store.accessToken,
        platform: 'windows',
        clientVersion: '1.0.0'
      }
    }));
  };

  activeWs.onclose = () => {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    activeWs = null;
    notifyConnection();
    if (!intentionallyClosed) {
      reconnectTimer = setTimeout(connectRealtime, 3000);
    }
  };

  activeWs.onerror = () => {};

  activeWs.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data) as ServerEnvelope;
      handleServerEnvelope(data);
      eventListeners.forEach(l => l(data));
    } catch {}
  };
}

function handleServerEnvelope(env: ServerEnvelope) {
  switch (env.t) {
    case 'welcome': {
      notifyConnection();
      // Start heartbeat
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const interval = (env.payload as any)?.heartbeatIntervalMs || 5000;
      heartbeatTimer = setInterval(() => {
        if (activeWs && activeWs.readyState === WebSocket.OPEN) {
          activeWs.send(JSON.stringify({
            v: 1, t: 'heartbeat', id: 'hb-' + Date.now(), ts: Date.now(),
            payload: { clientTs: Date.now(), monitoringActive: monitorActive && !monitorPaused }
          }));
        }
      }, interval);
      break;
    }
    case 'vote_cast_ack': {
      const ack = env.payload as VoteCastAckPayload;
      const resolve = pendingAcks.get(ack.clientCastId);
      if (resolve) {
        pendingAcks.delete(ack.clientCastId);
        resolve(ack);
      }
      break;
    }
    case 'rules_updated': {
      const rules = (env.payload as { rules: AiDetectionRule[] }).rules;
      cachedRules = rules;
      updateStore({ rules });
      break;
    }
    case 'monitoring_paused': {
      const p = env.payload as { reason: string; resumeAt: number | null };
      pauseMonitoring(p.reason);
      break;
    }
    case 'monitoring_resumed': {
      resumeMonitoring();
      break;
    }
    case 'force_logout': {
      stopMonitoring();
      intentionallyClosed = true;
      if (activeWs) { try { activeWs.close(); } catch {} }
      updateStore({
        user: null, delegate: null, accessToken: null, refreshToken: null,
        committees: [], rules: []
      });
      pendingAcks.clear();
      notifyConnection();
      break;
    }
    case 'auth_error': {
      stopMonitoring();
      intentionallyClosed = true;
      if (activeWs) { try { activeWs.close(); } catch {} }
      updateStore({
        user: null, delegate: null, accessToken: null, refreshToken: null,
        committees: [], rules: []
      });
      pendingAcks.clear();
      notifyConnection();
      break;
    }
  }
}

function disconnectRealtime() {
  intentionallyClosed = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (activeWs) {
    try { activeWs.close(1000, 'logout'); } catch {}
  }
}

// Clear session on app startup so the app always opens to the login page
if (typeof window !== 'undefined') {
  updateStore({
    user: null,
    delegate: null,
    accessToken: null,
    refreshToken: null,
    committees: [],
    rules: []
  });
}

// ─── Cryptography ────────────────────────────────────────────────────────────

function ensureKeyPair(): nacl.SignKeyPair {
  const storedStr = localStorage.getItem('mun_keypair');
  if (storedStr) {
    try {
      const { publicKey, secretKey } = JSON.parse(storedStr);
      return {
        publicKey: naclUtil.decodeBase64(publicKey),
        secretKey: naclUtil.decodeBase64(secretKey)
      };
    } catch {}
  }
  const keyPair = nacl.sign.keyPair();
  localStorage.setItem('mun_keypair', JSON.stringify({
    publicKey: naclUtil.encodeBase64(keyPair.publicKey),
    secretKey: naclUtil.encodeBase64(keyPair.secretKey)
  }));
  return keyPair;
}

/** Get the public key as base64url (matching server's expected format) */
function getPublicKeyB64url(): string {
  const kp = ensureKeyPair();
  return uint8ToBase64url(kp.publicKey);
}

function uint8ToBase64url(arr: Uint8Array): string {
  return btoa(String.fromCharCode(...arr))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Canonical JSON for vote signing (sorted keys) */
function canonicalJson(val: any): string {
  if (val === null) return 'null';
  if (typeof val === 'boolean' || typeof val === 'number') return JSON.stringify(val);
  if (typeof val === 'string') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(canonicalJson).join(',') + ']';
  if (typeof val === 'object') {
    const keys = Object.keys(val).sort();
    return '{' + keys.filter(k => val[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonicalJson(val[k])).join(',') + '}';
  }
  return JSON.stringify(val);
}

function signVotePayload(
  params: { voteId: string; delegateId: string; choice: VoteChoice; clientCastId: string }
): string {
  const kp = ensureKeyPair();
  const payload = {
    voteId: params.voteId,
    delegateId: params.delegateId,
    choice: params.choice,
    clientCastId: params.clientCastId,
  };
  const canonicalMessage = `mun-vote:v1\n${canonicalJson(payload)}`;
  const msgUint8 = new TextEncoder().encode(canonicalMessage);
  const sigUint8 = nacl.sign.detached(msgUint8, kp.secretKey);
  return uint8ToBase64url(sigUint8);
}

/** Register the delegate's public key with the server */
async function registerPublicKey(accessToken: string) {
  const pubKey = getPublicKeyB64url();
  try {
    await fetch(`${getStore().serverUrl}/delegate/register-key`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ publicKey: pubKey })
    });
  } catch {}
}

// ─── Post-Auth Setup ─────────────────────────────────────────────────────────

async function completeAuth(response: any) {
  updateStore({
    user: response.user,
    delegate: response.delegate,
    committees: response.committees,
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    rules: response.rules
  });

  cachedRules = response.rules ?? [];

  // Register voting key for delegates
  if (response.user?.role === 'delegate' && response.delegate) {
    await registerPublicKey(response.accessToken);
  }

  // Connect WebSocket
  connectRealtime();

  // Start monitoring for delegates
  if (response.user?.role === 'delegate' && response.monitoringActive) {
    startMonitoring();
  }
}

// ─── API Implementation ──────────────────────────────────────────────────────

export const api: MunApi = {
  async login(username, password) {
    const res = await api.apiRequest('POST', '/auth/login', {
      username, password,
      deviceId: getStore().deviceId,
      platform: 'windows',
      clientVersion: '1.0.0'
    });
    if (res.status === 200) {
      await completeAuth(res.data);
      return { ok: true, response: res.data as any };
    }
    if (res.status === 409 && (res.data as any)?.code === 'AUTH_RELOGIN_REQUIRED') {
      return {
        ok: false,
        reloginRequired: true,
        requestId: String((res.data as any).requestId ?? ''),
        message: String((res.data as any).message ?? 'Re-login required'),
      };
    }
    return { ok: false, error: (res.data as any)?.message ?? 'Login failed' };
  },

  async join(committeeId, country) {
    const res = await api.apiRequest('POST', '/auth/join', {
      committeeId, country,
      deviceId: getStore().deviceId,
      platform: 'windows',
      clientVersion: '1.0.0'
    });
    if (res.status === 200) {
      await completeAuth(res.data);
      return { ok: true, response: res.data as any };
    }
    if (res.status === 409 && (res.data as any)?.code === 'AUTH_RELOGIN_REQUIRED') {
      return {
        ok: false,
        reloginRequired: true,
        requestId: String((res.data as any).requestId ?? ''),
        message: String((res.data as any).message ?? 'Re-login required'),
      };
    }
    return { ok: false, error: (res.data as any)?.message ?? 'Join failed' };
  },

  async getJoinOptions() {
    const res = await fetch(`${getStore().serverUrl}/delegate/join-options`);
    if (res.ok) {
      const data = await res.json();
      return data.options ?? [];
    }
    return [];
  },

  async logout() {
    stopMonitoring();
    disconnectRealtime();
    const token = getStore().accessToken;
    if (token) {
      try {
        await fetch(`${getStore().serverUrl}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {}
    }
    updateStore({
      user: null, delegate: null, accessToken: null, refreshToken: null,
      committees: [], rules: []
    });
    pendingAcks.clear();
    notifyConnection();
  },

  async refreshSession() {
    const store = getStore();
    if (!store.refreshToken) return false;
    try {
      const res = await fetch(`${store.serverUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: store.refreshToken })
      });
      if (!res.ok) {
        updateStore({
          user: null, delegate: null, accessToken: null, refreshToken: null,
          committees: [], rules: []
        });
        notifyConnection();
        return false;
      }
      const data = await res.json();
      updateStore({ accessToken: data.accessToken, refreshToken: data.refreshToken });
      connectRealtime();
      if (store.delegate) {
        cachedRules = store.rules;
        startMonitoring();
      }
      return true;
    } catch {
      return false;
    }
  },

  async getState() {
    return getStore();
  },

  async clearState() {
    localStorage.removeItem('mun_state');
  },

  async castVote(voteId, choice) {
    const delegate = getStore().delegate;
    if (!delegate) throw new Error('Not a delegate');

    const clientCastId = crypto.randomUUID();
    const publicKey = getPublicKeyB64url();
    const signature = signVotePayload({
      voteId, delegateId: delegate.id, choice, clientCastId
    });

    // Create promise that waits for server ack
    const ackPromise = new Promise<VoteCastAckPayload>((resolve) => {
      pendingAcks.set(clientCastId, resolve);
      // 10 second timeout fallback
      setTimeout(() => {
        const r = pendingAcks.get(clientCastId);
        if (r) {
          pendingAcks.delete(clientCastId);
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

    // Send vote over WebSocket
    if (activeWs && activeWs.readyState === WebSocket.OPEN) {
      activeWs.send(JSON.stringify({
        v: 1, t: 'cast_vote', id: clientCastId, ts: Date.now(),
        payload: { voteId, choice, signature, publicKey, clientCastId }
      }));
    }

    return ackPromise;
  },

  async requestRelogin(reason) {
    // Re-login is driven by the login endpoint; noop
    void reason;
  },

  async cancelRelogin(requestId) {
    const token = getStore().accessToken;
    if (token) {
      try {
        await fetch(`${getStore().serverUrl}/auth/relogin/cancel`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ requestId })
        });
      } catch {}
    }
  },

  async setServerUrl(url) {
    updateStore({ serverUrl: url });
  },

  async getServerUrl() {
    return getStore().serverUrl;
  },

  async getServerPublicKey() {
    try {
      const res = await fetch(`${getStore().serverUrl}/server-key`);
      if (!res.ok) return '';
      const body = await res.json();
      return body.publicKey ?? '';
    } catch {
      return '';
    }
  },

  async getConnection() {
    return getConnectionInfo();
  },

  async getMonitoring() {
    return {
      active: monitorActive && !monitorPaused,
      paused: monitorPaused,
      currentAppName,
      away: monitorAway || idleActive,
      flagged: monitorFlagged,
      lastEventAt,
    };
  },

  async getPlatform() {
    return 'windows';
  },

  async apiRequest(method, path, body) {
    const token = getStore().accessToken;
    let res;
    try {
      res = await fetch(`${getStore().serverUrl}${path}`, {
        method,
        headers: {
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e: any) {
      return { status: 0, data: { message: e?.message ?? 'Network error' } };
    }
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  },

  async submitLinkSubmission(committeeId, type, title, url) {
    const res = await api.apiRequest('POST', `/committee/${committeeId}/submissions`, { type, title, url });
    if (res.status === 200) return { ok: true, submission: (res.data as any)?.submission };
    return { ok: false, error: (res.data as any)?.message ?? `Error ${res.status}` };
  },

  async submitFileSubmission(committeeId, type, title, filePath) {
    try {
      // Read file via Rust command and get Base64
      const dataBase64 = await invoke<string>('read_file_base64', { path: filePath });
      const fileName = filePath.split(/[\\/]/).pop() ?? 'document';
      const res = await api.apiRequest('POST', `/committee/${committeeId}/submissions/upload`, {
        type, title, fileName, dataBase64
      });
      if (res.status === 200) return { ok: true, submission: (res.data as any)?.submission };
      return { ok: false, error: (res.data as any)?.message ?? `Upload failed (${res.status})` };
    } catch (err: any) {
      return { ok: false, error: `Upload error: ${err?.message ?? err}` };
    }
  },

  async pickFile() {
    const res = await open({
      multiple: false,
      filters: [{ name: 'Documents', extensions: ['pdf', 'doc', 'docx'] }]
    });
    if (res && !Array.isArray(res)) {
      return { path: res, name: res.split(/[\\/]/).pop() ?? 'document' };
    }
    return null;
  },

  async listSubmissions(committeeId) {
    const res = await api.apiRequest('GET', `/committee/${committeeId}/submissions`);
    return (res.data as any)?.submissions ?? [];
  },

  async markSubmissionReviewed(committeeId, id) {
    await api.apiRequest('POST', `/committee/${committeeId}/submissions/${id}/reviewed`);
  },

  async deleteSubmission(committeeId, id) {
    await api.apiRequest('DELETE', `/committee/${committeeId}/submissions/${id}`);
  },

  async openSubmissionFile(committeeId, id, fileName) {
    const token = getStore().accessToken;
    try {
      const res = await fetch(`${getStore().serverUrl}/committee/${committeeId}/submissions/${id}/file`, {
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) return;
      const buf = new Uint8Array(await res.arrayBuffer());
      const safeName = fileName.replace(/[\\/]/g, '_');
      const tempPath = await invoke<string>('write_temp_file', {
        name: `safemun-${id}-${safeName}`,
        data: Array.from(buf)
      });
      await invoke('open_file_with_default', { path: tempPath });
    } catch {}
  },

  async openSubmissionLink(url) {
    try {
      // Use Tauri shell plugin to open URL in default browser
      const { open: shellOpen } = await import('@tauri-apps/plugin-shell');
      await shellOpen(url);
    } catch {
      // Fallback: use window.open
      window.open(url, '_blank');
    }
  },

  onEvent(listener) {
    eventListeners.push(listener);
    return () => { eventListeners = eventListeners.filter(l => l !== listener); };
  },

  onConnection(listener) {
    connectionListeners.push(listener);
    return () => { connectionListeners = connectionListeners.filter(l => l !== listener); };
  },

  onMonitoring(listener) {
    monitoringListeners.push(listener);
    return () => { monitoringListeners = monitoringListeners.filter(l => l !== listener); };
  }
};
