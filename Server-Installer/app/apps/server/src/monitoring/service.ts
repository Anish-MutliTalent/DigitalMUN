/**
 * @mun/server — monitoring query & export service
 *
 * Read-side of monitoring: chair/admin queries for the live feed history,
 * warnings, and committee log exports. Warning acknowledgement is also here.
 */

import { pool } from '../db/pool.js';
import { audit } from '../audit/service.js';
import { ProtocolError, type Warning, type MonitoringEventBroadcast } from '@mun/protocol';

export async function listEvents(committeeId: string, opts: {
  limit?: number;
  offset?: number;
  delegateId?: string;
  fromTs?: number;
  toTs?: number;
}): Promise<MonitoringEventBroadcast[]> {
  const limit = Math.min(opts.limit ?? 200, 5000);
  const offset = opts.offset ?? 0;
  const where: string[] = ['m.committee_id = $1'];
  const params: unknown[] = [committeeId];
  if (opts.delegateId) {
    params.push(opts.delegateId);
    where.push(`m.delegate_id = $${params.length}`);
  }
  if (opts.fromTs) {
    params.push(opts.fromTs);
    where.push(`m.server_ts >= $${params.length}`);
  }
  if (opts.toTs) {
    params.push(opts.toTs);
    where.push(`m.server_ts <= $${params.length}`);
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT m.*, u.display_name, d.country
     FROM monitoring_events m
     JOIN delegates d ON d.id = m.delegate_id
     JOIN users u ON u.id = d.user_id
     WHERE ${where.join(' AND ')}
     ORDER BY m.server_ts DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(rowToBroadcast);
}

export async function listWarnings(committeeId: string, opts: {
  limit?: number;
  offset?: number;
  unacknowledgedOnly?: boolean;
}): Promise<Warning[]> {
  const limit = Math.min(opts.limit ?? 200, 5000);
  const offset = opts.offset ?? 0;
  const where: string[] = ['committee_id = $1'];
  const params: unknown[] = [committeeId];
  if (opts.unacknowledgedOnly) {
    where.push('acknowledged = false');
  }
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT * FROM warnings WHERE ${where.join(' AND ')}
     ORDER BY timestamp DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(rowToWarning);
}

export async function acknowledgeWarning(
  warningId: string,
  chairUserId: string,
): Promise<Warning> {
  const { rows } = await pool.query(
    `UPDATE warnings
       SET acknowledged = true, acknowledged_by = $1, acknowledged_at = $2
     WHERE id = $3 AND acknowledged = false
     RETURNING *`,
    [chairUserId, Date.now(), warningId],
  );
  if (rows.length === 0) {
    // Either not found or already acknowledged.
    const check = await pool.query('SELECT * FROM warnings WHERE id = $1', [warningId]);
    if (check.rows.length === 0) throw new ProtocolError('NOT_FOUND', 'Warning not found');
    return rowToWarning(check.rows[0]);
  }
  const w = rowToWarning(rows[0]);
  await audit({
    actor: chairUserId,
    action: 'warning_ack',
    subject: warningId,
    detail: `Acknowledged ${w.type} warning for delegate ${w.delegateId}.`,
  });
  return w;
}

/** Export a committee's monitoring log + warnings as JSON for audit. */
export async function exportCommitteeLog(committeeId: string): Promise<{
  committeeId: string;
  exportedAt: number;
  events: MonitoringEventBroadcast[];
  warnings: Warning[];
}> {
  const events = await listEvents(committeeId, { limit: 5000 });
  const warnings = await listWarnings(committeeId, { limit: 5000 });
  return {
    committeeId,
    exportedAt: Date.now(),
    events,
    warnings,
  };
}

function rowToBroadcast(r: Record<string, unknown>): MonitoringEventBroadcast {
  return {
    id: r.id as string,
    delegateId: r.delegate_id as string,
    committeeId: r.committee_id as string,
    delegateDisplayName: r.display_name as string,
    country: r.country as string,
    type: r.type as MonitoringEventBroadcast['type'],
    serverTs: Number(r.server_ts as number),
    clientTs: Number(r.client_ts as number),
    appName: (r.app_name as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    titleScope: r.title_scope as MonitoringEventBroadcast['titleScope'],
    matchedRuleId: (r.matched_rule_id as string | null) ?? null,
    matchedRuleName: (r.matched_rule_name as string | null) ?? null,
    severity: r.severity as MonitoringEventBroadcast['severity'],
    durationMs: r.duration_ms ? Number(r.duration_ms) : null,
    fromAppName: (r.from_app_name as string | null) ?? null,
  };
}

function rowToWarning(r: Record<string, unknown>): Warning {
  return {
    id: r.id as string,
    committeeId: r.committee_id as string,
    delegateId: r.delegate_id as string,
    type: r.type as Warning['type'],
    severity: r.severity as Warning['severity'],
    message: r.message as string,
    ruleId: (r.rule_id as string | null) ?? null,
    appName: (r.app_name as string | null) ?? null,
    timestamp: Number(r.timestamp as number),
    acknowledged: r.acknowledged as boolean,
    acknowledgedBy: (r.acknowledged_by as string | null) ?? null,
    acknowledgedAt: r.acknowledged_at ? Number(r.acknowledged_at) : null,
  };
}
