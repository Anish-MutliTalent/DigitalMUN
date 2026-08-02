/**
 * @mun/server — PostgreSQL connection pool
 *
 * Uses the pure-JavaScript `pg` driver (no native compilation). A single shared
 * pool is exported; all services borrow clients from it. SSL is opt-in.
 */

import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  host: config.pg.host,
  port: config.pg.port,
  user: config.pg.user,
  password: config.pg.password,
  database: config.pg.database,
  ssl: config.pg.ssl ? { rejectUnauthorized: false } : false,
  max: config.pg.poolMax,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  application_name: 'mun-guardian-server',
});

pool.on('error', (err) => {
  // Logged but not fatal — the pool recreates clients.
  // eslint-disable-next-line no-console
  console.error('[pg pool] idle client error', err);
});

/** Run a function within a transaction. Rolls back on error. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback failure */
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Ping the database; used by the health check. Returns latency in ms. */
export async function pingDb(): Promise<number> {
  const start = Date.now();
  await pool.query('SELECT 1');
  return Date.now() - start;
}
