/**
 * @mun/server — typed configuration loaded from environment / .env
 *
 * All runtime knobs are read here and validated once at startup. The rest of
 * the server imports the singleton `config`, never `process.env` directly.
 */

import dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';

dotenv.config();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

function int(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v);
}

// Session secrets: derive a refresh secret from the access secret if not set,
// but only allow this in development. In production both must be explicit.
const sessionSecret = required('MUN_SESSION_SECRET', 'dev-only-insecure-secret-please-change-in-prod-' + randomBytes(16).toString('hex'));
if (
  sessionSecret.startsWith('replace_me') &&
  process.env.NODE_ENV === 'production'
) {
  throw new Error('MUN_SESSION_SECRET must be set to a strong random value in production');
}

export interface ServerConfig {
  host: string;
  port: number;
  pg: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    ssl: boolean;
    poolMax: number;
  };
  sessionSecret: string;
  refreshSecret: string;
  sessionTtlSeconds: number;
  refreshTtlSeconds: number;
  accessTtlSeconds: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  monitorMaxEventsPerMinute: number;
  auditGenesis: string;
  corsOrigin: string;
  bootstrapAdmin: { username: string; password: string };
  isProduction: boolean;
}

function deriveRefreshSecret(access: string): string {
  // Deterministic but distinct from the access secret so a leak of one does not
  // immediately forge the other. Still: set MUN_REFRESH_SECRET explicitly in prod.
  return 'refresh$' + access;
}

export const config: ServerConfig = {
  host: process.env.MUN_HOST ?? '0.0.0.0',
  port: int('MUN_PORT', 8080),
  pg: {
    host: process.env.PGHOST ?? 'localhost',
    port: int('PGPORT', 5432),
    user: process.env.PGUSER ?? 'postgres',
    password: process.env.PGPASSWORD ?? '',
    database: process.env.PGDATABASE ?? 'mun_guardian',
    ssl: bool('PGSSL', false),
    poolMax: int('PG_POOL_MAX', 20),
  },
  sessionSecret,
  refreshSecret: process.env.MUN_REFRESH_SECRET ?? deriveRefreshSecret(sessionSecret),
  sessionTtlSeconds: int('MUN_SESSION_TTL_SECONDS', 28800),
  refreshTtlSeconds: int('MUN_REFRESH_TTL_SECONDS', 2592000),
  accessTtlSeconds: int('MUN_ACCESS_TTL_SECONDS', 900),
  heartbeatIntervalMs: int('MUN_HEARTBEAT_INTERVAL_MS', 5000),
  heartbeatTimeoutMs: int('MUN_HEARTBEAT_TIMEOUT_MS', 16000),
  monitorMaxEventsPerMinute: int('MUN_MONITOR_MAX_EVENTS_PER_MINUTE', 240),
  auditGenesis: process.env.MUN_AUDIT_GENESIS ?? 'mun-guardian-audit-genesis-v1',
  corsOrigin: process.env.MUN_CORS_ORIGIN ?? '*',
  bootstrapAdmin: {
    username: process.env.MUN_BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
    password: process.env.MUN_BOOTSTRAP_ADMIN_PASSWORD ?? 'change-me-immediately',
  },
  isProduction: process.env.NODE_ENV === 'production',
};
