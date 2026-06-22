/* Auth routes: register, login, me. Usernames are case-insensitive (COLLATE
 * NOCASE in schema). JWT carries { id, username, role }. New accounts are always
 * regular players; the TO role is granted only via the local admin tool. */
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
    if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return reply.code(409).send({ error: 'Ese correo ya está registrado.' });
    }

    const hash = await hashPassword(password);
    const info = db
      .prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)')
      .run(username, email || null, hash); // role defaults to 'player'
    const user = { id: info.lastInsertRowid, username, role: 'player' };
    const token = await reply.jwtSign(user);
    return reply.code(201).send({ token, user });
  });

  app.post('/api/auth/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username || '');
    if (!row || !(await verifyPassword(password || '', row.password_hash))) {
      return reply.code(401).send({ error: 'Credenciales inválidas.' });
    }
    if (row.disabled) return reply.code(403).send({ error: 'Esta cuenta está deshabilitada.' });
    const user = { id: row.id, username: row.username, role: row.role };
    const token = await reply.jwtSign(user);
    return { token, user };
  });

  // Re-reads the role from the DB (so an admin change takes effect on next /me).
  app.get('/api/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const row = db.prepare('SELECT id, username, role, disabled, email FROM users WHERE id = ?').get(req.user.id);
    if (!row || row.disabled) return reply.code(401).send({ error: 'Sesión inválida.' });
    return { user: { id: row.id, username: row.username, role: row.role, email: row.email || null } };
  });

  // Add or change the account's email (self-service). Re-checks the current password
  // (sensitive change) and enforces uniqueness. Lets a user who signed up without an
  // email add one so they can use password reset (#35).
  app.post('/api/auth/email', { preHandler: requireAuth }, async (req, reply) => {
    const email = (req.body?.email || '').trim().toLowerCase(); // normalize (emails are case-insensitive)
    const password = req.body?.password || '';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return reply.code(400).send({ error: 'Correo inválido.' });
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
    if (!row || !(await verifyPassword(password, row.password_hash))) return reply.code(401).send({ error: 'Contraseña incorrecta.' });
    if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.user.id)) {
      return reply.code(409).send({ error: 'Ese correo ya está registrado.' });
    }
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
    return { ok: true, email };
  });
}
