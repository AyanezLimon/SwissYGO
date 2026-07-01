/* SwissYGO player page (/u/). Phone-first. Logged-in users join with their
 * account; everyone else joins as a guest (typed/random name, no saved stats).
 * Lists active tournaments to pick from, then live-polls /me for the pairing.
 * Standalone — does not touch the organizer console. */
(function () {
  const root = document.getElementById('player');
  const LS_JOINED = 'ygo_joined';           // { id, name, guestToken? }
  // Fallback deck cover when there's nothing to show (no favourite deck / no cover):
  // the "Question" card's mystery art (passcode 38723936) — nicer than a blank square.
  const MYSTERY_COVER = 'https://images.ygoprodeck.com/images/cards_cropped/38723936.jpg';
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  // Toast — unlike the console, /u/ has no #toast element in its HTML, so create
  // one lazily on first use. Reuses the .toast styles already in styles.css.
  let _toastTimer = null;
  function showToast(msg, isErr = false) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.add('show');
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }
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
  // A guest's per-tournament guest_token is the ONLY way to resume their registration.
  // Persist it in localStorage (keyed by join code) so it survives "Salir"
  // (setJoined(null)) AND a browser close — otherwise re-joining the same tournament
  // would create a duplicate registration. The active "playing as" session still
  // lives in sessionStorage; this is just dedupe memory.
  const gtokMap = () => { try { return JSON.parse(localStorage.getItem('ygo_gtok') || '{}'); } catch { return {}; } };
  const gtokGet = (code) => { const m = gtokMap(); return (m && m[code]) || null; };
  const gtokSet = (code, token) => { try { if (!token) return; const m = gtokMap(); m[code] = token; localStorage.setItem('ygo_gtok', JSON.stringify(m)); } catch {} };

  let pollTimer = null;
  let _pollInFlight = false;   // skip a tick if the previous /me is still awaiting (no overlap / out-of-order updates)
  let _seenInEvent = false;    // have we seen ourselves in the roster this session? (to detect removal vs not-yet-absorbed)
  const uname = () => { try { return localStorage.getItem('ygo_username') || ''; } catch { return ''; } };
  const fmtDate = (s) => String(s || '').replace('T', ' ').slice(0, 16);

  // ---- screen history: hardware/browser Back (and Forward) drive the view ----
  // The join screen (home) is the base; profile, leaderboard, the tournament
  // detail card, results and the Elo history stack on top of it — each as one
  // history entry. `_navStack` holds one (bare) renderer per depth ([0] = base);
  // `_navIndex` is the depth of the entry on screen. Opening a screen pushes a
  // state carrying its depth. popstate reconciles to whatever entry the browser
  // moved to — so it renders the right view for BOTH Back and Forward (rather than
  // blindly popping). Entries aren't discarded on Back, so Forward restores them;
  // branching (open a new screen after going back) truncates the stale forward
  // entries to match the browser. base seeded so a deep-linked screen still Backs home.
  const _navStack = [renderJoin];
  let _navIndex = 0;
  function navReset() { _navStack.length = 1; _navStack[0] = renderJoin; _navIndex = 0; } // (re)enter base (join/leave/finish)
  function navOpen(renderFn) {                       // open a screen as a new history entry
    _navStack.length = _navIndex + 1;                 // drop forward entries when branching
    _navStack.push(renderFn);
    _navIndex = _navStack.length - 1;
    try { history.pushState({ uScreen: _navIndex }, ''); } catch (e) {}
    renderFn();
  }
  function navBack() { if (_navIndex > 0) history.back(); } // "Volver" → triggers popstate below
  window.addEventListener('popstate', (e) => {
    const want = (e && e.state && typeof e.state.uScreen === 'number') ? e.state.uScreen : 0;
    _navIndex = Math.max(0, Math.min(want, _navStack.length - 1)); // clamp: a stale entry still renders a valid view
    const fn = _navStack[_navIndex];
    if (typeof fn === 'function') fn();              // render the view for this entry (Back or Forward)
  });

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
        ${logged ? '<button class="btn btn-sm btn-ghost" id="hist" type="button" style="width:100%;margin-top:10px">👤 Mi perfil</button>' : ''}
        ${logged ? '<button class="btn btn-sm btn-ghost" id="decks" type="button" style="width:100%;margin-top:10px">🎴 Mis Decks</button>' : ''}
        ${logged ? '<button class="btn btn-sm btn-ghost" id="acct" type="button" style="width:100%;margin-top:10px">⚙ Mi cuenta</button>' : ''}
        <button class="btn btn-sm btn-ghost" id="leaderboard" type="button" style="width:100%;margin-top:10px">🏆 Clasificación</button>
      </div>`;

    $('#join').addEventListener('click', () => doJoin($('#code').value));
    $('#code').addEventListener('keyup', (e) => { if (e.key === 'Enter') doJoin($('#code').value); });
    const lo = $('#logout'); if (lo) lo.addEventListener('click', () => { API.token.clear(); try { localStorage.removeItem('ygo_username'); localStorage.removeItem(LS_JOINED); } catch {} location.href = '/'; });
    const si = $('#signin'); if (si) si.addEventListener('click', () => { try { sessionStorage.removeItem('ygo_guest'); sessionStorage.removeItem('ygo_guest_name'); sessionStorage.removeItem(LS_JOINED); } catch {} location.href = '/'; });
    const gn = $('#gname'); if (gn) gn.addEventListener('input', () => { try { sessionStorage.setItem('ygo_guest_name', gn.value); } catch {} });
    const h = $('#hist'); if (h) h.addEventListener('click', () => navOpen(renderProfile));
    const dk = $('#decks'); if (dk) dk.addEventListener('click', () => navOpen(renderMyDecks));
    const ac = $('#acct'); if (ac) ac.addEventListener('click', () => navOpen(renderAccountScreen));
    const lb = $('#leaderboard'); if (lb) lb.addEventListener('click', () => navOpen(renderLeaderboard));
    loadActive();
  }

  // ---- "am I already registered?" ---------------------------------------
  // Used to badge the home list and to show the "already in" state on the card
  // (so a registered user doesn't see a join form again). Account → the server
  // knows every event they joined (/me/tournaments, any device); everyone → the
  // active session (joined) plus any per-tournament guest_token this browser kept
  // (ygo_gtok, keyed by UPPERCASE join code — survives "Salir"/browser close, #73).
  const gtokForCode = (code) => { try { return JSON.parse(localStorage.getItem('ygo_gtok') || '{}')[String(code || '').toUpperCase()] || null; } catch { return null; } };
  const gtokDel = (code) => { try { const m = JSON.parse(localStorage.getItem('ygo_gtok') || '{}'); delete m[String(code || '').toUpperCase()]; localStorage.setItem('ygo_gtok', JSON.stringify(m)); } catch {} };
  async function myRegistrations() {
    const ids = new Set(), codes = new Set();
    const j = joined(); if (j && j.id) ids.add(j.id);
    try { Object.keys(JSON.parse(localStorage.getItem('ygo_gtok') || '{}')).forEach((c) => codes.add(String(c).toUpperCase())); } catch {}
    if (loggedIn()) { try { (await API.req('/me/tournaments') || []).forEach((t) => ids.add(t.id)); } catch {} }
    return { ids, codes };
  }
  const isMine = (t, reg) => !!(reg && t && ((t.id && reg.ids.has(t.id)) || (t.code && reg.codes.has(String(t.code).toUpperCase()))));

  async function loadActive() {
    const el = $('#active'); if (!el) return;
    try {
      // Fetch the list and "what am I in" together so each card can show "Inscrito".
      const [list, reg] = await Promise.all([API.req('/tournaments/active', { auth: false }), myRegistrations()]);
      if (!list.length) { el.innerHTML = '<p class="muted" style="font-size:13px">No hay torneos activos ahora. Usa un código si tienes uno.</p>'; return; }
      el.innerHTML = '<div class="muted" style="font-size:11.5px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">Torneos activos</div>' +
        list.map((t) => `<div class="tcard" data-code="${esc(t.code)}" data-open="${t.status === 'setup' ? '1' : '0'}">
          <div class="row" style="justify-content:space-between;align-items:center">
            <b>${esc(t.name)}</b>
            <span style="display:flex;gap:6px;align-items:center">${isMine(t, reg) ? '<span class="pill pill-bye" title="Ya estás inscrito en este torneo">✓ Inscrito</span>' : ''}${t.ranked === false ? '<span class="pill pill-casual" title="No afecta tu Elo">Casual</span>' : ''}<span class="pill ${t.status === 'setup' ? 'pill-ok' : 'pill-pend'}">${t.status === 'setup' ? 'Registro abierto' : 'En curso'}</span></span>
          </div>
          <div class="muted" style="font-size:12.5px;margin-top:5px">${t.players} jugador(es) · ${esc(fmtDate(t.date || t.created_at))} · código <b style="font-family:var(--mono);letter-spacing:1px">${esc(t.code)}</b></div>
          ${t.note ? `<div class="muted" style="font-size:12.5px;margin-top:5px">${esc(t.note)}</div>` : ''}
        </div>`).join('');
      el.querySelectorAll('.tcard').forEach((c, i) => c.addEventListener('click', () => navOpen(() => showTournamentCard(list[i]))));
    } catch (e) { el.innerHTML = '<p class="muted" style="font-size:13px">No se pudo cargar la lista de torneos.</p>'; }
  }

  // Open the tournament detail card from a code (deep link /u/?torneo=CODE).
  async function openByCode(code) {
    try {
      const t = await API.req('/tournaments/by-code/' + encodeURIComponent(code), { auth: false });
      navOpen(() => showTournamentCard(t));   // Back from a deep-linked card → the join home
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
      + `<div class="gate-error" id="perr"></div><button class="btn btn-gold" id="confirm" style="width:100%">${btnLabel}</button>`
      // Arriving via a shared code link drops a guest straight on this card, with no
      // way back to the sign-in screen — so offer the account path here too (#70):
      // create one to keep stats/Elo, or sign in. Guest-only (accounts already in).
      + (logged ? '' : '<div class="muted" style="font-size:12px;text-align:center;margin-top:12px;line-height:1.5">¿Quieres guardar tus estadísticas y tu Elo?<br><a href="#" id="cardSignup" style="color:var(--gold);font-weight:600">Crear cuenta</a> · <a href="#" id="cardSignin" style="color:var(--gold)">Iniciar sesión</a></div>');
    // Ranked tournaments require an account (guests have no persistent Elo). For a
    // guest, the join form is replaced by a sign-in / create-account prompt — the
    // server enforces the same rule (403 ranked_requires_account) as a backstop.
    const needsAccount = (t.ranked !== false) && !logged;
    const authRequiredBlock = '<div class="muted" style="font-size:13px;margin-bottom:12px">🔒 <b>Torneo clasificatorio.</b> Necesitas una cuenta para registrarte — los invitados solo pueden entrar a torneos casuales.</div>'
      + '<button class="btn btn-gold" id="goSignin" style="width:100%">Iniciar sesión</button>'
      + '<button class="btn btn-sm btn-ghost" id="goSignup" style="width:100%;margin-top:10px">Crear cuenta</button>';
    let action;
    if (t.status === 'setup') {
      action = needsAccount ? authRequiredBlock : joinControls('Confirmar registro');
    } else if (t.status === 'finished') {
      action = '<button class="btn btn-gold" id="results" style="width:100%">Ver resultados</button>';
    } else if (t.lateOpen) {
      // Running but rounds remain → late entry (official rule: a loss per played round).
      // t.lateOpen is the server's own gate signal — UI can't advertise a 409.
      action = needsAccount ? authRequiredBlock
        : `<div class="muted" style="font-size:12.5px;margin-bottom:10px">Este torneo ya comenzó (Ronda ${t.currentRound}/${t.maxRounds}). Puedes entrar como <b>entrada tardía</b>: recibes una derrota por cada ronda ya jugada y te emparejan desde la próxima.</div>`
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
          <span id="cardPills" style="display:flex;gap:6px;align-items:center;flex-shrink:0">${t.ranked === false ? '<span class="pill pill-casual" title="No afecta tu Elo">Casual</span>' : ''}<span class="pill ${pill}">${label}</span></span>
        </div>
        <div class="muted" style="font-size:12.5px;margin:6px 0 12px">${meta}${t.ranked === false ? ' · <span style="color:var(--ink-soft)">no cuenta para el ranking</span>' : ''}</div>
        ${t.note ? `<div style="background:var(--field-bg);border:1px solid var(--border-2);border-radius:10px;padding:10px 12px;font-size:13px;color:var(--ink-soft);white-space:pre-wrap">${esc(t.note)}</div>` : ''}
        <div id="cardAction" style="margin-top:14px">${action}</div>
        <button class="btn btn-sm btn-ghost" id="back" style="width:100%;margin-top:10px">← Volver</button>
      </div>`;
    const c = $('#confirm'); if (c) c.addEventListener('click', () => doJoin(t.code));
    const rs = $('#results'); if (rs) rs.addEventListener('click', () => navOpen(() => showResults(t.id, null, () => showTournamentCard(t))));
    const gsi = $('#goSignin'); if (gsi) gsi.addEventListener('click', () => goToGate(false));
    const gsu = $('#goSignup'); if (gsu) gsu.addEventListener('click', () => goToGate(true));
    const csi = $('#cardSignin'); if (csi) csi.addEventListener('click', (e) => { e.preventDefault(); goToGate(false); });
    const csu = $('#cardSignup'); if (csu) csu.addEventListener('click', (e) => { e.preventDefault(); goToGate(true); });
    $('#back').addEventListener('click', navBack);
    markCardRegistered(t);   // already in? → swap the join form for an "inscrito"/withdraw state
  }

  // Leave the guest flow and go to the landing gate (/) to sign in or create an
  // account. Clears the guest session markers (like the home "Iniciar sesión") so
  // the gate shows instead of auto-entering the guest console; register=true
  // deep-links the gate's "Crear cuenta" tab via the #crear hash (read by connect.js).
  function goToGate(register) {
    try { sessionStorage.removeItem('ygo_guest'); sessionStorage.removeItem('ygo_guest_name'); sessionStorage.removeItem(LS_JOINED); } catch {}
    location.href = register ? '/#crear' : '/';
  }

  // If the caller is already registered in this tournament, replace the join form
  // (the user shouldn't "confirm" again) with an "Inscrito" badge + the right
  // action: withdraw while in setup, "Ver mi mesa" once it's running, results when
  // finished (left as-is). Runs after the sync render so the card never blanks.
  async function markCardRegistered(t) {
    const reg = await myRegistrations();
    if (!isMine(t, reg)) return;
    const pills = $('#cardPills');
    if (pills && !pills.querySelector('.pill-bye')) pills.insertAdjacentHTML('afterbegin', '<span class="pill pill-bye" title="Ya estás inscrito">✓ Inscrito</span>');
    const act = $('#cardAction'); if (!act) return;
    if (t.status === 'setup') {
      act.innerHTML = '<div class="muted" style="font-size:12.5px;margin-bottom:10px">✅ <b>Ya estás inscrito</b> en este torneo. Cuando empiece verás aquí tu mesa y rival.</div>'
        + '<button class="btn btn-danger" id="cardWithdraw" style="width:100%">Retirarme del torneo</button>';
      wireCardWithdraw(t);
    } else if (t.status === 'running') {
      act.innerHTML = '<div class="muted" style="font-size:12.5px;margin-bottom:10px">✅ <b>Ya estás inscrito</b>. El torneo está en curso.</div>'
        + '<button class="btn btn-gold" id="cardEnter" style="width:100%">Ver mi mesa</button>';
      const e = $('#cardEnter'); if (e) e.addEventListener('click', () => doJoin(t.code));
    }
    // finished → keep "Ver resultados"
  }

  // Withdraw from the card (setup only), with an inline confirm. Mirrors the
  // in-event withdraw (#71): DELETE my registration (account via JWT, guest via the
  // remembered token), drop the local registration/token, back to the home + toast.
  function wireCardWithdraw(t) {
    const wd = $('#cardWithdraw'); if (!wd) return;
    wd.addEventListener('click', () => {
      wd.outerHTML = '<div class="row" style="gap:8px;justify-content:center">'
        + '<button class="btn btn-danger btn-sm" id="cw-yes">Sí, retirarme</button>'
        + '<button class="btn btn-sm btn-ghost" id="cw-no">Cancelar</button></div>';
      const no = $('#cw-no'); if (no) no.addEventListener('click', () => showTournamentCard(t));
      const yes = $('#cw-yes'); if (yes) yes.addEventListener('click', async () => {
        const j = joined();
        const useAuth = loggedIn();
        const gtok = (j && j.id === t.id && j.guestToken) || gtokForCode(t.code);
        try { await API.req('/tournaments/' + t.id + '/registration', { method: 'DELETE', auth: useAuth, guestToken: useAuth ? undefined : gtok }); }
        catch (e) { showToast(e.message || 'No se pudo retirar.', true); return; }
        if (j && j.id === t.id) setJoined(null);
        gtokDel(t.code);
        navReset(); renderJoin();
        showToast('Te retiraste del torneo.');
      });
    });
  }

  /**
   * Joins a tournament by its join code.
   * @param {string} code - Tournament join code.
   */
  async function doJoin(code) {
    code = (code || '').trim().toUpperCase();
    const errEl = $('#perr');
    if (code.length !== 5) { if (errEl) errEl.textContent = 'El código tiene 5 caracteres.'; return; }
    primeNotifications(); // within the click gesture: unlock audio + ask for permission
    // Disable BOTH the home "Unirme" and the card's "Confirmar registro" while the
    // request is in flight — a double-tap on #confirm was firing two /join POSTs
    // before the guest_token was stored, creating duplicate registrations.
    const btns = ['#join', '#confirm'].map((s) => $(s)).filter(Boolean);
    btns.forEach((b) => { b.disabled = true; });
    try {
      let res;
      if (loggedIn()) {
        res = await API.req('/tournaments/join', { method: 'POST', body: { code } });
        // name = OUR display name (account username), NOT res.name (the tournament).
        setJoined({ id: res.id, name: res.display_name || uname(), guestToken: null });
      } else {
        const name = ($('#gname') && $('#gname').value.trim()) || guestName();
        try { sessionStorage.setItem('ygo_guest_name', name); } catch {}
        // Send any guest_token this browser already holds → the server resumes that
        // registration if it's for THIS tournament (no duplicate (1)/(2) on re-confirm).
        const prev = joined();
        const tok = (prev && prev.guestToken) || gtokGet(code) || undefined; // active session OR remembered (survives Salir / browser close)
        res = await API.req('/tournaments/join', { method: 'POST', auth: false, guestToken: tok, body: { code, name } });
        setJoined({ id: res.id, name: res.display_name || name, guestToken: res.guest_token });
        gtokSet(code, res.guest_token); // remember per-tournament so a future re-join resumes instead of duplicating
      }
      navReset();   // entering the event = base view; clear any screen depth (e.g. the card we joined from)
      startPoll();
    } catch (e) {
      btns.forEach((b) => { b.disabled = false; });
      // Guest typed a ranked tournament's code on the home → open its card, which
      // shows the "necesitas una cuenta" prompt + sign-in / create-account buttons.
      if (e && e.code === 'ranked_requires_account') { openByCode(code); return; }
      // Ranked event needs a registered deck (#109) → open the deck-pick screen.
      if (e && e.code === 'ranked_requires_deck') { navOpen(() => renderJoinDeckPick(code, e.data && e.data.name)); return; }
      if (errEl) errEl.textContent = e.message || 'No se pudo unir.';
    }
  }

  // ---- ranked deck registration (#109) -----------------------------------
  // Banlist read from ygoprodeck (banlist_info.ban_tcg); mirrors the server's
  // lib/deck-legality.js so the selector can show legality before registering.
  const BAN_LIMIT = { Forbidden: 0, Limited: 1, 'Semi-Limited': 2 }; // → max copies; else 3
  let _jdpJoining = false; // guards the deck-pick screen against concurrent /join requests
  // Throws (fail closed) if the lookup can't be completed — mirrors the server: an
  /**
   * Fetches banlist metadata for Yu-Gi-Oh card IDs.
   * @param {Array<string|number>} codes - The card IDs to look up.
   * @return {Promise<Object<string, {name: string, ban: string|null}>>} A map from card ID to card name and TCG banlist rank.
   * @throws {Error} When the card metadata lookup fails.
   */
  async function fetchCardMeta(codes) {
    const uniq = [...new Set(codes)]; const map = {};
    for (let i = 0; i < uniq.length; i += 100) {
      const chunk = uniq.slice(i, i + 100);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000); // a stall must not freeze the picker
      let j;
      try {
        const r = await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?id=' + chunk.join(','), { signal: ctrl.signal });
        if (!r.ok) throw new Error('No se pudo consultar la banlist.');
        j = await r.json();
      } finally { clearTimeout(timer); }
      for (const c of (j.data || [])) map[c.id] = { name: c.name, ban: (c.banlist_info && c.banlist_info.ban_tcg) || null };
    }
    return map;
  }
  /**
   * Validates deck size and copy-limit legality.
   * @param {Object} cards - Deck card lists grouped by section.
   * @param {Object} meta - Card metadata keyed by passcode.
   * @return {{legal: boolean, unverified: boolean, violations: string[]}} The legality result, including any rule violations and whether all cards could be verified.
   */
  function deckLegality(cards, meta) {
    const main = cards.main || [], extra = cards.extra || [], side = cards.side || []; const v = [];
    if (main.length < 40) v.push('Main Deck: ' + main.length + ' (mín. 40)');
    if (main.length > 60) v.push('Main Deck: ' + main.length + ' (máx. 60)');
    if (extra.length > 15) v.push('Extra Deck: ' + extra.length + ' (máx. 15)');
    if (side.length > 15) v.push('Side Deck: ' + side.length + ' (máx. 15)');
    const rank = (b) => (b in BAN_LIMIT ? BAN_LIMIT[b] : 3);
    const seen = new Map(); let unresolved = 0;
    for (const c of [...main, ...extra, ...side]) { const m = meta[c]; if (!m) unresolved++; const mm = m || { name: '#' + c, ban: null }; const e = seen.get(mm.name) || { count: 0, ban: null }; e.count++; if (mm.ban && (e.ban === null || rank(mm.ban) < rank(e.ban))) e.ban = mm.ban; seen.set(mm.name, e); }
    for (const [name, e] of seen) { const a = rank(e.ban); if (e.count > a) { const tag = a === 0 ? 'Prohibida' : a === 1 ? 'Limitada (máx 1)' : a === 2 ? 'Semi-limitada (máx 2)' : 'máx 3'; v.push(e.count + '× ' + name + ' — ' + tag); } }
    // Unresolved cards = unknown banlist status → treat as NOT verified-legal (locked).
    const unverified = unresolved > 0;
    return { legal: v.length === 0 && !unverified, unverified, violations: v };
  }

  /**
   * Renders the ranked tournament deck selection screen.
   * @param {string} code - Tournament join code.
   * @param {string} tname - Tournament name shown in the header.
   */
  async function renderJoinDeckPick(code, tname) {
    stopPoll(); root.classList.remove('results');
    root.innerHTML = `<div class="card">
        <div class="row scr-head">
          <button class="btn btn-sm btn-ghost" id="back" type="button">← Volver</button>
          <h2 class="scr-title">${esc(tname || 'Torneo')}</h2>
          <span class="scr-spacer"></span>
        </div>
        <div class="jdp-badge-row"><span class="jdp-badge">🏆 Torneo clasificatorio</span></div>
        <div class="muted jdp-lead">Elige el deck con el que vas a competir. Quedará registrado para este torneo.</div>
        <div id="jdp-body" class="muted jdp-body">Cargando tus decks…</div>
      </div>`;
    $('#back').addEventListener('click', navBack);
    let decks;
    try { decks = (await API.req('/decks')).decks || []; }
    catch (e) { $('#jdp-body').textContent = 'No se pudieron cargar tus decks.'; return; }
    const body = $('#jdp-body');
    if (!decks.length) {
      body.classList.remove('muted');
      body.innerHTML = `<div class="jdp-state">
          <div class="ico">🎴</div>
          <p class="muted">Necesitas un deck guardado para registrarte en un torneo clasificatorio.</p>
          <button class="btn btn-gold btn-block" id="jdp-create" type="button">Crear mi primer deck</button>
        </div>`;
      $('#jdp-create').addEventListener('click', () => navOpen(renderMyDecks));
      return;
    }
    body.textContent = 'Revisando legalidad…';
    const withCards = await Promise.all(decks.map(async (d) => {
      try { const r = await API.req('/decks/' + d.id + '/cards'); return { d, cards: r.decks || { main: [], extra: [], side: [] } }; }
      catch (e) { return { d, cards: null }; }
    }));
    const allCodes = []; withCards.forEach((x) => { if (x.cards) allCodes.push(...(x.cards.main || []), ...(x.cards.extra || []), ...(x.cards.side || [])); });
    let meta;
    try { meta = await fetchCardMeta(allCodes); }
    catch (e) {
      body.classList.remove('muted');
      body.innerHTML = `<div class="jdp-state">
          <p class="muted">No se pudo verificar la legalidad de los decks. Revisa tu conexión e inténtalo de nuevo.</p>
          <button class="btn btn-gold btn-block" id="jdp-retry" type="button">Reintentar</button>
        </div>`;
      $('#jdp-retry').addEventListener('click', () => renderJoinDeckPick(code, tname));
      return;
    }
    const rows = withCards.map((x) => ({ ...x, leg: x.cards ? deckLegality(x.cards, meta) : { legal: false, unverified: true, violations: ['No se pudo leer el decklist.'] } }));
    let selected = (rows.find((r) => r.leg.legal) || {}).d ? rows.find((r) => r.leg.legal).d.id : null;
    body.classList.remove('muted');
    const draw = () => {
      const cur = rows.find((r) => r.d.id === selected);
      body.innerHTML = `<div class="jdp-list">${rows.map((r) => {
        const legal = r.leg.legal, sel = r.d.id === selected;
        const cover = r.d.cover_url ? `<img class="cover" src="${esc(r.d.cover_url)}" alt="">` : '<div class="cover"></div>';
        const lock = legal ? '' : '<span class="lock">🔒</span>';
        const why = legal ? '' : `<span class="why">${r.leg.unverified ? 'No se pudo verificar la legalidad' : 'No legal para formato avanzado'}</span>`;
        return `<button class="jdp-deck${legal ? '' : ' illegal'}${sel ? ' sel' : ''}" data-id="${r.d.id}" data-legal="${legal ? 1 : 0}" type="button">
            <span class="cover-wrap">${cover}${lock}</span>
            <span class="meta"><b class="name">${esc(r.d.name || 'Deck sin nombre')}</b>${why}</span>
            <span class="radio">${sel ? '✓' : ''}</span>
          </button>`;
      }).join('')}</div>
        <button class="btn btn-gold jdp-go" id="jdp-go" type="button"${cur ? '' : ' disabled'}>${cur ? 'Registrarme con ' + esc(cur.d.name || 'este deck') : 'Elige un deck legal'}</button>
        <div class="muted jdp-manage-row">Gestiona tus mazos en <button class="jdp-manage" id="jdp-manage" type="button">Mis Decks</button></div>`;
      body.querySelectorAll('.jdp-deck').forEach((el) => el.addEventListener('click', () => {
        if (_jdpJoining) return; // a registration is in flight — ignore selection changes
        if (el.dataset.legal === '1') { selected = Number(el.dataset.id); draw(); return; }
        const r = rows.find((x) => x.d.id === Number(el.dataset.id));
        const msg = r.leg.unverified
          ? 'No se pudo verificar la legalidad de este deck.'
          : (r.leg.violations[0] || 'Deck no legal') + (r.leg.violations.length > 1 ? ' (+' + (r.leg.violations.length - 1) + ')' : '');
        showToast(msg, true);
      }));
      const go = $('#jdp-go'); if (go && cur) go.addEventListener('click', () => { if (_jdpJoining) return; doJoinWithDeck(code, selected, go); });
      const mng = $('#jdp-manage'); if (mng) mng.addEventListener('click', () => navOpen(renderMyDecks));
    };
    draw();
  }

  /**
   * Registers the player in a tournament with a saved deck.
   * @param {string} code - Tournament join code.
   * @param {number} deckId - Saved deck identifier to submit with the registration.
   * @param {HTMLButtonElement} btn - Button used to submit the registration.
   */
  async function doJoinWithDeck(code, deckId, btn) {
    if (_jdpJoining) return;               // one /join at a time (clicks elsewhere are gated too)
    _jdpJoining = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Registrando…'; }
    try {
      const res = await API.req('/tournaments/join', { method: 'POST', body: { code, deck_id: deckId } });
      _jdpJoining = false;
      setJoined({ id: res.id, name: res.display_name || uname(), guestToken: null });
      navReset(); startPoll();
    } catch (e) {
      _jdpJoining = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Registrarme'; }
      const vio = e.data && e.data.violations;
      showToast(vio && vio.length ? vio[0] : (e.message || 'No se pudo registrar.'), true);
    }
  }

  // ---- round-start alert -------------------------------------------------
  // When a new round's pairing appears, nudge the player (sound + vibration +
  // OS notification) so a phone-in-pocket player knows their table is up. We
  // skip the first sighting (page load / reload) to avoid spurious alerts.
  let _lastRound = -1;
  let _audioCtx = null;
  let _primed = false;
  // Audio unlock + Notification permission both need a user GESTURE, so this must
  // run inside one. It's idempotent and is wired to the FIRST gesture after load
  // (see boot) so EVERY entry path is covered — join-by-code, session resume,
  // deep-link resume, account/guest resume — not just the explicit join click.
  function primeNotifications() {
    if (_primed) return; _primed = true;
    try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {}
    try { _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)(); if (_audioCtx.state === 'suspended') _audioCtx.resume(); } catch {}
  }
  // Per-player preference (the bell toggle); default ON. Gates ALL alerting below.
  function notifEnabled() { try { return localStorage.getItem('ygo_notif') !== '0'; } catch { return true; } }

  // Two-note chime — more noticeable than a single beep. No-ops if audio is locked.
  function chime() {
    try {
      if (!_audioCtx) return;
      const t0 = _audioCtx.currentTime;
      [[880, 0], [1320, 0.16]].forEach(([f, dt]) => {
        const o = _audioCtx.createOscillator(), g = _audioCtx.createGain();
        o.type = 'sine'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0 + dt);
        g.gain.exponentialRampToValueAtTime(0.07, t0 + dt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.16);
        o.connect(g); g.connect(_audioCtx.destination);
        o.start(t0 + dt); o.stop(t0 + dt + 0.2);
      });
    } catch {}
  }
  // OS notification: brand crest icon, stays until tapped, click focuses this tab.
  function osNotify(title, body, tag) {
    try {
      if (!('Notification' in window) || Notification.permission !== 'granted') return;
      const icon = (window.BRAND && BRAND.crest) || undefined;
      const n = new Notification(title, { body, tag, renotify: true, requireInteraction: true, icon, badge: icon });
      n.onclick = () => { try { window.focus(); } catch {} n.close(); };
    } catch {}
  }
  // In-app banner — browsers often suppress OS notifications while the tab is
  // visible, so a fixed toast covers the foreground case. Auto-dismisses; tap to close.
  let _bannerTimer = null;
  function showBanner(title, body) {
    let el = document.getElementById('ygo-banner');
    if (!el) { el = document.createElement('div'); el.id = 'ygo-banner'; el.addEventListener('click', () => el.classList.remove('show')); document.body.appendChild(el); }
    el.innerHTML = '<div class="b-txt"><strong>' + esc(title) + '</strong><span>' + esc(body) + '</span></div><i aria-hidden="true">✕</i>';
    requestAnimationFrame(() => el.classList.add('show'));
    if (_bannerTimer) clearTimeout(_bannerTimer);
    _bannerTimer = setTimeout(() => el.classList.remove('show'), 9000);
  }
  const roundBody = (me) => me.pairing.isBye ? 'Descansas esta ronda (BYE)'
    : me.pairing.lateLoss ? 'Entrada tardía · derrota en esta ronda'
    : 'Mesa ' + me.pairing.table + (me.pairing.opponent ? ' · vs ' + me.pairing.opponent : '');
  function notifyRound(me) {
    if (!notifEnabled()) return;
    const title = 'Ronda ' + me.currentRound + (me.maxRounds ? '/' + me.maxRounds : '') + ' — ' + (me.name || 'Torneo');
    const body = roundBody(me);
    try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch {}
    chime(); osNotify(title, body, 'ygo-round'); showBanner(title, body);
  }
  function notifyFinished(name, pub, myRow) {
    if (!notifEnabled()) return;
    const title = 'Torneo finalizado' + (name ? ' — ' + name : '');
    const total = (pub && pub.standings) ? pub.standings.length : '?';
    const body = myRow ? 'Terminaste ' + RANK_ICON(myRow.rank) + ' de ' + total + ' · ' + myRow.wins + '-' + myRow.losses : 'Resultados disponibles';
    try { if (navigator.vibrate) navigator.vibrate([90, 50, 90, 50, 160]); } catch {}
    chime(); osNotify(title, body, 'ygo-finished'); showBanner(title, body);
  }

  // ---- pairing screen ----------------------------------------------------
  async function poll() {
    const j = joined(); if (!j) return;
    if (_pollInFlight) return;   // a previous tick is still in flight — don't overlap
    _pollInFlight = true;
    try {
      const me = await API.req('/tournaments/' + j.id + '/me', { auth: !j.guestToken, guestToken: j.guestToken });
      // Removal: the registration persists when the TO drops a player, so /me won't
      // 403. Detect the in→out transition (we were in the roster, now we're not) —
      // a not-yet-absorbed player has never been "in", so this won't false-fire.
      if (me.inEvent || me.pairing) _seenInEvent = true;
      if (me.inEvent === false && _seenInEvent) {
        stopPoll(); setJoined(null);
        navReset();
        renderJoin('El organizador te retiró del torneo.');
        return;
      }
      if (me.status === 'finished') {
        stopPoll();
        const live = _lastRound !== -1; // we saw at least one live round this session → real transition, worth notifying
        setJoined(null); // tournament's over — end the session so a refresh goes to the /u/ home, not back here
        navReset(); navOpen(() => showResults(j.id, j, () => renderJoin(), live, me.name)); // results as a screen → Back/Volver → home
        return; // finally still runs; stopPoll already halted the loop, so "finished" fires once
      }
      if (me.pairing && me.currentRound !== _lastRound) {
        if (_lastRound !== -1 && me.currentRound > _lastRound) notifyRound(me);
        _lastRound = me.currentRound;
      }
      renderPairing(j, me);
    } catch (e) {
      if (e.status === 403) renderJoin('Ya no estás inscrito en ese torneo.');
      // other errors: keep last view, retry next tick
    } finally {
      _pollInFlight = false;
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
      date: pub.date ? new Date(pub.date + 'T00:00:00') : (pub.finished_at ? new Date(String(pub.finished_at).replace(' ', 'T') + 'Z') : new Date()),
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
  async function showResults(id, j, onBack, notify, tname) {
    stopPoll();
    root.classList.remove('results');
    root.innerHTML = '<div class="card"><div class="muted">Cargando resultados…</div></div>';
    try {
      const pub = await API.req('/tournaments/' + id + '/public', { auth: !(j && j.guestToken), guestToken: j && j.guestToken });
      const mine = (j && j.name) || uname() || null;
      const myRow = mine ? pub.standings.find((s) => s.name === mine) : null;
      if (notify) notifyFinished(tname, pub, myRow); // live finish → alert (sound/OS/banner), gated by the bell pref
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
      $('#back').addEventListener('click', navBack);
    } catch (e) {
      root.classList.remove('results');
      root.innerHTML = `<div class="card"><p class="gate-error">${esc(e.message)}</p><button class="btn btn-sm btn-ghost" id="back" style="width:100%">← Volver</button></div>`;
      $('#back').addEventListener('click', navBack);
    }
  }

  // ---- account: add/change email ----------------------------------------
  async function renderAccountScreen() {
    stopPoll();
    root.classList.remove('results');
    root.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2 style="margin:0">Mi cuenta</h2>
          <button class="btn btn-sm btn-ghost" id="back" type="button">← Volver</button>
        </div>
        <div id="ac-body" class="muted" style="margin-top:10px">Cargando…</div>
      </div>`;
    $('#back').addEventListener('click', navBack);
    let cur = null;
    try { const me = await API.req('/auth/me'); cur = me.user.email || null; } catch (e) {}
    const body = $('#ac-body'); body.classList.remove('muted');
    body.innerHTML = `
      <p style="font-size:13px;margin:0 0 12px">Correo actual: <b>${cur ? esc(cur) : 'sin correo'}</b><br>
        <span class="muted" style="font-size:12px">Se usa para restablecer tu contraseña.</span></p>
      <div class="gate-field"><label>${cur ? 'Nuevo correo' : 'Agregar correo'}</label><input type="text" id="ac-email" autocomplete="email" autocapitalize="none" spellcheck="false" value="${cur ? esc(cur) : ''}"></div>
      <div class="gate-field"><label>Contraseña actual</label><input type="password" id="ac-pass" autocomplete="current-password"></div>
      <div class="gate-error" id="ac-error"></div>
      <button class="btn btn-gold" id="ac-save" type="button" style="width:100%">Guardar correo</button>`;
    $('#ac-save').addEventListener('click', async () => {
      const err = $('#ac-error'); err.textContent = '';
      const email = $('#ac-email').value.trim();
      const password = $('#ac-pass').value;
      if (!email) { err.textContent = 'Escribe un correo.'; return; }
      if (!password) { err.textContent = 'Ingresa tu contraseña actual.'; return; }
      const btn = $('#ac-save'); btn.disabled = true;
      try {
        await API.req('/auth/email', { method: 'POST', body: { email, password } });
        body.innerHTML = '<p style="font-size:14px;margin:0">✅ Tu correo se actualizó.</p>';
      } catch (e) { err.textContent = e.message || 'No se pudo guardar.'; btn.disabled = false; }
    });
  }

  // ---- Mis Decks (#84 / #102) -------------------------------------------
  // The account saves up to 5 decks. The backend calls the external decks API which
  // renders the deck image + cover and persists them to cloud storage; we only show
  // the returned URLs. The cover picker's thumbnails are loaded client-side straight
  // from ygoprodeck's cropped artwork (no server processing).
  const YGO_ART = 'https://images.ygoprodeck.com/images/cards_cropped/'; /**
   * Renders the deck management screen.
   */

  async function renderMyDecks() {
    stopPoll(); root.classList.remove('results');
    root.innerHTML = `<div class="card">
        <div class="row scr-head">
          <h2 class="scr-h2">Mis Decks</h2>
          <button class="btn btn-sm btn-ghost" id="back" type="button">← Volver</button>
        </div>
        <div id="md-body" class="muted md-body">Cargando…</div>
      </div>`;
    $('#back').addEventListener('click', navBack);
    API.req('/decks/prewarm').catch(() => {});   // wake the cold-starting image API while the user is here
    reloadDecks();
  }

  /**
   * Reloads the saved decks list and deck creation form.
   */
  async function reloadDecks() {
    const body = $('#md-body'); if (!body) return;
    let data;
    try { data = await API.req('/decks'); } catch (e) { body.classList.add('muted'); body.textContent = 'No se pudo cargar tus decks.'; return; }
    body.classList.remove('muted');
    const max = data.max || 5;
    const decks = data.decks || [];
    const full = decks.length >= max;
    body.innerHTML = `
      <div class="muted md-count">${decks.length}/${max} decks · pega un ydke o código de Omega y genera su imagen.</div>
      ${full ? `<div class="gate-error md-max">Llegaste al máximo (${max}). Borra uno para agregar otro.</div>` : `
        <div class="gate-field"><label>Nombre del deck</label><input type="text" id="md-name" maxlength="60" placeholder="Ej.: Branded Despia"></div>
        <div class="gate-field"><label>Decklist (ydke / Omega)</label><textarea class="md-deck-input" id="md-deck" rows="3" placeholder="ydke://..."></textarea></div>
        <div class="gate-error" id="md-err"></div>
        <button class="btn btn-gold btn-block" id="md-save" type="button">Generar y guardar</button>`}
      <div class="md-list">
        ${decks.map((d) => deckCard(d)).join('') || '<div class="muted md-empty">Aún no tienes decks guardados.</div>'}
      </div>`;

    const save = $('#md-save');
    if (save) save.addEventListener('click', async () => {
      const deck = ($('#md-deck').value || '').trim();
      const name = ($('#md-name').value || '').trim();
      const err = $('#md-err'); err.textContent = '';
      if (!deck) { err.textContent = 'Pega un decklist (ydke o código de Omega).'; return; }
      save.disabled = true; const orig = save.textContent; save.textContent = 'Generando imagen… (puede tardar la 1ª vez)';
      try { await API.req('/decks', { method: 'POST', body: { deck, name } }); showToast('Deck guardado.'); reloadDecks(); }
      catch (e) { err.textContent = e.message || 'No se pudo guardar.'; save.disabled = false; save.textContent = orig; }
    });

    body.querySelectorAll('[data-deck]').forEach((el) => {
      const id = Number(el.dataset.deck);
      el.querySelector('[data-act="edit"]').addEventListener('click', () => navOpen(() => renderDeckEdit(id)));
      el.querySelector('[data-act="del"]').addEventListener('click', () => {
        const acts = el.querySelector('[data-acts]');
        acts.innerHTML = '<button class="btn btn-danger btn-sm" data-yes>Sí, borrar</button><button class="btn btn-sm btn-ghost" data-no>Cancelar</button>';
        acts.querySelector('[data-no]').addEventListener('click', () => reloadDecks());
        acts.querySelector('[data-yes]').addEventListener('click', async () => {
          try { await API.req('/decks/' + id, { method: 'DELETE' }); showToast('Deck borrado.'); reloadDecks(); }
          catch (e) { showToast(e.message || 'No se pudo borrar.', true); }
        });
      });
    });
  }

  /**
   * Renders a deck card.
   * @param {Object} d - Deck data.
   * @return {string} The deck card HTML.
   */
  function deckCard(d) {
    const cover = d.cover_url ? `<img class="cover" src="${esc(d.cover_url)}" alt="">` : '<div class="cover"></div>';
    return `<div class="deck-card" data-deck="${d.id}">
      ${cover}
      <b class="name">${esc(d.name || 'Deck sin nombre')}</b>
      <div class="row acts" data-acts>
        <button class="btn btn-sm btn-ghost" data-act="edit">✎ Editar</button>
        <button class="btn btn-sm btn-danger" data-act="del" title="Borrar" aria-label="Borrar">🗑</button>
      </div>
    </div>`;
  }

  // Edit panel: cover + name (both editable in place), the deck image, and a
  // read-only decklist table. Re-fetches the deck on each render so it reflects
  /**
   * Renders the deck editing screen for a deck.
   * @param {number|string} deckId - The deck identifier.
   */
  async function renderDeckEdit(deckId) {
    stopPoll(); root.classList.remove('results');
    root.innerHTML = `<div class="card">
        <div class="row scr-head">
          <button class="btn btn-sm btn-ghost" id="back" type="button">← Volver</button>
          <h2 class="scr-title">Editar deck</h2>
          <span class="scr-spacer"></span>
        </div>
        <div id="de-body" class="muted de-body">Cargando…</div>
      </div>`;
    $('#back').addEventListener('click', navBack);
    let d;
    try { const data = await API.req('/decks'); d = (data.decks || []).find((x) => x.id === deckId); }
    catch (e) { const b = $('#de-body'); if (b) b.textContent = 'No se pudo cargar el deck.'; return; }
    if (!d) { showToast('Deck no encontrado.', true); navBack(); return; }
    const body = $('#de-body'); if (!body) return;
    body.classList.remove('muted');
    body.innerHTML = `
      <div class="de-hero">
        <button class="de-cover-btn" id="de-cover" type="button" title="Cambiar portada">
          ${d.cover_url ? `<img class="cover" src="${esc(d.cover_url)}" alt="">` : '<div class="cover empty"></div>'}
          <span class="badge">✎ Portada</span>
        </button>
        <div id="de-name-wrap" class="de-name-wrap"></div>
        <div class="muted de-hint">Toca la portada o el nombre para editarlos</div>
      </div>
      ${d.image_url ? `<div class="de-image"><img src="${esc(d.image_url)}" alt=""></div>` : ''}
      <div id="de-list" class="muted dl">Cargando lista…</div>`;
    $('#de-cover').addEventListener('click', () => navOpen(() => renderCoverPicker(d)));
    renderNameField(d);
    fillDeckList(deckId);
  }

  /**
   * Renders the deck name editor in the deck detail panel.
   * @param {Object} d - The deck being edited.
   * @param {number|string} d.id - The deck identifier.
   * @param {string} [d.name] - The current deck name.
   */
  function renderNameField(d) {
    const wrap = $('#de-name-wrap'); if (!wrap) return;
    const show = () => {
      wrap.innerHTML = `<button class="de-name-btn" id="de-name-btn" type="button">
        <span>${esc(d.name || 'Deck sin nombre')}</span><span class="pen">✎</span></button>`;
      $('#de-name-btn').addEventListener('click', edit);
    };
    const edit = () => {
      wrap.innerHTML = `<div class="row de-name-edit">
        <input class="de-name-input" id="de-name-input" type="text" maxlength="60" value="${esc(d.name || '')}">
        <button class="btn btn-sm btn-gold" id="de-name-save" type="button">✓</button>
        <button class="btn btn-sm btn-ghost" id="de-name-cancel" type="button">✕</button></div>`;
      const inp = $('#de-name-input'); inp.focus();
      $('#de-name-cancel').addEventListener('click', show);
      $('#de-name-save').addEventListener('click', async () => {
        const name = (inp.value || '').trim();
        if (!name) { showToast('Ponle un nombre al deck.', true); inp.focus(); return; }
        try { const u = await API.req('/decks/' + d.id, { method: 'PATCH', body: { name } }); d.name = u.name; showToast('Nombre actualizado.'); show(); }
        catch (e) { showToast(e.message || 'No se pudo renombrar.', true); }
      });
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('#de-name-save').click(); });
    };
    show();
  }

  /**
   * Loads the read-only deck list into the deck detail panel.
   * @param {number|string} deckId - The deck identifier.
   * @param {HTMLElement} [el] - The deck list container.
   */
  async function fillDeckList(deckId) {
    const el = $('#de-list'); if (!el) return;
    let cards;
    try { const r = await API.req('/decks/' + deckId + '/cards'); cards = r.decks || {}; }
    catch (e) { el.textContent = 'No se pudo cargar la lista.'; return; }
    const names = await resolveCardNames([...(cards.main || []), ...(cards.extra || []), ...(cards.side || [])]);
    const section = (title, codes) => {
      if (!codes || !codes.length) return '';
      const groups = []; const at = new Map();
      for (const c of codes) { if (!at.has(c)) { at.set(c, groups.length); groups.push([c, 0]); } groups[at.get(c)][1]++; }
      const rows = groups.map(([c, q]) => `<div class="dl-row"><span class="q">${q}×</span><span>${esc(names[c] || ('#' + c))}</span></div>`).join('');
      return `<div class="dl-sec"><span>${title}</span><span class="ct">${codes.length} cartas</span></div>${rows}`;
    };
    el.classList.remove('muted');
    el.innerHTML = section('Main Deck', cards.main) + section('Extra Deck', cards.extra) + section('Side Deck', cards.side)
      || '<div class="muted">Sin cartas.</div>';
  }

  // Resolve passcodes → card names from ygoprodeck (CORS-enabled). Missing → '#code'.
  async function resolveCardNames(codes) {
    const uniq = [...new Set(codes)]; const map = {};
    if (!uniq.length) return map;
    try {
      const r = await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?id=' + uniq.join(','));
      if (r.ok) { const j = await r.json(); for (const c of (j.data || [])) map[c.id] = c.name; }
    } catch (e) {}
    return map;
  }

  /**
   * Lets the user choose a deck cover from the deck's cards.
   * @param {Object} d - The deck to update.
   * @param {string|number} d.id - The deck identifier.
   * @param {string|number} d.cover_passcode - The current cover card code.
   */
  async function renderCoverPicker(d) {
    stopPoll(); root.classList.remove('results');
    root.innerHTML = `<div class="card">
      <div class="row scr-head">
        <h2 class="scr-title">Elegir portada</h2>
        <button class="btn btn-sm btn-ghost" id="back" type="button">← Volver</button>
      </div>
      <div class="muted cp-hint">Toca una carta del deck para usar su arte como portada.</div>
      <div id="cp-body" class="muted cp-body">Cargando cartas…</div>
    </div>`;
    $('#back').addEventListener('click', navBack);
    let cards;
    try { const r = await API.req('/decks/' + d.id + '/cards'); cards = r.decks || {}; }
    catch (e) { $('#cp-body').textContent = e.message || 'No se pudieron cargar las cartas.'; return; }
    const codes = [...new Set([...(cards.main || []), ...(cards.extra || []), ...(cards.side || [])])];
    const names = await resolveCardNames(codes); // name the options for screen readers
    const body = $('#cp-body'); body.classList.remove('muted');
    body.innerHTML = `<div class="cp-grid">
      ${codes.map((c) => { const nm = names[c] || ('carta ' + c); return `<button class="cp-card${d.cover_passcode === c ? ' sel' : ''}" data-code="${c}" type="button" aria-label="Usar ${esc(nm)} como portada">
        <img src="${YGO_ART}${c}.jpg" alt="${esc(names[c] || '')}" loading="lazy"></button>`; }).join('')}
    </div>`;
    body.querySelectorAll('.cp-card').forEach((b) => b.addEventListener('click', async () => {
      body.querySelectorAll('.cp-card').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      try { await API.req('/decks/' + d.id + '/cover', { method: 'PUT', body: { cover: Number(b.dataset.code) } }); showToast('Portada actualizada.'); navBack(); }
      catch (e) { showToast(e.message || 'No se pudo cambiar la portada.', true); }
    }));
  }

  const RANK_ICON = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : (r ? '#' + r : '—'));

  // ---- leaderboard (Clasificación) --------------------------------------
  // Public Elo ranking for the CURRENT season (one calendar month). Account
  // players only; the viewer's own row is highlighted. Past seasons live in the
  // player's profile (not here), so the public board stays fresh & contestable.
  const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const monthLabel = (ym) => { const [y, m] = String(ym || '').split('-'); const i = parseInt(m, 10) - 1; return MONTHS_ES[i] ? MONTHS_ES[i] + ' ' + y : (ym || ''); };
  const dateLabel = (d) => { try { const dt = new Date(String(d).replace(' ', 'T')); return isNaN(dt) ? '' : dt.getDate() + ' ' + MONTHS_ES[dt.getMonth()].slice(0, 3); } catch { return ''; } };
  async function renderLeaderboard() {
    stopPoll();
    root.classList.remove('results');
    root.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2 style="margin:0">🏆 Clasificación</h2>
          <button class="btn btn-sm btn-ghost" id="back" type="button">← Volver</button>
        </div>
        <div class="muted" id="lb-season" style="font-size:12.5px;margin:4px 0 12px">Temporada</div>
        <div id="lb-body" class="muted">Cargando…</div>
      </div>`;
    $('#back').addEventListener('click', navBack);
    try {
      const data = await API.req('/leaderboard', { auth: false });
      const seasonEl = $('#lb-season'); if (seasonEl) seasonEl.textContent = 'Temporada · ' + monthLabel(data.month);
      const me = (uname() || '').toLowerCase();
      const body = $('#lb-body'); body.classList.remove('muted');
      if (!data.players.length) {
        body.innerHTML = '<p class="muted" style="font-size:13px;text-align:center;padding:18px 0">Aún no hay partidas suficientes esta temporada.<br>Juega torneos con tu cuenta y aparecerás aquí.</p>';
        return;
      }
      body.innerHTML = '<table class="lb-table"><thead><tr><th></th><th>Jugador</th><th class="r">Rating</th><th class="r">W-L</th></tr></thead><tbody>'
        + data.players.map((p) => `
          <tr class="${me && p.username.toLowerCase() === me ? 'lb-me' : ''}">
            <td class="lb-rank">${medal(p.rank)}</td>
            <td class="lb-name">${esc(p.username)}</td>
            <td class="lb-rating">${p.rating}</td>
            <td class="lb-rec">${p.wins}-${p.losses}</td>
          </tr>`).join('') + '</tbody></table>';
    } catch (e) {
      const body = $('#lb-body'); body.classList.remove('muted');
      body.innerHTML = `<p class="gate-error">${esc(e.message)}</p>`;
    }
  }

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
    $('#back').addEventListener('click', navBack);
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
      let elo = null; try { elo = await API.req('/me/elo'); } catch (e) {} // best-effort Elo detail
      let dstats = null; try { dstats = await API.req('/me/deck-stats'); } catch (e) {} // best-effort deck stats (#108)

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

      // Elo — a tappable banner (rank + rating, or "te faltan N partidas" if not yet
      // ranked) that opens the season match history; plus a past-seasons recap.
      if (elo) {
        const countedN = (elo.matches || []).filter((m) => m.counted).length;
        const minG = elo.minGames || 3;
        const hasMatches = (elo.matches || []).length > 0;
        let inner;
        if (elo.current) {
          inner = `<span class="pf-elo-rank">${RANK_ICON(elo.current.rank)}</span><span class="pf-elo-rating">${elo.current.rating}</span><span class="pf-elo-cap">Rating Elo · ${elo.current.wins}-${elo.current.losses}</span>`;
        } else {
          const need = Math.max(1, minG - countedN);
          inner = `<span class="pf-elo-rank">📊</span><span class="pf-elo-need">Te falta${need === 1 ? '' : 'n'} ${need} partida${need === 1 ? '' : 's'} para entrar al ranking</span>`;
        }
        html += `<div class="pf-sec-title">Clasificación · ${esc(monthLabel(elo.season))}</div>`;
        html += `<button class="pf-elo-now" id="elo-open" type="button"${hasMatches ? '' : ' disabled'}>${inner}${hasMatches ? '<span class="pf-elo-go">Ver partidas ›</span>' : ''}</button>`;
        if (elo.pastSeasons && elo.pastSeasons.length) {
          html += '<div class="pf-sec-title">Temporadas pasadas</div><div class="pf-seasons">'
            + elo.pastSeasons.map((s) => `<div class="pf-season"><span class="pf-season-m">${esc(monthLabel(s.month))}</span><span class="pf-season-r">${RANK_ICON(s.rank)} · ${s.rating}</span></div>`).join('')
            + '</div>';
        }
      }

      // Deck stats teaser (#108): a tap into the full sub-screen. Shown for ANY
      // successful /me/deck-stats response — rich (favourite deck) when there's one
      // this season, otherwise a generic CTA so the entry never disappears.
      if (dstats) {
        const f = dstats.favorite;
        html += '<div class="pf-sec-title">Mis decks</div>';
        html += `<button id="deckstats-open" class="ds-teaser" type="button">
          <img class="cover" src="${f && f.coverUrl ? esc(f.coverUrl) : MYSTERY_COVER}" alt="">
          <span class="meta">
            <span class="kicker">${f ? 'Deck preferido' : 'Estadísticas de decks'}</span>
            <b class="name">${f ? esc(f.name || 'Deck') : 'Ver mis estadísticas'}</b>
            <span class="sub">${f ? `Jugado ${f.played}× · <b>${f.winrate}%</b> WR` : 'Deck preferido, cartas y winrate por temporada'}</span>
          </span>
          <span class="go">Ver stats ›</span>
        </button>`;
      }

      // Head-to-head: proportional win/loss bar per opponent, colour-coded.
      if (st.headToHead.length) {
        html += '<div class="pf-sec-title">Cara a cara</div><div class="pf-h2h">';
        html += st.headToHead.map((h) => {
          const tot = h.wins + h.losses;
          const wpct = tot ? Math.round((h.wins / tot) * 100) : 0;
          const cls = h.wins > h.losses ? 'pos' : h.wins < h.losses ? 'neg' : '';
          return `<div class="pf-opp">
            <div class="pf-opp-top"><span class="pf-opp-name">${esc(h.username)}</span><span class="pf-opp-rec ${cls}">${h.wins}-${h.losses} (${wpct}%)</span></div>
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
      b.querySelectorAll('.pf-tourney').forEach((el) => el.addEventListener('click', () => navOpen(() => showResults(Number(el.dataset.id), null, () => renderProfile()))));
      const eo = b.querySelector('#elo-open'); if (eo && !eo.disabled) eo.addEventListener('click', () => navOpen(() => renderEloDetail(elo)));
      const dso = b.querySelector('#deckstats-open'); if (dso) dso.addEventListener('click', () => navOpen(() => renderDeckStats()));

      // Animate after the initial (empty) frame paints: ring fills clockwise, bars grow.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        const prog = b.querySelector('#pf-prog');
        if (prog) prog.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(2);
        b.querySelectorAll('.pf-bar-w, .pf-bar-l').forEach((bar) => { bar.style.width = bar.dataset.w + '%'; });
      }));
    } catch (e) { const b = $('#body'); if (b) { b.classList.add('muted'); b.textContent = e.message; } }
  }

  // Full deck-stats sub-screen (#108): season selector, favourite deck, a summary,
  // and the top cards by play count / winrate. Card names/art resolved client-side.
  let _dsRender = 0; // monotonic token: a newer render (e.g. season change) invalidates older async writes
  async function renderDeckStats(season) {
    stopPoll(); root.classList.remove('results');
    const token = ++_dsRender;
    root.innerHTML = `<div class="card">
        <div class="row scr-head">
          <button class="btn btn-sm btn-ghost" id="back" type="button">← Volver</button>
          <h2 class="scr-title">Mis estadísticas</h2>
          <span class="scr-spacer"></span>
        </div>
        <div id="ds-body" class="muted ds-body">Cargando…</div>
      </div>`;
    $('#back').addEventListener('click', navBack);
    let data;
    try { data = await API.req('/me/deck-stats' + (season ? '?season=' + encodeURIComponent(season) : '')); }
    catch (e) { if (token === _dsRender) { const x = $('#ds-body'); if (x) x.textContent = 'No se pudieron cargar tus estadísticas.'; } return; }
    if (token !== _dsRender) return; // a newer render started while we awaited
    const codes = [...new Set([...(data.topPlayed || []).map((c) => c.code), ...(data.topWinrate || []).map((c) => c.code)])];
    const names = await resolveCardNames(codes);
    if (token !== _dsRender) return;
    const body = $('#ds-body'); if (!body) return; body.classList.remove('muted');
    const ART = 'https://images.ygoprodeck.com/images/cards_cropped/';
    const seasons = (data.seasons && data.seasons.length) ? data.seasons : [data.season];
    const seasonSel = seasons.length > 1
      ? `<select id="ds-season" class="ds-season">${seasons.map((s) => `<option value="${s}"${s === data.season ? ' selected' : ''}>${esc(monthLabel(s))}</option>`).join('')}</select>`
      : `<span class="ds-season">${esc(monthLabel(data.season))}</span>`;
    if (!data.summary || !data.summary.matches) {
      body.innerHTML = `<div class="ds-season-row">${seasonSel}</div>
        <p class="muted ds-empty">Aún no tienes partidas clasificatorias esta temporada.<br>Juega torneos ranked con un deck y tus estadísticas aparecerán aquí.</p>`;
      const s0 = $('#ds-season'); if (s0) s0.addEventListener('change', () => renderDeckStats(s0.value));
      return;
    }
    const f = data.favorite || {};
    const sum = data.summary;
    const cardRow = (i, code, right) => `<div class="ds-card">
        <span class="rank">${i}</span>
        <img class="art" src="${ART}${code}.jpg" alt="" loading="lazy">
        <span class="name">${esc(names[code] || ('#' + code))}</span>
        ${right}
      </div>`;
    body.innerHTML = `
      <div class="ds-season-row">${seasonSel}</div>
      <div class="ds-section">Deck preferido</div>
      <div class="ds-fav">
        <img class="cover" src="${f.coverUrl ? esc(f.coverUrl) : MYSTERY_COVER}" alt="">
        <div class="body">
          <div class="name">${esc(f.name || 'Deck')}</div>
          <div class="sub">Jugado <b>${f.played || 0}×</b> · <b>${f.winrate || 0}%</b> de victorias</div>
        </div>
      </div>
      <div class="ds-summary">
        <div class="ds-stat"><div class="v">${sum.tournaments}</div><div class="k">Torneos</div></div>
        <div class="ds-stat"><div class="v">${sum.matches}</div><div class="k">Partidas</div></div>
        <div class="ds-stat"><div class="v win">${sum.winrate}%</div><div class="k">Winrate</div></div>
      </div>
      ${(data.topPlayed || []).length ? `<div class="ds-section">Top 5 · cartas más jugadas</div>
        ${data.topPlayed.map((c, i) => cardRow(i + 1, c.code, `<span class="plays">${c.matches}×</span>`)).join('')}` : ''}
      ${(data.topWinrate || []).length ? `<div class="ds-section">Top 5 · mejor winrate</div>
        ${data.topWinrate.map((c, i) => cardRow(i + 1, c.code, `<span class="wr"><span class="bar"><i style="width:${c.winrate}%"></i></span><span class="pct">${c.winrate}%</span></span>`)).join('')}` : ''}
      <div class="ds-foot">Calculado con tus torneos clasificatorios de esta temporada.</div>`;
    const sel = $('#ds-season'); if (sel) sel.addEventListener('change', () => renderDeckStats(sel.value));
  }

  // Season match history (opened from the profile's Elo banner). One card per game:
  // opponent + tournament/date, with the ±Elo on the right (green/red, colour-bordered).
  // Games that didn't count show a short grey note (BYE / Sin rival / …) and no number.
  const ELO_NOTE = { bye: 'BYE', lateLoss: 'Entrada tardía', doubleLoss: 'Doble derrota', guest: 'Sin rival', other: 'No cuenta' };
  function renderEloDetail(elo) {
    stopPoll();
    root.classList.remove('results');
    const cards = (elo.matches || []).slice().reverse().map((mt) => {
      const sub = [mt.tournament, dateLabel(mt.date)].filter(Boolean).join(' · ');
      if (mt.counted) {
        const cls = mt.delta >= 0 ? 'win' : 'loss';
        return `<div class="pf-match ${cls}">
          <span class="pf-match-main"><span class="pf-match-opp">${esc(mt.opponent)}</span><span class="pf-match-sub">${esc(sub)}</span></span>
          <span class="pf-match-delta ${mt.delta >= 0 ? 'pos' : 'neg'}">${mt.delta >= 0 ? '+' : ''}${mt.delta}</span>
        </div>`;
      }
      const note = ELO_NOTE[mt.reason] || 'No cuenta';
      const main = mt.opponent || note;
      return `<div class="pf-match nc">
        <span class="pf-match-main"><span class="pf-match-opp">${esc(main)}</span><span class="pf-match-sub">${esc(sub)}</span></span>
        ${mt.opponent ? `<span class="pf-match-note">${esc(note)}</span>` : ''}
      </div>`;
    }).join('');
    root.innerHTML = `
      <div class="card">
        <div class="row" style="justify-content:space-between;align-items:center">
          <h2 style="margin:0">Historial · ${esc(monthLabel(elo.season))}</h2>
          <button class="btn btn-sm btn-ghost" id="back" type="button">← Volver</button>
        </div>
        <div class="muted" style="font-size:12.5px;margin:4px 0 12px">Cómo cambió tu rating, partida por partida.</div>
        <div class="pf-matches">${cards || '<p class="muted" style="text-align:center;padding:18px 0">Sin partidas esta temporada.</p>'}</div>
      </div>`;
    $('#back').addEventListener('click', navBack);
  }

  // Small personal summary under the live pairing box: this player's decided
  // matches in THIS tournament (round · opponent · result) + a running W-L.
  const H_LABEL = { win: 'Ganaste', loss: 'Perdiste', bye: 'BYE', lateLoss: 'Entrada tardía', doubleLoss: 'Doble derrota' };
  /**
   * Builds the match history block for a player.
   * @param {Object} me - Player data containing match history.
   * @return {string} The rendered history HTML, or an empty string when no history exists.
   */
  function historyBlock(me) {
    const h = me.history || [];
    if (!h.length) return '';
    const W = h.filter((x) => x.outcome === 'win' || x.outcome === 'bye').length;
    const L = h.length - W;
    const rows = h.map((x) => {
      const cls = x.outcome === 'bye' ? 'neutral' : (x.outcome === 'win' ? 'win' : 'loss');
      const who = x.opponent ? esc(x.opponent) : (x.outcome === 'bye' ? 'Descanso' : 'Sin rival');
      return `<div class="mh-row">
          <span class="r">R${x.round}</span>
          <span class="who">${who}</span>
          <span class="out ${cls}">${H_LABEL[x.outcome] || ''}</span>
        </div>`;
    }).join('');
    return `<div class="mh">
        <div class="mh-head">
          <span class="muted mh-title">Tu historial</span>
          <span class="mh-rec"><span class="w">${W}</span><span class="muted">-</span><span class="l">${L}</span></span>
        </div>${rows}
      </div>`;
  }

  function renderPairing(j, me) {
    root.classList.remove('results');
    let body;
    if (me.status === 'finished') {
      body = `<div class="big">🏁 Torneo finalizado</div><p class="muted">¡Gracias por jugar!</p>`;
      stopPoll();
    } else if (!me.pairing) {
      body = `<div class="big">✅ Inscrito</div><p class="muted">Espera a que el organizador inicie el torneo o genere la ronda.</p>`
        + (me.status === 'setup' ? `<button class="btn btn-sm btn-ghost" id="withdraw" style="margin-top:14px">Retirarme del torneo</button>` : '');
    } else if (me.pairing.lateLoss) {
      body = `<div class="round">Ronda ${me.currentRound} de ${me.maxRounds}</div><div class="big">Entrada tardía</div><p class="muted">Recibes una derrota administrativa esta ronda. Te emparejan desde la próxima.</p>`;
    } else if (me.pairing.isBye) {
      body = `<div class="round">Ronda ${me.currentRound} de ${me.maxRounds}</div><div class="big">Descansas (BYE)</div><p class="muted">Ganas la ronda automáticamente.</p>`;
    } else {
      const p = me.pairing, rep = p.report;
      let controls;
      if (p.reported) {
        controls = `<span class="pill pill-ok">Resultado registrado ✓</span>`;
      } else if (rep && rep.confirmed) {
        controls = `<span class="pill pill-ok">Confirmado ✓</span><p class="muted" style="font-size:12px;margin-top:8px">El organizador lo registrará en un momento.</p>`;
      } else if (rep && rep.mine) {
        controls = `<span class="pill pill-pend">Esperando confirmación</span><p class="muted" style="font-size:12px;margin-top:8px">Reportaste ${rep.doubleLoss ? 'doble derrota' : 'tu victoria'}. Tu rival debe confirmar.</p>`;
      } else if (rep && !rep.mine) {
        const claim = rep.doubleLoss ? '<b>doble derrota</b> (nadie gana)' : `que ganó <b>${esc(p.opponent || 'tu rival')}</b>`;
        controls = `<p class="muted" style="font-size:13px;margin-bottom:10px">Tu rival reportó ${claim}. ¿Es correcto?</p>
          <div class="row" style="gap:8px;justify-content:center">
            <button class="btn btn-gold btn-sm" id="rep-confirm">Confirmar</button>
            <button class="btn btn-sm btn-ghost" id="rep-reject">No</button></div>`;
      } else {
        controls = `<p class="muted" style="font-size:13px;margin-bottom:10px">Al terminar la partida, reporta el resultado:</p>
          <div class="row" style="gap:8px;justify-content:center">
            <button class="btn btn-gold btn-sm" id="rep-win">Gané</button>
            <button class="btn btn-sm btn-ghost" id="rep-dl">Doble derrota</button></div>`;
      }
      body = `<div class="round">Ronda ${me.currentRound} de ${me.maxRounds}</div>
              <div class="big">Mesa ${p.table}</div>
              <div class="vs">vs <b>${esc(p.opponent || '—')}</b></div>
              <div style="margin-top:14px">${controls}</div>`;
    }
    root.innerHTML = `
      <div class="card" style="text-align:center">
        <div class="muted" style="font-size:13px">${esc(me.name || '')}</div>
        <div class="muted" style="font-size:12px;margin-bottom:14px">Jugando como <b>${esc(j.name)}</b></div>
        ${body}
        ${historyBlock(me)}
        <button class="btn btn-sm btn-ghost" id="leave" style="margin-top:20px">Salir</button>
      </div>
      <style>
        #player .big{ font-size:34px; font-weight:800; margin:6px 0; color:var(--gold); }
        #player .round{ color:var(--ink-soft); font-size:13px; letter-spacing:.4px; text-transform:uppercase; }
        #player .vs{ font-size:18px; color:var(--ink); }
      </style>`;
    $('#leave').addEventListener('click', () => { setJoined(null); navReset(); renderJoin(); });
    // Player-driven result reporting: winner reports, opponent confirms. Each action
    // hits the server (which validates identity + match), then we re-poll to refresh.
    const sendReport = async (path, payload) => {
      try { await API.req('/tournaments/' + j.id + path, { method: 'POST', auth: !j.guestToken, guestToken: j.guestToken, body: payload }); }
      catch (e) { showToast(e.message || 'No se pudo enviar.', true); return; }
      poll();
    };
    const bindRep = (id, fn) => { const el = $('#' + id); if (el) el.addEventListener('click', fn); };
    bindRep('rep-win', () => sendReport('/report', { outcome: 'win' }));
    bindRep('rep-dl', () => sendReport('/report', { outcome: 'doubleLoss' }));
    bindRep('rep-confirm', () => sendReport('/report/confirm', { accept: true }));
    bindRep('rep-reject', () => sendReport('/report/confirm', { accept: false }));
    // Withdraw (setup only): deletes MY registration; the TO console reconciles the
    // roster removal (#72). Inline confirm — "Salir" above only leaves the view.
    const wd = $('#withdraw');
    if (wd) wd.addEventListener('click', () => {
      wd.outerHTML = '<div class="row" style="gap:8px;justify-content:center;margin-top:14px">'
        + '<button class="btn btn-gold btn-sm" id="wd-yes">Sí, retirarme</button>'
        + '<button class="btn btn-sm btn-ghost" id="wd-no">Cancelar</button></div>';
      $('#wd-no').addEventListener('click', () => renderPairing(j, me));
      $('#wd-yes').addEventListener('click', async () => {
        try { await API.req('/tournaments/' + j.id + '/registration', { method: 'DELETE', auth: !j.guestToken, guestToken: j.guestToken }); }
        catch (e) { showToast(e.message || 'No se pudo retirar.', true); return; }
        setJoined(null); navReset(); renderJoin();
        showToast('Te retiraste del torneo.');
      });
    });
  }

  function startPoll() { stopPoll(); _lastRound = -1; _pollInFlight = false; _seenInEvent = false; poll(); pollTimer = setInterval(poll, 4000); }
  function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && joined()) poll(); });

  // ---- theme (light/dark) -----------------------------------------------
  // Reuses the console's mechanism: the 'ygo_theme' key + [data-theme="light"]
  // on <html> (the FOUC script in the page head already applies it on load).
  function applyTheme(theme) {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }
  // Shared fixed cluster (top-right) for the page's toggles — both mount here so
  // they line up via flex gap instead of independent fixed offsets.
  function uControls() {
    let c = document.getElementById('u-controls');
    if (!c) { c = document.createElement('div'); c.id = 'u-controls'; c.className = 'u-controls'; document.body.appendChild(c); }
    return c;
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
    uControls().appendChild(btn);
  }

  // ---- notifications toggle (bell) --------------------------------------
  // A one-press mute switch for round/finish alerts. Standard affordance: a solid
  // gold bell when ON; desaturated + a red slash when OFF. Enabling it (re)primes
  // OS permission/audio within the click gesture.
  function mountNotifToggle() {
    if (document.getElementById('notif-toggle')) return;
    const btn = document.createElement('button');
    btn.className = 'notif-switch u-notif'; btn.id = 'notif-toggle'; btn.type = 'button';
    btn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path class="bell" d="M12 2a6 6 0 0 0-6 6v3.6L4.3 15A1 1 0 0 0 5.2 16.5h13.6A1 1 0 0 0 19.7 15L18 11.6V8a6 6 0 0 0-6-6Zm0 20a2.8 2.8 0 0 0 2.8-2.8H9.2A2.8 2.8 0 0 0 12 22Z"/><line class="slash" x1="4" y1="4" x2="20" y2="20"/></svg>';
    const sync = () => {
      const on = notifEnabled();
      btn.classList.toggle('off', !on);
      btn.title = on ? 'Notificaciones activadas — toca para silenciar' : 'Notificaciones silenciadas — toca para activar';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', String(on));
    };
    btn.addEventListener('click', () => {
      const next = !notifEnabled();
      try { localStorage.setItem('ygo_notif', next ? '1' : '0'); } catch {}
      if (next) primeNotifications();   // enabling: unlock audio + request OS permission within this gesture
      sync();
      if (next) showBanner('Notificaciones activadas', 'Te avisaremos cuando empiece tu ronda.');
    });
    sync();
    uControls().prepend(btn);   // bell sits left of the theme toggle
  }

  // ---- boot --------------------------------------------------------------
  mountThemeToggle();
  mountNotifToggle();
  // Prime audio + notification permission on the first user gesture, regardless of
  // how the player entered (join-by-code, resume, deep link). Each fires once.
  document.addEventListener('pointerdown', primeNotifications, { once: true });
  document.addEventListener('keydown', primeNotifications, { once: true });

  // An organizer administers; they don't play — so a TO must never sit on /u/.
  // The stored role can be stale right after an upgrade (a freshly-promoted player
  // was last seen as 'player'), so re-check with the server and, if this account is
  // an organizer, send them to the console (/). Guests/players stay. Mirror of the
  // console's applyView(), which routes players/guests the other way (→ /u/).
  async function routeIfOrganizer() {
    let tok = null; try { tok = localStorage.getItem('ygo_token'); } catch {}
    if (!tok) return false;                     // guest / no account → stays on /u/
    try {
      const r = await API.me();
      const role = r && r.user && r.user.role;
      if (role) { try { localStorage.setItem('ygo_role', role); } catch {} } // keep stored role fresh
      if (role === 'to' || role === 'casual') { location.replace('/'); return true; } // any organizer → console
    } catch (e) { console.warn('[u] role check failed, staying on /u/:', e && e.message); /* offline or expired session: staying here is the safe fallback (players use /u/) */ }
    return false;
  }

  // A shared link (/u/?torneo=CODE, also ?code= / #CODE) opens that tournament's
  // detail card automatically; otherwise show the join screen.
  (async () => {
    if (await routeIfOrganizer()) return;       // organizer → bounced to the console
    const _sp = new URLSearchParams(location.search);
    const pre = (_sp.get('code') || _sp.get('torneo') || location.hash.replace('#', '')).toUpperCase();
    // The deep-link code has served its purpose once captured — strip it from the URL
    // so a later refresh behaves like a plain /u/ visit (resume an active join, or home)
    // instead of re-opening that tournament's card.
    if (location.search || location.hash) { try { history.replaceState(null, '', location.pathname); } catch (e) {} }
    if (joined()) startPoll();
    else if (pre.length === 5) openByCode(pre);
    else renderJoin(null, pre);
  })();
})();
