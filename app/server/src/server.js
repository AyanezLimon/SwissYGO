/* SwissYGO backend — a tiny Fastify + SQLite API. Does only what a static site
 * can't: accounts, tournament storage, join codes, history. The heavy pairing/
 * tiebreak math runs in the browser, so this is just CRUD + auth. The existing
 * Caddy serves the static SPA and reverse-proxies /api here. Not needed at all
 * for offline mode. */
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { openDb } from './db.js';
import authRoutes from './routes/auth.js';
import tournamentRoutes from './routes/tournaments.js';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0'; // container; Caddy proxies to it
const DB_PATH = process.env.DB_PATH || './data/swissygo.sqlite';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';

export function buildApp() {
  const app = Fastify({ logger: true });
  app.decorate('db', openDb(DB_PATH));
  app.register(fastifyJwt, { secret: JWT_SECRET });

  app.get('/api/health', async () => ({ ok: true, name: 'swissygo', ts: Date.now() }));
  app.register(authRoutes);
  app.register(tournamentRoutes);

  app.addHook('onClose', (instance, done) => {
    try { instance.db.close(); } catch {}
    done();
  });
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const app = buildApp();
  app.listen({ port: PORT, host: HOST }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
