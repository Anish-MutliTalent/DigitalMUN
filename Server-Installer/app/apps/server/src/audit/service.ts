/**
 * @mun/server — audit service (tamper-evident log)
 *
 * Appends are serialised with a Postgres transaction-scoped advisory lock so
 * that under concurrent actions each append observes the true previous hash.
 * The `seq` column is an IDENTITY (may gap on rollback — allowed by the
 * verifier); the chain integrity comes from prevHash linkage + per-entry hash.
 *
 * The audit log records security-relevant *actions* (auth, committee state,
 * voting, chair/admin decisions, rule changes, exports). High-frequency
 * monitoring telemetry lives in `monitoring_events`, not here — but a warning
 * raised from telemetry IS audited.
 */

import { pool, tx } from '../db/pool.js';
import { config } from '../config.js';
import {
  chainEntry,
  genesisPrevHash,
  verifyChain,
  type ChainedEntry,
} from '@mun/crypto';
import type { AuditAction, AuditEntry } from '@mun/protocol';

// Fixed advisory-lock key (hashed to an int). Serialises all audit appends.
const ADVISORY_KEY = 0x0d13a7; // "mun-audit"

export interface AuditInput {
  actor: string;
  action: AuditAction;
  subject: string | null;
  detail: string;
}

/** Append an audit entry and return the stored, chained entry. */
export async function audit(input: AuditInput): Promise<ChainedEntry> {
  return tx(async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADVISORY_KEY]);
    const last = await client.query(
      'SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1',
    );
    const prevHash =
      last.rows.length > 0 ? (last.rows[0].hash as string) : genesisPrevHash(config.auditGenesis);
    // pg returns bigint as a string — coerce to number before arithmetic.
    const seq = last.rows.length > 0 ? Number(last.rows[0].seq) + 1 : 1;
    const timestamp = Date.now();
    const entry = chainEntry(prevHash, {
      seq,
      timestamp,
      actor: input.actor,
      action: input.action,
      subject: input.subject,
      detail: input.detail,
    });
    await client.query(
      `INSERT INTO audit_log (seq, timestamp, actor, action, subject, detail, prev_hash, hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.seq,
        entry.timestamp,
        entry.actor,
        entry.action,
        entry.subject,
        entry.detail,
        entry.prevHash,
        entry.hash,
      ],
    );
    return entry;
  });
}

/** Read a range of audit entries (newest first by default). */
export async function listAudit(opts: {
  limit?: number;
  offset?: number;
  action?: AuditAction;
  actor?: string;
  fromTs?: number;
  toTs?: number;
}): Promise<AuditEntry[]> {
  const limit = Math.min(opts.limit ?? 200, 5000);
  const offset = opts.offset ?? 0;
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.action) {
    params.push(opts.action);
    where.push(`action = $${params.length}`);
  }
  if (opts.actor) {
    params.push(opts.actor);
    where.push(`actor = $${params.length}`);
  }
  if (opts.fromTs) {
    params.push(opts.fromTs);
    where.push(`timestamp >= $${params.length}`);
  }
  if (opts.toTs) {
    params.push(opts.toTs);
    where.push(`timestamp <= $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);
  const { rows } = await pool.query(
    `SELECT seq, timestamp, actor, action, subject, detail, prev_hash, hash
     FROM audit_log ${clause}
     ORDER BY seq DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(rowToEntry);
}

/** Verify the entire audit chain. Returns the first broken seq or null. */
export async function verifyAuditChain(): Promise<{
  valid: boolean;
  brokenAtSeq: number | null;
  count: number;
}> {
  // Stream in ascending seq order to avoid loading the whole table at once for
  // very large logs. We page in chunks.
  let prev: ChainedEntry | null = null;
  let count = 0;
  let expectedPrev = genesisPrevHash(config.auditGenesis);
  let prevSeq = 0;
  const PAGE = 5000;
  let offset = 0;
  while (true) {
    const { rows } = await pool.query(
      `SELECT seq, timestamp, actor, action, subject, detail, prev_hash, hash
       FROM audit_log ORDER BY seq ASC LIMIT $1 OFFSET $2`,
      [PAGE, offset],
    );
    if (rows.length === 0) break;
    for (const r of rows) {
      count++;
      const e = rowToEntry(r);
      if (e.seq <= prevSeq) return { valid: false, brokenAtSeq: e.seq, count };
      if (e.prevHash !== expectedPrev) return { valid: false, brokenAtSeq: e.seq, count };
      // Recompute hash.
      const { computeEntryHash } = await import('@mun/crypto');
      if (computeEntryHash(e.prevHash, e) !== e.hash)
        return { valid: false, brokenAtSeq: e.seq, count };
      expectedPrev = e.hash;
      prevSeq = e.seq;
      prev = e;
    }
    if (rows.length < PAGE) break;
    offset += PAGE;
  }
  void prev;
  return { valid: true, brokenAtSeq: null, count };
}

/** Convenience: verify a provided slice (used by tests). */
export async function verifySlice(entries: ChainedEntry[]): Promise<boolean> {
  const res = verifyChain(entries, config.auditGenesis);
  return res.valid;
}

function rowToEntry(r: Record<string, unknown>): AuditEntry {
  return {
    seq: Number(r.seq),
    timestamp: Number(r.timestamp),
    actor: r.actor as string,
    action: r.action as AuditAction,
    subject: (r.subject as string | null) ?? null,
    detail: (r.detail as string) ?? '',
    prevHash: r.prev_hash as string,
    hash: r.hash as string,
  };
}
