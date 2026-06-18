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
      if (isCloud() && isTO()) startRegPoll(); // self-gates (setup or late-entry window)
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
      // The publish/code control lives in the file toolbar (see mountToolbarCloudBtn),
      // so the header only carries the account + "Torneos" panel.
      const cloud = isTO() ? `<button class="btn btn-sm" data-acc="panel" title="Administrar cualquier torneo">Torneos</button>` : '';
      ctl.innerHTML = `<span class="who">Hola, <b class="uname"></b></span>${cloud}<button class="btn btn-sm btn-ghost" data-acc="logout">Salir</button>`;
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
    if (!(hasSession() && isTO())) { if (btn) btn.remove(); return; }
    if (!btn) {
      btn = document.createElement('button');
      btn.id = 'toolbar-publish'; btn.type = 'button';
      tb.insertBefore(btn, tb.querySelector('.spacer') || tb.querySelector('#reset-all')); // group with the utilities, left of the spacer (keeps destructive "Nuevo Torneo" apart)
    }
    if (isCloud()) {
      btn.className = 'btn btn-sm';
      btn.textContent = 'Código ' + state.cloud.code;
      btn.title = 'Ver código y enlace';
      btn.onclick = () => showCodeModal(state.cloud.code);
    } else {
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
          <td><span class="pill ${t.status === 'finished' ? 'pill-ok' : 'pill-pend'}">${statusLabel(t.status)}</span></td>
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
    const open = () => {
      const base = window.emptyState ? window.emptyState() : {};
      state = Object.assign(base, t.state || {});
      state.cloud = { id: t.id, code: t.join_code };
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
    if (nameEl && dateEl && !tfWired) {
      tfWired = true;
      nameEl.addEventListener('input', () => { state.name = nameEl.value.trim(); save(); });
      dateEl.addEventListener('change', () => { state.eventDate = dateEl.value || todayISO(); save(); });
    }
    syncTournamentFields();
  }
  function syncTournamentFields() {
    const nameEl = document.getElementById('tournament-name');
    const dateEl = document.getElementById('tournament-date');
    if (nameEl && document.activeElement !== nameEl) {
      nameEl.value = state.name || '';
      nameEl.placeholder = 'Torneo - ' + ddmmyyyy(todayISO());
    }
    if (dateEl && document.activeElement !== dateEl) dateEl.value = state.eventDate || todayISO();
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
    try {
      const r = await API.req('/tournaments', { method: 'POST', body: { name } });
      state.cloud = { id: r.id, code: r.join_code };
      state.name = typed;              // live name (empty → /u/ falls back to stored name)
      state.eventDate = date;          // planned event date, travels in state_json
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
  const regPollActive = () => isCloud() && !state.finished && (!state.started || lateOpen());
  function startRegPoll() {
    stopRegPoll();
    if (!regPollActive()) return;
    regPollTimer = setInterval(absorbRegistrations, 4000);
    absorbRegistrations();
  }
  function stopRegPoll() { if (regPollTimer) { clearInterval(regPollTimer); regPollTimer = null; } }
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
  async function absorbRegistrations() {
    if (!regPollActive()) { stopRegPoll(); return; }
    try {
      const regs = await API.req('/tournaments/' + state.cloud.id + '/registrations');
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
      if (n) {
        save();
        if (window.render) render();
        if (window.showToast) showToast(late
          ? n + (n === 1 ? ' jugador entró tarde (derrota por ronda jugada).' : ' jugadores entraron tarde (derrota por ronda jugada).')
          : n + (n === 1 ? ' jugador se inscribió.' : ' jugadores se inscribieron.'));
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

  // ---- boot --------------------------------------------------------------
  wrapSave();
  wireTournamentFields();   // name/date inputs in the Registro section
  syncRoundsCount();        // populate the count now (a tournament loaded from storage already rendered)
  renderAccount();
  refreshMe(); // sets role from the server then routes (applyView); falls back to stored role offline
})();
