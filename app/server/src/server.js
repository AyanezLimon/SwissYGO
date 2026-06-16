/* SwissYGO backend — Fastify on the Pi, behind Caddy + Cloudflare tunnel.
 * Serves the API under /api; Caddy serves the built SPA and reverse-proxies
 * /api here. Binds to 127.0.0.1 by default (only Caddy talks to it). */
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { openDb } from './db.js';
import authRoutes from './routes/auth.js';
import tournamentRoutes from './routes/tournaments.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || './data/swissygo.sqlite';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';

export function buildApp() {
  const app = Fastify({ logger: true });
  app.decorate('db', openDb(DB_PATH));
  app.register(fastifyJwt, { secret: JWT_SECRET });

  // Health probe (used by the SPA to detect connected-mode availability).
  app.get('/api/health', async () => ({ ok: true, name: 'swissygo', ts: Date.now() }));

  app.register(authRoutes);
  app.register(tournamentRoutes);

  app.addHook('onClose', (instance, done) => {
    try { instance.db.close(); } catch {}
    done();
  });
  return app;
}

// Start only when run directly (not when imported by tests).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const app = buildApp();
  app.listen({ port: PORT, host: HOST }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
