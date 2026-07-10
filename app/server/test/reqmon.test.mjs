/* Monitor de requests (#142): el ring en memoria es puro — sin DB ni red.
 * Al final, un test de ruta real con fastify.inject() sobre el app admin
 * (cadena sin nativos: bcryptjs + node:sqlite, no requiere better-sqlite3). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { makeReqMonitor } from '../src/lib/reqmon.js';

// ADMIN_PASSWORD se lee al importar routes/admin.js → fijarla ANTES del import dinámico.
process.env.ADMIN_PASSWORD = 'test-pw';

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

test('GET /admin/requests: guard + snapshot del ring vía fastify.inject()', async (t) => {
  let Fastify, adminRoutes;
  try {
    Fastify = (await import('fastify')).default;
    adminRoutes = (await import('../src/routes/admin.js')).default;
  } catch {
    // Sin node_modules locales (deps solo en CI/Pi) el test de ruta no puede
    // correr; los del ring puro de arriba siguen cubriendo la lógica.
    t.skip('fastify no instalado en este entorno');
    return;
  }
  const MIG = new URL('../migrations/', import.meta.url);
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));

  const mon = makeReqMonitor(10);
  mon.record({ ts: 1, method: 'GET', url: '/api/health', status: 200, ms: 2, actor: null });
  mon.record({ ts: 2, method: 'POST', url: '/api/tournaments/join', status: 201, ms: 9, actor: 'guest' });

  const app = Fastify();
  app.decorate('db', db);
  app.decorate('reqmon', mon);
  await app.register(adminRoutes);

  const noPw = await app.inject({ method: 'GET', url: '/admin/requests' });
  assert.equal(noPw.statusCode, 401, 'sin password → 401');

  const ok = await app.inject({ method: 'GET', url: '/admin/requests', headers: { 'x-admin-password': 'test-pw' } });
  assert.equal(ok.statusCode, 200);
  const rows = ok.json();
  assert.equal(rows.length, 2);
  assert.equal(rows[1].url, '/api/tournaments/join');
  assert.equal(rows[1].actor, 'guest');

  await app.close();
});
