/**
 * @mun/server — monitoring event ingest
 *
 * The heart of Priority 1. Receives event-driven monitoring records from
 * delegates (only metadata — see @mun/protocol/events.ts). Guarantees:
 *  - Idempotency: (delegate_id, client_event_id) unique → duplicates after
 *    reconnect/retry are stored once.
 *  - Rate limiting: per-delegate token bucket.
 *  - Warning generation: ai_detected / unexpected_app events create durable
 *    Warning rows, notify the chair in real time, and are audited.
 *  - Presence: each event refreshes the delegate's live status (current app,
 *    away/flagged) broadcast to chairs.
 *  - Data minimisation: titles are only present when titleScope is 'matched'
 *    or 'self'; we never store more than the client sent.
 */

import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { RateLimiter } from '../util/ratelimit.js';
import { presence } from '../realtime/presence.js';
import { broker } from '../realtime/broker.js';
import { audit } from '../audit/service.js';
import { envelope, type MonitoringEventWire, type MonitoringEventBroadcast } from '@mun/protocol';
import { randomUuid, sha256Hex } from '@mun/crypto';

// Per-delegate rate limit: configured events/minute.
const limiters = new Map<string, RateLimiter>();
function limiterFor(delegateId: string): RateLimiter {
  let l = limiters.get(delegateId);
  if (!l) {
    l = new RateLimiter(config.monitorMaxEventsPerMinute, config.monitorMaxEventsPerMinute / 60);
    limiters.set(delegateId, l);
  }
  return l;
}

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  rateLimited: boolean;
  serverId: string | null;
}

export async function ingestEvent(
  event: MonitoringEventWire,
  ctx: { delegateId: string; committeeId: string; displayName: string; country: string },
): Promise<IngestResult> {
  // Ensure the event is for the authenticated delegate (defense in depth).
  if (event.delegateId !== ctx.delegateId) {
    return { accepted: false, duplicate: false, rateLimited: false, serverId: null };
  }

  if (!limiterFor(ctx.delegateId).consume(ctx.delegateId)) {
    return { accepted: false, duplicate: false, rateLimited: true, serverId: null };
  }

  const serverTs = Date.now();
  const serverId = randomUuid();

  // Idempotent insert.
  const inserted = await pool.query(
    `INSERT INTO monitoring_events
      (id, client_event_id, delegate_id, committee_id, type, server_ts, client_ts,
       app_name, title, title_scope, matched_rule_id, matched_rule_name, severity,
       duration_ms, from_app_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (delegate_id, client_event_id) DO NOTHING
     RETURNING id`,
    [
      serverId,
      event.clientEventId,
      event.delegateId,
      event.committeeId,
      event.type,
      serverTs,
      event.clientTs,
      event.appName,
      event.title,
      event.titleScope,
      event.matchedRuleId,
      event.matchedRuleName,
      event.severity,
      event.durationMs,
      event.fromAppName,
    ],
  );

  if (inserted.rows.length === 0) {
    // Duplicate — already stored. Acknowledge as duplicate (idempotent).
    return { accepted: true, duplicate: true, rateLimited: false, serverId: null };
  }

  // Update presence from the event.
  const away = event.type === 'away' || event.type === 'idle';
  const flagged = event.type === 'ai_detected' || event.type === 'unexpected_app';
  presence.update(ctx.delegateId, {
    currentAppName: event.appName,
    away,
    flagged,
    lastHeartbeatAt: serverTs,
  });

  // Broadcast the event to chairs/admins.
  const broadcast: MonitoringEventBroadcast = {
    id: serverId,
    delegateId: ctx.delegateId,
    committeeId: ctx.committeeId,
    delegateDisplayName: ctx.displayName,
    country: ctx.country,
    type: event.type,
    serverTs,
    clientTs: event.clientTs,
    appName: event.appName,
    title: event.title,
    titleScope: event.titleScope,
    matchedRuleId: event.matchedRuleId,
    matchedRuleName: event.matchedRuleName,
    severity: event.severity,
    durationMs: event.durationMs,
    fromAppName: event.fromAppName,
  };
  broker.broadcastCommittee(ctx.committeeId, envelope('monitor_broadcast', broadcast));

  // Generate a warning for integrity-relevant events.
  if (event.type === 'ai_detected' || event.type === 'unexpected_app') {
    await createWarning(event, ctx, serverTs);
    await audit({
      actor: ctx.delegateId,
      action: 'monitor_event',
      subject: serverId,
      detail: `${event.type}: ${event.matchedRuleName ?? event.appName ?? 'unknown'} (${ctx.displayName})`,
    });
  } else if (event.type === 'away') {
    // Audit away events for the record (no separate warning row to avoid noise).
    await audit({
      actor: ctx.delegateId,
      action: 'monitor_event',
      subject: serverId,
      detail: `away ${event.durationMs ? formatDuration(event.durationMs) : ''} (${ctx.displayName})`,
    });
  }

  return { accepted: true, duplicate: false, rateLimited: false, serverId };
}

async function createWarning(
  event: MonitoringEventWire,
  ctx: { delegateId: string; committeeId: string; displayName: string; country: string },
  timestamp: number,
): Promise<void> {
  const warningId = randomUuid();
  const type = event.type === 'ai_detected' ? 'ai_detected' : 'unexpected_app';
  const message =
    event.type === 'ai_detected'
      ? `AI assistant detected: ${event.matchedRuleName ?? 'unknown'} in ${event.appName ?? 'an application'}`
      : `Unexpected application focused: ${event.appName ?? 'unknown'}`;
  await pool.query(
    `INSERT INTO warnings
      (id, committee_id, delegate_id, type, severity, message, rule_id, app_name, timestamp)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      warningId,
      ctx.committeeId,
      ctx.delegateId,
      type,
      event.severity,
      message,
      event.matchedRuleId,
      event.appName,
      timestamp,
    ],
  );
  broker.broadcastCommittee(
    ctx.committeeId,
    envelope('warning', {
      warning: {
        id: warningId,
        committeeId: ctx.committeeId,
        delegateId: ctx.delegateId,
        type,
        severity: event.severity,
        message,
        ruleId: event.matchedRuleId,
        appName: event.appName,
        timestamp,
        acknowledged: false,
        acknowledgedBy: null,
        acknowledgedAt: null,
      },
    }),
  );
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m${rs}s`;
}

/** Compute a recorded hash for an event (used in audit anchors / exports). */
export function eventRecordedHash(event: MonitoringEventWire, serverId: string): string {
  return sha256Hex(
    JSON.stringify({
      id: serverId,
      delegateId: event.delegateId,
      type: event.type,
      clientTs: event.clientTs,
      clientEventId: event.clientEventId,
    }),
  );
}
