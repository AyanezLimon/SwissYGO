/* SwissYGO — vanilla UI controller. No framework, no build: loaded as a native
 * ES module. Re-renders the active tab into #app on any store change. Offline
 * mode (localStorage) works with zero backend; connected-mode views layer on
 * later. */
import { store } from './store.js';
import { getPlayer } from './lib/state.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const nameOf = (id) => { const p = getPlayer(store.state, id); return p ? esc(p.name) : '—'; };
const segTie = (t) => `${t.slice(0, 2)}·${t.slice(2, 5)}·${t.slice(5, 8)}·${t.slice(8)}`;

let tab = 'registro';
const app = document.getElementById('app');

// ---- views -----------------------------------------------------------------
function viewRegistro() {
  const s = store.state;
  if (s.started) {
    return `<section class="panel"><h2>Torneo en curso</h2>
      <p class="muted">Ronda ${s.currentRound} de ${s.maxRounds} · ${s.players.length} jugadores.</p>
      <button class="btn-danger" data-action="reset">Reiniciar torneo</button></section>`;
  }
  return `
    <section class="panel">
      <h2>Registro de jugadores</h2>
      <form class="row" data-action="add-player">
        <input class="grow" name="name" type="text" placeholder="Nombre del jugador" autocomplete="off" />
        <button class="btn-primary" type="submit">Agregar</button>
      </form>
      <div style="margin-top:14px">
        <label>Pegar lista (un nombre por línea; tolera "1.", "2)", etc.)</label>
        <textarea id="bulk" placeholder="1. Alice&#10;2. Bob&#10;3. Carol"></textarea>
        <div class="row" style="margin-top:8px"><button data-action="add-bulk">Agregar lista</button></div>
      </div>
    </section>
    <section class="panel">
      <h2>Jugadores (${s.players.length})</h2>
      ${s.players.length ? `<ul class="list">${s.players.map((p) => `
        <li><span class="grow">${esc(p.name)}</span>
        <button class="btn-danger" data-action="remove" data-id="${p.id}">Quitar</button></li>`).join('')}</ul>`
      : '<p class="muted">Aún no hay jugadores.</p>'}
    </section>
    <section class="panel">
      <h2>Iniciar torneo</h2>
      <div class="row">
        <div><label>Número de rondas (sugerido: ${store.suggestedRounds()})</label>
          <input id="rounds" type="number" min="1" placeholder="${store.suggestedRounds()}" style="width:120px" /></div>
        <button class="btn-primary" data-action="start" ${s.players.length < 2 ? 'disabled' : ''}>Iniciar</button>
      </div>
    </section>`;
}

function viewRondas() {
  const s = store.state;
  if (!s.started) return `<section class="panel"><p class="muted">El torneo no ha comenzado. Ve a <a href="#" data-tab="registro">Registro</a>.</p></section>`;
  const round = store.currentRound();
  const tabs = s.rounds.map((r) => `<button data-action="view-round" data-n="${r.roundNumber}" class="${r.roundNumber === s.viewRound ? 'btn-primary' : ''}">R${r.roundNumber}</button>`).join('');
  const rows = round ? round.matches.map((m, i) => `
    <tr><td>${i + 1}</td><td>${nameOf(m.p1Id)}</td>
    <td>${m.isBye ? '<span class="pill pill-bye">BYE</span>' : nameOf(m.p2Id)}</td>
    <td>${m.isBye ? '<span class="muted">Bye (3 pts)</span>' : `
      <div class="row">
        <button data-action="report" data-id="${m.id}" data-r="p1" class="${m.result === 'p1' ? 'btn-primary' : ''}">Gana 1</button>
        <button data-action="report" data-id="${m.id}" data-r="p2" class="${m.result === 'p2' ? 'btn-primary' : ''}">Gana 2</button>
        <button data-action="report" data-id="${m.id}" data-r="doubleLoss" class="${m.result === 'doubleLoss' ? 'btn-danger' : ''}">Doble derrota</button>
        ${m.isReported ? '' : '<span class="pill pill-pend">Pendiente</span>'}
      </div>`}</td></tr>`).join('') : '';
  return `
    <section class="panel"><div class="row"><h2 style="margin:0">Ronda ${s.viewRound} de ${s.maxRounds}</h2>
      <div class="spacer"></div>${tabs}</div></section>
    ${round ? `<section class="panel"><table><thead><tr><th>Mesa</th><th>Jugador 1</th><th>Jugador 2</th><th>Resultado</th></tr></thead><tbody>${rows}</tbody></table></section>` : ''}
    <section class="panel"><div class="row">
      <button class="btn-primary" data-action="next-round" ${store.canGenerateNext() ? '' : 'disabled'}>Generar siguiente ronda</button>
      ${s.finished ? '' : `<button data-action="finish" ${store.canGenerateNext() ? 'disabled' : ''}>Finalizar torneo</button>`}
      <button data-tab="standings">Ver standings</button>
    </div>${round?.rematchForced ? '<p class="muted" style="margin-top:10px">⚠️ Esta ronda incluyó una revancha forzada.</p>' : ''}</section>`;
}

function viewStandings() {
  const s = store.state;
  if (!s.players.length) return '<section class="panel"><p class="muted">No hay jugadores.</p></section>';
  const standings = store.standings();
  const groups = store.tieGroups();
  const inTie = {}; for (const g of groups) for (const id of g.ids) inTie[id] = true;
  const rows = standings.map((st, i) => `
    <tr><td>${i + 1}</td><td>${esc(st.name)}${st.dropped ? ' <span class="pill pill-drop">DROP</span>' : ''}</td>
    <td>${st.wins}-${st.losses}</td><td class="tie-string">${segTie(st.tieString)}</td>
    <td>${inTie[st.id] ? `<div class="row"><button data-action="tie-up" data-id="${st.id}">▲</button><button data-action="tie-down" data-id="${st.id}">▼</button></div>` : ''}</td></tr>`).join('');
  return `
    ${s.finished && standings.length ? `<section class="panel"><h2>🏆 Campeón: ${esc(standings[0].name)}</h2></section>` : ''}
    <section class="panel"><h2>Standings</h2>
      <table><thead><tr><th>#</th><th>Jugador</th><th>P-G</th><th class="mono">AA·BBB·CCC·DDD</th><th></th></tr></thead><tbody>${rows}</tbody></table></section>
    ${groups.length ? `<section class="panel"><h2>Empates exactos</h2>
      <p class="muted">Mismo número de desempate. Usa ▲▼ tras tu método (volado/dado/playoff) o confírmalo tal cual.</p>
      <ul class="list">${groups.map((g) => `<li><span class="grow">${g.size} empatados</span>
        <span class="pill ${g.resolved ? 'pill-bye' : 'pill-pend'}">${g.resolved ? 'Fijado' : 'Tentativo'}</span>
        <button data-action="tie-confirm" data-key="${esc(g.key)}">✓ Dejar</button>
        ${g.resolved ? `<button class="btn-danger" data-action="tie-clear" data-key="${esc(g.key)}">Revertir</button>` : ''}</li>`).join('')}</ul></section>` : ''}`;
}

// ---- render + events -------------------------------------------------------
function render() {
  const views = { registro: viewRegistro, rondas: viewRondas, standings: viewStandings };
  app.innerHTML = `
    <header class="app-header">
      <h1>SwissYGO</h1><span class="mode-badge">${store.mode === 'connected' ? 'En línea' : 'Local'}</span>
      <nav class="tabs">
        ${['registro', 'rondas', 'standings'].map((t) => `<a href="#" data-tab="${t}" class="${tab === t ? 'active' : ''}">${{ registro: 'Registro', rondas: 'Rondas', standings: 'Standings' }[t]}</a>`).join('')}
      </nav>
      <button class="theme-switch" data-action="theme">${document.documentElement.getAttribute('data-theme') === 'light' ? '🌙' : '☀️'}</button>
    </header>
    ${views[tab]()}`;
}

app.addEventListener('click', (e) => {
  const el = e.target.closest('[data-tab],[data-action]');
  if (!el) return;
  if (el.dataset.tab) { e.preventDefault(); tab = el.dataset.tab; render(); return; }
  const a = el.dataset.action;
  if (a === 'theme') return toggleTheme();
  if (a === 'add-bulk') { const n = store.addPlayersBulk(document.getElementById('bulk').value); if (n) {} return; }
  if (a === 'start') { store.start(parseInt(document.getElementById('rounds')?.value, 10) || 0); tab = 'rondas'; return; }
  if (a === 'reset') { if (confirm('¿Borrar el torneo actual y empezar de cero?')) store.reset(); return; }
  if (a === 'remove') return store.removePlayer(el.dataset.id);
  if (a === 'view-round') return store.setViewRound(Number(el.dataset.n));
  if (a === 'report') return store.reportMatch(el.dataset.id, el.dataset.r);
  if (a === 'next-round') return void store.generateNextRound();
  if (a === 'finish') return store.finishTournament();
  if (a === 'tie-up') return store.moveTie(el.dataset.id, -1);
  if (a === 'tie-down') return store.moveTie(el.dataset.id, 1);
  if (a === 'tie-confirm') return store.confirmTieOrder(el.dataset.key);
  if (a === 'tie-clear') return store.clearTieOrder(el.dataset.key);
});

app.addEventListener('submit', (e) => {
  const form = e.target.closest('[data-action="add-player"]');
  if (!form) return;
  e.preventDefault();
  const input = form.querySelector('input[name="name"]');
  if (store.addPlayer(input.value)) input.value = '';
});

function toggleTheme() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  if (light) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', 'light');
  try { localStorage.setItem('ygo_theme', light ? 'dark' : 'light'); } catch {}
  render();
}

// Re-render on every state change (store calls back immediately on subscribe).
store.subscribe(render);
