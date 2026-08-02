/**
 * @mun/server — admin service
 *
 * System-wide operations: user management, emergency stop/resume (overrides
 * chair pause), system health dashboard, and audit export. Admin actions are
 * always audited.
 */

import { pool } from '../db/pool.js';
import { audit } from '../audit/service.js';
import { listAudit, verifyAuditChain } from '../audit/service.js';
import { broker } from '../realtime/broker.js';
import { presence } from '../realtime/presence.js';
import { _setStatus } from '../committee/service.js';
import { revokeAllForUser } from '../auth/sessions.js';
import { hashPassword } from '../auth/passwords.js';
import { pingDb } from '../db/pool.js';
import { envelope, ProtocolError, type Role, type SystemHealth, type User, type AuditEntry } from '@mun/protocol';
import { randomUuid } from '@mun/crypto';

const STARTED_AT = Date.now();

export async function emergencyStop(committeeId: string, adminUserId: string): Promise<void> {
  await _setStatus(committeeId, 'emergency_stopped', adminUserId, 'emergency_stop');
}

export async function emergencyResume(committeeId: string, adminUserId: string): Promise<void> {
  await _setStatus(committeeId, 'active', adminUserId, 'emergency_resume');
}

export async function createUser(params: {
  username: string;
  password: string;
  role: Role;
  displayName: string;
}): Promise<User> {
  const { rows: existing } = await pool.query('SELECT id FROM users WHERE username = $1', [
    params.username,
  ]);
  if (existing.length > 0) throw new ProtocolError('CONFLICT', 'Username already exists');
  const id = randomUuid();
  const hash = await hashPassword(params.password);
  const now = Date.now();
  await pool.query(
    `INSERT INTO users (id, username, role, display_name, password_hash, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, params.username, params.role, params.displayName, hash, now],
  );
  return { id, username: params.username, role: params.role, displayName: params.displayName, createdAt: now };
}

export async function listUsers(): Promise<Array<User & { hasDelegate: boolean; committeeId: string | null }>> {
  const { rows } = await pool.query(
    `SELECT u.id, u.username, u.role, u.display_name, u.created_at,
            d.id AS delegate_id, d.committee_id
     FROM users u
     LEFT JOIN delegates d ON d.user_id = u.id
     ORDER BY u.created_at ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    displayName: r.display_name,
    createdAt: Number(r.created_at),
    hasDelegate: !!r.delegate_id,
    committeeId: r.committee_id ?? null,
  }));
}

export async function adminForceLogout(userId: string, adminUserId: string): Promise<void> {
  await revokeAllForUser(userId, 'admin force logout');
  await audit({
    actor: adminUserId,
    action: 'delegate_force_logout',
    subject: userId,
    detail: 'Admin forced logout for user.',
  });
  // Best-effort: notify via any sink owned by the user.
  for (const rec of presence.listByCommittee('*')) {
    void rec;
  }
  // The broker routes by delegateId; for a chair/admin we can't easily target
  // them here without a reverse index. Their session is revoked, so their next
  // action fails auth and they're effectively logged out.
}

export async function resetDelegateVotingKey(delegateId: string, adminUserId: string): Promise<void> {
  const { rows } = await pool.query(
    'UPDATE delegates SET public_key = NULL WHERE id = $1 RETURNING user_id',
    [delegateId],
  );
  if (rows.length === 0) throw new ProtocolError('DELEGATE_NOT_FOUND', 'Delegate not found');
  await audit({
    actor: adminUserId,
    action: 'rule_update',
    subject: delegateId,
    detail: 'Admin reset delegate voting key.',
  });
}

export async function systemHealth(): Promise<SystemHealth> {
  const counts = broker.count();
  const dbLatency = await pingDb().catch(() => -1);
  const now = Date.now();
  const { rows: crows } = await pool.query('SELECT COUNT(*)::int AS n FROM committees');
  const { rows: vrows } = await pool.query("SELECT COUNT(*)::int AS n FROM votes WHERE status = 'open'");
  const { rows: wrows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM warnings WHERE timestamp >= $1',
    [now - 3600_000],
  );
  const { rows: erows } = await pool.query(
    'SELECT COUNT(*)::int AS n FROM monitoring_events WHERE server_ts >= $1',
    [now - 3600_000],
  );
  return {
    uptimeMs: now - STARTED_AT,
    connectedDelegates: counts.delegates,
    connectedChairs: counts.chairs,
    committees: crows[0].n,
    activeVotes: vrows[0].n,
    warningsLastHour: wrows[0].n,
    monitorEventsLastHour: erows[0].n,
    dbLatencyMs: dbLatency,
    wsConnections: counts.total,
    healthy: dbLatency >= 0,
    timestamp: now,
  };
}

export async function exportAuditLog(opts: {
  limit?: number;
  action?: string;
  fromTs?: number;
  toTs?: number;
}): Promise<{ entries: AuditEntry[]; verification: { valid: boolean; brokenAtSeq: number | null; count: number } }> {
  const entries = await listAudit({
    limit: opts.limit ?? 5000,
    action: opts.action as AuditEntry['action'] | undefined,
    fromTs: opts.fromTs,
    toTs: opts.toTs,
  });
  const verification = await verifyAuditChain();
  return { entries, verification };
}

/** Admin views: all active sessions. */
export async function listActiveSessions(): Promise<Array<{
  id: string;
  userId: string;
  role: Role;
  platform: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}>> {
  const { rows } = await pool.query(
    `SELECT s.id, s.user_id, s.role, s.platform, s.created_at, s.last_seen_at, s.expires_at, u.username
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.revoked = false AND s.expires_at > $1
     ORDER BY s.last_seen_at DESC`,
    [Date.now()],
  );
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    role: r.role,
    platform: r.platform,
    createdAt: Number(r.created_at),
    lastSeenAt: Number(r.last_seen_at),
    expiresAt: Number(r.expires_at),
  }));
}

// Broadcast helper for admin to push system_health periodically.
export function broadcastHealth(): Promise<void> {
  return systemHealth().then((h) => broker.broadcastAdmins(envelope('system_health', h)));
}
