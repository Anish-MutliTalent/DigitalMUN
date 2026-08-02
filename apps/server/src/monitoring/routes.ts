/**
 * @mun/server — monitoring REST routes
 *
 * GET  /committee/:cid/events          — monitoring event history
 * GET  /committee/:cid/warnings        — warnings (optional ?unacknowledgedOnly=1)
 * POST /committee/:cid/warnings/:wid/ack — acknowledge a warning
 * GET  /committee/:cid/export          — committee log export (JSON)
 * GET  /admin/rules                    — list AI-detection rules
 * PUT  /admin/rules/:rid               — update a rule (admin)
 * POST /admin/rules                    — create a rule (admin)
 */

import type { FastifyInstance } from 'fastify';
import { ProtocolError, safeParse, formatZodIssues, AiDetectionRuleSchema } from '@mun/protocol';
import { authPreHandler, requireCommitteeChair, requireRole } from '../auth/context.js';
import * as monService from './service.js';
import { pool } from '../db/pool.js';
import { audit } from '../audit/service.js';
import { reloadAndBroadcastRules } from './rules.js';
import { broker } from '../realtime/broker.js';
import { envelope } from '@mun/protocol';
import { randomUuid } from '@mun/crypto';

export async function registerMonitoringRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/committee/:committeeId/events',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const q = request.query as Record<string, string | undefined>;
      const events = await monService.listEvents(committeeId, {
        limit: q.limit ? Number(q.limit) : 200,
        offset: q.offset ? Number(q.offset) : 0,
        delegateId: q.delegateId,
        fromTs: q.fromTs ? Number(q.fromTs) : undefined,
        toTs: q.toTs ? Number(q.toTs) : undefined,
      });
      return reply.send({ events });
    },
  );

  app.get(
    '/committee/:committeeId/warnings',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const q = request.query as Record<string, string | undefined>;
      const warnings = await monService.listWarnings(committeeId, {
        limit: q.limit ? Number(q.limit) : 200,
        offset: q.offset ? Number(q.offset) : 0,
        unacknowledgedOnly: q.unacknowledgedOnly === '1',
      });
      return reply.send({ warnings });
    },
  );

  app.post(
    '/committee/:committeeId/warnings/:warningId/ack',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId, warningId } = request.params as {
        committeeId: string;
        warningId: string;
      };
      const warning = await monService.acknowledgeWarning(warningId, request.user!.userId);
      broker.broadcastCommittee(
        committeeId,
        envelope('warning_acked', {
          warningId,
          by: request.user!.userId,
          at: warning.acknowledgedAt ?? Date.now(),
        }),
      );
      return reply.send({ warning });
    },
  );

  app.get(
    '/committee/:committeeId/export',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const exportData = await monService.exportCommitteeLog(committeeId);
      await audit({
        actor: request.user!.userId,
        action: 'admin_export',
        subject: committeeId,
        detail: `Committee log exported (${exportData.events.length} events).`,
      });
      reply.header('Content-Type', 'application/json');
      reply.header(
        'Content-Disposition',
        `attachment; filename="committee-${committeeId}-log.json"`,
      );
      return reply.send(exportData);
    },
  );

  // ─── AI-detection rule management (admin) ───────────────────────────────────
  app.get(
    '/admin/rules',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (_request, reply) => {
      const { rows } = await pool.query('SELECT * FROM ai_detection_rules ORDER BY created_at ASC');
      return reply.send({ rules: rows });
    },
  );

  app.post(
    '/admin/rules',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (request, reply) => {
      const parsed = safeParse(AiDetectionRuleSchema.omit({ id: true, createdAt: true, updatedAt: true }), request.body);
      if (!parsed.success) {
        throw new ProtocolError('VALIDATION_ERROR', 'Invalid rule', {
          details: formatZodIssues(parsed.error),
        });
      }
      const id = randomUuid();
      const now = Date.now();
      await pool.query(
        `INSERT INTO ai_detection_rules
          (id, name, platform, match_field, pattern_type, pattern, enabled, severity, category, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
        [
          id,
          parsed.data.name,
          parsed.data.platform,
          parsed.data.matchField,
          parsed.data.patternType,
          parsed.data.pattern,
          parsed.data.enabled,
          parsed.data.severity,
          parsed.data.category,
          now,
        ],
      );
      await audit({
        actor: request.user!.userId,
        action: 'rule_update',
        subject: id,
        detail: `Created rule ${parsed.data.name}.`,
      });
      await reloadAndBroadcastRules();
      return reply.send({ id });
    },
  );

  app.put(
    '/admin/rules/:ruleId',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (request, reply) => {
      const { ruleId } = request.params as { ruleId: string };
      const body = request.body as Record<string, unknown>;
      const allowed = ['name', 'platform', 'match_field', 'matchField', 'pattern_type', 'patternType', 'pattern', 'enabled', 'severity', 'category'];
      const sets: string[] = [];
      const params: unknown[] = [ruleId];
      for (const [k, v] of Object.entries(body)) {
        if (!allowed.includes(k)) continue;
        const col = k === 'matchField' ? 'match_field' : k === 'patternType' ? 'pattern_type' : k;
        params.push(v);
        sets.push(`${col} = $${params.length}`);
      }
      if (sets.length === 0) throw new ProtocolError('VALIDATION_ERROR', 'No valid fields');
      params.push(Date.now());
      sets.push(`updated_at = $${params.length}`);
      await pool.query(
        `UPDATE ai_detection_rules SET ${sets.join(', ')} WHERE id = $1`,
        params,
      );
      await audit({
        actor: request.user!.userId,
        action: 'rule_update',
        subject: ruleId,
        detail: `Updated rule ${ruleId}.`,
      });
      await reloadAndBroadcastRules();
      // Suppress unused import warning for envelope (kept for future broadcasts).
      void envelope;
      return reply.send({ ok: true });
    },
  );
}
