/* SwissYGO backend. Two Fastify apps sharing one SQLite db:
 *  - PUBLIC API on PORT (8787): exposed via Caddy + Cloudflare tunnel (/api).
 *  - ADMIN on ADMIN_PORT (8788): NOT in the tunnel → LAN-only personal admin tool.
 * The heavy pairing/tiebreak math runs in the browser; this is just CRUD + auth. */
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { openDb } from './db.js';
import authRoutes from './routes/auth.js';
import tournamentRoutes from './routes/tournaments.js';
import deckRoutes from './routes/decks.js';
import adminRoutes from './routes/admin.js';

const PORT = Number(process.env.PORT || 8787);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || './data/swissygo.sqlite';
// This literal is in the public repo, so a token signed with it is forgeable by
// anyone (impersonate any TO). It's tolerated ONLY for tests / local dev; a real
// server refuses to start with it (see the listen guard below).
const INSECURE_JWT_SECRET = 'dev-only-insecure-secret-change-me';
const JWT_SECRET = process.env.JWT_SECRET || INSECURE_JWT_SECRET;
// Cap the lifetime of a leaked token. Authorization (role/disabled) is re-read from
// the DB every request, so this only bounds how long a stolen token stays usable —
// 30 days keeps re-logins rare for a casual app. Tokens issued before this change
// carry no `exp` claim and stay valid (no forced mass logout on deploy).
const JWT_TTL = process.env.JWT_TTL || '30d';

export function buildApp(db = openDb(DB_PATH)) {
  const app = Fastify({ logger: true });
  app.decorate('db', db);
  app.register(fastifyJwt, { secret: JWT_SECRET, sign: { expiresIn: JWT_TTL } });
  app.get('/api/health', async () => ({ ok: true, name: 'swissygo', ts: Date.now() }));
  app.register(authRoutes);
  app.register(tournamentRoutes);
  app.register(deckRoutes);
  return app;
}

export function buildAdminApp(db) {
  const app = Fastify({ logger: true });
  app.decorate('db', db);
  app.register(adminRoutes);
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  // Fail closed: a real (listening) server must have a strong, non-default secret.
  // docker-compose already requires JWT_SECRET (${JWT_SECRET:?}); this is the
  // defense-in-depth backstop for any other launch path.
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === INSECURE_JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is missing or set to the public dev default. Set a strong, secret JWT_SECRET before starting the server.');
    process.exit(1);
  }
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
