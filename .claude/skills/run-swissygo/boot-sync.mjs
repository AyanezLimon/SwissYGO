/* Boot-sync integration test (#94 / PR #95). Boots the real offline console
 * (app.js + connect.js) headlessly with a STALE localStorage tournament and a
 * stubbed /api, and asserts connect.js's pullCloudStateOnBoot():
 *   (a) server reachable  → adopts the server state (a stale "ghost" player vanishes)
 *       AND persists LOCAL-ONLY (no PUT back to the server on boot)
 *   (b) GET fails (offline) → keeps the local cache (ghost stays) — offline still works
 * Run: node .claude/skills/run-swissygo/boot-sync.mjs   (exit 0 = pass)
 * Frontend-only (browser), so it lives here with the Playwright harness rather than
 * in the node:test CI gate. */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', '..', 'app', 'web');
const PORT = Number(process.env.PORT || 5210);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function startServer() {
  const srv = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(WEB, p)); if (!file.startsWith(WEB)) { res.writeHead(403).end('no'); return; }
      const body = await readFile(file); const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(body);
    } catch { res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}'); }
  });
  return new Promise((r) => srv.listen(PORT, () => r(srv)));
}

const STALE = { cloud: { id: 1, code: 'TESTC' }, ranked: true, started: true, finished: false, currentRound: 1, maxRounds: 3,
  players: [{ id: 'u9-real', name: 'RealPlayer', dropped: false, hasReceivedBye: false, userId: 9 }, { id: 'ghost-1', name: 'GhostStale', dropped: false, hasReceivedBye: false, lateEntry: true, userId: 99 }],
  rounds: [{ roundNumber: 1, matches: [{ id: 'm1', p1Id: 'u9-real', p2Id: null, result: 'p1', isBye: true, isReported: true }, { id: 'g1', p1Id: 'ghost-1', p2Id: null, result: 'lateLoss', isLateLoss: true, isReported: true }] }] };
const SERVER = { id: 1, join_code: 'TESTC', ranked: true, state: { cloud: { id: 1, code: 'TESTC', removed: [] }, ranked: true, started: true, finished: false, currentRound: 1, maxRounds: 3,
  players: [{ id: 'u9-real', name: 'RealPlayer', dropped: false, hasReceivedBye: false, userId: 9 }],
  rounds: [{ roundNumber: 1, matches: [{ id: 'm1', p1Id: 'u9-real', p2Id: null, result: 'p1', isBye: true, isReported: true }] }] } };
const A = (c, m) => { if (!c) throw new Error('ASSERT FAILED: ' + m); console.log('  ✓', m); };

async function boot(browser, failGet) {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  let putCount = 0;
  await ctx.addInitScript((s) => { localStorage.setItem('ygo_token', 't'); localStorage.setItem('ygo_role', 'to'); localStorage.setItem('ygo_username', 'aTO'); localStorage.setItem('ygo_swiss_v1', JSON.stringify(s)); }, STALE);
  await ctx.route('**/api/**', async (r) => {
    const u = r.request().url(); const m = r.request().method();
    const j = (o, st = 200) => r.fulfill({ status: st, contentType: 'application/json', body: JSON.stringify(o) });
    if (m === 'PUT' && /\/api\/tournaments\/1(\?|$)/.test(u)) { putCount++; return j({ ok: true }); }
    if (u.includes('/auth/me')) { await new Promise((x) => setTimeout(x, 600)); return j({ user: { id: 1, username: 'aTO', role: 'to' } }); }
    if (/\/api\/tournaments\/1(\?|$)/.test(u)) { return failGet ? j({ error: 'down' }, 500) : j(SERVER); }
    if (u.includes('/registrations')) return j([{ player_id: 'u9-real', user_id: 9, display_name: 'RealPlayer' }]);
    return j({ ok: true });
  });
  const p = await ctx.newPage();
  await p.goto('http://localhost:' + PORT + '/', { waitUntil: 'load' });
  await p.waitForFunction(() => typeof state !== 'undefined' && state.cloud && state.cloud.id === 1, { timeout: 10000 });
  await p.waitForTimeout(1500);
  const ids = await p.evaluate(() => state.players.map((x) => x.id));
  await ctx.close();
  return { ids, putCount };
}

(async () => {
  const srv = await startServer();
  const browser = await chromium.launch();
  try {
    console.log('--- ONLINE: server reachable → adopt server state, persist local-only ---');
    let r = await boot(browser, false);
    A(!r.ids.includes('ghost-1'), 'stale GHOST dropped → adopted server state');
    A(r.ids.includes('u9-real'), 'real player retained');
    A(r.putCount === 0, 'boot did NOT PUT to the server (local-only persist, no redundant write)');
    console.log('--- OFFLINE: GET fails → keep local cache ---');
    r = await boot(browser, true);
    A(r.ids.includes('ghost-1'), 'offline → stale state KEPT (offline flow intact)');
    console.log('\nALL OK');
  } finally { await browser.close(); srv.close(); }
})().catch((e) => { console.error('\nTEST FAILED:', e.message); process.exit(1); });
