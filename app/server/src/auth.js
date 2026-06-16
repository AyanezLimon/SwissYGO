/* Auth helpers: password hashing (bcryptjs — pure JS, no native build, friendly
 * to the Pi) and a Fastify preHandler that requires a valid JWT. */
import bcrypt from 'bcryptjs';

export async function hashPassword(plain) {
  return bcrypt.hash(plain, 10);
}
export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/* Use as a route `preHandler`. Populates req.user = { id, username } from the JWT
 * (verified by @fastify/jwt). Replies 401 when the token is missing/invalid. */
export async function requireAuth(req, reply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'Autenticación requerida.' });
  }
}
