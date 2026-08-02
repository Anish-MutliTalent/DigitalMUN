/**
 * @mun/crypto — session tokens (HMAC-SHA256 signed)
 *
 * Two token types:
 *  - access  : short-lived (minutes), carried on every REST call and presented
 *              once on WebSocket `hello`. Stateless to verify, revocable via a
 *              stored `tokenHash` denylist + session record.
 *  - refresh : long-lived (days), used only to mint new access tokens. Bound to
 *              a session id and rotated on use.
 *
 * Format: base64url(payloadJson) + '.' + base64url(hmacSig)
 * where hmacSig = HMAC-SHA256(secret, payloadJson). This mirrors JWT's
 * compactness without pulling in a JWT dependency or allowing algorithm
 * confusion — the only valid algorithm is HMAC-SHA256 with our secret.
 */

import { createHmac, randomBytes } from 'node:crypto';
import { base64url, base64urlDecode, constantTimeEqual, sha256Hex } from './util.js';
import type { Role } from '@mun/protocol';

export type TokenType = 'access' | 'refresh';

export interface TokenPayload {
  typ: TokenType;
  /** Subject (user id). */
  sub: string;
  /** Session id this token belongs to. */
  sid: string;
  /** Role at issue time. */
  role: Role;
  /** Issued-at (ms). */
  iat: number;
  /** Expiry (ms). */
  exp: number;
  /** Unique token id (replay protection / rotation tracking). */
  jti: string;
}

export interface IssuedToken {
  token: string;
  payload: TokenPayload;
}

export class TokenService {
  private readonly accessSecret: Buffer;
  private readonly refreshSecret: Buffer;

  constructor(accessSecret: string, refreshSecret: string) {
    if (accessSecret.length < 32)
      throw new Error('Access secret must be at least 32 bytes');
    if (refreshSecret.length < 32)
      throw new Error('Refresh secret must be at least 32 bytes');
    this.accessSecret = Buffer.from(accessSecret, 'utf8');
    this.refreshSecret = Buffer.from(refreshSecret, 'utf8');
  }

  /** Issue an access token. */
  issueAccess(
    params: { sub: string; sid: string; role: Role; ttlSeconds: number; jti?: string },
  ): IssuedToken {
    const now = Date.now();
    const payload: TokenPayload = {
      typ: 'access',
      sub: params.sub,
      sid: params.sid,
      role: params.role,
      iat: now,
      exp: now + params.ttlSeconds * 1000,
      jti: params.jti ?? randomJti(),
    };
    return { token: this.encode(payload, 'access'), payload };
  }

  /** Issue a refresh token. */
  issueRefresh(
    params: { sub: string; sid: string; role: Role; ttlSeconds: number; jti?: string },
  ): IssuedToken {
    const now = Date.now();
    const payload: TokenPayload = {
      typ: 'refresh',
      sub: params.sub,
      sid: params.sid,
      role: params.role,
      iat: now,
      exp: now + params.ttlSeconds * 1000,
      jti: params.jti ?? randomJti(),
    };
    return { token: this.encode(payload, 'refresh'), payload };
  }

  /**
   * Verify a token's signature and expiry. Does NOT check revocation (the
   * caller must check the session/token denylist). Returns the payload or null.
   */
  verify(token: string, expectedTyp?: TokenType): TokenPayload | null {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payloadB64, sigB64] = parts;
    let payload: TokenPayload;
    try {
      payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'));
    } catch {
      return null;
    }
    if (expectedTyp && payload.typ !== expectedTyp) return null;
    const secret = payload.typ === 'access' ? this.accessSecret : this.refreshSecret;
    const expectedSig = this.sign(payloadB64, secret);
    if (!constantTimeEqual(expectedSig, sigB64)) return null;
    if (payload.exp <= Date.now()) return null;
    return payload;
  }

  /** SHA-256 hash of a token for storage/lookup (never store raw tokens). */
  static tokenHash(token: string): string {
    return sha256Hex(token);
  }

  private encode(payload: TokenPayload, typ: TokenType): string {
    const secret = typ === 'access' ? this.accessSecret : this.refreshSecret;
    const payloadJson = JSON.stringify(payload);
    const payloadB64 = base64url(payloadJson);
    const sig = this.sign(payloadB64, secret);
    return `${payloadB64}.${sig}`;
  }

  private sign(payloadB64: string, secret: Buffer): string {
    const sig = createHmac('sha256', secret).update(payloadB64).digest();
    return base64url(sig);
  }
}

function randomJti(): string {
  // 16 random bytes hex — CSPRNG, sufficient uniqueness for replay tracking.
  return randomBytes(16).toString('hex');
}
