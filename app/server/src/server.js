/* SwissYGO backend. Two Fastify apps sharing one SQLite db:
 *  - PUBLIC API on PORT (8787): exposed via Caddy + Cloudflare tunnel (/api).
 *  - ADMIN on ADMIN_PORT (8788): NOT in the tunnel → LAN-only personal admin tool.
 * The heavy pairing/tiebreak math runs in the browser; this is just CRUD + auth. */
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { openDb } from './db.js';
import authRoutes from './routes/auth.js';
import tournamentRoutes from './routes/tournaments.js';
import adminRoutes from './routes/admin.js';

const PORT = Number(process.env.PORT || 8787);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || './data/swissygo.sqlite';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';

export function buildApp(db = openDb(DB_PATH)) {
  const app = Fastify({ logger: true });
  app.decorate('db', db);
  app.register(fastifyJwt, { secret: JWT_SECRET });
  app.get('/api/health', async () => ({ ok: true, name: 'swissygo', ts: Date.now() }));
  app.register(authRoutes);
  app.register(tournamentRoutes);
  return app;
}

export function buildAdminApp(db) {
  const app = Fastify({ logger: true });
  app.decorate('db', db);
  app.register(adminRoutes);
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const db = openDb(DB_PATH);
  const api = buildApp(db);
  const admin = buildAdminApp(db);
  Promise.all([
    api.listen({ port: PORT, host: HOST }),
    admin.listen({ port: ADMIN_PORT, host: HOST }),
  ]).catch((err) => {
    api.log.error(err);
    process.exit(1);
  });
}
