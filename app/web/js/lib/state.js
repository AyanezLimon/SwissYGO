/* SwissYGO — state model & migrations (pure, framework-agnostic).
 * Ported near-verbatim from SwissYGO.html (lines 745-829).
 * Functions take `state` as an argument instead of referencing a global. */

export const STORAGE_KEY = 'ygo_swiss_v1';

export function uid() {
  // Guid v4 simple (suficiente para uso local).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function emptyState() {
  return {
    started: false,
    finished: false, // true cuando se jugó la última ronda (resultados definitivos)
    maxRounds: 0, // rondas totales, fijadas al iniciar
    players: [], // {id, name, dropped, hasReceivedBye, lateEntry, droppedAtRounds}
    rounds: [], // {roundNumber, matches:[...]}
    currentRound: 0, // número de la última ronda generada
    viewRound: 0, // ronda visible en la pestaña (puede ser pasada)
    note: '', // comentario libre del torneo (premiación, observaciones…)
    excludeDrops: true, // si está activo, los DROP se relegan al fondo de los standings
    timer: { endsAt: null, pausedMs: null, durationMin: 50 }, // cronómetro de ronda
    tieBreaks: {}, // desempates manuales del TO: { "idA|idB|...": [idGanador, ...] }
  };
}

/* Rondas sugeridas según jugadores, alineado a la tabla oficial Tier 1/2:
   4-8 → 3, 9-16 → 4, 17-32 → 5, etc. (Para N≥9 equivale a ⌈log2(N)⌉.) */
export function computeMaxRounds(n) {
  if (n >= 4 && n <= 8) return 3;
  return n >= 2 ? Math.ceil(Math.log2(n)) : 0;
}

export function newMatch(p1Id, p2Id, opts = {}) {
  const isBye = opts.isBye ?? false;
  return {
    id: uid(),
    p1Id,
    p2Id,
    // result: 'p1' | 'p2' | 'doubleLoss' | null   (v2.5: el empate ya no existe)
    result: isBye ? 'p1' : null, // el BYE se auto-reporta como victoria de p1
    isBye,
    isReported: isBye,
  };
}

export const getPlayer = (state, id) => state.players.find((p) => p.id === id);

/* Normaliza un estado cargado (localStorage o backend) al esquema actual,
   aplicando las migraciones de formatos legados (ex-load(), líneas 814-825). */
export function migrate(parsed) {
  const state = Object.assign(emptyState(), parsed || {});
  // Compat: torneos guardados antes del tope de rondas no traían maxRounds.
  if (state.started && !state.maxRounds) state.maxRounds = computeMaxRounds(state.players.length);
  // Compat: migra matches del formato viejo (game wins) al nuevo (result).
  for (const r of state.rounds || [])
    for (const m of r.matches || []) {
      if (m.result === undefined) {
        m.result = m.isBye
          ? 'p1'
          : m.isDoubleLoss
            ? 'doubleLoss'
            : m.isReported
              ? (m.p1GameWins || 0) >= (m.p2GameWins || 0)
                ? 'p1'
                : 'p2'
              : null;
      }
      delete m.p1GameWins;
      delete m.p2GameWins;
      delete m.isDoubleLoss;
    }
  return state;
}
