/**
 * @mun/server — server Ed25519 key for receipt signing
 *
 * The server signs each accepted vote's receipt with an Ed25519 key so any
 * party holding the public key can independently verify a recorded vote. The
 * keypair is generated on first start and stored in `server_config`. For
 * production, restrict DB access to the application role (see deployment docs).
 */

import { pool } from '../db/pool.js';
import { generateEd25519KeyPair, publicKeyFromPrivateKey, type Ed25519KeyPair } from '@mun/crypto';

let cached: Ed25519KeyPair | null = null;

export async function getServerKeyPair(): Promise<Ed25519KeyPair> {
  if (cached) return cached;
  const priv = await pool.query("SELECT value FROM server_config WHERE key = 'ed25519_private'");
  if (priv.rows.length > 0) {
    const privateKeyB64 = priv.rows[0].value as string;
    const publicKeyB64 = publicKeyFromPrivateKey(privateKeyB64);
    cached = { privateKeyB64, publicKeyB64 };
    return cached;
  }
  // Generate + persist.
  const kp = generateEd25519KeyPair();
  const now = Date.now();
  await pool.query(
    `INSERT INTO server_config (key, value, updated_at) VALUES ('ed25519_private', $1, $2)
     ON CONFLICT (key) DO NOTHING`,
    [kp.privateKeyB64, now],
  );
  await pool.query(
    `INSERT INTO server_config (key, value, updated_at) VALUES ('ed25519_public', $1, $2)
     ON CONFLICT (key) DO NOTHING`,
    [kp.publicKeyB64, now],
  );
  cached = kp;
  return cached;
}

export async function getServerPublicKey(): Promise<string> {
  const kp = await getServerKeyPair();
  return kp.publicKeyB64;
}
