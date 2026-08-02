/**
 * @mun/server — auth REST routes
 *
 * POST /auth/login          — authenticate, issue tokens (or require re-login)
 * POST /auth/refresh        — rotate refresh token
 * POST /auth/logout         — revoke current session
 * POST /auth/relogin/cancel — delegate cancels their own pending request
 * GET  /committee/:cid/relogin            — chair lists pending re-login requests
 * POST /committee/:cid/relogin/:rid/approve
 * POST /committee/:cid/relogin/:rid/deny
 */

import type { FastifyInstance } from 'fastify';
import {
  LoginRequestSchema,
  RefreshRequestSchema,
  ProtocolError,
  safeParse,
  formatZodIssues,
} from '@mun/protocol';
import { authPreHandler, requireRole, requireCommitteeChair } from './context.js';
import { randomUuid } from '@mun/crypto';
import * as authService from './service.js';

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // ─── Login ──────────────────────────────────────────────────────────────────
  app.post('/auth/login', async (request, reply) => {
    const parsed = safeParse(LoginRequestSchema, request.body);
    if (!parsed.success) {
      throw new ProtocolError('VALIDATION_ERROR', 'Invalid login request', {
        details: formatZodIssues(parsed.error),
      });
    }
    const ip =
      (request.ip as string) ??
      (request.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      'unknown';

    const result = await authService.login({
      username: parsed.data.username,
      password: parsed.data.password,
      platform: parsed.data.platform ?? 'windows',
      clientVersion: parsed.data.clientVersion ?? '0.0.0',
      deviceId: parsed.data.deviceId,
      ip,
    });

    if ('code' in result) {
      // Re-login required → 409 with the request info.
      return reply.status(409).send({
        code: result.code,
        requestId: result.requestId,
        status: result.status,
        message: result.message,
      });
    }
    return reply.send(result.response);
  });

  // ─── Delegate join (passwordless: committee + country) ──────────────────────
  app.post('/auth/join', async (request, reply) => {
    const body = request.body as {
      committeeId?: string;
      country?: string;
      platform?: string;
      clientVersion?: string;
      deviceId?: string;
    };
    if (!body.committeeId || !body.country) {
      throw new ProtocolError('VALIDATION_ERROR', 'committeeId and country required');
    }
    const platform = body.platform === 'macos' ? 'macos' : 'windows';
    const result = await authService.join({
      committeeId: body.committeeId,
      country: body.country,
      deviceId: body.deviceId ?? randomUuid(),
      platform,
      clientVersion: body.clientVersion ?? '0.0.0',
    });
    if ('code' in result) {
      return reply.status(409).send({
        code: result.code,
        requestId: result.requestId,
        status: result.status,
        message: result.message,
      });
    }
    return reply.send(result.response);
  });

  // ─── Refresh ────────────────────────────────────────────────────────────────
  app.post('/auth/refresh', async (request, reply) => {
    const parsed = safeParse(RefreshRequestSchema, request.body);
    if (!parsed.success) {
      throw new ProtocolError('VALIDATION_ERROR', 'Invalid refresh request', {
        details: formatZodIssues(parsed.error),
      });
    }
    const r = await authService.refresh(parsed.data.refreshToken);
    if (!r) {
      throw new ProtocolError('AUTH_TOKEN_INVALID', 'Invalid or expired refresh token');
    }
    return reply.send(r);
  });

  // ─── Logout ─────────────────────────────────────────────────────────────────
  app.post('/auth/logout', { preHandler: authPreHandler }, async (request, reply) => {
    const user = request.user!;
    await authService.logout(user.userId, user.sessionId);
    return reply.send({ ok: true });
  });

  // ─── Delegate cancels their own re-login request ────────────────────────────
  app.post(
    '/auth/relogin/cancel',
    { preHandler: [authPreHandler, requireRole('delegate')] },
    async (request, reply) => {
      const { requestId } = request.body as { requestId?: string };
      if (!requestId) throw new ProtocolError('VALIDATION_ERROR', 'requestId required');
      await authService.cancelRelogin(requestId, request.user!.userId);
      return reply.send({ ok: true });
    },
  );

  // ─── Chair: list pending re-login requests ──────────────────────────────────
  app.get(
    '/committee/:committeeId/relogin',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { committeeId } = request.params as { committeeId: string };
      const list = await authService.listPendingRelogins(committeeId);
      return reply.send({ requests: list });
    },
  );

  // ─── Chair: approve ─────────────────────────────────────────────────────────
  app.post(
    '/committee/:committeeId/relogin/:requestId/approve',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { requestId } = request.params as { requestId: string };
      const result = await authService.approveRelogin(requestId, request.user!.userId);
      return reply.send({ request: result });
    },
  );

  // ─── Chair: deny ────────────────────────────────────────────────────────────
  app.post(
    '/committee/:committeeId/relogin/:requestId/deny',
    { preHandler: [authPreHandler, requireCommitteeChair()] },
    async (request, reply) => {
      const { requestId } = request.params as { requestId: string };
      const { reason } = (request.body as { reason?: string }) ?? {};
      const result = await authService.denyRelogin(
        requestId,
        request.user!.userId,
        reason ?? 'Denied by chair',
      );
      return reply.send({ request: result });
    },
  );
}
