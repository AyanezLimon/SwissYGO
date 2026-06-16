/* SwissYGO player page (/u/). Phone-first: join a tournament by 5-char code as an
 * account or a guest (typed/random name), then live-poll /me for the pairing.
 * Standalone — does not touch the organizer console. Reuses existing styles. */
(function () {
  const root = document.getElementById('player');
  const LS_JOINED = 'ygo_joined';           // { id, name, guestToken? }
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const randomName = () => 'Duelista-' + (1000 + Math.floor(Math.random() * 9000));

  const joined = () => { try { return JSON.parse(localStorage.getItem(LS_JOINED) || 'null'); } catch { return null; } };
  const setJoined = (v) => { try { v ? localStorage.setItem(LS_JOINED, JSON.stringify(v)) : localStorage.removeItem(LS_JOINED); } catch {} };
  const loggedIn = () => !!API.token.get();

  let mode = 'guest';   // 'guest' | 'account'
  let reg = false;      // account sub-mode: register vs login
  let pollTimer = null;

  // ---- join screen -------------------------------------------------------
  function renderJoin(err) {
    stopPoll();
    const acct = loggedIn()
      ? `<p class="muted" style="margin:4px 0 0">Entrarás con tu cuenta.</p>`
      : `<div class="gate-field"><label>Usuario</label><input type="text" id="u" autocapitalize="none" spellcheck="false"></div>
         <div class="gate-field"><label>Contraseña</label><input type="password" id="p"></div>
         <button class="btn btn-sm btn-ghost" id="toggle-reg" type="button" style="width:100%">${reg ? '¿Ya tienes cuenta? Inicia sesión' : 'Crear una cuenta nueva'}</button>`;
    root.innerHTML = `
      <div class="card">
        <h2 style="margin-top:0">Unirse a un torneo</h2>
        <div class="gate-field">
          <label>Código del torneo</label>
          <input type="text" id="code" maxlength="5" autocapitalize="characters" autocomplete="off" spellcheck="false"
                 style="text-transform:uppercase;font-family:var(--mono);font-size:22px;letter-spacing:4px;text-align:center">
        </div>
        <nav class="tabs" id="pmode" style="margin:6px 0 14px">
          <button type="button" class="${mode === 'guest' ? 'active' : ''}" data-m="guest">Invitado</button>
          <button type="button" class="${mode === 'account' ? 'active' : ''}" data-m="account">Con cuenta</button>
        </nav>
        <div id="mode-body">
          ${mode === 'guest'
            ? `<div class="gate-field"><label>Tu nombre</label><input type="text" id="gname" maxlength="40" value="${esc(randomName())}"></div>`
            : acct}
        </div>
        <div class="gate-error" id="perr">${err ? esc(err) : ''}</div>
        <button class="btn btn-gold" id="join" style="width:100%">Unirme</button>
      </div>`;

    $('#pmode').addEventListener('click', (e) => {
      const b = e.target.closest('[data-m]'); if (!b) return; mode = b.dataset.m; renderJoin();
    });
    const tg = $('#toggle-reg'); if (tg) tg.addEventListener('click', () => { reg = !reg; renderJoin(); });
    $('#join').addEventListener('click', doJoin);
    $('#code').addEventListener('keyup', (e) => { if (e.key === 'Enter') doJoin(); });
  }

  async function doJoin() {
    const code = ($('#code').value || '').trim().toUpperCase();
    if (code.length !== 5) return renderJoin('El código tiene 5 caracteres.');
    const btn = $('#join'); btn.disabled = true;
    try {
      if (mode === 'account' && !loggedIn()) {
        const u = $('#u').value.trim(), p = $('#p').value;
        if (!u || !p) { btn.disabled = false; return renderJoin('Usuario y contraseña requeridos.'); }
        const r = reg ? await API.register(u, p) : await API.login(u, p);
        API.token.set(r.token);
      }
      let res;
      if (mode === 'guest') {
        const name = ($('#gname').value || '').trim() || randomName();
        res = await API.req('/tournaments/join', { method: 'POST', auth: false, body: { code, name } });
        setJoined({ id: res.id, name: res.name, guestToken: res.guest_token });
      } else {
        res = await API.req('/tournaments/join', { method: 'POST', body: { code } });
        setJoined({ id: res.id, name: res.name });
      }
      startPoll();
    } catch (e) {
      btn.disabled = false;
      renderJoin(e.message || 'No se pudo unir.');
    }
  }

  // ---- pairing screen ----------------------------------------------------
  async function poll() {
    const j = joined(); if (!j) return;
    try {
      const me = await API.req('/tournaments/' + j.id + '/me', { auth: !j.guestToken, guestToken: j.guestToken });
      renderPairing(j, me);
    } catch (e) {
      if (e.status === 403) renderJoin('Ya no estás inscrito en ese torneo.');
      // other errors: keep last view, retry next tick
    }
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
  else { renderJoin(); if (pre && $('#code')) $('#code').value = pre; }
})();
