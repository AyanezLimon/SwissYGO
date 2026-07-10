/* SwissYGO backend. Two Fastify apps sharing one SQLite db:
 *  - PUBLIC API on PORT (8787): exposed via Caddy + Cloudflare tunnel (/api).
 *  - ADMIN on ADMIN_PORT (8788): NOT in the tunnel → LAN-only personal admin tool.
 * The heavy pairing/tiebreak math runs in the browser; this is just CRUD + auth. */
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { openDb } from './db.js';
import { makeReqMonitor } from './lib/reqmon.js';
import authRoutes from './routes/auth.js';
import tournamentRoutes from './routes/tournaments.js';
import deckRoutes from './routes/decks.js';
import adminRoutes from './routes/admin.js';

const PORT = Number(process.env.PORT || 8787);
const ADMIN_PORT = Number(process.env.ADMIN_PORT || 8788);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || './data/swissygo.sqlite';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';

export function buildApp(db = openDb(DB_PATH), reqmon = makeReqMonitor()) {
  const app = Fastify({ logger: true });
  app.decorate('db', db);
  app.decorate('reqmon', reqmon);
  app.register(fastifyJwt, { secret: JWT_SECRET });
  // #142: cada respuesta del API público alimenta el ring del monitor. Solo
  // metadatos — JAMÁS bodies (ahí viajan contraseñas). El actor sale del JWT
  // si alguna ruta lo verificó; un x-guest-token presente se marca como guest.
  app.addHook('onResponse', async (req, reply) => {
    reqmon.record({
      ts: Date.now(),
      method: req.method,
      url: req.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
      actor: (req.user && req.user.username) || (req.headers['x-guest-token'] ? 'guest' : null),
    });
  });
  app.get('/api/health', async () => ({ ok: true, name: 'swissygo', ts: Date.now() }));
  app.register(authRoutes);
  app.register(tournamentRoutes);
  app.register(deckRoutes);
  return app;
}

export function buildAdminApp(db, reqmon = makeReqMonitor()) {
  const app = Fastify({ logger: true });
  app.decorate('db', db);
  app.decorate('reqmon', reqmon);
  app.register(adminRoutes);
  return app;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  const db = openDb(DB_PATH);
  const reqmon = makeReqMonitor(); // compartido: el API escribe, el admin lee/streamea
  const api = buildApp(db, reqmon);
  const admin = buildAdminApp(db, reqmon);
  Promise.all([
    api.listen({ port: PORT, host: HOST }),
    admin.listen({ port: ADMIN_PORT, host: HOST }),
  ]).catch((err) => {
    api.log.error(err);
    process.exit(1);
  });
}
