/* ============================================================================
   GESTOR DE TORNEOS — Yu-Gi-Oh! TCG

   Secciones:
     1) MODELOS / ESTADO
     2) PERSISTENCIA (localStorage + Export/Import JSON)
     3) MATEMÁTICA DE DESEMPATES (MatchPoints, OMW%, GW%)
     4) ALGORITMO DE EMPAREJAMIENTO SUIZO (Greedy + Backtracking)
     5) FLUJO DEL TORNEO (iniciar, reportar, avanzar, drop)
     6) RENDER / UI
     7) WIRING DE EVENTOS
   ============================================================================ */

/* ---------------------------------------------------------------------------
   1) MODELOS / ESTADO
   - Internamente referenciamos jugadores por id (Guid) en cada Match para que
     la serialización a JSON sea limpia y sin duplicación.
   - Match.player1/2 del spec se representan como p1Id / p2Id.
--------------------------------------------------------------------------- */
const STORAGE_KEY = 'ygo_swiss_v1';

function uid(){
  // Guid v4 simple (suficiente para uso local)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random()*16|0, v = c==='x'? r : (r&0x3|0x8);
    return v.toString(16);
  });
}

function emptyState(){
  return {
    started: false,
    finished: false,  // true cuando se jugó la última ronda (resultados definitivos)
    maxRounds: 0,     // rondas totales, fijadas al iniciar
    players: [],      // {id, name, dropped, hasReceivedBye, lateEntry, droppedAtRounds}
    rounds: [],       // {roundNumber, matches:[...]}
    currentRound: 0,  // número de la última ronda generada
    viewRound: 0,     // ronda visible en la pestaña (puede ser pasada)
    note: '',         // comentario libre del torneo (premiación, observaciones…)
    excludeDrops: true, // si está activo, los DROP se relegan al fondo de los standings (no compiten por prizing)
    timer: { endsAt: null, pausedMs: null, durationMin: 50 }, // cronómetro de ronda
    tieBreaks: {},    // desempates manuales del TO: { "idA|idB|...": [idGanador, ...] }
  };
}

/* Rondas sugeridas según jugadores, alineado a la tabla oficial Tier 1/2:
   4-8 → 3, 9-16 → 4, 17-32 → 5, etc. (Para N≥9 equivale a ⌈log2(N)⌉.)
   Es solo una sugerencia: el campo "Número de Rondas" sigue siendo editable. */
function computeMaxRounds(n){
  if(n >= 4 && n <= 8) return 3;
  return n >= 2 ? Math.ceil(Math.log2(n)) : 0;
}

let state = emptyState();

// UI: ¿el usuario editó manualmente el "Número de Rondas"? Si es false, el campo
// sigue autocompletándose con ⌈log2(N)⌉; si es true, respetamos su valor.
let roundsManuallySet = false;

function newMatch(p1Id, p2Id, opts={}){
  const isBye = opts.isBye ?? false;
  return {
    id: uid(),
    p1Id, p2Id,
    // result: 'p1' | 'p2' | 'doubleLoss' | null   (v2.5: el empate ya no existe)
    result: isBye ? 'p1' : null,   // el BYE se auto-reporta como victoria de p1
    isBye,
    isReported: isBye,
  };
}

const getPlayer = id => state.players.find(p => p.id === id);

/* ---------------------------------------------------------------------------
   2) PERSISTENCIA
   localStorage envuelto en try/catch: si el entorno lo bloquea (p.ej. el
   preview de un sandbox), la app sigue funcionando 100% en memoria; al abrir
   el archivo descargado en un navegador real, la persistencia funciona sola.
--------------------------------------------------------------------------- */
function save(){
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(e){ /* sin persistencia */ }
}
function load(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if(raw){
      const parsed = JSON.parse(raw);
      if(parsed && typeof parsed === 'object'){
        state = Object.assign(emptyState(), parsed);
        // Compat: torneos guardados antes del tope de rondas no traían maxRounds.
        if(state.started && !state.maxRounds) state.maxRounds = computeMaxRounds(state.players.length);
        // Compat: migra matches del formato viejo (game wins) al nuevo (result).
        for(const r of (state.rounds||[])) for(const m of (r.matches||[])){
          if(m.result === undefined){
            m.result = m.isBye ? 'p1'
              : (m.isDoubleLoss ? 'doubleLoss'
              : (m.isReported ? ((m.p1GameWins||0) >= (m.p2GameWins||0) ? 'p1' : 'p2') : null));
          }
          delete m.p1GameWins; delete m.p2GameWins; delete m.isDoubleLoss;
        }
      }
    }
  } catch(e){ /* estado limpio */ }
}

/* ---------------------------------------------------------------------------
   3) MATEMÁTICA DE DESEMPATES
   Cada jugador acumula su "número" de desempate AABBBCCCDDD:
     AA  = puntos totales        (Victoria 3 / Derrota 0 / Bye 3)   ↓ mayor mejor
     BBB = OMW%  · % victorias de tus oponentes        (×1000)      ↓ mayor mejor
     CCC = OOMW% · % victorias de los oponentes de tus oponentes    ↓ mayor mejor
     DDD = Σ (ronda_perdida)²                                       ↓ mayor mejor (*)
   (*) La política presenta AABBBCCCDDD como UN número y rankea de mayor a menor;
       por tanto TODOS los componentes, incluido DDD, ordenan descendente: perder
       en rondas TARDÍAS te coloca por encima de quien perdió temprano.
   Sin suelo del 33%. Sin GW% (rendimiento por duelos). Sin winrate individual
   como criterio directo. Único supuesto (la política calla sobre el Bye): el Bye
   da 3 pts en AA pero se EXCLUYE de todos los porcentajes.
   El orden REAL usa la tupla numérica (no la cadena), para no romperse cuando un
   % llega a 100% (1000 → 4 dígitos) o DDD supera 999 (14+ rondas).
--------------------------------------------------------------------------- */
function avg(a){ return a.length ? a.reduce((s,v)=>s+v,0) / a.length : 0; }
function pad(n,w){ return String(n).padStart(w,'0'); }   // sólo presentación

function computeStats(){
  const stats = {};
  for(const p of state.players){
    stats[p.id] = {
      id:p.id, name:p.name, dropped:p.dropped,
      matchPoints:0,            // AA (incluye Bye)
      mwPts:0, mwGames:0,       // numerador/denominador del MWP propio (sin Bye)
      wins:0, losses:0,         // récord a mostrar (Bye cuenta como win)
      opponents:[], lostRounds:[],
      mwp:0, omw:0, oomw:0, ddd:0,
    };
  }
  const h2h = {};               // h2h['X|Y']='a' ⇒ X venció a Y (desempate final)

  state.rounds.forEach((round, idx) => {
    const roundNo = idx + 1;
    for(const m of round.matches){
      if(!m.isReported) continue;
      if(m.isBye){ const s = stats[m.p1Id]; if(s){ s.matchPoints += 3; s.wins++; } continue; }
      // Late Entry: derrota administrativa por una ronda ya jugada. A diferencia del BYE,
      // SÍ cuenta como un partido jugado-y-perdido en su winrate (mwGames++, 0 pts), para que
      // su % real se refleje en el BBB/CCC de quienes lo enfrentaron. No tiene oponente, así
      // que no agrega rival a su propia lista. Suma puntos 0 (AA) y suma al DDD.
      if(m.isLateLoss){ const s = stats[m.p1Id]; if(s){ s.losses++; s.mwGames++; s.lostRounds.push(roundNo); } continue; }

      const a = stats[m.p1Id], b = stats[m.p2Id];
      if(!a || !b) continue;
      a.opponents.push(b.id); b.opponents.push(a.id);
      a.mwGames++; b.mwGames++;

      if(m.result === 'p1'){
        a.matchPoints += 3; a.mwPts += 3; a.wins++;
        b.losses++; b.lostRounds.push(roundNo);
        h2h[a.id+'|'+b.id]='a'; h2h[b.id+'|'+a.id]='b';
      } else if(m.result === 'p2'){
        b.matchPoints += 3; b.mwPts += 3; b.wins++;
        a.losses++; a.lostRounds.push(roundNo);
        h2h[a.id+'|'+b.id]='b'; h2h[b.id+'|'+a.id]='a';
      } else if(m.result === 'doubleLoss'){
        a.losses++; a.lostRounds.push(roundNo);
        b.losses++; b.lostRounds.push(roundNo);
      }
    }
  });

  const vals = Object.values(stats);
  for(const s of vals) s.mwp  = s.mwGames ? s.mwPts / (3 * s.mwGames) : 0;  // sin suelo
  for(const s of vals) s.omw  = avg(s.opponents.map(id => stats[id].mwp));   // BBB
  for(const s of vals) s.oomw = avg(s.opponents.map(id => stats[id].omw));   // CCC
  for(const s of vals){
    s.ddd = s.lostRounds.reduce((acc, r) => acc + r*r, 0);                   // DDD
    s.tieString = pad(s.matchPoints,2) + pad(Math.round(s.omw*1000),3)
                + pad(Math.round(s.oomw*1000),3) + pad(s.ddd,3);
  }
  stats._h2h = h2h;   // se adjunta tras armar `vals` (no es un jugador)
  return stats;
}

function headToHead(h2h, x, y){
  const r = h2h[x.id+'|'+y.id];
  if(r === 'a') return -1;   // x ganó el directo → x más arriba
  if(r === 'b') return 1;    // y ganó el directo → y más arriba
  return 0;                  // no jugaron / doble derrota → siguiente criterio
}

// BBB y CCC tal como aparecen en la cadena: % redondeado al primer decimal (entero 0–1000).
// Se comparan por estos ENTEROS, no por el float crudo: así el orden coincide exactamente
// con el string mostrado, y el ruido de punto flotante no decide un empate que el spec
// considera idéntico ("al primer decimal").
function bbbInt(s){ return Math.round(s.omw  * 1000); }
function cccInt(s){ return Math.round(s.oomw * 1000); }

/* Orden DETERMINISTA (sin azar) para el emparejador: AA↓ BBB↓ CCC↓ DDD↓, nombre. */
function sortByStandings(players, stats){
  return [...players].sort((a,b) => {
    const sa = stats[a.id], sb = stats[b.id];
    return (sb.matchPoints - sa.matchPoints)
        || (bbbInt(sb) - bbbInt(sa))
        || (cccInt(sb) - cccInt(sa))
        || (sb.ddd  - sa.ddd)
        || a.name.localeCompare(b.name);
  });
}

/* Tabla de posiciones FINAL: orden oficial + desempate head-to-head y, si persiste,
   un orden ESTABLE por id (uid aleatorio fijo): no cambia al recargar/exportar.
   Devuelve las entradas de stats ya ordenadas (cada una trae id/name/dropped). */
function computeStandings(){
  const stats = computeStats();
  const h2h = stats._h2h;
  const vals = state.players.map(p => stats[p.id]);
  vals.sort((x,y) =>
       (y.matchPoints - x.matchPoints)
    || (bbbInt(y) - bbbInt(x))
    || (cccInt(y) - cccInt(x))
    || (y.ddd  - x.ddd)
    || headToHead(h2h, x, y)
    || x.id.localeCompare(y.id)
  );
  return vals;
}

/* ---------------------------------------------------------------------------
   DESEMPATE MANUAL DEL TO (standings exactamente iguales)
   Cuando varios jugadores comparten el MISMO tieString (idénticos en
   MatchPoints·OMW·OOMW·DDD), el orden entre ellos lo decide hoy el uid
   aleatorio. Al finalizar, el TO puede realizar un método oficial (volado,
   dado, playoff…) y FIJAR el orden arrastrando. Ese orden se guarda en
   state.tieBreaks, indexado por el CONJUNTO de ids empatados (clave estable):
   sobrevive a recargas y solo aplica si el grupo conserva exactamente esos
   integrantes (si cambia, vuelve al aleatorio).
--------------------------------------------------------------------------- */
function tieGroupKey(ids){ return [...ids].sort().join('|'); }

/* Detecta los grupos de empate exacto en un arreglo YA ordenado de stats.
   Devuelve [{ start, size, ids, key, resolved }] solo para grupos de 2+. */
function tieGroupsOf(ordered){
  const groups = [];
  let i = 0;
  while(i < ordered.length){
    let j = i + 1;
    while(j < ordered.length
          && ordered[j].tieString === ordered[i].tieString
          && !!ordered[j].dropped === !!ordered[i].dropped) j++;
    if(j - i >= 2){
      const ids = ordered.slice(i, j).map(s => s.id);
      const key = tieGroupKey(ids);
      groups.push({ start:i, size:j-i, ids, key, resolved: !!(state.tieBreaks && state.tieBreaks[key]) });
    }
    i = j;
  }
  return groups;
}

/* Reordena IN-PLACE cada grupo de empate según el orden manual del TO. */
function applyTieBreaks(ordered){
  const tb = state.tieBreaks || {};
  for(const g of tieGroupsOf(ordered)){
    const order = tb[g.key];
    if(!order || order.length !== g.size) continue;
    const byId = new Map(ordered.slice(g.start, g.start + g.size).map(s => [s.id, s]));
    const reordered = order.map(id => byId.get(id)).filter(Boolean);
    if(reordered.length === g.size){
      for(let k = 0; k < g.size; k++) ordered[g.start + k] = reordered[k];
    }
  }
  return ordered;
}

/* Orden final mostrado por la tabla y el PNG: orden oficial + relegado de DROPs
   (modo premiación) + desempate manual del TO. Es la única fuente de verdad
   para lo que se ve; el emparejador NO usa esto (usa sortByStandings). */
function finalStandings(){
  let ordered = computeStandings();
  if(state.excludeDrops){
    ordered = ordered.filter(s => !s.dropped).concat(ordered.filter(s => s.dropped));
  }
  return applyTieBreaks(ordered);
}

/* Fija/actualiza el orden manual de un grupo (lo invoca el drag & drop). */
function setTieOrder(key, orderedIds){
  if(!state.tieBreaks) state.tieBreaks = {};
  state.tieBreaks[key] = orderedIds;
  save(); render();
}

/* Confirma el orden ACTUAL del grupo como definitivo (sin reordenar). Sirve
   cuando el TO decide que el orden aleatorio ofrecido está bien: lo fija tal
   cual y el grupo pasa de "tentativo" a "fijado". */
function confirmTieOrder(key){
  const ordered = finalStandings();
  const g = tieGroupsOf(ordered).find(gr => gr.key === key);
  if(!g) return;
  setTieOrder(key, ordered.slice(g.start, g.start + g.size).map(s => s.id));
}

/* Revierte un grupo al orden aleatorio (borra el desempate manual). */
function clearTieOrder(key){
  if(state.tieBreaks){ delete state.tieBreaks[key]; save(); render(); }
}

/* Mueve un jugador una posición ↑/↓ dentro de su grupo de empate (respaldo
   táctil del arrastre). dir = -1 (sube) | +1 (baja). */
function moveTie(id, dir){
  const ordered = finalStandings();
  const g = tieGroupsOf(ordered).find(gr => gr.ids.includes(id));
  if(!g) return;
  const ids = ordered.slice(g.start, g.start + g.size).map(s => s.id);
  const from = ids.indexOf(id), to = from + dir;
  if(to < 0 || to >= ids.length) return;
  [ids[from], ids[to]] = [ids[to], ids[from]];
  setTieOrder(g.key, ids);
}

/* ---------------------------------------------------------------------------
   4) ALGORITMO DE EMPAREJAMIENTO SUIZO (Greedy + Backtracking)
--------------------------------------------------------------------------- */

// ¿Estos dos jugadores ya se enfrentaron antes en el torneo? (ignora Byes)
function havePlayed(aId, bId){
  for(const round of state.rounds){
    for(const m of round.matches){
      if(m.isBye) continue;
      if((m.p1Id===aId && m.p2Id===bId) || (m.p1Id===bId && m.p2Id===aId)) return true;
    }
  }
  return false;
}

/* Backtracking recursivo.
   `players` viene pre-ordenado por standings (mayor→menor). Tomamos siempre al
   primero y probamos al rival válido más cercano (i=1,2,3…). Esto da el sesgo
   "greedy" de emparejar dentro del mismo grupo de puntaje; si una rama lleva a
   un deadlock (a todos los restantes ya se enfrentaron), retorna null y el nivel
   anterior deshace su emparejamiento y prueba la siguiente alternativa.
   Devuelve un array de parejas [ [pA,pB], ... ] o null si no hay solución. */
function pairBacktrack(players){
  if(players.length === 0) return [];
  const first = players[0];
  for(let i=1; i<players.length; i++){
    const opp = players[i];
    if(havePlayed(first.id, opp.id)) continue;
    const rest = players.slice(1, i).concat(players.slice(i+1));
    const sub = pairBacktrack(rest);
    if(sub !== null) return [[first, opp], ...sub];
  }
  return null; // deadlock → backtrack
}

// Plan B: si es imposible evitar todos los rematches, emparejar igual (greedy puro).
function pairAllowRematch(players){
  const res = [];
  const pool = [...players];
  while(pool.length){
    const a = pool.shift();
    const b = pool.shift();
    res.push([a, b]);
  }
  return res;
}

function shuffle(arr){
  for(let i=arr.length-1; i>0; i--){
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* Resuelve una ronda IMPAR eligiendo el BYE de forma dinámica: el BYE entra al
   proceso de validación. Se prueban candidatos en orden de preferencia (los que
   NUNCA tuvieron bye, de menos a más puntos) y, para cada uno, se intenta
   emparejar al resto SIN revanchas. El primer candidato que lo logra gana.
   Devuelve { byePlayer, pairs, rematchForced }. No muta el estado. */
function solveOddRound(active, stats, isFirstRound){
  const byPointsAsc = arr => [...arr].sort((a,b) =>
    (stats[a.id].matchPoints - stats[b.id].matchPoints) || a.name.localeCompare(b.name));
  // Orden del resto al emparejar: R1 baraja; en adelante, por standings.
  const orderRest = rest => isFirstRound ? shuffle([...rest]) : sortByStandings(rest, stats);

  // 1) Candidatos elegibles para BYE: nunca lo recibieron, de menos a más puntos.
  const eligible = byPointsAsc(active.filter(p => !p.hasReceivedBye));

  // 2) Bucle de prueba (backtracking del BYE):
  //    el primer candidato cuyo "resto" se empareja sin revanchas, gana.
  for(const cand of eligible){
    const rest = active.filter(p => p.id !== cand.id);
    const pairs = pairBacktrack(orderRest(rest));
    if(pairs !== null) return { byePlayer: cand, pairs, rematchForced:false };
  }

  // 3) CLÁUSULA DE ESCAPE (último recurso):
  if(eligible.length){
    // Hay elegibles pero ninguno evita la revancha: conservar el preferente
    // (menos puntos) y permitir el rematch como última opción.
    const byePlayer = eligible[0];
    const rest = active.filter(p => p.id !== byePlayer.id);
    let pairs = pairBacktrack(orderRest(rest));
    if(pairs === null) pairs = pairAllowRematch(orderRest(rest));
    return { byePlayer, pairs, rematchForced:true };
  }
  // Caso degenerado: TODOS los activos ya recibieron bye (pool muy pequeño).
  // Intentar igualmente evitar revancha probando el pool completo como BYE.
  const pool = byPointsAsc(active);
  for(const cand of pool){
    const rest = active.filter(p => p.id !== cand.id);
    const pairs = pairBacktrack(orderRest(rest));
    if(pairs !== null) return { byePlayer: cand, pairs, rematchForced:false };
  }
  // Imposible evitar revancha de cualquier forma: bye al de menos puntos + rematch.
  const byePlayer = pool[0];
  const rest = active.filter(p => p.id !== byePlayer.id);
  return { byePlayer, pairs: pairAllowRematch(orderRest(rest)), rematchForced:true };
}

/* Genera los matches de una nueva ronda y la agrega al estado. */
function generateRound(){
  // GUARD CLAUSE: nunca generar más allá del límite de rondas del torneo.
  // Esto previene de raíz la "Ronda 4 fantasma" con rematches forzados.
  if(state.maxRounds && state.rounds.length >= state.maxRounds){
    return false;
  }

  const stats = computeStats();
  const active = state.players.filter(p => !p.dropped);

  if(active.length < 2){
    showToast('Se necesitan al menos 2 jugadores activos para generar una ronda.', true);
    return false;
  }

  const isFirstRound = state.rounds.length === 0;
  const matches = [];
  let rematchForced = false;

  if(active.length % 2 === 0){
    // PAR: sin BYE. Emparejar con backtracking (R1 baraja, resto por standings).
    const ordered = isFirstRound ? shuffle([...active]) : sortByStandings(active, stats);
    let pairs = pairBacktrack(ordered);
    if(pairs === null){ pairs = pairAllowRematch(ordered); rematchForced = true; }
    for(const [a, b] of pairs) matches.push(newMatch(a.id, b.id));
  } else {
    // IMPAR: el BYE es parte de la búsqueda (ver solveOddRound).
    const sol = solveOddRound(active, stats, isFirstRound);
    rematchForced = sol.rematchForced;
    sol.byePlayer.hasReceivedBye = true; // se marca SOLO el elegido (no en los intentos)
    matches.push(newMatch(sol.byePlayer.id, null, { isBye:true }));
    for(const [a, b] of sol.pairs) matches.push(newMatch(a.id, b.id));
  }

  state.currentRound += 1;
  state.viewRound = state.currentRound;
  state.rounds.push({ roundNumber: state.currentRound, matches, rematchForced });
  timerReset();   // nueva ronda → timer a cero en ambas pantallas; el título se refresca solo
  return true;
}

/* ---------------------------------------------------------------------------
   5) FLUJO DEL TORNEO
--------------------------------------------------------------------------- */
function addPlayer(name){
  name = name.trim();
  if(!name) return;
  if(state.started){ showToast('El registro está cerrado.', true); return; }
  if(state.players.some(p => p.name.toLowerCase() === name.toLowerCase())){
    showToast('Ya existe un jugador con ese nombre.', true); return;
  }
  state.players.push({ id: uid(), name, dropped:false, hasReceivedBye:false });
  save(); render();
}

/* Parsea el textarea de "pegar lista": una línea por nombre, descartando la
   numeración de listas (estilo WhatsApp "1. Mati", "10) Tavo", "11.") y las
   líneas vacías que deja esa numeración. Solo se quita el prefijo cuando hay un
   delimitador tras el número (. ) : -), para no mutilar nombres como "2 Pac". */
function parseBulkNames(text){
  return (text || '')
    .split(/\r?\n/)
    .map(s => s.replace(/^\s*\d{1,4}[.)\:\-]\s*/, '').trim())
    .filter(Boolean);
}

function addPlayersBulk(text){
  if(state.started){ showToast('El registro está cerrado.', true); return; }
  const lines = parseBulkNames(text);
  if(lines.length === 0){ showToast('Pega al menos un nombre por línea.', true); return; }
  const existing = new Set(state.players.map(p => p.name.toLowerCase()));
  let added = 0, dupes = 0;
  for(const name of lines){
    const key = name.toLowerCase();
    if(existing.has(key)){ dupes++; continue; } // omite duplicados (también dentro de la lista)
    existing.add(key);
    state.players.push({ id: uid(), name: name.slice(0,40), dropped:false, hasReceivedBye:false });
    added++;
  }
  save();
  document.getElementById('player-bulk').value = '';
  render();
  let msg = `Agregados: ${added}.`;
  if(dupes) msg += ` Omitidos por duplicado: ${dupes}.`;
  showToast(msg, added === 0);
}

function removePlayer(id){
  if(state.started) return;
  state.players = state.players.filter(p => p.id !== id);
  save(); render();
}

/* LATE ENTRY (política oficial): inscribe a un jugador con el torneo ya iniciado.
   Recibe una derrota administrativa por CADA ronda ya generada y se empareja desde
   la próxima ronda. No cambia el número de rondas del torneo. */
function lateEntryOpen(){
  return state.started && !state.finished && state.rounds.length < state.maxRounds;
}
function _createLatePlayer(name){
  const player = { id: uid(), name: name.slice(0,40), dropped:false, hasReceivedBye:false, lateEntry:true };
  // Una derrota por cada ronda ya jugada (se anexa al final de cada ronda).
  for(const r of state.rounds){
    r.matches.push({ id: uid(), p1Id: player.id, p2Id: null, result: 'lateLoss', isBye:false, isReported:true, isLateLoss:true });
  }
  state.players.push(player);
  return player;
}
function addLateEntry(name){
  name = (name || '').trim();
  if(!name) return;
  if(!lateEntryOpen()){ showToast('El Late Entry sólo aplica con el torneo en curso y rondas por jugar.', true); return; }
  if(state.players.some(p => p.name.toLowerCase() === name.toLowerCase())){
    showToast('Ya existe un jugador con ese nombre.', true); return;
  }
  _createLatePlayer(name);
  save(); render();
  showToast(`${name} entró tarde con ${state.rounds.length} derrota(s); se empareja en la próxima ronda.`);
}
function addLateEntriesBulk(text){
  if(!lateEntryOpen()){ showToast('El Late Entry sólo aplica con el torneo en curso y rondas por jugar.', true); return; }
  const lines = parseBulkNames(text);
  if(lines.length === 0){ showToast('Pega al menos un nombre por línea.', true); return; }
  const existing = new Set(state.players.map(p => p.name.toLowerCase()));
  let added = 0, dupes = 0;
  for(const name of lines){
    const key = name.toLowerCase();
    if(existing.has(key)){ dupes++; continue; }
    existing.add(key);
    _createLatePlayer(name);
    added++;
  }
  save();
  document.getElementById('player-bulk').value = '';
  render();
  let msg = `Late entries agregados: ${added} (con ${state.rounds.length} derrota(s) c/u).`;
  if(dupes) msg += ` Omitidos por duplicado: ${dupes}.`;
  showToast(msg, added === 0);
}

/* ---------------------------------------------------------------------------
   CRONÓMETRO DE RONDA (50 min por defecto). Estado en state.timer:
     endsAt   = timestamp absoluto cuando corre (sobrevive recargas)
     pausedMs = ms restantes cuando está en pausa
     durationMin = duración configurada
--------------------------------------------------------------------------- */
let _timerInterval = null;
let _timerWin = null;   // ventana de proyección (pantalla de tienda), si está abierta
function _timer(){ if(!state.timer) state.timer = { endsAt:null, pausedMs:null, durationMin:50 }; return state.timer; }
function roundTitleText(){
  if(!state.started) return 'SwissYGO';
  if(state.finished) return 'Torneo finalizado';
  return 'Ronda ' + state.currentRound + ' de ' + state.maxRounds;
}
function timerRunning(){ return !!_timer().endsAt; }
function timerRemainingMs(){
  const t = _timer();
  if(t.endsAt) return Math.max(0, t.endsAt - Date.now());
  if(t.pausedMs != null) return t.pausedMs;
  return (t.durationMin || 50) * 60000;
}
function fmtMMSS(ms){
  const tot = Math.ceil(ms / 1000), m = Math.floor(tot / 60), s = tot % 60;
  return String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
}
function renderTimer(){
  const ms = timerRemainingMs();
  const active = timerRunning() || _timer().pausedMs != null;
  const over = ms <= 0 && active;
  const txt = fmtMMSS(ms);

  const disp = $('#timer-display');
  if(disp){
    disp.textContent = txt;
    disp.classList.toggle('over', over);
    const toggle = $('#timer-toggle');
    if(toggle) toggle.textContent = timerRunning() ? 'Pausar' : (_timer().pausedMs != null ? 'Reanudar' : 'Iniciar');
    const minInput = $('#timer-min');
    if(minInput && document.activeElement !== minInput) minInput.value = _timer().durationMin || 50;
    // El campo de minutos solo se ve detenido (antes de iniciar / tras reiniciar): así no compite con el reloj.
    const minWrap = $('#timer-min-wrap');
    if(minWrap){
      const idle = !timerRunning() && _timer().pausedMs == null;
      minWrap.style.display = idle ? '' : 'none';
    }
  }

  // La ventana de proyección tiene su propio reloj; solo le reenviamos el estado.
  _pushTimerWin();
}
/* Reenvía el estado del timer a la ventana de proyección. Esa ventana corre su
   propio bucle a partir de endsAt absoluto, así que sigue avanzando aunque esta
   pestaña quede congelada en segundo plano (típico en móvil). */
function _pushTimerWin(){
  if(!_timerWin || _timerWin.closed) return;
  try {
    const t = _timer();
    if(typeof _timerWin.applyState === 'function'){
      // Al finalizar el torneo, la proyección pasa a "pantalla de campeón":
      // enviamos los standings (con la misma partición de DROPs que la tabla).
      let standings = null;
      if(state.finished){
        const ordered = finalStandings();
        standings = ordered.map(s => ({
          name: s.name, pts: s.matchPoints, wl: s.wins + '-' + s.losses, dropped: !!s.dropped
        }));
      }
      _timerWin.applyState({
        endsAt: t.endsAt,
        pausedMs: t.pausedMs,
        durationMin: t.durationMin || 50,
        title: roundTitleText(),
        finished: !!state.finished,
        standings: standings
      });
    } else {
      // El documento aún no terminó de cargar su script: pintamos directo por esta vez.
      const d = _timerWin.document;
      const ms = timerRemainingMs(), active = timerRunning() || t.pausedMs != null, over = ms <= 0 && active;
      const bt = d.getElementById('big-time'); if(bt){ bt.textContent = fmtMMSS(ms); bt.classList.toggle('over', over); }
      const br = d.getElementById('big-round'); if(br) br.textContent = roundTitleText();
      const bs = d.getElementById('big-sub');  if(bs) bs.textContent = over ? '¡TIEMPO!' : '';
    }
  } catch(e){ /* ventana cerrada o sin acceso */ }
}
function timerToggle(){
  const t = _timer();
  if(t.endsAt){ t.pausedMs = Math.max(0, t.endsAt - Date.now()); t.endsAt = null; }   // pausar
  else { t.endsAt = Date.now() + (t.pausedMs != null ? t.pausedMs : (t.durationMin||50)*60000); t.pausedMs = null; } // iniciar/reanudar
  save(); renderTimer();
}
function timerReset(){ const t = _timer(); t.endsAt = null; t.pausedMs = null; save(); renderTimer(); }
function timerSetMinutes(v){
  const n = Math.max(1, Math.min(180, parseInt(v,10) || 50));
  _timer().durationMin = n;
  save(); renderTimer();
}
function startTimerLoop(){ if(!_timerInterval) _timerInterval = setInterval(renderTimer, 1000); }

/* Aplica el tema actual de la app a la ventana de proyección (lee las variables
   computadas del documento principal y las copia como variables de la ventana). */
function _applyTimerWinTheme(){
  if(!_timerWin || _timerWin.closed) return;
  try {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
    const root = _timerWin.document.documentElement.style;
    root.setProperty('--pp-bg',     v('--bg', '#14131f'));
    root.setProperty('--pp-ink',    v('--ink', '#eef1f7'));
    root.setProperty('--pp-accent', v('--gold', '#82d8eb'));
    root.setProperty('--pp-over',   v('--crimson', '#e5534b'));
    root.setProperty('--pp-line',   v('--border-2', '#443f5d'));
  } catch(e){ /* sin acceso */ }
}

/* Abre (o reenfoca) la proyección del timer para las pantallas de la tienda.
   Se abre como PESTAÑA normal (sin features en window.open): así conserva la barra
   completa de Chrome, incluido el menú ⋮ → "Transmitir…" para castear la pestaña a
   un Chromecast. (Un popup con features pierde esa UI y no se puede castear.)
   Muestra el título de la ronda + el tiempo, y corre su PROPIO bucle de reloj a
   partir del endsAt absoluto que le pasa la app, así sigue avanzando aunque la
   pestaña principal quede dormida en segundo plano (móvil). */
function openTimerWindow(){
  if(_timerWin && !_timerWin.closed){ _timerWin.focus(); return; }
  const w = window.open('', 'ygoTimerWindow');
  if(!w){ showToast('El navegador bloqueó la pestaña. Permite pop-ups para proyectar el timer.', true); return; }
  w.document.open();
  w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Timer · SwissYGO</title><style>
    :root{--pp-bg:#14131f;--pp-ink:#eef1f7;--pp-accent:#82d8eb;--pp-over:#e5534b;--pp-line:#443f5d;}
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{height:100%;width:100%;}
    body{background:var(--pp-bg);color:var(--pp-ink);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.5vh;overflow:hidden;transition:background .2s,color .2s;}
    #big-round{font-size:min(9vh,9vw);font-weight:700;color:var(--pp-accent);letter-spacing:1px;text-align:center;padding:0 4vw;}
    #big-time{font-size:min(50vh,34vw);font-weight:800;line-height:.9;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
    #big-time.over{color:var(--pp-over);}
    #big-sub{font-size:min(6vh,7vw);color:var(--pp-over);font-weight:800;height:1.15em;letter-spacing:3px;}
    #champ-screen{display:none;flex-direction:column;align-items:center;gap:2.2vh;width:100%;padding:0 4vw;}
    #champ-label{font-size:min(5.5vh,5vw);font-weight:800;color:var(--pp-accent);letter-spacing:5px;}
    /* line-height ≥1.25: con line-height:1 el overflow:hidden (necesario para el
       ellipsis) recortaba los descendentes de letras como j, g, y, p, q. */
    #champ-name{font-size:min(22vh,15vw);font-weight:900;line-height:1.25;text-align:center;max-width:94vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    #champ-list{display:flex;flex-direction:column;gap:.9vh;margin-top:1.5vh;font-size:min(4.4vh,3.6vw);font-weight:600;}
    #champ-list .crow{display:flex;align-items:baseline;gap:1.6vw;}
    #champ-list .cpos{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--pp-accent);min-width:2.2em;text-align:right;}
    #champ-list .cpts{color:var(--pp-accent);opacity:.85;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
    #champ-list .cdrop{opacity:.45;text-decoration:line-through;}
    #champ-list .cmore{opacity:.55;font-weight:500;}
    #fs-btn{position:fixed;bottom:18px;right:18px;background:transparent;color:var(--pp-ink);opacity:.6;border:1px solid var(--pp-line);border-radius:8px;padding:9px 13px;font-size:14px;cursor:pointer;font-family:inherit;}
    #fs-btn:hover{opacity:1;}
    :fullscreen #fs-btn{opacity:.15;}
  </style></head><body>
    <div id="big-round">Ronda —</div>
    <div id="big-time">00:00</div>
    <div id="big-sub"></div>
    <div id="champ-screen">
      <div id="champ-label">🏆 CAMPEÓN</div>
      <div id="champ-name"></div>
      <div id="champ-list"></div>
    </div>
    <button id="fs-btn" onclick="if(document.fullscreenElement){document.exitFullscreen();}else if(document.documentElement.requestFullscreen){document.documentElement.requestFullscreen();}">⛶ Pantalla completa</button>
    <script>
      (function(){
        var S = { endsAt:null, pausedMs:null, durationMin:50, title:'SwissYGO', finished:false, standings:null };
        var MAX_ROWS = 8; // filas visibles después del campeón
        function fmt(ms){ var tot=Math.ceil(ms/1000), m=Math.floor(tot/60), s=tot%60; return (m<10?'0'+m:m)+':'+(s<10?'0'+s:s); }
        function remaining(){ if(S.endsAt) return Math.max(0, S.endsAt - Date.now()); if(S.pausedMs!=null) return S.pausedMs; return (S.durationMin||50)*60000; }
        function champMode(){ return !!(S.finished && S.standings && S.standings.length); }
        /* Construye la pantalla de campeón. SIEMPRE vía DOM/textContent: los nombres
           vienen del registro y jamás deben interpretarse como HTML. */
        function buildChamp(){
          var nameEl = document.getElementById('champ-name');
          var listEl = document.getElementById('champ-list');
          if(!nameEl || !listEl) return;
          var rows = S.standings;
          var champIdx = -1;
          for(var i=0;i<rows.length;i++){ if(!rows[i].dropped){ champIdx=i; break; } }
          if(champIdx === -1) champIdx = 0; // todos drop: el primero igual corona
          nameEl.textContent = rows[champIdx].name;
          while(listEl.firstChild) listEl.removeChild(listEl.firstChild);
          var shown = 0;
          for(var j=0;j<rows.length;j++){
            if(j === champIdx) continue;
            if(shown >= MAX_ROWS){
              var more = document.createElement('div');
              more.className = 'crow cmore';
              more.textContent = '+ ' + (rows.length - 1 - shown) + ' más…';
              listEl.appendChild(more);
              break;
            }
            var r = rows[j];
            var row = document.createElement('div');
            row.className = 'crow' + (r.dropped ? ' cdrop' : '');
            var pos = document.createElement('span'); pos.className='cpos'; pos.textContent = (j+1) + '.';
            var nm  = document.createElement('span'); nm.textContent = r.name;
            var pt  = document.createElement('span'); pt.className='cpts'; pt.textContent = r.pts + ' pts (' + r.wl + ')';
            row.appendChild(pos); row.appendChild(nm); row.appendChild(pt);
            listEl.appendChild(row);
            shown++;
          }
        }
        function render(){
          var champ = champMode();
          var cs = document.getElementById('champ-screen');
          var bt = document.getElementById('big-time');
          var br = document.getElementById('big-round');
          var bs = document.getElementById('big-sub');
          if(cs) cs.style.display = champ ? 'flex' : 'none';
          if(bt) bt.style.display = champ ? 'none' : '';
          if(bs) bs.style.display = champ ? 'none' : '';
          if(br) br.style.display = champ ? 'none' : '';
          if(champ) return; // la corona no necesita el tick del reloj
          var active = !!S.endsAt || S.pausedMs!=null;
          var ms = remaining();
          var over = ms<=0 && active;
          var bt = document.getElementById('big-time');
          if(bt){ bt.textContent = fmt(ms); bt.classList.toggle('over', over); }
          var br = document.getElementById('big-round'); if(br) br.textContent = S.title || 'SwissYGO';
          var bs = document.getElementById('big-sub');  if(bs) bs.textContent = over ? '¡TIEMPO!' : '';
        }
        window.applyState = function(s){
          if(s) S = s;
          if(champMode()){
            // Reconstruir solo si los standings cambiaron (llega un push por segundo).
            var sig = JSON.stringify(S.standings);
            if(sig !== window.__champSig){ window.__champSig = sig; buildChamp(); }
          } else {
            window.__champSig = null;
          }
          render();
        };
        setInterval(render, 250);
        document.addEventListener('visibilitychange', render);
        render();
      })();
    <\/script>
  </body></html>`);
  w.document.close();
  _timerWin = w;
  _applyTimerWinTheme();
  _pushTimerWin();
  renderTimer();
}

function startTournament(){
  if(state.players.length < 2){ showToast('Agrega al menos 2 jugadores.', true); return; }

  // MaxRounds se toma del campo "Número de Rondas" (editable por el TO).
  const field = document.getElementById('num-rounds');
  let rounds = parseInt(field.value, 10);
  if(isNaN(rounds) || rounds < 1){
    showToast('Ingresa un número de rondas válido (≥ 1).', true);
    field.focus();
    return;
  }
  if(rounds > 50) rounds = 50; // tope de seguridad ante typos

  state.started = true;
  state.finished = false;
  state.maxRounds = rounds;
  if(generateRound()){
    save(); switchTab('rondas'); render();
  }
}

/* Un único reporte: un toque marca al ganador del match.
   result: 'p1' | 'p2' | 'doubleLoss' | null (null = limpiar). */
function reportResult(matchId, result){
  if(state.finished) return;          // resultados bloqueados al finalizar
  const m = findMatch(matchId);
  if(!m || m.isBye) return;           // el Bye no se reporta a mano
  m.result = result;
  m.isReported = result !== null;
  save(); render();
}

function findMatch(matchId){
  for(const r of state.rounds) for(const m of r.matches) if(m.id === matchId) return m;
  return null;
}

function currentRoundObj(){ return state.rounds.find(r => r.roundNumber === state.currentRound) || null; }
function viewedRoundObj(){ return state.rounds.find(r => r.roundNumber === state.viewRound) || null; }

function allReported(round){ return round && round.matches.every(m => m.isReported); }

function advanceRound(){
  if(state.finished) return;
  const cur = currentRoundObj();
  if(!cur || !allReported(cur)){ showToast('Faltan mesas por reportar.', true); return; }

  // Si estamos en la última ronda, NO se genera otra: se finaliza el torneo.
  if(state.currentRound >= state.maxRounds){
    openConfirm(
      'Esta es la última ronda. Al finalizar se bloquean los resultados y se calculan los standings definitivos.',
      () => finishTournament(),
      { title:'Finalizar Torneo', confirmText:'Finalizar' }
    );
    return;
  }

  if(generateRound()){ save(); render(); showToast('Ronda ' + state.currentRound + ' generada.'); }
}

/* Cierra el torneo: bloquea resultados y lleva a Standings definitivos. */
function finishTournament(){
  state.finished = true;
  save();
  switchTab('standings');
  render();
  showToast('🏆 Torneo finalizado — standings definitivos.');
}

/* Recalcula hasReceivedBye de cada jugador a partir de las rondas vigentes.
   Se usa al descartar una ronda para no dejar flags de bye "fantasma". */
function recomputeByeFlags(){
  const had = new Set();
  for(const r of state.rounds) for(const m of r.matches) if(m.isBye) had.add(m.p1Id);
  for(const p of state.players) p.hasReceivedBye = had.has(p.id);
}

/* Corregir la ronda inmediatamente anterior: sólo permitido si la ronda actual
   ya se generó pero NO tiene resultados reportados. Descarta los emparejamientos
   de la ronda actual (no había datos que perder), retrocede a la anterior para
   editarla, y al volver a "Avanzar" se generan de nuevo los pairings. */
function correctPreviousRound(){
  if(state.finished) return;
  if(state.currentRound < 2){ showToast('No hay ronda anterior que corregir.', true); return; }
  const cur = currentRoundObj();
  const hasReported = cur && cur.matches.some(m => !m.isBye && m.isReported);
  if(hasReported){
    showToast('La ronda actual ya tiene resultados; no se puede retroceder.', true); return;
  }
  const discarded = state.currentRound;
  openConfirm(
    `Se descartarán los emparejamientos de la Ronda ${discarded} (no tiene resultados) para que puedas corregir la Ronda ${discarded - 1}. Después podrás volver a generar la Ronda ${discarded}.`,
    () => {
      state.rounds = state.rounds.filter(r => r.roundNumber !== discarded);
      state.currentRound -= 1;
      state.viewRound = state.currentRound;
      recomputeByeFlags(); // el bye de la ronda descartada deja de contar
      save(); render();
      showToast(`Ronda ${discarded} descartada. Corrige la Ronda ${state.currentRound} y pulsa "Avanzar" para regenerarla.`);
    },
    { title:'Corregir ronda anterior', confirmText:'Sí, corregir' }
  );
}

function toggleDrop(id){
  if(state.finished) return; // sin cambios de roster tras finalizar
  const p = getPlayer(id); if(!p) return;
  if(!p.dropped){
    p.dropped = true;
    p.droppedAtRounds = state.rounds.length; // cuántas rondas existían al hacer drop
  } else {
    // Reingreso permitido SÓLO si no se generó ninguna ronda desde el drop.
    const at = p.droppedAtRounds ?? state.rounds.length; // saves viejos: permisivo
    if(state.rounds.length !== at){
      showToast('No puede reingresar: ya se jugó al menos una ronda sin este jugador.', true);
      return;
    }
    p.dropped = false;
    delete p.droppedAtRounds;
  }
  save(); render();
}

function resetAll(){
  openConfirm(
    'Se borrarán todos los jugadores y rondas actuales. Esta acción no se puede deshacer.',
    () => {
      state = emptyState(); roundsManuallySet = false; save(); switchTab('registro'); render();
    },
    { title:'Nuevo Torneo', confirmText:'Sí, reiniciar', danger:true }
  );
}

/* ---------------------------------------------------------------------------
   6) RENDER / UI
--------------------------------------------------------------------------- */
const $ = sel => document.querySelector(sel);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pct = v => (v*100).toFixed(2) + '%';

function render(){
  renderRegistro();
  renderRondas();
  renderStandings();
}

function renderRegistro(){
  const lateOpen = lateEntryOpen();
  const formMode = !state.started ? 'reg' : (lateOpen ? 'late' : 'closed');
  const formEnabled = formMode === 'reg' || formMode === 'late';
  const countTxt = state.players.length ? '· ' + state.players.length + ' inscritos' : '';

  // El form principal se reutiliza: registro normal antes de iniciar; Late Entry en curso.
  $('#player-name').disabled = !formEnabled;
  $('#add-player').disabled  = !formEnabled;
  $('#player-bulk').disabled = !formEnabled;
  $('#add-bulk').disabled    = !formEnabled;

  const modeHint = $('#reg-mode-hint');
  if(formMode === 'late'){
    $('#reg-title').innerHTML = 'Late Entry <span class="count" id="reg-count">' + countTxt + '</span>';
    $('#add-player').textContent = 'Agregar (Late Entry)';
    $('#add-bulk').textContent   = 'Agregar lista (Late Entry)';
    modeHint.style.display = '';
    modeHint.innerHTML = 'Torneo en curso: cada nombre entra como <strong>Late Entry</strong> con una derrota por cada ronda ya jugada (0 pts, suma al DDD y baja su winrate) y se empareja desde la próxima ronda.';
  } else {
    $('#reg-title').innerHTML = 'Inscripción de Jugadores <span class="count" id="reg-count">' + countTxt + '</span>';
    $('#add-player').textContent = 'Agregar Jugador';
    $('#add-bulk').textContent   = 'Agregar lista';
    if(formMode === 'closed'){
      modeHint.style.display = '';
      modeHint.innerHTML = state.finished ? 'Torneo finalizado · registro cerrado.' : 'Ventana de Late Entry cerrada (no quedan rondas por jugar).';
    } else {
      modeHint.style.display = 'none';
    }
  }

  // --- Setup (pre-inicio) vs Resumen (en curso) ---
  $('#setup-controls').style.display = state.started ? 'none' : '';
  const summary = $('#setup-summary');
  summary.style.display = state.started ? '' : 'none';

  const roundsField = $('#num-rounds');
  const suggestion  = $('#rounds-suggestion');
  const suggested = computeMaxRounds(state.players.length);
  if(!state.started){
    roundsField.disabled = false;
    if(!roundsManuallySet) roundsField.value = suggested > 0 ? suggested : '';
    suggestion.innerHTML = suggested > 0 ? `Sugerido: <strong>${suggested}</strong> · editable` : 'Agrega al menos 2 jugadores';
    const hint = $('#start-hint');
    if(state.players.length >= 2){
      const chosen = parseInt(roundsField.value, 10);
      let msg = `Sugerencia: <strong>${suggested} ronda(s)</strong> (tabla oficial; 4-8 jugadores → 3). Editable antes de iniciar.`;
      if(!isNaN(chosen) && chosen > suggested){
        msg += ` Con <strong>${chosen}</strong> extiendes el evento; si se agotan los emparejamientos únicos, alguna ronda podría forzar revanchas (se avisa).`;
      }
      hint.innerHTML = msg;
    } else {
      hint.innerHTML = 'Necesitas al menos 2 jugadores para iniciar.';
    }
  } else {
    const activos = state.players.filter(p => !p.dropped).length;
    const lates   = state.players.filter(p => p.lateEntry).length;
    summary.innerHTML = `<table><tbody>
      <tr><td>Estado</td><td class="num">${state.finished ? 'Finalizado' : 'En curso'}</td></tr>
      <tr><td>Ronda</td><td class="num">${state.currentRound} / ${state.maxRounds}</td></tr>
      <tr><td>Jugadores</td><td class="num">${state.players.length} (${activos} activos)</td></tr>
      <tr><td>Late entries</td><td class="num">${lates}</td></tr>
    </tbody></table>`;
  }
  $('#start-tournament').disabled = state.started || state.players.length < 2;
  $('#start-tournament').textContent = state.started ? 'Torneo en curso' : 'Iniciar Torneo';

  // Marca el desplegable de comentario si ya hay texto guardado (para que no quede oculto).
  const noteBadge = $('#note-badge');
  if(noteBadge) noteBadge.textContent = (state.note && state.note.trim()) ? ' •' : '';

  // --- Lista de inscritos (con marca Late / DROP; clave para import/export) ---
  const list = $('#reg-list');
  if(state.players.length === 0){
    list.innerHTML = '<div class="empty">Aún no hay jugadores inscritos.</div>';
  } else {
    let rows = state.players.map((p,i) => `
      <tr>
        <td class="pos">${i+1}</td>
        <td>${esc(p.name)}${p.lateEntry ? ' <span class="pill pill-pend">Late</span>' : ''}${p.dropped ? ' <span class="pill pill-drop">DROP</span>' : ''}</td>
        <td style="text-align:right;">
          ${state.started ? '' : `<button class="btn btn-sm btn-danger" data-action="remove" data-id="${p.id}">Eliminar</button>`}
        </td>
      </tr>`).join('');
    list.innerHTML = `<table><tbody>${rows}</tbody></table>`;
  }

  // --- Nota / premiación (editable siempre, persistida y exportada) ---
  const noteEl = $('#tournament-note');
  if(noteEl && document.activeElement !== noteEl) noteEl.value = state.note || '';
}

function playerNameById(id){ const p = getPlayer(id); return p ? p.name : '—'; }

function renderRondas(){
  const title = $('#round-title');
  const matchesList = $('#matches-list');
  const banner = $('#round-banner');
  const selector = $('#round-selector');
  const toolbar = $('#round-toolbar');
  const hint = $('#round-hint');
  const timerBar = $('#timer-bar');

  if(!state.started || state.rounds.length === 0){
    title.textContent = 'Ronda —';
    selector.innerHTML = '';
    banner.innerHTML = '';
    matchesList.innerHTML = '<div class="empty">El torneo aún no ha iniciado. Ve a la pestaña <strong>Registro</strong>.</div>';
    toolbar.style.display = 'none';
    if(timerBar) timerBar.style.display = 'none';
    hint.innerHTML = '';
    return;
  }
  toolbar.style.display = '';
  // Cronómetro de ronda: visible mientras el torneo está en curso (no finalizado).
  if(timerBar){
    timerBar.style.display = state.finished ? 'none' : '';
    if(!state.finished) renderTimer();
  }

  // Selector de rondas (para ver historial)
  selector.innerHTML = state.rounds.map(r =>
    `<option value="${r.roundNumber}" ${r.roundNumber===state.viewRound?'selected':''}>Ronda ${r.roundNumber}${r.roundNumber===state.currentRound?' (actual)':''}</option>`
  ).join('');

  const round = viewedRoundObj();
  const isCurrent = round.roundNumber === state.currentRound;
  // Editable sólo en la ronda actual y mientras el torneo no haya finalizado.
  const editable = isCurrent && !state.finished;
  title.textContent = 'Ronda ' + round.roundNumber + ' de ' + state.maxRounds +
    (state.finished ? ' · final' : (isCurrent ? '' : ' · histórico'));

  banner.innerHTML = round.rematchForced
    ? '<div class="banner">⚠ En esta ronda fue imposible evitar todas las revanchas; se permitió al menos un rematch para completar el emparejamiento.</div>'
    : '';

  let mesa = 0;
  const html = round.matches.map(m => {
    mesa++;
    if(m.isBye){
      return `<div class="match bye">
        <div class="mesa">BYE</div>
        <div class="players"><span class="pname">${esc(playerNameById(m.p1Id))}</span>
          <span class="pill pill-bye">BYE · +3 pts</span></div>
      </div>`;
    }
    if(m.isLateLoss){
      return `<div class="match dl">
        <div class="mesa">—</div>
        <div class="players"><span class="pname">${esc(playerNameById(m.p1Id))}</span>
          <span class="pill pill-drop">Late entry · derrota</span></div>
      </div>`;
    }
    const dl   = m.result === 'doubleLoss';
    const win1 = m.result === 'p1';
    const win2 = m.result === 'p2';
    const cls  = m.isReported ? (dl ? 'dl' : 'reported') : '';

    // Un toque en un nombre = ganador. Doble derrota y "limpiar" son secundarias.
    const wonMark = '<span class="won-mark" aria-hidden="true">✓</span>';
    const picks = editable
      ? `<button class="pick ${win1?'won':''} ${m.isReported&&!win1?'lost':''}" data-action="win" data-result="p1" data-id="${m.id}">${win1?wonMark:''}${esc(playerNameById(m.p1Id))}</button>
         <span class="vs">VS</span>
         <button class="pick ${win2?'won':''} ${m.isReported&&!win2?'lost':''}" data-action="win" data-result="p2" data-id="${m.id}">${win2?wonMark:''}${esc(playerNameById(m.p2Id))}</button>`
      : `<span class="pname ${win1?'winner':''}">${win1?wonMark:''}${esc(playerNameById(m.p1Id))}</span>
         <span class="vs">VS</span>
         <span class="pname ${win2?'winner':''}">${win2?wonMark:''}${esc(playerNameById(m.p2Id))}</span>`;

    let foot;
    if(m.isReported){
      foot = `<span class="pill ${dl?'pill-drop':'pill-ok'}">${dl?'Doble derrota':'✓ Reportado'}</span>`
           + (editable ? ` <button class="btn btn-sm btn-ghost" data-action="clear" data-id="${m.id}">↺ Limpiar</button>` : '');
    } else {
      foot = `<span class="pill pill-pend">Pendiente</span>`
           + (editable ? ` <button class="btn btn-sm btn-ghost" data-action="dl" data-id="${m.id}">Doble derrota</button>` : '');
    }

    return `<div class="match ${cls}">
      <div class="mesa">Mesa ${mesa}</div>
      <div class="winner-pick">${picks}</div>
      <div class="match-foot">${foot}</div>
    </div>`;
  }).join('');
  matchesList.innerHTML = html;

  // Botón inferior: "Cerrar Ronda y Avanzar" / "Finalizar Torneo" / bloqueado.
  const cur = currentRoundObj();
  const isLastRound = state.currentRound >= state.maxRounds;
  const canAdvance = isCurrent && !state.finished && allReported(cur);
  const adv = $('#advance-round');
  if(state.finished){
    adv.textContent = '✓ Torneo Finalizado';
    adv.disabled = true;
  } else {
    adv.textContent = isLastRound ? 'Finalizar Torneo' : 'Cerrar Ronda y Avanzar';
    adv.disabled = !canAdvance;
  }

  // Botón "Corregir ronda anterior": visible sólo en la ronda actual, con ronda
  // previa, torneo no finalizado y SIN resultados reportados en la ronda actual.
  const correctBtn = $('#correct-prev');
  const hasReported = cur && cur.matches.some(m => !m.isBye && m.isReported);
  const canCorrect = isCurrent && !state.finished && state.currentRound >= 2 && !hasReported;
  if(canCorrect){
    correctBtn.textContent = '↩ Corregir Ronda ' + (state.currentRound - 1);
    correctBtn.disabled = false;
    correctBtn.style.display = '';
  } else {
    correctBtn.style.display = 'none';
  }

  const pending = isCurrent ? cur.matches.filter(m => !m.isReported).length : 0;
  if(state.finished){
    hint.innerHTML = 'Torneo finalizado. Los resultados son definitivos; revisa la pestaña <strong>Standings</strong>.';
  } else if(!isCurrent){
    hint.innerHTML = 'Estás viendo una ronda anterior (sólo lectura). Vuelve a la ronda actual para reportar.';
  } else if(canAdvance){
    hint.innerHTML = isLastRound
      ? 'Última ronda completa. Al <strong>finalizar</strong> se bloquean los resultados y verás los standings definitivos.'
      : 'Todas las mesas reportadas. Al avanzar se calculan los standings y se genera la siguiente ronda.';
  } else {
    hint.innerHTML = `Faltan <strong>${pending}</strong> mesa(s) por reportar para poder ${isLastRound ? 'finalizar el torneo' : 'cerrar la ronda'}.`;
  }
}

// Ícono de podio: trofeo para el 1º, medalla para 2º/3º. SVG inline (sin dependencias).
function rankIcon(i){
  if(i > 2) return '';
  const trophy = '<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3"/>';
  const medal  = '<circle cx="12" cy="15" r="5"/><path d="M9 10.5 6 3M15 10.5 18 3M9 3h6"/>';
  const path = i === 0 ? trophy : medal;
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
}
// Separa AABBBCCCDDD en sus 4 segmentos para que se lea como 4 datos, no como un churro.
function segmentTie(str){
  const s = String(str);
  if(s.length < 11) return esc(s);
  const sep = '<span class="tieseg">·</span>';
  return esc(s.slice(0,2)) + sep + esc(s.slice(2,5)) + sep + esc(s.slice(5,8)) + sep + esc(s.slice(8,11));
}
function renderStandings(){
  const SHOW_TIE_DEBUG = false;   // ponlo en true para auditar OMW%/OOMW%/AABBBCCCDDD
  const list = $('#standings-list');
  const swEx = $('#exclude-drops');
  if(swEx) swEx.checked = !!state.excludeDrops;
  $('#stand-count').textContent = state.finished
    ? '· Resultados Finales'
    : (state.players.length ? '· ' + state.players.filter(p=>!p.dropped).length + ' activos' : '');

  // Acciones contextuales: compartir/descargar solo aplican a resultados
  // definitivos. "Compartir" se oculta si el navegador no soporta Web Share
  // (ej. Firefox de escritorio), dejando "Descargar" como camino universal.
  const actions = $('#standings-actions');
  if(actions){
    actions.style.display = (state.finished && state.players.length) ? '' : 'none';
    const shareBtn = $('#share-standings');
    if(shareBtn) shareBtn.style.display = (typeof navigator.share === 'function') ? '' : 'none';
  }

  if(state.players.length === 0){
    list.innerHTML = '<div class="empty">No hay jugadores.</div>';
    return;
  }
  const ordered = finalStandings();   // orden oficial + premiación + desempate manual

  // Grupos de empate exacto: solo se activan al finalizar (durante el torneo
  // los standings cambian cada ronda y marcarlos sería ruido).
  const tieGroups = state.finished ? tieGroupsOf(ordered) : [];
  const groupAt = idx => tieGroups.find(g => idx >= g.start && idx < g.start + g.size) || null;
  const hasPendingTie = tieGroups.some(g => !g.resolved);

  // Banner de campeón cuando el torneo finaliza (primer NO-dropeado).
  let champBanner = '';
  if(state.finished){
    const champ = ordered.find(s => !s.dropped) || ordered[0];
    if(champ){
      const champIdx = ordered.indexOf(champ);
      const champGroup = groupAt(champIdx);
      const provisional = champGroup && !champGroup.resolved;
      const tint = provisional ? 'rgba(232,168,124,.14)' : 'rgba(130,216,235,.12)';
      const label = provisional ? '🏆 Campeón (provisional)' : '🏆 Campeón';
      const note = provisional ? ' <span class="hint" style="margin:0; display:inline;">— empate en la cima sin resolver; arrastra abajo para fijar el orden</span>' : '';
      champBanner = `<div class="banner" style="background:${tint}; border-color:var(--gold-soft); color:var(--gold); margin-bottom:14px;">${label}: <strong>${esc(champ.name)}</strong> — ${champ.matchPoints} pts tras ${state.maxRounds} ronda(s)${note}</div>`;
    }
  }

  const rows = ordered.map((s, i) => {
    const rankCls = !s.dropped && i===0 ? 'rank-1' : (!s.dropped && i===1 ? 'rank-2' : (!s.dropped && i===2 ? 'rank-3' : ''));
    const dbg = SHOW_TIE_DEBUG
      ? `<td class="num">${(s.omw*100).toFixed(1)}</td>
         <td class="num">${(s.oomw*100).toFixed(1)}</td>`
      : '';
    // Celda de Drop/Reingreso. El reingreso se bloquea si ya pasó una ronda sin el jugador.
    let dropCell = '';
    if(state.started && !state.finished){
      if(!s.dropped){
        dropCell = `<button class="btn btn-sm btn-danger" data-action="drop" data-id="${s.id}">Drop</button>`;
      } else {
        const pl = getPlayer(s.id);
        const canReenter = pl && state.rounds.length === (pl.droppedAtRounds ?? state.rounds.length);
        dropCell = canReenter
          ? `<button class="btn btn-sm" data-action="drop" data-id="${s.id}">Reingresar</button>`
          : `<span class="hint" style="margin:0; white-space:nowrap;">drop definitivo</span>`;
      }
    }

    // ---- Empate: marcado de grupo (bracket) + controles del TO ----
    const g = groupAt(i);
    let trClass = s.dropped ? 'dropped' : '';
    let trAttrs = '';
    let tieBadge = '';
    if(g){
      const isFirst = i === g.start, isLast = i === g.start + g.size - 1;
      trClass += ' tie-row' + (isFirst ? ' tie-first' : '') + (isLast ? ' tie-last' : '')
               + (g.resolved ? ' tie-resolved' : ' tie-pending');
      trAttrs = ` draggable="true" data-tie-key="${g.key}" data-id="${s.id}"`;
      tieBadge = g.resolved
        ? ` <span class="tie-badge ok" title="Orden fijado por el TO">⚖ fijado</span>`
        : ` <span class="tie-badge" title="Empate exacto: el orden es aleatorio hasta que el TO lo resuelva">⚖ empate</span>`;
      // Controles en la última celda (libre al finalizar).
      dropCell = `<span class="tie-ctl">
        <span class="tie-drag" title="Arrastra para reordenar">⠿</span>
        <button class="btn btn-sm btn-ghost tie-arrow" data-action="tie-up" data-id="${s.id}" title="Subir" ${isFirst?'disabled':''}>↑</button>
        <button class="btn btn-sm btn-ghost tie-arrow" data-action="tie-down" data-id="${s.id}" title="Bajar" ${isLast?'disabled':''}>↓</button>
        ${isFirst && !g.resolved ? `<button class="btn btn-sm btn-gold" data-action="tie-confirm" data-key="${g.key}" title="Dejar este orden como definitivo">✓ Dejar</button>` : ''}
        ${isFirst && g.resolved ? `<button class="btn btn-sm btn-ghost" data-action="tie-reset" data-key="${g.key}" title="Volver al orden aleatorio (reabrir empate)">↺</button>` : ''}
      </span>`;
    }

    return `<tr class="${trClass}"${trAttrs}>
      <td class="pos ${rankCls}"><span class="rank-wrap">${!s.dropped?rankIcon(i):''}${i+1}</span></td>
      <td>${esc(s.name)} ${s.dropped?'<span class="pill pill-drop">DROP</span>':''}${tieBadge}</td>
      <td class="num">${s.matchPoints}</td>
      <td class="num" style="color:var(--ink-soft)">${s.wins}-${s.losses}</td>
      ${dbg}
      <td class="num" style="font-family:var(--mono); letter-spacing:.5px; color:var(--ink-soft)" title="AA·BBB·CCC·DDD">${segmentTie(s.tieString)}</td>
      <td class="keep" style="text-align:right;">
        ${dropCell}
      </td>
    </tr>`;
  }).join('');

  const dbgHead = SHOW_TIE_DEBUG
    ? '<th class="num">OMW%</th><th class="num">OOMW%</th>' : '';

  // Aviso/ayuda cuando hay empates exactos por resolver.
  const tieHelp = tieGroups.length
    ? `<div class="banner tie-help" style="margin-bottom:12px;">
         ${hasPendingTie ? '⚖ <strong>Empate(s) exacto(s) detectado(s).</strong>' : '✓ <strong>Empate(s) resuelto(s) por el TO.</strong>'}
         Coinciden en MatchPoints, OMW%, OOMW% y DDD: el orden entre ellos es <em>aleatorio</em>.
         Si realizas un método oficial (volado, dado, playoff…), <strong>arrastra</strong> las filas marcadas (o usa ↑/↓) para fijar el resultado;
         si el orden aleatorio está bien, pulsa <strong>✓ Dejar</strong>. En ambos casos el empate queda <strong>fijado</strong> (con ↺ puedes reabrirlo).
       </div>`
    : '';

  list.innerHTML = champBanner + tieHelp + `<div class="table-scroll"><table>
    <thead><tr>
      <th class="pos">#</th><th>Jugador</th>
      <th class="num">Pts</th><th class="num">W-L</th>${dbgHead}<th class="num">Desempate<button class="tb-info-btn" type="button" data-action="tbinfo" aria-expanded="false" aria-controls="tie-legend" title="¿Cómo se calcula?" aria-label="Explicar el número de desempate">ⓘ</button></th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;

  if(tieGroups.length) wireTieDnD(list);
}

/* Drag & drop para reordenar dentro de un grupo de empate (desktop/mouse).
   En táctil HTML5-DnD no dispara: ahí se usan los botones ↑/↓. */
function wireTieDnD(list){
  let dragId = null, dragKey = null;
  list.querySelectorAll('tr[data-tie-key]').forEach(tr => {
    tr.addEventListener('dragstart', e => {
      dragId = tr.dataset.id; dragKey = tr.dataset.tieKey;
      tr.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move';
    });
    tr.addEventListener('dragend', () => {
      tr.classList.remove('dragging');
      list.querySelectorAll('tr.tie-over').forEach(r => r.classList.remove('tie-over'));
    });
    tr.addEventListener('dragover', e => {
      if(tr.dataset.tieKey === dragKey && tr.dataset.id !== dragId){ e.preventDefault(); tr.classList.add('tie-over'); }
    });
    tr.addEventListener('dragleave', () => tr.classList.remove('tie-over'));
    tr.addEventListener('drop', e => {
      e.preventDefault(); tr.classList.remove('tie-over');
      if(!dragId || tr.dataset.tieKey !== dragKey || tr.dataset.id === dragId) return;
      const rows = [...list.querySelectorAll('tr[data-tie-key="' + dragKey + '"]')];
      let ids = rows.map(r => r.dataset.id).filter(x => x !== dragId);
      ids.splice(ids.indexOf(tr.dataset.id), 0, dragId);  // suelta ANTES del objetivo
      setTieOrder(dragKey, ids);
    });
  });
}

/* ---------------------------------------------------------------------------
   STANDINGS COMPARTIBLES — PNG brandeado (Velvet Room + Budget Occidente)
   Genera un artefacto portable: una imagen lista para postear en el grupo de
   WhatsApp/Facebook o proyectar, distinta de la tabla viva dentro de la app.
   · Usa <canvas> + los dos SVG ya embebidos como data URI (sin CORS/taint).
   · Los nombres se dibujan con fillText: nunca se interpretan como HTML.
   · En móvil intenta el share sheet nativo (Web Share API con archivos);
     si no está disponible, descarga el PNG.
--------------------------------------------------------------------------- */
function _svgWithSize(src, px){
  // Chrome no rasteriza en canvas un SVG sin width/height intrínsecos
  // (los nuestros solo traen viewBox): se los inyectamos al vuelo.
  try{
    const svg = atob(src.split(',')[1]).replace('<svg ', '<svg width="'+px+'" height="'+px+'" ');
    return 'data:image/svg+xml;base64,' + btoa(svg);
  }catch(e){ return src; }
}
function _loadImg(src){
  return new Promise((resolve, reject) => {
    const im = new Image();
    im.onload = () => resolve(im);
    im.onerror = () => reject(new Error('No se pudo cargar un logo.'));
    im.src = src;
  });
}
function _wrapLines(ctx, text, maxW, maxLines){
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  for(const w of words){
    const t = line ? line + ' ' + w : w;
    if(ctx.measureText(t).width > maxW && line){
      lines.push(line); line = w;
      if(lines.length === maxLines){ line = ''; break; }
    } else line = t;
  }
  if(line && lines.length < maxLines) lines.push(line);
  if(lines.length === maxLines && ctx.measureText(words.join(' ')).width > maxW * maxLines){
    lines[maxLines-1] = lines[maxLines-1].replace(/.{2}$/, '') + '…';
  }
  return lines;
}
function _ellipsize(ctx, text, maxW){
  let t = String(text);
  if(ctx.measureText(t).width <= maxW) return t;
  while(t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t + '…';
}
async function buildStandingsImageBlob(){
    /* --- Datos: mismo orden que la tabla en vivo (incluye desempate del TO) --- */
    const ordered = finalStandings();
    const finished = !!state.finished;
    const champ = finished ? (ordered.find(s => !s.dropped) || ordered[0]) : null;
    const listRows = finished ? ordered.filter(s => s !== champ) : ordered;

    /* --- Paleta: se respeta el tema activo de la app --- */
    const cs = getComputedStyle(document.documentElement);
    const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
    const C = {
      bg:    v('--bg', '#14131f'),
      ink:   v('--ink', '#eef1f7'),
      soft:  v('--ink-soft', '#a7adc2'),
      faint: v('--ink-faint', '#767089'),
      gold:  v('--gold', '#82d8eb'),
      line:  v('--border-2', '#443f5d'),
    };
    const SANS = v('--sans', 'system-ui, sans-serif');
    const MONO = v('--mono', 'monospace');

    /* --- Ambos logos, desde los data URI ya presentes en el documento --- */
    const crestEl  = document.querySelector('header.app .crest');
    const budgetEl = document.getElementById('footer-logo');
    const [crest, budget] = await Promise.all([
      _loadImg(_svgWithSize(crestEl.src, 256)),
      _loadImg(_svgWithSize(budgetEl.src, 256)),
    ]);

    /* --- Medición previa (para calcular la altura total del lienzo) --- */
    const W = 1080, PAD = 72;
    const meas = document.createElement('canvas').getContext('2d');
    const dateTxt = new Date().toLocaleDateString('es-CR', { day:'numeric', month:'long', year:'numeric' });
    const note = (state.note || '').trim();

    meas.font = '400 27px ' + SANS;
    const noteLines = note ? _wrapLines(meas, note, W - PAD*2, 3) : [];

    let champFS = 0;
    if(champ){
      champFS = 124;
      meas.font = '900 ' + champFS + 'px ' + SANS;
      while(meas.measureText(champ.name).width > W - PAD*2 && champFS > 46){
        champFS -= 4;
        meas.font = '900 ' + champFS + 'px ' + SANS;
      }
    }

    const headerH = 96;                                       // crest + títulos
    const heroH   = champ ? (44 + Math.ceil(champFS * 1.3) + 52) : 0;
    const ROW_H   = 62;
    const rowsH   = listRows.length * ROW_H + (listRows.length ? 18 : 0);
    const noteH   = noteLines.length ? noteLines.length * 38 + 34 : 0;
    const footerH = 132;
    const H = PAD + headerH + 44 + heroH + rowsH + noteH + footerH;

    /* --- Lienzo --- */
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.textBaseline = 'alphabetic';

    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, W, H);

    /* Cabecera: crest + nombre de la tienda + fecha */
    ctx.drawImage(crest, PAD, PAD - 6, headerH, headerH);
    ctx.fillStyle = C.ink;
    ctx.font = '800 42px ' + SANS;
    ctx.fillText('Torneo Yu-Gi-Oh!', PAD + headerH + 28, PAD + 36);
    ctx.fillStyle = C.gold;
    ctx.font = '700 27px ' + SANS;
    ctx.fillText('Velvet Room Game Store', PAD + headerH + 28, PAD + 72);
    ctx.fillStyle = C.soft;
    ctx.font = '400 23px ' + SANS;
    const subInfo = finished
      ? 'Resultados finales · ' + state.maxRounds + ' ronda' + (state.maxRounds === 1 ? '' : 's') + ' · ' + dateTxt
      : 'Standings · Ronda ' + state.currentRound + ' de ' + state.maxRounds + ' · ' + dateTxt;
    ctx.fillText(subInfo, PAD + headerH + 28, PAD + headerH - 2);

    let y = PAD + headerH + 26;
    ctx.strokeStyle = C.line; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(PAD, y); ctx.lineTo(W - PAD, y); ctx.stroke();
    y += 18;

    /* Héroe del campeón (solo torneo finalizado) */
    if(champ){
      y += 44;
      ctx.fillStyle = C.gold;
      ctx.font = '800 30px ' + SANS;
      try{ ctx.letterSpacing = '6px'; }catch(e){}
      ctx.textAlign = 'center';
      ctx.fillText('🏆 CAMPEÓN', W / 2, y);
      try{ ctx.letterSpacing = '0px'; }catch(e){}

      y += Math.ceil(champFS * 1.08);
      ctx.fillStyle = C.ink;
      ctx.font = '900 ' + champFS + 'px ' + SANS;
      ctx.fillText(champ.name, W / 2, y);

      y += 46;
      ctx.fillStyle = C.soft;
      ctx.font = '600 27px ' + MONO;
      ctx.fillText(champ.matchPoints + ' pts · ' + champ.wins + '-' + champ.losses, W / 2, y);
      ctx.textAlign = 'left';
      y += 6;
    }

    /* Tabla (desde el 2.º lugar si hay héroe; completa si no) */
    y += 18;
    const numX = PAD + 64;                 // posición, alineada a la derecha
    const nameX = PAD + 92;
    const ptsX = W - PAD;                  // puntos, alineados a la derecha
    const maxNameW = ptsX - nameX - 300;
    for(let i = 0; i < listRows.length; i++){
      const r = listRows[i];
      const pos = ordered.indexOf(r) + 1;
      const rowY = y + ROW_H * (i + 1) - 20;
      const inkMain = r.dropped ? C.faint : C.ink;

      ctx.font = '700 30px ' + MONO;
      ctx.fillStyle = r.dropped ? C.faint : C.gold;
      ctx.textAlign = 'right';
      ctx.fillText(pos + '.', numX, rowY);

      ctx.textAlign = 'left';
      ctx.font = '600 32px ' + SANS;
      ctx.fillStyle = inkMain;
      const nm = _ellipsize(ctx, r.name, maxNameW);
      ctx.fillText(nm, nameX, rowY);
      if(r.dropped){
        const w = ctx.measureText(nm).width;
        ctx.strokeStyle = C.faint; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(nameX, rowY - 10); ctx.lineTo(nameX + w, rowY - 10); ctx.stroke();
        ctx.font = '700 19px ' + SANS;
        ctx.fillText('DROP', nameX + w + 16, rowY - 4);
      }

      ctx.textAlign = 'right';
      ctx.font = '600 28px ' + MONO;
      ctx.fillStyle = r.dropped ? C.faint : C.gold;
      ctx.fillText(r.matchPoints + ' pts (' + r.wins + '-' + r.losses + ')', ptsX, rowY);
      ctx.textAlign = 'left';
    }
    y += rowsH;

    /* Nota del torneo (premiación, sede…) */
    if(noteLines.length){
      y += 40;
      ctx.fillStyle = C.soft;
      ctx.font = 'italic 400 27px ' + SANS;
      for(const ln of noteLines){ ctx.fillText(ln, PAD, y); y += 38; }
      y -= 38;
    }

    /* Pie: divisor + ambas marcas */
    const fy = H - 64;
    ctx.strokeStyle = C.line; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(PAD, fy - 42); ctx.lineTo(W - PAD, fy - 42); ctx.stroke();
    ctx.drawImage(crest, PAD, fy - 26, 44, 44);
    ctx.fillStyle = C.soft;
    ctx.font = '600 22px ' + SANS;
    ctx.fillText('Velvet Room Game Store', PAD + 58, fy + 4);
    ctx.textAlign = 'right';
    ctx.fillStyle = C.faint;
    ctx.font = '400 21px ' + SANS;
    const madeTxt = 'Made with passion by';
    ctx.fillText(madeTxt, W - PAD - 56, fy + 3);
    ctx.textAlign = 'left';
    ctx.drawImage(budget, W - PAD - 46, fy - 26, 46, 46);

    /* --- Resultado: el PNG, listo para que el llamador decida qué hacer --- */
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    if(!blob) throw new Error('No se pudo generar la imagen.');
    const fname = finished ? 'resultados-torneo.png' : ('standings-ronda-' + state.currentRound + '.png');
    return { blob, file: new File([blob], fname, { type:'image/png' }), fname };
}

/* Dos acciones explícitas: el usuario decide. Compartir abre el share sheet
   nativo (y al cancelar NO hace nada, respetando el "no"); Descargar baja el
   PNG de forma deliberada — el camino para WhatsApp Web. */
async function shareStandingsImage(){
  if(!state.finished || !state.players.length){ showToast('Los resultados se comparten al finalizar el torneo.', true); return; }
  const btn = $('#share-standings'); if(btn) btn.disabled = true;
  try{
    const { file } = await buildStandingsImageBlob();
    if(navigator.canShare && navigator.canShare({ files:[file] })){
      try{ await navigator.share({ files:[file], title:'Torneo Yu-Gi-Oh! · Velvet Room' }); }
      catch(e){ /* cancelado o fallo: no hacemos nada — el usuario tiene "Descargar". */ }
    }else{
      showToast('Tu navegador no permite compartir aquí. Usa "Descargar".', true);
    }
  }catch(err){
    showToast('No se pudo generar la imagen: ' + (err && err.message || err), true);
  }finally{ if(btn) btn.disabled = false; }
}
async function downloadStandingsImage(){
  if(!state.finished || !state.players.length){ showToast('Los resultados se comparten al finalizar el torneo.', true); return; }
  const btn = $('#download-standings'); if(btn) btn.disabled = true;
  try{
    const { blob, fname } = await buildStandingsImageBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    showToast('Imagen descargada: adjúntala en WhatsApp Web o tu grupo. 📤');
  }catch(err){
    showToast('No se pudo generar la imagen: ' + (err && err.message || err), true);
  }finally{ if(btn) btn.disabled = false; }
}

/* ---- Tabs ---- */
const TAB_ORDER = ['registro','rondas','standings'];
/* Estilo de transición entre pestañas:
   'carousel' → los paneles se deslizan completos, como si la página vecina siempre existiera al lado.
   'fade'     → desplazamiento corto con fundido (comportamiento anterior).
   Cambia esta constante y listo; todo lo demás se ajusta solo. */
const TAB_FX = 'carousel';
document.getElementById('tab-stack').classList.add('fx-' + TAB_FX);
let _currentTab = 'registro';
let _tabsReady = false;

function moveTabIndicator(){
  const ind = document.getElementById('tab-indicator');
  const btn = document.querySelector('nav.tabs button.active');
  if(!ind || !btn) return;
  ind.style.width = btn.offsetWidth + 'px';
  ind.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
}

function switchTab(name){
  // Defensivo: click sobre la pestaña ya activa → no hay nada que animar.
  if(_tabsReady && name === _currentTab) return;
  // dirección: adelante (1) = la pestaña nueva está a la derecha; atrás (-1) = a la izquierda
  const dir = TAB_ORDER.indexOf(name) < TAB_ORDER.indexOf(_currentTab) ? -1 : 1;
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));

  const newPanel = document.getElementById('tab-' + name);
  const oldPanel = document.getElementById('tab-' + _currentTab);

  // Primera vez (arranque): coloca todo sin animación para no “crecer” el blob.
  if(!_tabsReady){
    const ind = document.getElementById('tab-indicator');
    if(ind){ ind.style.transition = 'none'; }
    moveTabIndicator();
    if(ind){ requestAnimationFrame(() => { ind.style.transition = ''; }); }
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + name));
    _currentTab = name; _tabsReady = true;
    return;
  }

  moveTabIndicator(); // el blob se traslada a la nueva pestaña

  const stack = document.getElementById('tab-stack');
  const h0 = stack ? stack.offsetHeight : 0; // alto con la pestaña saliente aún en flujo

  if(newPanel){
    if(oldPanel && oldPanel !== newPanel){
      oldPanel.classList.remove('active','enter-right','enter-left','exit-left','exit-right');
      oldPanel.classList.add(dir === 1 ? 'exit-left' : 'exit-right');
      oldPanel.addEventListener('animationend', function h(){
        oldPanel.classList.remove('exit-left','exit-right');
        oldPanel.removeEventListener('animationend', h);
      }, { once:true });
    }
    newPanel.classList.remove('exit-left','exit-right','enter-right','enter-left');
    newPanel.classList.add('active', dir === 1 ? 'enter-right' : 'enter-left');
    if(stack) stack.classList.add('sliding'); // difumina los bordes durante el deslizamiento
    newPanel.addEventListener('animationend', function h(){
      newPanel.classList.remove('enter-right','enter-left');
      if(stack) stack.classList.remove('sliding');
      newPanel.removeEventListener('animationend', h);
    }, { once:true });
    if(stack) setTimeout(() => stack.classList.remove('sliding'), 700); // red de seguridad

    // El alto del stack se anima entre pestañas de distinta altura: así el footer
    // y el toolbar "viajan" en sincronía con el deslizamiento en lugar de saltar.
    if(stack){
      stack.classList.remove('h-anim');   // limpia una animación de alto en curso
      stack.style.height = '';            // para medir el alto natural de la pestaña entrante
      const h1 = stack.offsetHeight;
      if(Math.abs(h1 - h0) > 1){
        stack.classList.add('h-anim');
        stack.style.height = h0 + 'px';
        void stack.offsetHeight; // reflow para que la transición parta de h0
        stack.style.height = h1 + 'px';
        const settle = () => {
          stack.style.height = '';
          stack.classList.remove('h-anim');
          stack.removeEventListener('transitionend', settle);
        };
        stack.addEventListener('transitionend', settle, { once:true });
        setTimeout(settle, 600); // red de seguridad si transitionend no dispara
      }
    }
  }
  _currentTab = name;
}

/* ---- Toast ---- */
let toastTimer = null;
function showToast(msg, isErr=false){
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---- Modal de confirmación personalizado (reemplaza confirm() nativo) ----
   Controlado por la clase .open en el overlay. El callback de confirmación se
   guarda en _confirmCb y se ejecuta al pulsar "Confirmar". */
let _confirmCb = null;
function openConfirm(message, onConfirm, opts={}){
  $('#confirm-title').textContent = opts.title || 'Confirmar';
  $('#confirm-msg').textContent = message;
  const ok = $('#confirm-ok');
  ok.textContent = opts.confirmText || 'Confirmar';
  ok.className = 'btn ' + (opts.danger ? 'btn-crimson' : 'btn-gold');
  _confirmCb = onConfirm;
  $('#confirm-modal').classList.add('open');
  $('#confirm-modal').setAttribute('aria-hidden', 'false');
}
function closeConfirm(){
  $('#confirm-modal').classList.remove('open');
  $('#confirm-modal').setAttribute('aria-hidden', 'true');
  _confirmCb = null;
}

/* ---- Tema claro/oscuro ---- */
function applyTheme(theme){
  if(theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
  else document.documentElement.removeAttribute('data-theme');
}
function toggleTheme(){
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  applyTheme(next);
  _applyTimerWinTheme();   // la ventana de proyección sigue el tema de la app
  try{ localStorage.setItem('ygo_theme', next); }catch(e){}
}

/* ---- Export / Import ---- */
function exportJSON(){
  const blob = new Blob([JSON.stringify(state, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  a.href = url; a.download = `torneo-suizo-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  showToast('Torneo exportado.');
}
function importJSON(file){
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const parsed = JSON.parse(reader.result);
      if(!parsed || !Array.isArray(parsed.players)) throw new Error('formato');
      state = Object.assign(emptyState(), parsed);
      roundsManuallySet = state.started; // si ya arrancó, su maxRounds es definitivo
      if(state.started && !state.maxRounds) state.maxRounds = computeMaxRounds(state.players.length);
      save(); switchTab(state.finished ? 'standings' : (state.started ? 'rondas' : 'registro')); render();
      showToast('Torneo importado.');
    }catch(e){ showToast('Archivo JSON inválido.', true); }
  };
  reader.readAsText(file);
}

/* ---------------------------------------------------------------------------
   7) WIRING DE EVENTOS
--------------------------------------------------------------------------- */
document.querySelectorAll('nav.tabs button').forEach(b =>
  b.addEventListener('click', () => switchTab(b.dataset.tab)));

// El form principal se reutiliza: antes de iniciar = registro; en curso = Late Entry.
$('#add-player').addEventListener('click', () => {
  const inp = $('#player-name');
  if(state.started) addLateEntry(inp.value); else addPlayer(inp.value);
  inp.value=''; inp.focus();
});
$('#player-name').addEventListener('keydown', e => {
  if(e.key === 'Enter'){
    if(state.started) addLateEntry(e.target.value); else addPlayer(e.target.value);
    e.target.value='';
  }
});
$('#add-bulk').addEventListener('click', () => {
  const text = $('#player-bulk').value;
  if(state.started) addLateEntriesBulk(text); else addPlayersBulk(text);
});
$('#start-tournament').addEventListener('click', startTournament);
// Comentario / premiación: se guarda en el estado (y se exporta) mientras se escribe.
$('#tournament-note').addEventListener('input', e => { state.note = e.target.value; save(); });
// Switch de premiación: relega los DROP al fondo de los standings.
$('#exclude-drops').addEventListener('change', e => { state.excludeDrops = e.target.checked; save(); render(); });
// Cronómetro de ronda.
$('#timer-toggle').addEventListener('click', timerToggle);
$('#timer-reset').addEventListener('click', timerReset);
$('#timer-min').addEventListener('input', e => timerSetMinutes(e.target.value));
$('#timer-popout').addEventListener('click', openTimerWindow);
// Al editar manualmente el número de rondas, dejamos de autocompletarlo.
$('#num-rounds').addEventListener('input', () => {
  roundsManuallySet = true;
  if(!state.started) renderRegistro(); // refresca el hint sin tocar el valor escrito
});
$('#advance-round').addEventListener('click', advanceRound);
$('#correct-prev').addEventListener('click', correctPreviousRound);
$('#round-selector').addEventListener('change', e => {
  state.viewRound = parseInt(e.target.value, 10); render();
});

// Delegación de eventos para botones dinámicos
document.body.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if(!btn) return;
  const id = btn.dataset.id;
  switch(btn.dataset.action){
    case 'remove': removePlayer(id); break;
    case 'win':    reportResult(id, btn.dataset.result); break;
    case 'dl':     reportResult(id, 'doubleLoss'); break;
    case 'clear':  reportResult(id, null); break;
    case 'drop':   toggleDrop(id); break;
    case 'tie-up':    moveTie(id, -1); break;
    case 'tie-down':  moveTie(id,  1); break;
    case 'tie-confirm': confirmTieOrder(btn.dataset.key); break;
    case 'tie-reset': clearTieOrder(btn.dataset.key); break;
    case 'tbinfo': {
      const leg = $('#tie-legend');
      if(leg){ const open = leg.classList.toggle('open'); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); }
      break;
    }
    case 'disclosure': {
      const body = document.getElementById(btn.dataset.target);
      if(body){ const open = body.classList.toggle('open'); btn.setAttribute('aria-expanded', open ? 'true' : 'false'); }
      break;
    }
  }
});

$('#export-json').addEventListener('click', exportJSON);
$('#share-standings').addEventListener('click', shareStandingsImage);
$('#download-standings').addEventListener('click', downloadStandingsImage);
$('#import-json').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', e => { if(e.target.files[0]) importJSON(e.target.files[0]); e.target.value=''; });
$('#reset-all').addEventListener('click', resetAll);
$('#theme-toggle').addEventListener('click', toggleTheme);

// Modal de confirmación
$('#confirm-ok').addEventListener('click', () => { const cb = _confirmCb; closeConfirm(); if(cb) cb(); });
$('#confirm-cancel').addEventListener('click', closeConfirm);
$('#confirm-modal').addEventListener('click', e => { if(e.target.id === 'confirm-modal') closeConfirm(); }); // clic en el fondo cancela
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && $('#confirm-modal').classList.contains('open')) closeConfirm();
});

/* ---- Arranque ---- */
load();
switchTab(state.finished ? 'standings' : (state.started ? 'rondas' : 'registro'));
render();
startTimerLoop();
// Al cambiar tamaño/orientación o salir de fullscreen, limpiamos cualquier alto
// inline que el carrusel haya dejado a medio camino (un cambio de viewport durante
// la animación de altura puede dejar el stack con un height fijo que ya no
// corresponde, recortando el contenido al lateral). Además reposiciona el blob.
function _resyncTabStack(){
  const stack = document.getElementById('tab-stack');
  if(stack){
    stack.classList.remove('h-anim','sliding');
    stack.style.height = '';
  }
  moveTabIndicator();
}
window.addEventListener('resize', _resyncTabStack);
window.addEventListener('orientationchange', _resyncTabStack);
document.addEventListener('fullscreenchange', _resyncTabStack);
