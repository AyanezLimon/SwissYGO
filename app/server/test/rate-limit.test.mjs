/* Rate limiter (lib/rate-limit.js) — the per-IP brute-force/abuse throttle on the
 * auth endpoints (#38). Guards: it counts per client IP, replies 429 past the max
 * with a Retry-After, keys off the proxy headers (not Caddy's socket IP), and the
 * window resets so a venue isn't locked out forever. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimit } from '../src/lib/rate-limit.js';

// Minimal Fastify-ish req/reply doubles. reply.code/header chain; capture the send.
const mkReq = (headers = {}, ip = '10.0.0.1') => ({ headers, ip });
const mkReply = () => {
  const r = { statusCode: 200, headers: {}, sent: undefined };
  r.code = (c) => { r.statusCode = c; return r; };
  r.header = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.send = (b) => { r.sent = b; return r; };
  return r;
};
// Run the preHandler once; return the reply (429 → reply.sent set, else undefined).
async function hit(limiter, req) { const reply = mkReply(); await limiter(req, reply); return reply; }

test('allows up to max, then blocks with 429 + Retry-After', async () => {
  const limiter = rateLimit({ max: 3, windowMs: 60_000 });
  const req = mkReq({ 'cf-connecting-ip': '1.2.3.4' });
  for (let i = 0; i < 3; i++) assert.equal((await hit(limiter, req)).statusCode, 200, `request ${i + 1} should pass`);
  const blocked = await hit(limiter, req);
  assert.equal(blocked.statusCode, 429);
  assert.ok(blocked.sent && blocked.sent.error, 'sends an error body');
  assert.ok(Number(blocked.headers['retry-after']) > 0, 'sets Retry-After seconds');
});

test('buckets are per client IP — one abuser does not block others', async () => {
  const limiter = rateLimit({ max: 1, windowMs: 60_000 });
  assert.equal((await hit(limiter, mkReq({ 'cf-connecting-ip': 'a' }))).statusCode, 200);
  assert.equal((await hit(limiter, mkReq({ 'cf-connecting-ip': 'a' }))).statusCode, 429, 'IP a is over its limit');
  assert.equal((await hit(limiter, mkReq({ 'cf-connecting-ip': 'b' }))).statusCode, 200, 'IP b is unaffected');
});

test('uses X-Forwarded-For first hop when no CF header, not the socket IP', async () => {
  const limiter = rateLimit({ max: 1, windowMs: 60_000 });
  // Same socket ip, different XFF client → must be treated as different clients.
  assert.equal((await hit(limiter, mkReq({ 'x-forwarded-for': '9.9.9.9, 172.17.0.1' }, '172.17.0.1'))).statusCode, 200);
  assert.equal((await hit(limiter, mkReq({ 'x-forwarded-for': '8.8.8.8, 172.17.0.1' }, '172.17.0.1'))).statusCode, 200);
  assert.equal((await hit(limiter, mkReq({ 'x-forwarded-for': '9.9.9.9, 172.17.0.1' }, '172.17.0.1'))).statusCode, 429, '9.9.9.9 is over');
});

test('the window resets — a client is not locked out forever', async () => {
  const limiter = rateLimit({ max: 1, windowMs: 20 });
  const req = mkReq({ 'cf-connecting-ip': 'x' });
  assert.equal((await hit(limiter, req)).statusCode, 200);
  assert.equal((await hit(limiter, req)).statusCode, 429);
  await new Promise((r) => setTimeout(r, 30)); // let the window elapse
  assert.equal((await hit(limiter, req)).statusCode, 200, 'allowed again after the window');
});
