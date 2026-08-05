/**
 * @mun/server — committee & break REST routes
 *
 * Admin: committee CRUD, delegate assignment.
 * Chair: roll call, enable/disable, force-logout, pause/resume, break scheduling.
 */

import type { FastifyInstance } from 'fastify';
import { ProtocolError, AttendanceSchema, type Attendance as AttendanceType } from '@mun/protocol';
import { authPreHandler, requireRole, requireCommitteeChair } from '../auth/context.js';
import * as committee from './service.js';
import * as breaks from './breaks.js';

export async function registerCommitteeRoutes(app: FastifyInstance): Promise<void> {
  // ─── Admin: committee CRUD ──────────────────────────────────────────────────
  app.post(
    '/admin/committee',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (request, reply) => {
      const body = request.body as {
        name?: string;
        topic?: string;
        description?: string;
        chairUserId?: string | null;
        viceUserId?: string | null;
      };
      if (!body.name || !body.topic) {
        throw new ProtocolError('VALIDATION_ERROR', 'name and topic required');
      }
      const c = await committee.createCommittee({
        name: body.name,
        topic: body.topic,
        description: body.description ?? '',
        chairUserId: body.chairUserId ?? null,
        viceUserId: body.viceUserId ?? null,
      });
      return reply.send({ committee: c });
    },
  );

  app.put(
    '/admin/committee/:committeeId',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const body = request.body as Record<string, unknown>;
      const c = await committee.updateCommittee(committeeId, {
        name: body.name as string | undefined,
        topic: body.topic as string | undefined,
        description: body.description as string | undefined,
        chairUserId: body.chairUserId as string | null | undefined,
        viceUserId: body.viceUserId as string | null | undefined,
      });
      return reply.send({ committee: c });
    },
  );

  app.get(
    '/admin/committees',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (_request, reply) => {
      const committees = await committee.listCommittees();
      return reply.send({ committees });
    },
  );

  app.post(
    '/admin/committee/:committeeId/delegate',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const { userId, country } = request.body as { userId?: string; country?: string };
      if (!userId || !country) {
        throw new ProtocolError('VALIDATION_ERROR', 'userId and country required');
      }
      const d = await committee.addDelegate({ userId, committeeId, country });
      return reply.send({ delegate: d });
    },
  );

  // ─── Admin: manage country delegations (delegates join these, no passwords) ─
  app.post(
    '/admin/committee/:committeeId/delegation',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const { country } = request.body as { country?: string };
      if (!country) throw new ProtocolError('VALIDATION_ERROR', 'country required');
      const d = await committee.addDelegation(committeeId, country);
      return reply.send({ delegate: d });
    },
  );

  app.delete(
    '/admin/committee/:committeeId/delegation/:delegateId',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (request, reply) => {
      const { delegateId } = request.params as { delegateId: string };
      await committee.removeDelegation(delegateId);
      return reply.send({ ok: true });
    },
  );

  // ─── Public: committees + country slots + taken status (for delegate join) ──
  app.get('/delegate/join-options', async (_request, reply) => {
    const options = await committee.listJoinOptions();
    return reply.send({ options });
  });

  // ─── Committee state (chair/admin/delegate) ─────────────────────────────────
  app.get(
    '/committee/:committeeId',
    { preHandler: [authPreHandler] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const user = request.user!;
      // Delegates may only view their own committee.
      if (user.role === 'delegate' && user.committeeId !== committeeId) {
        throw new ProtocolError('AUTH_FORBIDDEN', 'Not a member of this committee');
      }
      const state = await committee.getCommitteeState(committeeId);
      return reply.send(state);
    },
  );

  // ─── Chair: roll call / enable / disable / force-logout ─────────────────────
  app.post(
    '/committee/:committeeId/delegate/:delegateId/attendance',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { delegateId } = request.params as { delegateId: string };
      const { attendance } = request.body as { attendance?: string };
      const parsed = AttendanceSchema.safeParse(attendance);
      if (!parsed.success) {
        throw new ProtocolError('VALIDATION_ERROR', 'Invalid attendance');
      }
      const d = await committee.setAttendance(delegateId, parsed.data as AttendanceType);
      return reply.send({ delegate: d });
    },
  );

  app.post(
    '/committee/:committeeId/delegate/:delegateId/enable',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { delegateId } = request.params as { delegateId: string };
      const d = await committee.setEnabled(delegateId, true, request.user!.userId);
      return reply.send({ delegate: d });
    },
  );

  app.post(
    '/committee/:committeeId/delegate/:delegateId/disable',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { delegateId } = request.params as { delegateId: string };
      const { reason, comment } = (request.body as { reason?: string; comment?: string }) ?? {};
      const d = await committee.setEnabled(delegateId, false, request.user!.userId, reason ?? comment ?? null);
      return reply.send({ delegate: d });
    },
  );

  app.post(
    '/committee/:committeeId/delegate/:delegateId/force-logout',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { delegateId } = request.params as { delegateId: string };
      await committee.forceLogoutDelegate(delegateId, request.user!.userId);
      return reply.send({ ok: true });
    },
  );

  // ─── Chair: pause / resume ──────────────────────────────────────────────────
  app.post(
    '/committee/:committeeId/pause',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const c = await committee.pauseCommittee(committeeId, request.user!.userId);
      return reply.send({ committee: c });
    },
  );

  app.post(
    '/committee/:committeeId/resume',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const c = await committee.resumeCommittee(committeeId, request.user!.userId);
      return reply.send({ committee: c });
    },
  );

  // ─── Breaks ─────────────────────────────────────────────────────────────────
  app.get(
    '/committee/:committeeId/breaks',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const list = await breaks.listBreaks(committeeId);
      return reply.send({ breaks: list });
    },
  );

  app.post(
    '/committee/:committeeId/breaks',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const { label, startAt, endAt } = request.body as {
        label?: string;
        startAt?: number;
        endAt?: number;
      };
      if (!label || !startAt || !endAt) {
        throw new ProtocolError('VALIDATION_ERROR', 'label, startAt, endAt required');
      }
      const b = await breaks.scheduleBreak({ committeeId, label, startAt, endAt });
      return reply.send({ break: b });
    },
  );

  app.delete(
    '/committee/:committeeId/breaks/:breakId',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { breakId } = request.params as { breakId: string };
      await breaks.cancelBreak(breakId);
      return reply.send({ ok: true });
    },
  );
}
