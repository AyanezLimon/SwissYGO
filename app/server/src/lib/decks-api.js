/* Thin client for the external decks API (omega-api-decks) — just the `/parse`
 * call needed to read a saved deck's card codes server-side (for #109 legality).
 * The image/upload flow lives in routes/decks.js; this stays minimal. */

const API_URL = (process.env.DECKS_API_URL || '').replace(/\/+$/, '');
const API_TOKEN = process.env.DECKS_REQUEST_TOKEN || '';

/**
 * Determines whether the decks API is configured.
 * @return {boolean} `true` if both the API URL and request token are set, `false` otherwise.
 */
export function decksConfigured() { return !!(API_URL && API_TOKEN); }

/**
 * Parses a deck string into main, extra, and side card code lists.
 * @param {string} deckString - A deck string in `ydk`, `ydke`, or Omega code format.
 * @return {{ main: any[]; extra: any[]; side: any[] }} The parsed deck code lists.
 * @throws {Error} When the decks API is not configured or the API request fails.
 */
export async function parseDeckString(deckString) {
  if (!decksConfigured()) { const e = new Error('decks API not configured'); e.code = 'unconfigured'; throw e; }
  const q = '?' + new URLSearchParams({ token: API_TOKEN, list: deckString }).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000); // generous: the free host can cold-start
  try {
    const res = await fetch(API_URL + '/parse' + q, { signal: ctrl.signal });
    const text = await res.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    if (!res.ok || !data || data.success === false) throw new Error((data && (data.meta?.error || data.error)) || ('parse respondió ' + res.status));
    const d = (data.data && data.data.decks) || {};
    return { main: d.main || [], extra: d.extra || [], side: d.side || [] };
  } finally { clearTimeout(timer); }
}
