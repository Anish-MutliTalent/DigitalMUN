/**
 * @mun/desktop — server REST client (auth + key registration)
 *
 * Thin fetch wrapper for the REST endpoints. The realtime path uses a separate
 * WebSocket client. All responses are validated by the server; here we just
 * surface success/failure to the IPC layer.
 */

import type { LoginResponse } from '@mun/protocol';

export interface LoginOk {
  ok: true;
  response: LoginResponse;
}
export interface LoginRelogin {
  ok: false;
  reloginRequired: true;
  requestId: string;
  message: string;
}
export interface LoginFail {
  ok: false;
  error: string;
}
export type LoginResult = LoginOk | LoginRelogin | LoginFail;

export class AuthClient {
  constructor(private serverUrl: string) {}

  setServerUrl(url: string): void {
    this.serverUrl = url;
  }

  async login(
    username: string,
    password: string,
    deviceId: string,
    platform: 'windows' | 'macos',
  ): Promise<LoginResult> {
    try {
      const res = await fetch(`${this.serverUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, platform, clientVersion: '1.0.0', deviceId }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status === 200 && typeof body.accessToken === 'string') {
        return { ok: true, response: body as unknown as LoginResponse };
      }
      if (res.status === 409 && body.code === 'AUTH_RELOGIN_REQUIRED') {
        return {
          ok: false,
          reloginRequired: true,
          requestId: String(body.requestId ?? ''),
          message: String(body.message ?? 'Re-login required'),
        };
      }
      return { ok: false, error: String(body.message ?? 'Login failed') };
    } catch (err) {
      return { ok: false, error: `Network error: ${(err as Error).message}` };
    }
  }

  async refresh(
    refreshToken: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number } | null> {
    try {
      const res = await fetch(`${this.serverUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
      if (!res.ok) return null;
      return (await res.json()) as { accessToken: string; refreshToken: string; expiresIn: number };
    } catch {
      return null;
    }
  }

  async getJoinOptions(): Promise<
    Array<{ committeeId: string; committeeName: string; countries: Array<{ country: string; delegateId: string; taken: boolean }> }>
  > {
    try {
      const res = await fetch(`${this.serverUrl}/delegate/join-options`);
      if (!res.ok) return [];
      const body = (await res.json()) as { options?: Array<{ committeeId: string; committeeName: string; countries: Array<{ country: string; delegateId: string; taken: boolean }> }> };
      return body.options ?? [];
    } catch {
      return [];
    }
  }

  async join(
    committeeId: string,
    country: string,
    deviceId: string,
    platform: 'windows' | 'macos',
  ): Promise<LoginResult> {
    try {
      const res = await fetch(`${this.serverUrl}/auth/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ committeeId, country, platform, clientVersion: '1.0.0', deviceId }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (res.status === 200 && typeof body.accessToken === 'string') {
        return { ok: true, response: body as unknown as LoginResponse };
      }
      if (res.status === 409 && body.code === 'AUTH_RELOGIN_REQUIRED') {
        return {
          ok: false,
          reloginRequired: true,
          requestId: String(body.requestId ?? ''),
          message: String(body.message ?? 'Re-login required'),
        };
      }
      return { ok: false, error: String(body.message ?? 'Join failed') };
    } catch (err) {
      return { ok: false, error: `Network error: ${(err as Error).message}` };
    }
  }

  async logout(accessToken: string): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/auth/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      /* best effort */
    }
  }

  async registerKey(accessToken: string, publicKey: string): Promise<boolean> {
    try {
      const res = await fetch(`${this.serverUrl}/delegate/register-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ publicKey }),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async getServerPublicKey(): Promise<string | null> {
    try {
      const res = await fetch(`${this.serverUrl}/server-key`);
      if (!res.ok) return null;
      const body = (await res.json()) as { publicKey?: string };
      return body.publicKey ?? null;
    } catch {
      return null;
    }
  }

  async cancelRelogin(accessToken: string, requestId: string): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/auth/relogin/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ requestId }),
      });
    } catch {
      /* best effort */
    }
  }
}
