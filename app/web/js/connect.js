/* SwissYGO connected-mode layer (Phase A: landing gate + account control).
 * Classic script loaded AFTER app.js, so offline behavior is untouched: this only
 * gates entry and adds a header control. Guest → today's offline console.
 * Reuses existing styles (.modal-overlay/.modal, nav.tabs, .btn*). */
(function () {
  const LS_GUEST = 'ygo_guest';
  const LS_USER = 'ygo_username';
  const LS_ROLE = 'ygo_role';

  const hasSession = () => !!API.token.get();
  const isGuest = () => { try { return sessionStorage.getItem(LS_GUEST) === '1'; } catch { return false; } };
  const username = () => { try { return localStorage.getItem(LS_USER) || ''; } catch { return ''; } };
  const role = () => { try { return localStorage.getItem(LS_ROLE) || 'player'; } catch { return 'player'; } };
  const isTO = () => hasSession() && role() === 'to';
  const setGuest = (v) => { try { v ? sessionStorage.setItem(LS_GUEST, '1') : sessionStorage.removeItem(LS_GUEST); } catch {} };
  const setUser = (u) => { try { u ? localStorage.setItem(LS_USER, u) : localStorage.removeItem(LS_USER); } catch {} };
  const setRole = (r) => { try { r ? localStorage.setItem(LS_ROLE, r) : localStorage.removeItem(LS_ROLE); } catch {} };

  // Re-read role/username from the server (so an admin role/disable change applies).
  async function refreshMe() {
    if (!hasSession()) { applyView(); return; }
    try {
      const r = await API.me();
      setUser(r.user.username); setRole(r.user.role);
      renderAccount();
      applyView();
      if (isCloud() && isTO() && !state.started) startRegPoll();
    } catch (e) {
      if (e.status === 401) { API.token.clear(); setUser(''); setRole(''); stopRegPoll(); renderAccount(); }
      applyView(); // fall back to stored role when offline
    }
  }

  // ---- header account control -------------------------------------------
  function renderAccount() {
    const header = document.querySelector('header.app');
    if (!header) return;
    let ctl = header.querySelector('.account-ctl');
    if (!ctl) {
      ctl = document.createElement('div');
      ctl.className = 'account-ctl';
      const themeBtn = header.querySelector('.theme-switch');
      header.insertBefore(ctl, themeBtn || null);
    }
    if (hasSession()) {
      let cloud = '';
      if (isTO()) {
        cloud = isCloud()
          ? `<button class="btn btn-sm" data-acc="code" title="Ver código y estado">Código <b></b></button>`
          : `<button class="btn btn-sm" data-acc="publish" title="Publicar para que jugadores se inscriban">☁ Publicar</button>`;
        cloud += `<button class="btn btn-sm" data-acc="panel" title="Administrar cualquier torneo">Torneos</button>`;
      }
      ctl.innerHTML = `<span class="who">Hola, <b class="uname"></b></span>${cloud}<button class="btn btn-sm btn-ghost" data-acc="logout">Salir</button>`;
      ctl.querySelector('.uname').textContent = username() || 'usuario';
      if (isTO() && isCloud()) ctl.querySelector('[data-acc="code"] b').textContent = state.cloud.code;
    } else {
      ctl.innerHTML = `<span class="who">Invitado</span><button class="btn btn-sm btn-ghost" data-acc="login">Iniciar sesión</button>`;
    }
  }

  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-acc]');
    if (!b) return;
    if (b.dataset.acc === 'logout') { await flushSync(); API.token.clear(); setUser(''); setRole(''); setGuest(false); stopRegPoll(); renderAccount(); applyView(); }
    if (b.dataset.acc === 'login') { setGuest(false); applyView(); }
    if (b.dataset.acc === 'publish') publish();
    if (b.dataset.acc === 'code') showCodeModal(isCloud() ? state.cloud.code : '');
    if (b.dataset.acc === 'panel') showTournamentsPanel();
  });

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function makeModal(maxW = 420) {
    const o = document.createElement('div'); o.className = 'modal-overlay';
    const body = document.createElement('div'); body.className = 'modal'; body.style.maxWidth = maxW + 'px';
    o.appendChild(body); document.body.appendChild(o);
    requestAnimationFrame(() => o.classList.add('open'));
    const close = () => { o.classList.remove('open'); setTimeout(() => o.remove(), 200); };
    o.addEventListener('click', (e) => { if (e.target === o || e.target.closest('[data-close]')) close(); });
    return { body, close };
  }

  // Admin panel: EVERY tournament (a TO can administer any event, not just its own
  // or the ones it joined as a player). Shows round progress + timer state so the
  // TO can resume one mid-round. "Abrir" loads it into the console.
  async function showTournamentsPanel() {
    const m = makeModal(520);
    m.body.innerHTML = '<h3 class="modal-title">Torneos</h3><p class="modal-msg" id="mt">Cargando…</p>';
    try {
      const list = await API.req('/tournaments');
      if (!list.length) { m.body.querySelector('#mt').textContent = 'Aún no hay torneos.'; return; }
      const statusLabel = (s) => s === 'finished' ? 'Finalizado' : s === 'running' ? 'En curso' : 'Registro';
      const timerLabel = { running: '⏱ corriendo', paused: '⏱ en pausa', ended: '⏱ terminado' };
      const day = (s) => { const d = String(s || '').slice(0, 10); return d || '—'; };
      const curId = isCloud() ? state.cloud.id : null;
      const ul = document.createElement('ul'); ul.className = 'list tlist';
      ul.innerHTML = list.map((t) => {
        const here = t.id === curId;
        const progress = t.status === 'setup'
          ? `${t.players} jugador${t.players === 1 ? '' : 'es'}`
          : `Ronda ${t.currentRound}/${t.maxRounds} · ${t.players} jug.`;
        const timer = timerLabel[t.timer] ? ` · ${timerLabel[t.timer]}` : '';
        const code = `<code class="tcode">${esc(t.join_code)}</code>`;
        return `<li class="trow">
          <div class="grow">
            <div class="tname">${esc(t.name)} <span class="pill ${t.status === 'finished' ? 'pill-ok' : 'pill-pend'}">${statusLabel(t.status)}</span>${here ? ' <span class="pill pill-ok">Abierto</span>' : ''}</div>
            <div class="tmeta">${code} · ${progress}${timer} · ${day(t.created_at)}${t.owner ? ' · por ' + esc(t.owner) : ''}</div>
          </div>
          <div class="tacts">
            <button class="btn btn-sm" data-act="open" data-id="${t.id}"${here ? ' disabled' : ''}>${here ? 'Actual' : 'Abrir'}</button>
            <button class="btn btn-sm btn-ghost" data-act="res" data-id="${t.id}">Resultados</button>
          </div></li>`;
      }).join('');
      m.body.querySelector('#mt').replaceWith(ul);
      ul.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-act]'); if (!btn || btn.disabled) return;
        const id = Number(btn.dataset.id);
        m.close();
        if (btn.dataset.act === 'open') loadTournament(id);
        else showResultsModal(id);
      });
    } catch (e) { const el = m.body.querySelector('#mt'); if (el) el.textContent = e.message; }
  }

  async function showResultsModal(id) {
    const m = makeModal();
    m.body.innerHTML = '<p class="modal-msg">Cargando resultados…</p>';
    try {
      const pub = await API.req('/tournaments/' + id + '/public');
      const rows = pub.standings.map((s) => `<tr><td>${s.rank}</td><td>${esc(s.name)}${s.dropped ? ' <span class="pill pill-drop">DROP</span>' : ''}</td><td>${s.points}</td><td>${s.wins}-${s.losses}</td></tr>`).join('');
      m.body.innerHTML = `<h3 class="modal-title">${esc(pub.name)}</h3>
        <div class="modal-msg" style="margin-bottom:10px">${pub.status === 'finished' ? '🏁 Resultados finales' : 'Tabla parcial'}</div>
        <table><thead><tr><th>#</th><th>Jugador</th><th>Pts</th><th>G-P</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="modal-actions" style="margin-top:16px"><button class="btn" data-close>Cerrar</button></div>`;
    } catch (e) {
      m.body.innerHTML = `<p class="gate-error">${esc(e.message)}</p><div class="modal-actions"><button class="btn" data-close>Cerrar</button></div>`;
    }
  }

  // Open a specific cloud tournament into the console: pull its state_json, make
  // it the live `state`, relink the cloud id/code, and resume sync + reg polling.
  // Replacing what's on screen is destructive, so confirm first (styled modal).
  async function loadTournament(id) {
    let t;
    try { t = await API.req('/tournaments/' + id); }
    catch (e) { if (window.showToast) showToast('No se pudo abrir el torneo: ' + e.message, true); return; }
    const open = () => {
      const base = window.emptyState ? window.emptyState() : {};
      state = Object.assign(base, t.state || {});
      state.cloud = { id: t.id, code: t.join_code };
      stopRegPoll();
      save();                                  // persist locally + push (wrapped)
      if (window.render) render();
      if (window.switchTab) switchTab(state.finished ? 'standings' : state.started ? 'rondas' : 'registro');
      renderAccount();
      if (!state.started && !state.finished) startRegPoll();
      if (window.showToast) showToast('Torneo «' + t.name + '» abierto.');
    };
    const msg = 'Abrir «' + t.name + '» reemplaza el torneo que tienes en pantalla. ¿Continuar?';
    if (window.openConfirm) openConfirm(msg, open, { title: 'Abrir torneo', confirmText: 'Abrir' });
    else open();
  }

  // ---- cloud hosting (Phase B) ------------------------------------------
  let syncTimer = null, regPollTimer = null, saveWrapped = false;
  const isCloud = () => !!(typeof state !== 'undefined' && state && state.cloud && state.cloud.id);

  // Wrap the global save() once: keep localStorage, and (when cloud-linked) push
  // state to the server (debounced, fail-soft). Function declarations are window
  // properties, so app.js's internal save() calls use the wrapped one too.
  function wrapSave() {
    if (saveWrapped || typeof window.save !== 'function') return;
    const orig = window.save;
    window.save = function () { orig.apply(this, arguments); if (isCloud()) scheduleSync(); };
    saveWrapped = true;
  }
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(cloudSync, 400); }
  async function cloudSync() {
    if (!isCloud()) return;
    try { await API.req('/tournaments/' + state.cloud.id, { method: 'PUT', body: { state } }); }
    catch (e) { /* fail-soft: localStorage remains the cache; retry on next save */ }
  }
  // Push any debounced-but-unsent state before the page goes away, so closing the
  // tab / navigating right after a report/start/finish doesn't leave the server
  // stale (players would keep polling old pairings). keepalive lets it outlive
  // the page. `await flushSync()` is also used before logout (token still valid).
  async function flushSync() {
    if (!isCloud() || !syncTimer) return;
    clearTimeout(syncTimer); syncTimer = null;
    const t = API.token.get();
    try {
      await fetch('/api/tournaments/' + state.cloud.id, {
        method: 'PUT', keepalive: true,
        headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) },
        body: JSON.stringify({ state }),
      });
    } catch { /* best-effort */ }
  }
  window.addEventListener('pagehide', flushSync);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSync(); });

  async function publish() {
    if (!hasSession()) { showGate(); return; }
    const name = (state.note && state.note.trim()) || ('Torneo ' + new Date().toLocaleDateString());
    try {
      const r = await API.req('/tournaments', { method: 'POST', body: { name } });
      state.cloud = { id: r.id, code: r.join_code };
      save();              // persists locally + first cloud push (wrapped)
      startRegPoll();
      renderAccount();
      showCodeModal(r.join_code);
    } catch (e) {
      if (window.showToast) showToast('No se pudo publicar: ' + e.message, true);
    }
  }

  // While registration is open, pull self-registrations and absorb them into the
  // TO's player list (single-writer: the TO writes state, players only register).
  function startRegPoll() {
    stopRegPoll();
    if (!isCloud() || state.started) return;
    regPollTimer = setInterval(absorbRegistrations, 4000);
    absorbRegistrations();
  }
  function stopRegPoll() { if (regPollTimer) { clearInterval(regPollTimer); regPollTimer = null; } }
  async function absorbRegistrations() {
    if (!isCloud() || state.started) { stopRegPoll(); return; }
    try {
      const regs = await API.req('/tournaments/' + state.cloud.id + '/registrations');
      const removed = (state.cloud && state.cloud.removed) || [];
      let added = 0;
      for (const r of regs) {
        // Skip registrations the TO removed via "Eliminar": absorbing them again
        // would resurrect a no-show right after the TO took them out.
        if (removed.includes(r.player_id)) continue;
        if (!state.players.some((p) => p.id === r.player_id)) {
          state.players.push({ id: r.player_id, name: r.display_name, dropped: false, hasReceivedBye: false, userId: r.user_id || null });
          added++;
        }
      }
      if (added) {
        save();
        if (window.render) render();
        if (window.showToast) showToast(added + (added === 1 ? ' jugador se inscribió.' : ' jugadores se inscribieron.'));
      }
    } catch (e) { /* ignore transient poll errors */ }
  }

  function showCodeModal(code) {
    if (document.getElementById('code-modal')) return;
    const m = document.createElement('div');
    m.className = 'modal-overlay'; m.id = 'code-modal';
    m.innerHTML = `
      <div class="modal" style="max-width:380px;text-align:center">
        <h3 class="modal-title">Torneo publicado</h3>
        <p class="modal-msg" style="margin-bottom:8px">Los jugadores entran a <b>torneodev.elbunkers.com/u</b> e ingresan este código:</p>
        <div style="font-family:var(--mono);font-size:42px;font-weight:800;letter-spacing:8px;color:var(--gold);margin:4px 0 18px">${code}</div>
        <div class="modal-actions" style="justify-content:center"><button class="btn btn-gold" data-close>Listo</button></div>
      </div>`;
    document.body.appendChild(m);
    requestAnimationFrame(() => m.classList.add('open'));
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) { m.classList.remove('open'); setTimeout(() => m.remove(), 200); }
    });
  }

  // ---- landing gate ------------------------------------------------------
  let mode = 'login'; // 'login' | 'register'

  function showGate() {
    if (document.getElementById('gate')) return;
    const g = document.createElement('div');
    g.className = 'modal-overlay';
    g.id = 'gate';
    g.innerHTML = `
      <div class="modal" style="max-width:400px">
        <h3 class="modal-title">SwissYGO</h3>
        <p class="modal-msg" style="margin-bottom:16px">Gestor de Torneos — Velvet Room</p>
        <nav class="tabs" id="gate-tabs" style="margin:0 0 16px">
          <span class="tab-indicator"></span>
          <button type="button" class="active" data-gt="login">Iniciar sesión</button>
          <button type="button" data-gt="register">Crear cuenta</button>
        </nav>
        <form id="gate-form">
          <div class="gate-field"><label>Usuario</label><input type="text" id="gate-user" autocomplete="username" autocapitalize="none" spellcheck="false"></div>
          <div class="gate-field" id="gate-email-wrap" hidden><label>Correo (opcional)</label><input type="text" id="gate-email" autocomplete="email" autocapitalize="none" spellcheck="false"></div>
          <div class="gate-field"><label>Contraseña</label><input type="password" id="gate-pass" autocomplete="current-password"></div>
          <div class="gate-error" id="gate-error"></div>
          <button class="btn btn-gold" type="submit" id="gate-submit" style="width:100%">Entrar</button>
        </form>
        <button class="btn btn-ghost btn-sm" id="gate-guest" type="button" style="width:100%;margin-top:12px">Ingresar como invitado</button>
      </div>`;
    document.body.appendChild(g);
    requestAnimationFrame(() => g.classList.add('open')); // play the modal open animation

    const tabs = g.querySelector('#gate-tabs');
    tabs.addEventListener('click', (e) => {
      const t = e.target.closest('[data-gt]'); if (!t) return;
      setMode(t.dataset.gt, g, true);
    });
    g.querySelector('#gate-form').addEventListener('submit', (e) => { e.preventDefault(); submit(g); });
    g.querySelector('#gate-guest').addEventListener('click', () => { setGuest(true); renderAccount(); applyView(); });
    setMode('login', g, false);
    setTimeout(() => g.querySelector('#gate-user').focus(), 60);
  }

  // Slide the pill (.tab-indicator) under the active tab — same mechanism as the
  // main nav's moveTabIndicator(). animate=false places it instantly (first paint).
  function positionGatePill(g, animate) {
    const ind = g.querySelector('#gate-tabs .tab-indicator');
    const btn = g.querySelector('#gate-tabs button.active');
    if (!ind || !btn) return;
    if (!animate) ind.style.transition = 'none';
    ind.style.width = btn.offsetWidth + 'px';
    ind.style.transform = 'translateX(' + btn.offsetLeft + 'px)';
    if (!animate) requestAnimationFrame(() => { ind.style.transition = ''; });
  }

  function setMode(m, g, animate) {
    if (animate && m === mode) return; // clicking the active tab: nothing to do
    const modal = g.querySelector('.modal');
    const h0 = modal.offsetHeight; // height before the content change

    mode = m;
    g.querySelectorAll('#gate-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.gt === m));
    g.querySelector('#gate-email-wrap').hidden = m !== 'register';
    g.querySelector('#gate-submit').textContent = m === 'register' ? 'Crear cuenta' : 'Entrar';
    g.querySelector('#gate-pass').setAttribute('autocomplete', m === 'register' ? 'new-password' : 'current-password');
    g.querySelector('#gate-error').textContent = '';

    positionGatePill(g, animate);

    // Tween the box height between the two layouts (mirrors .tab-stack.h-anim).
    modal.style.height = '';
    const h1 = modal.offsetHeight;
    if (animate && Math.abs(h1 - h0) > 1) {
      modal.classList.add('h-anim');
      modal.style.height = h0 + 'px';
      void modal.offsetHeight; // reflow so the transition starts from h0
      modal.style.height = h1 + 'px';
      const settle = () => {
        modal.style.height = '';
        modal.classList.remove('h-anim');
        modal.removeEventListener('transitionend', settle);
      };
      modal.addEventListener('transitionend', settle, { once: true });
      setTimeout(settle, 600); // safety net
    }
  }

  async function submit(g) {
    const user = g.querySelector('#gate-user').value.trim();
    const pass = g.querySelector('#gate-pass').value;
    const email = g.querySelector('#gate-email').value.trim();
    const errEl = g.querySelector('#gate-error');
    const btn = g.querySelector('#gate-submit');
    errEl.textContent = '';
    if (!user || !pass) { errEl.textContent = 'Usuario y contraseña requeridos.'; return; }
    if (mode === 'register' && pass.length < 6) { errEl.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
    btn.disabled = true;
    try {
      const r = mode === 'register' ? await API.register(user, pass, email || undefined) : await API.login(user, pass);
      API.token.set(r.token);
      setUser(r.user.username);
      setRole(r.user.role);
      setGuest(false);
      renderAccount();
      applyView();
    } catch (err) {
      errEl.textContent = err.status ? err.message : 'No se pudo conectar con el servidor.';
      btn.disabled = false;
    }
  }

  function closeGate() {
    document.documentElement.classList.remove('gate-pending');
    const g = document.getElementById('gate');
    if (!g) return;
    g.classList.remove('open');
    setTimeout(() => g.remove(), 220);
  }

  // Entry routing: the main page is the ORGANIZER console — only TOs see it.
  // Account players and guests are routed to the player page (/u/); unauthenticated
  // visitors get the login/register/guest gate.
  function applyView() {
    if (hasSession() && isTO()) {              // organizer → console
      closeGate();
      document.documentElement.classList.remove('gate-pending');
      return;
    }
    if (hasSession() || isGuest()) {           // account player or guest → player page
      location.replace('/u/');
      return;
    }
    showGate();                                // not authenticated, not guest
  }

  // Before a CLOUD tournament starts, drain pending self-registrations so a player
  // who joined seconds earlier (between absorb polls) isn't stranded: otherwise the
  // TO closes registration and that player polls /me forever with no pairing.
  // app.js binds #start-tournament by reference (and registered first), so we
  // intercept on document in the CAPTURE phase — runs before app.js's handler and
  // stopImmediatePropagation keeps the event from reaching it; we re-invoke after.
  let draining = false;
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('#start-tournament');
    if (!btn || draining) return;
    if (!isCloud() || (typeof state !== 'undefined' && state.started)) return; // offline / already running: let app.js handle it
    e.preventDefault();
    e.stopImmediatePropagation();
    draining = true; btn.disabled = true;
    try { await absorbRegistrations(); } catch { /* fall through: start with what we have */ }
    draining = false; btn.disabled = false;
    if (window.startTournament) startTournament();
  }, true);

  // When the TO removes a self-registered player ("Eliminar"), tombstone that
  // player_id so the absorb poll / pre-start drain don't add them back. We record
  // in the capture phase (before app.js's delegated handler removes them) and let
  // app.js's removePlayer + save() run normally (the tombstone rides along in state).
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove"]');
    if (!btn || !isCloud()) return;
    const id = btn.dataset.id;
    if (!id) return;
    state.cloud.removed = state.cloud.removed || [];
    if (!state.cloud.removed.includes(id)) state.cloud.removed.push(id);
  }, true);

  // "Nuevo Torneo" (#reset-all) on a cloud-linked, not-yet-finished event must
  // CLOSE it on the server first — otherwise resetAll drops state.cloud and the
  // wrapped save() no longer PUTs, leaving an orphan tournament that players can
  // still join/poll in /u/. We intercept (capture) and run our own confirm+reset.
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('#reset-all');
    if (!btn || !isCloud()) return; // offline / unpublished: let app.js handle it
    e.preventDefault();
    e.stopImmediatePropagation();
    const id = state.cloud.id;
    const active = !state.finished;
    const msg = active
      ? 'Se borrarán los jugadores y rondas. Este torneo está PUBLICADO: se cerrará para los jugadores (ya no podrán inscribirse ni ver emparejamientos).'
      : 'Se borrarán todos los jugadores y rondas actuales. Esta acción no se puede deshacer.';
    const reset = async () => {
      if (active) { try { await API.req('/tournaments/' + id + '/finish', { method: 'POST' }); } catch { /* best-effort close */ } }
      stopRegPoll();
      state = window.emptyState ? window.emptyState() : {};
      roundsManuallySet = false;
      save(); // no cloud now → local only, which is correct
      if (window.switchTab) switchTab('registro');
      if (window.render) render();
      renderAccount();
    };
    if (window.openConfirm) openConfirm(msg, reset, { title: 'Nuevo Torneo', confirmText: 'Sí, reiniciar', danger: true });
    else reset();
  }, true);

  // ---- boot --------------------------------------------------------------
  wrapSave();
  renderAccount();
  refreshMe(); // sets role from the server then routes (applyView); falls back to stored role offline
})();
