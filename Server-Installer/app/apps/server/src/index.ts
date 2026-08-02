/**
 * @mun/server — entry point
 *
 * Startup order:
 *  1. Run pending DB migrations (idempotent).
 *  2. Seed bootstrap admin + built-in AI rules (idempotent).
 *  3. Load AI rules into the in-memory cache.
 *  4. Build the Fastify app + WebSocket server.
 *  5. Start the presence timeout sweep, break scheduler, and health broadcast.
 *  6. Listen.
 *
 * Shutdown: stop schedulers, close the WS server, close Fastify, drain the pool.
 */

import { config } from './config.js';
import { pool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';
import { runSeed } from './db/seed.js';
import { loadRules } from './monitoring/rules.js';
import { presence } from './realtime/presence.js';
import { startBreakScheduler, stopBreakScheduler } from './committee/breaks.js';
import { broadcastHealth } from './admin/service.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log('[server] starting SAFE MUN 2026 server…');

  await runMigrations();
  await runSeed();
  await loadRules();

  const { app, close } = await buildApp({ withWebSocket: true });

  presence.startSweep(2000);
  startBreakScheduler(5000);

  // Periodic health broadcast to admins (every 10s).
  const healthTimer = setInterval(() => {
    void broadcastHealth().catch(() => {});
  }, 10_000);
  healthTimer.unref?.();

  await app.listen({ host: config.host, port: config.port });
  // eslint-disable-next-line no-console
  console.log(`[server] listening on http://${config.host}:${config.port} (ws at /ws)`);

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[server] ${signal} received, shutting down…`);
    clearInterval(healthTimer);
    stopBreakScheduler();
    presence.stopSweep();
    await close();
    await pool.end();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] fatal startup error', err);
  pool.end().finally(() => process.exit(1));
});
