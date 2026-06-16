/* Tiny fetch wrapper for the backend API (connected mode). Same-origin: Caddy
 * serves this static app and reverse-proxies /api to the Node service, so no
 * base URL is needed. JWT kept in localStorage. Everything degrades gracefully
 * when the API is absent (offline mode just never calls these). */
const TOKEN_KEY = 'ygo_token';

export const token = {
  get() { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } },
  set(v) { try { v ? localStorage.setItem(TOKEN_KEY, v) : localStorage.removeItem(TOKEN_KEY); } catch {} },
};

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const t = auth ? token.get() : null;
  if (t) headers.Authorization = `Bearer ${t}`;
  const res = await fetch(`/api${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

/* Is the backend reachable? Lets the UI show connected-mode features. Never throws. */
export async function backendAvailable() {
  try { return (await fetch('/api/health')).ok; } catch { return false; }
}
