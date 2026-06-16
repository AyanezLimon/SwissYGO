-- SwissYGO backend schema. Pragmatic hybrid: each tournament's full state lives
-- in tournaments.state_json (same shape as the offline localStorage state), with
-- minimal relational tables for the genuinely relational needs (accounts, join
-- codes, account→player links, history listing).
PRAGMA journal_mode = WAL;     -- safe concurrent reads while the TO writes
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email         TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tournaments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  to_user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  join_code   TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'setup',   -- 'setup' | 'running' | 'finished'
  state_json  TEXT NOT NULL,                    -- the full tournament state blob
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tournaments_to_user ON tournaments(to_user_id);

-- Links an account to a player slot inside a tournament's state_json. Manual
-- TO-added players simply have no row here (no user_id) — accounts and
-- hand-registered players coexist. Powers "my tournaments" + per-player lookup.
CREATE TABLE IF NOT EXISTS registrations (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  player_id     TEXT NOT NULL,                  -- matches a player.id in state_json
  joined_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (tournament_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_registrations_user ON registrations(user_id);
