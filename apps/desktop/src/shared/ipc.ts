/**
 * @mun/desktop — shared IPC contract
 *
 * The typed bridge between the Electron main process and the React renderer.
 * The preload script implements `MunApi` via contextBridge; the renderer imports
 * only the types from here. Keeping the contract in one place guarantees the
 * two sides stay in sync.
 */

import type {
  LoginResponse,
  VoteChoice,
  ServerEnvelope,
  Committee,
  Delegate,
  User,
  AiDetectionRule,
  VoteCastAckPayload,
  ConnectionStatus,
  Submission,
  SubmissionType,
} from '@mun/protocol';

export const IPC = {
  // Renderer → Main (invoke)
  LOGIN: 'mun:login',
  LOGOUT: 'mun:logout',
  REFRESH: 'mun:refresh',
  GET_STATE: 'mun:get-state',
  CLEAR_STATE: 'mun:clear-state',
  CAST_VOTE: 'mun:cast-vote',
  REQUEST_RELOGIN: 'mun:request-relogin',
  CANCEL_RELOGIN: 'mun:cancel-relogin',
  SET_SERVER_URL: 'mun:set-server-url',
  GET_SERVER_URL: 'mun:get-server-url',
  GET_SERVER_PUBLIC_KEY: 'mun:get-server-public-key',
  GET_CONNECTION: 'mun:get-connection',
  GET_MONITORING: 'mun:get-monitoring',
  GET_PLATFORM: 'mun:get-platform',
  API_REQUEST: 'mun:api-request',
  JOIN: 'mun:join',
  GET_JOIN_OPTIONS: 'mun:get-join-options',
  SUBMIT_LINK: 'mun:submit-link',
  SUBMIT_FILE: 'mun:submit-file',
  PICK_FILE: 'mun:pick-file',
  LIST_SUBMISSIONS: 'mun:list-submissions',
  MARK_SUBMISSION_REVIEWED: 'mun:mark-submission-reviewed',
  DELETE_SUBMISSION: 'mun:delete-submission',
  OPEN_SUBMISSION_FILE: 'mun:open-submission-file',
  OPEN_SUBMISSION_LINK: 'mun:open-submission-link',
  // Main → Renderer (push)
  EVENT: 'mun:event',
  CONNECTION: 'mun:connection',
  MONITORING: 'mun:monitoring',
} as const;

/** The persisted session restored on app start (for auto-reconnect). */
export interface PersistedState {
  user: User | null;
  delegate: Delegate | null;
  committees: Committee[];
  accessToken: string | null;
  refreshToken: string | null;
  deviceId: string;
  rules: AiDetectionRule[];
  serverUrl: string;
}

export interface ConnectionInfo {
  ws: 'connecting' | 'open' | 'closed';
  monitoring: 'active' | 'paused' | 'inactive';
  pausedReason: string | null;
}

export interface MonitoringState {
  active: boolean;
  paused: boolean;
  currentAppName: string | null;
  away: boolean;
  flagged: boolean;
  lastEventAt: number | null;
}

export interface LoginResult {
  ok: boolean;
  response?: LoginResponse;
  reloginRequired?: boolean;
  requestId?: string;
  message?: string;
  error?: string;
}

export interface JoinOptionCountry {
  country: string;
  delegateId: string;
  taken: boolean;
}
export interface JoinOptionCommittee {
  committeeId: string;
  committeeName: string;
  countries: JoinOptionCountry[];
}

/** The full API exposed to the renderer via contextBridge. */
export interface MunApi {
  login(username: string, password: string): Promise<LoginResult>;
  /** Delegate passwordless join: claim a (committee, country) delegation slot. */
  join(committeeId: string, country: string): Promise<LoginResult>;
  /** Public list of committees + country slots + taken status (for delegate join). */
  getJoinOptions(): Promise<JoinOptionCommittee[]>;
  logout(): Promise<void>;
  refreshSession(): Promise<boolean>;
  getState(): Promise<PersistedState>;
  clearState(): Promise<void>;
  castVote(voteId: string, choice: VoteChoice): Promise<VoteCastAckPayload>;
  requestRelogin(reason: string): Promise<void>;
  cancelRelogin(requestId: string): Promise<void>;
  setServerUrl(url: string): Promise<void>;
  getServerUrl(): Promise<string>;
  getServerPublicKey(): Promise<string>;
  getConnection(): Promise<ConnectionInfo>;
  getMonitoring(): Promise<MonitoringState>;
  getPlatform(): Promise<'windows' | 'macos'>;
  /**
   * Authenticated REST proxy. The main process attaches the access token; the
   * renderer never handles tokens directly. Returns { status, data }.
   */
  apiRequest(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: unknown }>;
  // ─── Submissions (resolutions / directives) ──
  /** Submit a resolution/directive as a Google Doc (or other) link. */
  submitLinkSubmission(
    committeeId: string,
    type: SubmissionType,
    title: string,
    url: string,
  ): Promise<{ ok: boolean; submission?: Submission; error?: string }>;
  /** Submit a file (opens a native file picker, then uploads PDF/DOC). */
  submitFileSubmission(
    committeeId: string,
    type: SubmissionType,
    title: string,
    filePath: string,
  ): Promise<{ ok: boolean; submission?: Submission; error?: string }>;
  /** Open a native file picker and return the chosen path + name (no upload). */
  pickFile(): Promise<{ path: string; name: string } | null>;
  listSubmissions(committeeId: string): Promise<Submission[]>;
  markSubmissionReviewed(committeeId: string, id: string): Promise<void>;
  deleteSubmission(committeeId: string, id: string): Promise<void>;
  /** Download a file submission to a temp file and open it. */
  openSubmissionFile(committeeId: string, id: string, fileName: string): Promise<void>;
  /** Open a link submission in the system browser. */
  openSubmissionLink(url: string): Promise<void>;
  /** Subscribe to realtime server→client envelopes. Returns an unsubscribe fn. */
  onEvent(listener: (env: ServerEnvelope) => void): () => void;
  /** Subscribe to connection-state changes. */
  onConnection(listener: (info: ConnectionInfo) => void): () => void;
  /** Subscribe to monitoring-state changes (delegate). */
  onMonitoring(listener: (state: MonitoringState) => void): () => void;
}

declare global {
  interface Window {
    mun: MunApi;
  }
}
