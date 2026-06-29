/* Per-account deck statistics for one season (#108). Pure + testable: feed it the
 * account's RANKED, finished registrations (each with the tournament state, the
 * player_id, the registered deck + its snapshot card codes) and it returns the
 * favourite deck, a summary, and the top cards by play count and by winrate.
 *
 * Only DECISIVE matches count (a clear p1/p2 result) — byes, late-entry losses,
 * double-losses and unreported games are skipped. A card is credited for a match
 * whenever the deck played that match contained it (counted once per match, not per
 * copy); winrate is aggregated across every deck the player ran. */

export function aggregateDeckStats(rows, { minGames = 3 } = {}) {
  const perDeck = new Map();   // deckId -> { deckId, name, coverUrl, coverPasscode, played, wins }
  const perCard = new Map();   // code   -> { code, played, wins }
  const tourneys = new Set();
  let played = 0, wins = 0;

  for (const r of rows) {
    const state = r.state || {};
    const uniqCards = r.cards
      ? [...new Set([...(r.cards.main || []), ...(r.cards.extra || []), ...(r.cards.side || [])].map(Number).filter(Boolean))]
      : null;
    for (const round of state.rounds || []) {
      for (const m of round.matches || []) {
        if (m.p1Id !== r.playerId && m.p2Id !== r.playerId) continue;
        if (m.isBye || m.isLateLoss) continue;
        if (m.result !== 'p1' && m.result !== 'p2') continue; // decisive only
        const won = (m.result === 'p1') === (m.p1Id === r.playerId);
        played++; if (won) wins++;
        tourneys.add(r.tournamentId);
        if (r.deckId) {
          const d = perDeck.get(r.deckId) || { deckId: r.deckId, name: r.deckName || null, coverUrl: r.coverUrl || null, coverPasscode: r.coverPasscode || null, played: 0, wins: 0 };
          d.played++; if (won) d.wins++; perDeck.set(r.deckId, d);
        }
        if (uniqCards) for (const c of uniqCards) { const e = perCard.get(c) || { code: c, played: 0, wins: 0 }; e.played++; if (won) e.wins++; perCard.set(c, e); }
      }
    }
  }

  const favorite = [...perDeck.values()].sort((a, b) => b.played - a.played || b.wins - a.wins)[0] || null;
  if (favorite) favorite.winrate = favorite.played ? Math.round((favorite.wins * 100) / favorite.played) : 0;

  const cards = [...perCard.values()];
  const topPlayed = cards.slice().sort((a, b) => b.played - a.played || b.wins - a.wins).slice(0, 5)
    .map((c) => ({ code: c.code, matches: c.played, wins: c.wins }));
  const topWinrate = cards.filter((c) => c.played >= minGames)
    .map((c) => ({ code: c.code, matches: c.played, wins: c.wins, winrate: Math.round((c.wins * 100) / c.played) }))
    .sort((a, b) => b.winrate - a.winrate || b.matches - a.matches).slice(0, 5);

  return {
    summary: { tournaments: tourneys.size, matches: played, wins, winrate: played ? Math.round((wins * 100) / played) : 0 },
    favorite, topPlayed, topWinrate,
  };
}
