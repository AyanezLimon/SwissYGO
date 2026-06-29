/* SwissYGO API client — tiny fetch wrapper + token store. Classic script (shares
 * global scope with app.js); exposes window.API. Same-origin: Caddy serves this
 * static app and reverse-proxies /api to the Node service. Everything degrades
 * gracefully when the API is absent (offline/guest never calls it). */
(function () {
  const TOKEN_KEY = 'ygo_token';

  const token = {
    get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
    set(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {} },
    clear() { this.set(null); },
  };

  async function req(path, { method = 'GET', body, auth = true, guestToken } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const t = auth ? token.get() : null;
    if (t) headers.Authorization = 'Bearer ' + t;
    if (guestToken) headers['X-Guest-Token'] = guestToken;
    const res = await fetch('/api' + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const err = new Error((data && data.error) || res.statusText);
      err.status = res.status;
      if (data && data.code) err.code = data.code;   // machine-readable hint (e.g. 'ranked_requires_account')
      if (data) err.data = data;                     // full payload (extra fields, e.g. name, violations)
      throw err;
    }
    return data;
  }

  window.API = {
    token,
    req,
    register(username, password, email) {
      return req('/auth/register', { method: 'POST', auth: false, body: { username, password, email } });
    },
    login(username, password) {
      return req('/auth/login', { method: 'POST', auth: false, body: { username, password } });
    },
    me() { return req('/auth/me'); },
    async available() { try { return (await fetch('/api/health')).ok; } catch { return false; } },
  };
})();
