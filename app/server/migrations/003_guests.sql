-- Guests can play too (no account). Rebuild `registrations` so user_id is
-- nullable and add guest_token + display_name. A registration is either an
-- account (user_id set) or a guest (guest_token set). display_name is what the
-- TO absorbs into the player list and what /me matches.
CREATE TABLE registrations_new (
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,   -- null for guests
  guest_token   TEXT,                                             -- set for guests
  player_id     TEXT NOT NULL,                                    -- matches a player.id in state_json
  display_name  TEXT NOT NULL DEFAULT '',
  joined_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Carry over existing (account-only) registrations, backfilling display_name.
INSERT INTO registrations_new (tournament_id, user_id, guest_token, player_id, display_name, joined_at)
  SELECT r.tournament_id, r.user_id, NULL, r.player_id, COALESCE(u.username, ''), r.joined_at
  FROM registrations r LEFT JOIN users u ON u.id = r.user_id;

DROP TABLE registrations;
ALTER TABLE registrations_new RENAME TO registrations;

CREATE UNIQUE INDEX idx_reg_tp ON registrations(tournament_id, player_id);
CREATE UNIQUE INDEX idx_reg_tu ON registrations(tournament_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_reg_guest ON registrations(guest_token) WHERE guest_token IS NOT NULL;
CREATE INDEX idx_registrations_user ON registrations(user_id);
