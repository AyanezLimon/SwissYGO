/* Local-only admin API + page. Runs on a SEPARATE port (ADMIN_PORT) that is NOT
 * exposed through the Cloudflare tunnel — reachable only on the LAN. Gated by a
 * shared ADMIN_PASSWORD (sent as X-Admin-Password). User CRUD: list, change role,
 * disable, reset password, delete. Tournament CRUD: list, rename, delete. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../auth.js';
import { reassignToAccount, restorePlayer, removePlayer, matchKind } from '../lib/roster.js';
import { makeAudit } from '../lib/audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

export default async function adminRoutes(app) {
  const db = app.db;
  const audit = makeAudit(db);                    // #136
  const ADMIN = { type: 'admin', name: 'admin' }; // actor local (:8788, sin identidad propia)

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
    if (role === 'to' || role === 'player' || role === 'casual') { sets.push('role = ?'); vals.push(role); }
    if (disabled === 0 || disabled === 1 || disabled === true || disabled === false) {
      sets.push('disabled = ?'); vals.push(disabled ? 1 : 0);
    }
    if (!sets.length) return reply.code(400).send({ error: 'Nada que actualizar.' });
    vals.push(Number(req.params.id));
    db.prepare('UPDATE users SET ' + sets.join(', ') + ' WHERE id = ?').run(...vals);
    audit(ADMIN, 'admin.user_update', null, { user_id: Number(req.params.id), ...(role !== undefined ? { role } : {}), ...(disabled !== undefined ? { disabled: disabled ? 1 : 0 } : {}) });
    return { ok: true };
  });

  app.post('/admin/users/:id/password', { preHandler: guard }, async (req, reply) => {
    const { password } = req.body || {};
    if (!password || password.length < 6) return reply.code(400).send({ error: 'Contraseña mín. 6.' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), Number(req.params.id));
    audit(ADMIN, 'admin.user_password', null, { user_id: Number(req.params.id) });
    return { ok: true };
  });

  app.delete('/admin/users/:id', { preHandler: guard }, async (req) => {
    db.prepare('DELETE FROM users WHERE id = ?').run(Number(req.params.id));
    audit(ADMIN, 'admin.user_delete', null, { user_id: Number(req.params.id) });
    return { ok: true };
  });

  // ---- Tournament CRUD (read / rename / delete) ----
  // No "create" here: tournaments are born from the organizer console.
  app.get('/admin/tournaments', { preHandler: guard }, async () => {
    const rows = db.prepare(`SELECT t.id, t.name, t.join_code, t.status, t.created_at, t.finished_at, t.state_json, u.username AS owner
                             FROM tournaments t LEFT JOIN users u ON u.id = t.to_user_id
                             ORDER BY t.created_at DESC`).all();
    return rows.map((r) => {
      let s = {}; try { s = JSON.parse(r.state_json); } catch {}
      return {
        id: r.id, name: r.name, code: r.join_code, status: r.status, owner: r.owner || null,
        created_at: r.created_at, finished_at: r.finished_at,
        players: (s.players || []).length, currentRound: s.currentRound || 0, maxRounds: s.maxRounds || 0,
      };
    });
  });

  app.patch('/admin/tournaments/:id', { preHandler: guard }, async (req, reply) => {
    const name = (typeof req.body?.name === 'string' && req.body.name.trim()) ? req.body.name.trim().slice(0, 80) : null;
    if (!name) return reply.code(400).send({ error: 'Indica un nombre.' });
    const info = db.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run(name, Number(req.params.id));
    if (!info.changes) return reply.code(404).send({ error: 'Torneo no encontrado.' });
    audit(ADMIN, 'admin.tournament_rename', Number(req.params.id), { name });
    return { ok: true };
  });

  app.delete('/admin/tournaments/:id', { preHandler: guard }, async (req, reply) => {
    const info = db.prepare('DELETE FROM tournaments WHERE id = ?').run(Number(req.params.id)); // registrations cascade (FK)
    if (!info.changes) return reply.code(404).send({ error: 'Torneo no encontrado.' });
    audit(ADMIN, 'admin.tournament_delete', Number(req.params.id));
    return { ok: true };
  });

  // ---- Registrations (read / delete) ----
  // No "id" column: a registration is keyed by (tournament_id, player_id). guest_token
  // is never exposed; we only surface whether the entry is an account or a guest.
  app.get('/admin/registrations', { preHandler: guard }, async () => {
    const rows = db.prepare(`SELECT r.tournament_id, r.player_id, r.display_name, r.user_id, r.joined_at,
                                    t.name AS tournament, t.join_code AS code, u.username AS account
                             FROM registrations r
                             LEFT JOIN tournaments t ON t.id = r.tournament_id
                             LEFT JOIN users u ON u.id = r.user_id
                             ORDER BY r.joined_at DESC`).all();
    return rows.map((r) => ({
      tournament_id: r.tournament_id, player_id: r.player_id, display_name: r.display_name,
      tournament: r.tournament, code: r.code,
      kind: r.user_id ? 'cuenta' : 'invitado', account: r.account || null,
      joined_at: r.joined_at,
    }));
  });

  app.delete('/admin/registrations/:tournamentId/:playerId', { preHandler: guard }, async (req, reply) => {
    const info = db.prepare('DELETE FROM registrations WHERE tournament_id = ? AND player_id = ?')
      .run(Number(req.params.tournamentId), req.params.playerId);
    if (!info.changes) return reply.code(404).send({ error: 'Inscripción no encontrada.' });
    audit(ADMIN, 'admin.registration_delete', Number(req.params.tournamentId), { player_id: req.params.playerId });
    return { ok: true };
  });

  // ---- Global settings ----
  // Currently just the Elo K-factor (rating volatility). Changing it re-rates the
  // whole season on the next leaderboard recompute (the board is derived from match
  // history, not stored incrementally), so it applies retroactively — by design.
  app.get('/admin/settings', { preHandler: guard }, async () => {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'elo_k'").get();
    const k = parseInt(row && row.value, 10);
    return { elo_k: Number.isFinite(k) ? k : 24 };
  });

  app.patch('/admin/settings', { preHandler: guard }, async (req, reply) => {
    const k = parseInt(req.body?.elo_k, 10);
    if (!Number.isFinite(k) || k < 1 || k > 100) return reply.code(400).send({ error: 'elo_k debe ser un entero entre 1 y 100.' });
    db.prepare("INSERT INTO settings (key, value) VALUES ('elo_k', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(k));
    audit(ADMIN, 'admin.settings', null, { elo_k: k });
    return { ok: true, elo_k: k };
  });

  // ---- Per-tournament roster surgery (#96) ----
  // Edits BOTH registrations and state_json atomically (the two sides that the
  // single-writer model otherwise keeps separate). SAFE MODE: ops that would touch
  // a real pairing in a running event are refused (the state helpers throw → 409).
  // After a change the TO must reload the console (automatic once #95 ships) so its
  // localStorage cache adopts the corrected server state.
  const loadTourney = (id, reply) => {
    const row = db.prepare('SELECT id, name, status, state_json FROM tournaments WHERE id = ?').get(id);
    if (!row) { reply.code(404).send({ error: 'Torneo no encontrado.' }); return null; }
    let state; try { state = JSON.parse(row.state_json); } catch { reply.code(500).send({ error: 'state_json corrupto.' }); return null; }
    return { row, state };
  };
  const writeState = (id, state) => db.prepare('UPDATE tournaments SET state_json = ? WHERE id = ?').run(JSON.stringify(state), id);

  app.get('/admin/tournaments/:id/roster', { preHandler: guard }, async (req, reply) => {
    const tid = Number(req.params.id);
    const lt = loadTourney(tid, reply); if (!lt) return;
    const { row, state } = lt;
    const regs = db.prepare('SELECT player_id, user_id, display_name, CASE WHEN guest_token IS NULL THEN 0 ELSE 1 END AS is_guest FROM registrations WHERE tournament_id = ?').all(tid);
    const regByPid = new Map(regs.map((r) => [r.player_id, r]));
    const inState = new Set((state.players || []).map((p) => p.id));
    const removed = (state.cloud && state.cloud.removed) || [];
    const players = (state.players || []).map((p) => {
      const r = regByPid.get(p.id);
      return { player_id: p.id, name: p.name, userId: p.userId ?? (r ? r.user_id : null), dropped: !!p.dropped, kind: r ? (r.user_id != null ? 'account' : 'guest') : 'manual', match: matchKind(state, p.id) };
    });
    const orphanRegs = regs.filter((r) => !inState.has(r.player_id)).map((r) => ({
      player_id: r.player_id, user_id: r.user_id, display_name: r.display_name, kind: r.user_id != null ? 'account' : 'guest', tombstoned: removed.includes(r.player_id),
    }));
    return { id: tid, name: row.name, status: row.status, started: !!state.started, finished: !!state.finished, currentRound: state.currentRound || 0, players, orphanRegs };
  });

  // Reassign a slot to an account (e.g. a guest who also created an account). If that
  // account already has another slot here (a duplicate), it's removed first (safe gate).
  app.post('/admin/tournaments/:id/roster/reassign', { preHandler: guard }, async (req, reply) => {
    const tid = Number(req.params.id);
    const playerId = String(req.body?.player_id || '');
    const userId = Number(req.body?.user_id);
    const lt = loadTourney(tid, reply); if (!lt) return;
    const { state } = lt;
    const reg = db.prepare('SELECT * FROM registrations WHERE tournament_id=? AND player_id=?').get(tid, playerId);
    if (!reg) return reply.code(404).send({ error: 'Inscripción no encontrada para ese jugador.' });
    const user = db.prepare('SELECT id, username FROM users WHERE id=?').get(userId);
    if (!user) return reply.code(404).send({ error: 'Usuario no encontrado.' });
    const existing = db.prepare('SELECT * FROM registrations WHERE tournament_id=? AND user_id=?').get(tid, userId);
    try {
      db.transaction(() => {
        if (existing && existing.player_id !== playerId) {
          if (state.players.some((p) => p.id === existing.player_id)) removePlayer(state, existing.player_id); // throws if in a real match
          db.prepare('DELETE FROM registrations WHERE tournament_id=? AND player_id=?').run(tid, existing.player_id);
        }
        db.prepare('UPDATE registrations SET user_id=?, guest_token=NULL, display_name=? WHERE tournament_id=? AND player_id=?').run(userId, user.username, tid, playerId);
        reassignToAccount(state, playerId, user.username, userId);
        writeState(tid, state);
      })();
    } catch (e) { return reply.code(409).send({ error: e.message }); }
    audit(ADMIN, 'admin.roster_reassign', tid, { player_id: playerId, user_id: userId, username: user.username });
    return { ok: true };
  });

  app.post('/admin/tournaments/:id/roster/restore', { preHandler: guard }, async (req, reply) => {
    const tid = Number(req.params.id);
    const playerId = String(req.body?.player_id || '');
    const lt = loadTourney(tid, reply); if (!lt) return;
    const { state } = lt;
    const reg = db.prepare('SELECT * FROM registrations WHERE tournament_id=? AND player_id=?').get(tid, playerId);
    if (!reg) return reply.code(404).send({ error: 'No hay inscripción para restaurar ese jugador.' });
    try { restorePlayer(state, reg); writeState(tid, state); }
    catch (e) { return reply.code(409).send({ error: e.message }); }
    audit(ADMIN, 'admin.roster_restore', tid, { player_id: playerId });
    return { ok: true };
  });

  app.post('/admin/tournaments/:id/roster/remove', { preHandler: guard }, async (req, reply) => {
    const tid = Number(req.params.id);
    const playerId = String(req.body?.player_id || '');
    const lt = loadTourney(tid, reply); if (!lt) return;
    const { state } = lt;
    try {
      db.transaction(() => {
        removePlayer(state, playerId); // throws if in a real match
        db.prepare('DELETE FROM registrations WHERE tournament_id=? AND player_id=?').run(tid, playerId);
        writeState(tid, state);
      })();
    } catch (e) { return reply.code(409).send({ error: e.message }); }
    audit(ADMIN, 'admin.roster_remove', tid, { player_id: playerId });
    return { ok: true };
  });

  // Delete a dangling registration whose player_id is NOT in the tournament state
  // (the "removed in console but still in the DB" case). State is untouched.
  app.delete('/admin/tournaments/:id/roster/orphan/:playerId', { preHandler: guard }, async (req, reply) => {
    const tid = Number(req.params.id);
    const playerId = req.params.playerId;
    const lt = loadTourney(tid, reply); if (!lt) return;
    if ((lt.state.players || []).some((p) => p.id === playerId)) return reply.code(409).send({ error: 'Ese jugador SÍ está en el torneo; usa "Quitar jugador", no limpiar huérfano.' });
    const info = db.prepare('DELETE FROM registrations WHERE tournament_id=? AND player_id=?').run(tid, playerId);
    if (!info.changes) return reply.code(404).send({ error: 'Inscripción no encontrada.' });
    audit(ADMIN, 'admin.roster_orphan_clean', tid, { player_id: playerId });
    return { ok: true };
  });

  // ---- Auditoría (#136) — solo lectura ----
  // Trail de mutaciones (lo llena makeAudit desde todas las rutas). Filtros:
  // ?tournament_id=N, ?action=prefijo (LIKE 'x%'), ?limit (máx 500).
  app.get('/admin/audit', { preHandler: guard }, async (req) => {
    const lim = Math.min(500, Math.max(1, parseInt(req.query?.limit, 10) || 100));
    const conds = [], vals = [];
    if (req.query?.tournament_id) { conds.push('tournament_id = ?'); vals.push(Number(req.query.tournament_id)); }
    if (req.query?.action) { conds.push('action LIKE ?'); vals.push(String(req.query.action) + '%'); }
    const where = conds.length ? ' WHERE ' + conds.join(' AND ') : '';
    return db.prepare('SELECT id, ts, actor_type, actor_id, actor_name, action, tournament_id, detail_json FROM audit_log' + where + ' ORDER BY id DESC LIMIT ?').all(...vals, lim);
  });

  // Ring de snapshots del estado (material de diff/rollback): lista + snapshot.
  app.get('/admin/tournaments/:id/history', { preHandler: guard }, async (req) =>
    db.prepare('SELECT id, ts, length(state_json) AS bytes FROM state_history WHERE tournament_id = ? ORDER BY id DESC').all(Number(req.params.id)));

  app.get('/admin/history/:id', { preHandler: guard }, async (req, reply) => {
    const row = db.prepare('SELECT * FROM state_history WHERE id = ?').get(Number(req.params.id));
    if (!row) return reply.code(404).send({ error: 'Snapshot no encontrado.' });
    return { id: row.id, tournament_id: row.tournament_id, ts: row.ts, state: JSON.parse(row.state_json) };
  });

  // ---- Monitor de requests (#142) — ring en memoria del API público ----
  app.get('/admin/requests', { preHandler: guard }, async () => app.reqmon.list());

  // Streaming SSE de las requests nuevas. El cliente NO usa EventSource (no
  // permite el header X-Admin-Password) sino fetch en streaming; el formato de
  // eventos es SSE estándar igualmente. Heartbeat cada 25 s para que la
  // conexión inactiva no se corte; hijack() para manejar el socket a mano.
  app.get('/admin/requests/stream', { preHandler: guard }, (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // Escrituras blindadas + cleanup idempotente: el admin comparte proceso con
    // el API público — un socket muerto jamás debe escalar a excepción global.
    let hb = null, unsub = () => {}, done = false;
    function cleanup() {
      if (done) return;
      done = true;
      clearInterval(hb);
      unsub();
      try { reply.raw.end(); } catch { /* ya cerrado */ }
    }
    const write = (s) => {
      if (done) return;
      try { reply.raw.write(s); } catch { cleanup(); }
    };
    write(':ok\n\n');
    unsub = app.reqmon.subscribe((e) => write('data: ' + JSON.stringify(e) + '\n\n'));
    hb = setInterval(() => write(':hb\n\n'), 25000);
    req.raw.on('close', cleanup);
    reply.raw.on('error', cleanup);
  });
}
