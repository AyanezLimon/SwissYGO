-- #136: audit trail de las acciones que MUTAN datos (nunca lecturas) + un ring
-- pequeño de snapshots del estado por torneo. Motivado por el incidente del
-- Torneo Virtual: no había forma de saber quién escribió el estado, cuándo se
-- marcó la doble derrota masiva, ni de probar un reclamo unilateral.

-- Sin FK a tournaments/users a propósito: el log debe SOBREVIVIR a los deletes
-- (un borrado accidental es justo lo que se quiere poder reconstruir).
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ts            TEXT    NOT NULL DEFAULT (datetime('now')),
  actor_type    TEXT    NOT NULL,          -- 'user' | 'guest' | 'admin' | 'anon'
  actor_id      TEXT,                      -- user id / player_id del guest / NULL
  actor_name    TEXT,                      -- snapshot del nombre al momento
  action        TEXT    NOT NULL,          -- p. ej. 'tournament.put_state'
  tournament_id INTEGER,                   -- NULL para acciones globales (auth/admin)
  detail_json   TEXT                       -- resumen compacto (diff, ids, etc.)
);
CREATE INDEX idx_audit_ts ON audit_log (ts);
CREATE INDEX idx_audit_tournament ON audit_log (tournament_id);

-- Ring de snapshots: los últimos N state_json por torneo, solo cuando el PUT
-- trae un cambio NOTABLE (diff no vacío) — material real de diff/rollback sin
-- que el ruido del timer rote las entradas útiles. Pruning en el insert.
CREATE TABLE state_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tournament_id INTEGER NOT NULL,
  ts            TEXT    NOT NULL DEFAULT (datetime('now')),
  state_json    TEXT    NOT NULL
);
CREATE INDEX idx_state_history_t ON state_history (tournament_id, id);
