-- `to_user_id` is now only "who created it" metadata: any TO can administer any
-- tournament. Deleting an organizer account must NOT erase tournament history,
-- so relax the FK from NOT NULL / ON DELETE CASCADE to nullable / ON DELETE SET
-- NULL. SQLite can't alter a column's constraint in place, so rebuild the table
-- (12-step procedure: FK off, rebuild in a txn, FK back on).
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;

CREATE TABLE tournaments_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  to_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,  -- nullable: creator metadata only
  name        TEXT NOT NULL,
  join_code   TEXT NOT NULL UNIQUE,
  status      TEXT NOT NULL DEFAULT 'setup',
  state_json  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);

INSERT INTO tournaments_new (id, to_user_id, name, join_code, status, state_json, created_at, finished_at)
  SELECT id, to_user_id, name, join_code, status, state_json, created_at, finished_at FROM tournaments;

DROP TABLE tournaments;
ALTER TABLE tournaments_new RENAME TO tournaments;
CREATE INDEX IF NOT EXISTS idx_tournaments_to_user ON tournaments(to_user_id);

COMMIT;
PRAGMA foreign_keys=ON;
