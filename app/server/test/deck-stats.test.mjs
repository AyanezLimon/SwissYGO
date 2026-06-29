/* Deck stats aggregator (lib/deck-stats.js) — pure, no DB. Guards the "decisive
 * matches only" rule, the favourite-deck pick, and the top-cards-by-plays / by-winrate
 * aggregation across decks (#108). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDeckStats } from '../src/lib/deck-stats.js';

// A finished tournament where "me" had the given per-match results (p1 = my win,
// p2 = my loss; bye/lateLoss/doubleLoss are excluded), playing `cards` from `deckId`.
const row = (tid, deckId, results, cards, opts = {}) => ({
  tournamentId: tid, playerId: 'me', deckId, deckName: 'D' + deckId, coverUrl: 'c', coverPasscode: deckId, cards,
  state: { rounds: [{ matches: results.map((r, i) => ({ p1Id: 'me', p2Id: 'o' + i, result: r, isReported: true, ...opts })) }] },
});

test('summary counts only decisive matches; favourite = most-played deck', () => {
  const rows = [
    row(1, 7, ['p1', 'p1', 'p2'], { main: [100, 200], extra: [], side: [] }),
    row(2, 7, ['p1'], { main: [100], extra: [], side: [] }),
    row(3, 9, ['p2'], { main: [100], extra: [], side: [] }),
  ];
  const s = aggregateDeckStats(rows, { minGames: 1 });
  assert.deepEqual(s.summary, { tournaments: 3, matches: 5, wins: 3, winrate: 60 });
  assert.equal(s.favorite.deckId, 7);
  assert.equal(s.favorite.played, 4);
  assert.equal(s.favorite.winrate, 75);
});

test('byes / late losses / unreported are not counted', () => {
  const rows = [{
    tournamentId: 1, playerId: 'me', deckId: 1, cards: { main: [1], extra: [], side: [] },
    state: { rounds: [{ matches: [
      { p1Id: 'me', p2Id: 'o', result: 'p1', isReported: true },
      { p1Id: 'me', p2Id: null, isBye: true, isReported: true },
      { p1Id: 'me', p2Id: 'o2', isLateLoss: true, isReported: true },
      { p1Id: 'me', p2Id: 'o3', result: 'doubleLoss', isReported: true },
    ] }] },
  }];
  assert.deepEqual(aggregateDeckStats(rows).summary, { tournaments: 1, matches: 1, wins: 1, winrate: 100 });
});

test('top cards: most-played by match count, best-winrate respects minGames', () => {
  const rows = [
    row(1, 7, ['p1', 'p1', 'p2'], { main: [100, 200], extra: [], side: [] }), // 100,200 each: 3 played, 2 won
    row(2, 7, ['p1'], { main: [100, 300], extra: [], side: [] }),             // 100:+1won, 300:1 played 1 won
  ];
  const s = aggregateDeckStats(rows, { minGames: 3 });
  assert.equal(s.topPlayed[0].code, 100);        // in both → 4 matches
  assert.equal(s.topPlayed[0].matches, 4);
  // only cards with >=3 matches qualify for winrate: 100 (4) and 200 (3); 300 (1) excluded
  assert.deepEqual(s.topWinrate.map((c) => c.code).sort(), [100, 200]);
  assert.equal(s.topWinrate.find((c) => c.code === 100).winrate, 75); // 3 of 4
});

test('a card counts once per match regardless of copies in the deck', () => {
  const rows = [row(1, 1, ['p1', 'p2'], { main: [100, 100, 100], extra: [], side: [] })]; // 3 copies
  const s = aggregateDeckStats(rows, { minGames: 1 });
  assert.equal(s.topPlayed[0].matches, 2); // 2 matches, not 6
});
