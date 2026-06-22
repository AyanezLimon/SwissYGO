/* qa-live.mjs — QA the player side against the LIVE torneodev (connected mode).
 * Read-only GUI checks: gate, /u/ join screen, the tournament detail card via the
 * deep link (both a late-entry-open and a closed tournament, discovered live),
 * and account login → Mi perfil. Does NOT confirm any join (no writes to others'
 * tournaments). Screenshots to ./screenshots-live/.
 * Usage: node .claude/skills/run-swissygo/qa-live.mjs
 */
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'screenshots-live');
const BASE = process.env.BASE || 'https://torneodev.elbunkers.com';
const PLAYER_USER = process.env.QA_PLAYER_USER || 'qa-player';
if (!process.env.QA_PLAYER_PASS) { console.error('Set QA_PLAYER_PASS (QA player account password) in the env.'); process.exit(1); }
const PLAYER_PASS = process.env.QA_PLAYER_PASS;
const VIEWPORT = { width: 1280, height: 900 };
const shots = [];

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: VIEWPORT });
  const shot = async (page, name) => { const f = join(OUT, name + '.png'); await page.screenshot({ path: f }); shots.push(name); console.log('  📸', name); };
  try {
    // discover a late-open and a closed tournament code, live
    const active = await (await ctx.request.get(BASE + '/api/tournaments/active')).json();
    const lateT = active.find((t) => t.lateOpen);
    const closedT = active.find((t) => t.status === 'running' && !t.lateOpen) || active.find((t) => !t.lateOpen);
    console.log('active:', active.map((t) => `${t.code}:${t.status}:late=${t.lateOpen}`).join(' '));

    // 1) landing gate
    const g = await ctx.newPage();
    await g.goto(BASE + '/', { waitUntil: 'load' });
    await g.waitForSelector('#gate .modal', { timeout: 15000 });
    await shot(g, 'live-1-gate');

    // 2) /u/ as guest — join screen + live active list
    const u = await ctx.newPage();
    await u.goto(BASE + '/u/', { waitUntil: 'load' });
    await u.waitForSelector('#player .card', { timeout: 15000 });
    await u.waitForSelector('#active .tcard, #active .muted', { timeout: 15000 });
    await u.waitForTimeout(600);
    await shot(u, 'live-2-u-join');

    // 3) detail card via deep link — late-entry-open tournament
    if (lateT) {
      const p = await ctx.newPage();
      await p.goto(BASE + '/u/?torneo=' + lateT.code, { waitUntil: 'load' });
      await p.waitForSelector('#player .card h2', { timeout: 15000 });
      await p.waitForTimeout(400);
      const txt = await p.textContent('#player');
      console.log('  late card mentions entrada tardía:', /entrada tard/i.test(txt));
      await shot(p, 'live-3-card-late-entry');
    } else { console.log('  (no late-open tournament live to screenshot)'); }

    // 4) detail card — closed/no-late tournament
    if (closedT) {
      const p = await ctx.newPage();
      await p.goto(BASE + '/u/?torneo=' + closedT.code, { waitUntil: 'load' });
      await p.waitForSelector('#player .card h2', { timeout: 15000 });
      await p.waitForTimeout(400);
      await shot(p, 'live-4-card-closed');
    }

    // 5) account login (qa-player) → Mi perfil (empty-state stats)
    const a = await ctx.newPage();
    await a.goto(BASE + '/', { waitUntil: 'load' });
    await a.waitForSelector('#gate-user', { timeout: 15000 });
    await a.fill('#gate-user', PLAYER_USER);
    await a.fill('#gate-pass', PLAYER_PASS);
    await a.click('#gate-submit');
    await a.waitForURL('**/u/**', { timeout: 15000 });
    await a.waitForSelector('#hist', { timeout: 15000 });
    await a.click('#hist');
    await a.waitForTimeout(1200);
    await shot(a, 'live-5-mi-perfil');

    console.log('\nOK —', shots.length, 'screenshots in', OUT);
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('QA-LIVE FAILED:', e.message); process.exit(1); });