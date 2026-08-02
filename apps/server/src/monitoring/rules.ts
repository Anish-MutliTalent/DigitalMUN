/**
 * @mun/server — AI-detection rule cache
 *
 * Rules are loaded once into memory and reloaded when an admin edits them
 * (admin routes call `reloadRules()` and broadcast `rules_updated` to clients).
 * The cache avoids a DB hit on every event ingest and every login sync.
 */

import { pool } from '../db/pool.js';
import { broker } from '../realtime/broker.js';
import { envelope, type AiDetectionRule } from '@mun/protocol';

let cache: AiDetectionRule[] = [];
let loaded = false;

export async function loadRules(): Promise<AiDetectionRule[]> {
  const { rows } = await pool.query(
    'SELECT * FROM ai_detection_rules ORDER BY created_at ASC',
  );
  cache = rows.map((r) => ({
    id: r.id,
    name: r.name,
    platform: r.platform,
    matchField: r.match_field,
    patternType: r.pattern_type,
    pattern: r.pattern,
    enabled: r.enabled,
    severity: r.severity,
    category: r.category,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  }));
  loaded = true;
  return cache;
}

export function getCachedRules(): AiDetectionRule[] {
  return loaded ? cache : [];
}

/** Reload rules and push the full set to every connected client. */
export async function reloadAndBroadcastRules(): Promise<AiDetectionRule[]> {
  const rules = await loadRules();
  // Rules are global → push to every connected client (delegates + chairs + admins).
  broker.broadcastAllCommitteesAll(envelope('rules_updated', { rules }));
  return rules;
}
