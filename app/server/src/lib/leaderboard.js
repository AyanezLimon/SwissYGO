/* Cross-tournament Elo leaderboard.
 *
 * Ranks ACCOUNT players (guests have no persistent identity) by an Elo rating
 * computed from their head-to-head match results across finished tournaments.
 * Elo is chosen so the board rewards consistent skill yet stays contestable: a
 * loss drops you, beating a strong player lifts you a lot, and a newcomer can
 * climb fast — no permanent throne. The "season" window recomputes from scratch
 * over a single period, giving everyone a fresh start.
 *
 * Only decisive account-vs-account matches count. Byes, late-entry admin losses,
 * double-losses, unreported matches, and games against guests / TO-added players
 * (no account to exchange rating with) are skipped.
 */
const BASE = 1200;
const K = 24;
const MIN_GAMES = 3;

// rows: [{ id, state (parsed), pidMap: Map<player_id, {userId, username}> }], already
// ordered chronologically (oldest finished first). Returns ranked player entries.
export function computeLeaderboard(rows, opts = {}) {
  const base = opts.base ?? BASE;
  const k = opts.k ?? K;
  const minGames = opts.minGames ?? MIN_GAMES;

  const rating = new Map();   // userId -> number
  const meta = new Map();     // userId -> { username, wins, losses, games, tourneys:Set }
  const ratingOf = (uid) => (rating.has(uid) ? rating.get(uid) : base);
  const metaOf = (uid, username) => {
    let m = meta.get(uid);
    if (!m) { m = { username, wins: 0, losses: 0, games: 0, tourneys: new Set() }; meta.set(uid, m); }
    if (username) m.username = username; // keep the latest known username
    return m;
  };

  for (const t of rows) {
    for (const round of t.state.rounds || []) {
      for (const m of round.matches || []) {
        if (!m.isReported || m.isBye || m.isLateLoss) continue;
        if (m.result !== 'p1' && m.result !== 'p2') continue; // decisive only (skip doubleLoss/null)
        const a = t.pidMap.get(m.p1Id);
        const b = t.pidMap.get(m.p2Id);
        if (!a || !b) continue;                 // both sides must be account players
        const Ra = ratingOf(a.userId), Rb = ratingOf(b.userId);
        const Ea = 1 / (1 + Math.pow(10, (Rb - Ra) / 400));
        const Sa = m.result === 'p1' ? 1 : 0;
        rating.set(a.userId, Ra + k * (Sa - Ea));
        rating.set(b.userId, Rb + k * ((1 - Sa) - (1 - Ea)));
        const ma = metaOf(a.userId, a.username), mb = metaOf(b.userId, b.username);
        ma.games++; mb.games++; ma.tourneys.add(t.id); mb.tourneys.add(t.id);
        if (Sa === 1) { ma.wins++; mb.losses++; } else { ma.losses++; mb.wins++; }
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
