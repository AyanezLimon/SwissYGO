/* Auth helpers: password hashing (bcryptjs — pure JS, no native build, friendly
 * to the Pi) and a Fastify preHandler that requires a valid JWT. */
import bcrypt from 'bcryptjs';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}
export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/* Use as a route `preHandler`. Populates req.user = { id, username, role } from
 * the JWT (verified by @fastify/jwt). Replies 401 when the token is missing/invalid. */
export async function requireAuth(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Autenticación requerida.' });
  }
}

/* TO-only routes (hosting). Requires a valid JWT AND role 'to'. Re-reads the role
 * from the DB so an admin promote/demote/disable takes effect immediately (no
 * re-login needed) and stale tokens can't outrank the current role. */
export async function requireTO(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Autenticación requerida.' });
  }
  const row = req.server.db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(req.user.id);
  if (!row || row.disabled) return reply.code(401).send({ error: 'Sesión inválida.' });
  if (row.role !== 'to') return reply.code(403).send({ error: 'Solo los organizadores pueden hacer esto.' });
}

/* Hosting routes open to ANY organizer: 'to' (official — may run ranked + casual
 * events, administers any tournament) or 'casual' (casual-only — creates unranked
 * events and administers only its own). Stashes the live role on req.userRole so
 * handlers can scope by capability/ownership. */
export async function requireOrganizer(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Autenticación requerida.' });
  }
  const row = req.server.db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(req.user.id);
  if (!row || row.disabled) return reply.code(401).send({ error: 'Sesión inválida.' });
  if (row.role !== 'to' && row.role !== 'casual') return reply.code(403).send({ error: 'Solo los organizadores pueden hacer esto.' });
  req.userRole = row.role; // 'to' | 'casual'
}
