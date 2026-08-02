/**
 * @mun/desktop — realtime WebSocket client
 *
 * Resilience guarantees (spec → RESILIENCE):
 *  - Auto-reconnect with exponential backoff + jitter on close/error.
 *  - Offline queue: messages sent while disconnected are buffered and flushed
 *    on reconnect. Monitor events and votes carry client idempotency keys so
 *    the server dedups redelivered messages.
 *  - Heartbeats every `heartbeatIntervalMs` (from the welcome); if the socket
 *    drops, the queue keeps events until reconnect.
 *  - Clock-drift: the welcome + heartbeat_ack carry serverTs so the renderer
 *    can correct displayed timestamps.
 *  - Sleep/wake: Electron's powerMonitor triggers a forced reconnect on resume
 *    (wired in index.ts) so a stale socket is replaced.
 */

import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import {
  envelope,
  type Envelope,
  type ServerEnvelope,
  type MonitoringEventWire,
  type CastVotePayload,
  type HelloPayload,
} from '@mun/protocol';

type Listener = (env: ServerEnvelope) => void;

export type WsState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface RealtimeClientOptions {
  getUrl: () => string; // ws URL derived from the REST server URL
  getAccessToken: () => string | null;
  platform: 'windows' | 'macos';
  clientVersion: string;
  onStateChange: (s: WsState) => void;
}

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private state: WsState = 'idle';
  private listeners = new Set<Listener>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private backoff = 500;
  private heartbeatIntervalMs = 5000;
  private monitorActive = true;
  private queued: Envelope[] = [];
  private welcomed = false;
  private intentionallyClosed = false;

  constructor(private opts: RealtimeClientOptions) {}

  connect(): void {
    this.intentionallyClosed = false;
    this.openSocket();
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.clearReconnect();
    this.clearHeartbeat();
    if (this.ws) {
      try {
        this.ws.close(1000, 'logout');
      } catch {
        /* ignore */
      }
    }
    this.setState('closed');
  }

  /** Send a monitor event (buffered while disconnected). */
  sendMonitorEvent(event: MonitoringEventWire): void {
    this.send(envelope('monitor_event', event, { id: event.clientEventId }));
  }

  /** Send a signed vote (buffered while disconnected). */
  sendCastVote(payload: CastVotePayload): void {
    this.send(envelope('cast_vote', payload, { id: payload.clientCastId }));
  }

  send(env: Envelope): void {
    if (this.ws && this.state === 'open' && this.welcomed) {
      this.rawSend(env);
    } else {
      // Buffer; flush on reconnect. Dedup by env.id at flush.
      if (env.id && this.queued.some((q) => q.id === env.id)) return;
      this.queued.push(env);
      if (this.state !== 'connecting' && this.state !== 'reconnecting' && !this.intentionallyClosed) {
        this.scheduleReconnect();
      }
    }
  }

  setMonitoringActive(active: boolean): void {
    this.monitorActive = active;
  }

  onMessage(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getState(): WsState {
    return this.state;
  }

  /** Force a reconnect (used on power-resume). */
  forceReconnect(): void {
    if (this.ws) {
      try {
        this.ws.close(4000, 'force reconnect');
      } catch {
        /* ignore */
      }
    } else {
      this.scheduleReconnect();
    }
  }

  // ─── internal ──────────────────────────────────────────────────────────────

  private openSocket(): void {
    const token = this.opts.getAccessToken();
    if (!token) {
      this.setState('closed');
      return;
    }
    this.setState(this.state === 'closed' || this.state === 'idle' ? 'connecting' : 'reconnecting');
    this.welcomed = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.getUrl());
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = 500;
      const hello: HelloPayload = {
        accessToken: token,
        platform: this.opts.platform,
        clientVersion: this.opts.clientVersion,
      };
      this.rawSend(envelope('hello', hello, { id: 'hello' }));
    });

    ws.on('message', (data) => {
      let env: ServerEnvelope;
      try {
        env = JSON.parse(data.toString()) as ServerEnvelope;
      } catch {
        return;
      }
      if (env.t === 'welcome') {
        this.welcomed = true;
        this.setState('open');
        this.heartbeatIntervalMs = (env.payload as { heartbeatIntervalMs?: number }).heartbeatIntervalMs ?? 5000;
        this.startHeartbeat();
        this.flushQueue();
      } else if (env.t === 'heartbeat_ack') {
        // drift available in payload; renderer can read it.
      } else if (env.t === 'auth_error' || (env.t === 'error' && (env.payload as { fatal?: boolean }).fatal)) {
        // Token invalid → don't keep retrying; surface to renderer.
        this.intentionallyClosed = true;
        this.setState('closed');
      } else if (env.t === 'force_logout') {
        this.intentionallyClosed = true;
        this.setState('closed');
      }
      for (const l of this.listeners) l(env);
    });

    ws.on('close', () => {
      this.clearHeartbeat();
      this.ws = null;
      if (this.intentionallyClosed) {
        this.setState('closed');
        return;
      }
      this.scheduleReconnect();
    });

    ws.on('error', () => {
      // 'close' will follow and handle reconnect.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.state === 'open' && this.ws) {
        this.rawSend(envelope('heartbeat', { clientTs: Date.now(), monitoringActive: this.monitorActive }, { id: randomUUID() }));
      }
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private flushQueue(): void {
    const q = this.queued;
    this.queued = [];
    for (const env of q) this.rawSend(env);
  }

  private rawSend(env: Envelope): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queued.push(env);
      return;
    }
    try {
      this.ws.send(JSON.stringify(env));
    } catch {
      this.queued.push(env);
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionallyClosed) return;
    this.clearReconnect();
    const jitter = Math.floor(Math.random() * 250);
    const delay = Math.min(this.backoff + jitter, 15000);
    this.backoff = Math.min(this.backoff * 2, 15000);
    this.setState('reconnecting');
    this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    this.reconnectTimer.unref?.();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private setState(s: WsState): void {
    this.state = s;
    this.opts.onStateChange(s);
  }
}
