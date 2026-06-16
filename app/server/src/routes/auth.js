/* Auth routes: register, login, me. Usernames are case-insensitive (COLLATE
 * NOCASE in schema). JWT carries { id, username }. */
import { hashPassword, verifyPassword, requireAuth } from '../auth.js';

export default async function authRoutes(app) {
  const db = app.db;

  app.post('/api/auth/register', async (req, reply) => {
    const { username, password, email } = req.body || {};
    if (!username || !password || password.length < 6) {
      return reply.code(400).send({ error: 'Usuario y contraseña (mín. 6) requeridos.' });
    }
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) return reply.code(409).send({ error: 'Ese usuario ya existe.' });

    const hash = await hashPassword(password);
    const info = db
      .prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)')
      .run(username, email || null, hash);
    const user = { id: info.lastInsertRowid, username };
    const token = await reply.jwtSign(user);
    return reply.code(201).send({ token, user });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
    if (!row || !(await verifyPassword(password || '', row.password_hash))) {
      return reply.code(401).send({ error: 'Credenciales inválidas.' });
    }
    const user = { id: row.id, username: row.username };
    const token = await reply.jwtSign(user);
    return { token, user };
  });

  app.get('/api/auth/me', { preHandler: requireAuth }, async (req) => {
    return { user: { id: req.user.id, username: req.user.username } };
  });
}
