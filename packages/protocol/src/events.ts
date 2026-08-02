/**
 * @mun/protocol — monitoring event wire types
 *
 * These are the event records produced by the desktop monitoring engine and
 * ingested by the server. They carry ONLY integrity-relevant metadata:
 *   - which application is in the foreground
 *   - a coarse window title (scoped — see MonitoringEvent.titleScope)
 *   - which detection rule matched, if any
 *   - timing (away/idle durations)
 *
 * They deliberately NEVER carry screenshots, video, audio, keystrokes,
 * document contents, or clipboard data. See docs/architecture.md → Privacy.
 */

import type { MonitoringEventType, Severity } from './models.js';

/**
 * How much of the window title is disclosed.
 *  - none     : no title recorded (default for non-flagged, non-MUN apps)
 *  - app_only : only the application name; title omitted for privacy
 *  - matched  : title recorded because a detection rule matched (required for
 *               the integrity warning; e.g. "ChatGPT - Google Chrome")
 *  - self     : the focused app is MUN Guardian itself (title = our app)
 *
 * This scoping enforces the project's data-minimisation principle: full window
 * titles are recorded only when an integrity rule actually matches.
 */
export type TitleScope = 'none' | 'app_only' | 'matched' | 'self';

/**
 * A monitoring event as sent from client → server.
 * `clientEventId` is a client-generated UUID used for idempotent ingest
 * (dedup after reconnect / duplicate delivery).
 */
export interface MonitoringEventWire {
  /** Client-generated idempotency key (UUID v4). */
  clientEventId: string;
  delegateId: string;
  committeeId: string;
  type: MonitoringEventType;
  /** Client wall-clock at event time (ms). Server re-stamps on ingest. */
  clientTs: number;
  /** Foreground application / process name, or null. */
  appName: string | null;
  /** Window title (only present when titleScope is 'matched' or 'self'). */
  title: string | null;
  titleScope: TitleScope;
  /** Id of the AI-detection rule that matched, or null. */
  matchedRuleId: string | null;
  /** Matched rule display name (for the chair feed without a join). */
  matchedRuleName: string | null;
  /** Severity derived from the matched rule, or 'info'. */
  severity: Severity;
  /** Away/idle duration in ms, for 'away'/'return'/'idle' events. */
  durationMs: number | null;
  /** Previous foreground app (for focus_change context). */
  fromAppName: string | null;
}

/**
 * A monitoring event as broadcast server → chair/admin (realtime feed).
 * Adds the server timestamp and a stable server id.
 */
export interface MonitoringEventBroadcast {
  id: string;
  delegateId: string;
  committeeId: string;
  delegateDisplayName: string;
  country: string;
  type: MonitoringEventType;
  serverTs: number;
  clientTs: number;
  appName: string | null;
  title: string | null;
  titleScope: TitleScope;
  matchedRuleId: string | null;
  matchedRuleName: string | null;
  severity: Severity;
  durationMs: number | null;
  fromAppName: string | null;
}

/** Live delegate status broadcast (presence + monitoring summary). */
export interface DelegateStatusBroadcast {
  delegateId: string;
  committeeId: string;
  connectionStatus: import('./models.js').ConnectionStatus;
  attendance: import('./models.js').Attendance;
  enabled: boolean;
  lastHeartbeatAt: number | null;
  /** Current foreground app, or null when away/idle. */
  currentAppName: string | null;
  /** Whether the delegate is currently considered "away". */
  away: boolean;
  /** Whether the delegate is currently in a flagged (AI/unexpected) app. */
  flagged: boolean;
  updatedAt: number;
}
