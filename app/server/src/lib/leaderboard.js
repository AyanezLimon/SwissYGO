/* Cross-tournament Elo leaderboard + per-user match log.
 *
 * Ranks ACCOUNT players (guests have no persistent identity) by an Elo rating
 * computed from their head-to-head match results. Elo is chosen so the board
 * rewards consistent skill yet stays contestable: a loss drops you, beating a
 * strong player lifts you a lot, and a newcomer can climb fast — no permanent
 * throne. The public board is per-SEASON (one calendar month), recomputed fresh.
 *
 * Only decisive account-vs-account matches move the rating. Byes, late-entry
 * admin losses, double-losses, unreported matches, and games against guests /
 * TO-added players (no account to rate against) are skipped — but for the
 * tracked user they are still recorded in the match log (counted:false + reason)
 * so a player can see exactly which games gave points and which didn't.
 */
const BASE = 1200;
const K = 24;
export const MIN_GAMES = 3;

// rows: [{ id, state (parsed), pidMap: Map<player_id, {userId, username}> }], ordered
// chronologically (oldest finished first).
// opts.trackUser: userId whose per-match deltas to record into opts.log (optional).
// Returns the ranked player entries (unchanged shape regardless of tracking).
export function computeLeaderboard(rows, opts = {}) {
  const base = opts.base ?? BASE;
  const k = opts.k ?? K;
  const minGames = opts.minGames ?? MIN_GAMES;
  const trackUser = opts.trackUser ?? null;
  const log = opts.log; // optional array to fill with the tracked user's matches

  const rating = new Map();   // userId -> number
  const meta = new Map();     // userId -> { username, wins, losses, games, tourneys:Set }
  const ratingOf = (uid) => (rating.has(uid) ? rating.get(uid) : base);
  const metaOf = (uid, username) => {
    let m = meta.get(uid);
    if (!m) { m = { username, wins: 0, losses: 0, games: 0, tourneys: new Set() }; meta.set(uid, m); }
    if (username) m.username = username;
    return m;
  };

  for (const t of rows) {
    const names = new Map((t.state.players || []).map((p) => [p.id, p.name])); // for opponent labels
    for (const round of t.state.rounds || []) {
      for (const m of round.matches || []) {
        if (!m.isReported) continue; // not played yet
        const a = t.pidMap.get(m.p1Id);
        const b = t.pidMap.get(m.p2Id);
        const decisive = (m.result === 'p1' || m.result === 'p2') && !m.isBye && !m.isLateLoss;
        const rated = decisive && a && b; // both sides are account players
        const involvesUser = trackUser != null && ((a && a.userId === trackUser) || (b && b.userId === trackUser));

        if (rated) {
          const Ra = ratingOf(a.userId), Rb = ratingOf(b.userId);
          const Ea = 1 / (1 + Math.pow(10, (Rb - Ra) / 400));
          const Sa = m.result === 'p1' ? 1 : 0;
          const Ra2 = Ra + k * (Sa - Ea);
          const Rb2 = Rb + k * ((1 - Sa) - (1 - Ea));
          rating.set(a.userId, Ra2); rating.set(b.userId, Rb2);
          const ma = metaOf(a.userId, a.username), mb = metaOf(b.userId, b.username);
          ma.games++; mb.games++; ma.tourneys.add(t.id); mb.tourneys.add(t.id);
          if (Sa === 1) { ma.wins++; mb.losses++; } else { ma.losses++; mb.wins++; }
          if (log && involvesUser) {
            const meIsA = a.userId === trackUser;
            const before = meIsA ? Ra : Rb, after = meIsA ? Ra2 : Rb2;
            log.push({
              tournamentId: t.id, tournament: t.name || null, date: t.date || null,
              opponent: names.get(meIsA ? m.p2Id : m.p1Id) || 'Rival',
              counted: true, won: meIsA ? (m.result === 'p1') : (m.result === 'p2'),
              before: Math.round(before), after: Math.round(after), delta: Math.round(after - before),
            });
          }
        } else if (log && involvesUser) {
          const meIsA = a && a.userId === trackUser;
          const reason = m.isBye ? 'bye' : m.isLateLoss ? 'lateLoss'
            : m.result === 'doubleLoss' ? 'doubleLoss'
            : (!a || !b) ? 'guest' : 'other';
          log.push({ tournamentId: t.id, tournament: t.name || null, date: t.date || null, opponent: names.get(meIsA ? m.p2Id : m.p1Id) || null, counted: false, reason });
        }
      }
    }
  }

  const out = [];
  for (const [uid, m] of meta) {
    if (m.games < minGames) continue;
    out.push({ userId: uid, username: m.username, rating: Math.round(ratingOf(uid)), wins: m.wins, losses: m.losses, games: m.games, tournaments: m.tourneys.size });
  }
  out.sort((x, y) => (y.rating - x.rating) || (y.games - x.games) || x.username.localeCompare(y.username));
  return out.map((e, i) => ({ rank: i + 1, ...e }));
}
