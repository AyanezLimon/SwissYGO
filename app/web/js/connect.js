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
  const isTO = () => hasSession() && role() === 'to';                                   // official: ranked-capable, admins any event
  const isCasual = () => hasSession() && role() === 'casual';                            // casual-only: unranked, own events
  const isOrganizer = () => hasSession() && (role() === 'to' || role() === 'casual');    // either → gets the console
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
      if (isCloud() && isOrganizer()) { await pullCloudStateOnBoot(); startRegPoll(); } // self-gates (setup or late-entry window)
    } catch (e) {
      if (e.status === 401) { API.token.clear(); setUser(''); setRole(''); stopRegPoll(); renderAccount(); }
      applyView(); // fall back to stored role when offline
    }
  }

  // On boot the in-memory `state` came from localStorage (app.js load()) and may be
  // STALE — the server is the durable source of truth (the tournament could have
  // changed from another device/tab, or via a data fix). Pull the authoritative
  // state and adopt it BEFORE we poll or let the TO save, so a plain refresh never
  // shows — or, on the next save, re-pushes — outdated data (the localStorage cache
  // could otherwise clobber the server). Fail-soft: if the API is unreachable we keep
  // the local copy, so the offline flow still works. Mirrors loadTournament's adopt,
  // minus the confirm + tab switch (it's the same tournament the TO already had open).
  async function pullCloudStateOnBoot() {
    if (!isCloud()) return;
    const id = state.cloud.id;
    let t;
    try {
      t = await API.req('/tournaments/' + id);
    } catch (e) {
      // Fail-soft: keep the local cache so the offline flow still works. Log with the
      // status so an operator can tell offline (no status) from auth/server issues
      // (401/403/5xx) — but adopting nothing is the safe default either way.
      console.warn('[boot] kept local cache; server state for tournament ' + id + ' unavailable: ' + (e && (e.status ? 'HTTP ' + e.status : e.message)));
      return;
    }
    if (!t || !t.state) { console.warn('[boot] kept local cache; server returned no state for tournament ' + id); return; }
    const base = window.emptyState ? window.emptyState() : {};
    state = Object.assign(base, t.state);
    // t.state.cloud already carries the synced metadata (incl. `removed` tombstones);
    // just re-pin id/code, and take ranked from its authoritative column.
    state.cloud = Object.assign({}, state.cloud, { id: t.id, code: t.join_code });
    state.ranked = t.ranked !== false;
    // Persist the adopted state to localStorage WITHOUT pushing it back to the server:
    // the cloud copy is the source we just read, so a PUT would be a redundant write
    // (extra request + confusing in logs). Use app.js's unwrapped save (localStorage
    // only); fall back to the wrapped save only if the handle isn't set yet.
    (_origSave || window.save)();
    if (window.render) render();
    renderAccount();
    syncTournamentFields();
    console.info('[boot] adopted server state for tournament ' + id);
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
      // The publish/code control lives in the file toolbar (see mountToolbarCloudBtn),
      // so the header only carries the account + "Torneos" panel.
      const cloud = isOrganizer() ? `<button class="btn btn-sm" data-acc="panel" title="${isTO() ? 'Administrar cualquier torneo' : 'Tus torneos'}">Torneos</button>` : '';
      ctl.innerHTML = `<span class="who">Hola, <b class="uname"></b></span>${cloud}<button class="btn btn-sm btn-ghost" data-acc="account" title="Tu correo y cuenta">Cuenta</button><button class="btn btn-sm btn-ghost" data-acc="logout">Salir</button>`;
      ctl.querySelector('.uname').textContent = username() || 'usuario';
    } else {
      ctl.innerHTML = `<span class="who">Invitado</span><button class="btn btn-sm btn-ghost" data-acc="login">Iniciar sesión</button>`;
    }
    mountToolbarCloudBtn();
  }

  // The TO's cloud control in the file toolbar (with Exportar/Importar/Nuevo
  // torneo). It STAYS in this slot through publish: "☁ Publicar" before, then
  // "Código XXXXX" after — so it doesn't jump to the header once published.
  function mountToolbarCloudBtn() {
    const tb = document.querySelector('.toolbar');
    if (!tb || !tb.querySelector('#reset-all')) return; // only the file toolbar
    let btn = document.getElementById('toolbar-publish');
    let saveBtn = document.getElementById('toolbar-save');
    if (!(hasSession() && isOrganizer())) { if (btn) btn.remove(); if (saveBtn) saveBtn.remove(); return; }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'toolbar-publish'; btn.type = 'button';
      tb.insertBefore(btn, tb.querySelector('.spacer') || tb.querySelector('#reset-all')); // group with the utilities, left of the spacer (keeps destructive "Nuevo Torneo" apart)
    }
    if (isCloud()) {
      // "💾 Guardar" only makes sense once published; sits left of the code button.
      if (!saveBtn) {
        saveBtn = document.createElement('button');
        saveBtn.id = 'toolbar-save'; saveBtn.type = 'button';
        saveBtn.className = 'btn btn-sm';
        saveBtn.textContent = '💾 Guardar';
        saveBtn.title = 'Guardar este torneo en el servidor ahora';
        saveBtn.onclick = saveNow;
        tb.insertBefore(saveBtn, btn);
      }
      btn.className = 'btn btn-sm';
      btn.textContent = 'Código ' + state.cloud.code;
      btn.title = 'Ver código y enlace';
      btn.onclick = () => showCodeModal(state.cloud.code);
    } else {
      if (saveBtn) saveBtn.remove();
      btn.className = 'btn btn-sm btn-gold';
      btn.textContent = '☁ Publicar';
      btn.title = 'Publicar para que jugadores se inscriban';
      btn.onclick = publish;
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
    if (b.dataset.acc === 'account') showAccountModal();
  });

  // Add/change the account's email (self-service). Re-checks the current password.
  async function showAccountModal() {
    const m = makeModal(400);
    m.body.innerHTML = '<h3 class="modal-title">Mi cuenta</h3><p class="modal-msg">Cargando…</p>';
    let cur = null;
    try { const me = await API.me(); cur = me.user.email || null; } catch (e) {}
    m.body.innerHTML = `
      <h3 class="modal-title">Mi cuenta</h3>
      <p class="modal-msg" style="margin-bottom:12px">Correo actual: <b>${cur ? esc(cur) : 'sin correo'}</b><br>
        <span style="font-size:12px;color:var(--ink-soft)">Se usa para restablecer tu contraseña.</span></p>
      <div class="gate-field"><label>${cur ? 'Nuevo correo' : 'Agregar correo'}</label><input type="text" id="ac-email" autocomplete="email" autocapitalize="none" spellcheck="false" value="${cur ? esc(cur) : ''}"></div>
      <div class="gate-field"><label>Contraseña actual</label><input type="password" id="ac-pass" autocomplete="current-password"></div>
      <div class="gate-error" id="ac-error"></div>
      <button class="btn btn-gold" id="ac-save" type="button" style="width:100%">Guardar correo</button>
      <button class="btn btn-ghost btn-sm" data-close type="button" style="width:100%;margin-top:8px">Cancelar</button>`;
    m.body.querySelector('#ac-save').addEventListener('click', async () => {
      const err = m.body.querySelector('#ac-error'); err.textContent = '';
      const email = m.body.querySelector('#ac-email').value.trim();
      const password = m.body.querySelector('#ac-pass').value;
      if (!email) { err.textContent = 'Escribe un correo.'; return; }
      if (!password) { err.textContent = 'Ingresa tu contraseña actual.'; return; }
      const btn = m.body.querySelector('#ac-save'); btn.disabled = true;
      try {
        await API.req('/auth/email', { method: 'POST', body: { email, password } });
        m.body.innerHTML = '<h3 class="modal-title">Listo</h3><p class="modal-msg" style="margin:8px 0 14px">Tu correo se actualizó.</p><button class="btn btn-gold" data-close type="button" style="width:100%">Cerrar</button>';
      } catch (e) { err.textContent = e.message || 'No se pudo guardar.'; btn.disabled = false; }
    });
  }

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

  // Admin panel: EVERY tournament (a TO administers any event, not just its own).
  // A searchable / sortable / paginated table — stays usable with many events.
  // "Abrir" loads one into the console; "Resultados" shows the shared image.
  async function showTournamentsPanel() {
    const m = makeModal(760);
    m.body.innerHTML = '<h3 class="modal-title">Torneos</h3><p class="modal-msg" id="mt">Cargando…</p>';
    let list;
    try { list = await API.req('/tournaments'); }
    catch (e) { const el = m.body.querySelector('#mt'); if (el) el.textContent = e.message; return; }
    if (!list.length) { m.body.querySelector('#mt').textContent = 'Aún no hay torneos.'; return; }

    const statusLabel = (s) => s === 'finished' ? 'Finalizado' : s === 'running' ? 'En curso' : 'Registro';
    const timerMark = { running: '⏱', paused: '⏸', ended: '⏱✓' };
    const day = (s) => String(s || '').slice(0, 10) || '—';
    const PER = 8;
    const curId = isCloud() ? state.cloud.id : null;
    const ui = { q: '', status: 'all', sort: 'created_at', dir: -1, page: 0 };

    m.body.innerHTML = `
      <h3 class="modal-title">Torneos</h3>
      <div class="tp-toolbar">
        <input type="text" id="tp-q" class="tp-search" placeholder="Buscar nombre, código o creador…" autocomplete="off" autocapitalize="none" spellcheck="false">
        <select id="tp-status" class="tp-filter" aria-label="Filtrar por estado">
          <option value="all">Todos</option><option value="setup">Registro</option>
          <option value="running">En curso</option><option value="finished">Finalizado</option>
        </select>
      </div>
      <div class="tp-wrap">
        <table class="tp-table"><thead><tr>
          <th data-sort="name">Torneo</th><th data-sort="status">Estado</th>
          <th data-sort="currentRound">Ronda</th><th data-sort="players">Jug.</th>
          <th data-sort="created_at">Creado</th><th>Acciones</th>
        </tr></thead><tbody id="tp-body"></tbody></table>
      </div>
      <div class="tp-foot">
        <span id="tp-count" class="tp-count"></span>
        <span class="tp-pager"><button class="btn btn-sm btn-ghost" id="tp-prev" aria-label="Anterior">‹</button>
          <span id="tp-page" class="tp-pageno"></span>
          <button class="btn btn-sm btn-ghost" id="tp-next" aria-label="Siguiente">›</button></span>
      </div>`;
    const body = m.body.querySelector('#tp-body');

    function filtered() {
      let rows = list.slice();
      if (ui.status !== 'all') rows = rows.filter((t) => t.status === ui.status);
      const q = ui.q.trim().toLowerCase();
      if (q) rows = rows.filter((t) => [t.name, t.join_code, t.owner].some((f) => String(f || '').toLowerCase().includes(q)));
      const k = ui.sort, text = (k === 'name' || k === 'status' || k === 'created_at');
      rows.sort((a, b) => {
        if (text) { const av = String(a[k] || '').toLowerCase(), bv = String(b[k] || '').toLowerCase(); return av < bv ? -ui.dir : av > bv ? ui.dir : 0; }
        return ((Number(a[k]) || 0) - (Number(b[k]) || 0)) * ui.dir;
      });
      return rows;
    }
    function draw() {
      const rows = filtered();
      const pages = Math.max(1, Math.ceil(rows.length / PER));
      ui.page = Math.min(Math.max(0, ui.page), pages - 1);
      const slice = rows.slice(ui.page * PER, ui.page * PER + PER);
      body.innerHTML = slice.map((t) => {
        const here = t.id === curId;
        const round = t.status === 'setup' ? '—' : `${t.currentRound}/${t.maxRounds}${timerMark[t.timer] ? ' ' + timerMark[t.timer] : ''}`;
        return `<tr>
          <td><div class="tp-name">${esc(t.name)}${here ? ' <span class="pill pill-ok">Abierto</span>' : ''}</div>
            <div class="tp-sub"><code class="tcode">${esc(t.join_code)}</code>${t.owner ? ' · ' + esc(t.owner) : ''}</div></td>
          <td><span class="pill ${t.status === 'finished' ? 'pill-ok' : 'pill-pend'}">${statusLabel(t.status)}</span>${t.ranked === false ? ' <span class="pill pill-casual" title="No cuenta para el ranking">Casual</span>' : ''}</td>
          <td class="tp-num">${round}</td><td class="tp-num">${t.players}</td><td class="tp-day">${day(t.created_at)}</td>
          <td class="tp-acts"><button class="btn btn-sm" data-act="open" data-id="${t.id}"${here ? ' disabled' : ''}>${here ? 'Actual' : 'Abrir'}</button>
            <button class="btn btn-sm btn-ghost" data-act="res" data-id="${t.id}">Resultados</button></td></tr>`;
      }).join('') || '<tr><td colspan="6" class="tp-empty">Sin resultados.</td></tr>';
      m.body.querySelector('#tp-count').textContent = rows.length + (rows.length === 1 ? ' torneo' : ' torneos');
      m.body.querySelector('#tp-page').textContent = (ui.page + 1) + ' / ' + pages;
      m.body.querySelector('#tp-prev').disabled = ui.page <= 0;
      m.body.querySelector('#tp-next').disabled = ui.page >= pages - 1;
      m.body.querySelectorAll('th[data-sort]').forEach((th) => {
        const on = th.dataset.sort === ui.sort;
        th.classList.toggle('sorted', on);
        th.setAttribute('data-dir', on ? (ui.dir > 0 ? 'asc' : 'desc') : '');
      });
    }

    m.body.querySelector('#tp-q').addEventListener('input', (e) => { ui.q = e.target.value; ui.page = 0; draw(); });
    m.body.querySelector('#tp-status').addEventListener('change', (e) => { ui.status = e.target.value; ui.page = 0; draw(); });
    m.body.querySelector('#tp-prev').addEventListener('click', () => { ui.page--; draw(); });
    m.body.querySelector('#tp-next').addEventListener('click', () => { ui.page++; draw(); });
    m.body.querySelectorAll('th[data-sort]').forEach((th) => th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (ui.sort === k) ui.dir = -ui.dir; else { ui.sort = k; ui.dir = (k === 'name' || k === 'status') ? 1 : -1; }
      draw();
    }));
    body.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-act]'); if (!btn || btn.disabled) return;
      const id = Number(btn.dataset.id);
      m.close();
      if (btn.dataset.act === 'open') loadTournament(id);
      else showResultsModal(id);
    });
    draw();
    setTimeout(() => { const q = m.body.querySelector('#tp-q'); if (q) q.focus(); }, 60);
  }

  // /public → the shared StandingsImage renderer's data shape (web card + PNG).
  function publicToImageData(pub) {
    return {
      standings: (pub.standings || []).map((s) => ({ name: s.name, matchPoints: s.points, wins: s.wins, losses: s.losses, dropped: !!s.dropped })),
      finished: pub.status === 'finished',
      maxRounds: pub.maxRounds, currentRound: pub.currentRound, note: pub.note || '',
      date: pub.date ? new Date(pub.date + 'T00:00:00') : (pub.finished_at ? new Date(String(pub.finished_at).replace(' ', 'T') + 'Z') : new Date()),
    };
  }
  // Build the branded PNG on demand and share it (native sheet) or download it.
  async function shareResultsImage(pub, btn) {
    if (!window.StandingsImage) return;
    if (btn) btn.disabled = true;
    try {
      const img = await StandingsImage.build(publicToImageData(pub));
      if (navigator.canShare && navigator.canShare({ files: [img.file] })) {
        try { await navigator.share({ files: [img.file], title: 'Resultados · Velvet Room' }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; /* user cancelled */ }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(img.blob); a.download = img.fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) {
      if (window.showToast) showToast('No se pudo generar la imagen: ' + e.message, true);
    } finally { if (btn) btn.disabled = false; }
  }

  // Results = the WEB VIEW: an HTML card identical to the shareable image
  // (StandingsImage.buildCardEl), plus a "Compartir" that renders the same design
  // as a PNG for the native share sheet / download.
  async function showResultsModal(id) {
    const m = makeModal(760);
    m.body.innerHTML = '<p class="modal-msg">Cargando resultados…</p>';
    try {
      const pub = await API.req('/tournaments/' + id + '/public');
      m.body.innerHTML = '';
      m.body.appendChild(StandingsImage.buildCardEl(publicToImageData(pub)));
      const actions = document.createElement('div');
      actions.className = 'modal-actions';
      actions.style.cssText = 'margin-top:16px;justify-content:center;gap:10px';
      actions.innerHTML = '<button class="btn btn-gold btn-sm" data-share>📤 Compartir</button><button class="btn btn-sm" data-close>Cerrar</button>';
      m.body.appendChild(actions);
      actions.querySelector('[data-share]').addEventListener('click', (e) => shareResultsImage(pub, e.currentTarget));
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
    const open = async () => {
      await flushSync();                       // push any unsent change to the CURRENT tournament before swapping it out
      const base = window.emptyState ? window.emptyState() : {};
      state = Object.assign(base, t.state || {});
      // Keep the synced cloud metadata — especially the `removed` tombstones; only
      // re-pin id/code from the authoritative response. Replacing state.cloud with a
      // bare { id, code } dropped `removed`, so the absorb poll resurrected players
      // the TO had deleted (the reported "deletion not reflected after reload" bug).
      state.cloud = Object.assign({}, state.cloud, { id: t.id, code: t.join_code });
      state.ranked = t.ranked !== false;       // authoritative ranked flag (column, not state_json)
      stopRegPoll();
      save();                                  // persist locally + push (wrapped)
      if (window.render) render();
      if (window.switchTab) switchTab(state.finished ? 'standings' : state.started ? 'rondas' : 'registro');
      renderAccount();
      syncTournamentFields();
      startRegPoll(); // self-gates (setup or running late-entry window)
      if (window.showToast) showToast('Torneo «' + t.name + '» abierto.');
    };
    const msg = 'Abrir «' + t.name + '» reemplaza el torneo que tienes en pantalla. ¿Continuar?';
    if (window.openConfirm) openConfirm(msg, open, { title: 'Abrir torneo', confirmText: 'Abrir' });
    else open();
  }

  // ---- cloud hosting (Phase B) ------------------------------------------
  let syncTimer = null, regPollTimer = null, saveWrapped = false;
  let _origSave = null;   // app.js's unwrapped save() (localStorage only, no cloud push)
  const isCloud = () => !!(typeof state !== 'undefined' && state && state.cloud && state.cloud.id);

  // Wrap the global save() once: keep localStorage, and (when cloud-linked) push
  // state to the server (debounced, fail-soft). Function declarations are window
  // properties, so app.js's internal save() calls use the wrapped one too.
  function wrapSave() {
    if (saveWrapped || typeof window.save !== 'function') return;
    const orig = window.save;
    _origSave = orig;       // keep a handle to persist locally WITHOUT the cloud push
    window.save = function () { orig.apply(this, arguments); if (isCloud()) scheduleSync(); };
    saveWrapped = true;
  }
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(cloudSync, 400); }
  async function cloudSync() {
    if (!isCloud()) return;
    // name = durable metadata → server stores it in the tournaments.name column
    // (state_json is mutable). Only sent when set; empty leaves the column as-is.
    const name = (state.name && state.name.trim()) || undefined;
    try { await API.req('/tournaments/' + state.cloud.id, { method: 'PUT', body: { state, name } }); }
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
        body: JSON.stringify({ state, name: (state.name && state.name.trim()) || undefined }),
      });
    } catch { /* best-effort */ }
  }
  window.addEventListener('pagehide', flushSync);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSync(); });

  // Explicit "Guardar": force an immediate, AWAITED push with visible feedback.
  // The debounced cloudSync above is fail-soft and silent, so a failed sync goes
  // unnoticed; this button lets the TO confirm the server has the current state
  // (and surfaces any error) — the "definitive save" for tournament config.
  async function saveNow() {
    if (!isCloud()) { if (window.showToast) showToast('Publica el torneo antes de guardarlo en el servidor.', true); return; }
    clearTimeout(syncTimer); syncTimer = null;  // supersede the pending debounce
    const btn = document.getElementById('toolbar-save');
    if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = 'Guardando…'; }
    try {
      await API.req('/tournaments/' + state.cloud.id, { method: 'PUT', body: { state, name: (state.name && state.name.trim()) || undefined } });
      if (window.showToast) showToast('Torneo guardado en el servidor.');
    } catch (e) {
      if (window.showToast) showToast('No se pudo guardar: ' + e.message, true);
      scheduleSync();  // re-arm the debounced sync we superseded, so the queued attempt isn't lost when the manual PUT fails
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label || '💾 Guardar'; }
    }
  }

  const ddmmyyyy = (iso) => { const p = String(iso).split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso; };
  const todayISO = () => new Date().toISOString().slice(0, 10);

  // Name + date are filled in the Registro section (#tournament-name / -date),
  // alongside the player list and the note — NOT in a publish modal. They live in
  // state_json (state.name / state.eventDate); publish just reads them. Wired once,
  // mirroring app.js's #tournament-note pattern (persist on input, refill on load).
  let tfWired = false;
  function wireTournamentFields() {
    const nameEl = document.getElementById('tournament-name');
    const dateEl = document.getElementById('tournament-date');
    const rankedEl = document.getElementById('tournament-ranked');
    if (nameEl && dateEl && !tfWired) {
      tfWired = true;
      nameEl.addEventListener('input', () => { state.name = nameEl.value.trim(); save(); });
      dateEl.addEventListener('change', () => { state.eventDate = dateEl.value || todayISO(); save(); });
      // "Cuenta para el ranking": editable only before the event starts. While
      // cloud-linked + in setup, persist the change to the server immediately (it
      // lives in the tournaments.ranked column, not state_json).
      if (rankedEl) rankedEl.addEventListener('change', async () => {
        if (state.started) { rankedEl.checked = state.ranked !== false; return; } // locked once started
        state.ranked = rankedEl.checked;
        save();
        if (isCloud()) {
          try { await API.req('/tournaments/' + state.cloud.id, { method: 'PUT', body: { state, name: (state.name && state.name.trim()) || undefined, ranked: state.ranked } }); }
          catch (e) { if (window.showToast) showToast('No se pudo cambiar el modo: ' + e.message, true); }
        }
        syncTournamentFields();   // ranked off → hide the Elo-seed option
      });
      // Elo-seed (#39): seeds the 1st round by Elo (ranked only). Lives in state_json
      // (no column), so a plain save() syncs it. Locked once the event starts.
      const eloEl = document.getElementById('tournament-elo-seed');
      if (eloEl) eloEl.addEventListener('change', () => {
        if (state.started) { eloEl.checked = state.eloSeed === true; return; }
        state.eloSeed = eloEl.checked; save();
      });
    }
    syncTournamentFields();
  }
  function syncTournamentFields() {
    const nameEl = document.getElementById('tournament-name');
    const dateEl = document.getElementById('tournament-date');
    const rankedEl = document.getElementById('tournament-ranked');
    if (nameEl && document.activeElement !== nameEl) {
      nameEl.value = state.name || '';
      nameEl.placeholder = 'Torneo - ' + ddmmyyyy(todayISO());
    }
    if (dateEl && document.activeElement !== dateEl) dateEl.value = state.eventDate || todayISO();
    if (rankedEl) {
      const casual = isCasual();                        // casual organizers can't run ranked events
      rankedEl.checked = casual ? false : (state.ranked !== false); // default ranked
      rankedEl.disabled = casual || !!state.started;    // can't reclassify after it starts (or ever, if casual)
      const lbl = document.getElementById('ranked-label');
      if (lbl) {
        lbl.style.opacity = (casual || state.started) ? '0.55' : '';
        lbl.title = casual
          ? 'Tu cuenta de organizador casual solo crea torneos que no afectan el Elo.'
          : 'Si lo desactivas, las partidas no afectan el Elo (modo casual). Solo se puede cambiar antes de iniciar.';
      }
    }
    // Elo-seed option: only meaningful on ranked events (#39).
    const eloWrap = document.getElementById('elo-seed-wrap');
    const eloEl = document.getElementById('tournament-elo-seed');
    const rankedNow = !isCasual() && state.ranked !== false;
    if (eloWrap) eloWrap.hidden = !rankedNow;
    if (eloEl) { eloEl.checked = state.eloSeed === true; eloEl.disabled = !!state.started; }
  }

  // Publish reads the already-filled Registro fields — no extra form. Empty name →
  // "Torneo - DD/MM/YYYY"; date defaults to today.
  async function publish() {
    if (!hasSession()) { showGate(); return; }
    const nameEl = document.getElementById('tournament-name');
    const dateEl = document.getElementById('tournament-date');
    const date = (dateEl && dateEl.value) || todayISO();
    const typed = nameEl ? nameEl.value.trim() : '';
    const name = typed || ('Torneo - ' + ddmmyyyy(date));
    const rankedEl = document.getElementById('tournament-ranked');
    const ranked = rankedEl ? rankedEl.checked : true;
    try {
      const r = await API.req('/tournaments', { method: 'POST', body: { name, ranked } });
      state.cloud = { id: r.id, code: r.join_code };
      state.name = typed;              // live name (empty → /u/ falls back to stored name)
      state.eventDate = date;          // planned event date, travels in state_json
      state.ranked = r.ranked !== false; // authoritative from the server
      save();                          // local + first cloud push (wrapped)
      startRegPoll();
      renderAccount();
      showCodeModal(r.join_code);
    } catch (e) {
      if (window.showToast) showToast('No se pudo publicar: ' + e.message, true);
    }
  }

  // Pull self-registrations and absorb them (single-writer: the TO writes state,
  // players only register). Runs during setup AND while the event is running with
  // rounds left — the latter absorbs newcomers as LATE ENTRIES.
  const lateOpen = () => isCloud() && state.started && !state.finished && (state.rounds || []).length < state.maxRounds;
  const regWindowOpen = () => isCloud() && !state.finished && (!state.started || lateOpen()); // when self-registrations are absorbed
  const cloudPollActive = () => isCloud() && !state.finished;                                  // poll through setup AND running (the latter absorbs result reports)
  function startRegPoll() {
    stopRegPoll();
    if (!cloudPollActive()) return;
    regPollTimer = setInterval(cloudPollTick, 4000);
    cloudPollTick();
  }
  function stopRegPoll() { if (regPollTimer) { clearInterval(regPollTimer); regPollTimer = null; } }
  function cloudPollTick() {
    if (!cloudPollActive()) { stopRegPoll(); return; }
    if (regWindowOpen()) absorbRegistrations();
    if (state.started && !state.finished) absorbReports();
  }
  // Late entry (official rule): the player joins a running event with a loss for
  // each round already generated, then gets paired from the next round. Uses the
  // registration's player_id so the player's /me poll matches their slot.
  function addLatePlayerFromReg(r) {
    const mkid = window.uid || (() => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7));
    const player = { id: r.player_id, name: r.display_name, dropped: false, hasReceivedBye: false, lateEntry: true, userId: r.user_id || null };
    for (const round of (state.rounds || [])) {
      round.matches.push({ id: mkid(), p1Id: player.id, p2Id: null, result: 'lateLoss', isBye: false, isReported: true, isLateLoss: true });
    }
    state.players.push(player);
  }
  // A player whose id was minted by a /join registration: account `u<id>-<b36>`
  // or guest `g-<hex8>-<b36>` (see tournaments.js /join). A TO-added MANUAL player
  // has a uid() UUID and NO registrations row — so this shape is what lets us
  // reconcile registration deletions without ever touching manual players.
  const isRegOriginId = (id) => /^u\d+-[a-z0-9]+$/i.test(id) || /^g-[0-9a-f]{8}-[a-z0-9]+$/i.test(id);

  // ---- #39 Elo-seed matchmaking -----------------------------------------
  // app.js calls window.shuffle ONLY to seed the FIRST round (later rounds sort by
  // standings; pairBacktrack handles no-rematch). When the per-tournament Elo-seed
  // setting is on (ranked only) we replace that coin-flip with an Elo-ordered seed:
  // sort by rating but with a ±MARGIN jitter, so near-equal players don't always
  // meet their exact neighbour (the TO wanted a band, not a fixed ladder). Clear
  // favourites still sit on top; early-season ratings (all ~base) stay near-random.
  // No other pairing behaviour changes. _eloByUser is refreshed from each /registrations
  // poll (account user_id → current-season rating); unrated/guest/manual → base.
  const _eloByUser = new Map();
  const ELO_SEED_BASE = 1200, ELO_SEED_MARGIN = 40;
  const eloSeedActive = () => typeof state !== 'undefined' && state && state.eloSeed === true && state.ranked !== false && _eloByUser.size > 0;
  if (typeof window.shuffle === 'function' && !window.shuffle._eloPatched) {
    const orig = window.shuffle;
    window.shuffle = function (arr) {
      if (eloSeedActive() && Array.isArray(arr) && arr.length > 1) {
        return arr
          .map((p) => ({ p, k: ((p && p.userId != null && _eloByUser.has(p.userId)) ? _eloByUser.get(p.userId) : ELO_SEED_BASE) + (Math.random() * 2 - 1) * ELO_SEED_MARGIN }))
          .sort((a, b) => b.k - a.k)
          .map((x) => x.p);
      }
      return orig.apply(this, arguments);
    };
    window.shuffle._eloPatched = true;
  }

  async function absorbRegistrations() {
    if (!regWindowOpen()) return;
    try {
      const regs = await API.req('/tournaments/' + state.cloud.id + '/registrations');
      for (const r of regs) { if (r.user_id != null && typeof r.rating === 'number') _eloByUser.set(r.user_id, r.rating); } // keep Elo-seed map fresh (#39)
      const removed = (state.cloud && state.cloud.removed) || [];
      const late = !!state.started; // running → newcomers enter as late entries
      let n = 0;
      for (const r of regs) {
        // Skip registrations the TO removed via "Eliminar": absorbing them again
        // would resurrect a no-show right after the TO took them out.
        if (removed.includes(r.player_id)) continue;
        if (state.players.some((p) => p.id === r.player_id)) continue;
        if (late) addLatePlayerFromReg(r);
        else state.players.push({ id: r.player_id, name: r.display_name, dropped: false, hasReceivedBye: false, userId: r.user_id || null });
        n++;
      }
      // Reconcile DELETIONS (setup only): a registration removed externally (admin
      // tool / DB) is gone from `regs`, but its absorbed player lingers in
      // state.players. Drop it — but ONLY a registration-origin id (manual uid()
      // players have no row and must stay) and ONLY before the event starts, where
      // the roster is just state.players (during a running event the player may be
      // in generated rounds; that removal is the TO's explicit call, left alone).
      let removedN = 0;
      if (!state.started) {
        const live = new Set(regs.map((r) => r.player_id));
        const before = state.players.length;
        state.players = state.players.filter((p) => !(isRegOriginId(p.id) && !live.has(p.id)));
        removedN = before - state.players.length;
      }
      if (n || removedN) {
        save();
        if (window.render) render();
        if (n && window.showToast) showToast(late
          ? n + (n === 1 ? ' jugador entró tarde (derrota por ronda jugada).' : ' jugadores entraron tarde (derrota por ronda jugada).')
          : n + (n === 1 ? ' jugador se inscribió.' : ' jugadores se inscribieron.'));
        if (removedN && window.showToast) showToast(removedN === 1
          ? 'Se quitó 1 jugador cuya inscripción fue eliminada.'
          : 'Se quitaron ' + removedN + ' jugadores cuyas inscripciones fueron eliminadas.');
      }
    } catch (e) { /* ignore transient poll errors */ }
  }

  // Absorb player-confirmed results into state_json (single-writer: players file a
  // result + confirm it; the TO is the only writer, so we apply confirmed reports to
  // the matching matches here — mirroring app.js reportResult — then delete them.
  async function absorbReports() {
    try {
      const reports = await API.req('/tournaments/' + state.cloud.id + '/reports');
      if (!reports || !reports.length) return;
      let applied = 0;
      const resolved = []; // report ids whose result is now in `state` (apply or already there)
      for (const rep of reports) {
        const round = (state.rounds || []).find((r) => r.roundNumber === rep.round_number);
        const m = round && (round.matches || []).find((x) => x.p2Id && [x.p1Id, x.p2Id].slice().sort().join('|') === rep.match_key);
        if (!m || m.isBye || m.isLateLoss) continue; // unknown / non-reportable → leave the report alone
        if (!m.isReported) {
          m.result = rep.result;   // 'p1' | 'p2' | 'doubleLoss' (same fields app.js's reportResult sets)
          m.isReported = true;
          applied++;
        }
        resolved.push(rep.id);
      }
      if (!resolved.length) return;
      // PERSIST FIRST, DELETE AFTER: only remove a report once the state carrying its
      // result is saved on the server. Deleting before a successful PUT could lose a
      // confirmed result for good (gone from result_reports AND not in state_json).
      save(); // local cache
      try {
        await API.req('/tournaments/' + state.cloud.id, { method: 'PUT', body: { state, name: (state.name && state.name.trim()) || undefined } });
      } catch (e) {
        return; // PUT failed → keep the reports; the next poll tick retries (idempotent)
      }
      for (const id of resolved) { try { await API.req('/tournaments/' + state.cloud.id + '/reports/' + id, { method: 'DELETE' }); } catch (e) {} }
      if (applied) {
        if (window.render) render();
        if (window.showToast) showToast(applied === 1 ? 'Resultado confirmado por los jugadores aplicado.' : applied + ' resultados de jugadores aplicados.');
      }
    } catch (e) { /* ignore transient poll errors */ }
  }

  function showCodeModal(code) {
    if (document.getElementById('code-modal')) return;
    const url = location.origin + '/u/?torneo=' + code;
    const m = document.createElement('div');
    m.className = 'modal-overlay'; m.id = 'code-modal';
    m.innerHTML = `
      <div class="modal" style="max-width:400px;text-align:center">
        <h3 class="modal-title">Torneo publicado</h3>
        <p class="modal-msg" style="margin-bottom:8px">Comparte el enlace, o el código para entrar en <b>${location.host}/u</b>:</p>
        <div style="font-family:var(--mono);font-size:42px;font-weight:800;letter-spacing:8px;color:var(--gold);margin:4px 0 14px">${code}</div>
        <div class="modal-actions" style="justify-content:center;gap:8px">
          <button class="btn btn-gold" id="code-copy">📋 Copiar enlace</button>
          <button class="btn btn-ghost" data-close>Listo</button></div>
      </div>`;
    document.body.appendChild(m);
    requestAnimationFrame(() => m.classList.add('open'));
    const close = () => { m.classList.remove('open'); setTimeout(() => m.remove(), 200); };
    m.querySelector('#code-copy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(url); if (window.showToast) showToast('Enlace copiado'); }
      catch { if (window.showToast) showToast(url); }
      close(); // copying confirms + dismisses, like "Listo"
    });
    m.addEventListener('click', (e) => {
      if (e.target === m || e.target.closest('[data-close]')) close();
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
        <button class="btn btn-ghost btn-sm" id="gate-forgot" type="button" style="width:100%;margin-top:8px;font-size:12.5px">¿Olvidaste tu contraseña?</button>
        <button class="btn btn-ghost btn-sm" id="gate-guest" type="button" style="width:100%;margin-top:8px">Ingresar como invitado</button>
      </div>`;
    document.body.appendChild(g);
    requestAnimationFrame(() => g.classList.add('open')); // play the modal open animation

    const tabs = g.querySelector('#gate-tabs');
    tabs.addEventListener('click', (e) => {
      const t = e.target.closest('[data-gt]'); if (!t) return;
      setMode(t.dataset.gt, g, true);
    });
    g.querySelector('#gate-form').addEventListener('submit', (e) => { e.preventDefault(); submit(g); });
    g.querySelector('#gate-forgot').addEventListener('click', () => showResetModal(g.querySelector('#gate-email').value.trim()));
    g.querySelector('#gate-guest').addEventListener('click', () => { setGuest(true); renderAccount(); applyView(); });
    // Deep link: /#crear (e.g. from the /u/ "Crear cuenta" prompt on a ranked event)
    // opens straight on the register tab; otherwise default to sign-in.
    const wantRegister = /^#(crear|register|signup)$/i.test(location.hash || '');
    setMode(wantRegister ? 'register' : 'login', g, false);
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
    g.querySelector('#gate-forgot').hidden = m !== 'login'; // reset only makes sense from the login tab
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

  // Self-service password reset: email → 6-digit code + new password. /auth/forgot
  // always 200s (no enumeration), so step 1 always advances to step 2.
  function showResetModal(prefillEmail) {
    const m = makeModal(400);
    m.body.innerHTML = `
      <h3 class="modal-title">Restablecer contraseña</h3>
      <p class="modal-msg" id="rs-msg" style="margin-bottom:14px">Te enviaremos un código de 6 dígitos al correo de tu cuenta.</p>
      <div class="gate-field"><label>Correo</label><input type="text" id="rs-email" autocomplete="email" autocapitalize="none" spellcheck="false" value="${esc(prefillEmail || '')}"></div>
      <div id="rs-step2" hidden>
        <div class="gate-field"><label>Código (6 dígitos)</label><input type="text" id="rs-code" inputmode="numeric" maxlength="6" autocomplete="one-time-code" style="font-family:var(--mono);letter-spacing:6px;text-align:center"></div>
        <div class="gate-field"><label>Nueva contraseña</label><input type="password" id="rs-pass" autocomplete="new-password"></div>
      </div>
      <div class="gate-error" id="rs-error"></div>
      <button class="btn btn-gold" id="rs-go" type="button" style="width:100%">Enviar código</button>
      <button class="btn btn-ghost btn-sm" data-close type="button" style="width:100%;margin-top:8px">Cancelar</button>`;
    let step = 1;
    const err = m.body.querySelector('#rs-error');
    const go = m.body.querySelector('#rs-go');
    go.addEventListener('click', async () => {
      err.textContent = '';
      const email = m.body.querySelector('#rs-email').value.trim();
      if (step === 1) {
        if (!email) { err.textContent = 'Escribe tu correo.'; return; }
        go.disabled = true;
        try { await API.req('/auth/forgot', { method: 'POST', auth: false, body: { email } }); } catch (e) { /* never reveal — advance anyway */ }
        go.disabled = false;
        step = 2;
        m.body.querySelector('#rs-step2').hidden = false;
        m.body.querySelector('#rs-msg').textContent = 'Si el correo está registrado, te enviamos un código (vence en 15 min). Escríbelo y tu nueva contraseña.';
        m.body.querySelector('#rs-email').setAttribute('readonly', '');
        go.textContent = 'Restablecer';
        m.body.querySelector('#rs-code').focus();
      } else {
        const code = m.body.querySelector('#rs-code').value.trim();
        const pass = m.body.querySelector('#rs-pass').value;
        if (code.length !== 6) { err.textContent = 'El código tiene 6 dígitos.'; return; }
        if (pass.length < 6) { err.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
        go.disabled = true;
        try {
          await API.req('/auth/reset', { method: 'POST', auth: false, body: { email, code, password: pass } });
          m.body.innerHTML = '<h3 class="modal-title">¡Listo!</h3><p class="modal-msg" style="margin:8px 0 14px">Tu contraseña se actualizó. Ya puedes iniciar sesión.</p><button class="btn btn-gold" data-close type="button" style="width:100%">Iniciar sesión</button>';
        } catch (e) {
          err.textContent = e.message || 'No se pudo restablecer.';
          go.disabled = false;
        }
      }
    });
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
    if (hasSession() && isOrganizer()) {       // organizer (official or casual) → console
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
    syncTournamentFields(); // lock the "ranked" toggle now that the event has started
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
    const msg = 'Se borrarán los cambios locales no guardados (jugadores, rondas y configuración). El torneo publicado en el servidor permanecerá sin cambios. Esta acción no se puede deshacer.';
    const reset = async () => {
      stopRegPoll();
      state = window.emptyState ? window.emptyState() : {};
      roundsManuallySet = false;
      save(); // no cloud now → local only, which is correct
      if (window.switchTab) switchTab('registro');
      if (window.render) render();
      renderAccount();
      syncTournamentFields();        // clear name, reset date to today
    };
    if (window.openConfirm) openConfirm(msg, reset, { title: 'Nuevo Torneo', confirmText: 'Sí, reiniciar', danger: true });
    else reset();
  }, true);

  // Single source of truth for the shareable image: route the console's live
  // Compartir/Descargar (bound in app.js) through StandingsImage too. app.js calls
  // buildStandingsImageBlob() by name, so reassigning the global redirects its
  // handlers — the format lives in ONE place (js/standings-image.js), shared with
  // the results-view "Compartir" above.
  if (window.StandingsImage) {
    window.buildStandingsImageBlob = function () {
      const ordered = window.finalStandings ? finalStandings() : [];
      return StandingsImage.build({
        standings: ordered.map((s) => ({ name: s.name, matchPoints: s.matchPoints, wins: s.wins, losses: s.losses, dropped: !!s.dropped })),
        finished: !!state.finished, maxRounds: state.maxRounds, currentRound: state.currentRound, note: state.note || '',
        date: state.eventDate ? new Date(state.eventDate + 'T00:00:00') : undefined,
      });
    };
  }

  // Surface the live registrant count next to the rounds field — that's what
  // actually informs the rounds choice ("we're N players, how many rounds?"), so
  // it's more useful there than in the section title (whose count we hide in CSS).
  // app.js rebuilds the title (with its count) and calls renderRegistro() by name,
  // so wrap the global to refresh our count on every render.
  function syncRoundsCount() {
    const el = document.getElementById('rounds-count');
    if (!el) return;
    const n = (typeof state !== 'undefined' && state && state.players) ? state.players.length : 0;
    el.innerHTML = n ? '<b>' + n + '</b> ' + (n === 1 ? 'inscrito' : 'inscritos') : '';
  }
  if (typeof renderRegistro === 'function') {
    const _renderRegistro = renderRegistro;
    window.renderRegistro = function () { const r = _renderRegistro.apply(this, arguments); syncRoundsCount(); return r; };
  }

  /* ---- Proyección de tienda: pairings + resultados en vivo (#129) ---------
     app.js abre una pestaña de solo-timer (openTimerWindow) y la alimenta una
     vez por segundo vía _pushTimerWin(). Aquí se reemplaza por un layout para
     TV: lista única de pairings de la ronda actual a la izquierda (ganador ✓,
     doble derrota ✗, BYE; auto-scroll lento si no caben) y el reloj a la
     derecha. Sin torneo en curso vuelve al timer centrado de siempre y la
     pantalla de campeón se conserva. #timer-popout quedó vinculado por
     referencia, así que su click se intercepta en fase de captura;
     _pushTimerWin sí se llama por nombre, por lo que reasignar el global
     basta para tomar el feed de datos. */

  function projectionPayload() {
    const t = _timer();
    const payload = {
      endsAt: t.endsAt, pausedMs: t.pausedMs, durationMin: t.durationMin || 50,
      title: roundTitleText(), finished: !!state.finished, standings: null, pairings: null
    };
    if (state.finished) {
      payload.standings = finalStandings().map(s => ({
        name: s.name, pts: s.matchPoints, wl: s.wins + '-' + s.losses, dropped: !!s.dropped
      }));
    } else if (state.started) {
      const round = currentRoundObj();
      if (round) {
        const rows = [];
        let mesa = 0;
        for (const m of round.matches) {
          mesa++;                     // espeja la numeración "Mesa N" del console (el BYE consume número)
          if (m.isLateLoss) continue; // fila sintética de late entry: no es una mesa física
          rows.push({
            t: mesa,
            p1: playerNameById(m.p1Id),
            p2: m.isBye ? null : playerNameById(m.p2Id),
            result: m.result || null  // 'p1' | 'p2' | 'doubleLoss' | null
          });
        }
        if (rows.length) payload.pairings = rows;
      }
    }
    return payload;
  }

  window._pushTimerWin = function () {
    if (!_timerWin || _timerWin.closed) return;
    try {
      if (typeof _timerWin.applyState === 'function') _timerWin.applyState(projectionPayload());
    } catch (e) { /* ventana cerrada o sin acceso */ }
  };

  // El tema de app.js solo copia bg/ink/accent/over/line; el layout de pairings
  // usa más colores de la paleta, así que se extiende la misma función.
  const _origTimerWinTheme = window._applyTimerWinTheme;
  window._applyTimerWinTheme = function () {
    _origTimerWinTheme.apply(this, arguments);
    if (!_timerWin || _timerWin.closed) return;
    try {
      const cs = getComputedStyle(document.documentElement);
      const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
      const root = _timerWin.document.documentElement.style;
      root.setProperty('--pp-panel', v('--panel', '#211f35'));
      root.setProperty('--pp-field', v('--field-bg', '#1a1829'));
      root.setProperty('--pp-green', v('--green', '#57ab5a'));
      root.setProperty('--pp-soft', v('--ink-soft', '#a7adc2'));
      root.setProperty('--pp-faint', v('--ink-faint', '#767089'));
    } catch (e) { /* sin acceso */ }
  };

  function openProjectionWindow() {
    if (_timerWin && !_timerWin.closed) { _timerWin.focus(); return; }
    const w = window.open('', 'ygoTimerWindow');
    if (!w) { showToast('El navegador bloqueó la pestaña. Permite pop-ups para proyectar el timer.', true); return; }
    w.document.open();
    w.document.write(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Timer · SwissYGO</title><style>
    :root{--pp-bg:#14131f;--pp-panel:#211f35;--pp-ink:#eef1f7;--pp-soft:#a7adc2;--pp-faint:#767089;--pp-accent:#82d8eb;--pp-over:#e5534b;--pp-green:#57ab5a;--pp-line:#443f5d;--pp-field:#1a1829;}
    *{margin:0;padding:0;box-sizing:border-box;}
    html,body{height:100%;width:100%;}
    body{background:var(--pp-bg);color:var(--pp-ink);font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;display:flex;overflow:hidden;transition:background .2s,color .2s;}
    /* Pairings (izquierda): lista única, una mesa por fila. */
    #pair-pane{width:66%;display:flex;flex-direction:column;padding:2.8vh 1.8vw 2vh;min-width:0;border-right:1px solid var(--pp-line);}
    #pair-title{font-size:min(3.8vh,2.2vw);font-weight:800;color:var(--pp-soft);letter-spacing:4px;text-transform:uppercase;margin-bottom:1.8vh;}
    #pair-scroll{flex:1;overflow:hidden;min-height:0;}
    #pair-list{display:flex;flex-direction:column;gap:1.4vh;}
    .pm{flex:none;height:12.5vh;display:flex;align-items:center;gap:1vw;background:var(--pp-panel);border:1px solid var(--pp-line);border-radius:1.4vh;padding:0 1.2vw;min-width:0;}
    .pm .tno{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:700;color:var(--pp-accent);font-size:min(5vh,2.8vw);min-width:1.9em;text-align:center;background:var(--pp-field);border-radius:1vh;padding:.6vh 0;flex:none;}
    .pm .side{flex:1;display:flex;align-items:center;gap:.6vw;min-width:0;font-size:min(7.5vh,4.2vw);font-weight:700;}
    .pm .side.right{flex-direction:row-reverse;text-align:right;}
    .pm .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
    .pm .vs{color:var(--pp-faint);font-size:min(3.4vh,1.9vw);font-weight:800;letter-spacing:1px;flex:none;}
    .pm .mark{width:1.1em;text-align:center;flex:none;font-weight:800;font-size:min(6vh,3.2vw);}
    .pm .side.win{color:var(--pp-green);}
    .pm .side.lose{color:var(--pp-faint);}
    .pm .side.dl{color:var(--pp-over);}
    .pm.done{border-color:color-mix(in srgb, var(--pp-green) 45%, var(--pp-line));}
    .pm.dl{border-color:color-mix(in srgb, var(--pp-over) 45%, var(--pp-line));}
    .pm .bye{font-size:min(3.4vh,1.9vw);font-weight:800;letter-spacing:2px;color:var(--pp-accent);background:var(--pp-field);border:1px solid var(--pp-line);border-radius:1vh;padding:.8vh .8vw;flex:none;}
    /* Reloj (derecha). */
    #clock-pane{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2.4vh;padding:0 1.5vw;}
    #big-round{font-size:min(6.5vh,4vw);font-weight:700;color:var(--pp-accent);letter-spacing:1px;text-align:center;}
    #big-time{font-size:min(19vh,10vw);font-weight:800;line-height:.95;font-variant-numeric:tabular-nums;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
    #big-time.over{color:var(--pp-over);}
    #big-sub{font-size:min(4.5vh,3vw);color:var(--pp-over);font-weight:800;height:1.15em;letter-spacing:3px;}
    #rep-count{font-size:min(3.4vh,2vw);color:var(--pp-soft);font-weight:600;min-height:1.2em;}
    #rep-count b{color:var(--pp-accent);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;}
    /* Sin pairings: timer centrado a pantalla completa (comportamiento previo). */
    body.solo #pair-pane{display:none;}
    body.solo #big-round{font-size:min(9vh,9vw);}
    body.solo #big-time{font-size:min(50vh,34vw);}
    body.solo #big-sub{font-size:min(6vh,7vw);}
    /* Campeón (torneo finalizado). */
    body.champ #pair-pane,body.champ #clock-pane{display:none;}
    #champ-screen{display:none;flex-direction:column;align-items:center;justify-content:center;gap:2.2vh;width:100%;padding:0 4vw;}
    body.champ #champ-screen{display:flex;}
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
  </style></head><body class="solo">
    <div id="pair-pane">
      <div id="pair-title">Pairings</div>
      <div id="pair-scroll"><div id="pair-list"></div></div>
    </div>
    <div id="clock-pane">
      <div id="big-round">Ronda —</div>
      <div id="big-time">00:00</div>
      <div id="big-sub"></div>
      <div id="rep-count"></div>
    </div>
    <div id="champ-screen">
      <div id="champ-label">🏆 CAMPEÓN</div>
      <div id="champ-name"></div>
      <div id="champ-list"></div>
    </div>
    <button id="fs-btn" onclick="if(document.fullscreenElement){document.exitFullscreen();}else if(document.documentElement.requestFullscreen){document.documentElement.requestFullscreen();}">⛶ Pantalla completa</button>
    <script>
      (function(){
        var S = { endsAt:null, pausedMs:null, durationMin:50, title:'SwissYGO', finished:false, standings:null, pairings:null };
        var MAX_ROWS = 8; // filas visibles después del campeón
        function fmt(ms){ var tot=Math.ceil(ms/1000), m=Math.floor(tot/60), s=tot%60; return (m<10?'0'+m:m)+':'+(s<10?'0'+s:s); }
        function remaining(){ if(S.endsAt) return Math.max(0, S.endsAt - Date.now()); if(S.pausedMs!=null) return S.pausedMs; return (S.durationMin||50)*60000; }
        function champMode(){ return !!(S.finished && S.standings && S.standings.length); }
        function pairMode(){ return !champMode() && !!(S.pairings && S.pairings.length); }
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
        /* Lado de una mesa (nombre + marca ✓/✗). También SIEMPRE vía textContent. */
        function buildSide(name, isP1, result){
          var win  = result === (isP1 ? 'p1' : 'p2');
          var lose = (result === 'p1' || result === 'p2') && !win;
          var dl   = result === 'doubleLoss';
          var s = document.createElement('span');
          s.className = 'side' + (isP1 ? '' : ' right') + (dl ? ' dl' : win ? ' win' : lose ? ' lose' : '');
          var nm = document.createElement('span'); nm.className='nm'; nm.textContent = name;
          var mk = document.createElement('span'); mk.className='mark'; mk.textContent = dl ? '✗' : (win ? '✓' : '');
          s.appendChild(nm); s.appendChild(mk);
          return s;
        }
        function buildPairings(){
          var list = document.getElementById('pair-list');
          if(!list) return;
          while(list.firstChild) list.removeChild(list.firstChild);
          var rows = S.pairings || [];
          for(var i=0;i<rows.length;i++){
            var r = rows[i];
            var dl = r.result === 'doubleLoss';
            var pm = document.createElement('div');
            pm.className = 'pm' + (dl ? ' dl' : (r.result != null ? ' done' : ''));
            var tno = document.createElement('span'); tno.className='tno'; tno.textContent = r.t;
            pm.appendChild(tno);
            pm.appendChild(buildSide(r.p1, true, r.result));
            var vs = document.createElement('span'); vs.className='vs'; vs.textContent = r.p2 == null ? '' : 'VS';
            pm.appendChild(vs);
            if(r.p2 == null){
              var right = document.createElement('span'); right.className='side right';
              var bye = document.createElement('span'); bye.className='bye'; bye.textContent='BYE';
              right.appendChild(bye);
              pm.appendChild(right);
            } else {
              pm.appendChild(buildSide(r.p2, false, r.result));
            }
            list.appendChild(pm);
          }
          fitNames();
        }
        /* Cada nombre parte del tamaño grande; si no cabe en su mitad, solo ese
           nombre reduce su fuente lo justo (piso 55%) en vez de truncarse. */
        function fitNames(){
          var nms = document.querySelectorAll('.pm .nm');
          for(var i=0;i<nms.length;i++){
            var el = nms[i];
            el.style.fontSize = '';
            var base = parseFloat(getComputedStyle(el).fontSize), size = base;
            while(el.scrollWidth > el.clientWidth && size > base * 0.55){
              size -= 2;
              el.style.fontSize = size + 'px';
            }
          }
        }
        function updateMeta(){
          var pt = document.getElementById('pair-title');
          if(pt) pt.textContent = 'Pairings · ' + String(S.title || '').split(' de ')[0];
          var rc = document.getElementById('rep-count');
          if(rc){
            while(rc.firstChild) rc.removeChild(rc.firstChild);
            var rows = S.pairings || [], rep = 0;
            for(var i=0;i<rows.length;i++) if(rows[i].result != null) rep++;
            if(rows.length){
              var b = document.createElement('b'); b.textContent = rep + '/' + rows.length;
              rc.appendChild(b);
              rc.appendChild(document.createTextNode(' mesas reportadas'));
            }
          }
        }
        function render(){
          var champ = champMode(), pairs = pairMode();
          document.body.className = champ ? 'champ' : (pairs ? '' : 'solo');
          if(champ) return; // la corona no necesita el tick del reloj
          var active = !!S.endsAt || S.pausedMs!=null;
          var ms = remaining();
          var over = ms<=0 && active;
          var bt = document.getElementById('big-time');
          if(bt){ bt.textContent = fmt(ms); bt.classList.toggle('over', over); }
          var br = document.getElementById('big-round'); if(br) br.textContent = S.title || 'SwissYGO';
          var bs = document.getElementById('big-sub');  if(bs) bs.textContent = over ? '¡TIEMPO!' : '';
        }
        /* Auto-scroll: si la lista desborda, baja lento, pausa en cada extremo,
           sube y repite. La posición vive fuera del rebuild para no saltar al
           reportarse una mesa; si la lista se acorta se re-clampa sola. */
        var _dir = 1, _pos = 0, _pausedUntil = 0, _last = null;
        var SCROLL_PX_S = 40, SCROLL_PAUSE_MS = 2200;
        function scrollTick(ts){
          var box = document.getElementById('pair-scroll');
          if(box){
            if(_last == null) _last = ts;
            var dt = (ts - _last) / 1000; _last = ts;
            var max = box.scrollHeight - box.clientHeight;
            if(pairMode() && max > 4 && ts >= _pausedUntil){
              _pos = Math.max(0, Math.min(max, _pos + _dir * SCROLL_PX_S * dt));
              if(_pos <= 0 || _pos >= max){ _dir = -_dir; _pausedUntil = ts + SCROLL_PAUSE_MS; }
              box.scrollTop = _pos;
            } else if(max <= 4){
              _pos = 0; box.scrollTop = 0;
            }
          }
          requestAnimationFrame(scrollTick);
        }
        window.applyState = function(s){
          if(s) S = s;
          render(); // fija la clase del body ANTES de construir: fitNames necesita el panel visible para medir
          if(champMode()){
            // Reconstruir solo si los standings cambiaron (llega un push por segundo).
            var sig = JSON.stringify(S.standings);
            if(sig !== window.__champSig){ window.__champSig = sig; buildChamp(); }
          } else {
            window.__champSig = null;
          }
          var psig = pairMode() ? JSON.stringify(S.pairings) : null;
          if(psig !== window.__pairSig){
            window.__pairSig = psig;
            if(pairMode()) buildPairings();
            updateMeta();
          }
        };
        window.addEventListener('resize', fitNames);
        setInterval(render, 250);
        document.addEventListener('visibilitychange', render);
        requestAnimationFrame(scrollTick);
        render();
      })();
    <\/script>
  </body></html>`);
    w.document.close();
    _timerWin = w;
    _applyTimerWinTheme();   // resuelve al global extendido de arriba
    _pushTimerWin();
    renderTimer();
  }

  // app.js ató #timer-popout por referencia a su openTimerWindow; captura + stop
  // para que el click abra la proyección nueva (misma ventana nombrada).
  document.addEventListener('click', function (e) {
    const btn = e.target && e.target.closest ? e.target.closest('#timer-popout') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    openProjectionWindow();
  }, true);
  window.openTimerWindow = openProjectionWindow; // por si algo más lo invoca por nombre

  // ---- boot --------------------------------------------------------------
  wrapSave();
  wireTournamentFields();   // name/date inputs in the Registro section
  syncRoundsCount();        // populate the count now (a tournament loaded from storage already rendered)
  renderAccount();
  refreshMe(); // sets role from the server then routes (applyView); falls back to stored role offline
})();
