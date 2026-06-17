/* Tournament routes. TO writes are authoritative (PUT state_json); player
 * endpoints are read-only except join. Live pairing = players poll
 * GET /api/tournaments/:id/me. Pairing/standings are computed client-side from
 * the same state blob, so the server just persists and serves it. */
import { randomBytes } from 'node:crypto';
import { requireAuth, requireTO } from '../auth.js';
import { finalStandings } from '../lib/tiebreak.js';

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
  app.post('/api/tournaments', { preHandler: requireTO }, async (req, reply) => {
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
    const state = req.body?.state;
    if (!state || typeof state !== 'object') return reply.code(400).send({ error: 'state inválido.' });
    const status = state.finished ? 'finished' : state.started ? 'running' : 'setup';
    // Stamp finished_at the first time it finishes (for history); stay editable
    // afterwards so the TO can still resolve ties post-finish.
    if (state.finished && !row.finished_at) {
      db.prepare("UPDATE tournaments SET state_json = ?, status = ?, finished_at = datetime('now') WHERE id = ?")
        .run(JSON.stringify(state), status, row.id);
    } else {
      db.prepare('UPDATE tournaments SET state_json = ?, status = ? WHERE id = ?').run(JSON.stringify(state), status, row.id);
    }
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
    // display_name covers both accounts and guests; guest_token is never exposed.
    return db
      .prepare('SELECT player_id, display_name, user_id, joined_at FROM registrations WHERE tournament_id = ? ORDER BY joined_at')
      .all(row.id);
  });

  // ---- Player ----
  // No requireAuth: accounts join with a JWT, guests join with a typed name and
  // receive a per-tournament guest_token (stored only in their browser).
  app.post('/api/tournaments/join', async (req, reply) => {
    const code = (req.body?.code || '').trim().toUpperCase();
    const t = db.prepare('SELECT * FROM tournaments WHERE join_code = ?').get(code);
    if (!t) return reply.code(404).send({ error: 'Código inválido.' });
    if (t.status !== 'setup') return reply.code(409).send({ error: 'El registro de este torneo ya cerró.' });

    let userId = null, uname = null;
    try { await req.jwtVerify(); userId = req.user.id; uname = req.user.username; } catch { /* guest */ }

    if (userId) {
      const existing = db.prepare('SELECT player_id FROM registrations WHERE tournament_id = ? AND user_id = ?').get(t.id, userId);
      if (existing) return { id: t.id, name: t.name, player_id: existing.player_id };
      const playerId = 'u' + userId + '-' + Date.now().toString(36);
      db.prepare('INSERT INTO registrations (tournament_id, user_id, player_id, display_name) VALUES (?, ?, ?, ?)')
        .run(t.id, userId, playerId, uname);
      return reply.code(201).send({ id: t.id, name: t.name, player_id: playerId });
    }

    // Guest: requires a display name; issue a guest_token for /me identification.
    const name = (req.body?.name || '').trim().slice(0, 40);
    if (!name) return reply.code(400).send({ error: 'Indica un nombre para inscribirte como invitado.' });
    const guestToken = randomBytes(16).toString('hex');
    const playerId = 'g-' + guestToken.slice(0, 8) + '-' + Date.now().toString(36);
    db.prepare('INSERT INTO registrations (tournament_id, guest_token, player_id, display_name) VALUES (?, ?, ?, ?)')
      .run(t.id, guestToken, playerId, name);
    return reply.code(201).send({ id: t.id, name: t.name, player_id: playerId, guest_token: guestToken });
  });

  // Polled by the player view (~every 4s). Identify by JWT (account) or
  // X-Guest-Token header (guest).
  app.get('/api/tournaments/:id/me', async (req, reply) => {
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'Torneo no encontrado.' });
    let reg = null;
    try { await req.jwtVerify(); reg = db.prepare('SELECT player_id FROM registrations WHERE tournament_id = ? AND user_id = ?').get(t.id, req.user.id); } catch { /* guest */ }
    if (!reg) {
      const gt = req.headers['x-guest-token'];
      if (gt) reg = db.prepare('SELECT player_id FROM registrations WHERE tournament_id = ? AND guest_token = ?').get(t.id, gt);
    }
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

  // Read-only results: final standings + rounds (names resolved). Finished
  // tournaments are public; ongoing ones only to the owner or a participant.
  app.get('/api/tournaments/:id/public', async (req, reply) => {
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'Torneo no encontrado.' });

    if (t.status !== 'finished') {
      let allowed = false;
      try { await req.jwtVerify(); if (req.user.id === t.to_user_id || db.prepare('SELECT 1 FROM registrations WHERE tournament_id = ? AND user_id = ?').get(t.id, req.user.id)) allowed = true; } catch {}
      if (!allowed) {
        const gt = req.headers['x-guest-token'];
        if (gt && db.prepare('SELECT 1 FROM registrations WHERE tournament_id = ? AND guest_token = ?').get(t.id, gt)) allowed = true;
      }
      if (!allowed) return reply.code(403).send({ error: 'Los resultados aún no son públicos.' });
    }

    const state = JSON.parse(t.state_json);
    const pname = (id) => { const p = state.players.find((x) => x.id === id); return p ? p.name : '—'; };
    const standings = finalStandings(state).map((s, i) => ({
      rank: i + 1, name: s.name, points: s.matchPoints, wins: s.wins, losses: s.losses, dropped: !!s.dropped,
    }));
    const rounds = (state.rounds || []).map((r) => ({
      roundNumber: r.roundNumber,
      matches: r.matches.map((m) => ({ bye: !!m.isBye, p1: pname(m.p1Id), p2: m.isBye ? null : pname(m.p2Id), result: m.result, reported: !!m.isReported })),
    }));
    return { name: t.name, status: t.status, finished_at: t.finished_at, currentRound: state.currentRound, maxRounds: state.maxRounds, standings, rounds };
  });

  // Public list of active tournaments (accepting registration or running) so
  // players can pick one. Join codes are intentionally shown.
  app.get('/api/tournaments/active', async () => {
    const rows = db
      .prepare("SELECT id, name, join_code, status, created_at, state_json FROM tournaments WHERE status IN ('setup','running') ORDER BY created_at DESC LIMIT 50")
      .all();
    return rows.map((r) => {
      let s = {}; try { s = JSON.parse(r.state_json); } catch {}
      return {
        id: r.id, name: r.name, code: r.join_code, status: r.status, created_at: r.created_at,
        players: (s.players || []).length, note: s.note || '', maxRounds: s.maxRounds || 0,
      };
    });
  });
}
