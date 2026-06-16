/* SwissYGO — Swiss pairing engine (Greedy + Backtracking), pure.
 * Ported near-verbatim from SwissYGO.html (lines 1046-1186).
 * `generateRound` (the only DOM/state-mutating original) is split into the pure
 * `generateRoundMatches(state)`; the store applies the result + side effects. */

import { sortByStandings, computeStats } from './tiebreak.js';
import { newMatch } from './state.js';

// ¿Estos dos jugadores ya se enfrentaron antes? (ignora Byes)
export function havePlayed(state, aId, bId) {
  for (const round of state.rounds) {
    for (const m of round.matches) {
      if (m.isBye) continue;
      if ((m.p1Id === aId && m.p2Id === bId) || (m.p1Id === bId && m.p2Id === aId)) return true;
    }
  }
  return false;
}

/* Backtracking recursivo. `players` viene pre-ordenado por standings (mayor→menor).
   Devuelve un array de parejas [ [pA,pB], ... ] o null si no hay solución. */
export function pairBacktrack(state, players) {
  if (players.length === 0) return [];
  const first = players[0];
  for (let i = 1; i < players.length; i++) {
    const opp = players[i];
    if (havePlayed(state, first.id, opp.id)) continue;
    const rest = players.slice(1, i).concat(players.slice(i + 1));
    const sub = pairBacktrack(state, rest);
    if (sub !== null) return [[first, opp], ...sub];
  }
  return null; // deadlock → backtrack
}

// Plan B: si es imposible evitar todos los rematches, emparejar igual (greedy puro).
export function pairAllowRematch(players) {
  const res = [];
  const pool = [...players];
  while (pool.length) {
    const a = pool.shift();
    const b = pool.shift();
    res.push([a, b]);
  }
  return res;
}

export function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* Resuelve una ronda IMPAR eligiendo el BYE dinámicamente (ver doc original).
   Devuelve { byePlayer, pairs, rematchForced }. No muta el estado. */
export function solveOddRound(state, active, stats, isFirstRound) {
  const byPointsAsc = (arr) =>
    [...arr].sort(
      (a, b) => stats[a.id].matchPoints - stats[b.id].matchPoints || a.name.localeCompare(b.name),
    );
  // Orden del resto al emparejar: R1 baraja; en adelante, por standings.
  const orderRest = (rest) => (isFirstRound ? shuffle([...rest]) : sortByStandings(rest, stats));

  // 1) Candidatos elegibles para BYE: nunca lo recibieron, de menos a más puntos.
  const eligible = byPointsAsc(active.filter((p) => !p.hasReceivedBye));

  // 2) Bucle de prueba (backtracking del BYE).
  for (const cand of eligible) {
    const rest = active.filter((p) => p.id !== cand.id);
    const pairs = pairBacktrack(state, orderRest(rest));
    if (pairs !== null) return { byePlayer: cand, pairs, rematchForced: false };
  }

  // 3) CLÁUSULA DE ESCAPE (último recurso):
  if (eligible.length) {
    const byePlayer = eligible[0];
    const rest = active.filter((p) => p.id !== byePlayer.id);
    let pairs = pairBacktrack(state, orderRest(rest));
    if (pairs === null) pairs = pairAllowRematch(orderRest(rest));
    return { byePlayer, pairs, rematchForced: true };
  }
  // Caso degenerado: TODOS los activos ya recibieron bye.
  const pool = byPointsAsc(active);
  for (const cand of pool) {
    const rest = active.filter((p) => p.id !== cand.id);
    const pairs = pairBacktrack(state, orderRest(rest));
    if (pairs !== null) return { byePlayer: cand, pairs, rematchForced: false };
  }
  const byePlayer = pool[0];
  const rest = active.filter((p) => p.id !== byePlayer.id);
  return { byePlayer, pairs: pairAllowRematch(orderRest(rest)), rematchForced: true };
}

/* Calcula los matches de la PRÓXIMA ronda. Pura: no muta `state`.
   Devuelve null si no se puede generar (tope de rondas o <2 activos), o
   { matches, rematchForced, byePlayerId, roundNumber }. El store la aplica:
   marca hasReceivedBye en byePlayerId, hace push de la ronda, resetea timer, etc. */
export function generateRoundMatches(state) {
  // GUARD: nunca generar más allá del límite de rondas del torneo.
  if (state.maxRounds && state.rounds.length >= state.maxRounds) return null;

  const stats = computeStats(state);
  const active = state.players.filter((p) => !p.dropped);
  if (active.length < 2) return null;

  const isFirstRound = state.rounds.length === 0;
  const matches = [];
  let rematchForced = false;
  let byePlayerId = null;

  if (active.length % 2 === 0) {
    // PAR: sin BYE. (R1 baraja, resto por standings.)
    const ordered = isFirstRound ? shuffle([...active]) : sortByStandings(active, stats);
    let pairs = pairBacktrack(state, ordered);
    if (pairs === null) {
      pairs = pairAllowRematch(ordered);
      rematchForced = true;
    }
    for (const [a, b] of pairs) matches.push(newMatch(a.id, b.id));
  } else {
    // IMPAR: el BYE es parte de la búsqueda.
    const sol = solveOddRound(state, active, stats, isFirstRound);
    rematchForced = sol.rematchForced;
    byePlayerId = sol.byePlayer.id; // el store marca hasReceivedBye SOLO en el elegido
    matches.push(newMatch(sol.byePlayer.id, null, { isBye: true }));
    for (const [a, b] of sol.pairs) matches.push(newMatch(a.id, b.id));
  }

  return { matches, rematchForced, byePlayerId, roundNumber: state.currentRound + 1 };
}
