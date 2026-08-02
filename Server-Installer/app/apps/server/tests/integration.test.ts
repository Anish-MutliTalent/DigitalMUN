/**
 * @mun/server — integration tests
 *
 * Tests the highest-risk paths against the real PostgreSQL database using
 * Fastify's `inject` (no network). Isolated test data is created via the admin
 * API and cleaned up afterwards. Requires a running Postgres with the schema
 * migrated (pnpm migrate).
 */

import { describe, beforeAll, afterAll, it, expect } from 'vitest';
import { buildApp } from '../src/app.js';
import type { FastifyInstance } from 'fastify';
import { pool } from '../src/db/pool.js';
import { ingestEvent } from '../src/monitoring/ingest.js';
import { audit, verifyAuditChain } from '../src/audit/service.js';
import { generateEd25519KeyPair, signVote } from '@mun/crypto';
import { randomUUID } from 'node:crypto';
import type { ServerEnvelope } from '@mun/protocol';

const PREFIX = `t${Date.now().toString(36)}`;
let app: FastifyInstance;
let close: () => Promise<void>;

const adminUser = `${PREFIX}_admin`;
const adminPass = `${PREFIX}_pw`;
const chairUser = `${PREFIX}_chair`;
const chairPass = `${PREFIX}_pw`;
const delegateUser = `${PREFIX}_delegate`;
const delegatePass = `${PREFIX}_pw`;

let adminToken: string;
let chairToken: string;
let delegateToken: string;
let committeeId: string;
let chairUserId: string;
let delegateUserId: string;
let delegateId: string;

async function inject(method: string, url: string, body?: unknown, token?: string) {
  const res = await app.inject({
    method: method as 'GET' | 'POST' | 'PUT' | 'DELETE',
    url,
    headers: token ? { authorization: `Bearer ${token}` } : undefined,
    payload: body,
  });
  return { status: res.statusCode, data: res.json() as Record<string, unknown> };
}

async function login(username: string, password: string) {
  const r = await inject('POST', '/auth/login', { username, password, platform: 'windows' });
  return r;
}

beforeAll(async () => {
  ({ app, close } = await buildApp({ withWebSocket: false }));

  // Bootstrap a dedicated admin (the seeded admin works, but create a fresh one
  // to avoid disturbing demo data).
  const seededAdmin = await login('admin', 'change-me-immediately');
  adminToken = seededAdmin.data.accessToken as string;

  // Create test chair + delegate users.
  const chairRes = await inject('POST', '/admin/users', {
    username: chairUser,
    password: chairPass,
    role: 'chair',
    displayName: 'Test Chair',
  }, adminToken);
  chairUserId = (chairRes.data.user as { id: string }).id;

  const delegateRes = await inject('POST', '/admin/users', {
    username: delegateUser,
    password: delegatePass,
    role: 'delegate',
    displayName: 'Test Delegate',
  }, adminToken);
  delegateUserId = (delegateRes.data.user as { id: string }).id;

  // Create a committee chaired by the test chair.
  const committeeRes = await inject('POST', '/admin/committee', {
    name: `${PREFIX} Committee`,
    topic: 'Test topic',
    description: 'test',
    chairUserId,
  }, adminToken);
  committeeId = (committeeRes.data.committee as { id: string }).id;

  // Add the delegate to the committee.
  const addDel = await inject('POST', `/admin/committee/${committeeId}/delegate`, {
    userId: delegateUserId,
    country: 'Testland',
  }, adminToken);
  delegateId = (addDel.data.delegate as { id: string }).id;

  // Mark the delegate present + voting-eligible.
  await inject('POST', `/committee/${committeeId}/delegate/${delegateId}/attendance`, { attendance: 'present' }, adminToken);
});

afterAll(async () => {
  // Cleanup: delete the test committee (cascades delegates/votes/warnings/…)
  // then the test users (cascades sessions).
  await pool.query('DELETE FROM committees WHERE id = $1', [committeeId]).catch(() => {});
  await pool.query('DELETE FROM users WHERE username LIKE $1', [`${PREFIX}%`]).catch(() => {});
  await close();
  await pool.end();
});

describe('auth: single-device enforcement', () => {
  it('lets a delegate log in once', async () => {
    const r = await login(delegateUser, delegatePass);
    expect(r.status).toBe(200);
    expect(r.data.accessToken).toBeTypeOf('string');
    delegateToken = r.data.accessToken as string;
  });

  it('blocks a second login while the session is active (re-login required)', async () => {
    const r = await login(delegateUser, delegatePass);
    expect(r.status).toBe(409);
    expect(r.data.code).toBe('AUTH_RELOGIN_REQUIRED');
  });
});

describe('voting: end-to-end', () => {
  let voteId: string;
  const kp = generateEd25519KeyPair();

  it('chair opens a vote', async () => {
    const chairLogin = await login(chairUser, chairPass);
    chairToken = chairLogin.data.accessToken as string;
    const r = await inject('POST', `/committee/${committeeId}/vote`, { question: 'Adopt the resolution?' }, chairToken);
    expect(r.status).toBe(200);
    voteId = (r.data.vote as { id: string }).id;
    expect(voteId).toBeTypeOf('string');
  });

  it('delegate registers a voting key', async () => {
    const r = await inject('POST', '/delegate/register-key', { publicKey: kp.publicKeyB64 }, delegateToken);
    expect(r.status).toBe(200);
  });

  it('delegate casts a valid signed vote (FOR)', async () => {
    const clientCastId = randomUUID();
    const signature = signVote({ voteId, delegateId, choice: 'for', clientCastId }, kp.privateKeyB64);
    const r = await inject('POST', `/committee/${committeeId}/vote/${voteId}/cast`, {
      choice: 'for',
      signature,
      publicKey: kp.publicKeyB64,
      clientCastId,
    }, delegateToken);
    expect(r.status).toBe(200);
    expect(r.data.accepted).toBe(true);
    expect(r.data.duplicate).toBe(false);
    expect(r.data.receipt).toBeTypeOf('string');
  });

  it('rejects a duplicate cast (idempotent)', async () => {
    // r1: a fresh cast attempt by a delegate who already voted -> duplicate ack.
    const clientCastId1 = randomUUID();
    const r1 = await inject('POST', `/committee/${committeeId}/vote/${voteId}/cast`, {
      choice: 'for',
      signature: signVote({ voteId, delegateId, choice: 'for', clientCastId: clientCastId1 }, kp.privateKeyB64),
      publicKey: kp.publicKeyB64,
      clientCastId: clientCastId1,
    }, delegateToken);
    expect(r1.data.accepted).toBe(true);
    expect(r1.data.duplicate).toBe(true);

    // r2: a different choice, same delegate -> still duplicate (one vote per delegate).
    const clientCastId2 = randomUUID();
    const r2 = await inject('POST', `/committee/${committeeId}/vote/${voteId}/cast`, {
      choice: 'against',
      signature: signVote({ voteId, delegateId, choice: 'against', clientCastId: clientCastId2 }, kp.privateKeyB64),
      publicKey: kp.publicKeyB64,
      clientCastId: clientCastId2,
    }, delegateToken);
    expect(r2.data.accepted).toBe(true);
    expect(r2.data.duplicate).toBe(true);
  });

  it('rejects an invalid signature', async () => {
    const other = generateEd25519KeyPair();
    const clientCastId = randomUUID();
    const r = await inject('POST', `/committee/${committeeId}/vote/${voteId}/cast`, {
      choice: 'for',
      signature: signVote({ voteId, delegateId, choice: 'for', clientCastId }, other.privateKeyB64),
      publicKey: other.publicKeyB64, // wrong key
      clientCastId,
    }, delegateToken);
    expect(r.status).toBe(400);
    expect(r.data.code).toBe('VOTE_INVALID_SIGNATURE');
  });

  it('chair cannot reveal before completion (only 1 of 1 — should complete)', async () => {
    // The only enabled+present delegate has voted, so eligible=1, submitted=1.
    const r = await inject('POST', `/committee/${committeeId}/vote/${voteId}/reveal`, {}, chairToken);
    expect(r.status).toBe(200);
    const result = r.data.result as { forCount: number; againstCount: number };
    expect(result.forCount).toBe(1);
    expect(result.againstCount).toBe(0);
  });

  it('hides choices before reveal (public state)', async () => {
    // Open a second vote and check the public state hides the choice.
    const open = await inject('POST', `/committee/${committeeId}/vote`, { question: 'Second?' }, chairToken);
    const vid = (open.data.vote as { id: string }).id;
    const state = await inject('GET', `/committee/${committeeId}/vote/${vid}`, {}, chairToken);
    expect(state.status).toBe(200);
    // result is null until revealed.
    expect(state.data.result).toBeNull();
    await inject('POST', `/committee/${committeeId}/vote/${vid}/close`, {}, chairToken);
  });
});

describe('monitoring: ingest idempotency + warnings', () => {
  it('ingests an event and creates a warning on ai_detected', async () => {
    const clientEventId = randomUUID();
    const r1 = await ingestEvent(
      {
        clientEventId,
        delegateId,
        committeeId,
        type: 'ai_detected',
        clientTs: Date.now(),
        appName: 'Google Chrome',
        title: 'ChatGPT',
        titleScope: 'matched',
        matchedRuleId: null,
        matchedRuleName: 'ChatGPT',
        severity: 'critical',
        durationMs: null,
        fromAppName: null,
      },
      { delegateId, committeeId, displayName: 'Test Delegate', country: 'Testland' },
    );
    expect(r1.accepted).toBe(true);
    expect(r1.duplicate).toBe(false);

    // Duplicate (same clientEventId) -> idempotent.
    const r2 = await ingestEvent(
      {
        clientEventId,
        delegateId,
        committeeId,
        type: 'ai_detected',
        clientTs: Date.now(),
        appName: 'Google Chrome',
        title: 'ChatGPT',
        titleScope: 'matched',
        matchedRuleId: null,
        matchedRuleName: 'ChatGPT',
        severity: 'critical',
        durationMs: null,
        fromAppName: null,
      },
      { delegateId, committeeId, displayName: 'Test Delegate', country: 'Testland' },
    );
    expect(r2.duplicate).toBe(true);

    // A warning row should exist for this delegate.
    const { rows } = await pool.query(
      "SELECT type FROM warnings WHERE delegate_id = $1 AND type = 'ai_detected'",
      [delegateId],
    );
    expect(rows.length).toBeGreaterThan(0);
  });
});

describe('audit: hash chain integrity', () => {
  it('appends entries and verifies the chain', async () => {
    await audit({ actor: 'test', action: 'login', subject: null, detail: 'test entry 1' });
    await audit({ actor: 'test', action: 'logout', subject: null, detail: 'test entry 2' });
    const res = await verifyAuditChain();
    expect(res.valid).toBe(true);
  });
});

// Helper to satisfy the ServerEnvelope import type usage.
export type { ServerEnvelope };
