/**
 * @mun/crypto — encoding & canonicalisation utilities
 *
 * Determinism is the foundation of cryptographic verification: a signature or
 * hash is only reproducible if the signed bytes are canonical. All crypto in
 * this package encodes through these helpers so server and client always agree
 * on the exact bytes that were signed/hashed.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

/** Base64url encoding (no padding) — URL-safe, JSON-safe. */
export function base64url(input: Buffer | Uint8Array | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return buf.toString('base64url');
}

/** Decode a base64url string to a Buffer. */
export function base64urlDecode(input: string): Buffer {
  // Buffer supports base64url directly (Node ≥14).
  return Buffer.from(input, 'base64url');
}

/** Hex encoding of bytes. */
export function toHex(input: Buffer | Uint8Array): string {
  return Buffer.from(input).toString('hex');
}

/** Decode a hex string to a Buffer. */
export function fromHex(input: string): Buffer {
  return Buffer.from(input, 'hex');
}

/**
 * Constant-time equality for secrets (tokens, signatures). Falls back to a
 * length-checked compare for non-equal-length inputs (which can never match).
 */
export function constantTimeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const ab = typeof a === 'string' ? Buffer.from(a) : a;
  const bb = typeof b === 'string' ? Buffer.from(b) : b;
  if (ab.length !== bb.length) return false;
  try {
    return timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}

/**
 * Canonical JSON encoding for signing/hashing:
 *  - Object keys sorted ascending (stable).
 *  - No insignificant whitespace.
 *  - UTF-8 output.
 *  - `undefined` omitted; `null` preserved.
 *
 * This matches the canonical-JSON convention used for verifiable logs.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Non-finite number in canonical input');
    return value;
  }
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  throw new TypeError(`Cannot canonicalize value of type ${typeof value}`);
}

/** SHA-256 of a string/Buffer, returned as hex. */
export function sha256Hex(input: string | Buffer | Uint8Array): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input);
  return toHex(createHash('sha256').update(buf).digest());
}

/** SHA-256 of a Buffer, returned as a Buffer. */
export function sha256(input: Buffer | Uint8Array): Buffer {
  return createHash('sha256').update(Buffer.from(input)).digest();
}

/** A random UUID v4 (uses Node's CSPRNG). */
export function randomUuid(): string {
  return randomUUID();
}

/** Random bytes as hex. */
export function randomHex(byteLength: number): string {
  return toHex(randomBytes(byteLength));
}

/** Random bytes as a Buffer. */
export function randomBytesBuf(byteLength: number): Buffer {
  return randomBytes(byteLength);
}
