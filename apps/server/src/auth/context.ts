/**
 * @mun/server — authentication context & Fastify middleware
 *
 * A single preHandler reads the Bearer access token, resolves the session, and
 * attaches an `AuthContext` to `request.user`. Routes declare the required
 * role(s) via `requireRole(...)`. No route trusts client-supplied identity;
 * identity always derives from the verified token.
 */

import type { FastifyRequest, FastifyReply, preHandlerHookHandler } from 'fastify';
import { getSessionByAccessToken } from './sessions.js';
import { pool } from '../db/pool.js';
import type { Role } from '@mun/protocol';
import { ProtocolError } from '@mun/protocol';

export interface AuthContext {
  userId: string;
  role: Role;
  sessionId: string;
  deviceId: string;
  /** Resolved delegate id + committee, when the user is a delegate. */
  delegateId: string | null;
  committeeId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthContext;
  }
}

/** Resolve the delegate record (if any) for a user, in one query. */
async function resolveDelegate(userId: string): Promise<{ delegateId: string; committeeId: string } | null> {
  const { rows } = await pool.query(
    'SELECT id, committee_id FROM delegates WHERE user_id = $1',
    [userId],
  );
  if (rows.length === 0) return null;
  return { delegateId: rows[0].id as string, committeeId: rows[0].committee_id as string };
}

/** Bearer-token auth preHandler. Attaches `request.user`. */
export const authPreHandler: preHandlerHookHandler = async (request, _reply) => {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    throw new ProtocolError('AUTH_TOKEN_INVALID', 'Missing or malformed Authorization header');
  }
  const token = header.slice('Bearer '.length).trim();
  const resolved = await getSessionByAccessToken(token);
  if (!resolved) {
    throw new ProtocolError('AUTH_TOKEN_INVALID', 'Invalid or expired access token');
  }
  const delegate =
    resolved.role === 'delegate' ? await resolveDelegate(resolved.userId) : null;
  request.user = {
    userId: resolved.userId,
    role: resolved.role,
    sessionId: resolved.session.id,
    deviceId: resolved.session.deviceId,
    delegateId: delegate?.delegateId ?? null,
    committeeId: delegate?.committeeId ?? null,
  };
};

/** Returns a preHandler that rejects callers without one of the given roles. */
export function requireRole(...roles: Role[]): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) {
      throw new ProtocolError('AUTH_TOKEN_INVALID', 'Authentication required');
    }
    if (!roles.includes(request.user.role)) {
      throw new ProtocolError('AUTH_FORBIDDEN', 'Insufficient role');
    }
  };
}

/** Convenience: require the caller to be the chair of the committee in params (or an admin). */
export function requireCommitteeChair(): preHandlerHookHandler {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) {
      throw new ProtocolError('AUTH_TOKEN_INVALID', 'Authentication required');
    }
    const user = request.user;
    if (user.role !== 'chair' && user.role !== 'admin') {
      throw new ProtocolError('AUTH_FORBIDDEN', 'Chair or admin role required');
    }
    if (user.role === 'admin') return; // admins can act as chair
    const committeeId = (request.params as Record<string, unknown>).committeeId as
      | string
      | undefined;
    if (!committeeId) {
      throw new ProtocolError('AUTH_FORBIDDEN', 'Committee context required');
    }
    const { rows } = await pool.query('SELECT chair_user_id FROM committees WHERE id = $1', [
      committeeId,
    ]);
    if (rows.length === 0) throw new ProtocolError('COMMITTEE_NOT_FOUND', 'Committee not found');
    if (rows[0].chair_user_id !== user.userId) {
      throw new ProtocolError('AUTH_FORBIDDEN', 'Not the chair of this committee');
    }
  };
}
