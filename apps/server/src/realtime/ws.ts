/**
 * @mun/server — WebSocket realtime handler
 *
 * One endpoint: ws://host/ws. Authentication is via a `hello` message carrying
 * an access token (browsers can't set headers on WS upgrades), which must
 * arrive within a short window or the socket is closed. After `hello`, the
 * socket is registered with the broker + presence and dispatches typed
 * messages. Heartbeats also re-check session validity so a revoked session's
 * socket is terminated even if the client ignores `force_logout`.
 */

import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from '../config.js';
import { getSessionByAccessToken } from '../auth/sessions.js';
import { presence } from './presence.js';
import { broker } from './broker.js';
import { ingestEvent } from '../monitoring/ingest.js';
import { castVote } from '../voting/service.js';
import { broadcastCommitteeState } from '../committee/service.js';
import { getCachedRules, loadRules } from '../monitoring/rules.js';
import * as authService from '../auth/service.js';
import { pool } from '../db/pool.js';
import {
  PROTOCOL_VERSION,
  envelope,
  ProtocolError,
  safeParse,
  formatZodIssues,
  EnvelopeShapeSchema,
  HelloPayloadSchema,
  HeartbeatPayloadSchema,
  CastVotePayloadSchema,
  MonitoringEventWireSchema,
  RequestReloginPayloadSchema,
  SubscribeCommitteePayloadSchema,
  directionOf,
  CLIENT_TO_SERVER,
  type Envelope,
  type Role,
} from '@mun/protocol';
import type { ClientSink } from './types.js';
import { randomUuid } from '@mun/crypto';

const HELLO_TIMEOUT_MS = 5000;

interface ConnectionState {
  ws: WebSocket;
  sinkId: string;
  sink: ClientSink | null; // set after hello
  helloTimer: NodeJS.Timeout | null;
  ip: string;
}

export function setupWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws' });
  // Ensure rules are loaded for the first hello.
  void loadRules();

  wss.on('connection', (ws, req) => {
    const ip =
      req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      'unknown';

    const state: ConnectionState = {
      ws,
      sinkId: randomUuid(),
      sink: null,
      helloTimer: null,
      ip,
    };

    state.helloTimer = setTimeout(() => {
      if (!state.sink) closeWith(state, 4001, 'hello timeout');
    }, HELLO_TIMEOUT_MS);

    ws.on('message', (raw) => {
      void handleMessage(state, raw.toString());
    });
    ws.on('close', () => onDisconnect(state));
    ws.on('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  });

  return wss;
}

async function handleMessage(state: ConnectionState, text: string): Promise<void> {
  let parsed: Envelope;
  try {
    const json = JSON.parse(text);
    const shape = safeParse(EnvelopeShapeSchema, json);
    if (!shape.success) return sendError(state, 'PROTOCOL_BAD_MESSAGE', 'Malformed envelope');
    parsed = shape.data as Envelope;
  } catch {
    return sendError(state, 'PROTOCOL_BAD_MESSAGE', 'Invalid JSON');
  }

  if (parsed.v !== PROTOCOL_VERSION) {
    return sendError(state, 'PROTOCOL_BAD_VERSION', `Expected version ${PROTOCOL_VERSION}`);
  }

  try {
    // hello is the only message allowed pre-auth.
    if (parsed.t === 'hello') {
      if (state.sink) return sendError(state, 'PROTOCOL_BAD_MESSAGE', 'Already authenticated');
      return await handleHello(state, parsed);
    }

    if (!state.sink) {
      return sendError(state, 'PROTOCOL_UNAUTHENTICATED', 'Send hello first');
    }

    if (!CLIENT_TO_SERVER.has(parsed.t)) {
      return sendError(state, 'PROTOCOL_BAD_MESSAGE', `Unknown message type ${parsed.t}`);
    }

    switch (parsed.t) {
      case 'heartbeat':
        return await handleHeartbeat(state, parsed);
      case 'monitor_event':
        return await handleMonitorEvent(state, parsed);
      case 'cast_vote':
        return await handleCastVote(state, parsed);
      case 'request_relogin':
        return await handleRequestRelogin(state, parsed);
      case 'cancel_relogin':
        return await handleCancelRelogin(state, parsed);
      case 'subscribe_committee':
        return await handleSubscribe(state, parsed);
      case 'unsubscribe_committee':
        return; // no-op (subscription is fixed at hello)
      case 'client_ack':
        return; // ordered-delivery ack; no server action needed
      default:
        return sendError(state, 'PROTOCOL_BAD_MESSAGE', `Unhandled ${parsed.t}`);
    }
  } catch (err) {
    if (err instanceof ProtocolError) {
      return sendError(state, err.code, err.message, { fatal: false, ref: parsed.id });
    }
    // eslint-disable-next-line no-console
    console.error('[ws] handler error', err);
    return sendError(state, 'INTERNAL_ERROR', 'Internal error', { ref: parsed.id });
  }
}

// ─── Hello / auth ─────────────────────────────────────────────────────────────

async function handleHello(state: ConnectionState, env: Envelope): Promise<void> {
  const parsed = safeParse(HelloPayloadSchema, env.payload);
  if (!parsed.success) {
    return sendError(state, 'PROTOCOL_BAD_MESSAGE', 'Invalid hello payload');
  }
  const resolved = await getSessionByAccessToken(parsed.data.accessToken);
  if (!resolved) {
    return sendError(state, 'AUTH_TOKEN_INVALID', 'Invalid or expired access token', { fatal: true });
  }

  // Resolve delegate info if delegate.
  let delegateId: string | null = null;
  let committeeId: string | null = null;
  let displayName = '';
  let country = '';
  if (resolved.role === 'delegate') {
    const { rows } = await pool.query(
      'SELECT d.id, d.committee_id, d.country, u.display_name, d.enabled, d.attendance FROM delegates d JOIN users u ON u.id = d.user_id WHERE d.user_id = $1',
      [resolved.userId],
    );
    if (rows.length === 0) {
      return sendError(state, 'AUTH_FORBIDDEN', 'Delegate record not found', { fatal: true });
    }
    delegateId = rows[0].id;
    committeeId = rows[0].committee_id;
    displayName = rows[0].display_name;
    country = rows[0].country;
  } else if (resolved.role === 'chair') {
    const { rows } = await pool.query(
      'SELECT u.display_name, c.id AS committee_id FROM users u LEFT JOIN committees c ON c.chair_user_id = u.id WHERE u.id = $1',
      [resolved.userId],
    );
    displayName = rows[0]?.display_name ?? '';
    committeeId = rows[0]?.committee_id ?? null;
  } else {
    // admin — subscribes via the admin fan-out; committeeId stays null.
    const { rows } = await pool.query('SELECT display_name FROM users WHERE id = $1', [resolved.userId]);
    displayName = rows[0]?.display_name ?? '';
  }

  if (state.helloTimer) {
    clearTimeout(state.helloTimer);
    state.helloTimer = null;
  }

  const sink: ClientSink = {
    id: state.sinkId,
    userId: resolved.userId,
    role: resolved.role as Role,
    sessionId: resolved.session.id,
    delegateId,
    committeeId,
    send: (data: string) => {
      if (state.ws.readyState === WebSocket.OPEN) state.ws.send(data);
    },
    close: (code?: number, reason?: string) => state.ws.close(code, reason),
    isAlive: () => state.ws.readyState === WebSocket.OPEN,
  };
  state.sink = sink;
  broker.subscribe(sink);

  // Welcome payload.
  const { rows: userRows } = await pool.query(
    'SELECT id, username, role, display_name FROM users WHERE id = $1',
    [resolved.userId],
  );
  const u = userRows[0];
  let committees: import('@mun/protocol').Committee[] = [];
  let delegate: import('@mun/protocol').Delegate | null = null;
  if (resolved.role === 'delegate' && committeeId) {
    const { rows: cr } = await pool.query('SELECT * FROM committees WHERE id = $1', [committeeId]);
    committees = cr.map(rowToCommittee);
    const { rows: dr } = await pool.query('SELECT * FROM delegates WHERE id = $1', [delegateId]);
    if (dr.length) delegate = rowToDelegate(dr[0]);
    // Register presence.
    presence.register({
      delegateId: delegateId!,
      committeeId: committeeId!,
      userId: resolved.userId,
      displayName,
      country,
      connectionStatus: 'connected',
      attendance: (delegate?.attendance ?? 'not_checked_in') as import('@mun/protocol').Attendance,
      enabled: delegate?.enabled ?? true,
      lastHeartbeatAt: Date.now(),
    });
    // Push current committee state to the delegate.
    void broadcastCommitteeState(committeeId!);
  } else if (resolved.role === 'chair') {
    const { rows: cr } = await pool.query('SELECT * FROM committees WHERE chair_user_id = $1', [resolved.userId]);
    committees = cr.map(rowToCommittee);
    for (const c of committees) void broadcastCommitteeState(c.id);
  } else {
    // admin
    const { rows: cr } = await pool.query('SELECT * FROM committees');
    committees = cr.map(rowToCommittee);
  }

  sink.send(
    JSON.stringify(
      envelope('welcome', {
        user: { id: u.id, username: u.username, role: u.role, displayName: u.display_name },
        committees,
        delegate,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        serverTs: Date.now(),
      }),
    ),
  );
  // Push current rules to the freshly connected client.
  sink.send(JSON.stringify(envelope('rules_updated', { rules: getCachedRules() })));
}

// ─── Heartbeat ────────────────────────────────────────────────────────────────

async function handleHeartbeat(state: ConnectionState, env: Envelope): Promise<void> {
  const parsed = safeParse(HeartbeatPayloadSchema, env.payload);
  if (!parsed.success) return sendError(state, 'PROTOCOL_BAD_MESSAGE', 'Invalid heartbeat');
  const sink = state.sink!;
  // Re-check session validity: a revoked session's socket is terminated even
  // if the client ignores the earlier force_logout.
  const { rows } = await pool.query('SELECT revoked FROM sessions WHERE id = $1', [sink.sessionId]);
  if (rows.length === 0 || rows[0].revoked) {
    sink.send(JSON.stringify(envelope('force_logout', { reason: 'Session revoked', revoked: true })));
    return closeWith(state, 4003, 'session revoked');
  }
  if (sink.delegateId) {
    presence.heartbeat(sink.delegateId, parsed.data.monitoringActive);
  }
  const serverTs = Date.now();
  const driftMs = serverTs - parsed.data.clientTs;
  sink.send(
    JSON.stringify(
      envelope('heartbeat_ack', { serverTs, driftMs }, { ref: env.id }),
    ),
  );
}

// ─── Monitor event ────────────────────────────────────────────────────────────

async function handleMonitorEvent(state: ConnectionState, env: Envelope): Promise<void> {
  const sink = state.sink!;
  if (sink.role !== 'delegate' || !sink.delegateId || !sink.committeeId) {
    return sendError(state, 'AUTH_FORBIDDEN', 'Only delegates send monitor events');
  }
  const parsed = safeParse(MonitoringEventWireSchema, env.payload);
  if (!parsed.success) {
    return sendError(state, 'MONITOR_INVALID_EVENT', 'Invalid event', {
      ref: env.id,
      details: formatZodIssues(parsed.error),
    });
  }
  const rec = presence.get(sink.delegateId);
  const result = await ingestEvent(parsed.data, {
    delegateId: sink.delegateId,
    committeeId: sink.committeeId,
    displayName: rec?.displayName ?? '',
    country: rec?.country ?? '',
  });
  if (result.rateLimited) {
    return sendError(state, 'MONITOR_RATE_LIMITED', 'Rate limited', { ref: env.id });
  }
  // Ack the event (idempotent success either way).
  sink.send(
    JSON.stringify(
      envelope('client_ack', { ref: env.id ?? parsed.data.clientEventId }),
    ),
  );
}

// ─── Cast vote ────────────────────────────────────────────────────────────────

async function handleCastVote(state: ConnectionState, env: Envelope): Promise<void> {
  const sink = state.sink!;
  if (sink.role !== 'delegate' || !sink.delegateId || !sink.committeeId) {
    return sendError(state, 'AUTH_FORBIDDEN', 'Only delegates cast votes');
  }
  const parsed = safeParse(CastVotePayloadSchema, env.payload);
  if (!parsed.success) {
    return sendError(state, 'VOTE_INVALID_CHOICE', 'Invalid cast payload', { ref: env.id });
  }
  const p = parsed.data;
  const result = await castVote({
    voteId: p.voteId,
    delegateId: sink.delegateId,
    committeeId: sink.committeeId,
    choice: p.choice,
    signature: p.signature,
    publicKey: p.publicKey,
    clientCastId: p.clientCastId,
  });
  sink.send(
    JSON.stringify(
      envelope(
        'vote_cast_ack',
        {
          voteId: p.voteId,
          clientCastId: p.clientCastId,
          accepted: result.accepted,
          receipt: result.receipt,
          reason: result.reason,
          submittedCount: result.submittedCount,
          requiredCount: result.requiredCount,
        },
        { ref: env.id },
      ),
    ),
  );
}

// ─── Re-login request / cancel ────────────────────────────────────────────────

async function handleRequestRelogin(state: ConnectionState, env: Envelope): Promise<void> {
  const sink = state.sink!;
  if (sink.role !== 'delegate') return sendError(state, 'AUTH_FORBIDDEN', 'Delegates only');
  const parsed = safeParse(RequestReloginPayloadSchema, env.payload);
  if (!parsed.success) return sendError(state, 'PROTOCOL_BAD_MESSAGE', 'Invalid payload');
  // A delegate connected on an existing session requesting re-login is unusual,
  // but supported (e.g. to switch devices). They must re-authenticate via REST.
  // Here we just ack; the real re-login flow is triggered at login time.
  sink.send(JSON.stringify(envelope('client_ack', { ref: env.id ?? '' })));
}

async function handleCancelRelogin(state: ConnectionState, env: Envelope): Promise<void> {
  const sink = state.sink!;
  if (sink.role !== 'delegate') return;
  // Delegate cancels a pending request they own.
  const body = env.payload as { requestId?: string };
  if (body.requestId) await authService.cancelRelogin(body.requestId, sink.userId).catch(() => {});
  sink.send(JSON.stringify(envelope('client_ack', { ref: env.id ?? '' })));
}

// ─── Subscribe (chairs/admins can subscribe to additional committees) ──────────

async function handleSubscribe(state: ConnectionState, env: Envelope): Promise<void> {
  const sink = state.sink!;
  if (sink.role === 'delegate') return sendError(state, 'AUTH_FORBIDDEN', 'Delegates cannot subscribe');
  const parsed = safeParse(SubscribeCommitteePayloadSchema, env.payload);
  if (!parsed.success) return sendError(state, 'PROTOCOL_BAD_MESSAGE', 'Invalid payload');
  await broadcastCommitteeState(parsed.data.committeeId);
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function onDisconnect(state: ConnectionState): void {
  if (state.helloTimer) clearTimeout(state.helloTimer);
  if (state.sink) {
    broker.unsubscribe(state.sink);
    if (state.sink.delegateId) {
      // Mark disconnected (session stays — crashes don't auto-free it).
      void presence.markDisconnected(state.sink.delegateId, 'websocket closed');
    }
  }
}

function closeWith(state: ConnectionState, code: number, reason: string): void {
  try {
    state.ws.close(code, reason);
  } catch {
    /* ignore */
  }
}

function sendError(
  state: ConnectionState,
  code: string,
  message: string,
  opts: { fatal?: boolean; ref?: string; details?: Array<{ field: string; issue: string }> } = {},
): void {
  const env = envelope('error', { code, message, fatal: opts.fatal ?? false }, { ref: opts.ref });
  try {
    if (state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(env));
  } catch {
    /* ignore */
  }
  if (opts.fatal) closeWith(state, 4003, 'fatal error');
}

// Unused but kept to satisfy import surface for direction checks.
void directionOf;

// ─── Row mappers (duplicated minimally to avoid a circular import) ────────────

function rowToCommittee(r: Record<string, unknown>): import('@mun/protocol').Committee {
  return {
    id: r.id as string,
    name: r.name as string,
    topic: r.topic as string,
    description: (r.description as string) ?? '',
    status: r.status as import('@mun/protocol').CommitteeStatus,
    chairUserId: (r.chair_user_id as string | null) ?? null,
    createdAt: Number(r.created_at as number),
    rev: Number(r.rev as number),
  };
}

function rowToDelegate(r: Record<string, unknown>): import('@mun/protocol').Delegate {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    committeeId: r.committee_id as string,
    country: r.country as string,
    attendance: r.attendance as import('@mun/protocol').Attendance,
    connectionStatus: r.connection_status as import('@mun/protocol').ConnectionStatus,
    lastHeartbeatAt: r.last_heartbeat_at ? Number(r.last_heartbeat_at) : null,
    enabled: r.enabled as boolean,
    disabledReason: (r.disabled_reason as string | null) ?? null,
    reloginRequested: false,
    createdAt: Number(r.created_at as number),
  };
}
