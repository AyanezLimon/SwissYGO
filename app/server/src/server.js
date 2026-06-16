/* SwissYGO backend — Fastify, runs as a self-contained Docker container on the
 * Pi (CasaOS). Serves the API under /api AND the built SPA (static + history
 * fallback) from PUBLIC_DIR, so a single container is all the tunnel points at.
 * In container mode it binds 0.0.0.0 (Docker maps the host port); for API-only
 * local dev it defaults to 127.0.0.1 and just skips static serving if there's
 * no build. */
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import authRoutes from './routes/auth.js';
import tournamentRoutes from './routes/tournaments.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || './data/swissygo.sqlite';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-change-me';
const PUBLIC_DIR = process.env.PUBLIC_DIR || join(__dirname, '..', 'public');

export function buildApp() {
  const app = Fastify({ logger: true });
  app.decorate('db', openDb(DB_PATH));
  app.register(fastifyJwt, { secret: JWT_SECRET });

  // Health probe (used by the SPA to detect connected-mode availability).
  app.get('/api/health', async () => ({ ok: true, name: 'swissygo', ts: Date.now() }));

  app.register(authRoutes);
  app.register(tournamentRoutes);

  // Serve the built SPA when present (production container). Unknown non-/api
  // GET routes fall back to index.html for client-side (history-mode) routing.
  if (existsSync(join(PUBLIC_DIR, 'index.html'))) {
    app.register(fastifyStatic, { root: PUBLIC_DIR });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.method === 'GET' && !req.raw.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.code(404).send({ error: 'No encontrado.' });
    });
  }

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
