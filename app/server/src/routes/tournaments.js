/* Tournament routes. TO writes are authoritative (PUT state_json); player
 * endpoints are read-only except join. Live pairing = players poll
 * GET /api/tournaments/:id/me. Pairing/standings are computed client-side from
 * the same state blob, so the server just persists and serves it. */
import { randomBytes } from 'node:crypto';
import { requireAuth, requireOrganizer } from '../auth.js';
import { finalStandings } from '../lib/tiebreak.js';
import { computeLeaderboard, MIN_GAMES as LB_MIN_GAMES } from '../lib/leaderboard.js';
import { parseDeckString } from '../lib/decks-api.js';
import { checkDeckLegality } from '../lib/deck-legality.js';
import { aggregateDeckStats } from '../lib/deck-stats.js';

/**
 * Generates a 5-character tournament join code.
 * @return {string} An uppercase code that avoids ambiguous characters.
 */
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

/**
 * Registers tournament routes and related leaderboard endpoints.
 * @param {object} app - Fastify application instance with database access.
 */
export default async function tournamentRoutes(app) {
  const db = app.db;

  // Elo K-factor (rating volatility), admin-tunable via the settings table (#91).
  // Bigger K = larger swings. Changing it re-rates the season on the next recompute
  // (the board is derived from match history, not stored). Clamps to a sane range.
  const eloK = () => {
    try { const r = db.prepare("SELECT value FROM settings WHERE key = 'elo_k'").get(); const n = parseInt(r && r.value, 10); if (Number.isFinite(n) && n >= 1 && n <= 100) return n; } catch {}
    return 24;
  };

  // Single source of truth for late-entry eligibility: the event is running and
  // at least one more round can be generated. Used by /join (the gate) AND the
  // read endpoints (so the UI never advertises a join the server would reject).
  const isLateOpen = (s) => !!s.started && !s.finished && (s.rounds || []).length < (s.maxRounds || 0);

  // Console endpoints gate on requireOrganizer ('to' or 'casual'). An official 'to'
  // administers ANY tournament (the role is system-wide); a 'casual' organizer only
  // its own (canManage). `to_user_id` is "who created it" — meaningful for casual scoping.
  const findOr404 = (id, reply) => {
    const row = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(id);
    if (!row) { reply.code(404).send({ error: 'Torneo no encontrado.' }); return null; }
    return row;
  };
  // An official 'to' administers ANY tournament; a 'casual' organizer only its own.
  const canManage = (req, row) => req.userRole === 'to' || row.to_user_id === req.user.id;

  // Resolve the caller's participant slot in tournament t: account via JWT, or guest
  // via x-guest-token. Returns the player_id or null. (Shared by /me and reporting.)
  async function participantId(req, t) {
    let pid = null;
    try { await req.jwtVerify(); const r = db.prepare('SELECT player_id FROM registrations WHERE tournament_id = ? AND user_id = ?').get(t.id, req.user.id); if (r) pid = r.player_id; } catch { /* not an account */ }
    if (!pid) { const gt = req.headers['x-guest-token']; if (gt) { const r = db.prepare('SELECT player_id FROM registrations WHERE tournament_id = ? AND guest_token = ?').get(t.id, gt); if (r) pid = r.player_id; } }
    return pid;
  }
  // The player's current-round, reportable (non-bye, two-player) match in `state`.
  function currentMatchFor(state, playerId) {
    const round = (state.rounds || []).find((r) => r.roundNumber === state.currentRound);
    if (!round) return null;
    const m = (round.matches || []).find((x) => (x.p1Id === playerId || x.p2Id === playerId) && x.p2Id && !x.isBye && !x.isLateLoss);
    if (!m) return null;
    return { match: m, roundNumber: round.roundNumber, isP1: m.p1Id === playerId, key: [m.p1Id, m.p2Id].slice().sort().join('|') };
  }

  // ---- TO (owner) ----
  app.post('/api/tournaments', { preHandler: requireOrganizer }, async (req, reply) => {
    const name = (req.body?.name || '').trim() || 'Torneo';
    // Casual organizers can ONLY create unranked events; official TOs choose (default ranked).
    const ranked = req.userRole === 'casual' ? 0 : (req.body?.ranked === false ? 0 : 1);
    let code = genJoinCode();
    while (db.prepare('SELECT 1 FROM tournaments WHERE join_code = ?').get(code)) code = genJoinCode();
    const info = db
      .prepare('INSERT INTO tournaments (to_user_id, name, join_code, status, state_json, ranked) VALUES (?, ?, ?, ?, ?, ?)')
      .run(req.user.id, name, code, 'setup', emptyStateJson(), ranked);
    return reply.code(201).send({ id: info.lastInsertRowid, name, join_code: code, status: 'setup', ranked: !!ranked });
  });

  // Admin panel: EVERY tournament (any TO administers any event), newest-active
  // first. Includes round progress, timer state and creator so the TO can pick.
  app.get('/api/tournaments', { preHandler: requireOrganizer }, async (req) => {
    const mineOnly = req.userRole === 'casual'; // casual organizers see only their own events
    const sql = `SELECT t.id, t.name, t.join_code, t.status, t.created_at, t.finished_at, t.state_json, t.ranked, u.username AS owner
                 FROM tournaments t LEFT JOIN users u ON u.id = t.to_user_id
                 ${mineOnly ? 'WHERE t.to_user_id = ?' : ''}
                 ORDER BY (t.status = 'finished') ASC, t.created_at DESC`;
    const rows = mineOnly ? db.prepare(sql).all(req.user.id) : db.prepare(sql).all();
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
        created_at: r.created_at, finished_at: r.finished_at, ranked: !!r.ranked,
        players: (s.players || []).length, currentRound: s.currentRound || 0, maxRounds: s.maxRounds || 0,
        timer,
      };
    });
  });

  app.get('/api/tournaments/:id', { preHandler: requireOrganizer }, async (req, reply) => {
    const row = findOr404(Number(req.params.id), reply);
    if (!row) return;
    if (!canManage(req, row)) return reply.code(403).send({ error: 'No puedes administrar este torneo.' });
    return { id: row.id, name: row.name, join_code: row.join_code, status: row.status, ranked: !!row.ranked, state: JSON.parse(row.state_json) };
  });

  app.put('/api/tournaments/:id', { preHandler: requireOrganizer }, async (req, reply) => {
    const row = findOr404(Number(req.params.id), reply);
    if (!row) return;
    if (!canManage(req, row)) return reply.code(403).send({ error: 'No puedes administrar este torneo.' });
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
    // The name is DURABLE metadata: keep it in the tournaments.name column (not
    // only in state_json, which is mutable). The TO's renames ride along here.
    const name = (typeof req.body?.name === 'string' && req.body.name.trim()) ? req.body.name.trim().slice(0, 80) : null;
    if (name && name !== row.name) db.prepare('UPDATE tournaments SET name = ? WHERE id = ?').run(name, row.id);
    // `ranked` is only editable before the event starts — never retroactively, so a
    // finished/in-progress tournament can't be reclassified and shift past ratings.
    if (typeof req.body?.ranked === 'boolean' && status === 'setup') {
      const r = req.userRole === 'casual' ? 0 : (req.body.ranked ? 1 : 0); // casual can never set ranked
      db.prepare('UPDATE tournaments SET ranked = ? WHERE id = ?').run(r, row.id);
    }
    return { ok: true, status };
  });

  app.post('/api/tournaments/:id/finish', { preHandler: requireOrganizer }, async (req, reply) => {
    const row = findOr404(Number(req.params.id), reply);
    if (!row) return;
    if (!canManage(req, row)) return reply.code(403).send({ error: 'No puedes administrar este torneo.' });
    const state = JSON.parse(row.state_json);
    state.finished = true;
    db.prepare("UPDATE tournaments SET state_json = ?, status = 'finished', finished_at = datetime('now') WHERE id = ?")
      .run(JSON.stringify(state), row.id);
    return { ok: true };
  });

  app.get('/api/tournaments/:id/registrations', { preHandler: requireOrganizer }, async (req, reply) => {
    const row = findOr404(Number(req.params.id), reply);
    if (!row) return;
    if (!canManage(req, row)) return reply.code(403).send({ error: 'No puedes administrar este torneo.' });
    // display_name covers both accounts and guests; guest_token is never exposed.
    const regs = db
      .prepare('SELECT player_id, display_name, user_id, joined_at FROM registrations WHERE tournament_id = ? ORDER BY joined_at')
      .all(row.id);
    // Attach each account player's current-season Elo so the console can offer
    // Elo-seed matchmaking (#39). Guests / TO-added / unrated → null (client = base).
    const ratings = seasonRatings();
    return regs.map((r) => ({ ...r, rating: (r.user_id != null && ratings.has(r.user_id)) ? ratings.get(r.user_id) : null }));
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

    // Registration is open during setup OR as a LATE ENTRY while the event runs
    // and rounds remain (rounds.length < maxRounds). The TO console absorbs late
    // entries with a loss per already-played round (official rule).
    let st = {}; try { st = JSON.parse(t.state_json); } catch {}
    const lateOpen = isLateOpen(st);
    const open = t.status === 'setup' || lateOpen;
    const closedMsg = st.finished ? 'Este torneo ya finalizó.' : 'El registro de este torneo ya cerró.';

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
      const existing = db.prepare('SELECT player_id, display_name, deck_id FROM registrations WHERE tournament_id = ? AND user_id = ?').get(t.id, userId);

      // Ranked events require a registered, LEGAL deck (#109). Legality is enforced ONLY
      // at (open) registration, never at deck creation — an illegal deck can live in Mis
      // Decks, it just can't be registered for ranked. Resume/closed checks come first so a
      // saved registration is returned WITHOUT touching the decks API (parse/legality).
      const wantedDeck = (t.ranked && /^\d+$/.test(String(req.body?.deck_id ?? ''))) ? Number(req.body.deck_id) : null;

      // Validate the chosen ranked deck and run `apply(deckId, cardsJson)` on success.
      // Returns an error reply to send, or null on success. Fails CLOSED if legality
      // can't be checked. The parsed codes (cardsJson) are snapshotted for deck stats (#108).
      const useRankedDeck = async (apply) => {
        const deck = db.prepare('SELECT deck_string FROM user_decks WHERE id = ? AND user_id = ?').get(wantedDeck, userId);
        if (!deck) return reply.code(400).send({ error: 'Ese deck no existe o no es tuyo.' });
        let cards;
        try { cards = await parseDeckString(deck.deck_string); }
        catch (e) { return reply.code(502).send({ error: 'No se pudo leer el decklist para validarlo. Intenta de nuevo.' }); }
        let result;
        try { result = await checkDeckLegality(cards); }
        catch (e) { return reply.code(502).send({ code: e.code || 'legality_unavailable', error: e.message || 'No se pudo verificar la legalidad del deck. Intenta de nuevo.' }); }
        if (!result.legal) return reply.code(422).send({ code: 'deck_illegal', error: 'Ese deck no es legal para formato avanzado.', violations: result.violations });
        apply(wantedDeck, JSON.stringify({ main: cards.main || [], extra: cards.extra || [], side: cards.side || [] }));
        return null;
      };

      // Resume an existing registration — works even after registration closes.
      if (existing) {
        // Ranked + still open: switch to (or first set) a chosen deck.
        if (t.ranked && open && wantedDeck && wantedDeck !== existing.deck_id) {
          const err = await useRankedDeck((id, cj) => db.prepare('UPDATE registrations SET deck_id = ?, cards_json = ? WHERE tournament_id = ? AND user_id = ?').run(id, cj, t.id, userId));
          if (err) return err;
          return { id: t.id, name: t.name, player_id: existing.player_id, display_name: existing.display_name, deck_id: wantedDeck };
        }
        // Ranked + open but still no deck on file and none chosen → must pick one.
        if (t.ranked && open && !existing.deck_id && !wantedDeck)
          return reply.code(409).send({ code: 'ranked_requires_deck', name: t.name, error: 'Este torneo es clasificatorio: elige un deck para registrarte.' });
        return { id: t.id, name: t.name, player_id: existing.player_id, display_name: existing.display_name, deck_id: existing.deck_id };
      }

      // Fresh registration — must be open. (Checked before any deck parse/legality work.)
      if (!open) return reply.code(409).send({ error: closedMsg });
      let deckId = null, cardsJson = null;
      if (t.ranked) {
        if (!wantedDeck)
          return reply.code(409).send({ code: 'ranked_requires_deck', name: t.name, error: 'Este torneo es clasificatorio: elige un deck para registrarte.' });
        const err = await useRankedDeck((id, cj) => { deckId = id; cardsJson = cj; });
        if (err) return err;
      }
      const dn = uniqueName(t, uname);
      const playerId = 'u' + userId + '-' + Date.now().toString(36);
      db.prepare('INSERT INTO registrations (tournament_id, user_id, player_id, display_name, deck_id, cards_json) VALUES (?, ?, ?, ?, ?, ?)')
        .run(t.id, userId, playerId, dn, deckId, cardsJson);
      return reply.code(201).send({ id: t.id, name: t.name, player_id: playerId, display_name: dn, deck_id: deckId, late: lateOpen });
    }

    // Guest: identity is the per-tournament guest_token saved in the browser. If this
    // browser already holds a token for THIS tournament, RESUME that registration
    // instead of inserting a duplicate (mirrors the account resume above) — fixes the
    // "(1)/(2)" duplicate guests created on re-confirmation. Resolved before the open
    // gate so a guest can recover their slot even after registration closed.
    const gt = req.headers['x-guest-token'];
    if (gt) {
      const existing = db.prepare('SELECT player_id, display_name FROM registrations WHERE tournament_id = ? AND guest_token = ?').get(t.id, gt);
      if (existing) return { id: t.id, name: t.name, player_id: existing.player_id, display_name: existing.display_name, guest_token: gt };
    }

    // Ranked tournaments require an account: a guest has no persistent identity or
    // Elo, so they can't meaningfully play a rated event. Block a FRESH guest
    // registration (an existing guest_token still RESUMES above, grandfathering any
    // slot created before this rule). Casual events (ranked = 0) still allow guests.
    if (t.ranked) return reply.code(403).send({ error: 'Los torneos clasificatorios requieren una cuenta. Inicia sesión o crea una para registrarte.', code: 'ranked_requires_account' });

    // No matching token → a fresh guest registration (registration must be open).
    if (!open) return reply.code(409).send({ error: closedMsg });
    const name = (req.body?.name || '').trim().slice(0, 40);
    if (!name) return reply.code(400).send({ error: 'Indica un nombre para inscribirte como invitado.' });
    const dn = uniqueName(t, name);
    const guestToken = randomBytes(16).toString('hex');
    const playerId = 'g-' + guestToken.slice(0, 8) + '-' + Date.now().toString(36);
    db.prepare('INSERT INTO registrations (tournament_id, guest_token, player_id, display_name) VALUES (?, ?, ?, ?)')
      .run(t.id, guestToken, playerId, dn);
    return reply.code(201).send({ id: t.id, name: t.name, player_id: playerId, display_name: dn, guest_token: guestToken, late: lateOpen });
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
        const table = round.matches.filter((x) => !x.isBye && !x.isLateLoss).indexOf(m) + 1;
        pairing = {
          isBye: !!m.isBye,
          lateLoss: !!m.isLateLoss,                 // admin loss for joining mid-event
          table: (m.isBye || m.isLateLoss) ? null : table,
          opponent: opp ? opp.name : null,
          result: m.result,
          reported: !!m.isReported,
        };
        // Pending player-filed report for this match (so the UI can show
        // "waiting for confirmation" / "confirm your rival's result").
        if (!m.isBye && !m.isLateLoss && m.p2Id && !m.isReported) {
          const key = [m.p1Id, m.p2Id].slice().sort().join('|');
          const rep = db.prepare('SELECT reporter_id, result, confirmed FROM result_reports WHERE tournament_id = ? AND round_number = ? AND match_key = ?').get(t.id, round.roundNumber, key);
          if (rep) pairing.report = {
            mine: rep.reporter_id === reg.player_id,                 // did I file it?
            doubleLoss: rep.result === 'doubleLoss',
            iWon: rep.result !== 'doubleLoss' && ((rep.result === 'p1') === (m.p1Id === reg.player_id)),
            confirmed: !!rep.confirmed,
          };
        }
      }
    }
    // inEvent: is this participant still in the organizer's player list? Used by the
    // player page to detect a removal (a registration persists when the TO removes a
    // player from state_json, so /me wouldn't otherwise 403).
    const inEvent = (state.players || []).some((p) => p.id === reg.player_id);

    // Personal match history for this tournament: this participant's decided matches
    // up to the current round (round · opponent · outcome). Drives the small summary
    // under the live pairing box on the player page.
    const history = [];
    for (const r of (state.rounds || [])) {
      if (r.roundNumber > state.currentRound) continue;
      const mm = (r.matches || []).find((x) => x.p1Id === reg.player_id || x.p2Id === reg.player_id);
      if (!mm) continue;
      if (mm.isBye) { history.push({ round: r.roundNumber, opponent: null, outcome: 'bye' }); continue; }
      if (mm.isLateLoss || mm.result === 'lateLoss') { history.push({ round: r.roundNumber, opponent: null, outcome: 'lateLoss' }); continue; }
      const oppId = mm.p1Id === reg.player_id ? mm.p2Id : mm.p1Id;
      const opp = oppId ? state.players.find((p) => p.id === oppId) : null;
      let outcome;
      if (mm.result === 'doubleLoss') outcome = 'doubleLoss';
      else if (mm.result === 'p1' || mm.result === 'p2') outcome = ((mm.result === 'p1') === (mm.p1Id === reg.player_id)) ? 'win' : 'loss';
      else continue; // not yet decided — it's the live box, not history
      history.push({ round: r.roundNumber, opponent: opp ? opp.name : null, outcome });
    }

    return { name: t.name, status: t.status, currentRound: state.currentRound, maxRounds: state.maxRounds, pairing, inEvent, history };
  });

  // A participant withdraws their OWN registration. SETUP only — once the event
  // starts they're in the bracket (the TO handles drops). Deleting the row lets the
  // console's absorb reconcile the removal from the roster (#72). Identity via JWT
  // (account) or x-guest-token (guest), resolved by participantId.
  app.delete('/api/tournaments/:id/registration', async (req, reply) => {
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'Torneo no encontrado.' });
    if (t.status !== 'setup') return reply.code(409).send({ error: 'El torneo ya inició; pide al organizador que te retire.' });
    const pid = await participantId(req, t);
    if (!pid) return reply.code(404).send({ error: 'No estás inscrito en este torneo.' });
    db.prepare('DELETE FROM registrations WHERE tournament_id = ? AND player_id = ?').run(t.id, pid);
    return { ok: true };
  });

  // ---- Player-driven result reporting -----------------------------------
  // Players never write state_json. The WINNER files a claim (or either player a
  // double-loss); the OPPONENT confirms; the TO console absorbs confirmed claims
  // into state_json. All identity + match-membership checks run here on the server.

  // Winner reports the result of their current-round match. body: { outcome:'win'|'doubleLoss' }
  app.post('/api/tournaments/:id/report', async (req, reply) => {
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'Torneo no encontrado.' });
    if (t.status !== 'running') return reply.code(409).send({ error: 'El torneo no está en curso.' });
    const pid = await participantId(req, t);
    if (!pid) return reply.code(403).send({ error: 'No estás inscrito en este torneo.' });
    const cm = currentMatchFor(JSON.parse(t.state_json), pid);
    if (!cm) return reply.code(409).send({ error: 'No tienes una partida activa esta ronda.' });
    if (cm.match.isReported) return reply.code(409).send({ error: 'Esta partida ya tiene resultado.' });
    const outcome = req.body?.outcome;
    let result;
    if (outcome === 'win') result = cm.isP1 ? 'p1' : 'p2';   // you can ONLY report that YOU won
    else if (outcome === 'doubleLoss') result = 'doubleLoss';
    else return reply.code(400).send({ error: 'Resultado inválido.' });
    // A new claim replaces any pending one and resets confirmation (corrections /
    // disputes → the opponent must (re)confirm).
    db.prepare(`INSERT INTO result_reports (tournament_id, round_number, match_key, reporter_id, result)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(tournament_id, round_number, match_key)
                DO UPDATE SET reporter_id=excluded.reporter_id, result=excluded.result, confirmed=0, confirmer_id=NULL, confirmed_at=NULL, created_at=datetime('now')`)
      .run(t.id, cm.roundNumber, cm.key, pid, result);
    return { ok: true, result, awaitingConfirmation: true };
  });

  // Opponent confirms (or rejects) the pending claim. body: { accept:true|false }
  app.post('/api/tournaments/:id/report/confirm', async (req, reply) => {
    const t = db.prepare('SELECT * FROM tournaments WHERE id = ?').get(Number(req.params.id));
    if (!t) return reply.code(404).send({ error: 'Torneo no encontrado.' });
    if (t.status !== 'running') return reply.code(409).send({ error: 'El torneo no está en curso.' });
    const pid = await participantId(req, t);
    if (!pid) return reply.code(403).send({ error: 'No estás inscrito en este torneo.' });
    const cm = currentMatchFor(JSON.parse(t.state_json), pid);
    if (!cm) return reply.code(409).send({ error: 'No tienes una partida activa esta ronda.' });
    const rep = db.prepare('SELECT * FROM result_reports WHERE tournament_id = ? AND round_number = ? AND match_key = ?').get(t.id, cm.roundNumber, cm.key);
    if (!rep) return reply.code(409).send({ error: 'No hay un resultado por confirmar.' });
    if (rep.reporter_id === pid) return reply.code(409).send({ error: 'Quien reporta no confirma; espera a tu rival.' });
    if (req.body?.accept === false) {
      db.prepare('DELETE FROM result_reports WHERE id = ?').run(rep.id);
      return { ok: true, confirmed: false, rejected: true };
    }
    db.prepare("UPDATE result_reports SET confirmed=1, confirmer_id=?, confirmed_at=datetime('now') WHERE id = ?").run(pid, rep.id);
    return { ok: true, confirmed: true };
  });

  // TO console: confirmed reports to absorb into state_json (then DELETE applied ones).
  app.get('/api/tournaments/:id/reports', { preHandler: requireOrganizer }, async (req, reply) => {
    const row = findOr404(Number(req.params.id), reply);
    if (!row) return;
    if (!canManage(req, row)) return reply.code(403).send({ error: 'No puedes administrar este torneo.' });
    return db.prepare('SELECT id, round_number, match_key, result FROM result_reports WHERE tournament_id = ? AND confirmed = 1 ORDER BY confirmed_at').all(row.id);
  });

  app.delete('/api/tournaments/:id/reports/:rid', { preHandler: requireOrganizer }, async (req, reply) => {
    const row = findOr404(Number(req.params.id), reply);
    if (!row) return;
    if (!canManage(req, row)) return reply.code(403).send({ error: 'No puedes administrar este torneo.' });
    db.prepare('DELETE FROM result_reports WHERE id = ? AND tournament_id = ?').run(Number(req.params.rid), row.id);
    return { ok: true };
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
    return { name: t.name, status: t.status, ranked: !!t.ranked, finished_at: t.finished_at, date: state.eventDate || null, note: state.note || '', currentRound: state.currentRound, maxRounds: state.maxRounds, standings, rounds };
  });

  // Public list of active tournaments (accepting registration or running) so
  // players can pick one. Join codes are intentionally shown.
  app.get('/api/tournaments/active', async () => {
    const rows = db
      .prepare("SELECT id, name, join_code, status, created_at, state_json, ranked FROM tournaments WHERE status IN ('setup','running') ORDER BY created_at DESC LIMIT 50")
      .all();
    return rows.map((r) => {
      let s = {}; try { s = JSON.parse(r.state_json); } catch {}
      return {
        id: r.id, name: r.name, code: r.join_code, status: r.status, created_at: r.created_at, ranked: !!r.ranked,
        date: s.eventDate || null, players: (s.players || []).length, note: s.note || '',
        currentRound: s.currentRound || 0, maxRounds: s.maxRounds || 0, lateOpen: isLateOpen(s),
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
      id: t.id, name: t.name, code: t.join_code, status: t.status, ranked: !!t.ranked,
      date: s.eventDate || null, players: (s.players || []).length, note: s.note || '',
      currentRound: s.currentRound || 0, maxRounds: s.maxRounds || 0, lateOpen: isLateOpen(s),
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

  // ---- Leaderboard (Elo) helpers ----------------------------------------
  const monthOf = (t) => String(t.finished_at || t.created_at || '').slice(0, 7); // YYYY-MM
  // Only RANKED finished tournaments feed the Elo engine; casual events are excluded
  // here, so they never affect the public board, season standings, or /me/elo.
  const allFinished = () => db.prepare(`SELECT id, name, finished_at, created_at, state_json FROM tournaments
                                        WHERE status = 'finished' AND ranked = 1 ORDER BY COALESCE(finished_at, created_at) ASC`).all();
  // Build computeLeaderboard rows (parsed state + player_id→account map) for a set of
  // finished tournaments. Guests / TO-added players (no user_id) are left unmapped.
  // name/date ride along so the per-match log can show where each game was played.
  function lbRows(tourneys) {
    const users = new Map(db.prepare('SELECT id, username FROM users').all().map((u) => [u.id, u.username]));
    const rows = [];
    for (const t of tourneys) {
      let state; try { state = JSON.parse(t.state_json); } catch { continue; }
      const pidMap = new Map();
      for (const r of db.prepare('SELECT player_id, user_id FROM registrations WHERE tournament_id = ? AND user_id IS NOT NULL').all(t.id)) {
        pidMap.set(r.player_id, { userId: r.user_id, username: users.get(r.user_id) || ('user#' + r.user_id) });
      }
      if (pidMap.size) rows.push({ id: t.id, name: t.name, date: t.finished_at || t.created_at, state, pidMap });
    }
    return rows;
  }

  // Current-season Elo per account (minGames:0, so even <3-game players get a live
  // rating), briefly memoized — feeds the `rating` attached to /registrations for
  // the optional Elo-seed matchmaking (#39). Ratings only shift when a tournament
  // finishes, so a 30s memo is ample even under the console's setup-phase polling.
  let _seedRatings = { at: 0, month: '', k: 0, map: null };
  function seasonRatings() {
    const month = new Date().toISOString().slice(0, 7);
    const k = eloK();
    if (_seedRatings.map && _seedRatings.month === month && _seedRatings.k === k && Date.now() - _seedRatings.at < 30000) return _seedRatings.map;
    const map = new Map(computeLeaderboard(lbRows(allFinished().filter((t) => monthOf(t) === month)), { minGames: 0, k }).map((e) => [e.userId, e.rating]));
    _seedRatings = { at: Date.now(), month, k, map };
    return map;
  }

  // Public season leaderboard for one calendar month (default current). Recomputed
  // fresh per month so the board stays contestable; small memo to avoid re-scans.
  const _lbCache = {};
  app.get('/api/leaderboard', async (req) => {
    const month = /^\d{4}-\d{2}$/.test((req.query && req.query.month) || '') ? req.query.month : new Date().toISOString().slice(0, 7);
    const k = eloK();
    const hit = _lbCache[month];
    if (hit && hit.k === k && Date.now() - hit.at < 30000) return hit.data; // K-aware: an admin K change invalidates the memo
    const rows = lbRows(allFinished().filter((t) => monthOf(t) === month));
    const data = { month, players: computeLeaderboard(rows, { k }) };
    _lbCache[month] = { at: Date.now(), k, data };
    return data;
  });

  // The signed-in player's Elo detail: this season's match-by-match log (with the
  // ±points each game gave, and which didn't count + why) plus a recap of past
  // seasons (placement + final rating per month they played).
  app.get('/api/me/elo', { preHandler: requireAuth }, async (req) => {
    const uid = req.user.id;
    const finished = allFinished();
    const myIds = new Set(db.prepare('SELECT tournament_id FROM registrations WHERE user_id = ?').all(uid).map((r) => r.tournament_id));
    const myMonths = [...new Set(finished.filter((t) => myIds.has(t.id)).map(monthOf))].filter(Boolean).sort().reverse();
    const cur = new Date().toISOString().slice(0, 7);

    const k = eloK();
    const log = [];
    const curPlayers = computeLeaderboard(lbRows(finished.filter((t) => monthOf(t) === cur)), { trackUser: uid, log, k });
    const meCur = curPlayers.find((p) => p.userId === uid) || null;

    const pastSeasons = [];
    for (const m of myMonths) {
      if (m === cur) continue;
      const e = computeLeaderboard(lbRows(finished.filter((t) => monthOf(t) === m)), { k }).find((p) => p.userId === uid);
      if (e) pastSeasons.push({ month: m, rank: e.rank, rating: e.rating, wins: e.wins, losses: e.losses });
    }

    return {
      season: cur,
      minGames: LB_MIN_GAMES,
      current: meCur ? { rank: meCur.rank, rating: meCur.rating, wins: meCur.wins, losses: meCur.losses, games: meCur.games } : null,
      matches: log,        // chronological; counted entries carry delta/before/after, others carry reason
      pastSeasons,
    };
  });

  // Per-account deck statistics for one season (#108): favourite deck, summary, and
  // top cards by play count / winrate — built ONLY from the player's ranked, finished
  // registrations + the deck codes snapshotted at registration (no external call). Card
  // names/art are resolved client-side. season = YYYY-MM (default current month).
  app.get('/api/me/deck-stats', { preHandler: requireAuth }, async (req) => {
    const uid = req.user.id;
    const cur = new Date().toISOString().slice(0, 7);
    const season = /^\d{4}-\d{2}$/.test((req.query && req.query.season) || '') ? req.query.season : cur;
    const safe = (s) => { try { return JSON.parse(s); } catch { return null; } };
    const regs = db.prepare(`SELECT t.id AS tid, t.finished_at, t.created_at, t.state_json,
        r.player_id, r.deck_id, r.cards_json, d.name AS deck_name, d.cover_url, d.cover_passcode
      FROM registrations r
      JOIN tournaments t ON t.id = r.tournament_id
      LEFT JOIN user_decks d ON d.id = r.deck_id
      WHERE r.user_id = ? AND t.ranked = 1 AND t.status = 'finished'`).all(uid);
    const monthOfRow = (x) => String(x.finished_at || x.created_at || '').slice(0, 7);
    const seasons = [...new Set(regs.map(monthOfRow))].filter(Boolean).sort().reverse();
    const rows = regs.filter((x) => monthOfRow(x) === season).map((x) => ({
      tournamentId: x.tid, playerId: x.player_id, deckId: x.deck_id,
      deckName: x.deck_name, coverUrl: x.cover_url, coverPasscode: x.cover_passcode,
      state: safe(x.state_json) || {}, cards: x.cards_json ? safe(x.cards_json) : null,
    }));
    return { season, seasons: seasons.length ? seasons : [cur], ...aggregateDeckStats(rows) };
  });
}
