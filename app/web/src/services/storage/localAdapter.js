/* Offline persistence adapter — localStorage, wire-compatible with today's app.
 * Reads/writes the same STORAGE_KEY ('ygo_swiss_v1') so a browser that used the
 * legacy single-file SwissYGO can carry its in-progress tournament straight over. */
import { STORAGE_KEY, migrate, emptyState } from '@/lib/state.js';

export const localAdapter = {
  mode: 'local',

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyState();
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return migrate(parsed);
    } catch {
      /* sandbox sin localStorage → estado limpio en memoria */
    }
    return emptyState();
  },

  save(state) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* sin persistencia: la app sigue funcionando en memoria */
    }
  },
};
