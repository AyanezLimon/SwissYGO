/* Thin fetch wrapper for the backend API. Same-origin in production (Caddy proxies
 * /api → Fastify); proxied by Vite in dev. JWT is kept in localStorage and sent as
 * a Bearer token. All networked features degrade gracefully when the API is absent. */

const TOKEN_KEY = 'ygo_token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = auth ? getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(data?.error || res.statusText, res.status);
  }
  return data;
}

/* Best-effort probe so the UI can decide whether connected-mode features are
 * available. Never throws. */
export async function backendAvailable() {
  try {
    const res = await fetch('/api/health', { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}
