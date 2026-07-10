/* Monitor de requests (#142): el ring en memoria es puro — sin DB ni red. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReqMonitor } from '../src/lib/reqmon.js';

const entry = (i) => ({ ts: i, method: 'GET', url: '/api/x/' + i, status: 200, ms: 1, actor: null });

test('el ring capea al tamaño configurado y conserva las más recientes', () => {
  const mon = makeReqMonitor(3);
  for (let i = 1; i <= 5; i++) mon.record(entry(i));
  const urls = mon.list().map((e) => e.url);
  assert.deepEqual(urls, ['/api/x/3', '/api/x/4', '/api/x/5']);
});

test('los suscriptores reciben cada entrada nueva; unsubscribe corta', () => {
  const mon = makeReqMonitor(10);
  const got = [];
  const unsub = mon.subscribe((e) => got.push(e.url));
  mon.record(entry(1));
  mon.record(entry(2));
  unsub();
  mon.record(entry(3));
  assert.deepEqual(got, ['/api/x/1', '/api/x/2']);
});

test('un suscriptor roto no afecta ni al ring ni al resto', () => {
  const mon = makeReqMonitor(10);
  const got = [];
  mon.subscribe(() => { throw new Error('boom'); });
  mon.subscribe((e) => got.push(e.id));
  assert.doesNotThrow(() => mon.record(entry(1)));
  assert.equal(got.length, 1);
  assert.equal(mon.list().length, 1);
});

test('list() devuelve una copia y las entradas llevan id incremental', () => {
  const mon = makeReqMonitor(10);
  mon.record(entry(1));
  const a = mon.list();
  a.pop(); // mutar la copia no toca el ring
  assert.equal(mon.list().length, 1);
  mon.record(entry(2));
  const ids = mon.list().map((e) => e.id);
  assert.deepEqual(ids, [1, 2]);
});
