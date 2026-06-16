/* Tournament store (model/controller). Holds the reactive `state`, drives the pure
 * lib/* logic, and persists through the active storage adapter. All the side effects
 * that were inline in SwissYGO.html (save, timer-reset on new round, etc.) live here;
 * the lib functions stay pure. Defaults to the offline localStorage adapter so the
 * app works with zero backend, exactly like today. */
import { defineStore } from 'pinia';
import { ref, computed } from 'vue';
import { emptyState, computeMaxRounds, uid } from '@/lib/state.js';
import { finalStandings, computeStats, tieGroupsOf, tieGroupOrderedIds, moveTieOrder } from '@/lib/tiebreak.js';
import { generateRoundMatches } from '@/lib/pairing.js';
import { parseBulkNames } from '@/lib/parse.js';
import { localAdapter } from '@/services/storage/localAdapter.js';

export const useTournamentStore = defineStore('tournament', () => {
  const state = ref(emptyState());
  const adapter = ref(localAdapter);
  let saveTimer = null;

  // ---- persistence ----
  async function init(nextAdapter) {
    if (nextAdapter) adapter.value = nextAdapter;
    state.value = await adapter.value.load();
  }
  function persist() {
    // debounce: coalesce bursts of mutations into one write
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => adapter.value.save(state.value), 150);
  }
  function mutate(fn) {
    fn(state.value);
    persist();
  }

  // ---- derived ----
  const mode = computed(() => adapter.value.mode);
  const started = computed(() => state.value.started);
  const finished = computed(() => state.value.finished);
  const players = computed(() => state.value.players);
  const stats = computed(() => computeStats(state.value));
  const standings = computed(() => finalStandings(state.value));
  const tieGroups = computed(() => tieGroupsOf(standings.value, state.value.tieBreaks || {}));
  const currentRound = computed(() =>
    state.value.rounds.find((r) => r.roundNumber === state.value.viewRound) || null,
  );
  const canGenerateNext = computed(() => {
    const s = state.value;
    if (!s.started || s.finished) return false;
    if (s.maxRounds && s.rounds.length >= s.maxRounds) return false;
    const last = s.rounds[s.rounds.length - 1];
    return !last || last.matches.every((m) => m.isReported);
  });

  // ---- registration ----
  function addPlayer(name) {
    name = (name || '').trim();
    if (!name || state.value.started) return false;
    mutate((s) => s.players.push({ id: uid(), name, dropped: false, hasReceivedBye: false }));
    return true;
  }
  function addPlayersBulk(text) {
    if (state.value.started) return 0;
    const names = parseBulkNames(text);
    const existing = new Set(state.value.players.map((p) => p.name.toLowerCase()));
    let added = 0;
    mutate((s) => {
      for (const name of names) {
        if (existing.has(name.toLowerCase())) continue;
        existing.add(name.toLowerCase());
        s.players.push({ id: uid(), name, dropped: false, hasReceivedBye: false });
        added++;
      }
    });
    return added;
  }
  function removePlayer(id) {
    if (state.value.started) return;
    mutate((s) => (s.players = s.players.filter((p) => p.id !== id)));
  }
  function toggleDrop(id) {
    mutate((s) => {
      const p = s.players.find((x) => x.id === id);
      if (p) p.dropped = !p.dropped;
    });
  }

  // ---- flow ----
  function suggestedRounds() {
    return computeMaxRounds(state.value.players.length);
  }
  function start(maxRounds) {
    mutate((s) => {
      if (s.players.length < 2) return;
      s.started = true;
      s.maxRounds = maxRounds || computeMaxRounds(s.players.length);
    });
    generateNextRound();
  }
  function generateNextRound() {
    const result = generateRoundMatches(state.value);
    if (!result) return false;
    mutate((s) => {
      if (result.byePlayerId) {
        const bye = s.players.find((p) => p.id === result.byePlayerId);
        if (bye) bye.hasReceivedBye = true;
      }
      s.currentRound += 1;
      s.viewRound = s.currentRound;
      s.rounds.push({
        roundNumber: result.roundNumber,
        matches: result.matches,
        rematchForced: result.rematchForced,
      });
      resetTimerSlice(s);
    });
    return true;
  }
  function reportMatch(matchId, result) {
    mutate((s) => {
      for (const r of s.rounds) {
        const m = r.matches.find((x) => x.id === matchId);
        if (m && !m.isBye) {
          m.result = result; // 'p1' | 'p2' | 'doubleLoss'
          m.isReported = true;
          break;
        }
      }
    });
  }
  function finishTournament() {
    mutate((s) => (s.finished = true));
  }
  function setViewRound(n) {
    mutate((s) => (s.viewRound = n));
  }
  function setNote(note) {
    mutate((s) => (s.note = note));
  }
  function setExcludeDrops(v) {
    mutate((s) => (s.excludeDrops = !!v));
  }

  // ---- manual tie resolution ----
  function setTieOrder(key, orderedIds) {
    mutate((s) => {
      if (!s.tieBreaks) s.tieBreaks = {};
      s.tieBreaks[key] = orderedIds;
    });
  }
  function confirmTieOrder(key) {
    const ids = tieGroupOrderedIds(state.value, key);
    if (ids) setTieOrder(key, ids);
  }
  function clearTieOrder(key) {
    mutate((s) => {
      if (s.tieBreaks) delete s.tieBreaks[key];
    });
  }
  function moveTie(id, dir) {
    const res = moveTieOrder(state.value, id, dir);
    if (res) setTieOrder(res.key, res.orderedIds);
  }

  // ---- timer (time math is in lib/timer.js; here we only mutate the slice) ----
  function resetTimerSlice(s) {
    s.timer = { endsAt: null, pausedMs: null, durationMin: s.timer?.durationMin || 50 };
  }
  function timerStart() {
    mutate((s) => {
      const remaining =
        s.timer.pausedMs != null ? s.timer.pausedMs : (s.timer.durationMin || 50) * 60000;
      s.timer.endsAt = Date.now() + remaining;
      s.timer.pausedMs = null;
    });
  }
  function timerPause() {
    mutate((s) => {
      if (s.timer.endsAt) {
        s.timer.pausedMs = Math.max(0, s.timer.endsAt - Date.now());
        s.timer.endsAt = null;
      }
    });
  }
  function timerReset() {
    mutate((s) => resetTimerSlice(s));
  }
  function timerSetMinutes(min) {
    mutate((s) => {
      s.timer.durationMin = Math.max(1, Math.floor(min) || 50);
      s.timer.endsAt = null;
      s.timer.pausedMs = null;
    });
  }

  function reset() {
    mutate((s) => Object.assign(s, emptyState()));
  }

  return {
    state, mode, started, finished, players, stats, standings, tieGroups, currentRound,
    canGenerateNext,
    init, persist,
    addPlayer, addPlayersBulk, removePlayer, toggleDrop,
    suggestedRounds, start, generateNextRound, reportMatch, finishTournament,
    setViewRound, setNote, setExcludeDrops,
    setTieOrder, confirmTieOrder, clearTieOrder, moveTie,
    timerStart, timerPause, timerReset, timerSetMinutes,
    reset,
  };
});
