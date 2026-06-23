/* Roster surgery on a tournament's parsed state_json (#96). Pure functions: they
 * MUTATE the passed `state` and return it, or throw an Error (message is shown to
 * the admin) when an operation isn't safe. SAFE MODE: anything that would touch a
 * REAL pairing in a running event is refused — only self-contained slots (a BYE or
 * a late-loss, which have no opponent) can be re-paired/removed automatically.
 * The admin route layer handles the `registrations` table + the transaction. */

// Matches a player appears in, split into REAL (has an opponent) vs SELF-contained
// (a BYE or late-loss: p1 only, p2 null). Used for the safety gate.
export function playerMatches(state, pid) {
  const real = [], self = [];
  for (const r of (state.rounds || [])) for (const m of (r.matches || [])) {
    if (m.p1Id !== pid && m.p2Id !== pid) continue;
    if (!m.p2Id && (m.isBye || m.isLateLoss)) self.push(m);
    else real.push(m);
  }
  return { real, self };
}

// What kind of slot a player currently holds (for the roster view).
export function matchKind(state, pid) {
  const { real, self } = playerMatches(state, pid);
  if (real.length) return 'real';
  if (self.some((m) => m.isBye)) return 'bye';
  if (self.some((m) => m.isLateLoss)) return 'lateloss';
  return 'none';
}

const running = (s) => !!s.started && !s.finished;
const untombstone = (s, pid) => { if (s.cloud && Array.isArray(s.cloud.removed)) s.cloud.removed = s.cloud.removed.filter((id) => id !== pid); };
const tombstone = (s, pid) => { if (s.cloud) { s.cloud.removed = s.cloud.removed || []; if (!s.cloud.removed.includes(pid)) s.cloud.removed.push(pid); } };

// Reassign an existing slot to an account (e.g. a guest who also has an account).
// Pure state side: rename + stamp userId. Does NOT touch matches → always safe.
// (The route remaps the registration row; the optional duplicate is removed via
// removePlayer, which keeps its own safety gate.)
export function reassignToAccount(state, pid, username, userId) {
  const p = (state.players || []).find((x) => x.id === pid);
  if (!p) throw new Error('El jugador no está en el estado del torneo.');
  p.name = username;
  p.userId = userId;
  return state;
}

// Restore a previously-removed player (un-tombstone + re-add). In a running event we
// only do it if there's a free BYE in the current round to slot them into (the
// bye-holder then plays the restored player); otherwise we refuse (safe mode).
export function restorePlayer(state, reg) {
  const pid = reg.player_id;
  if ((state.players || []).some((p) => p.id === pid)) throw new Error('El jugador ya está en el torneo.');
  if (running(state)) {
    const cur = (state.rounds || []).find((r) => r.roundNumber === state.currentRound);
    const bye = cur && (cur.matches || []).find((m) => m.isBye && !m.p2Id);
    if (!bye) throw new Error('No hay un BYE libre en la ronda actual para emparejar al jugador restaurado. Hazlo manualmente o regenera la ronda.');
    const holder = (state.players || []).find((p) => p.id === bye.p1Id);
    bye.p2Id = pid; bye.isBye = false; bye.result = null; bye.isReported = false;
    if (holder) holder.hasReceivedBye = false;
  }
  untombstone(state, pid);
  (state.players = state.players || []).push({ id: pid, name: reg.display_name || 'Jugador', dropped: false, hasReceivedBye: false, userId: reg.user_id || null });
  return state;
}

// Hard-remove a player from the tournament state. SAFE MODE: refuse if they're in a
// REAL pairing (would orphan the opponent / corrupt a result); allowed when their
// only slot is a BYE / late-loss / none (those matches are dropped with them). The
// route also deletes the registration row.
export function removePlayer(state, pid) {
  const { real, self } = playerMatches(state, pid);
  if (real.length) throw new Error('El jugador está en un emparejamiento real; no es seguro quitarlo automáticamente. Resuélvelo en la consola.');
  for (const r of (state.rounds || [])) r.matches = (r.matches || []).filter((m) => !self.includes(m));
  state.players = (state.players || []).filter((p) => p.id !== pid);
  tombstone(state, pid);
  return state;
}
