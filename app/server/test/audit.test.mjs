/* Audit trail (#136): diffStates es puro; makeAudit/makeStateHistory se prueban
 * contra la migración real usando node:sqlite (builtin, sin build nativo — el
 * mismo truco de migrations.test.mjs). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { diffStates, makeAudit, makeStateHistory, actorFromReq } from '../src/lib/audit.js';

const MIG = new URL('../migrations/', import.meta.url);
function freshDb() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  return db;
}

const P = [{ id: 'a', name: 'Galeomir' }, { id: 'b', name: 'wilaz' }, { id: 'c', name: 'Bonz' }];
const st = (over = {}) => ({
  started: true, finished: false, currentRound: 1, players: P,
  rounds: [{ roundNumber: 1, matches: [{ id: 'm1', p1Id: 'a', p2Id: 'b', result: null }] }],
  ...over,
});

test('diffStates: sin cambios notables → null (el ruido del timer no audita)', () => {
  const a = st({ timer: { endsAt: 1 } });
  const b = st({ timer: { endsAt: 999 }, note: 'otra' });
  assert.equal(diffStates(a, b), null);
});

test('diffStates: resultado cambiado se lista con nombres y antes→después', () => {
  const a = st({ rounds: [{ roundNumber: 1, matches: [{ id: 'm1', p1Id: 'a', p2Id: 'b', result: 'doubleLoss' }] }] });
  const b = st({ rounds: [{ roundNumber: 1, matches: [{ id: 'm1', p1Id: 'a', p2Id: 'b', result: 'p2' }] }] });
  const d = diffStates(a, b);
  assert.deepEqual(d.results, ['R1 Galeomir vs wilaz: doubleLoss→p2']);
});

test('diffStates: ronda nueva + bye auto-reportado', () => {
  const b = st({
    currentRound: 2,
    rounds: [
      { roundNumber: 1, matches: [{ id: 'm1', p1Id: 'a', p2Id: 'b', result: 'p1' }] },
      { roundNumber: 2, matches: [
        { id: 'm2', p1Id: 'a', p2Id: 'b', result: null },
        { id: 'm3', p1Id: 'c', p2Id: null, result: 'p1', isBye: true },
      ] },
    ],
  });
  const a = st({ rounds: [{ roundNumber: 1, matches: [{ id: 'm1', p1Id: 'a', p2Id: 'b', result: 'p1' }] }] });
  const d = diffStates(a, b);
  assert.equal(d.round, '1→2');
  // la mesa nueva sin resultado NO se lista; el BYE auto-reportado sí
  assert.deepEqual(d.results, ['R2 Bonz (BYE): ∅→p1']);
});

test('diffStates: inicio/fin/jugadores', () => {
  const d = diffStates(st({ started: false, players: P.slice(0, 2), rounds: [] }), st({ rounds: [] }));
  assert.equal(d.started, true);
  assert.equal(d.players, '2→3');
  const f = diffStates(st(), st({ finished: true }));
  assert.equal(f.finished, true);
});

test('diffStates: la lista de resultados se trunca a 20', () => {
  const many = (result) => [{
    roundNumber: 1,
    matches: Array.from({ length: 30 }, (_, i) => ({ id: 'm' + i, p1Id: 'a', p2Id: 'b', result })),
  }];
  const d = diffStates(st({ rounds: many(null) }), st({ rounds: many('p1') }));
  assert.equal(d.results.length, 20);
  assert.equal(d.resultsTotal, 30);
});

test('actorFromReq: user / guest / anon', () => {
  assert.deepEqual(actorFromReq({ user: { id: 7, username: 'Aries' } }), { type: 'user', id: 7, name: 'Aries' });
  assert.equal(actorFromReq({ headers: { 'x-guest-token': 'g' } }).type, 'guest');
  assert.equal(actorFromReq({ headers: {} }).type, 'anon');
});

test('makeAudit inserta contra el esquema real y jamás lanza', () => {
  const db = freshDb();
  const audit = makeAudit(db);
  audit({ type: 'user', id: 7, name: 'Aries' }, 'tournament.put_state', 32, { round: '3→4' });
  audit(null, 'auth.login_failed'); // actor nulo → anon, sin explotar
  const rows = db.prepare('SELECT * FROM audit_log ORDER BY id').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].actor_type, 'user');
  assert.equal(rows[0].actor_id, '7');
  assert.equal(rows[0].tournament_id, 32);
  assert.deepEqual(JSON.parse(rows[0].detail_json), { round: '3→4' });
  assert.equal(rows[1].actor_type, 'anon');
  // una db rota no debe romper el request
  const broken = makeAudit({ prepare: () => { throw new Error('boom'); } });
  assert.doesNotThrow(() => broken({ type: 'user' }, 'x'));
});

test('makeStateHistory: ring de N, salta duplicados', () => {
  const db = freshDb();
  const record = makeStateHistory(db, 3);
  record(1, '{"v":1}');
  record(1, '{"v":1}'); // idéntico → no inserta
  for (let v = 2; v <= 6; v++) record(1, JSON.stringify({ v }));
  const rows = db.prepare('SELECT state_json FROM state_history WHERE tournament_id = 1 ORDER BY id').all();
  assert.equal(rows.length, 3, 'poda a N=3');
  assert.deepEqual(rows.map((r) => JSON.parse(r.state_json).v), [4, 5, 6]);
  record(2, '{"v":9}'); // otro torneo no interfiere
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM state_history').get().n, 4);
});
