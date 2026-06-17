/* SwissYGO player page (/u/). Phone-first. Logged-in users join with their
 * account; everyone else joins as a guest (typed/random name, no saved stats).
 * Lists active tournaments to pick from, then live-polls /me for the pairing.
 * Standalone — does not touch the organizer console. */
(function () {
  const root = document.getElementById('player');
  const LS_JOINED = 'ygo_joined';           // { id, name, guestToken? }
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // Fun guest names: Sustantivo + Adjetivo + número (e.g. "JarronEsponjoso76").
  // Semillas: Yu-Gi-Oh, videojuegos, objetos, lugares y cosas silly.
  const FB_NOUNS = [
    'Kuriboh', 'MagoOscuro', 'OjosAzules', 'Exodia', 'Slifer', 'Obelisco', 'Jinzo', 'Pendulo',
    'Kaiba', 'Yugi', 'Pegasus', 'Marik', 'DragonAlado', 'CartaTrampa', 'Polymerization',
    'Pikachu', 'Kirby', 'Link', 'Bowser', 'Sonic', 'Yoshi', 'Goomba', 'Creeper', 'Chocobo',
    'Tonberry', 'Moguri', 'Cactilio', 'Slime', 'Pacman', 'Samus', 'MasterChief', 'Vivi',
    'Jarron', 'Tostadora', 'Calcetin', 'Cuchara', 'Almohada', 'Sarten', 'Croqueta', 'Waffle',
    'Burrito', 'Pinata', 'Chancla', 'Aguacate', 'Pulpo', 'Capibara', 'Mapache',
    'Hyrule', 'Termina', 'Kanto', 'Midgar', 'Zanarkand', 'Gerudo',
  ];
  const FB_ADJS = [
    'Esponjoso', 'Brillante', 'Furioso', 'Legendario', 'Cosmico', 'Picante', 'Turbo', 'Supremo',
    'Magico', 'Oscuro', 'Veloz', 'Radiante', 'Salvaje', 'Mistico', 'Glorioso', 'Travieso',
    'Imparable', 'Ardiente', 'Glaciar', 'Funky', 'Ninja', 'Pixelado', 'Epico', 'Dorado',
    'Fugaz', 'Caotico', 'Sigiloso', 'Crujiente', 'Galactico', 'Rebelde',
  ];
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  // Big vocabulary from names-data.js if present; otherwise the small built-in set.
  const NAMES = (window.NAMES && window.NAMES.NOUNS && window.NAMES.NOUNS.length) ? window.NAMES : { NOUNS: FB_NOUNS, ADJS: FB_ADJS };
  const randomName = () => pick(NAMES.NOUNS) + pick(NAMES.ADJS) + (10 + Math.floor(Math.random() * 90));

  const joined = () => { try { return JSON.parse(localStorage.getItem(LS_JOINED) || 'null'); } catch { return null; } };
  const setJoined = (v) => { try { v ? localStorage.setItem(LS_JOINED, JSON.stringify(v)) : localStorage.removeItem(LS_JOINED); } catch {} };
  const loggedIn = () => !!API.token.get();

  let pollTimer = null;
  const uname = () => { try { return localStorage.getItem('ygo_username') || ''; } catch { return ''; } };
  const fmtDate = (s) => String(s || '').replace('T', ' ').slice(0, 16);

  // ---- join screen -------------------------------------------------------
  function renderJoin(err, codePrefill) {
    stopPoll();
    const logged = loggedIn();
    root.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2 style="margin:0">Unirse a un torneo</h2>
          ${logged
            ? '<button class="btn btn-sm btn-ghost" id="logout" type="button">Salir</button>'
            : '<button class="btn btn-sm btn-ghost" id="signin" type="button">Iniciar sesión</button>'}
        </div>
        <div class="muted" style="font-size:12.5px;margin:4px 0 14px">
          ${logged ? `Tu cuenta: <b>${esc(uname() || 'usuario')}</b>` : 'Jugando como invitado — tus resultados no se guardan.'}
        </div>
        ${logged ? '' : `<div class="gate-field"><label>Tu nombre</label><input type="text" id="gname" maxlength="40" value="${esc(randomName())}"></div>`}
        <div id="active"><p class="muted" style="font-size:13px">Cargando torneos…</p></div>
        <div class="gate-field" style="margin-top:14px">
          <label>¿Tienes un código?</label>
          <input type="text" id="code" maxlength="5" autocapitalize="characters" autocomplete="off" spellcheck="false"
                 value="${esc(codePrefill || '')}" style="text-transform:uppercase;font-family:var(--mono);font-size:20px;letter-spacing:4px;text-align:center">
        </div>
        <div class="gate-error" id="perr">${err ? esc(err) : ''}</div>
        <button class="btn btn-gold" id="join" type="button" style="width:100%">Unirme con código</button>
        ${logged ? '<button class="btn btn-sm btn-ghost" id="hist" type="button" style="width:100%;margin-top:10px">Mis torneos</button>' : ''}
      </div>`;

    $('#join').addEventListener('click', () => doJoin($('#code').value));
    $('#code').addEventListener('keyup', (e) => { if (e.key === 'Enter') doJoin($('#code').value); });
    const lo = $('#logout'); if (lo) lo.addEventListener('click', () => { API.token.clear(); try { localStorage.removeItem('ygo_username'); } catch {} location.href = '/'; });
    const si = $('#signin'); if (si) si.addEventListener('click', () => { try { localStorage.removeItem('ygo_guest'); } catch {} location.href = '/'; });
    const h = $('#hist'); if (h) h.addEventListener('click', renderHistory);
    loadActive();
  }

  async function loadActive() {
    const el = $('#active'); if (!el) return;
    try {
      const list = await API.req('/tournaments/active', { auth: false });
      if (!list.length) { el.innerHTML = '<p class="muted" style="font-size:13px">No hay torneos activos ahora. Usa un código si tienes uno.</p>'; return; }
      el.innerHTML = '<div class="muted" style="font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Torneos activos</div>' +
        list.map((t) => `<div class="tcard" data-code="${esc(t.code)}" data-open="${t.status === 'setup' ? '1' : '0'}">
          <div class="row" style="justify-content:space-between;align-items:center">
            <b>${esc(t.name)}</b>
            <span class="pill ${t.status === 'setup' ? 'pill-ok' : 'pill-pend'}">${t.status === 'setup' ? 'Registro abierto' : 'En curso'}</span>
          </div>
          <div class="muted" style="font-size:12.5px;margin-top:5px">${t.players} jugador(es) · ${esc(fmtDate(t.created_at))} · código <b style="font-family:var(--mono);letter-spacing:1px">${esc(t.code)}</b></div>
          ${t.note ? `<div class="muted" style="font-size:12.5px;margin-top:5px">${esc(t.note)}</div>` : ''}
        </div>`).join('');
      el.querySelectorAll('.tcard').forEach((c) => c.addEventListener('click', () => {
        if (c.dataset.open !== '1') { const pe = $('#perr'); if (pe) pe.textContent = 'Ese torneo ya cerró el registro.'; return; }
        doJoin(c.dataset.code);
      }));
    } catch (e) { el.innerHTML = '<p class="muted" style="font-size:13px">No se pudo cargar la lista de torneos.</p>'; }
  }

  async function doJoin(code) {
    code = (code || '').trim().toUpperCase();
    const errEl = $('#perr');
    if (code.length !== 5) { if (errEl) errEl.textContent = 'El código tiene 5 caracteres.'; return; }
    const btn = $('#join'); if (btn) btn.disabled = true;
    try {
      let res;
      if (loggedIn()) {
        res = await API.req('/tournaments/join', { method: 'POST', body: { code } });
        setJoined({ id: res.id, name: res.name });
      } else {
        const name = ($('#gname') && $('#gname').value.trim()) || randomName();
        res = await API.req('/tournaments/join', { method: 'POST', auth: false, body: { code, name } });
        setJoined({ id: res.id, name: res.name, guestToken: res.guest_token });
      }
      startPoll();
    } catch (e) {
      if (btn) btn.disabled = false;
      if (errEl) errEl.textContent = e.message || 'No se pudo unir.';
    }
  }

  // ---- pairing screen ----------------------------------------------------
  async function poll() {
    const j = joined(); if (!j) return;
    try {
      const me = await API.req('/tournaments/' + j.id + '/me', { auth: !j.guestToken, guestToken: j.guestToken });
      if (me.status === 'finished') { stopPoll(); showResults(j.id, j, () => { setJoined(null); renderJoin(); }); return; }
      renderPairing(j, me);
    } catch (e) {
      if (e.status === 403) renderJoin('Ya no estás inscrito en ese torneo.');
      // other errors: keep last view, retry next tick
    }
  }

  // ---- results & history -------------------------------------------------
  const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : r);

  async function showResults(id, j, onBack) {
    stopPoll();
    try {
      const pub = await API.req('/tournaments/' + id + '/public', { auth: !(j && j.guestToken), guestToken: j && j.guestToken });
      const mine = (j && j.name) || (() => { try { return localStorage.getItem('ygo_username'); } catch { return null; } })();
      renderResults(pub, mine, onBack);
    } catch (e) {
      root.innerHTML = `<div class="card"><p class="gate-error">${esc(e.message)}</p><button class="btn btn-sm btn-ghost" id="back" style="width:100%">← Volver</button></div>`;
      $('#back').addEventListener('click', onBack);
    }
  }

  function renderResults(pub, highlightName, onBack) {
    const rows = pub.standings.map((s) => `
      <tr class="${highlightName && s.name === highlightName ? 'me' : ''}">
        <td>${medal(s.rank)}</td><td>${esc(s.name)}${s.dropped ? ' <span class="pill pill-drop">DROP</span>' : ''}</td>
        <td>${s.points}</td><td>${s.wins}-${s.losses}</td></tr>`).join('');
    root.innerHTML = `
      <div class="card">
        <h2 style="margin-top:0">${esc(pub.name)}</h2>
        <div class="muted" style="margin-bottom:12px">${pub.status === 'finished' ? '🏁 Resultados finales' : 'Tabla parcial'}</div>
        <table><thead><tr><th>#</th><th>Jugador</th><th>Pts</th><th>G-P</th></tr></thead><tbody>${rows}</tbody></table>
        <button class="btn btn-sm btn-ghost" id="back" style="margin-top:16px;width:100%">← Volver</button>
      </div>
      <style>#player tr.me{ background:rgba(130,216,235,.12); } #player tr.me td{ color:var(--ink); font-weight:700; }</style>`;
    $('#back').addEventListener('click', onBack);
  }

  async function renderHistory() {
    stopPoll();
    root.innerHTML = `<div class="card"><h2 style="margin-top:0">Mis torneos</h2><div class="muted" id="hl">Cargando…</div>
      <button class="btn btn-sm btn-ghost" id="back" style="margin-top:14px;width:100%">← Volver</button></div>`;
    $('#back').addEventListener('click', () => renderJoin());
    try {
      const list = await API.req('/me/tournaments');
      if (!list.length) { $('#hl').textContent = 'Aún no te has inscrito en torneos.'; return; }
      const ul = document.createElement('ul'); ul.className = 'list';
      ul.innerHTML = list.map((t) => `<li data-id="${t.id}" style="cursor:pointer">
        <span class="grow">${esc(t.name)}</span>
        <span class="pill ${t.status === 'finished' ? 'pill-ok' : 'pill-pend'}">${t.status === 'finished' ? 'Finalizado' : 'En curso'}</span></li>`).join('');
      $('#hl').replaceWith(ul);
      ul.addEventListener('click', (e) => {
        const li = e.target.closest('li[data-id]'); if (!li) return;
        showResults(Number(li.dataset.id), null, () => renderHistory());
      });
    } catch (e) { const hl = $('#hl'); if (hl) hl.textContent = e.message; }
  }

  function renderPairing(j, me) {
    let body;
    if (me.status === 'finished') {
      body = `<div class="big">🏁 Torneo finalizado</div><p class="muted">¡Gracias por jugar!</p>`;
      stopPoll();
    } else if (!me.pairing) {
      body = `<div class="big">✅ Inscrito</div><p class="muted">Espera a que el organizador inicie el torneo o genere la ronda.</p>`;
    } else if (me.pairing.isBye) {
      body = `<div class="round">Ronda ${me.currentRound} de ${me.maxRounds}</div><div class="big">Descansas (BYE)</div><p class="muted">Ganas la ronda automáticamente.</p>`;
    } else {
      const res = me.pairing.reported
        ? `<span class="pill ${me.pairing.result === 'p1' || me.pairing.result === 'p2' ? 'pill-ok' : 'pill-drop'}">Resultado reportado</span>`
        : `<span class="pill pill-pend">En juego</span>`;
      body = `<div class="round">Ronda ${me.currentRound} de ${me.maxRounds}</div>
              <div class="big">Mesa ${me.pairing.table}</div>
              <div class="vs">vs <b>${esc(me.pairing.opponent || '—')}</b></div>
              <div style="margin-top:12px">${res}</div>`;
    }
    root.innerHTML = `
      <div class="card" style="text-align:center">
        <div class="muted" style="font-size:13px">${esc(me.name || '')}</div>
        <div class="muted" style="font-size:12px;margin-bottom:14px">Jugando como <b>${esc(j.name)}</b></div>
        ${body}
        <button class="btn btn-sm btn-ghost" id="leave" style="margin-top:20px">Salir</button>
      </div>
      <style>
        #player .big{ font-size:34px; font-weight:800; margin:6px 0; color:var(--gold); }
        #player .round{ color:var(--ink-soft); font-size:13px; letter-spacing:.4px; text-transform:uppercase; }
        #player .vs{ font-size:18px; color:var(--ink); }
      </style>`;
    $('#leave').addEventListener('click', () => { setJoined(null); renderJoin(); });
  }

  function startPoll() { stopPoll(); poll(); pollTimer = setInterval(poll, 4000); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && joined()) poll(); });

  // ---- boot --------------------------------------------------------------
  // Allow ?code=XXXX / #XXXX prefill from a shared link.
  const pre = (new URLSearchParams(location.search).get('code') || location.hash.replace('#', '')).toUpperCase();
  if (joined()) startPoll();
  else renderJoin(null, pre);
})();
