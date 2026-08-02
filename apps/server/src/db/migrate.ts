/**
 * @mun/server — migration runner
 *
 * Applies numbered SQL files from ./migrations in order, tracking applied
 * migrations in the `_migrations` table. Idempotent: re-running skips already
 * applied migrations. Each migration runs in its own transaction.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

async function listMigrations(): Promise<Array<{ id: string; path: string }>> {
  const files = await readdir(MIGRATIONS_DIR);
  return files
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ id: f.replace(/\.sql$/, ''), path: join(MIGRATIONS_DIR, f) }));
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const migrations = await listMigrations();
  const applied: string[] = [];
  const skipped: string[] = [];

  // Ensure tracking table exists.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         TEXT PRIMARY KEY,
      applied_at BIGINT NOT NULL DEFAULT (cast(extract(epoch from clock_timestamp()) * 1000 as bigint))
    )
  `);

  const { rows } = await pool.query('SELECT id FROM _migrations');
  const done = new Set(rows.map((r) => r.id as string));

  for (const m of migrations) {
    if (done.has(m.id)) {
      skipped.push(m.id);
      continue;
    }
    const sql = await readFile(m.path, 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (id) VALUES ($1)', [m.id]);
      await client.query('COMMIT');
      applied.push(m.id);
      // eslint-disable-next-line no-console
      console.log(`[migrate] applied ${m.id}`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`Migration ${m.id} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return { applied, skipped };
}

// Run directly: `pnpm migrate`
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runMigrations()
    .then(({ applied, skipped }) => {
      // eslint-disable-next-line no-console
      console.log(`[migrate] done — applied: ${applied.length}, skipped: ${skipped.length}`);
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[migrate] error', err);
      pool.end().finally(() => process.exit(1));
    });
}
