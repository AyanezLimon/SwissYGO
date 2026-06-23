/* Migrations smoke test — applies every migrations/*.sql in order on a fresh
 * in-memory DB (node:sqlite, a builtin, so no native build needed) and asserts the
 * core tables exist. Catches a broken/incompatible migration before it ships. As
 * new migrations land they're picked up automatically (same ordering as db.js). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const MIG = new URL('../migrations/', import.meta.url);

test('all migrations apply cleanly in order', () => {
  const db = new DatabaseSync(':memory:');
  const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  assert.ok(files.length >= 1, 'there are migration files');
  for (const f of files) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  for (const t of ['users', 'tournaments', 'registrations', 'settings']) {
    assert.ok(tables.has(t), `table "${t}" exists after migrations`);
  }
});

test('registrations enforces its uniqueness invariants', () => {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  db.prepare("INSERT INTO users (id, username, password_hash) VALUES (1,'a','x')").run();
  db.prepare("INSERT INTO tournaments (id, to_user_id, name, join_code, status, state_json) VALUES (1,1,'T','C','setup','{}')").run();
  db.prepare("INSERT INTO registrations (tournament_id, user_id, player_id, display_name) VALUES (1,1,'u1-a','a')").run();
  // same (tournament_id, player_id) must be rejected (idx_reg_tp)
  assert.throws(() => db.prepare("INSERT INTO registrations (tournament_id, user_id, player_id, display_name) VALUES (1,NULL,'u1-a','dup')").run());
  // same (tournament_id, user_id) must be rejected (idx_reg_tu)
  assert.throws(() => db.prepare("INSERT INTO registrations (tournament_id, user_id, player_id, display_name) VALUES (1,1,'u1-b','dup')").run());
});
