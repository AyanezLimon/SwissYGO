/* Connected persistence adapter — backend (Pi) over the API.
 * A connected tournament has an id; the TO's authoritative state lives in
 * `tournaments.state_json` on the server. load()/save() map onto GET/PUT.
 * (Wired to the routes added in the backend phase.) */
import { api } from '@/services/api.js';
import { migrate } from '@/lib/state.js';

export function makeApiAdapter(tournamentId) {
  return {
    mode: 'connected',
    tournamentId,

    async load() {
      const row = await api(`/tournaments/${tournamentId}`);
      return migrate(row.state);
    },

    async save(state) {
      await api(`/tournaments/${tournamentId}`, { method: 'PUT', body: { state } });
    },
  };
}
