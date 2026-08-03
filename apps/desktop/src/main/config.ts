/**
 * @mun/desktop — main process configuration
 *
 * The server URL is configurable (Settings) and persisted in the encrypted
 * store. Defaults to a local venue server.
 */

import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const APP_VERSION = readAppVersion();

function readAppVersion(): string {
  try {
    const pkgPath = join(app.getAppPath(), 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      return pkg.version ?? '0.0.0';
    }
  } catch {
    /* ignore */
  }
  return '0.0.0';
}

export const DEFAULT_SERVER_URL = 'https://digitalmun.onrender.com';

/** Monitoring poll interval (ms). Event-driven emission happens on change. */
export const MONITOR_POLL_MS = 400;
/** Idle threshold (ms) before an "away/idle" event is emitted. */
export const IDLE_THRESHOLD_MS = 60_000;
/** Away = foreground is not MUN Guardian for at least this long. */
export const AWAY_THRESHOLD_MS = 5_000;

/** The app's own process names (so the engine recognises itself). */
export const SELF_APP_NAMES = new Set([
  'mun guardian',
  'mun-guardian',
  'safe mun 2026',
  'safe mun 2026.exe',
  'safe mun',
  'safe-mun',
  'safemun',
  'safemun2026',
  'electron',
]);
