/* Orphan-image GC ref-counting (#117). Deck images are content-addressed by hash, so
 * the SAME image_url/cover_url can be shared across users/decks. When a deck is deleted
 * we may delete its blob from storage ONLY when no remaining user_decks row references
 * that URL (reference count 0) — otherwise we'd break another user's deck. This asserts
 * that exact decision over the real migration chain (the route uses the same COUNT(*)). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const MIG = new URL('../migrations/', import.meta.url);

function freshDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  return db;
}

// Mirrors gcOrphanImage's guard: orphaned (deletable) ⇔ no remaining row references the URL.
const refcount = (db, column, url) => db.prepare(`SELECT COUNT(*) AS n FROM user_decks WHERE ${column} = ?`).get(url).n;

test('a shared image_url is kept while another deck still references it', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1,'a','x'),(2,'b','x')").run();
  const URL_SHARED = 'https://ref.supabase.co/storage/v1/object/public/deck-images/abc.jpg';
  // Two users saved the identical decklist → same content-addressed image_url.
  const mk = (id, uid) => db.prepare("INSERT INTO user_decks (id, user_id, name, deck_string, image_url) VALUES (?,?,?,?,?)").run(id, uid, 'd', 'ydke://', URL_SHARED);
  mk(1, 1); mk(2, 2);

  // User 1 deletes their deck.
  db.prepare('DELETE FROM user_decks WHERE id = ? AND user_id = ?').run(1, 1);
  assert.equal(refcount(db, 'image_url', URL_SHARED), 1, 'still referenced → NOT orphaned → must keep the blob');

  // User 2 deletes theirs too → now orphaned.
  db.prepare('DELETE FROM user_decks WHERE id = ? AND user_id = ?').run(2, 2);
  assert.equal(refcount(db, 'image_url', URL_SHARED), 0, 'last reference gone → orphaned → safe to delete the blob');
});

test('covers are ref-counted by URL independently of the deck image', () => {
  const db = freshDb();
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1,'a','x')").run();
  const COVER = 'https://ref.supabase.co/storage/v1/object/public/deck-images/covers/12345.jpg';
  // Two different decks (different images) that happen to share the same cover passcode.
  db.prepare("INSERT INTO user_decks (id, user_id, name, deck_string, image_url, cover_url, cover_passcode) VALUES (1,1,'d1','ydke://a','img-a',?,12345)").run(COVER);
  db.prepare("INSERT INTO user_decks (id, user_id, name, deck_string, image_url, cover_url, cover_passcode) VALUES (2,1,'d2','ydke://b','img-b',?,12345)").run(COVER);

  db.prepare('DELETE FROM user_decks WHERE id = 1 AND user_id = 1').run();
  assert.equal(refcount(db, 'cover_url', COVER), 1, 'other deck still uses the cover → keep it');
  assert.equal(refcount(db, 'image_url', 'img-a'), 0, 'that deck image is unique → orphaned');

  db.prepare('DELETE FROM user_decks WHERE id = 2 AND user_id = 1').run();
  assert.equal(refcount(db, 'cover_url', COVER), 0, 'cover now unreferenced → safe to delete');
});
