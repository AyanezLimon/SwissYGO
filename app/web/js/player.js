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

  const loggedIn = () => !!API.token.get();
  // Account data lives in localStorage (survives a browser close); guest data in
  // sessionStorage (persists across reloads, dies when the browser closes).
  const store = () => (loggedIn() ? localStorage : sessionStorage);
  const joined = () => { try { return JSON.parse(store().getItem(LS_JOINED) || 'null'); } catch { return null; } };
  const setJoined = (v) => { try { v ? store().setItem(LS_JOINED, JSON.stringify(v)) : store().removeItem(LS_JOINED); } catch {} };
  // A guest's display name: auto-generated once, kept for the whole session.
  const guestName = () => {
    try { let n = sessionStorage.getItem('ygo_guest_name'); if (!n) { n = randomName(); sessionStorage.setItem('ygo_guest_name', n); } return n; }
    catch { return randomName(); }
  };

  let pollTimer = null;
  const uname = () => { try { return localStorage.getItem('ygo_username') || ''; } catch { return ''; } };
  const fmtDate = (s) => String(s || '').replace('T', ' ').slice(0, 16);

  // ---- join screen -------------------------------------------------------
  function renderJoin(err, codePrefill) {
    stopPoll();
    root.classList.remove('results');
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
        ${logged ? '' : `<div class="gate-field"><label>Tu nombre (invitado)</label><input type="text" id="gname" maxlength="40" value="${esc(guestName())}"></div>`}
        <div id="active"><p class="muted" style="font-size:13px">Cargando torneos…</p></div>
        <div class="gate-field" style="margin-top:14px">
          <label>¿Tienes un código?</label>
          <input type="text" id="code" maxlength="5" autocapitalize="characters" autocomplete="off" spellcheck="false"
                 value="${esc(codePrefill || '')}" style="text-transform:uppercase;font-family:var(--mono);font-size:20px;letter-spacing:4px;text-align:center">
        </div>
        <div class="gate-error" id="perr">${err ? esc(err) : ''}</div>
        <button class="btn btn-gold" id="join" type="button" style="width:100%">Unirme con código</button>
        ${logged ? '<button class="btn btn-sm btn-ghost" id="hist" type="button" style="width:100%;margin-top:10px">Mi perfil</button>' : ''}
      </div>`;

    $('#join').addEventListener('click', () => doJoin($('#code').value));
    $('#code').addEventListener('keyup', (e) => { if (e.key === 'Enter') doJoin($('#code').value); });
    const lo = $('#logout'); if (lo) lo.addEventListener('click', () => { API.token.clear(); try { localStorage.removeItem('ygo_username'); localStorage.removeItem(LS_JOINED); } catch {} location.href = '/'; });
    const si = $('#signin'); if (si) si.addEventListener('click', () => { try { sessionStorage.removeItem('ygo_guest'); sessionStorage.removeItem('ygo_guest_name'); sessionStorage.removeItem(LS_JOINED); } catch {} location.href = '/'; });
    const gn = $('#gname'); if (gn) gn.addEventListener('input', () => { try { sessionStorage.setItem('ygo_guest_name', gn.value); } catch {} });
    const h = $('#hist'); if (h) h.addEventListener('click', renderProfile);
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
          <div class="muted" style="font-size:12.5px;margin-top:5px">${t.players} jugador(es) · ${esc(fmtDate(t.date || t.created_at))} · código <b style="font-family:var(--mono);letter-spacing:1px">${esc(t.code)}</b></div>
          ${t.note ? `<div class="muted" style="font-size:12.5px;margin-top:5px">${esc(t.note)}</div>` : ''}
        </div>`).join('');
      el.querySelectorAll('.tcard').forEach((c, i) => c.addEventListener('click', () => showTournamentCard(list[i])));
    } catch (e) { el.innerHTML = '<p class="muted" style="font-size:13px">No se pudo cargar la lista de torneos.</p>'; }
  }

  // Open the tournament detail card from a code (deep link /u/?torneo=CODE).
  async function openByCode(code) {
    try {
      const t = await API.req('/tournaments/by-code/' + encodeURIComponent(code), { auth: false });
      showTournamentCard(t);
    } catch (e) { renderJoin(e.status === 404 ? 'Código inválido.' : null, code); }
  }

  // Detailed tournament card — reused by the deep link and the active list. Shows
  // the event info and a "Confirmar registro" action (setup), results (finished),
  // or a closed notice (running; late entry comes in Part 3).
  function showTournamentCard(t) {
    stopPoll();
    root.classList.remove('results');
    const logged = loggedIn();
    const label = t.status === 'finished' ? 'Finalizado' : t.status === 'running' ? 'En curso' : 'Registro abierto';
    const pill = t.status === 'setup' ? 'pill-ok' : 'pill-pend';
    // Account → joins as username; guest → typed name. Shared by setup + late entry.
    const joinControls = (btnLabel) => (logged
      ? `<div class="muted" style="font-size:12.5px;margin-bottom:10px">Te inscribes como <b>${esc(uname() || 'tu cuenta')}</b></div>`
      : `<div class="gate-field"><label>Tu nombre (invitado)</label><input type="text" id="gname" maxlength="40" value="${esc(guestName())}"></div>`)
      + `<div class="gate-error" id="perr"></div><button class="btn btn-gold" id="confirm" style="width:100%">${btnLabel}</button>`;
    let action;
    if (t.status === 'setup') {
      action = joinControls('Confirmar registro');
    } else if (t.status === 'finished') {
      action = '<button class="btn btn-gold" id="results" style="width:100%">Ver resultados</button>';
    } else if (t.lateOpen) {
      // Running but rounds remain → late entry (official rule: a loss per played round).
      // t.lateOpen is the server's own gate signal — UI can't advertise a 409.
      action = `<div class="muted" style="font-size:12.5px;margin-bottom:10px">Este torneo ya comenzó (Ronda ${t.currentRound}/${t.maxRounds}). Puedes entrar como <b>entrada tardía</b>: recibes una derrota por cada ronda ya jugada y te emparejan desde la próxima.</div>`
        + joinControls('Entrar como entrada tardía');
    } else {
      action = '<div class="muted" style="font-size:13px;text-align:center;padding:6px 0">El registro cerró y no quedan rondas por jugar.</div>';
    }
    const meta = `${t.date ? esc(fmtDate(t.date)) + ' · ' : ''}${t.players} jugador(es)`
      + `${t.status === 'running' ? ` · Ronda ${t.currentRound}/${t.maxRounds}` : ''}`
      + ` · código <b style="font-family:var(--mono);letter-spacing:1px">${esc(t.code)}</b>`;
    root.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:flex-start;gap:10px">
          <h2 style="margin:0">${esc(t.name)}</h2>
          <span class="pill ${pill}">${label}</span>
        </div>
        <div class="muted" style="font-size:12.5px;margin:6px 0 12px">${meta}</div>
        ${t.note ? `<div style="background:var(--field-bg);border:1px solid var(--border-2);border-radius:10px;padding:10px 12px;font-size:13px;color:var(--ink-soft);white-space:pre-wrap">${esc(t.note)}</div>` : ''}
        <div style="margin-top:14px">${action}</div>
        <button class="btn btn-sm btn-ghost" id="back" style="width:100%;margin-top:10px">← Volver</button>
      </div>`;
    const c = $('#confirm'); if (c) c.addEventListener('click', () => doJoin(t.code));
    const rs = $('#results'); if (rs) rs.addEventListener('click', () => showResults(t.id, null, () => showTournamentCard(t)));
    $('#back').addEventListener('click', () => renderJoin());
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
        // name = OUR display name (account username), NOT res.name (the tournament).
        setJoined({ id: res.id, name: res.display_name || uname(), guestToken: null });
      } else {
        const name = ($('#gname') && $('#gname').value.trim()) || guestName();
        try { sessionStorage.setItem('ygo_guest_name', name); } catch {}
        res = await API.req('/tournaments/join', { method: 'POST', auth: false, body: { code, name } });
        setJoined({ id: res.id, name: res.display_name || name, guestToken: res.guest_token });
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

  // /public → the shared StandingsImage renderer's data shape (only built when the
  // player chooses to share — the view itself is the HTML table).
  function publicToImageData(pub) {
    return {
      standings: (pub.standings || []).map((s) => ({ name: s.name, matchPoints: s.points, wins: s.wins, losses: s.losses, dropped: !!s.dropped })),
      finished: pub.status === 'finished',
      maxRounds: pub.maxRounds, currentRound: pub.currentRound, note: pub.note || '',
      date: pub.finished_at ? new Date(String(pub.finished_at).replace(' ', 'T') + 'Z') : new Date(),
    };
  }
  async function shareResultsImage(pub, btn) {
    if (!window.StandingsImage) return;
    if (btn) btn.disabled = true;
    try {
      const img = await StandingsImage.build(publicToImageData(pub));
      if (navigator.canShare && navigator.canShare({ files: [img.file] })) {
        try { await navigator.share({ files: [img.file], title: 'Resultados · Velvet Room' }); return; }
        catch (e) { if (e && e.name === 'AbortError') return; }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(img.blob); a.download = img.fname;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    } catch (e) { /* best-effort; stay on the results view */ }
    finally { if (btn) btn.disabled = false; }
  }

  // Results = the WEB VIEW: the HTML card identical to the shareable image.
  // A small caption above shows the player's own placement (the card mirrors the
  // image exactly, so it doesn't single anyone out). "Compartir" renders the PNG.
  async function showResults(id, j, onBack) {
    stopPoll();
    root.classList.remove('results');
    root.innerHTML = '<div class="card"><div class="muted">Cargando resultados…</div></div>';
    try {
      const pub = await API.req('/tournaments/' + id + '/public', { auth: !(j && j.guestToken), guestToken: j && j.guestToken });
      const mine = (j && j.name) || uname() || null;
      const myRow = mine ? pub.standings.find((s) => s.name === mine) : null;
      root.classList.add('results'); // wider layout for the results card
      root.innerHTML = '';
      if (myRow) {
        const cap = document.createElement('div');
        cap.className = 'muted'; cap.style.cssText = 'text-align:center;margin-bottom:12px';
        cap.innerHTML = 'Tu posición: <b style="color:var(--gold)">' + medal(myRow.rank) + '</b> de ' + pub.standings.length + ' · ' + myRow.wins + '-' + myRow.losses;
        root.appendChild(cap);
      }
      // The .sresult card is the framed artifact itself — no extra panel around it.
      root.appendChild(StandingsImage.buildCardEl(publicToImageData(pub)));
      const actions = document.createElement('div');
      actions.className = 'row'; actions.style.cssText = 'gap:10px;margin-top:16px;justify-content:center';
      actions.innerHTML = '<button class="btn btn-gold btn-sm" id="share">📤 Compartir</button><button class="btn btn-sm btn-ghost" id="back">← Volver</button>';
      root.appendChild(actions);
      $('#share').addEventListener('click', (e) => shareResultsImage(pub, e.currentTarget));
      $('#back').addEventListener('click', onBack);
    } catch (e) {
      root.classList.remove('results');
      root.innerHTML = `<div class="card"><p class="gate-error">${esc(e.message)}</p><button class="btn btn-sm btn-ghost" id="back" style="width:100%">← Volver</button></div>`;
      $('#back').addEventListener('click', onBack);
    }
  }

  const RANK_ICON = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : (r ? '#' + r : '—'));

  async function renderProfile() {
    stopPoll();
    root.classList.remove('results');
    root.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2 style="margin:0">Mi perfil</h2>
          <button class="btn btn-sm btn-ghost" id="back" type="button">← Volver</button>
        </div>
        <div id="body" class="muted" style="margin-top:16px">Cargando…</div>
      </div>`;
    $('#back').addEventListener('click', () => renderJoin());
    try {
      const st = await API.req('/me/stats');
      const r = st.record;
      const b = $('#body'); b.classList.remove('muted');

      if (!st.tournaments.joined) {
        b.innerHTML = '<p class="muted" style="font-size:13px;text-align:center;padding:18px 0">Aún no has jugado torneos con tu cuenta.<br>Únete a uno con un código y tus estadísticas aparecerán aquí.</p>';
        return;
      }

      const C = 339.292; // 2π·54 — ring circumference
      const pct = r.winPct;
      const decided = r.wins + r.losses;

      // Hero: animated win-rate ring + stat tiles.
      let html = `
        <div class="pf-hero">
          <div class="pf-ring">
            <svg viewBox="0 0 120 120" aria-hidden="true">
              <circle class="track" cx="60" cy="60" r="54"></circle>
              <circle class="prog" id="pf-prog" cx="60" cy="60" r="54" stroke-dasharray="${C}" stroke-dashoffset="${C}"></circle>
            </svg>
            <div class="center"><div class="pct">${pct}<span>%</span></div><div class="lbl">Win rate</div></div>
          </div>
          <div class="pf-tiles">
            <div class="pf-tile"><div class="v win">${r.wins}</div><div class="k">Victorias</div></div>
            <div class="pf-tile"><div class="v loss">${r.losses}</div><div class="k">Derrotas</div></div>
            <div class="pf-tile"><div class="v">${st.tournaments.joined}</div><div class="k">Torneos</div></div>
          </div>
          <div class="pf-byes">${decided} partida${decided === 1 ? '' : 's'} decidida${decided === 1 ? '' : 's'}${r.byes ? ` · ${r.byes} BYE${r.byes === 1 ? '' : 's'}` : ''}</div>
        </div>`;

      // Head-to-head: proportional win/loss bar per opponent, colour-coded.
      if (st.headToHead.length) {
        html += '<div class="pf-sec-title">Cara a cara</div><div class="pf-h2h">';
        html += st.headToHead.map((h) => {
          const tot = h.wins + h.losses;
          const wpct = tot ? Math.round((h.wins / tot) * 100) : 0;
          const cls = h.wins > h.losses ? 'pos' : h.wins < h.losses ? 'neg' : '';
          return `<div class="pf-opp">
            <div class="pf-opp-top"><span class="pf-opp-name">${esc(h.username)}</span><span class="pf-opp-rec ${cls}">${h.wins}-${h.losses} · ${wpct}%</span></div>
            <div class="pf-bar"><span class="pf-bar-w" data-w="${tot ? (h.wins / tot) * 100 : 0}"></span><span class="pf-bar-l" data-w="${tot ? (h.losses / tot) * 100 : 0}"></span></div>
          </div>`;
        }).join('');
        html += '</div>';
      }

      // Tournaments played (tap to see results).
      html += '<div class="pf-sec-title">Torneos jugados</div><div class="pf-tourneys">';
      html += st.byTournament.map((t) => `<button class="pf-tourney" data-id="${t.id}" type="button">
        <span class="pf-tk-rank">${RANK_ICON(t.rank)}</span>
        <span class="pf-tk-main"><span class="pf-tk-name">${esc(t.name)}</span>
          <span class="pf-tk-sub">${t.rank ? t.rank + '/' + t.total + ' · ' : ''}${t.wins}-${t.losses}</span></span>
        <span class="pill ${t.status === 'finished' ? 'pill-ok' : 'pill-pend'}">${t.status === 'finished' ? 'Final' : 'En curso'}</span>
      </button>`).join('');
      html += '</div>';

      b.innerHTML = html;
      b.querySelectorAll('.pf-tourney').forEach((el) => el.addEventListener('click', () => showResults(Number(el.dataset.id), null, () => renderProfile())));

      // Animate after the initial (empty) frame paints: ring fills clockwise, bars grow.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const prog = b.querySelector('#pf-prog');
        if (prog) prog.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(2);
        b.querySelectorAll('.pf-bar-w, .pf-bar-l').forEach((bar) => { bar.style.width = bar.dataset.w + '%'; });
      }));
    } catch (e) { const b = $('#body'); if (b) { b.classList.add('muted'); b.textContent = e.message; } }
  }

  function renderPairing(j, me) {
    root.classList.remove('results');
    let body;
    if (me.status === 'finished') {
      body = `<div class="big">🏁 Torneo finalizado</div><p class="muted">¡Gracias por jugar!</p>`;
      stopPoll();
    } else if (!me.pairing) {
      body = `<div class="big">✅ Inscrito</div><p class="muted">Espera a que el organizador inicie el torneo o genere la ronda.</p>`;
    } else if (me.pairing.lateLoss) {
      body = `<div class="round">Ronda ${me.currentRound} de ${me.maxRounds}</div><div class="big">Entrada tardía</div><p class="muted">Recibes una derrota administrativa esta ronda. Te emparejan desde la próxima.</p>`;
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

  // ---- theme (light/dark) -----------------------------------------------
  // Reuses the console's mechanism: the 'ygo_theme' key + [data-theme="light"]
  // on <html> (the FOUC script in the page head already applies it on load).
  function applyTheme(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }
  function mountThemeToggle() {
    if (document.getElementById('theme-toggle')) return;
    const btn = document.createElement('button');
    btn.className = 'theme-switch u-theme'; btn.id = 'theme-toggle'; btn.type = 'button';
    btn.setAttribute('aria-label', 'Cambiar entre tema claro y oscuro');
    btn.title = 'Tema claro / oscuro';
    btn.innerHTML = '<span class="track"><span class="knob"></span></span>';
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      applyTheme(next);
      try { localStorage.setItem('ygo_theme', next); } catch (e) {}
    });
    document.body.appendChild(btn);
  }

  // ---- boot --------------------------------------------------------------
  mountThemeToggle();
  // A shared link (/u/?torneo=CODE, also ?code= / #CODE) opens that tournament's
  // detail card automatically; otherwise show the join screen.
  const _sp = new URLSearchParams(location.search);
  const pre = (_sp.get('code') || _sp.get('torneo') || location.hash.replace('#', '')).toUpperCase();
  if (joined()) startPoll();
  else if (pre.length === 5) openByCode(pre);
  else renderJoin(null, pre);
})();
