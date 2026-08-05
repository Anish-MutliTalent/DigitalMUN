/**
 * @mun/server — authentication service
 *
 * Orchestration layer over sessions.ts, passwords.ts, and the realtime broker.
 * Implements the spec's authentication guarantees (see sessions.ts for the
 * low-level invariants):
 *
 *  Login (delegate): if an active session already exists, the login is NOT
 *  granted. Instead a re-login request is recorded (or the existing pending
 *  request is returned) and the chair is notified in real time. The delegate
 *  retries login after the chair approves (which revokes the old session).
 *
 *  Login (chair/admin): any previous session is revoked and a new one issued
 *  (operators may switch devices).
 */

import { pool } from '../db/pool.js';
import { verifyPassword } from './passwords.js';
import {
  createSession,
  findActiveSession,
  revokeSession,
  type IssuedSession,
} from './sessions.js';
import { loginLimiter, loginIpLimiter } from '../util/ratelimit.js';
import { audit } from '../audit/service.js';
import { broker } from '../realtime/broker.js';
import { envelope } from '@mun/protocol';
import {
  ProtocolError,
  type AiDetectionRule,
  type Committee,
  type Delegate,
  type LoginResponse,
  type Role,
  type User,
} from '@mun/protocol';
import { randomUuid } from '@mun/crypto';

export interface LoginResult {
  response: LoginResponse;
  sessionId: string;
}

export interface ReloginRequiredResult {
  code: 'AUTH_RELOGIN_REQUIRED';
  requestId: string;
  status: 'pending' | 'approved' | 'denied';
  message: string;
}

const DUMMY_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$bmI1dE3NqaW5lZN$YpJqeOqHDF3tvrRGxVGIXVjEgPpZDqQz/z2S6Wf1Yqk';

export async function login(params: {
  username: string;
  password: string;
  platform: 'windows' | 'macos';
  clientVersion: string;
  deviceId?: string;
  ip: string;
}): Promise<LoginResult | ReloginRequiredResult> {
  // Rate limit (per username + per IP).
  if (!loginLimiter.consume(params.username.toLowerCase()) || !loginIpLimiter.consume(params.ip)) {
    throw new ProtocolError('AUTH_RATE_LIMITED', 'Too many login attempts. Slow down.');
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE username = $1', [params.username]);
  const userRow = rows[0] as
    | { id: string; username: string; role: Role; display_name: string; password_hash: string }
    | undefined;

  // Always perform a hash verification to reduce username-enumeration timing.
  if (!userRow) {
    await verifyPassword(params.password, DUMMY_HASH);
    throw new ProtocolError('AUTH_INVALID_CREDENTIALS', 'Invalid username or password');
  }

  const ok = await verifyPassword(params.password, userRow.password_hash);
  if (!ok) {
    throw new ProtocolError('AUTH_INVALID_CREDENTIALS', 'Invalid username or password');
  }
  loginLimiter.reset(params.username.toLowerCase());

  const deviceId = params.deviceId ?? randomUuid();

  // Single-device enforcement.
  if (userRow.role === 'delegate') {
    const active = await findActiveSession(userRow.id);
    if (active) {
      // Blocked: create/return a pending re-login request and notify the chair.
      const req = await upsertReloginRequest({
        userId: userRow.id,
        sessionId: active.id,
        reason: 'New login attempted while a session is active.',
      });
      await audit({
        actor: userRow.id,
        action: 'relogin_request',
        subject: req.id,
        detail: `Delegate ${userRow.username} requested re-login (session ${active.id}).`,
      });
      notifyChairRelogin(req.id, userRow.id, userRow.display_name, 'requested', req.reason);
      return {
        code: 'AUTH_RELOGIN_REQUIRED',
        requestId: req.id,
        status: 'pending',
        message:
          'Another device is already signed in. The chair has been notified and must approve this sign-in.',
      };
    }
  } else {
    // Chair/admin: revoke any prior session, then issue a new one.
    const prior = await findActiveSession(userRow.id);
    if (prior) {
      await revokeSession(prior.id, 'superseded by new login');
      await audit({
        actor: userRow.id,
        action: 'session_revoke',
        subject: prior.id,
        detail: 'Previous session revoked on new login.',
      });
      // Force the old device out if it's connected.
      broker.sendToSink(prior.id, envelope('force_logout', { reason: 'Signed in elsewhere', revoked: true }));
    }
  }

  const issued = await createSession({
    userId: userRow.id,
    role: userRow.role,
    deviceId,
    platform: params.platform,
    clientVersion: params.clientVersion,
  });

  await audit({
    actor: userRow.id,
    action: 'login',
    subject: issued.sessionId,
    detail: `${userRow.role} ${userRow.username} logged in (${params.platform}).`,
  });

  const response = await buildLoginResponse(userRow, issued);
  return { response, sessionId: issued.sessionId };
}

/**
 * Passwordless delegate join: a delegate selects their committee + country and
 * claims that delegation slot. No credentials. Single-device enforcement +
 * chair-approved re-login apply, keyed by the delegation's user.
 */
export async function join(params: {
  committeeId: string;
  country: string;
  deviceId: string;
  platform: 'windows' | 'macos';
  clientVersion: string;
}): Promise<LoginResult | ReloginRequiredResult> {
  // Resolve the delegation slot.
  const { rows } = await pool.query(
    'SELECT d.id AS delegate_id, d.user_id, u.username, u.display_name FROM delegates d JOIN users u ON u.id = d.user_id WHERE d.committee_id = $1 AND d.country = $2',
    [params.committeeId, params.country],
  );
  if (rows.length === 0) {
    throw new ProtocolError('DELEGATE_NOT_FOUND', 'No such delegation (committee + country).');
  }
  const slot = rows[0];
  const userId = slot.user_id as string;

  // Single-device: if the delegation is already claimed (active session), the
  // slot is locked. The chair releases it via Force logout — there is no
  // re-login approval flow. Tell the delegate what to do.
  const active = await findActiveSession(userId);
  if (active) {
    return {
      code: 'AUTH_RELOGIN_REQUIRED',
      requestId: '',
      status: 'pending',
      message: `${params.country} is already signed in on another device. Ask the chair to force-logout that delegate, then retry.`,
    };
  }

  const issued = await createSession({
    userId,
    role: 'delegate',
    deviceId: params.deviceId,
    platform: params.platform,
    clientVersion: params.clientVersion,
  });

  await audit({
    actor: userId,
    action: 'login',
    subject: issued.sessionId,
    detail: `delegate joined as ${params.country} (${params.platform}).`,
  });

  const response = await buildLoginResponse(
    { id: userId, username: slot.username, role: 'delegate', display_name: slot.display_name },
    issued,
  );
  return { response, sessionId: issued.sessionId };
}

export async function refresh(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} | null> {
  return rotateRefreshReturn(refreshToken);
}

async function rotateRefreshReturn(refreshToken: string) {
  const { rotateRefresh } = await import('./sessions.js');
  const r = await rotateRefresh(refreshToken);
  if (!r) return null;
  return { accessToken: r.accessToken, refreshToken: r.refreshToken, expiresIn: r.expiresIn };
}

export async function logout(userId: string, sessionId: string): Promise<void> {
  await revokeSession(sessionId, 'user logout');
  await audit({
    actor: userId,
    action: 'logout',
    subject: sessionId,
    detail: 'User logged out.',
  });
}

// ─── Re-login requests ────────────────────────────────────────────────────────

interface ReloginRequest {
  id: string;
  userId: string;
  delegateId: string;
  committeeId: string;
  sessionId: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
}

async function upsertReloginRequest(p: {
  userId: string;
  sessionId: string;
  reason: string;
}): Promise<ReloginRequest> {
  // If a pending request already exists for this user, reuse it (update reason/time).
  const existing = await pool.query(
    `SELECT id, delegate_id, committee_id, session_id, reason, status
     FROM relogin_requests WHERE delegate_user_id = $1 AND status = 'pending'
     ORDER BY requested_at DESC LIMIT 1`,
    [p.userId],
  );
  if (existing.rows.length > 0) {
    const r = existing.rows[0];
    await pool.query(
      'UPDATE relogin_requests SET reason = $1, requested_at = $2 WHERE id = $3',
      [p.reason, Date.now(), r.id],
    );
    return rowToRelogin(r);
  }
  const delegate = await pool.query(
    'SELECT id, committee_id FROM delegates WHERE user_id = $1',
    [p.userId],
  );
  if (delegate.rows.length === 0) {
    throw new ProtocolError('DELEGATE_NOT_FOUND', 'No delegate record for user');
  }
  const id = randomUuid();
  await pool.query(
    `INSERT INTO relogin_requests
      (id, delegate_user_id, delegate_id, committee_id, session_id, reason, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')`,
    [id, p.userId, delegate.rows[0].id, delegate.rows[0].committee_id, p.sessionId, p.reason],
  );
  return {
    id,
    userId: p.userId,
    delegateId: delegate.rows[0].id,
    committeeId: delegate.rows[0].committee_id,
    sessionId: p.sessionId,
    reason: p.reason,
    status: 'pending',
  };
}

/** Chair approves a re-login: revoke the old session so the delegate can sign in. */
export async function approveRelogin(
  requestId: string,
  chairUserId: string,
): Promise<ReloginRequest> {
  return await pool.connect().then(async (client) => {
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        'SELECT * FROM relogin_requests WHERE id = $1 FOR UPDATE',
        [requestId],
      );
      const r = rows[0];
      if (!r) throw new ProtocolError('NOT_FOUND', 'Re-login request not found');
      if (r.status !== 'pending')
        throw new ProtocolError('CONFLICT', `Request already ${r.status}`);
      // Revoke the old session.
      await client.query(
        'UPDATE sessions SET revoked = true, revoke_reason = $1 WHERE id = $2',
        ['chair-approved re-login', r.session_id],
      );
      await client.query(
        `UPDATE relogin_requests SET status = 'approved', decided_by = $1, decided_at = $2 WHERE id = $3`,
        [chairUserId, Date.now(), requestId],
      );
      await client.query('COMMIT');
      const result = rowToRelogin(r);
      result.status = 'approved';
      // Force the old device out.
      broker.sendToSink(r.session_id, envelope('force_logout', { reason: 'Re-login approved by chair', revoked: true }));
      await audit({
        actor: chairUserId,
        action: 'relogin_approve',
        subject: requestId,
        detail: `Chair approved re-login for delegate ${r.delegate_id}.`,
      });
      notifyChairRelogin(requestId, r.delegate_user_id, '', 'approved', 'Re-login approved');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}

export async function denyRelogin(
  requestId: string,
  chairUserId: string,
  reason: string,
): Promise<ReloginRequest> {
  const { rows } = await pool.query('SELECT * FROM relogin_requests WHERE id = $1', [requestId]);
  const r = rows[0];
  if (!r) throw new ProtocolError('NOT_FOUND', 'Re-login request not found');
  if (r.status !== 'pending') throw new ProtocolError('CONFLICT', `Request already ${r.status}`);
  await pool.query(
    `UPDATE relogin_requests SET status = 'denied', decided_by = $1, decided_at = $2, decision_reason = $3 WHERE id = $4`,
    [chairUserId, Date.now(), reason, requestId],
  );
  await audit({
    actor: chairUserId,
    action: 'relogin_deny',
    subject: requestId,
    detail: `Chair denied re-login: ${reason}`,
  });
  notifyChairRelogin(requestId, r.delegate_user_id, '', 'denied', reason);
  return rowToRelogin(r);
}

export async function cancelRelogin(requestId: string, userId: string): Promise<void> {
  const { rows } = await pool.query(
    'SELECT * FROM relogin_requests WHERE id = $1 AND delegate_user_id = $2',
    [requestId, userId],
  );
  const r = rows[0];
  if (!r) throw new ProtocolError('NOT_FOUND', 'Re-login request not found');
  if (r.status !== 'pending') throw new ProtocolError('CONFLICT', `Request already ${r.status}`);
  await pool.query(
    `UPDATE relogin_requests SET status = 'cancelled' WHERE id = $1`,
    [requestId],
  );
  notifyChairRelogin(requestId, userId, '', 'cancelled', 'Cancelled by delegate');
}

export async function listPendingRelogins(committeeId: string): Promise<ReloginRequest[]> {
  const { rows } = await pool.query(
    `SELECT r.*, u.display_name AS delegate_display_name, d.country
     FROM relogin_requests r
     JOIN users u ON u.id = r.delegate_user_id
     JOIN delegates d ON d.id = r.delegate_id
     WHERE r.committee_id = $1 AND r.status = 'pending'
     ORDER BY r.requested_at DESC`,
    [committeeId],
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.delegate_user_id,
    delegateId: r.delegate_id,
    committeeId: r.committee_id,
    sessionId: r.session_id,
    reason: r.reason,
    status: r.status,
  }));
}

function notifyChairRelogin(
  requestId: string,
  delegateUserId: string,
  _delegateDisplayName: string,
  status: 'requested' | 'approved' | 'denied' | 'cancelled',
  reason: string,
  decidedBy: string | null = null,
): void {
  // Resolve committee + display name lazily for the broadcast.
  void (async () => {
    const { rows } = await pool.query(
      `SELECT d.id, d.committee_id, u.display_name, d.country
       FROM delegates d JOIN users u ON u.id = d.user_id
       WHERE d.user_id = $1`,
      [delegateUserId],
    );
    if (rows.length === 0) return;
    const row = rows[0];
    broker.broadcastCommittee(
      row.committee_id,
      envelope('relogin_update', {
        requestId,
        delegateId: row.id,
        committeeId: row.committee_id,
        delegateDisplayName: row.display_name,
        country: row.country,
        status,
        reason,
        decidedBy,
        timestamp: Date.now(),
      }),
    );
  })();
}

// ─── Login response builder ───────────────────────────────────────────────────

async function buildLoginResponse(
  userRow: { id: string; username: string; role: Role; display_name: string },
  issued: IssuedSession,
): Promise<LoginResponse> {
  const user: User = {
    id: userRow.id,
    username: userRow.username,
    role: userRow.role,
    displayName: userRow.display_name,
    createdAt: 0, // not needed on the wire; populated below if required
  };
  // Fetch createdAt (pg returns bigint as string → coerce to number).
  const { rows: urows } = await pool.query('SELECT created_at FROM users WHERE id = $1', [userRow.id]);
  user.createdAt = Number(urows[0]?.created_at ?? 0);

  let delegate: Delegate | null = null;
  const committees: Committee[] = [];
  if (userRow.role === 'delegate') {
    const { rows: drows } = await pool.query(
      `SELECT id, user_id, committee_id, country, attendance, connection_status,
              last_heartbeat_at, enabled, created_at
       FROM delegates WHERE user_id = $1`,
      [userRow.id],
    );
    if (drows.length > 0) {
      const d = drows[0];
      delegate = {
        id: d.id,
        userId: d.user_id,
        committeeId: d.committee_id,
        country: d.country,
        attendance: d.attendance,
        connectionStatus: d.connection_status,
        lastHeartbeatAt: d.last_heartbeat_at ? Number(d.last_heartbeat_at) : null,
        enabled: d.enabled,
        reloginRequested: false,
        createdAt: Number(d.created_at),
      };
      const { rows: crows } = await pool.query(
        'SELECT * FROM committees WHERE id = $1',
        [d.committee_id],
      );
      if (crows.length > 0) committees.push(rowToCommittee(crows[0]));
    }
  } else if (userRow.role === 'chair' || userRow.role === 'vice') {
    const { rows: crows } = await pool.query(
      'SELECT * FROM committees WHERE chair_user_id = $1 OR vice_user_id = $1',
      [userRow.id],
    );
    for (const c of crows) committees.push(rowToCommittee(c));
  } else {
    // admin sees all
    const { rows: crows } = await pool.query('SELECT * FROM committees');
    for (const c of crows) committees.push(rowToCommittee(c));
  }

  const rules = await loadRules();

  const monitoringActive =
    userRow.role === 'delegate' && delegate
      ? committees[0]?.status === 'active'
      : false;

  return {
    user,
    delegate,
    committees,
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    expiresIn: issued.expiresIn,
    monitoringActive,
    rules,
  };
}

async function loadRules(): Promise<AiDetectionRule[]> {
  const { rows } = await pool.query(
    'SELECT * FROM ai_detection_rules ORDER BY created_at ASC',
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    matchField: r.match_field,
    patternType: r.pattern_type,
    pattern: r.pattern,
    enabled: r.enabled,
    severity: r.severity,
    category: r.category,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }));
}

function rowToCommittee(r: Record<string, unknown>): Committee {
  return {
    id: r.id as string,
    name: r.name as string,
    topic: r.topic as string,
    description: (r.description as string) ?? '',
    status: r.status as Committee['status'],
    chairUserId: (r.chair_user_id as string | null) ?? null,
    viceUserId: (r.vice_user_id as string | null) ?? null,
    createdAt: Number(r.created_at as number),
    rev: Number(r.rev as number),
  };
}

function rowToRelogin(r: Record<string, unknown>): ReloginRequest {
  return {
    id: r.id as string,
    userId: r.delegate_user_id as string,
    delegateId: r.delegate_id as string,
    committeeId: r.committee_id as string,
    sessionId: r.session_id as string,
    reason: (r.reason as string) ?? '',
    status: r.status as ReloginRequest['status'],
  };
}
