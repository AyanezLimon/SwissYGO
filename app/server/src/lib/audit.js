/* #136: audit trail. Tres piezas:
 *  - diffStates(prev, next): resumen PURO de qué cambió entre dos estados
 *    (inicio/fin, ronda, jugadores, resultados por mesa). null = nada notable,
 *    así el ruido (ticks del timer, notas) no genera filas.
 *  - makeAudit(db): audit(actor, action, tournamentId, detail) — INSERT que
 *    jamás rompe el request (try/catch) + pruning por retención cada ~100 filas.
 *  - makeStateHistory(db): ring de los últimos N snapshots por torneo.
 */

const RETENTION_DAYS = 90;   // el Pi no debe crecer sin límite
const PRUNE_EVERY = 100;     // corre el DELETE de retención 1 de cada N inserts
const HISTORY_KEEP = 10;     // snapshots de estado por torneo
const MAX_RESULT_LINES = 20; // tope de mesas listadas en un diff

/** Resume qué cambió entre dos estados de torneo; null si nada notable. */
export function diffStates(prev, next) {
  const P = prev || {}, N = next || {};
  const d = {};
  if (!!P.started !== !!N.started) d.started = !!N.started;
  if (!!P.finished !== !!N.finished) d.finished = !!N.finished;
  const pr = P.currentRound || 0, nr = N.currentRound || 0;
  if (pr !== nr) d.round = pr + '→' + nr;
  const pp = (P.players || []).length, np = (N.players || []).length;
  if (pp !== np) d.players = pp + '→' + np;

  // Resultados: indexa los matches previos por id y compara. Una mesa nueva sin
  // resultado no se lista (la cubre `round`); el BYE auto-reportado sí (∅→p1).
  const prevById = new Map();
  for (const r of P.rounds || []) for (const m of r.matches || []) prevById.set(m.id, m);
  const nameOf = (id) => (((N.players || []).find((p) => p.id === id)) || {}).name || String(id);
  const lines = [];
  for (const r of N.rounds || []) {
    for (const m of r.matches || []) {
      const old = prevById.get(m.id);
      const before = old ? (old.result ?? null) : null;
      const after = m.result ?? null;
      if (old && before === after) continue;
      if (!old && after === null) continue;
      const who = nameOf(m.p1Id) + (m.p2Id ? ' vs ' + nameOf(m.p2Id) : (m.isBye ? ' (BYE)' : ' (late)'));
      lines.push('R' + r.roundNumber + ' ' + who + ': ' + (old ? String(before) : '∅') + '→' + String(after));
    }
  }
  if (lines.length) {
    d.results = lines.slice(0, MAX_RESULT_LINES);
    if (lines.length > MAX_RESULT_LINES) d.resultsTotal = lines.length;
  }
  return Object.keys(d).length ? d : null;
}

/** Actor a partir del request (JWT ya verificado por el preHandler, si lo hay). */
export function actorFromReq(req) {
  if (req.user && req.user.id != null) return { type: 'user', id: req.user.id, name: req.user.username };
  if (req.headers && req.headers['x-guest-token']) return { type: 'guest' };
  return { type: 'anon' };
}

/** @return {(actor:object, action:string, tournamentId?:number, detail?:object) => void} */
export function makeAudit(db) {
  let ins, prune; // prepare perezoso, dentro del try: ni una tabla ausente rompe un request
  return function audit(actor, action, tournamentId = null, detail = null) {
    try {
      if (!ins) {
        ins = db.prepare('INSERT INTO audit_log (actor_type, actor_id, actor_name, action, tournament_id, detail_json) VALUES (?, ?, ?, ?, ?, ?)');
        prune = db.prepare("DELETE FROM audit_log WHERE ts < datetime('now', '-' || ? || ' days')");
      }
      const a = actor || { type: 'anon' };
      const info = ins.run(
        a.type || 'anon',
        a.id != null ? String(a.id) : null,
        a.name || null,
        action,
        tournamentId != null ? Number(tournamentId) : null,
        detail ? JSON.stringify(detail) : null
      );
      if (Number(info.lastInsertRowid) % PRUNE_EVERY === 0) prune.run(RETENTION_DAYS);
    } catch { /* la auditoría nunca debe romper el request */ }
  };
}

/** Ring de snapshots por torneo: guarda solo si cambió, poda a HISTORY_KEEP. */
export function makeStateHistory(db, keep = HISTORY_KEEP) {
  let last, ins, prune; // prepare perezoso (misma razón que makeAudit)
  return function recordState(tournamentId, stateJson) {
    try {
      if (!ins) {
        last = db.prepare('SELECT state_json FROM state_history WHERE tournament_id = ? ORDER BY id DESC LIMIT 1');
        ins = db.prepare('INSERT INTO state_history (tournament_id, state_json) VALUES (?, ?)');
        prune = db.prepare('DELETE FROM state_history WHERE tournament_id = ? AND id NOT IN (SELECT id FROM state_history WHERE tournament_id = ? ORDER BY id DESC LIMIT ?)');
      }
      const prev = last.get(tournamentId);
      if (prev && prev.state_json === stateJson) return;
      ins.run(tournamentId, stateJson);
      prune.run(tournamentId, tournamentId, keep);
    } catch { /* nunca romper el request */ }
  };
}
