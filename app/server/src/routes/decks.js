/* Saved decks (#84 / #102). The account submits a deck string (ydke/omega); we call
 * the external decks API (DECKS_API_URL) — which renders the deck image + cover and
 * persists them to cloud storage — and keep ONLY the returned public URLs (no blobs).
 * Capped at MAX_DECKS per account. The external host is free/serverless and cold-starts,
 * so calls use a long timeout + one retry, and the UI pre-warms it (GET /decks/prewarm). */
import { requireAuth } from '../auth.js';

const MAX_DECKS = 5;
const API_URL = (process.env.DECKS_API_URL || '').replace(/\/+$/, '');
const API_TOKEN = process.env.DECKS_REQUEST_TOKEN || '';

/**
 * Registers deck management routes.
 */
export default async function deckRoutes(app) {
  const db = app.db;

  const rowOf = (r) => r && ({ id: r.id, name: r.name, format: r.format, deck_string: r.deck_string, image_url: r.image_url, cover_url: r.cover_url, cover_passcode: r.cover_passcode, created_at: r.created_at });
  const myDecks = (uid) => db.prepare('SELECT * FROM user_decks WHERE user_id = ? ORDER BY created_at DESC, id DESC').all(uid).map(rowOf);
  const deckById = (uid, id) => db.prepare('SELECT * FROM user_decks WHERE id = ? AND user_id = ?').get(id, uid);
  const guessFormat = (s) => (/^ydke:\/\//i.test(s) ? 'ydke' : 'omega');
  const q = (params) => '?' + new URLSearchParams({ token: API_TOKEN, ...params }).toString();

  // Best-effort GC of orphaned cloud images (#117): when a deck is deleted and its
  // image/cover is no longer referenced by ANY remaining user_decks row, ask the
  // external API to drop that blob from storage. Images are content-addressed by hash,
  // so the SAME url is shared across users/decks — we must never delete one another deck
  // (or a deck being saved RIGHT NOW with the same list) still references.
  //
  // A one-shot COUNT-then-DELETE is RACY: a concurrent save can re-associate the url
  // (same decklist → same hash → same blob) between the count and the external delete
  // landing, so we'd delete live content. Instead: wait a grace window, then RE-CHECK the
  // refcount immediately before deleting — a save within the window wins and we skip.
  // (Saves AFTER the window self-heal: the external API regenerates a missing blob on the
  // next save of that list. A durable periodic sweep is the planned backstop for the
  // residual in-flight window and for GCs lost to a container restart.)
  const GC_GRACE_MS = 5 * 60 * 1000;
  function gcOrphanImage(url, column) {
    if (!url || !API_URL || !API_TOKEN) return;
    const t = setTimeout(() => {
      try {
        if (db.prepare(`SELECT COUNT(*) AS n FROM user_decks WHERE ${column} = ?`).get(url).n > 0) return;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 60000);
        fetch(API_URL + '/deck-image' + q({ url }), { method: 'DELETE', signal: ctrl.signal })
          .catch(() => {}).finally(() => clearTimeout(timer));
      } catch { /* DB gone / shutting down — the periodic sweep will catch it */ }
    }, GC_GRACE_MS);
    if (t.unref) t.unref(); // don't keep the event loop alive for a best-effort cleanup
  }

  // Call the external decks API: long timeout + one retry (free host cold-start).
  async function decksApi(path) {
    if (!API_URL || !API_TOKEN) { const e = new Error('La generación de imágenes de deck no está configurada.'); e.code = 'unconfigured'; throw e; }
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), attempt === 0 ? 60000 : 120000);
      try {
        const res = await fetch(API_URL + path, { signal: ctrl.signal });
        clearTimeout(timer);
        const text = await res.text();
        let data = null; try { data = JSON.parse(text); } catch {}
        if (!res.ok || !data || data.success === false) throw new Error((data && (data.meta?.error || data.error)) || ('La API de decks respondió ' + res.status));
        return data.data || {};
      } catch (e) { clearTimeout(timer); last = e; }
    }
    throw last || new Error('No se pudo contactar la API de decks.');
  }

  // List my decks (+ the cap, so the UI can show "x/5").
  app.get('/api/decks', { preHandler: requireAuth }, async (req) => ({ decks: myDecks(req.user.id), max: MAX_DECKS }));

  // Wake the cold-starting external API — the UI calls this when "Mis Decks" opens.
  app.get('/api/decks/prewarm', { preHandler: requireAuth }, async () => {
    if (!API_URL) return { ok: false };
    try { const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000); await fetch(API_URL + '/', { signal: c.signal }); clearTimeout(t); } catch {}
    return { ok: true };
  });

  // Save a new deck → generate image (+ default cover) via the external API.
  app.post('/api/decks', { preHandler: requireAuth }, async (req, reply) => {
    const deck = String(req.body?.deck || '').trim();
    const name = String(req.body?.name || '').trim().slice(0, 60);
    const cover = (req.body?.cover != null && /^\d+$/.test(String(req.body.cover))) ? String(req.body.cover) : null;
    if (!deck) return reply.code(400).send({ error: 'Pega un decklist (ydke o código de Omega).' });
    const count = db.prepare('SELECT COUNT(*) AS n FROM user_decks WHERE user_id = ?').get(req.user.id).n;
    if (count >= MAX_DECKS) return reply.code(409).send({ error: `Máximo ${MAX_DECKS} decks. Borra uno para agregar otro.` });
    let data;
    try { data = await decksApi('/deck-image' + q(cover ? { list: deck, cover } : { list: deck })); }
    catch (e) { return reply.code(502).send({ error: e.message || 'No se pudo generar la imagen del deck.' }); }
    const info = db.prepare('INSERT INTO user_decks (user_id, name, deck_string, format, image_url, cover_url, cover_passcode) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, name, deck, guessFormat(deck), data.url || null, data.cover_url || null, cover ? Number(cover) : null);
    return reply.code(201).send(rowOf(deckById(req.user.id, info.lastInsertRowid)));
  });

  // The deck's card passcodes (main/extra/side) — feeds the cover picker UI.
  app.get('/api/decks/:id/cards', { preHandler: requireAuth }, async (req, reply) => {
    const d = deckById(req.user.id, Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Deck no encontrado.' });
    let data;
    try { data = await decksApi('/parse' + q({ list: d.deck_string })); }
    catch (e) { return reply.code(502).send({ error: e.message }); }
    return { decks: data.decks || { main: [], extra: [], side: [] } };
  });

  // Change the cover card (re-generate the cover only; the deck image is cached).
  app.put('/api/decks/:id/cover', { preHandler: requireAuth }, async (req, reply) => {
    const d = deckById(req.user.id, Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Deck no encontrado.' });
    const cover = String(req.body?.cover ?? '');
    if (!/^\d+$/.test(cover)) return reply.code(400).send({ error: 'Portada inválida.' });
    let data;
    try { data = await decksApi('/deck-image' + q({ list: d.deck_string, cover })); }
    catch (e) { return reply.code(502).send({ error: e.message }); }
    db.prepare('UPDATE user_decks SET cover_url = ?, cover_passcode = ? WHERE id = ? AND user_id = ?').run(data.cover_url || null, Number(cover), d.id, req.user.id);
    return rowOf(deckById(req.user.id, d.id));
  });

  // Rename a deck (name only — the deck string / image never change here).
  app.patch('/api/decks/:id', { preHandler: requireAuth }, async (req, reply) => {
    const d = deckById(req.user.id, Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Deck no encontrado.' });
    const name = String(req.body?.name ?? '').trim().slice(0, 60);
    if (!name) return reply.code(400).send({ error: 'Ponle un nombre al deck.' });
    db.prepare('UPDATE user_decks SET name = ? WHERE id = ? AND user_id = ?').run(name, d.id, req.user.id);
    return rowOf(deckById(req.user.id, d.id));
  });

  app.delete('/api/decks/:id', { preHandler: requireAuth }, async (req, reply) => {
    const d = deckById(req.user.id, Number(req.params.id));
    if (!d) return reply.code(404).send({ error: 'Deck no encontrado.' });
    db.prepare('DELETE FROM user_decks WHERE id = ? AND user_id = ?').run(d.id, req.user.id);
    // Now that the row is gone, GC its image/cover if nothing else references them (#117).
    gcOrphanImage(d.image_url, 'image_url');
    gcOrphanImage(d.cover_url, 'cover_url');
    return { ok: true };
  });
}
