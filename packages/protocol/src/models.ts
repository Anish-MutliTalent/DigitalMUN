/**
 * @mun/protocol — domain models
 *
 * Canonical, transport-agnostic domain types shared by the MUN Guardian
 * server and desktop clients. These are the single source of truth for the
 * shape of data flowing over HTTP and WebSocket. Zod schemas in `schema.ts`
 * mirror and validate these at every trust boundary.
 *
 * Design rules:
 *  - Identifiers are opaque strings (UUID v4) unless stated otherwise.
 *  - Timestamps are integer milliseconds since the Unix epoch (UTC).
 *  - Enums are string unions for JSON-friendliness.
 *  - No server-only or client-only fields leak across the wire.
 */

// ─── Roles & users ────────────────────────────────────────────────────────────

export type Role = 'delegate' | 'chair' | 'admin' | 'vice';

export interface User {
  id: string;
  username: string;
  role: Role;
  displayName: string;
  createdAt: number;
}

/** Public user profile returned to clients (never includes credentials). */
export interface UserProfile extends User {
  /** Committees the user is associated with, if any. */
  committeeIds: string[];
}

// ─── Committees ───────────────────────────────────────────────────────────────

/**
 * Runtime state of a committee.
 *  - active           : debate in progress, monitoring live
 *  - paused           : chair/admin paused the committee (monitoring paused)
 *  - break            : scheduled break in progress (monitoring paused, UI = STANDBY)
 *  - emergency_stopped: admin emergency stop (monitoring paused, locked)
 */
export type CommitteeStatus = 'active' | 'paused' | 'break' | 'emergency_stopped';

export interface Committee {
  id: string;
  name: string;
  topic: string;
  description: string;
  status: CommitteeStatus;
  chairUserId: string | null;
  viceUserId: string | null;
  createdAt: number;
  /** Update sequence — increments on every state change for optimistic sync. */
  rev: number;
}

// ─── Delegates ────────────────────────────────────────────────────────────────

export type Attendance = 'not_checked_in' | 'present' | 'voting' | 'absent';

export type ConnectionStatus =
  | 'never_connected'
  | 'connected'
  | 'disconnected'
  | 'reconnecting';

export interface Delegate {
  id: string;
  userId: string;
  committeeId: string;
  country: string;
  attendance: Attendance;
  connectionStatus: ConnectionStatus;
  /** When the delegate last sent a heartbeat (ms), or null. */
  lastHeartbeatAt: number | null;
  /** Whether the chair has enabled the delegate (disabled delegates can't vote). */
  enabled: boolean;
  /** Reason or comment entered by chair when disabling. */
  disabledReason?: string | null;
  /** Whether the delegate has requested re-login approval. */
  reloginRequested: boolean;
  createdAt: number;
}

// ─── Monitoring ───────────────────────────────────────────────────────────────

/**
 * The type of a monitoring event. Events are emitted only on state change
 * (event-driven), never as a continuous stream.
 */
export type MonitoringEventType =
  | 'focus_change' // foreground app/window changed
  | 'away' // delegate left MUN Guardian / went idle beyond threshold
  | 'return' // delegate returned to MUN Guardian
  | 'ai_detected' // an AI-assistant rule matched
  | 'unexpected_app' // an app not on the allowlist was focused
  | 'idle' // system idle beyond threshold (no focus change)
  | 'session_start' // monitoring session began
  | 'session_end'; // monitoring session ended (break/logout)

/** Severity of an integrity warning derived from an event. */
export type Severity = 'info' | 'warning' | 'critical';

// ─── Warnings ─────────────────────────────────────────────────────────────────

export type WarningType =
  | 'ai_detected'
  | 'unexpected_app'
  | 'away'
  | 'disconnected'
  | 'relogin_request'
  | 'duplicate_login_attempt';

export interface Warning {
  id: string;
  committeeId: string;
  delegateId: string;
  type: WarningType;
  severity: Severity;
  message: string;
  /** The rule that triggered the warning, if any. */
  ruleId: string | null;
  /** The application name captured when the warning was raised. */
  appName: string | null;
  /** Event timestamp (ms). */
  timestamp: number;
  /** Whether the chair has acknowledged the warning. */
  acknowledged: boolean;
  acknowledgedBy: string | null;
  acknowledgedAt: number | null;
}

// ─── Voting ───────────────────────────────────────────────────────────────────

export type VoteStatus = 'open' | 'closed' | 'revealed';

/** FOR or AGAINST only — abstention is intentionally not supported. */
export type VoteChoice = 'for' | 'against';

export interface Vote {
  id: string;
  committeeId: string;
  question: string;
  status: VoteStatus;
  createdBy: string;
  createdAt: number;
  closedAt: number | null;
  revealedAt: number | null;
  /** Number of enabled, checked-in delegates required to complete the vote. */
  requiredCount: number;
  /** Number of votes submitted so far. */
  submittedCount: number;
}

/**
 * A single recorded vote. `choice` is only populated server→client after the
 * vote is revealed. Before reveal, clients receive counts only.
 */
export interface VoteRecord {
  voteId: string;
  delegateId: string;
  choice: VoteChoice | null;
  submittedAt: number;
  /** Server-signed receipt the delegate can use to verify their vote was recorded. */
  receipt: string;
  /** Delegate's Ed25519 signature over the canonical vote message (verifiable). */
  signature: string;
}

/** Aggregate result of a revealed vote. */
export interface VoteResult {
  voteId: string;
  forCount: number;
  againstCount: number;
  requiredCount: number;
  submittedCount: number;
  /** Per-delegate records, only available after reveal. */
  records: VoteRecord[];
  revealedAt: number | null;
}

// ─── Breaks ───────────────────────────────────────────────────────────────────

export type BreakStatus = 'scheduled' | 'active' | 'ended' | 'cancelled';

export interface ScheduledBreak {
  id: string;
  committeeId: string;
  startAt: number;
  endAt: number;
  status: BreakStatus;
  label: string;
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export type AuditAction =
  | 'login'
  | 'logout'
  | 'session_revoke'
  | 'relogin_request'
  | 'relogin_approve'
  | 'relogin_deny'
  | 'committee_create'
  | 'committee_update'
  | 'committee_pause'
  | 'committee_resume'
  | 'emergency_stop'
  | 'emergency_resume'
  | 'delegate_enable'
  | 'delegate_disable'
  | 'delegate_force_logout'
  | 'vote_open'
  | 'vote_close'
  | 'vote_reveal'
  | 'vote_cast'
  | 'warning_ack'
  | 'monitor_event'
  | 'break_start'
  | 'break_end'
  | 'rule_create'
  | 'rule_update'
  | 'rule_delete'
  | 'user_create'
  | 'key_reset'
  | 'admin_export'
  | 'update_settings'
  | 'submission_submit'
  | 'submission_review'
  | 'submission_delete';

export interface AuditEntry {
  /** Monotonic sequence number within the audit log. */
  seq: number;
  timestamp: number;
  /** User id of the actor, or 'system'. */
  actor: string;
  action: AuditAction;
  /** Primary subject id (committee, delegate, vote, etc.), or null. */
  subject: string | null;
  /** Short human-readable detail. */
  detail: string;
  /** SHA-256 hash of this entry (hex). */
  hash: string;
  /** SHA-256 hash of the previous entry (hex); genesis entry has a fixed value. */
  prevHash: string;
}

// ─── System health ────────────────────────────────────────────────────────────

export interface SystemHealth {
  uptimeMs: number;
  connectedDelegates: number;
  connectedChairs: number;
  committees: number;
  activeVotes: number;
  warningsLastHour: number;
  monitorEventsLastHour: number;
  dbLatencyMs: number;
  wsConnections: number;
  /** Whether the server is accepting connections. */
  healthy: boolean;
  timestamp: number;
}

// ─── Submissions (resolutions / directives) ───────────────────────────────────

export type SubmissionType = 'resolution' | 'directive';
export type SubmissionKind = 'file' | 'link';
export type SubmissionStatus = 'submitted' | 'reviewed';

/**
 * A resolution or directive submitted by a delegate. Either an uploaded file
 * (PDF/DOC, stored server-side) or a Google Doc link. Visible to the chair in
 * real time, replacing email/SMS submission.
 */
export interface Submission {
  id: string;
  committeeId: string;
  delegateId: string;
  delegateName: string;
  country: string;
  type: SubmissionType;
  title: string;
  kind: SubmissionKind;
  /** For file submissions: original file name. */
  fileName: string | null;
  /** For link submissions: the Google Doc (or other) URL. */
  url: string | null;
  status: SubmissionStatus;
  submittedAt: number;
  reviewedAt: number | null;
  reviewedBy: string | null;
}
