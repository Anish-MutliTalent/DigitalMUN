/**
 * @mun/desktop — encrypted persistent store
 *
 * Holds session tokens, the device id, the delegate's Ed25519 private key, and
 * the last-synced rules + committees so the app can auto-reconnect after a
 * restart/crash. The whole blob is encrypted with Electron `safeStorage`, which
 * uses the OS keychain (DPAPI on Windows, Keychain on macOS) — so secrets are
 * never written to disk in plaintext and are bound to the OS user account.
 */

import { app, safeStorage } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PersistedState } from '@shared/ipc';
import { DEFAULT_SERVER_URL } from '../config.js';

const STORE_FILE = () => join(app.getPath('userData'), 'mun-session.enc');

const DEFAULT_STATE: PersistedState = {
  user: null,
  delegate: null,
  committees: [],
  accessToken: null,
  refreshToken: null,
  deviceId: randomDeviceId(),
  rules: [],
  serverUrl: DEFAULT_SERVER_URL,
};

function randomDeviceId(): string {
  return crypto.randomUUID();
}

class EncryptedStore {
  private state: PersistedState = { ...DEFAULT_STATE };

  load(): PersistedState {
    const file = STORE_FILE();
    if (!existsSync(file)) {
      this.state = { ...DEFAULT_STATE };
      return this.state;
    }
    try {
      const buf = readFileSync(file);
      if (!safeStorage.isEncryptionAvailable()) {
        // Fallback: refuse to load plaintext secrets (better to require re-login).
        this.state = { ...DEFAULT_STATE, accessToken: null, refreshToken: null };
        return this.state;
      }
      const json = safeStorage.decryptString(buf);
      const parsed = JSON.parse(json);
      this.state = { ...DEFAULT_STATE, ...parsed, serverUrl: DEFAULT_SERVER_URL };
      return this.state;
    } catch {
      this.state = { ...DEFAULT_STATE };
      return this.state;
    }
  }

  save(state: PersistedState): void {
    this.state = state;
    const file = STORE_FILE();
    mkdirSync(join(app.getPath('userData')), { recursive: true });
    if (safeStorage.isEncryptionAvailable()) {
      const buf = safeStorage.encryptString(JSON.stringify(state));
      writeFileSync(file, buf);
    } else {
      // Without OS encryption, persist only non-secret fields (deviceId,
      // serverUrl, rules, committees). user/delegate/tokens are NOT persisted,
      // so the user must re-authenticate on every launch (no stuck offline state).
      const safe: PersistedState = {
        ...state,
        user: null,
        delegate: null,
        accessToken: null,
        refreshToken: null,
      };
      writeFileSync(file, JSON.stringify(safe), 'utf8');
    }
  }

  get(): PersistedState {
    return this.state;
  }

  update(patch: Partial<PersistedState>): PersistedState {
    // Invariant: a user can never be persisted without valid tokens. If any
    // path clears the access/refresh token, also clear the user + delegate so
    // the app returns to the login screen instead of a stuck offline state.
    if (patch.accessToken === null || patch.refreshToken === null) {
      patch = { ...patch, user: null, delegate: null };
    }
    this.state = { ...this.state, ...patch };
    this.save(this.state);
    return this.state;
  }

  clear(): void {
    this.state = { ...DEFAULT_STATE, deviceId: this.state.deviceId, serverUrl: this.state.serverUrl };
    this.save(this.state);
  }
}

export const store = new EncryptedStore();
