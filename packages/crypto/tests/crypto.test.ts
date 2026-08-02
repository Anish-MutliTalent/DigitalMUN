import { describe, it, expect } from 'vitest';
import {
  generateEd25519KeyPair,
  signEd25519,
  verifyEd25519,
  publicKeyFromPrivateKey,
  signVote,
  verifyVoteSignature,
  signReceipt,
  verifyReceipt,
  type ReceiptPayload,
} from '../src/index.js';
import {
  chainEntry,
  verifyChain,
  genesisPrevHash,
  computeEntryHash,
  type ChainEntryFields,
} from '../src/audit-chain.js';
import { TokenService } from '../src/tokens.js';
import { canonicalJson, sha256Hex, constantTimeEqual } from '../src/util.js';

describe('Ed25519 keys', () => {
  it('generates a valid keypair and signs/verifies', () => {
    const kp = generateEd25519KeyPair();
    expect(kp.privateKeyB64.length).toBeGreaterThan(0);
    expect(kp.publicKeyB64.length).toBeGreaterThan(0);
    const msg = 'hello-mun';
    const sig = signEd25519(msg, kp.privateKeyB64);
    expect(verifyEd25519(msg, sig, kp.publicKeyB64)).toBe(true);
    expect(verifyEd25519('tampered', sig, kp.publicKeyB64)).toBe(false);
  });

  it('derives a consistent public key from the private key', () => {
    const kp = generateEd25519KeyPair();
    expect(publicKeyFromPrivateKey(kp.privateKeyB64)).toBe(kp.publicKeyB64);
  });

  it('rejects tampered signatures', () => {
    const kp = generateEd25519KeyPair();
    const sig = signEd25519('msg', kp.privateKeyB64);
    // Flip a character in the signature.
    const tampered = sig.charAt(0) === 'A' ? 'B' + sig.slice(1) : 'A' + sig.slice(1);
    expect(verifyEd25519('msg', tampered, kp.publicKeyB64)).toBe(false);
  });
});

describe('canonical JSON', () => {
  it('sorts keys deterministically', () => {
    const a = canonicalJson({ b: 1, a: 2, c: { z: 1, a: 2 } });
    const b = canonicalJson({ c: { a: 2, z: 1 }, a: 2, b: 1 });
    expect(a).toBe(b);
  });

  it('omits undefined and keeps null', () => {
    expect(canonicalJson({ x: undefined, y: null })).toBe('{"y":null}');
  });

  it('produces stable hashes', () => {
    const o1 = { b: 1, a: 2 };
    const o2 = { a: 2, b: 1 };
    expect(sha256Hex(canonicalJson(o1))).toBe(sha256Hex(canonicalJson(o2)));
  });
});

describe('audit hash chain', () => {
  const GENESIS = 'test-genesis';

  function fields(seq: number, actor: string, action: string): ChainEntryFields {
    return { seq, timestamp: 1_000_000 + seq, actor, action, subject: 's' + seq, detail: 'd' + seq };
  }

  it('chains entries and verifies a clean chain', () => {
    let prev = genesisPrevHash(GENESIS);
    const entries = [];
    for (let i = 1; i <= 5; i++) {
      const e = chainEntry(prev, fields(i, 'u1', 'login'));
      entries.push(e);
      prev = e.hash;
    }
    const res = verifyChain(entries, GENESIS);
    expect(res.valid).toBe(true);
    expect(res.brokenAt).toBeNull();
  });

  it('detects tampering with a field', () => {
    let prev = genesisPrevHash(GENESIS);
    const entries = [];
    for (let i = 1; i <= 4; i++) {
      const e = chainEntry(prev, fields(i, 'u1', 'login'));
      entries.push(e);
      prev = e.hash;
    }
    // Tamper with entry 2's detail but keep its (now-wrong) hash.
    entries[1] = { ...entries[1], detail: 'HACKED' };
    const res = verifyChain(entries, GENESIS);
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it('detects a broken prevHash link', () => {
    let prev = genesisPrevHash(GENESIS);
    const entries = [];
    for (let i = 1; i <= 3; i++) {
      const e = chainEntry(prev, fields(i, 'u1', 'login'));
      entries.push(e);
      prev = e.hash;
    }
    entries[1] = { ...entries[1], prevHash: 'deadbeef' };
    const res = verifyChain(entries, GENESIS);
    expect(res.valid).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it('detects a missing/reordered entry by seq', () => {
    let prev = genesisPrevHash(GENESIS);
    const entries = [];
    for (let i = 1; i <= 3; i++) {
      const e = chainEntry(prev, fields(i, 'u1', 'login'));
      entries.push(e);
      prev = e.hash;
    }
    // Skip entry 2 by renumbering entry 3.
    entries[2] = { ...entries[2], seq: 2 };
    const res = verifyChain(entries, GENESIS);
    expect(res.valid).toBe(false);
  });

  it('is deterministic across recomputation', () => {
    const prev = genesisPrevHash(GENESIS);
    const f = fields(1, 'u', 'a');
    expect(computeEntryHash(prev, f)).toBe(computeEntryHash(prev, f));
  });
});

describe('session tokens', () => {
  const svc = new TokenService('a'.repeat(48), 'b'.repeat(48));

  it('issues and verifies an access token', () => {
    const { token, payload } = svc.issueAccess({
      sub: 'u1',
      sid: 's1',
      role: 'delegate',
      ttlSeconds: 60,
    });
    expect(payload.typ).toBe('access');
    const verified = svc.verify(token, 'access');
    expect(verified).not.toBeNull();
    expect(verified?.sub).toBe('u1');
  });

  it('rejects expired tokens', () => {
    const { token } = svc.issueAccess({
      sub: 'u1',
      sid: 's1',
      role: 'delegate',
      ttlSeconds: -1,
    });
    expect(svc.verify(token, 'access')).toBeNull();
  });

  it('rejects type mismatch (refresh used as access)', () => {
    const { token } = svc.issueRefresh({
      sub: 'u1',
      sid: 's1',
      role: 'delegate',
      ttlSeconds: 60,
    });
    expect(svc.verify(token, 'access')).toBeNull();
  });

  it('rejects tampered signatures', () => {
    const { token } = svc.issueAccess({
      sub: 'u1',
      sid: 's1',
      role: 'delegate',
      ttlSeconds: 60,
    });
    const tampered = token.slice(0, -2) + 'XX';
    expect(svc.verify(tampered, 'access')).toBeNull();
  });

  it('tokenHash is stable and non-reversible', () => {
    const { token } = svc.issueAccess({
      sub: 'u1',
      sid: 's1',
      role: 'delegate',
      ttlSeconds: 60,
    });
    expect(TokenService.tokenHash(token)).toBe(TokenService.tokenHash(token));
    expect(TokenService.tokenHash(token)).not.toContain(token);
  });
});

describe('voting crypto', () => {
  it('signs and verifies a vote', () => {
    const kp = generateEd25519KeyPair();
    const params = {
      voteId: '11111111-1111-1111-1111-111111111111',
      delegateId: '22222222-2222-2222-2222-222222222222',
      choice: 'for' as const,
      clientCastId: '33333333-3333-3333-3333-333333333333',
    };
    const sig = signVote(params, kp.privateKeyB64);
    expect(verifyVoteSignature(params, sig, kp.publicKeyB64)).toBe(true);
  });

  it('rejects a vote signature for a different choice', () => {
    const kp = generateEd25519KeyPair();
    const params = {
      voteId: '11111111-1111-1111-1111-111111111111',
      delegateId: '22222222-2222-2222-2222-222222222222',
      choice: 'for' as const,
      clientCastId: '33333333-3333-3333-3333-333333333333',
    };
    const sig = signVote(params, kp.privateKeyB64);
    expect(
      verifyVoteSignature({ ...params, choice: 'against' }, sig, kp.publicKeyB64),
    ).toBe(false);
  });

  it('rejects a vote signature verified with the wrong public key', () => {
    const kp = generateEd25519KeyPair();
    const other = generateEd25519KeyPair();
    const params = {
      voteId: '11111111-1111-1111-1111-111111111111',
      delegateId: '22222222-2222-2222-2222-222222222222',
      choice: 'for' as const,
      clientCastId: '33333333-3333-3333-3333-333333333333',
    };
    const sig = signVote(params, kp.privateKeyB64);
    expect(verifyVoteSignature(params, sig, other.publicKeyB64)).toBe(false);
  });

  it('server signs and anyone verifies a receipt', () => {
    const server = generateEd25519KeyPair();
    const payload: ReceiptPayload = {
      voteId: '11111111-1111-1111-1111-111111111111',
      delegateId: '22222222-2222-2222-2222-222222222222',
      choice: 'for',
      submittedAt: 1_700_000_000_000,
      recordedHash: sha256Hex('record'),
    };
    const receipt = signReceipt(payload, server.privateKeyB64);
    const verified = verifyReceipt(receipt.token, server.publicKeyB64);
    expect(verified).not.toBeNull();
    expect(verified?.choice).toBe('for');
    expect(verified?.voteId).toBe(payload.voteId);
  });

  it('rejects a tampered receipt', () => {
    const server = generateEd25519KeyPair();
    const payload: ReceiptPayload = {
      voteId: '11111111-1111-1111-1111-111111111111',
      delegateId: '22222222-2222-2222-2222-222222222222',
      choice: 'for',
      submittedAt: 1_700_000_000_000,
      recordedHash: sha256Hex('record'),
    };
    const receipt = signReceipt(payload, server.privateKeyB64);
    const tampered = receipt.token.slice(0, -2) + 'ZZ';
    expect(verifyReceipt(tampered, server.publicKeyB64)).toBeNull();
  });
});

describe('constant-time compare', () => {
  it('matches equal buffers and rejects unequal', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false);
    expect(constantTimeEqual('abc', 'ab')).toBe(false);
  });
});
