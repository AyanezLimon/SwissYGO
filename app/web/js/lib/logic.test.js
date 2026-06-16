/* Parity tests for the ported pure logic. Cross-checks behavior described in
 * README.md "Matemática de desempates" and the pairing invariants. */
import { describe, it, expect } from 'vitest';
import { emptyState, computeMaxRounds, newMatch, migrate } from './state.js';
import {
  computeStats,
  computeStandings,
  finalStandings,
  tieGroupsOf,
} from './tiebreak.js';
import { havePlayed, generateRoundMatches, pairBacktrack } from './pairing.js';
import { parseBulkNames } from './parse.js';

// --- helpers ---------------------------------------------------------------
function stateWith(names) {
  const s = emptyState();
  s.players = names.map((name, i) => ({
    id: `p${i}`,
    name,
    dropped: false,
    hasReceivedBye: false,
  }));
  return s;
}
function applyRound(state) {
  const r = generateRoundMatches(state);
  if (!r) return null;
  if (r.byePlayerId) {
    const bye = state.players.find((p) => p.id === r.byePlayerId);
    if (bye) bye.hasReceivedBye = true;
  }
  state.currentRound += 1;
  state.viewRound = state.currentRound;
  state.rounds.push({ roundNumber: r.roundNumber, matches: r.matches, rematchForced: r.rematchForced });
  return r;
}
// p1 always wins each non-bye match (deterministic results to drive standings)
function reportAllP1Win(state) {
  const round = state.rounds[state.rounds.length - 1];
  for (const m of round.matches) {
    if (m.isBye) continue;
    m.result = 'p1';
    m.isReported = true;
  }
}

// --- state -----------------------------------------------------------------
describe('state model', () => {
  it('computeMaxRounds follows the Tier 1/2 table', () => {
    expect(computeMaxRounds(4)).toBe(3);
    expect(computeMaxRounds(8)).toBe(3);
    expect(computeMaxRounds(9)).toBe(4);
    expect(computeMaxRounds(16)).toBe(4);
    expect(computeMaxRounds(17)).toBe(5);
    expect(computeMaxRounds(1)).toBe(0);
  });
  it('bye match auto-reports as a p1 win', () => {
    const m = newMatch('a', null, { isBye: true });
    expect(m.isBye).toBe(true);
    expect(m.result).toBe('p1');
    expect(m.isReported).toBe(true);
  });
  it('migrate upgrades legacy game-win matches to result', () => {
    const legacy = {
      started: true,
      players: [{ id: 'a' }, { id: 'b' }],
      rounds: [{ roundNumber: 1, matches: [{ p1Id: 'a', p2Id: 'b', isReported: true, p1GameWins: 2, p2GameWins: 1 }] }],
    };
    const s = migrate(legacy);
    expect(s.rounds[0].matches[0].result).toBe('p1');
    expect(s.rounds[0].matches[0].p1GameWins).toBeUndefined();
    expect(s.maxRounds).toBe(computeMaxRounds(2));
  });
});

// --- pairing ---------------------------------------------------------------
describe('pairing engine', () => {
  it('never rematches across a full small tournament (8 players, 3 rounds)', () => {
    const s = stateWith(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    s.maxRounds = 3;
    const seen = new Set();
    for (let r = 0; r < 3; r++) {
      applyRound(s);
      const round = s.rounds[r];
      for (const m of round.matches) {
        if (m.isBye) continue;
        const key = [m.p1Id, m.p2Id].sort().join('|');
        expect(seen.has(key)).toBe(false); // no repeated pairing
        seen.add(key);
      }
      expect(round.rematchForced).toBe(false);
      reportAllP1Win(s);
    }
  });

  it('assigns exactly one bye on odd player counts, to a player without a prior bye', () => {
    const s = stateWith(['A', 'B', 'C', 'D', 'E']);
    s.maxRounds = 3;
    applyRound(s);
    const byes = s.rounds[0].matches.filter((m) => m.isBye);
    expect(byes.length).toBe(1);
    expect(byes[0].p2Id).toBe(null);
    reportAllP1Win(s);
    applyRound(s);
    // the round-1 bye recipient should not get the bye again in round 2
    const firstByeId = byes[0].p1Id;
    const secondBye = s.rounds[1].matches.find((m) => m.isBye);
    expect(secondBye.p1Id).not.toBe(firstByeId);
  });

  it('havePlayed detects prior non-bye encounters only', () => {
    const s = stateWith(['A', 'B', 'C']);
    s.rounds.push({ roundNumber: 1, matches: [newMatch('p0', 'p1'), newMatch('p2', null, { isBye: true })] });
    expect(havePlayed(s, 'p0', 'p1')).toBe(true);
    expect(havePlayed(s, 'p1', 'p0')).toBe(true);
    expect(havePlayed(s, 'p0', 'p2')).toBe(false);
  });

  it('pairBacktrack returns null when every remaining pairing is a rematch', () => {
    const s = stateWith(['A', 'B']);
    s.rounds.push({ roundNumber: 1, matches: [newMatch('p0', 'p1')] });
    const players = s.players;
    expect(pairBacktrack(s, players)).toBe(null);
  });
});

// --- tiebreaks -------------------------------------------------------------
describe('tiebreak math', () => {
  it('bye grants 3 match points but is excluded from win%', () => {
    const s = stateWith(['A', 'B', 'C']);
    s.rounds.push({ roundNumber: 1, matches: [newMatch('p0', null, { isBye: true }), newMatch('p1', 'p2')] });
    s.rounds[0].matches[1].result = 'p1';
    s.rounds[0].matches[1].isReported = true;
    const stats = computeStats(s);
    expect(stats.p0.matchPoints).toBe(3);
    expect(stats.p0.mwGames).toBe(0); // bye not counted toward win%
    expect(stats.p0.wins).toBe(1);
  });

  it('late-entry loss counts as a played-and-lost game (unlike a bye)', () => {
    const s = stateWith(['A', 'B']);
    const m = newMatch('p1', null);
    m.isLateLoss = true;
    m.isReported = true;
    s.rounds.push({ roundNumber: 1, matches: [m] });
    const stats = computeStats(s);
    expect(stats.p1.matchPoints).toBe(0);
    expect(stats.p1.losses).toBe(1);
    expect(stats.p1.mwGames).toBe(1); // affects opponents' OMW%, unlike a bye
    expect(stats.p1.lostRounds).toEqual([1]);
  });

  it('orders by match points, then DDD rewards losing later', () => {
    // Two players, both 1 win 1 loss, but X lost in round 2 (later) and Y in round 1.
    const s = stateWith(['X', 'Y', 'W', 'Z']);
    // R1: X beats W, Y loses to Z
    s.rounds.push({
      roundNumber: 1,
      matches: [
        Object.assign(newMatch('p0', 'p2'), { result: 'p1', isReported: true }), // X>W
        Object.assign(newMatch('p3', 'p1'), { result: 'p1', isReported: true }), // Z>Y
      ],
    });
    // R2: X loses to Z, Y beats W
    s.rounds.push({
      roundNumber: 2,
      matches: [
        Object.assign(newMatch('p3', 'p0'), { result: 'p1', isReported: true }), // Z>X
        Object.assign(newMatch('p1', 'p2'), { result: 'p1', isReported: true }), // Y>W
      ],
    });
    const stats = computeStats(s);
    expect(stats.p0.ddd).toBe(4); // X lost round 2 -> 2^2
    expect(stats.p1.ddd).toBe(1); // Y lost round 1 -> 1^2
    const order = computeStandings(s).map((x) => x.id);
    expect(order.indexOf('p0')).toBeLessThan(order.indexOf('p1')); // X above Y
  });

  it('detects an exact tie group and applies a manual tieBreaks order', () => {
    // Two players with identical records and no head-to-head: exact tie.
    const s = stateWith(['A', 'B', 'C', 'D']);
    s.rounds.push({
      roundNumber: 1,
      matches: [
        Object.assign(newMatch('p0', 'p2'), { result: 'p1', isReported: true }), // A>C
        Object.assign(newMatch('p1', 'p3'), { result: 'p1', isReported: true }), // B>D
      ],
    });
    const ordered = finalStandings(s);
    const groups = tieGroupsOf(ordered, s.tieBreaks);
    const top = groups.find((g) => g.ids.includes('p0') && g.ids.includes('p1'));
    expect(top).toBeTruthy();
    // Force B above A manually:
    s.tieBreaks[top.key] = ['p1', 'p0'];
    const after = finalStandings(s).map((x) => x.id);
    expect(after.indexOf('p1')).toBeLessThan(after.indexOf('p0'));
  });
});

// --- bulk paste ------------------------------------------------------------
describe('parseBulkNames', () => {
  it('strips numbered-list prefixes (delimiter must immediately follow digits) but preserves names like "2 Pac"', () => {
    // "10) Carol" -> stripped; "2 Pac" -> preserved (space, not a delimiter, after the digit).
    const input = '1. Alice\n2) Bob\n10) Carol\n\n  Dave  \n2 Pac';
    expect(parseBulkNames(input)).toEqual(['Alice', 'Bob', 'Carol', 'Dave', '2 Pac']);
  });
  it('returns [] for empty/blank input', () => {
    expect(parseBulkNames('')).toEqual([]);
    expect(parseBulkNames('\n  \n')).toEqual([]);
  });
});
