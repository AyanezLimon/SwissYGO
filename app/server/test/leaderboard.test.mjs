/* Elo engine (lib/leaderboard.js) — pure, no DB. Guards the rating math + the
 * "only decisive account-vs-account matches count" rule + the K-factor knob (#91). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLeaderboard } from '../src/lib/leaderboard.js';

// One finished tournament with the given matches + player→account map.
const row = (matches, pidMap) => ({ id: 1, name: 'T', date: '2026-06', state: { players: [], rounds: [{ matches }] }, pidMap: new Map(pidMap) });
const decisive = (p1, p2, winner) => ({ p1Id: p1, p2Id: p2, result: winner, isReported: true, isBye: false });

test('a decisive account-vs-account win moves both ratings by ±K/2 (K=24)', () => {
  const rows = [row([decisive('pa', 'pb', 'p1')], [['pa', { userId: 1, username: 'A' }], ['pb', { userId: 2, username: 'B' }]])];
  const board = computeLeaderboard(rows, { minGames: 0, k: 24 });
  const A = board.find((p) => p.userId === 1), B = board.find((p) => p.userId === 2);
  assert.equal(A.rating, 1212); // 1200 + 24*0.5
  assert.equal(B.rating, 1188);
});

test('K is configurable — bigger K = bigger swing', () => {
  const rows = [row([decisive('pa', 'pb', 'p1')], [['pa', { userId: 1, username: 'A' }], ['pb', { userId: 2, username: 'B' }]])];
  const a35 = computeLeaderboard(rows, { minGames: 0, k: 35 }).find((p) => p.userId === 1).rating;
  assert.ok(a35 > 1212, `K=35 winner (${a35}) should exceed K=24 winner (1212)`);
});

test('matches involving a guest (no account) do NOT move ratings', () => {
  // pb has no entry in pidMap → not an account → match is not rated.
  const rows = [row([decisive('pa', 'pb', 'p1')], [['pa', { userId: 1, username: 'A' }]])];
  const board = computeLeaderboard(rows, { minGames: 0, k: 24 });
  assert.equal(board.length, 0, 'no rated games → nobody on the board');
});

test('byes and late-losses are not decisive (no rating change)', () => {
  const matches = [
    { p1Id: 'pa', p2Id: null, result: 'p1', isBye: true, isReported: true },
    { p1Id: 'pb', p2Id: null, result: 'lateLoss', isLateLoss: true, isReported: true },
  ];
  const board = computeLeaderboard([row(matches, [['pa', { userId: 1, username: 'A' }], ['pb', { userId: 2, username: 'B' }]])], { minGames: 0 });
  assert.equal(board.length, 0, 'bye + late-loss are not rated');
});

test('minGames filters the public board', () => {
  const rows = [row([decisive('pa', 'pb', 'p1')], [['pa', { userId: 1, username: 'A' }], ['pb', { userId: 2, username: 'B' }]])];
  assert.equal(computeLeaderboard(rows, { minGames: 3 }).length, 0, '1 game < minGames 3 → excluded');
  assert.equal(computeLeaderboard(rows, { minGames: 0 }).length, 2, 'minGames 0 → both shown');
});
