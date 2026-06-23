-- Global key/value settings, admin-tunable (LAN admin panel). Kept as a tiny
-- generic table so future knobs (base rating, min games, …) can reuse it.
-- First setting: the Elo K-factor used by the leaderboard engine (default 24).
-- Changing it re-rates the whole season on the next recompute, because the board
-- is computed from match history rather than stored incrementally.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings (key, value) VALUES ('elo_k', '24');
