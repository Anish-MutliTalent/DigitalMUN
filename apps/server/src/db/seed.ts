/**
 * @mun/server — database seed (idempotent)
 *
 * Ensures the bootstrap administrator exists and the built-in AI-detection
 * rules are loaded. Safe to run repeatedly: existing rows are left untouched.
 * Optionally creates a demo committee + delegates when SEED_DEMO=1 (for
 * development and load testing).
 */

import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { config } from '../config.js';
import { BUILTIN_AI_RULES } from '@mun/protocol';
import { hashPassword } from '../auth/passwords.js';

async function seedAdmin(): Promise<void> {
  const { rows } = await pool.query('SELECT id FROM users WHERE username = $1', [
    config.bootstrapAdmin.username,
  ]);
  if (rows.length > 0) return;
  const hashStr = await hashPassword(config.bootstrapAdmin.password);
  await pool.query(
    `INSERT INTO users (id, username, role, display_name, password_hash)
     VALUES ($1, $2, 'admin', 'Administrator', $3)`,
    [randomUUID(), config.bootstrapAdmin.username, hashStr],
  );
  // eslint-disable-next-line no-console
  console.log(`[seed] created admin user "${config.bootstrapAdmin.username}"`);
}

async function seedRules(): Promise<void> {
  for (const rule of BUILTIN_AI_RULES) {
    // Skip if a rule with the same name+pattern already exists.
    const { rows } = await pool.query(
      'SELECT id FROM ai_detection_rules WHERE name = $1 AND pattern = $2',
      [rule.name, rule.pattern],
    );
    if (rows.length > 0) continue;
    await pool.query(
      `INSERT INTO ai_detection_rules
        (id, name, platform, match_field, pattern_type, pattern, enabled, severity, category)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        randomUUID(),
        rule.name,
        rule.platform,
        rule.matchField,
        rule.patternType,
        rule.pattern,
        rule.enabled,
        rule.severity,
        rule.category,
      ],
    );
  }
  // eslint-disable-next-line no-console
  console.log('[seed] ensured built-in AI detection rules');
}

async function seedDemo(): Promise<void> {
  if (process.env.SEED_DEMO !== '1') return;
  // Demo committee + chair + delegates for development.
  const { rows: existing } = await pool.query("SELECT id FROM committees WHERE name = 'General Assembly'");
  let committeeId: string;
  if (existing.length > 0) {
    committeeId = existing[0].id;
  } else {
    const ins = await pool.query(
      `INSERT INTO committees (id, name, topic, description, status)
       VALUES ($1, 'General Assembly', 'Measures to regulate AI in armed conflict', 'Demo committee', 'active')
       RETURNING id`,
      [randomUUID()],
    );
    committeeId = ins.rows[0].id;
  }

  // Demo chair
  const { rows: chairRows } = await pool.query("SELECT id FROM users WHERE username = 'chair'");
  let chairId: string;
  if (chairRows.length === 0) {
    const pwHash = await hashPassword('chair');
    const ins = await pool.query(
      `INSERT INTO users (id, username, role, display_name, password_hash)
       VALUES ($1, 'chair', 'chair', 'Demo Chair', $2) RETURNING id`,
      [randomUUID(), pwHash],
    );
    chairId = ins.rows[0].id;
    await pool.query('UPDATE committees SET chair_user_id = $1 WHERE id = $2', [chairId, committeeId]);
  } else {
    chairId = chairRows[0].id;
  }

  // Demo country delegations (delegates join by selecting committee + country —
  // no passwords). Each slot is a passwordless delegate user + a delegates row.
  const countries = ['France', 'Germany', 'Japan', 'Brazil', 'Kenya', 'Canada', 'India', 'Australia'];
  for (const country of countries) {
    const { rows: existingDel } = await pool.query(
      'SELECT id FROM delegates WHERE committee_id = $1 AND country = $2',
      [committeeId, country],
    );
    if (existingDel.length > 0) continue;
    const userId = randomUUID();
    await pool.query(
      `INSERT INTO users (id, username, role, display_name, password_hash)
       VALUES ($1, $2, 'delegate', $3, '')`,
      [userId, `del-${userId}`, country],
    );
    await pool.query(
      `INSERT INTO delegates (id, user_id, committee_id, country, attendance)
       VALUES ($1, $2, $3, $4, 'not_checked_in')`,
      [randomUUID(), userId, committeeId, country],
    );
  }
  // eslint-disable-next-line no-console
  console.log('[seed] demo ready: chair/chair (password); delegates join by selecting General Assembly + their country');
}

export async function runSeed(): Promise<void> {
  await seedAdmin();
  await seedRules();
  await seedDemo();
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  runSeed()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('[seed] done');
      return pool.end();
    })
    .then(() => process.exit(0))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[seed] error', err);
      pool.end().finally(() => process.exit(1));
    });
}
