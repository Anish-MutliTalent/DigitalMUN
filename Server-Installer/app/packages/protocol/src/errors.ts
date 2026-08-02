/**
 * @mun/protocol — error codes
 *
 * Stable string codes used in both REST error responses and WebSocket
 * `error` messages. Clients can branch on codes without parsing text.
 */

export type ErrorCode =
  // Auth
  | 'AUTH_INVALID_CREDENTIALS'
  | 'AUTH_SESSION_ACTIVE'
  | 'AUTH_RELOGIN_REQUIRED'
  | 'AUTH_RELOGIN_DENIED'
  | 'AUTH_RELOGIN_NOT_REQUESTED'
  | 'AUTH_TOKEN_INVALID'
  | 'AUTH_TOKEN_EXPIRED'
  | 'AUTH_FORBIDDEN'
  | 'AUTH_RATE_LIMITED'
  // Committee / delegate
  | 'COMMITTEE_NOT_FOUND'
  | 'DELEGATE_NOT_FOUND'
  | 'DELEGATE_DISABLED'
  | 'DELEGATE_ALREADY_ENABLED'
  // Voting
  | 'VOTE_NOT_FOUND'
  | 'VOTE_NOT_OPEN'
  | 'VOTE_ALREADY_CAST'
  | 'VOTE_INVALID_SIGNATURE'
  | 'VOTE_INVALID_CHOICE'
  | 'VOTE_REVEAL_NOT_READY'
  | 'VOTE_NOT_REVEALED'
  // Monitoring
  | 'MONITOR_RATE_LIMITED'
  | 'MONITOR_INVALID_EVENT'
  // Protocol
  | 'PROTOCOL_BAD_VERSION'
  | 'PROTOCOL_BAD_MESSAGE'
  | 'PROTOCOL_UNAUTHENTICATED'
  // System
  | 'INTERNAL_ERROR'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'VALIDATION_ERROR'
  | 'SERVICE_UNAVAILABLE';

export interface ApiError {
  code: ErrorCode;
  message: string;
  /** Field-level validation details, when applicable. */
  details?: Array<{ field: string; issue: string }>;
}

export class ProtocolError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Array<{ field: string; issue: string }>;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; details?: Array<{ field: string; issue: string }> } = {},
  ) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.status = opts.status ?? codeToStatus(code);
    this.details = opts.details;
  }

  toApiError(): ApiError {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function codeToStatus(code: ErrorCode): number {
  switch (code) {
    case 'AUTH_INVALID_CREDENTIALS':
    case 'AUTH_TOKEN_INVALID':
    case 'AUTH_TOKEN_EXPIRED':
      return 401;
    case 'AUTH_FORBIDDEN':
    case 'AUTH_RELOGIN_DENIED':
      return 403;
    case 'AUTH_SESSION_ACTIVE':
    case 'AUTH_RELOGIN_REQUIRED':
    case 'AUTH_RELOGIN_NOT_REQUESTED':
      return 409;
    case 'AUTH_RATE_LIMITED':
    case 'MONITOR_RATE_LIMITED':
      return 429;
    case 'COMMITTEE_NOT_FOUND':
    case 'DELEGATE_NOT_FOUND':
    case 'VOTE_NOT_FOUND':
    case 'NOT_FOUND':
      return 404;
    case 'DELEGATE_ALREADY_ENABLED':
    case 'VOTE_ALREADY_CAST':
    case 'CONFLICT':
      return 409;
    case 'DELEGATE_DISABLED':
    case 'VOTE_NOT_OPEN':
    case 'VOTE_INVALID_SIGNATURE':
    case 'VOTE_INVALID_CHOICE':
    case 'VOTE_REVEAL_NOT_READY':
    case 'VOTE_NOT_REVEALED':
    case 'MONITOR_INVALID_EVENT':
    case 'VALIDATION_ERROR':
      return 400;
    case 'PROTOCOL_BAD_VERSION':
    case 'PROTOCOL_BAD_MESSAGE':
    case 'PROTOCOL_UNAUTHENTICATED':
      return 400;
    case 'INTERNAL_ERROR':
      return 500;
    case 'SERVICE_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}
