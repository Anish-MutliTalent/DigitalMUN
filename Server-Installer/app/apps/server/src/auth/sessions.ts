/**
 * @mun/server — session management
 *
 * Enforces the authentication guarantees in the spec:
 *  - One active session per user (single device). For delegates, a second
 *    login while a session is active is blocked pending chair approval; for
 *    chairs/admins the previous session is revoked on a new login.
 *  - Crashes do NOT auto-free sessions (rows persist until explicit revoke or
 *    chair-approved re-login), so a crashed delegate cannot trivially log in
 *    elsewhere.
 *  - Refresh tokens are single-use (rotated jti); presenting an already-rotated
 *    refresh token is rejected as a replay.
 *  - Tokens are HMAC-signed (see @mun/crypto); only their SHA-256 hash is
 *    stored, so a DB leak cannot forge tokens.
 */

import { pool, tx } from '../db/pool.js';
import { config } from '../config.js';
import { TokenService, randomUuid, sha256Hex } from '@mun/crypto';
import type { Role } from '@mun/protocol';

export const tokenService = new TokenService(config.sessionSecret, config.refreshSecret);

export interface SessionRow {
  id: string;
  userId: string;
  role: Role;
  deviceId: string;
  platform: string;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  revoked: boolean;
  revokeReason: string | null;
}

export interface IssuedSession {
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  accessJti: string;
  refreshJti: string;
}

/** Find a non-revoked, unexpired session for a user. */
export async function findActiveSession(userId: string): Promise<SessionRow | null> {
  const now = Date.now();
  const { rows } = await pool.query(
    `SELECT id, user_id, role, device_id, platform, created_at, expires_at,
            last_seen_at, revoked, revoke_reason
     FROM sessions
     WHERE user_id = $1 AND revoked = false AND expires_at > $2
     ORDER BY created_at DESC LIMIT 1`,
    [userId, now],
  );
  return rows.length ? rowToSession(rows[0]) : null;
}

/** Create a new session and issue tokens. */
export async function createSession(params: {
  userId: string;
  role: Role;
  deviceId: string;
  platform: string;
  clientVersion: string;
}): Promise<IssuedSession> {
  const sessionId = randomUuid();
  const now = Date.now();
  const expiresAt = now + config.sessionTtlSeconds * 1000;

  const access = tokenService.issueAccess({
    sub: params.userId,
    sid: sessionId,
    role: params.role,
    ttlSeconds: config.accessTtlSeconds,
  });
  const refresh = tokenService.issueRefresh({
    sub: params.userId,
    sid: sessionId,
    role: params.role,
    ttlSeconds: config.refreshTtlSeconds,
  });

  await pool.query(
    `INSERT INTO sessions
      (id, user_id, role, device_id, platform, client_version,
       access_token_hash, refresh_token_hash, refresh_jti, created_at, expires_at, last_seen_at, revoked)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $10, false)`,
    [
      sessionId,
      params.userId,
      params.role,
      params.deviceId,
      params.platform,
      params.clientVersion,
      sha256Hex(access.token),
      sha256Hex(refresh.token),
      refresh.payload.jti,
      now,
      expiresAt,
    ],
  );

  return {
    sessionId,
    accessToken: access.token,
    refreshToken: refresh.token,
    expiresIn: config.accessTtlSeconds,
    accessJti: access.payload.jti,
    refreshJti: refresh.payload.jti,
  };
}

/** Revoke a session (and optionally all sessions for a user). */
export async function revokeSession(sessionId: string, reason: string): Promise<void> {
  await pool.query(
    'UPDATE sessions SET revoked = true, revoke_reason = $1 WHERE id = $2 AND revoked = false',
    [reason, sessionId],
  );
}

export async function revokeAllForUser(userId: string, reason: string): Promise<void> {
  await pool.query(
    'UPDATE sessions SET revoked = true, revoke_reason = $1 WHERE user_id = $2 AND revoked = false',
    [reason, userId],
  );
}

/**
 * Rotate a refresh token: verify signature + expiry, look up the session by
 * refresh_token_hash, ensure the presented jti matches the stored current jti
 * (replay protection), then issue a new access token and a new refresh token
 * with a fresh jti. Atomic via transaction + row lock.
 *
 * Returns new tokens, or null if the refresh token is invalid/expired/revoked.
 */
export async function rotateRefresh(
  refreshToken: string,
): Promise<{ sessionId: string; userId: string; role: Role; accessToken: string; refreshToken: string; expiresIn: number } | null> {
  const payload = tokenService.verify(refreshToken, 'refresh');
  if (!payload) return null;

  return tx(async (client) => {
    const hash = sha256Hex(refreshToken);
    const { rows } = await client.query(
      'SELECT id, user_id, role, revoked, refresh_jti, expires_at FROM sessions WHERE refresh_token_hash = $1 FOR UPDATE',
      [hash],
    );
    if (rows.length === 0) return null;
    const row = rows[0];
    if (row.revoked) return null;
    if (row.refresh_jti !== payload.jti) return null; // replay/stale refresh
    if ((row.expires_at as number) <= Date.now()) return null;

    const access = tokenService.issueAccess({
      sub: row.user_id,
      sid: row.id,
      role: row.role,
      ttlSeconds: config.accessTtlSeconds,
    });
    const newRefresh = tokenService.issueRefresh({
      sub: row.user_id,
      sid: row.id,
      role: row.role,
      ttlSeconds: config.refreshTtlSeconds,
    });

    await client.query(
      'UPDATE sessions SET access_token_hash = $1, refresh_token_hash = $2, refresh_jti = $3, last_seen_at = $4 WHERE id = $5',
      [sha256Hex(access.token), sha256Hex(newRefresh.token), newRefresh.payload.jti, Date.now(), row.id],
    );

    return {
      sessionId: row.id,
      userId: row.user_id,
      role: row.role as Role,
      accessToken: access.token,
      refreshToken: newRefresh.token,
      expiresIn: config.accessTtlSeconds,
    };
  });
}

/** Resolve a session by access token hash (for REST auth + WS hello). */
export async function getSessionByAccessToken(
  accessToken: string,
): Promise<{ session: SessionRow; userId: string; role: Role } | null> {
  const payload = tokenService.verify(accessToken, 'access');
  if (!payload) return null;
  const { rows } = await pool.query(
    `SELECT id, user_id, role, device_id, platform, created_at, expires_at,
            last_seen_at, revoked, revoke_reason
     FROM sessions WHERE access_token_hash = $1`,
    [sha256Hex(accessToken)],
  );
  if (rows.length === 0) return null;
  const s = rowToSession(rows[0]);
  if (s.revoked) return null;
  if (s.expiresAt <= Date.now()) return null;
  return { session: s, userId: s.userId, role: s.role };
}

/** Update last-seen timestamp (heartbeat / activity). */
export async function touchSession(sessionId: string): Promise<void> {
  await pool.query('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [Date.now(), sessionId]);
}

function rowToSession(r: Record<string, unknown>): SessionRow {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    role: r.role as Role,
    deviceId: r.device_id as string,
    platform: r.platform as string,
    createdAt: r.created_at as number,
    expiresAt: r.expires_at as number,
    lastSeenAt: r.last_seen_at as number,
    revoked: r.revoked as boolean,
    revokeReason: (r.revoke_reason as string | null) ?? null,
  };
}
