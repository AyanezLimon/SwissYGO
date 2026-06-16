-- Roles & account status. Everyone defaults to a regular player; the TO role is
-- granted via the local-only admin tool. `disabled` locks an account out of login.
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'player';   -- 'player' | 'to'
ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;   -- 0 = active, 1 = disabled
