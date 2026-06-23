-- Profile cosmetics (#37, Phase 1). Ownership of NON-base cosmetics (base ones are
-- implicit for everyone, see lib/cosmetics.js). The equipped selection lives as a
-- small JSON blob on the user ({border, banner, badges[]}); NULL = the defaults.
CREATE TABLE IF NOT EXISTS user_cosmetics (
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cosmetic_id  TEXT NOT NULL,
  granted_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, cosmetic_id)
);
CREATE INDEX IF NOT EXISTS idx_user_cosmetics_user ON user_cosmetics(user_id);

ALTER TABLE users ADD COLUMN cosmetics_equipped TEXT;   -- JSON {border,banner,badges[]}; NULL = defaults
