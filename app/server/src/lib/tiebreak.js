/* Standings/tiebreak math (server copy, for read-only public results). Ported
 * from SwissYGO.html — same AA·BBB·CCC·DDD logic, operating on a state object. */
function avg(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function pad(n, w) { return String(n).padStart(w, '0'); }

export function computeStats(state) {
  const stats = {};
  for (const p of state.players) {
    stats[p.id] = {
      id: p.id, name: p.name, dropped: p.dropped,
      matchPoints: 0, mwPts: 0, mwGames: 0, wins: 0, losses: 0,
      opponents: [], lostRounds: [], mwp: 0, omw: 0, oomw: 0, ddd: 0,
    };
  }
  const h2h = {};
  (state.rounds || []).forEach((round, idx) => {
    const roundNo = idx + 1;
    for (const m of round.matches) {
      if (!m.isReported) continue;
      if (m.isBye) { const s = stats[m.p1Id]; if (s) { s.matchPoints += 3; s.wins++; } continue; }
      if (m.isLateLoss) { const s = stats[m.p1Id]; if (s) { s.losses++; s.mwGames++; s.lostRounds.push(roundNo); } continue; }
      const a = stats[m.p1Id], b = stats[m.p2Id];
      if (!a || !b) continue;
      a.opponents.push(b.id); b.opponents.push(a.id);
      a.mwGames++; b.mwGames++;
      if (m.result === 'p1') { a.matchPoints += 3; a.mwPts += 3; a.wins++; b.losses++; b.lostRounds.push(roundNo); h2h[a.id + '|' + b.id] = 'a'; h2h[b.id + '|' + a.id] = 'b'; }
      else if (m.result === 'p2') { b.matchPoints += 3; b.mwPts += 3; b.wins++; a.losses++; a.lostRounds.push(roundNo); h2h[a.id + '|' + b.id] = 'b'; h2h[b.id + '|' + a.id] = 'a'; }
      else if (m.result === 'doubleLoss') { a.losses++; a.lostRounds.push(roundNo); b.losses++; b.lostRounds.push(roundNo); }
    }
  });
  const vals = Object.values(stats);
  for (const s of vals) s.mwp = s.mwGames ? s.mwPts / (3 * s.mwGames) : 0;
  for (const s of vals) s.omw = avg(s.opponents.map((id) => stats[id].mwp));
  for (const s of vals) s.oomw = avg(s.opponents.map((id) => stats[id].omw));
  for (const s of vals) {
    s.ddd = s.lostRounds.reduce((acc, r) => acc + r * r, 0);
    s.tieString = pad(s.matchPoints, 2) + pad(Math.round(s.omw * 1000), 3) + pad(Math.round(s.oomw * 1000), 3) + pad(s.ddd, 3);
  }
  stats._h2h = h2h;
  return stats;
}

function headToHead(h2h, x, y) { const r = h2h[x.id + '|' + y.id]; if (r === 'a') return -1; if (r === 'b') return 1; return 0; }
const bbbInt = (s) => Math.round(s.omw * 1000);
const cccInt = (s) => Math.round(s.oomw * 1000);

export function computeStandings(state) {
  const stats = computeStats(state);
  const h2h = stats._h2h;
  const vals = state.players.map((p) => stats[p.id]);
  vals.sort((x, y) =>
    (y.matchPoints - x.matchPoints) || (bbbInt(y) - bbbInt(x)) || (cccInt(y) - cccInt(x)) ||
    (y.ddd - x.ddd) || headToHead(h2h, x, y) || x.id.localeCompare(y.id));
  return vals;
}

function tieGroupKey(ids) { return [...ids].sort().join('|'); }
function tieGroupsOf(ordered, tieBreaks = {}) {
  const groups = []; let i = 0;
  while (i < ordered.length) {
    let j = i + 1;
    while (j < ordered.length && ordered[j].tieString === ordered[i].tieString && !!ordered[j].dropped === !!ordered[i].dropped) j++;
    if (j - i >= 2) { const ids = ordered.slice(i, j).map((s) => s.id); groups.push({ start: i, size: j - i, ids, key: tieGroupKey(ids) }); }
    i = j;
  }
  return groups;
}
function applyTieBreaks(ordered, tieBreaks = {}) {
  for (const g of tieGroupsOf(ordered, tieBreaks)) {
    const order = tieBreaks[g.key];
    if (!order || order.length !== g.size) continue;
    const byId = new Map(ordered.slice(g.start, g.start + g.size).map((s) => [s.id, s]));
    const reordered = order.map((id) => byId.get(id)).filter(Boolean);
    if (reordered.length === g.size) for (let k = 0; k < g.size; k++) ordered[g.start + k] = reordered[k];
  }
  return ordered;
}

export function finalStandings(state) {
  let ordered = computeStandings(state);
  if (state.excludeDrops) ordered = ordered.filter((s) => !s.dropped).concat(ordered.filter((s) => s.dropped));
  return applyTieBreaks(ordered, state.tieBreaks || {});
}
