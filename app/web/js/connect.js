/* SwissYGO connected-mode layer (Phase A: landing gate + account control).
 * Classic script loaded AFTER app.js, so offline behavior is untouched: this only
 * gates entry and adds a header control. Guest → today's offline console.
 * Reuses existing styles (.modal-overlay/.modal, nav.tabs, .btn*). */
(function () {
  const LS_GUEST = 'ygo_guest';
  const LS_USER = 'ygo_username';

  const hasSession = () => !!API.token.get();
  const isGuest = () => { try { return localStorage.getItem(LS_GUEST) === '1'; } catch { return false; } };
  const username = () => { try { return localStorage.getItem(LS_USER) || ''; } catch { return ''; } };
  const setGuest = (v) => { try { v ? localStorage.setItem(LS_GUEST, '1') : localStorage.removeItem(LS_GUEST); } catch {} };
  const setUser = (u) => { try { u ? localStorage.setItem(LS_USER, u) : localStorage.removeItem(LS_USER); } catch {} };

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
      ctl.innerHTML = `<span class="who">Hola, <b></b></span><button class="btn btn-sm btn-ghost" data-acc="logout">Salir</button>`;
      ctl.querySelector('b').textContent = username() || 'usuario';
    } else {
      ctl.innerHTML = `<span class="who">Invitado</span><button class="btn btn-sm btn-ghost" data-acc="login">Iniciar sesión</button>`;
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-acc]');
    if (!b) return;
    if (b.dataset.acc === 'logout') { API.token.clear(); setUser(''); setGuest(false); renderAccount(); showGate(); }
    if (b.dataset.acc === 'login') { setGuest(false); showGate(); }
  });

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
      setMode(t.dataset.gt, g);
    });
    g.querySelector('#gate-form').addEventListener('submit', (e) => { e.preventDefault(); submit(g); });
    g.querySelector('#gate-guest').addEventListener('click', () => { setGuest(true); closeGate(); renderAccount(); });
    setMode('login', g);
    setTimeout(() => g.querySelector('#gate-user').focus(), 60);
  }

  function setMode(m, g) {
    mode = m;
    g.querySelectorAll('#gate-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.gt === m));
    g.querySelector('#gate-email-wrap').hidden = m !== 'register';
    g.querySelector('#gate-submit').textContent = m === 'register' ? 'Crear cuenta' : 'Entrar';
    g.querySelector('#gate-pass').setAttribute('autocomplete', m === 'register' ? 'new-password' : 'current-password');
    g.querySelector('#gate-error').textContent = '';
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
      setGuest(false);
      closeGate();
      renderAccount();
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

  // ---- boot --------------------------------------------------------------
  renderAccount();
  if (!hasSession() && !isGuest()) showGate();
  else document.documentElement.classList.remove('gate-pending');
})();
