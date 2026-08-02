/**
 * @mun/server — realtime sink abstraction
 *
 * The broker talks to a `ClientSink`, not a raw WebSocket, so the broker is
 * testable and decoupled from the transport. The WS handler adapts a
 * `WebSocket` into a `ClientSink`.
 */

import type { Role, ConnectionStatus, Attendance } from '@mun/protocol';

export interface ClientSink {
  /** Stable unique id for this connection (UUID). */
  id: string;
  userId: string;
  role: Role;
  /** Session id this connection authenticated with (for revocation re-checks). */
  sessionId: string;
  delegateId: string | null;
  committeeId: string | null;
  /** Send a raw JSON string to the client. */
  send: (data: string) => void;
  /** Close the connection. */
  close: (code?: number, reason?: string) => void;
  /** Whether the underlying socket is open. */
  isAlive: () => boolean;
}

/** Live presence snapshot for a delegate (used by the chair dashboard). */
export interface PresenceState {
  delegateId: string;
  committeeId: string;
  connectionStatus: ConnectionStatus;
  attendance: Attendance;
  enabled: boolean;
  lastHeartbeatAt: number | null;
  currentAppName: string | null;
  away: boolean;
  flagged: boolean;
  updatedAt: number;
}
