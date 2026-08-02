/**
 * @mun/server — voting service
 *
 * Implements the spec's digital-voting guarantees:
 *  - FOR / AGAINST only (no abstain).
 *  - Results HIDDEN until every enabled, checked-in delegate has voted. The
 *    chair sees only "Votes Submitted: n / required" until reveal.
 *  - Reveal is gated on completion: submitted_count == eligibleCount (enabled
 *    + present/voting delegates). Disabling a non-voting delegate lowers
 *    eligibleCount, letting a blocked vote complete — the chair's escape hatch.
 *  - Votes are immutable (DB trigger forbids update/delete; see migration).
 *  - One vote per delegate per question: enforced atomically with a row lock on
 *    the vote + a UNIQUE constraint (race-condition-proof).
 *  - Cryptographically verifiable: each cast carries the delegate's Ed25519
 *    signature over the canonical vote message, verified against their
 *    registered public key. The server returns an Ed25519-signed receipt.
 *  - Idempotent: a repeated cast with the same clientCastId is a no-op ack.
 */

import { pool, tx } from '../db/pool.js';
import { audit } from '../audit/service.js';
import { broker } from '../realtime/broker.js';
import { presence } from '../realtime/presence.js';
import { getServerKeyPair } from './serverkeys.js';
import { envelope, ProtocolError, type Vote, type VoteResult, type VoteChoice } from '@mun/protocol';
import { verifyVoteSignature, signReceipt, sha256Hex, randomUuid } from '@mun/crypto';

/** Count enabled, checked-in delegates (the eligible voting set). */
export async function eligibleCount(committeeId: string): Promise<number> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM delegates
     WHERE committee_id = $1 AND enabled = true AND attendance IN ('present','voting')`,
    [committeeId],
  );
  return rows[0].n as number;
}

export async function createVote(params: {
  committeeId: string;
  question: string;
  chairUserId: string;
}): Promise<Vote> {
  const { rows: crows } = await pool.query('SELECT status FROM committees WHERE id = $1', [
    params.committeeId,
  ]);
  if (crows.length === 0) throw new ProtocolError('COMMITTEE_NOT_FOUND', 'Committee not found');
  if (crows[0].status !== 'active') {
    throw new ProtocolError('CONFLICT', 'Committee is not active; cannot open a vote.');
  }

  const required = await eligibleCount(params.committeeId);
  const id = randomUuid();
  const now = Date.now();
  await pool.query(
    `INSERT INTO votes (id, committee_id, question, status, created_by, created_at, required_count, submitted_count)
     VALUES ($1, $2, $3, 'open', $4, $5, $6, 0)`,
    [id, params.committeeId, params.question, params.chairUserId, now, required],
  );
  const vote = await getVote(id);
  await audit({
    actor: params.chairUserId,
    action: 'vote_open',
    subject: id,
    detail: `Opened vote: "${params.question}" (required ${required}).`,
  });
  broadcastVoteState(params.committeeId, vote!, null);
  return vote!;
}

export interface CastResult {
  accepted: boolean;
  duplicate: boolean;
  receipt: string | null;
  submittedCount: number;
  requiredCount: number;
  reason: string | null;
}

export async function castVote(params: {
  voteId: string;
  delegateId: string;
  committeeId: string;
  choice: VoteChoice;
  signature: string;
  publicKey: string;
  clientCastId: string;
}): Promise<CastResult> {
  return tx(async (client) => {
    // Lock the vote row to serialise casts per vote (prevents count races).
    const { rows: vrows } = await client.query(
      'SELECT * FROM votes WHERE id = $1 FOR UPDATE',
      [params.voteId],
    );
    const voteRow = vrows[0];
    if (!voteRow) throw new ProtocolError('VOTE_NOT_FOUND', 'Vote not found');
    if (voteRow.status !== 'open')
      throw new ProtocolError('VOTE_NOT_OPEN', 'Vote is not open');

    // Delegate must be enabled + checked in.
    const { rows: drows } = await client.query(
      'SELECT enabled, attendance, public_key FROM delegates WHERE id = $1',
      [params.delegateId],
    );
    const d = drows[0];
    if (!d) throw new ProtocolError('DELEGATE_NOT_FOUND', 'Delegate not found');
    if (!d.enabled) throw new ProtocolError('DELEGATE_DISABLED', 'Delegate is disabled');
    if (!['present', 'voting'].includes(d.attendance))
      throw new ProtocolError('CONFLICT', 'Delegate is not checked in');

    // Verify against the REGISTERED public key (never the client-supplied one).
    if (!d.public_key) {
      throw new ProtocolError('VOTE_INVALID_SIGNATURE', 'Delegate has not registered a voting key');
    }
    if (d.public_key !== params.publicKey) {
      throw new ProtocolError('VOTE_INVALID_SIGNATURE', 'Public key does not match registration');
    }
    const valid = verifyVoteSignature(
      {
        voteId: params.voteId,
        delegateId: params.delegateId,
        choice: params.choice,
        clientCastId: params.clientCastId,
      },
      params.signature,
      d.public_key,
    );
    if (!valid) throw new ProtocolError('VOTE_INVALID_SIGNATURE', 'Signature verification failed');

    // Check for an existing cast (clean error + idempotency).
    const { rows: existing } = await client.query(
      'SELECT choice FROM vote_records WHERE vote_id = $1 AND delegate_id = $2',
      [params.voteId, params.delegateId],
    );
    if (existing.length > 0) {
      // Idempotent: already cast. Acknowledge without revealing the choice.
      const submitted = (voteRow.submitted_count as number) ?? 0;
      return {
        accepted: true,
        duplicate: true,
        receipt: null,
        submittedCount: submitted,
        requiredCount: voteRow.required_count as number,
        reason: 'Already voted',
      };
    }

    const submittedAt = Date.now();
    const recordedHash = sha256Hex(
      JSON.stringify({ voteId: params.voteId, delegateId: params.delegateId, choice: params.choice, clientCastId: params.clientCastId, submittedAt }),
    );
    const serverKey = await getServerKeyPair();
    const receipt = signReceipt(
      {
        voteId: params.voteId,
        delegateId: params.delegateId,
        choice: params.choice,
        submittedAt,
        recordedHash,
      },
      serverKey.privateKeyB64,
    );
    const recordId = randomUuid();
    try {
      await client.query(
        `INSERT INTO vote_records
          (id, vote_id, delegate_id, choice, signature, public_key, client_cast_id, submitted_at, receipt, recorded_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          recordId,
          params.voteId,
          params.delegateId,
          params.choice,
          params.signature,
          d.public_key,
          params.clientCastId,
          submittedAt,
          receipt.token,
          recordedHash,
        ],
      );
    } catch {
      // UNIQUE violation → duplicate (race lost). Idempotent ack.
      const submitted = (voteRow.submitted_count as number) ?? 0;
      return {
        accepted: true,
        duplicate: true,
        receipt: null,
        submittedCount: submitted,
        requiredCount: voteRow.required_count as number,
        reason: 'Already voted',
      };
    }

    const newCount = (voteRow.submitted_count as number) + 1;
    await client.query('UPDATE votes SET submitted_count = $1 WHERE id = $2', [
      newCount,
      params.voteId,
    ]);

    await audit({
      actor: params.delegateId,
      action: 'vote_cast',
      subject: params.voteId,
      detail: `Delegate cast a vote (${params.choice}).`,
    });

    const updatedVote = await getVoteWithClient(client, params.voteId);
    // Broadcast counts (no choices) to the committee.
    broadcastVoteState(params.committeeId, updatedVote, null);

    return {
      accepted: true,
      duplicate: false,
      receipt: receipt.token,
      submittedCount: newCount,
      requiredCount: updatedVote.requiredCount,
      reason: null,
    };
  });
}

export async function closeVote(voteId: string, chairUserId: string): Promise<Vote> {
  const { rows } = await pool.query(
    "UPDATE votes SET status = 'closed', closed_at = $1 WHERE id = $2 AND status = 'open' RETURNING *",
    [Date.now(), voteId],
  );
  if (rows.length === 0) {
    const v = await getVote(voteId);
    if (!v) throw new ProtocolError('VOTE_NOT_FOUND', 'Vote not found');
    return v; // already closed/revealed
  }
  const vote = rowToVote(rows[0]);
  await audit({ actor: chairUserId, action: 'vote_close', subject: voteId, detail: 'Vote closed.' });
  broadcastVoteState(vote.committeeId, vote, null);
  return vote;
}

export async function revealVote(voteId: string, chairUserId: string): Promise<VoteResult> {
  return tx(async (client) => {
    const { rows: vrows } = await client.query('SELECT * FROM votes WHERE id = $1 FOR UPDATE', [
      voteId,
    ]);
    const v = vrows[0];
    if (!v) throw new ProtocolError('VOTE_NOT_FOUND', 'Vote not found');

    const eligible = await eligibleCountWithClient(client, v.committee_id);
    const submitted = v.submitted_count as number;
    if (submitted < eligible) {
      throw new ProtocolError(
        'VOTE_REVEAL_NOT_READY',
        `Cannot reveal: ${submitted}/${eligible} eligible delegates have voted.`,
      );
    }
    if (v.status === 'revealed') {
      // Already revealed — return the result.
      const result = await computeResultWithClient(client, v);
      return result;
    }
    await client.query(
      "UPDATE votes SET status = 'revealed', revealed_at = $1 WHERE id = $2",
      [Date.now(), voteId],
    );
    await audit({
      actor: chairUserId,
      action: 'vote_reveal',
      subject: voteId,
      detail: `Vote revealed (${submitted}/${eligible}).`,
    });
    const { rows: updated } = await client.query('SELECT * FROM votes WHERE id = $1', [voteId]);
    const vote = rowToVote(updated[0]);
    const result = await computeResultWithClient(client, updated[0]);
    // Broadcast revealed results to the whole committee (delegates included).
    broker.broadcastCommitteeAll(v.committee_id, envelope('vote_revealed', { vote, result }));
    return result;
  });
}

export async function getVote(voteId: string): Promise<Vote | null> {
  const { rows } = await pool.query('SELECT * FROM votes WHERE id = $1', [voteId]);
  return rows.length ? rowToVote(rows[0]) : null;
}

async function getVoteWithClient(client: import('pg').PoolClient, voteId: string): Promise<Vote> {
  const { rows } = await client.query('SELECT * FROM votes WHERE id = $1', [voteId]);
  return rowToVote(rows[0]);
}

export async function listCommitteeVotes(committeeId: string, opts: { limit?: number } = {}): Promise<Vote[]> {
  const limit = Math.min(opts.limit ?? 50, 500);
  const { rows } = await pool.query(
    'SELECT * FROM votes WHERE committee_id = $1 ORDER BY created_at DESC LIMIT $2',
    [committeeId, limit],
  );
  return rows.map(rowToVote);
}

/** Return the public view of a vote (counts only until revealed). */
export async function getVotePublicState(voteId: string): Promise<{
  vote: Vote;
  result: VoteResult | null;
}> {
  const vote = await getVote(voteId);
  if (!vote) throw new ProtocolError('VOTE_NOT_FOUND', 'Vote not found');
  if (vote.status === 'revealed') {
    const { rows } = await pool.query('SELECT * FROM vote_records WHERE vote_id = $1', [voteId]);
    const result = computeResultFromRows(vote, rows);
    return { vote, result };
  }
  return { vote, result: null };
}

function broadcastVoteState(committeeId: string, vote: Vote, result: VoteResult | null): void {
  broker.broadcastCommitteeAll(committeeId, envelope('vote_state', { vote, result }));
}

async function computeResultWithClient(
  client: import('pg').PoolClient,
  voteRow: Record<string, unknown>,
): Promise<VoteResult> {
  const { rows } = await client.query('SELECT * FROM vote_records WHERE vote_id = $1', [
    voteRow.id,
  ]);
  return computeResultFromRows(rowToVote(voteRow), rows);
}

function computeResultFromRows(vote: Vote, rows: ReadonlyArray<Record<string, unknown>>): VoteResult {
  let forCount = 0;
  let againstCount = 0;
  const records = rows.map((r) => ({
    voteId: r.vote_id as string,
    delegateId: r.delegate_id as string,
    choice: r.choice as VoteChoice,
    submittedAt: Number(r.submitted_at as number),
    receipt: r.receipt as string,
    signature: r.signature as string,
  }));
  for (const r of records) {
    if (r.choice === 'for') forCount++;
    else againstCount++;
  }
  return {
    voteId: vote.id,
    forCount,
    againstCount,
    requiredCount: vote.requiredCount,
    submittedCount: vote.submittedCount,
    records,
    revealedAt: vote.revealedAt,
  };
}

async function eligibleCountWithClient(
  client: import('pg').PoolClient,
  committeeId: string,
): Promise<number> {
  const { rows } = await client.query(
    `SELECT COUNT(*)::int AS n FROM delegates
     WHERE committee_id = $1 AND enabled = true AND attendance IN ('present','voting')`,
    [committeeId],
  );
  return rows[0].n as number;
}

function rowToVote(r: Record<string, unknown>): Vote {
  return {
    id: r.id as string,
    committeeId: r.committee_id as string,
    question: r.question as string,
    status: r.status as Vote['status'],
    createdBy: r.created_by as string,
    createdAt: Number(r.created_at as number),
    closedAt: r.closed_at ? Number(r.closed_at) : null,
    revealedAt: r.revealed_at ? Number(r.revealed_at) : null,
    requiredCount: r.required_count as number,
    submittedCount: r.submitted_count as number,
  };
}

// Suppress unused-import warning for presence (used by committee enable/disable
// to refresh eligibility broadcasts).
export { presence };
