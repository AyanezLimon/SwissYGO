-- Self-service password reset: short-lived, single-use 6-digit codes emailed to the
-- account's address. Only the hash of the code is stored. One active code per user
-- (a new request supersedes the old). `attempts` caps brute force; `used` marks it
-- spent (success or too many tries).
CREATE TABLE IF NOT EXISTS password_resets (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL,
  expires_at  TEXT NOT NULL,               -- SQLite datetime (UTC); compared to datetime('now')
  attempts    INTEGER NOT NULL DEFAULT 0,
  used        INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pwreset_user ON password_resets(user_id);
