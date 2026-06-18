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

  // Any TO can administer ANY tournament (the TO role is system-wide, not per-event),
  // so console endpoints gate on the `to` role (requireTO) and only 404 here.
  // `to_user_id` is kept purely as "who created it" metadata.
  const findOr404 = (id, reply) => {
    const row = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!row) { reply.code(404).send({ error: 'Torneo no encontrado.' }); return null; }
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

  // Admin panel: EVERY tournament (any TO administers any event), newest-active
  // first. Includes round progress, timer state and creator so the TO can pick.
  app.get('/api/tournaments', { preHandler: requireTO }, async () => {
    const rows = db
      .prepare(`SELECT t.id, t.name, t.join_code, t.status, t.created_at, t.finished_at, t.state_json, u.username AS owner
                FROM tournaments t LEFT JOIN users u ON u.id = t.to_user_id
                ORDER BY (t.status = 'finished') ASC, t.created_at DESC`)
      .all();
    const now = Date.now();
    return rows.map((r) => {
      let s = {}; try { s = JSON.parse(r.state_json); } catch {}
      const tm = s.timer || {};
      let timer = 'none';
      if (s.started && !s.finished) {
        if (tm.pausedMs != null) timer = 'paused';
        else if (tm.endsAt) timer = tm.endsAt > now ? 'running' : 'ended';
      }
      return {
        id: r.id, name: r.name, join_code: r.join_code, status: r.status, owner: r.owner || null,
        created_at: r.created_at, finished_at: r.finished_at,
        players: (s.players || []).length, currentRound: s.currentRound || 0, maxRounds: s.maxRounds || 0,
        timer,
      };
    });
  });

  app.get('/api/tournaments/:id', { preHandler: requireTO }, async (req, reply) => {
    const row = findOr404(Number(req.params.id), reply);
    if (!row) return;
    return { id: row.id, name: row.name, join_code: row.join_code, status: row.status, state: JSON.parse(row.state_json) };
  });

  app.put('/api/tournaments/:id', { preHandler: requireTO }, async (req, reply) => {
    const row = findOr404(Number(req.params.id), reply);
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

  app.post('/api/tournaments/:id/finish', { preHandler: requireTO }, async (req, reply) => {
    const row = findOr404(Number(req.params.id), reply);
    if (!row) return;
    const state = JSON.parse(row.state_json);
    state.finished = true;
    db.prepare("UPDATE tournaments SET state_json = ?, status = 'finished', finished_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(state), row.id);
    return { ok: true };
  });

  app.get('/api/tournaments/:id/registrations', { preHandler: requireTO }, async (req, reply) => {
    const row = findOr404(Number(req.params.id), reply);
    if (!row) return;
    // display_name covers both accounts and guests; guest_token is never exposed.
    return db
      .prepare('SELECT player_id, display_name, user_id, joined_at FROM registrations WHERE tournament_id = ? ORDER BY joined_at')
      .all(row.id);
  });

  // ---- Player ----
  // No requireAuth: accounts join with a JWT, guests join with a typed name and
  // receive a per-tournament guest_token (stored only in their browser).
  // Disambiguate a display name against everyone already in the tournament
  // (registrations + manually-added players in state_json), so name-based
  // pairing/highlighting/history can't point at the wrong person. Appends
  // " (2)", " (3)", … on collision (case-insensitive). The offline add path
  // already rejects dup names; self-registration goes through here instead.
  const uniqueName = (t, base) => {
    const taken = new Set();
    for (const r of db.prepare('SELECT display_name FROM registrations WHERE tournament_id = ?').all(t.id)) {
      if (r.display_name) taken.add(r.display_name.toLowerCase());
    }
    try { for (const p of (JSON.parse(t.state_json).players || [])) if (p.name) taken.add(p.name.toLowerCase()); } catch {}
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n < 1000; n++) {
      const cand = `${base} (${n})`.slice(0, 40);
      if (!taken.has(cand.toLowerCase())) return cand;
    }
    return base;
  };

  app.post('/api/tournaments/join', async (req, reply) => {
    const code = (req.body?.code || '').trim().toUpperCase();
    const t = db.prepare('SELECT * FROM tournaments WHERE join_code = ?').get(code);
    if (!t) return reply.code(404).send({ error: 'Código inválido.' });

    let userId = null;
    try { await req.jwtVerify(); userId = req.user.id; } catch { /* guest */ }

    if (userId) {
      // Re-read the account live: a token alone must not let a disabled user join.
      const u = db.prepare('SELECT username, disabled FROM users WHERE id = ?').get(userId);
      if (!u || u.disabled) return reply.code(401).send({ error: 'Sesión inválida.' });
      const uname = u.username; // authoritative display name (case as stored)
      // Resume: if already registered, return that BEFORE the open-registration
      // gate, so a player who lost localStorage / switched devices can recover
      // their pairing even after the TO started the event.
      // Return the STORED display_name (not uname): it may have been disambiguated
      // to "Name (2)" at insert, and that's the name used in state.players/pairings.
      const existing = db.prepare('SELECT player_id, display_name FROM registrations WHERE tournament_id = ? AND user_id = ?').get(t.id, userId);
      if (existing) return { id: t.id, name: t.name, player_id: existing.player_id, display_name: existing.display_name };
      if (t.status !== 'setup') return reply.code(409).send({ error: 'El registro de este torneo ya cerró.' });
      const dn = uniqueName(t, uname);
      const playerId = 'u' + userId + '-' + Date.now().toString(36);
      db.prepare('INSERT INTO registrations (tournament_id, user_id, player_id, display_name) VALUES (?, ?, ?, ?)')
        .run(t.id, userId, playerId, dn);
      return reply.code(201).send({ id: t.id, name: t.name, player_id: playerId, display_name: dn });
    }

    // Guest: no persistent identity, so no resume — registration must be open.
    if (t.status !== 'setup') return reply.code(409).send({ error: 'El registro de este torneo ya cerró.' });
    const name = (req.body?.name || '').trim().slice(0, 40);
    if (!name) return reply.code(400).send({ error: 'Indica un nombre para inscribirte como invitado.' });
    const dn = uniqueName(t, name);
    const guestToken = randomBytes(16).toString('hex');
    const playerId = 'g-' + guestToken.slice(0, 8) + '-' + Date.now().toString(36);
    db.prepare('INSERT INTO registrations (tournament_id, guest_token, player_id, display_name) VALUES (?, ?, ?, ?)')
      .run(t.id, guestToken, playerId, dn);
    return reply.code(201).send({ id: t.id, name: t.name, player_id: playerId, display_name: dn, guest_token: guestToken });
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
      try {
        await req.jwtVerify();
        // Creator, a participant, or ANY active TO (the role administers every event).
        if (req.user.id === t.to_user_id || db.prepare('SELECT 1 FROM registrations WHERE tournament_id = ? AND user_id = ?').get(t.id, req.user.id)) allowed = true;
        else { const u = db.prepare('SELECT role, disabled FROM users WHERE id = ?').get(req.user.id); if (u && !u.disabled && u.role === 'to') allowed = true; }
      } catch {}
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
    return { name: t.name, status: t.status, finished_at: t.finished_at, note: state.note || '', currentRound: state.currentRound, maxRounds: state.maxRounds, standings, rounds };
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
        id: r.id, name: s.name || r.name, code: r.join_code, status: r.status, created_at: r.created_at,
        date: s.eventDate || null, players: (s.players || []).length, note: s.note || '',
        currentRound: s.currentRound || 0, maxRounds: s.maxRounds || 0,
      };
    });
  });

  // Public summary by join code — powers the player's tournament detail card
  // (deep link /u/?torneo=CODE and the active-list card). No state mutation.
  app.get('/api/tournaments/by-code/:code', async (req, reply) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const t = db.prepare('SELECT * FROM tournaments WHERE join_code = ?').get(code);
    if (!t) return reply.code(404).send({ error: 'Código inválido.' });
    let s = {}; try { s = JSON.parse(t.state_json); } catch {}
    return {
      id: t.id, name: s.name || t.name, code: t.join_code, status: t.status,
      date: s.eventDate || null, players: (s.players || []).length, note: s.note || '',
      currentRound: s.currentRound || 0, maxRounds: s.maxRounds || 0,
    };
  });

  // Account-only profile/stats: overall record + win%, per-tournament placement,
  // and head-to-head vs every opponent BY NAME (account, guest, or manual player).
  // Only the logged-in account can see this; non-account opponents can't.
  app.get('/api/me/stats', { preHandler: requireAuth }, async (req) => {
    const uid = req.user.id;
    const myRegs = db.prepare('SELECT tournament_id, player_id FROM registrations WHERE user_id = ?').all(uid);
    const empty = { tournaments: { joined: 0, finished: 0 }, record: { wins: 0, losses: 0, byes: 0, winPct: 0 }, byTournament: [], headToHead: [] };
    if (!myRegs.length) return empty;

    const myPid = new Map(myRegs.map((r) => [r.tournament_id, r.player_id]));
    const ids = myRegs.map((r) => r.tournament_id);
    const ph = ids.map(() => '?').join(',');
    const tourneys = db.prepare(`SELECT id, name, status, created_at, finished_at, state_json FROM tournaments WHERE id IN (${ph})`).all(...ids);

    let wins = 0, losses = 0, byes = 0, finished = 0;
    const byTournament = [];
    const h2h = new Map(); // opponentUserId -> { username, wins, losses }

    for (const t of tourneys) {
      if (t.status === 'finished') finished++;
      let state; try { state = JSON.parse(t.state_json); } catch { continue; }
      const me = myPid.get(t.id);
      const pidToName = new Map((state.players || []).map((p) => [p.id, p.name])); // all players, by name

      let tw = 0, tl = 0;
      for (const round of state.rounds || []) for (const m of round.matches) {
        if (!m.isReported) continue;
        if (m.isBye) { if (m.p1Id === me) { byes++; tw++; } continue; }
        if (m.isLateLoss) { if (m.p1Id === me) { losses++; tl++; } continue; }
        if (m.p1Id !== me && m.p2Id !== me) continue;
        const iAmP1 = m.p1Id === me;
        const oppId = iAmP1 ? m.p2Id : m.p1Id;
        // Head-to-head keyed by opponent name (account, guest, or manual TO player).
        const recordH2H = (won) => {
          if (!oppId) return;
          const oname = pidToName.get(oppId) || 'Rival';
          const e = h2h.get(oname) || { username: oname, wins: 0, losses: 0 };
          if (won) e.wins++; else e.losses++;
          h2h.set(oname, e);
        };
        if (m.result === 'doubleLoss') { losses++; tl++; recordH2H(false); continue; }
        if (m.result !== 'p1' && m.result !== 'p2') continue;
        const iWon = (m.result === 'p1') === iAmP1;
        if (iWon) { wins++; tw++; } else { losses++; tl++; }
        recordH2H(iWon);
      }

      let rank = null;
      try { const idx = finalStandings(state).findIndex((s) => s.id === me); if (idx >= 0) rank = idx + 1; } catch {}
      byTournament.push({ id: t.id, name: t.name, status: t.status, created_at: t.created_at, finished_at: t.finished_at, wins: tw, losses: tl, rank, total: (state.players || []).length });
    }

    byTournament.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    const decided = wins + losses;
    return {
      tournaments: { joined: tourneys.length, finished },
      record: { wins, losses, byes, winPct: decided ? Math.round((wins / decided) * 100) : 0 },
      byTournament,
      headToHead: [...h2h.values()].sort((a, b) => (b.wins + b.losses) - (a.wins + a.losses)),
    };
  });
}
