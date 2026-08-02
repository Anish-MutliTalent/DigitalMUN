/**
 * @mun/crypto — tamper-evident audit log (hash chain)
 *
 * Every security-relevant action is appended as an entry whose hash chains to
 * the previous entry's hash:
 *
 *   hash_n = SHA-256( prevHash_n || canonicalJson({
 *     seq, timestamp, actor, action, subject, detail
 *   }) )
 *
 * The genesis entry uses a fixed prevHash derived from a configurable constant.
 * Tampering with any entry breaks the chain at that point and is detectable by
 * `verifyChain`. The server stores entries in an append-only table; deletion or
 * mutation of any row invalidates the chain.
 */

import { sha256Hex } from './util.js';

export interface ChainEntryFields {
  seq: number;
  timestamp: number;
  actor: string;
  action: string;
  subject: string | null;
  detail: string;
}

export interface ChainedEntry extends ChainEntryFields {
  prevHash: string;
  hash: string;
}

/** Compute the genesis prevHash from a domain separator. */
export function genesisPrevHash(genesisConstant: string): string {
  return sha256Hex(`mun-guardian:audit:genesis:${genesisConstant}`);
}

/**
 * Compute the hash for an entry given the previous hash and the entry fields.
 * Deterministic across server restarts and across machines.
 */
export function computeEntryHash(prevHash: string, fields: ChainEntryFields): string {
  const canon = canonicalEntry(fields);
  return sha256Hex(`${prevHash}|${canon}`);
}

/** Canonical serialisation of the signed fields (stable key order, no whitespace). */
export function canonicalEntry(fields: ChainEntryFields): string {
  // Order matters for the hash; we fix it explicitly here rather than relying
  // on object key sorting, so the format is documented and stable.
  return JSON.stringify({
    seq: fields.seq,
    timestamp: fields.timestamp,
    actor: fields.actor,
    action: fields.action,
    subject: fields.subject,
    detail: fields.detail,
  });
}

/**
 * Build a new chained entry from the previous entry and new fields.
 * The caller assigns `seq` (typically previous.seq + 1, or 1 for genesis).
 */
export function chainEntry(prevHash: string, fields: ChainEntryFields): ChainedEntry {
  const hash = computeEntryHash(prevHash, fields);
  return { ...fields, prevHash, hash };
}

/**
 * Verify an ordered list of chained entries. Returns the index of the first
 * broken entry, or `null` if the entire chain is valid.
 *
 * Rules:
 *  - Entries are ordered by ascending seq; seq must be strictly increasing
 *    (reorders/duplicates are caught). Gaps are ALLOWED because the identity
 *    column can skip values on rolled-back transactions — a gap represents an
 *    entry that never committed, not a tampered chain.
 *  - The first entry's prevHash must equal the genesis hash.
 *  - Each entry's prevHash must equal the previous entry's hash.
 *  - Each entry's hash must recompute correctly.
 */
export function verifyChain(
  entries: ReadonlyArray<ChainedEntry>,
  genesisConstant: string,
): { valid: boolean; brokenAt: number | null } {
  let expectedPrev = genesisPrevHash(genesisConstant);
  let prevSeq = 0;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.seq <= prevSeq) return { valid: false, brokenAt: i };
    if (e.prevHash !== expectedPrev) return { valid: false, brokenAt: i };
    const recomputed = computeEntryHash(e.prevHash, e);
    if (recomputed !== e.hash) return { valid: false, brokenAt: i };
    expectedPrev = e.hash;
    prevSeq = e.seq;
  }
  return { valid: true, brokenAt: null };
}

/**
 * Verify a single entry against its stated prevHash (useful for streaming
 * verification as entries are loaded).
 */
export function verifyEntry(entry: ChainedEntry): boolean {
  return computeEntryHash(entry.prevHash, entry) === entry.hash;
}
