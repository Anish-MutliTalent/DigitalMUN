/**
 * @mun/crypto — Ed25519 keys & signing
 *
 * Ed25519 is used for two purposes:
 *  1. Delegate vote signatures — a delegate signs their FOR/AGAINST choice so
 *     the recorded vote is independently verifiable against their registered
 *     public key. Private keys never leave the delegate's device.
 *  2. Server receipt signing — the server signs each accepted vote receipt so
 *     any party holding the server's public key can verify a receipt is genuine
 *     and matches the recorded choice.
 *
 * All keys are transported as base64url raw 32-byte keys (per RFC 8032), not as
 * PEM/DER, to keep the wire format compact and JSON-safe.
 */

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { base64url, base64urlDecode } from './util.js';

/** Raw Ed25519 private key (64 bytes) and public key (32 bytes), base64url. */
export interface Ed25519KeyPair {
  /** base64url 64-byte seed+pubkey (Node format) — keep secret. */
  privateKeyB64: string;
  /** base64url 32-byte public key — safe to share. */
  publicKeyB64: string;
}

/** Generate a new Ed25519 keypair. */
export function generateEd25519KeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  // Export as raw bytes: private key as PKCS8 DER, public key as SP1 DER.
  // For Ed25519 the raw public key is the last 32 bytes of the SP1 DER; we use
  // the KeyObject export to get raw formats directly.
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' });
  const pubDer = publicKey.export({ format: 'der', type: 'spki' });
  // PKCS8 Ed25519 private key: 16-byte prefix + 32-byte seed = 48 bytes total.
  // SPKI Ed25519 public key: 12-byte prefix + 32-byte raw key = 44 bytes.
  const privSeed = privDer.subarray(16); // 32-byte seed
  const pubRaw = pubDer.subarray(12); // 32-byte raw public key
  return {
    privateKeyB64: base64url(privSeed),
    publicKeyB64: base64url(pubRaw),
  };
}

/** Reconstruct a Node KeyObject from a base64url raw private seed. */
export function privateKeyFromB64(b64: string): KeyObject {
  const seed = base64urlDecode(b64);
  if (seed.length !== 32) throw new Error('Invalid Ed25519 private key (expected 32-byte seed)');
  // Build a JWK for Ed25519 private key: x = public, d = private seed.
  // Easier: import raw via PKCS8 prefix.
  const pkcs8 = Buffer.concat([ED25519_PKCS8_PREFIX, seed]);
  return createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
}

/** Reconstruct a Node KeyObject from a base64url raw public key. */
export function publicKeyFromB64(b64: string): KeyObject {
  const raw = base64urlDecode(b64);
  if (raw.length !== 32) throw new Error('Invalid Ed25519 public key (expected 32 bytes)');
  const spki = Buffer.concat([ED25519_SPKI_PREFIX, raw]);
  return createPublicKey({ key: spki, format: 'der', type: 'spki' });
}

/** Derive the base64url public key from a base64url private seed. */
export function publicKeyFromPrivateKey(privB64: string): string {
  const key = privateKeyFromB64(privB64);
  const pub = createPublicKey(key);
  const pubDer = pub.export({ format: 'der', type: 'spki' });
  return base64url(pubDer.subarray(12));
}

/** Sign a message (string or Buffer) with an Ed25519 private key. Returns base64url signature. */
export function signEd25519(message: string | Buffer, privB64: string): string {
  const key = privateKeyFromB64(privB64);
  const buf = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
  return base64url(sign(null, buf, key));
}

/** Verify a base64url Ed25519 signature against a base64url public key. */
export function verifyEd25519(
  message: string | Buffer,
  signatureB64: string,
  pubB64: string,
): boolean {
  try {
    const key = publicKeyFromB64(pubB64);
    const buf = typeof message === 'string' ? Buffer.from(message, 'utf8') : message;
    const sig = base64urlDecode(signatureB64);
    return verify(null, buf, key, sig);
  } catch {
    return false;
  }
}

// DER prefixes for raw Ed25519 key import (avoids needing JWK support quirks).
// PKCS8 prefix for Ed25519 (16 bytes) — OID + algorithm + OCTET STRING wrapper.
const ED25519_PKCS8_PREFIX = Buffer.from(
  '302e020100300506032b657004220420',
  'hex',
);
// SPKI prefix for Ed25519 (12 bytes) — OID + algorithm + BIT STRING tag.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
