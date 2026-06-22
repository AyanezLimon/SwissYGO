/* Auth routes: register, login, me. Usernames are case-insensitive (COLLATE
 * NOCASE in schema). JWT carries { id, username, role }. New accounts are always
 * regular players; the TO role is granted only via the local admin tool. */
import { randomInt } from 'node:crypto';
import { hashPassword, verifyPassword, requireAuth } from '../auth.js';
import { sendEmail } from '../lib/email.js';

const RESET_TTL_MIN = 15;   // a reset code is valid for this many minutes
const RESET_MAX_TRIES = 5;  // wrong-code attempts before the code is burned

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

  // ---- Self-service password reset (email + 6-digit code) ----------------
  // Request a code. ALWAYS returns 200 (never reveal whether the email exists).
  // Only accounts with an email on file can receive one.
  app.post('/api/auth/forgot', async (req, reply) => {
    const email = (req.body?.email || '').trim();
    if (email) {
      const u = db.prepare('SELECT id, username FROM users WHERE email = ?').get(email);
      if (u && !db.prepare('SELECT disabled FROM users WHERE id = ?').get(u.id)?.disabled) {
        const code = String(randomInt(0, 1000000)).padStart(6, '0');
        const codeHash = await hashPassword(code);
        db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id); // supersede any prior code
        db.prepare("INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES (?, ?, datetime('now', '+' || ? || ' minutes'))")
          .run(u.id, codeHash, RESET_TTL_MIN);
        try {
          await sendEmail({
            to: email,
            subject: 'Tu código para restablecer la contraseña — SwissYGO',
            text: `Hola ${u.username}: tu código para restablecer la contraseña es ${code}. Vence en ${RESET_TTL_MIN} minutos. Si no lo solicitaste, ignora este correo.`,
            html: `<p>Hola <b>${u.username}</b>,</p><p>Tu código para restablecer la contraseña es:</p>`
              + `<p style="font-size:30px;font-weight:800;letter-spacing:8px;font-family:monospace">${code}</p>`
              + `<p>Vence en ${RESET_TTL_MIN} minutos. Si no lo solicitaste, ignora este correo.</p>`,
          });
        } catch (e) { req.log.error(e, 'reset email failed'); }
      }
    }
    return { ok: true };
  });

  // Consume a code + set a new password. Generic errors (no enumeration); the code
  // is single-use and burns after RESET_MAX_TRIES wrong attempts.
  app.post('/api/auth/reset', async (req, reply) => {
    const email = (req.body?.email || '').trim();
    const code = String(req.body?.code || '').trim();
    const password = req.body?.password || '';
    if (!email || !code || password.length < 6) {
      return reply.code(400).send({ error: 'Datos inválidos (la contraseña debe tener mín. 6 caracteres).' });
    }
    const u = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    const row = u && db.prepare("SELECT * FROM password_resets WHERE user_id = ? AND used = 0 AND expires_at > datetime('now') ORDER BY id DESC").get(u.id);
    if (!row) return reply.code(400).send({ error: 'Código inválido o expirado.' });
    if (!(await verifyPassword(code, row.code_hash))) {
      const attempts = row.attempts + 1;
      if (attempts >= RESET_MAX_TRIES) db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
      else db.prepare('UPDATE password_resets SET attempts = ? WHERE id = ?').run(attempts, row.id);
      return reply.code(400).send({ error: 'Código inválido o expirado.' });
    }
    const hash = await hashPassword(password);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, u.id);
    db.prepare('UPDATE password_resets SET used = 1 WHERE id = ?').run(row.id);
    return { ok: true };
  });

  // Re-reads the role from the DB (so an admin change takes effect on next /me).
  app.get('/api/auth/me', { preHandler: requireAuth }, async (req, reply) => {
    const row = db.prepare('SELECT id, username, role, disabled FROM users WHERE id = ?').get(req.user.id);
    if (!row || row.disabled) return reply.code(401).send({ error: 'Sesión inválida.' });
    return { user: { id: row.id, username: row.username, role: row.role } };
  });
}
