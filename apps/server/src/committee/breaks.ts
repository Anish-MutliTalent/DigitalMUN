/**
 * @mun/server — break scheduling & enforcement
 *
 * A chair schedules one or more breaks (label + start + end). A periodic
 * scheduler transitions breaks:
 *  - scheduled → active when now >= startAt: committee status set to 'break',
 *    monitoring paused (delegates' UI shows STANDBY).
 *  - active → ended when now >= endAt: committee status set back to 'active',
 *    monitoring resumed.
 *
 * The scheduler is started in index.ts and stopped on shutdown.
 */

import { pool } from '../db/pool.js';
import { audit } from '../audit/service.js';
import { broker } from '../realtime/broker.js';
import { _setStatus, broadcastCommitteeState } from './service.js';
import { envelope, type ScheduledBreak, type BreakStatus } from '@mun/protocol';
import { randomUuid } from '@mun/crypto';

let timer: NodeJS.Timeout | null = null;

export async function scheduleBreak(params: {
  committeeId: string;
  label: string;
  startAt: number;
  endAt: number;
}): Promise<ScheduledBreak> {
  if (params.endAt <= params.startAt)
    throw new Error('Break end must be after start');
  const id = randomUuid();
  const { rows } = await pool.query(
    `INSERT INTO scheduled_breaks (id, committee_id, label, start_at, end_at, status)
     VALUES ($1, $2, $3, $4, $5, 'scheduled') RETURNING *`,
    [id, params.committeeId, params.label, params.startAt, params.endAt],
  );
  return rowToBreak(rows[0]);
}

export async function listBreaks(committeeId: string): Promise<ScheduledBreak[]> {
  const { rows } = await pool.query(
    'SELECT * FROM scheduled_breaks WHERE committee_id = $1 ORDER BY start_at ASC',
    [committeeId],
  );
  return rows.map(rowToBreak);
}

export async function cancelBreak(breakId: string): Promise<void> {
  await pool.query("UPDATE scheduled_breaks SET status = 'cancelled' WHERE id = $1 AND status IN ('scheduled','active')", [breakId]);
}

/** Periodic sweep: start/stop breaks whose time has come. */
async function sweep(): Promise<void> {
  const now = Date.now();
  // Start scheduled breaks.
  const { rows: toStart } = await pool.query(
    `UPDATE scheduled_breaks SET status = 'active'
     WHERE status = 'scheduled' AND start_at <= $1
     RETURNING id, committee_id, label, start_at, end_at`,
    [now],
  );
  for (const b of toStart) {
    const committeeId = b.committee_id as string;
    await _setStatus(committeeId, 'break', 'system', 'break_start');
    broker.broadcastCommitteeAll(
      committeeId,
      envelope('break_state', { break: rowToBreak(b), committeeId }),
    );
    await audit({ actor: 'system', action: 'break_start', subject: b.id, detail: `Break "${b.label}" started.` });
  }

  // End active breaks.
  const { rows: toEnd } = await pool.query(
    `UPDATE scheduled_breaks SET status = 'ended'
     WHERE status = 'active' AND end_at <= $1
     RETURNING id, committee_id, label, start_at, end_at`,
    [now],
  );
  for (const b of toEnd) {
    const committeeId = b.committee_id as string;
    // Only resume if the committee is still in 'break' (not emergency-stopped meanwhile).
    const { rows: crows } = await pool.query('SELECT status FROM committees WHERE id = $1', [committeeId]);
    if (crows.length > 0 && crows[0].status === 'break') {
      await _setStatus(committeeId, 'active', 'system', 'break_end');
    }
    broker.broadcastCommitteeAll(
      committeeId,
      envelope('break_state', { break: { ...rowToBreak(b), status: 'ended' as BreakStatus }, committeeId }),
    );
    await audit({ actor: 'system', action: 'break_end', subject: b.id, detail: `Break "${b.label}" ended.` });
  }
}

export function startBreakScheduler(intervalMs = 5000): void {
  if (timer) return;
  timer = setInterval(() => {
    void sweep().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[breaks] sweep error', err);
    });
  }, intervalMs);
  timer.unref?.();
}

export function stopBreakScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

// Re-export so callers can trigger an immediate state push after manual edits.
export { broadcastCommitteeState };

function rowToBreak(r: Record<string, unknown>): ScheduledBreak {
  return {
    id: r.id as string,
    committeeId: r.committee_id as string,
    label: r.label as string,
    startAt: Number(r.start_at as number),
    endAt: Number(r.end_at as number),
    status: r.status as BreakStatus,
  };
}
