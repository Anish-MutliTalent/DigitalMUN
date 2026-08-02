/**
 * @mun/server — admin REST routes
 *
 * GET    /admin/health                 — system health dashboard
 * GET    /admin/users                  — list users
 * POST   /admin/users                  — create a user
 * POST   /admin/users/:userId/force-logout
 * POST   /admin/delegate/:delegateId/reset-key
 * POST   /admin/committee/:cid/emergency-stop
 * POST   /admin/committee/:cid/emergency-resume
 * GET    /admin/sessions               — active sessions
 * GET    /admin/audit                  — audit log export + chain verification
 */

import type { FastifyInstance } from 'fastify';
import { ProtocolError, RoleSchema } from '@mun/protocol';
import { authPreHandler, requireRole } from '../auth/context.js';
import * as admin from './service.js';

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get('/admin/health', { preHandler: [authPreHandler, requireRole('admin')] }, async (_req, reply) => {
    const health = await admin.systemHealth();
    return reply.send(health);
  });

  app.get('/admin/users', { preHandler: [authPreHandler, requireRole('admin')] }, async (_req, reply) => {
    const users = await admin.listUsers();
    return reply.send({ users });
  });

  app.post('/admin/users', { preHandler: [authPreHandler, requireRole('admin')] }, async (req, reply) => {
    const body = req.body as { username?: string; password?: string; role?: string; displayName?: string };
    if (!body.username || !body.password || !body.role || !body.displayName) {
      throw new ProtocolError('VALIDATION_ERROR', 'username, password, role, displayName required');
    }
    const roleParsed = RoleSchema.safeParse(body.role);
    if (!roleParsed.success) throw new ProtocolError('VALIDATION_ERROR', 'Invalid role');
    const user = await admin.createUser({
      username: body.username,
      password: body.password,
      role: roleParsed.data,
      displayName: body.displayName,
    });
    return reply.send({ user });
  });

  app.post(
    '/admin/users/:userId/force-logout',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (req, reply) => {
      const { userId } = req.params as { userId: string };
      await admin.adminForceLogout(userId, req.user!.userId);
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/admin/delegate/:delegateId/reset-key',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (req, reply) => {
      const { delegateId } = req.params as { delegateId: string };
      await admin.resetDelegateVotingKey(delegateId, req.user!.userId);
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/admin/committee/:committeeId/emergency-stop',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (req, reply) => {
      const { committeeId } = req.params as { committeeId: string };
      await admin.emergencyStop(committeeId, req.user!.userId);
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/admin/committee/:committeeId/emergency-resume',
    { preHandler: [authPreHandler, requireRole('admin')] },
    async (req, reply) => {
      const { committeeId } = req.params as { committeeId: string };
      await admin.emergencyResume(committeeId, req.user!.userId);
      return reply.send({ ok: true });
    },
  );

  app.get('/admin/sessions', { preHandler: [authPreHandler, requireRole('admin')] }, async (_req, reply) => {
    const sessions = await admin.listActiveSessions();
    return reply.send({ sessions });
  });

  app.get('/admin/audit', { preHandler: [authPreHandler, requireRole('admin')] }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const result = await admin.exportAuditLog({
      limit: q.limit ? Number(q.limit) : 5000,
      action: q.action,
      fromTs: q.fromTs ? Number(q.fromTs) : undefined,
      toTs: q.toTs ? Number(q.toTs) : undefined,
    });
    reply.header('Content-Type', 'application/json');
    reply.header('Content-Disposition', 'attachment; filename="audit-log.json"');
    return reply.send(result);
  });
}
