/* SwissYGO — round timer time math (pure).
 * Ported from SwissYGO.html (lines 1301-1311). Takes the `timer` slice of state
 * ({ endsAt, pausedMs, durationMin }); rendering/controls live in the store/UI. */

export function timerRunning(timer) {
  return !!timer.endsAt;
}

export function timerRemainingMs(timer) {
  if (timer.endsAt) return Math.max(0, timer.endsAt - Date.now());
  if (timer.pausedMs != null) return timer.pausedMs;
  return (timer.durationMin || 50) * 60000;
}

export function fmtMMSS(ms) {
  const tot = Math.ceil(ms / 1000);
  const m = Math.floor(tot / 60);
  const s = tot % 60;
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}
