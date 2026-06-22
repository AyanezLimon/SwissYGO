-- Player-driven result reporting. Players never write state_json (single-writer
-- rule): the winner files a report here, the opponent confirms it, and the TO
-- console absorbs confirmed reports into state_json (just like it absorbs
-- self-registrations). One active report per match per round.
CREATE TABLE IF NOT EXISTS result_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
  round_number  INTEGER NOT NULL,
  match_key     TEXT NOT NULL,                  -- sorted "p1Id|p2Id" of the match (stable within a round)
  reporter_id   TEXT NOT NULL,                  -- player_id who filed the claim
  result        TEXT NOT NULL,                  -- 'p1' | 'p2' | 'doubleLoss'  (relative to the match's p1Id/p2Id)
  confirmed     INTEGER NOT NULL DEFAULT 0,     -- 0 = waiting for opponent, 1 = confirmed (ready for the TO to apply)
  confirmer_id  TEXT,                           -- player_id who confirmed
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  confirmed_at  TEXT,
  UNIQUE (tournament_id, round_number, match_key)
);
CREATE INDEX IF NOT EXISTS idx_reports_tournament ON result_reports(tournament_id);
