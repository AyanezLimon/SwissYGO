/* Tournament routes. TO writes are authoritative (PUT state_json); player
 * endpoints are read-only except join. Live pairing = players poll
 * GET /api/tournaments/:id/me. Pairing/standings are computed client-side from
 * the same state blob, so the server just persists and serves it. */
import { requireAuth } from '../auth.js';

function genJoinCode() {
  // 5 chars, unambiguous alphabet (no 0/O/1/I). Short enough to read aloud / type.
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 5; i++) c += A[Math.floor(Math.random() * A.length)];
  return c;
}

function emptyStateJson() {
  return JSON.stringify({
    started: false, finished: false, maxRounds: 0, players: [], rounds: [],
    currentRound: 0, viewRound: 0, note: '', excludeDrops: true,
    timer: { endsAt: null, pausedMs: null, durationMin: 50 }, tieBreaks: {},
  });
}

export default async function tournamentRoutes(app) {
  const db = app.db;

  const ownedOr404 = (id, userId, reply) => {
    const row = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!row) {
      reply.code(404).send({ error: 'Torneo no encontrado.' });
      return null;
    }
    if (row.to_user_id !== userId) {
      reply.code(403).send({ error: 'No eres el organizador de este torneo.' });
      return null;
    }
    return row;
  };

  // ---- TO (owner) ----
  app.post('/api/tournaments', { preHandler: requireAuth }, async (req, reply) => {
    const name = (req.body?.name || '').trim() || 'Torneo';
    let code = genJoinCode();
    while (db.prepare('SELECT 1 FROM tournaments WHERE join_code = ?').get(code)) code = genJoinCode();
    const info = db
      .prepare('INSERT INTO tournaments (to_user_id, name, join_code, status, state_json) VALUES (?, ?, ?, ?, ?)')
      .run(req.user.id, name, code, 'setup', emptyStateJson());
    return reply.code(201).send({ id: info.lastInsertRowid, name, join_code: code, status: 'setup' });
  });

  app.get('/api/tournaments', { preHandler: requireAuth }, async (req) => {
    return db
      .prepare('SELECT id, name, join_code, status, created_at, finished_at FROM tournaments WHERE to_user_id = ? ORDER BY created_at DESC')
      .all(req.user.id);
  });

  app.get('/api/tournaments/:id', { preHandler: requireAuth }, async (req, reply) => {
    const row = ownedOr404(Number(req.params.id), req.user.id, reply);
    if (!row) return;
    return { id: row.id, name: row.name, join_code: row.join_code, status: row.status, state: JSON.parse(row.state_json) };
  });

  app.put('/api/tournaments/:id', { preHandler: requireAuth }, async (req, reply) => {
    const row = ownedOr404(Number(req.params.id), req.user.id, reply);
    if (!row) return;
    if (row.finished_at) return reply.code(409).send({ error: 'El torneo finalizado es inmutable.' });
    const state = req.body?.state;
    if (!state || typeof state !== 'object') return reply.code(400).send({ error: 'state inválido.' });
    const status = state.finished ? 'finished' : state.started ? 'running' : 'setup';
    db.prepare('UPDATE tournaments SET state_json = ?, status = ? WHERE id = ?').run(JSON.stringify(state), status, row.id);
    return { ok: true, status };
  });

  app.post('/api/tournaments/:id/finish', { preHandler: requireAuth }, async (req, reply) => {
    const row = ownedOr404(Number(req.params.id), req.user.id, reply);
    if (!row) return;
    const state = JSON.parse(row.state_json);
    state.finished = true;
    db.prepare("UPDATE tournaments SET state_json = ?, status = 'finished', finished_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(state), row.id);
    return { ok: true };
  });

  app.get('/api/tournaments/:id/registrations', { preHandler: requireAuth }, async (req, reply) => {
    const row = ownedOr404(Number(req.params.id), req.user.id, reply);
    if (!row) return;
    return db
      .prepare('SELECT r.user_id, r.player_id, r.joined_at, u.username FROM registrations r JOIN users u ON u.id = r.user_id WHERE r.tournament_id = ?')
      .all(row.id);
  });

  // ---- Player ----
  app.post('/api/tournaments/join', { preHandler: requireAuth }, async (req, reply) => {
    const code = (req.body?.code || '').trim().toUpperCase();
    const t = db.prepare('SELECT * FROM tournaments WHERE join_code = ?').get(code);
    if (!t) return reply.code(404).send({ error: 'Código inválido.' });
    if (t.status !== 'setup') return reply.code(409).send({ error: 'El registro de este torneo ya cerró.' });

    const existing = db.prepare('SELECT player_id FROM registrations WHERE tournament_id = ? AND user_id = ?').get(t.id, req.user.id);
    if (existing) return { id: t.id, name: t.name, player_id: existing.player_id };

    // Single-writer rule: only insert the registration. The TO (sole writer of
    // state_json) absorbs new registrations into state.players, so a join can
    // never clobber the tournament state.
    const playerId = 'u' + req.user.id + '-' + Date.now().toString(36);
    db.prepare('INSERT INTO registrations (tournament_id, user_id, player_id) VALUES (?, ?, ?)').run(t.id, req.user.id, playerId);
    return reply.code(201).send({ id: t.id, name: t.name, player_id: playerId });
  });

  // Polled by the player view (~every 4s) for their current-round pairing.
  app.get('/api/tournaments/:id/me', { preHandler: requireAuth }, async (req, reply) => {
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'Torneo no encontrado.' });
    const reg = db.prepare('SELECT player_id FROM registrations WHERE tournament_id = ? AND user_id = ?').get(t.id, req.user.id);
    if (!reg) return reply.code(403).send({ error: 'No estás inscrito en este torneo.' });

    const state = JSON.parse(t.state_json);
    const round = state.rounds.find((r) => r.roundNumber === state.currentRound) || null;
    let pairing = null;
    if (round) {
      const m = round.matches.find((x) => x.p1Id === reg.player_id || x.p2Id === reg.player_id);
      if (m) {
        const oppId = m.p1Id === reg.player_id ? m.p2Id : m.p1Id;
        const opp = oppId ? state.players.find((p) => p.id === oppId) : null;
        const table = round.matches.filter((x) => !x.isBye).indexOf(m) + 1;
        pairing = {
          isBye: !!m.isBye,
          table: m.isBye ? null : table,
          opponent: opp ? opp.name : null,
          result: m.result,
          reported: !!m.isReported,
        };
      }
    }
    return { name: t.name, status: t.status, currentRound: state.currentRound, maxRounds: state.maxRounds, pairing };
  });

  app.get('/api/me/tournaments', { preHandler: requireAuth }, async (req) => {
    return db
      .prepare(`SELECT t.id, t.name, t.status, t.created_at, t.finished_at
                FROM tournaments t JOIN registrations r ON r.tournament_id = t.id
                WHERE r.user_id = ? ORDER BY t.created_at DESC`)
      .all(req.user.id);
  });
}
