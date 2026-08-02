/**
 * @mun/server — password hashing (Argon2id)
 *
 * Argon2id is the recommended password hashing algorithm (OWASP). Parameters
 * are tuned for a conference server (single-host, ~500 users): memory 19 MiB,
 * time 2, parallelism 1. Verification is constant-time via the library.
 *
 * NOTE: `@node-rs/argon2` exposes `Algorithm` as a const enum, which cannot be
 * referenced under `isolatedModules`. We pass the numeric Argon2id value (2)
 * via a type-preserving cast instead.
 */

import { hash, verify } from '@node-rs/argon2';

type HashOptions = NonNullable<Parameters<typeof hash>[1]>;

const PARAMS: HashOptions = {
  algorithm: 2 as HashOptions['algorithm'], // 2 === Argon2id
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
};

export async function hashPassword(password: string): Promise<string> {
  return hash(password, PARAMS);
}

export async function verifyPassword(password: string, digest: string): Promise<boolean> {
  try {
    return await verify(digest, password);
  } catch {
    return false;
  }
}
