/**
 * @mun/server — committee & delegate management service
 *
 * Covers committee CRUD (admin), delegate assignment (admin), roll call and
 * enable/disable (chair), force-logout (chair/admin), and committee state
 * transitions (pause/resume; emergency stop/resume is in admin/service.ts).
 *
 * Every status change bumps `rev` and broadcasts a fresh `committee_state` plus
 * a `monitoring_paused`/`monitoring_resumed` signal so delegates' monitoring
 * engines start/stop accordingly (breaks, pauses, and emergency stops all
 * pause monitoring — Priority 1 integrity enforcement respects breaks).
 */

import { pool } from '../db/pool.js';
import { audit } from '../audit/service.js';
import { broker } from '../realtime/broker.js';
import { presence } from '../realtime/presence.js';
import { revokeAllForUser } from '../auth/sessions.js';
import { envelope, ProtocolError, type Committee, type Delegate, type Attendance, type Vote } from '@mun/protocol';
import { randomUuid } from '@mun/crypto';
import { listCommitteeVotes } from '../voting/service.js';

export async function createCommittee(params: {
  name: string;
  topic: string;
  description?: string;
  chairUserId?: string | null;
}): Promise<Committee> {
  const id = randomUuid();
  const { rows } = await pool.query(
    `INSERT INTO committees (id, name, topic, description, status, chair_user_id)
     VALUES ($1, $2, $3, $4, 'active', $5) RETURNING *`,
    [id, params.name, params.topic, params.description ?? '', params.chairUserId ?? null],
  );
  const c = rowToCommittee(rows[0]);
  await audit({
    actor: 'system',
    action: 'committee_create',
    subject: id,
    detail: `Created committee "${params.name}".`,
  });
  return c;
}

export async function updateCommittee(
  id: string,
  patch: { name?: string; topic?: string; description?: string; chairUserId?: string | null },
): Promise<Committee> {
  const sets: string[] = [];
  const params: unknown[] = [id];
  if (patch.name !== undefined) {
    params.push(patch.name);
    sets.push(`name = $${params.length}`);
  }
  if (patch.topic !== undefined) {
    params.push(patch.topic);
    sets.push(`topic = $${params.length}`);
  }
  if (patch.description !== undefined) {
    params.push(patch.description);
    sets.push(`description = $${params.length}`);
  }
  if (patch.chairUserId !== undefined) {
    params.push(patch.chairUserId);
    sets.push(`chair_user_id = $${params.length}`);
  }
  if (sets.length === 0) throw new ProtocolError('VALIDATION_ERROR', 'No fields to update');
  sets.push(`rev = rev + 1`);
  const { rows } = await pool.query(
    `UPDATE committees SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params,
  );
  if (rows.length === 0) throw new ProtocolError('COMMITTEE_NOT_FOUND', 'Committee not found');
  const c = rowToCommittee(rows[0]);
  await broadcastCommitteeState(c.id);
  return c;
}

export async function listCommittees(): Promise<Committee[]> {
  const { rows } = await pool.query('SELECT * FROM committees ORDER BY created_at ASC');
  return rows.map(rowToCommittee);
}

export async function getCommittee(id: string): Promise<Committee> {
  const { rows } = await pool.query('SELECT * FROM committees WHERE id = $1', [id]);
  if (rows.length === 0) throw new ProtocolError('COMMITTEE_NOT_FOUND', 'Committee not found');
  return rowToCommittee(rows[0]);
}

export async function listCommitteeDelegates(committeeId: string): Promise<Delegate[]> {
  const { rows } = await pool.query(
    'SELECT * FROM delegates WHERE committee_id = $1 ORDER BY country ASC',
    [committeeId],
  );
  return rows.map(rowToDelegate);
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

/**
 * Add a country delegation slot to a committee. Creates a passwordless delegate
 * user (delegates join by selecting committee + country, not by credentials).
 * The slot is "free" until a device claims it via /auth/join.
 */
export async function addDelegation(committeeId: string, country: string): Promise<Delegate> {
  const { rows: crows } = await pool.query('SELECT id FROM committees WHERE id = $1', [committeeId]);
  if (crows.length === 0) throw new ProtocolError('COMMITTEE_NOT_FOUND', 'Committee not found');
  const { rows: existing } = await pool.query(
    'SELECT id FROM delegates WHERE committee_id = $1 AND country = $2',
    [committeeId, country],
  );
  if (existing.length > 0)
    throw new ProtocolError('CONFLICT', 'Country already added to this committee');
  const userId = randomUuid();
  // Passwordless delegate user — username is an opaque id; display name is the
  // country. password_hash '' is never verified (delegates use /auth/join).
  await pool.query(
    `INSERT INTO users (id, username, role, display_name, password_hash)
     VALUES ($1, $2, 'delegate', $3, '')`,
    [userId, `del-${userId}`, country],
  );
  const id = randomUuid();
  const { rows } = await pool.query(
    `INSERT INTO delegates (id, user_id, committee_id, country) VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, userId, committeeId, country],
  );
  const d = rowToDelegate(rows[0]);
  await broadcastCommitteeState(committeeId);
  return d;
}

/** Remove a delegation slot (admin) — frees the country for re-assignment. */
export async function removeDelegation(delegateId: string): Promise<void> {
  const { rows } = await pool.query('SELECT committee_id FROM delegates WHERE id = $1', [delegateId]);
  if (rows.length === 0) throw new ProtocolError('DELEGATE_NOT_FOUND', 'Delegation not found');
  const committeeId = rows[0].committee_id as string;
  // Revoke any active session for this delegation's user.
  const { rows: drows } = await pool.query('SELECT user_id FROM delegates WHERE id = $1', [delegateId]);
  if (drows.length > 0) {
    await pool.query('UPDATE sessions SET revoked = true, revoke_reason = $1 WHERE user_id = $2 AND revoked = false', ['delegation removed', drows[0].user_id]);
  }
  await pool.query('DELETE FROM delegates WHERE id = $1', [delegateId]);
  await broadcastCommitteeState(committeeId);
}

/** Public list of committees + their country slots + whether each is taken. */
export async function listJoinOptions(): Promise<JoinOptionCommittee[]> {
  const { rows } = await pool.query(
    `SELECT c.id AS committee_id, c.name AS committee_name,
            d.id AS delegate_id, d.country,
            EXISTS (SELECT 1 FROM sessions s
                    WHERE s.user_id = d.user_id AND s.revoked = false AND s.expires_at > $1) AS taken
     FROM committees c
     JOIN delegates d ON d.committee_id = c.id
     ORDER BY c.name, d.country`,
    [Date.now()],
  );
  const map = new Map<string, JoinOptionCommittee>();
  for (const r of rows) {
    let c = map.get(r.committee_id);
    if (!c) {
      c = { committeeId: r.committee_id, committeeName: r.committee_name, countries: [] };
      map.set(r.committee_id, c);
    }
    c.countries.push({ country: r.country, delegateId: r.delegate_id, taken: r.taken });
  }
  return [...map.values()];
}


export async function addDelegate(params: {
  userId: string;
  committeeId: string;
  country: string;
}): Promise<Delegate> {
  // Ensure the user exists and is a delegate.
  const { rows: urows } = await pool.query('SELECT role FROM users WHERE id = $1', [params.userId]);
  if (urows.length === 0) throw new ProtocolError('NOT_FOUND', 'User not found');
  if (urows[0].role !== 'delegate')
    throw new ProtocolError('CONFLICT', 'User is not a delegate');
  // One delegation per user.
  const { rows: existing } = await pool.query('SELECT id FROM delegates WHERE user_id = $1', [
    params.userId,
  ]);
  if (existing.length > 0)
    throw new ProtocolError('CONFLICT', 'User is already a delegate in a committee');
  const id = randomUuid();
  const { rows } = await pool.query(
    `INSERT INTO delegates (id, user_id, committee_id, country) VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, params.userId, params.committeeId, params.country],
  );
  const d = rowToDelegate(rows[0]);
  await broadcastCommitteeState(params.committeeId);
  return d;
}

export async function setAttendance(delegateId: string, attendance: Attendance): Promise<Delegate> {
  const { rows } = await pool.query(
    'UPDATE delegates SET attendance = $1 WHERE id = $2 RETURNING *',
    [attendance, delegateId],
  );
  if (rows.length === 0) throw new ProtocolError('DELEGATE_NOT_FOUND', 'Delegate not found');
  const d = rowToDelegate(rows[0]);
  presence.update(delegateId, { attendance });
  await broadcastCommitteeState(d.committeeId);
  return d;
}

export async function setEnabled(
  delegateId: string,
  enabled: boolean,
  byUserId: string,
  disabledReason?: string | null,
): Promise<Delegate> {
  const { rows } = await pool.query(
    'UPDATE delegates SET enabled = $1, disabled_reason = $2 WHERE id = $3 RETURNING *',
    [enabled, enabled ? null : (disabledReason ?? null), delegateId],
  );
  if (rows.length === 0) throw new ProtocolError('DELEGATE_NOT_FOUND', 'Delegate not found');
  const d = rowToDelegate(rows[0]);
  presence.update(delegateId, { enabled });
  await audit({
    actor: byUserId,
    action: enabled ? 'delegate_enable' : 'delegate_disable',
    subject: delegateId,
    detail: `Delegate ${d.country} ${enabled ? 'enabled' : 'disabled'}${disabledReason ? ` (${disabledReason})` : ''}.`,
  });
  await broadcastCommitteeState(d.committeeId);
  return d;
}

export async function forceLogoutDelegate(delegateId: string, byUserId: string): Promise<void> {
  const { rows } = await pool.query('SELECT user_id, committee_id FROM delegates WHERE id = $1', [
    delegateId,
  ]);
  if (rows.length === 0) throw new ProtocolError('DELEGATE_NOT_FOUND', 'Delegate not found');
  const userId = rows[0].user_id as string;
  const committeeId = rows[0].committee_id as string;
  // Revoke all sessions for the delegate's user + force the connected client out.
  await revokeAllForUser(userId, 'force logout by chair/admin');
  await audit({
    actor: byUserId,
    action: 'delegate_force_logout',
    subject: delegateId,
    detail: 'Delegate forced out.',
  });
  // Broadcast force_logout to the delegate (if connected) via their sink.
  // Find the delegate's sink through the broker by delegateId.
  broker.sendToDelegate(delegateId, envelope('force_logout', { reason: 'Forced logout by chair/admin', revoked: true }));
  await presence.markDisconnected(delegateId, 'force logout');
  await broadcastCommitteeState(committeeId);
}

async function setStatus(committeeId: string, status: Committee['status'], byUserId: string, action: 'committee_pause' | 'committee_resume'): Promise<Committee> {
  const { rows } = await pool.query(
    `UPDATE committees SET status = $1, rev = rev + 1 WHERE id = $2 RETURNING *`,
    [status, committeeId],
  );
  if (rows.length === 0) throw new ProtocolError('COMMITTEE_NOT_FOUND', 'Committee not found');
  const c = rowToCommittee(rows[0]);
  await audit({ actor: byUserId, action, subject: committeeId, detail: `Committee ${status}.` });
  await broadcastCommitteeState(committeeId);
  // Signal monitoring pause/resume to delegates.
  if (status === 'active') {
    broker.broadcastCommitteeAll(committeeId, envelope('monitoring_resumed', { committeeId, status: c.status }));
  } else {
    broker.broadcastCommitteeAll(committeeId, envelope('monitoring_paused', { reason: status, committeeId, resumeAt: null }));
  }
  return c;
}

export async function pauseCommittee(committeeId: string, byUserId: string): Promise<Committee> {
  return setStatus(committeeId, 'paused', byUserId, 'committee_pause');
}

export async function resumeCommittee(committeeId: string, byUserId: string): Promise<Committee> {
  const c = await getCommittee(committeeId);
  if (c.status === 'emergency_stopped')
    throw new ProtocolError('CONFLICT', 'Committee is emergency-stopped; use admin resume.');
  return setStatus(committeeId, 'active', byUserId, 'committee_resume');
}

/** Internal: set status without the chair-only action semantics (used by admin/breaks). */
export async function _setStatus(committeeId: string, status: Committee['status'], byUserId: string, action: 'committee_pause' | 'committee_resume' | 'emergency_stop' | 'emergency_resume' | 'break_start' | 'break_end'): Promise<Committee> {
  const { rows } = await pool.query(
    `UPDATE committees SET status = $1, rev = rev + 1 WHERE id = $2 RETURNING *`,
    [status, committeeId],
  );
  if (rows.length === 0) throw new ProtocolError('COMMITTEE_NOT_FOUND', 'Committee not found');
  const c = rowToCommittee(rows[0]);
  await audit({ actor: byUserId, action, subject: committeeId, detail: `Committee ${status}.` });
  await broadcastCommitteeState(committeeId);
  if (status === 'active') {
    broker.broadcastCommitteeAll(committeeId, envelope('monitoring_resumed', { committeeId, status: c.status }));
  } else {
    broker.broadcastCommitteeAll(committeeId, envelope('monitoring_paused', { reason: status, committeeId, resumeAt: null }));
  }
  return c;
}

/** Build and broadcast the full committee state to all subscribers. */
export async function broadcastCommitteeState(committeeId: string): Promise<void> {
  const c = await getCommittee(committeeId).catch(() => null);
  if (!c) return;
  const delegates = await listCommitteeDelegates(committeeId);
  const votes = await listCommitteeVotes(committeeId, { limit: 20 });
  const { rows: brows } = await pool.query(
    "SELECT * FROM scheduled_breaks WHERE committee_id = $1 AND status = 'active' LIMIT 1",
    [committeeId],
  );
  const activeBreak = brows.length ? rowToBreak(brows[0]) : null;
  broker.broadcastCommitteeAll(committeeId, envelope('committee_state', { committee: c, delegates, votes, activeBreak, rev: c.rev }));
}

export async function getCommitteeState(committeeId: string): Promise<{
  committee: Committee;
  delegates: Delegate[];
  votes: Vote[];
  activeBreak: import('@mun/protocol').ScheduledBreak | null;
}> {
  const committee = await getCommittee(committeeId);
  const delegates = await listCommitteeDelegates(committeeId);
  const votes = await listCommitteeVotes(committeeId, { limit: 50 });
  const { rows: brows } = await pool.query(
    "SELECT * FROM scheduled_breaks WHERE committee_id = $1 AND status = 'active' LIMIT 1",
    [committeeId],
  );
  const activeBreak = brows.length ? rowToBreak(brows[0]) : null;
  return { committee, delegates, votes, activeBreak };
}

// ─── Row mappers ──────────────────────────────────────────────────────────────

function rowToCommittee(r: Record<string, unknown>): Committee {
  return {
    id: r.id as string,
    name: r.name as string,
    topic: r.topic as string,
    description: (r.description as string) ?? '',
    status: r.status as Committee['status'],
    chairUserId: (r.chair_user_id as string | null) ?? null,
    createdAt: Number(r.created_at as number),
    rev: Number(r.rev as number),
  };
}

function rowToDelegate(r: Record<string, unknown>): Delegate {
  return {
    id: r.id as string,
    userId: r.user_id as string,
    committeeId: r.committee_id as string,
    country: r.country as string,
    attendance: r.attendance as Attendance,
    connectionStatus: r.connection_status as Delegate['connectionStatus'],
    lastHeartbeatAt: r.last_heartbeat_at ? Number(r.last_heartbeat_at) : null,
    enabled: r.enabled as boolean,
    disabledReason: (r.disabled_reason as string | null) ?? null,
    reloginRequested: false,
    createdAt: Number(r.created_at as number),
  };
}

function rowToBreak(r: Record<string, unknown>): import('@mun/protocol').ScheduledBreak {
  return {
    id: r.id as string,
    committeeId: r.committee_id as string,
    label: r.label as string,
    startAt: Number(r.start_at as number),
    endAt: Number(r.end_at as number),
    status: r.status as import('@mun/protocol').BreakStatus,
  };
}
