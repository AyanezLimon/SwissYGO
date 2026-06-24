-- Saved decks per account (#84 / #102). The user submits a deck string (ydke/omega);
-- the external decks API renders + persists the images to cloud storage and returns
-- public URLs — we store ONLY those URLs (no blobs). Capped to 5 per user in the route.
CREATE TABLE IF NOT EXISTS user_decks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT NOT NULL DEFAULT '',
  deck_string    TEXT NOT NULL,            -- the original ydke:// / omega string
  format         TEXT NOT NULL DEFAULT 'ydke',
  image_url      TEXT,                     -- public deck-image URL (cloud storage)
  cover_url      TEXT,                     -- public cover (cropped art) URL
  cover_passcode INTEGER,                  -- the card chosen as the cover
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_user_decks_user ON user_decks(user_id);
