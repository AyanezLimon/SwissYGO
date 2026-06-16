/* Tournament store (plain module, no framework). Holds the state, drives the pure
 * lib/* logic, persists to localStorage (offline mode), and notifies subscribers
 * so the UI can re-render. Connected mode (API persistence) layers on later via
 * setRemote(); the same logic runs in both modes. */
import { emptyState, migrate, computeMaxRounds, uid, getPlayer, STORAGE_KEY } from './lib/state.js';
import {
  finalStandings, computeStats, tieGroupsOf, tieGroupOrderedIds, moveTieOrder,
} from './lib/tiebreak.js';
import { generateRoundMatches } from './lib/pairing.js';
import { parseBulkNames } from './lib/parse.js';

let state = loadLocal();
let remote = null; // { save(state) } when connected; null = offline (localStorage)
const listeners = new Set();

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return migrate(JSON.parse(raw));
  } catch { /* sandbox without storage → in-memory */ }
  return emptyState();
}
function persist() {
  if (remote) remote.save(state);
  else { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} }
}
function commit() { persist(); for (const fn of listeners) fn(state); }

export const store = {
  get state() { return state; },
  get mode() { return remote ? 'connected' : 'local'; },
  subscribe(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },

  // connected mode hookup (used by the API layer later)
  setRemote(r, initialState) { remote = r; if (initialState) state = migrate(initialState); commit(); },
  helpers: { getPlayer, computeStats, finalStandings, tieGroupsOf },

  // derived
  standings() { return finalStandings(state); },
  tieGroups() { return tieGroupsOf(finalStandings(state), state.tieBreaks || {}); },
  currentRound() { return state.rounds.find((r) => r.roundNumber === state.viewRound) || null; },
  suggestedRounds() { return computeMaxRounds(state.players.length); },
  canGenerateNext() {
    if (!state.started || state.finished) return false;
    if (state.maxRounds && state.rounds.length >= state.maxRounds) return false;
    const last = state.rounds[state.rounds.length - 1];
    return !last || last.matches.every((m) => m.isReported);
  },

  // registration
  addPlayer(name) {
    name = (name || '').trim();
    if (!name || state.started) return false;
    state.players.push({ id: uid(), name, dropped: false, hasReceivedBye: false });
    commit(); return true;
  },
  addPlayersBulk(text) {
    if (state.started) return 0;
    const existing = new Set(state.players.map((p) => p.name.toLowerCase()));
    let added = 0;
    for (const name of parseBulkNames(text)) {
      if (existing.has(name.toLowerCase())) continue;
      existing.add(name.toLowerCase());
      state.players.push({ id: uid(), name, dropped: false, hasReceivedBye: false });
      added++;
    }
    if (added) commit();
    return added;
  },
  removePlayer(id) {
    if (state.started) return;
    state.players = state.players.filter((p) => p.id !== id);
    commit();
  },

  // flow
  start(maxRounds) {
    if (state.players.length < 2) return;
    state.started = true;
    state.maxRounds = maxRounds || computeMaxRounds(state.players.length);
    this.generateNextRound(); // commits
  },
  generateNextRound() {
    const r = generateRoundMatches(state);
    if (!r) return false;
    if (r.byePlayerId) {
      const bye = state.players.find((p) => p.id === r.byePlayerId);
      if (bye) bye.hasReceivedBye = true;
    }
    state.currentRound += 1;
    state.viewRound = state.currentRound;
    state.rounds.push({ roundNumber: r.roundNumber, matches: r.matches, rematchForced: r.rematchForced });
    state.timer = { endsAt: null, pausedMs: null, durationMin: state.timer?.durationMin || 50 };
    commit(); return true;
  },
  reportMatch(matchId, result) {
    for (const round of state.rounds) {
      const m = round.matches.find((x) => x.id === matchId);
      if (m && !m.isBye) { m.result = result; m.isReported = true; break; }
    }
    commit();
  },
  finishTournament() { state.finished = true; commit(); },
  setViewRound(n) { state.viewRound = n; commit(); },

  // manual tie resolution
  confirmTieOrder(key) {
    const ids = tieGroupOrderedIds(state, key);
    if (ids) { (state.tieBreaks ||= {})[key] = ids; commit(); }
  },
  clearTieOrder(key) { if (state.tieBreaks) { delete state.tieBreaks[key]; commit(); } },
  moveTie(id, dir) {
    const res = moveTieOrder(state, id, dir);
    if (res) { (state.tieBreaks ||= {})[res.key] = res.orderedIds; commit(); }
  },

  reset() { state = emptyState(); commit(); },
};
