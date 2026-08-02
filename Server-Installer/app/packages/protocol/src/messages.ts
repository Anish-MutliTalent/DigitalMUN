/**
 * @mun/protocol — realtime WebSocket protocol
 *
 * A single typed envelope carries every WebSocket message. Auth happens over
 * HTTP (REST) first; the client then opens a WebSocket and sends a `hello`
 * carrying its access token. The server validates the token, resolves the
 * user/delegate/committee, and subscribes the socket to the right channels.
 *
 * Every message carries a server-or-client timestamp and an optional
 * correlation id (`id` on requests, `ref` on responses) so replies and
 * acks can be matched (e.g. cast_vote → vote_cast_ack).
 */

import type {
  Committee,
  CommitteeStatus,
  Delegate,
  ScheduledBreak,
  Severity,
  SystemHealth,
  Vote,
  VoteResult,
  Warning,
} from './models.js';
import type {
  DelegateStatusBroadcast,
  MonitoringEventBroadcast,
} from './events.js';
import type { VoteChoice } from './models.js';

export const PROTOCOL_VERSION = 1;

/** All distinct message types on the wire. */
export type MessageType =
  // Client → Server
  | 'hello'
  | 'heartbeat'
  | 'monitor_event'
  | 'cast_vote'
  | 'subscribe_committee'
  | 'unsubscribe_committee'
  | 'request_relogin' // delegate asks chair to approve a re-login
  | 'cancel_relogin'
  | 'client_ack' // acknowledge a server warning/event (for ordered delivery)
  // Server → Client
  | 'welcome'
  | 'heartbeat_ack'
  | 'auth_error'
  | 'committee_state'
  | 'delegate_status'
  | 'monitor_broadcast'
  | 'warning'
  | 'warning_acked'
  | 'vote_state'
  | 'vote_cast_ack'
  | 'vote_revealed'
  | 'break_state'
  | 'relogin_update' // chair sees a re-login request; delegate sees approval/denial
  | 'system_health'
  | 'force_logout' // chair/admin forced this client out
  | 'monitoring_paused' // committee paused/break/emergency → client pauses monitoring
  | 'monitoring_resumed'
  | 'rules_updated' // AI-detection rule set changed → client reloads
  | 'submission' // a delegate submitted a resolution/directive
  | 'submission_update' // a submission's status changed (reviewed)
  | 'error'
  | 'pong';

/** Direction of a message type, used for validation. */
export type MessageDirection = 'client_to_server' | 'server_to_client';

export const CLIENT_TO_SERVER: ReadonlySet<MessageType> = new Set<MessageType>([
  'hello',
  'heartbeat',
  'monitor_event',
  'cast_vote',
  'subscribe_committee',
  'unsubscribe_committee',
  'request_relogin',
  'cancel_relogin',
  'client_ack',
]);

export const SERVER_TO_CLIENT: ReadonlySet<MessageType> = new Set<MessageType>([
  'welcome',
  'heartbeat_ack',
  'auth_error',
  'committee_state',
  'delegate_status',
  'monitor_broadcast',
  'warning',
  'warning_acked',
  'vote_state',
  'vote_cast_ack',
  'vote_revealed',
  'break_state',
  'relogin_update',
  'system_health',
  'force_logout',
  'monitoring_paused',
  'monitoring_resumed',
  'rules_updated',
  'submission',
  'submission_update',
  'error',
  'pong',
]);

/** The wire envelope. `payload` is one of the typed payloads below. */
export interface Envelope<T extends MessageType = MessageType, P = unknown> {
  v: typeof PROTOCOL_VERSION;
  t: T;
  /** Correlation id set by the requester. */
  id?: string;
  /** Correlation id echoed by the responder. */
  ref?: string;
  /** Sender wall-clock (ms). */
  ts: number;
  payload: P;
}

// ─── Client → Server payloads ─────────────────────────────────────────────────

export interface HelloPayload {
  /** Short-lived access token (JWT-like, HMAC-signed). */
  accessToken: string;
  /** Platform reported by the client ('windows' | 'macos'). */
  platform: 'windows' | 'macos';
  /** Client version string. */
  clientVersion: string;
}

export interface HeartbeatPayload {
  /** Client wall-clock (ms) for drift estimation. */
  clientTs: number;
  /** Whether monitoring is currently active on the client. */
  monitoringActive: boolean;
}

export interface CastVotePayload {
  voteId: string;
  choice: VoteChoice;
  /** Delegate Ed25519 signature over the canonical vote message. */
  signature: string;
  /** Delegate public key (base64url) for verification. */
  publicKey: string;
  /** Client idempotency key (UUID) — dedups duplicate casts. */
  clientCastId: string;
}

export interface SubscribeCommitteePayload {
  committeeId: string;
}

export interface RequestReloginPayload {
  reason: string;
}

// ─── Server → Client payloads ─────────────────────────────────────────────────

export interface WelcomePayload {
  user: { id: string; username: string; role: 'delegate' | 'chair' | 'admin'; displayName: string };
  /** committees the client is authorised to view. */
  committees: Committee[];
  /** Resolved delegate record, if the user is a delegate. */
  delegate: Delegate | null;
  /** Heartbeat interval the client should use (ms). */
  heartbeatIntervalMs: number;
  /** Server-reported time (ms) for clock-drift correction. */
  serverTs: number;
}

export interface CommitteeStatePayload {
  committee: Committee;
  delegates: Delegate[];
  /** Open or recent vote summary (counts only until revealed). */
  votes: Vote[];
  activeBreak: ScheduledBreak | null;
  rev: number;
}

export interface VoteStatePayload {
  vote: Vote;
  /** Only present after reveal. */
  result: VoteResult | null;
}

export interface VoteCastAckPayload {
  voteId: string;
  clientCastId: string;
  accepted: boolean;
  /** Server-signed receipt (so the delegate can later prove their vote). */
  receipt: string | null;
  /** Reason for rejection, if accepted === false. */
  reason: string | null;
  /** Current submitted count (chair/visibility-safe). */
  submittedCount: number;
  requiredCount: number;
}

export interface VoteRevealedPayload {
  vote: Vote;
  result: VoteResult;
}

export interface ReloginUpdatePayload {
  requestId: string;
  delegateId: string;
  committeeId: string;
  delegateDisplayName: string;
  country: string;
  status: 'requested' | 'approved' | 'denied' | 'cancelled';
  reason: string | null;
  /** Chair who decided, when applicable. */
  decidedBy: string | null;
  timestamp: number;
}

export interface MonitoringPausedPayload {
  reason: 'break' | 'paused' | 'emergency_stopped';
  committeeId: string;
  /** Expected resume time (ms), or null when unknown. */
  resumeAt: number | null;
}

export interface MonitoringResumedPayload {
  committeeId: string;
  status: CommitteeStatus;
}

export interface RulesUpdatedPayload {
  /** The full updated rule set to apply (client replaces its local copy). */
  rules: import('./rules.js').AiDetectionRule[];
}

export interface WarningPayload {
  warning: Warning;
}

export interface ErrorPayload {
  /** Stable error code (see errors.ts). */
  code: string;
  message: string;
  /** Whether the error is fatal (client should disconnect). */
  fatal: boolean;
}

export interface ForceLogoutPayload {
  reason: string;
  /** Whether the session was revoked (client must re-authenticate). */
  revoked: boolean;
}

export interface SubmissionPayload {
  submission: import('./models.js').Submission;
}

// ─── Typed envelope helpers ───────────────────────────────────────────────────

/** Maps a message type to its payload type (client → server). */
export interface ClientPayloadMap {
  hello: HelloPayload;
  heartbeat: HeartbeatPayload;
  monitor_event: import('./events.js').MonitoringEventWire;
  cast_vote: CastVotePayload;
  subscribe_committee: SubscribeCommitteePayload;
  unsubscribe_committee: SubscribeCommitteePayload;
  request_relogin: RequestReloginPayload;
  cancel_relogin: Record<string, never>;
  client_ack: { ref: string };
}

/** Maps a message type to its payload type (server → client). */
export interface ServerPayloadMap {
  welcome: WelcomePayload;
  heartbeat_ack: { serverTs: number; driftMs: number };
  auth_error: ErrorPayload;
  committee_state: CommitteeStatePayload;
  delegate_status: DelegateStatusBroadcast;
  monitor_broadcast: MonitoringEventBroadcast;
  warning: WarningPayload;
  warning_acked: { warningId: string; by: string; at: number };
  vote_state: VoteStatePayload;
  vote_cast_ack: VoteCastAckPayload;
  vote_revealed: VoteRevealedPayload;
  break_state: { break: ScheduledBreak | null; committeeId: string };
  relogin_update: ReloginUpdatePayload;
  system_health: SystemHealth;
  force_logout: ForceLogoutPayload;
  monitoring_paused: MonitoringPausedPayload;
  monitoring_resumed: MonitoringResumedPayload;
  rules_updated: RulesUpdatedPayload;
  submission: SubmissionPayload;
  submission_update: SubmissionPayload;
  error: ErrorPayload;
  pong: { serverTs: number };
}

/** A fully-typed client→server envelope. */
export type ClientEnvelope<T extends keyof ClientPayloadMap = keyof ClientPayloadMap> =
  Envelope<Extract<MessageType, T>, ClientPayloadMap[T]>;

/** A fully-typed server→client envelope. */
export type ServerEnvelope<T extends keyof ServerPayloadMap = keyof ServerPayloadMap> =
  Envelope<Extract<MessageType, T>, ServerPayloadMap[T]>;

// ─── Constructors ─────────────────────────────────────────────────────────────

export function envelope<T extends MessageType, P>(
  t: T,
  payload: P,
  opts: { id?: string; ref?: string; ts?: number } = {},
): Envelope<T, P> {
  return {
    v: PROTOCOL_VERSION,
    t,
    ts: opts.ts ?? Date.now(),
    id: opts.id,
    ref: opts.ref,
    payload,
  };
}

export function directionOf(t: MessageType): MessageDirection | 'unknown' {
  if (CLIENT_TO_SERVER.has(t)) return 'client_to_server';
  if (SERVER_TO_CLIENT.has(t)) return 'server_to_client';
  return 'unknown';
}

// Re-export severity for convenience in message modules.
export type { Severity };
