/* Local-only admin API + page. Runs on a SEPARATE port (ADMIN_PORT) that is NOT
 * exposed through the Cloudflare tunnel — reachable only on the LAN. Gated by a
 * shared ADMIN_PASSWORD (sent as X-Admin-Password). User CRUD: list, change role,
 * disable, reset password, delete. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

export default async function adminRoutes(app) {
  const db = app.db;

  const guard = async (req, reply) => {
    if (!ADMIN_PASSWORD) return reply.code(503).send({ error: 'Admin deshabilitado: define ADMIN_PASSWORD.' });
    if ((req.headers['x-admin-password'] || '') !== ADMIN_PASSWORD) {
      return reply.code(401).send({ error: 'Contraseña de admin incorrecta.' });
    }
  };

  // The admin page itself (no password needed to load the HTML; the API calls are guarded).
  let html = '<!doctype html><title>Admin</title><p>admin.html missing</p>';
  try { html = readFileSync(join(__dirname, '..', '..', 'admin.html'), 'utf8'); } catch {}
  app.get('/', async (req, reply) => reply.type('text/html').send(html));

  app.get('/admin/users', { preHandler: guard }, async () =>
    db.prepare('SELECT id, username, email, role, disabled, created_at FROM users ORDER BY created_at DESC').all());

  app.patch('/admin/users/:id', { preHandler: guard }, async (req, reply) => {
    const { role, disabled } = req.body || {};
    const sets = [], vals = [];
    if (role === 'to' || role === 'player') { sets.push('role = ?'); vals.push(role); }
    if (disabled === 0 || disabled === 1 || disabled === true || disabled === false) {
      sets.push('disabled = ?'); vals.push(disabled ? 1 : 0);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nada que actualizar.' });
    vals.push(Number(req.params.id));
    db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
    return { ok: true };
  });

  app.post('/admin/users/:id/password', { preHandler: guard }, async (req, reply) => {
    const { password } = req.body || {};
    if (!password || password.length < 6) return reply.code(400).send({ error: 'Contraseña mín. 6.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), Number(req.params.id));
    return { ok: true };
  });

  app.delete('/admin/users/:id', { preHandler: guard }, async (req) => {
    db.prepare('DELETE FROM users WHERE id = ?').run(Number(req.params.id));
    return { ok: true };
  });
}
