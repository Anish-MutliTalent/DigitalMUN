/**
 * @mun/crypto — digital voting primitives
 *
 * Voting integrity rests on three properties enforced here:
 *
 *  1. Authenticity  — only the delegate's registered key can produce a
 *     signature the server will accept (`signVote` / `verifyVoteSignature`).
 *  2. Verifiability — after reveal, anyone holding the delegate's public key
 *     can re-verify a recorded signature, and anyone holding the server's
 *     public key can verify the receipt tying a vote to a recorded choice
 *     (`verifyReceipt`).
 *  3. Immutability  — votes are append-only; the canonical message includes the
 *     client idempotency key so a duplicate cast produces an identical message
 *     and is rejected as a duplicate rather than recorded twice.
 *
 * The canonical signed message is fixed and documented so it can be recomputed
 * years later for an audit.
 */

import type { VoteChoice } from '@mun/protocol';
import { canonicalJson } from './util.js';
import { signEd25519, verifyEd25519 } from './keys.js';

/**
 * The canonical message a delegate signs. Format (stable, versioned):
 *
 *   mun-vote:v1\n<canonicalJson(payload)>
 *
 * where payload = { voteId, delegateId, choice, clientCastId }.
 * The `v1` prefix prevents cross-protocol signature reuse.
 */
export function canonicalVoteMessage(params: {
  voteId: string;
  delegateId: string;
  choice: VoteChoice;
  clientCastId: string;
}): string {
  const payload = {
    voteId: params.voteId,
    delegateId: params.delegateId,
    choice: params.choice,
    clientCastId: params.clientCastId,
  };
  return `mun-vote:v1\n${canonicalJson(payload)}`;
}

/** Delegate signs their vote with their Ed25519 private key. Returns base64url signature. */
export function signVote(
  params: { voteId: string; delegateId: string; choice: VoteChoice; clientCastId: string },
  privateKeyB64: string,
): string {
  return signEd25519(canonicalVoteMessage(params), privateKeyB64);
}

/** Server verifies a delegate's vote signature against the registered public key. */
export function verifyVoteSignature(
  params: { voteId: string; delegateId: string; choice: VoteChoice; clientCastId: string },
  signatureB64: string,
  publicKeyB64: string,
): boolean {
  return verifyEd25519(canonicalVoteMessage(params), signatureB64, publicKeyB64);
}

/**
 * The canonical receipt message the server signs. Includes the recorded choice
 * and submitted timestamp so the delegate can later prove what was recorded.
 */
export function canonicalReceiptMessage(params: {
  voteId: string;
  delegateId: string;
  choice: VoteChoice;
  submittedAt: number;
  recordedHash: string;
}): string {
  const payload = {
    voteId: params.voteId,
    delegateId: params.delegateId,
    choice: params.choice,
    submittedAt: params.submittedAt,
    recordedHash: params.recordedHash,
  };
  return `mun-receipt:v1\n${canonicalJson(payload)}`;
}

/**
 * A server receipt = base64url(receiptPayloadJson) + '.' + base64url(ed25519Sig).
 * The receipt payload is self-describing so verification doesn't need a second
 * round-trip.
 */
export interface ServerReceipt {
  payloadB64: string;
  signatureB64: string;
  token: string; // payloadB64 + '.' + signatureB64
}

export interface ReceiptPayload {
  voteId: string;
  delegateId: string;
  choice: VoteChoice;
  submittedAt: number;
  recordedHash: string;
}

/** Server signs a receipt with its Ed25519 private key. */
export function signReceipt(
  payload: ReceiptPayload,
  serverPrivateKeyB64: string,
): ServerReceipt {
  const msg = canonicalReceiptMessage(payload);
  const signatureB64 = signEd25519(msg, serverPrivateKeyB64);
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson, 'utf8').toString('base64url');
  return { payloadB64, signatureB64, token: `${payloadB64}.${signatureB64}` };
}

/**
 * Anyone holding the server's public key can verify a receipt and recover the
 * recorded choice. Returns the payload on success, null on failure.
 */
export function verifyReceipt(
  token: string,
  serverPublicKeyB64: string,
): ReceiptPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, signatureB64] = parts;
  let payload: ReceiptPayload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const msg = canonicalReceiptMessage(payload);
  if (!verifyEd25519(msg, signatureB64, serverPublicKeyB64)) return null;
  return payload;
}
