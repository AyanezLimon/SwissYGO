/* run-swissygo driver — launches the SwissYGO overhaul frontend (app/web) and
 * drives the real GUI with Playwright, taking screenshots.
 *
 * The frontend is plain static files (no build) and the OFFLINE tournament
 * console runs fully without the backend (state lives in localStorage). The
 * connected features (accounts, publish, /u/ join) need the Fastify+SQLite API,
 * whose native dep (better-sqlite3) does NOT build on Node 24/Windows without
 * Python+MSVC — so this driver covers the offline GUI, which is the core app.
 * Connected flows are verified against the deployed torneodev (see SKILL.md).
 *
 * Usage:  node .claude/skills/run-swissygo/driver.mjs [outDir]
 * Output: screenshots in <outDir> (default: this skill's screenshots/).
 *
 * Resolves playwright + app/web relative to this file, so cwd doesn't matter.
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..', '..', '..', 'app', 'web');           // repo/app/web
const OUT = process.argv[2] || join(HERE, 'screenshots');
const PORT = Number(process.env.PORT || 5179);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function startServer() {
  const srv = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(WEB, p));
      if (!file.startsWith(WEB)) { res.writeHead(403).end('no'); return; }      // no traversal
      const body = await readFile(file);
      const ext = file.slice(file.lastIndexOf('.'));
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(body);
    } catch { res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"error":"not found"}'); }
  });
  return new Promise((resolve) => srv.listen(PORT, () => resolve(srv)));
}

const shots = [];
async function shot(page, name) {
  const f = join(OUT, name + '.png');
  await page.screenshot({ path: f });           // viewport-only (fullPage trips on the fixed modal overlay)
  shots.push(f); console.log('  📸', name);
}
const VIEWPORT = { width: 1280, height: 900 };

(async () => {
  if (!existsSync(WEB)) throw new Error('app/web not found at ' + WEB);
  mkdirSync(OUT, { recursive: true });
  const srv = await startServer();
  const base = 'http://localhost:' + PORT;
  console.log('serving app/web at', base);
  const browser = await chromium.launch();                    // headless chromium
  try {
    // 1) Landing gate — fresh visitor (no token, no guest).
    const fresh = await browser.newContext({ viewport: VIEWPORT });
    const gate = await fresh.newPage();
    await gate.goto(base + '/', { waitUntil: 'load' });
    await gate.waitForSelector('#gate .modal', { timeout: 8000 });
    await shot(gate, '1-gate');

    // 2) Player page /u/ as a guest (join screen; active list fails gracefully offline).
    const u = await fresh.newPage();
    await u.goto(base + '/u/', { waitUntil: 'load' });
    await u.waitForSelector('#player .card', { timeout: 8000 });
    await u.waitForTimeout(500);
    await shot(u, '2-player-u');

    // 3) Offline organizer console — reachable by injecting a TO session into
    //    localStorage (hasSession()+isTO() shows the console; API calls 404 and
    //    fall back to the stored role). This is the real verbatim offline app.
    const to = await browser.newContext({ viewport: VIEWPORT });
    await to.addInitScript(() => {
      try { localStorage.setItem('ygo_token', 'dev-offline'); localStorage.setItem('ygo_role', 'to'); localStorage.setItem('ygo_username', 'DevTO'); } catch {}
    });
    const con = await to.newPage();
    await con.goto(base + '/', { waitUntil: 'load' });
    await con.waitForSelector('#add-player', { timeout: 8000 });
    for (const n of ['Alice', 'Bob', 'Carol', 'Dave']) {
      await con.fill('#player-name', n);
      await con.click('#add-player');
    }
    await con.waitForTimeout(300);
    await shot(con, '3-console-registro');

    // start the tournament → rounds tab
    await con.click('#start-tournament');
    await con.waitForTimeout(600);
    await shot(con, '4-console-rondas');

    // standings tab
    await con.click('nav.tabs button[data-tab="standings"]');
    await con.waitForTimeout(600);
    await shot(con, '5-console-standings');

    console.log('\nOK —', shots.length, 'screenshots in', OUT);
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => { console.error('DRIVER FAILED:', e.message); process.exit(1); });