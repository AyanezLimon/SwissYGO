/* SwissYGO — tiebreak math & standings (pure).
 * Ported near-verbatim from SwissYGO.html (lines 847-1043).
 *
 * Cada jugador acumula su "número" de desempate AABBBCCCDDD:
 *   AA  = puntos totales        (Victoria 3 / Derrota 0 / Bye 3)   ↓ mayor mejor
 *   BBB = OMW%  · % victorias de tus oponentes        (×1000)      ↓ mayor mejor
 *   CCC = OOMW% · % victorias de los oponentes de tus oponentes    ↓ mayor mejor
 *   DDD = Σ (ronda_perdida)²                                       ↓ mayor mejor
 * El orden REAL usa la tupla numérica (no la cadena). El Bye da 3 pts en AA pero
 * se EXCLUYE de todos los porcentajes; el Late Entry SÍ cuenta como duelo perdido. */

function avg(a) {
  return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
}
function pad(n, w) {
  return String(n).padStart(w, '0');
} // sólo presentación

export function computeStats(state) {
  const stats = {};
  for (const p of state.players) {
    stats[p.id] = {
      id: p.id,
      name: p.name,
      dropped: p.dropped,
      matchPoints: 0, // AA (incluye Bye)
      mwPts: 0,
      mwGames: 0, // numerador/denominador del MWP propio (sin Bye)
      wins: 0,
      losses: 0, // récord a mostrar (Bye cuenta como win)
      opponents: [],
      lostRounds: [],
      mwp: 0,
      omw: 0,
      oomw: 0,
      ddd: 0,
    };
  }
  const h2h = {}; // h2h['X|Y']='a' ⇒ X venció a Y (desempate final)

  state.rounds.forEach((round, idx) => {
    const roundNo = idx + 1;
    for (const m of round.matches) {
      if (!m.isReported) continue;
      if (m.isBye) {
        const s = stats[m.p1Id];
        if (s) {
          s.matchPoints += 3;
          s.wins++;
        }
        continue;
      }
      // Late Entry: derrota administrativa por una ronda ya jugada. A diferencia del BYE,
      // SÍ cuenta como un partido jugado-y-perdido en su winrate (mwGames++, 0 pts).
      if (m.isLateLoss) {
        const s = stats[m.p1Id];
        if (s) {
          s.losses++;
          s.mwGames++;
          s.lostRounds.push(roundNo);
        }
        continue;
      }

      const a = stats[m.p1Id];
      const b = stats[m.p2Id];
      if (!a || !b) continue;
      a.opponents.push(b.id);
      b.opponents.push(a.id);
      a.mwGames++;
      b.mwGames++;

      if (m.result === 'p1') {
        a.matchPoints += 3;
        a.mwPts += 3;
        a.wins++;
        b.losses++;
        b.lostRounds.push(roundNo);
        h2h[a.id + '|' + b.id] = 'a';
        h2h[b.id + '|' + a.id] = 'b';
      } else if (m.result === 'p2') {
        b.matchPoints += 3;
        b.mwPts += 3;
        b.wins++;
        a.losses++;
        a.lostRounds.push(roundNo);
        h2h[a.id + '|' + b.id] = 'b';
        h2h[b.id + '|' + a.id] = 'a';
      } else if (m.result === 'doubleLoss') {
        a.losses++;
        a.lostRounds.push(roundNo);
        b.losses++;
        b.lostRounds.push(roundNo);
      }
    }
  });

  const vals = Object.values(stats);
  for (const s of vals) s.mwp = s.mwGames ? s.mwPts / (3 * s.mwGames) : 0; // sin suelo
  for (const s of vals) s.omw = avg(s.opponents.map((id) => stats[id].mwp)); // BBB
  for (const s of vals) s.oomw = avg(s.opponents.map((id) => stats[id].omw)); // CCC
  for (const s of vals) {
    s.ddd = s.lostRounds.reduce((acc, r) => acc + r * r, 0); // DDD
    s.tieString =
      pad(s.matchPoints, 2) +
      pad(Math.round(s.omw * 1000), 3) +
      pad(Math.round(s.oomw * 1000), 3) +
      pad(s.ddd, 3);
  }
  stats._h2h = h2h; // se adjunta tras armar `vals` (no es un jugador)
  return stats;
}

export function headToHead(h2h, x, y) {
  const r = h2h[x.id + '|' + y.id];
  if (r === 'a') return -1; // x ganó el directo → x más arriba
  if (r === 'b') return 1; // y ganó el directo → y más arriba
  return 0; // no jugaron / doble derrota → siguiente criterio
}

// BBB y CCC tal como aparecen en la cadena: % redondeado al primer decimal (entero 0–1000).
export function bbbInt(s) {
  return Math.round(s.omw * 1000);
}
export function cccInt(s) {
  return Math.round(s.oomw * 1000);
}

/* Orden DETERMINISTA (sin azar) para el emparejador: AA↓ BBB↓ CCC↓ DDD↓, nombre. */
export function sortByStandings(players, stats) {
  return [...players].sort((a, b) => {
    const sa = stats[a.id];
    const sb = stats[b.id];
    return (
      sb.matchPoints - sa.matchPoints ||
      bbbInt(sb) - bbbInt(sa) ||
      cccInt(sb) - cccInt(sa) ||
      sb.ddd - sa.ddd ||
      a.name.localeCompare(b.name)
    );
  });
}

/* Tabla de posiciones FINAL: orden oficial + desempate head-to-head y, si persiste,
   un orden ESTABLE por id. Devuelve las entradas de stats ya ordenadas. */
export function computeStandings(state) {
  const stats = computeStats(state);
  const h2h = stats._h2h;
  const vals = state.players.map((p) => stats[p.id]);
  vals.sort(
    (x, y) =>
      y.matchPoints - x.matchPoints ||
      bbbInt(y) - bbbInt(x) ||
      cccInt(y) - cccInt(x) ||
      y.ddd - x.ddd ||
      headToHead(h2h, x, y) ||
      x.id.localeCompare(y.id),
  );
  return vals;
}

/* ---------------------------------------------------------------------------
   DESEMPATE MANUAL DEL TO (standings exactamente iguales)
   El orden manual vive en `tieBreaks` (= state.tieBreaks), indexado por el
   CONJUNTO de ids empatados. Estas funciones son puras; la persistencia
   (save/render) la hace el store.
--------------------------------------------------------------------------- */
export function tieGroupKey(ids) {
  return [...ids].sort().join('|');
}

/* Detecta los grupos de empate exacto en un arreglo YA ordenado de stats.
   Devuelve [{ start, size, ids, key, resolved }] solo para grupos de 2+. */
export function tieGroupsOf(ordered, tieBreaks = {}) {
  const groups = [];
  let i = 0;
  while (i < ordered.length) {
    let j = i + 1;
    while (
      j < ordered.length &&
      ordered[j].tieString === ordered[i].tieString &&
      !!ordered[j].dropped === !!ordered[i].dropped
    )
      j++;
    if (j - i >= 2) {
      const ids = ordered.slice(i, j).map((s) => s.id);
      const key = tieGroupKey(ids);
      groups.push({ start: i, size: j - i, ids, key, resolved: !!tieBreaks[key] });
    }
    i = j;
  }
  return groups;
}

/* Reordena IN-PLACE cada grupo de empate según el orden manual del TO. */
export function applyTieBreaks(ordered, tieBreaks = {}) {
  for (const g of tieGroupsOf(ordered, tieBreaks)) {
    const order = tieBreaks[g.key];
    if (!order || order.length !== g.size) continue;
    const byId = new Map(ordered.slice(g.start, g.start + g.size).map((s) => [s.id, s]));
    const reordered = order.map((id) => byId.get(id)).filter(Boolean);
    if (reordered.length === g.size) {
      for (let k = 0; k < g.size; k++) ordered[g.start + k] = reordered[k];
    }
  }
  return ordered;
}

/* Orden final mostrado por la tabla y el PNG: orden oficial + relegado de DROPs
   (modo premiación) + desempate manual del TO. Única fuente de verdad de lo que
   se ve; el emparejador NO usa esto (usa sortByStandings). */
export function finalStandings(state) {
  let ordered = computeStandings(state);
  if (state.excludeDrops) {
    ordered = ordered.filter((s) => !s.dropped).concat(ordered.filter((s) => s.dropped));
  }
  return applyTieBreaks(ordered, state.tieBreaks || {});
}

/* Devuelve los ids del grupo `key` en su orden actual (para "confirmar" tal cual). */
export function tieGroupOrderedIds(state, key) {
  const ordered = finalStandings(state);
  const g = tieGroupsOf(ordered, state.tieBreaks || {}).find((gr) => gr.key === key);
  return g ? ordered.slice(g.start, g.start + g.size).map((s) => s.id) : null;
}

/* Calcula el nuevo orden tras mover `id` una posición (dir = -1 sube | +1 baja).
   Devuelve { key, orderedIds } o null si no aplica. El store persiste el resultado. */
export function moveTieOrder(state, id, dir) {
  const ordered = finalStandings(state);
  const g = tieGroupsOf(ordered, state.tieBreaks || {}).find((gr) => gr.ids.includes(id));
  if (!g) return null;
  const ids = ordered.slice(g.start, g.start + g.size).map((s) => s.id);
  const from = ids.indexOf(id);
  const to = from + dir;
  if (to < 0 || to >= ids.length) return null;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  return { key: g.key, orderedIds: ids };
}
