/**
 * @mun/server — Fastify application wiring
 *
 * Assembles the HTTP app (CORS, JSON limits, a unified ProtocolError handler,
 * all REST route groups) and attaches the WebSocket server. Exported as a
 * factory so tests can construct an isolated app instance.
 */

import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { setupWebSocketServer } from './realtime/ws.js';
import { ProtocolError, type ApiError, type ErrorCode } from '@mun/protocol';

export interface AppDeps {
  /** When false, the WebSocket server is not attached (for some unit tests). */
  withWebSocket?: boolean;
}

export async function buildApp(deps: AppDeps = {}): Promise<{
  app: FastifyInstance;
  close: () => Promise<void>;
}> {
  const app = Fastify({
    logger: config.isProduction
      ? { level: 'info' }
      : { level: 'debug' },
    bodyLimit: 256 * 1024,
    trustProxy: true,
  });

  await app.register(cors, {
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(','),
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    credentials: true,
  });

  // Multipart file uploads (resolution/directive PDF/DOC). 25 MB cap.
  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  // ─── Unified error handler ──────────────────────────────────────────────────
  app.setErrorHandler((err: FastifyError, _request, reply) => {
    if (err instanceof ProtocolError) {
      const body: ApiError = err.toApiError();
      return reply.status(err.status).send(body);
    }
    // Fastify validation errors → 400.
    if (err.validation) {
      const details = Array.isArray(err.validation)
        ? err.validation.map((v) => ({ field: v.instancePath ?? '', issue: v.message ?? err.message }))
        : [{ field: '', issue: err.message }];
      const body: ApiError = {
        code: 'VALIDATION_ERROR' as ErrorCode,
        message: err.message,
        details,
      };
      return reply.status(400).send(body);
    }
    // eslint-disable-next-line no-console
    console.error('[server] unhandled error', err);
    return reply.status(500).send({
      code: 'INTERNAL_ERROR' as ErrorCode,
      message: 'Internal server error',
    } satisfies ApiError);
  });

  // ─── Health (unauthenticated, for load balancers) ───────────────────────────
  app.get('/health', async () => ({ ok: true, ts: Date.now() }));

  // ─── Route groups ───────────────────────────────────────────────────────────
  const { registerAuthRoutes } = await import('./auth/routes.js');
  const { registerMonitoringRoutes } = await import('./monitoring/routes.js');
  const { registerVotingRoutes } = await import('./voting/routes.js');
  const { registerCommitteeRoutes } = await import('./committee/routes.js');
  const { registerAdminRoutes } = await import('./admin/routes.js');
  const { registerSubmissionRoutes } = await import('./submission/routes.js');

  await registerAuthRoutes(app);
  await registerMonitoringRoutes(app);
  await registerVotingRoutes(app);
  await registerCommitteeRoutes(app);
  await registerAdminRoutes(app);
  await registerSubmissionRoutes(app);

  // ─── WebSocket ──────────────────────────────────────────────────────────────
  let wss: import('ws').WebSocketServer | null = null;
  if (deps.withWebSocket !== false) {
    await app.ready();
    wss = setupWebSocketServer(app.server);
  }

  const close = async () => {
    if (wss) wss.close();
    await app.close();
  };

  return { app, close };
}
