-- Per-tournament "ranked" flag. Ranked tournaments contribute to the Elo
-- leaderboard; casual ones (e.g. a friendly at someone's house) do not. Existing
-- tournaments were all competitive, so they default to ranked = 1.
ALTER TABLE tournaments ADD COLUMN ranked INTEGER NOT NULL DEFAULT 1;
