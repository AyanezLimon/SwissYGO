/* qa-e2e.mjs — full connected E2E against LIVE torneodev with the qa-to TO account.
 * Self-contained: qa-to publishes a fresh tournament, guests self-register via the
 * deep link, the TO console absorbs them, starts, a late entry joins mid-event,
 * the TO reports every round to the finish, and we confirm a player sees results.
 * Writes only its own qa tournament (owned by qa-to). Screenshots to ./screenshots-e2e/.
 * Usage: node .claude/skills/run-swissygo/qa-e2e.mjs
 */
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'screenshots-e2e');
const BASE = process.env.BASE || 'https://torneodev.elbunkers.com';
const TO_USER = process.env.QA_TO_USER || 'qa-to';
const TO_PASS = process.env.QA_TO_PASS || 'qa-pass-123';
const VP = { width: 1280, height: 950 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const shot = async (page, n) => { await page.screenshot({ path: join(OUT, n + '.png') }); console.log('  📸', n); };
  const log = (...a) => console.log('  ·', ...a);
  try {
    // ---- TO logs in → console ----
    const toCtx = await browser.newContext({ viewport: VP });
    const TO = await toCtx.newPage();
    await TO.goto(BASE + '/', { waitUntil: 'load' });
    await TO.waitForSelector('#gate-user', { timeout: 20000 });
    await TO.fill('#gate-user', TO_USER); await TO.fill('#gate-pass', TO_PASS);
    await TO.click('#gate-submit');
    await TO.waitForSelector('#add-player', { timeout: 20000 });
    log('TO console loaded');

    // ---- name + date, then publish (toolbar button) ----
    const name = 'QA-E2E ' + new Date().toISOString().slice(11, 19);
    await TO.fill('#tournament-name', name);
    await TO.waitForSelector('#toolbar-publish', { timeout: 10000 });
    await TO.click('#toolbar-publish');
    await TO.waitForFunction(() => typeof state!=='undefined' && state.cloud && !!state.cloud.code, null, { timeout: 20000 });
    const code = await TO.evaluate(() => state.cloud.code);
    log('published', name, '→ code', code);
    // close the code modal
    await TO.click('#code-modal [data-close]').catch(() => {});
    await sleep(500);

    // ---- 4 guests self-register via the deep link ----
    const guests = [];
    for (const gname of ['QA-Ann', 'QA-Ben', 'QA-Cid', 'QA-Dan']) {
      const c = await browser.newContext({ viewport: VP });
      const p = await c.newPage();
      await p.goto(BASE + '/u/?torneo=' + code, { waitUntil: 'load' });
      await p.waitForSelector('#confirm', { timeout: 20000 });
      await p.fill('#gname', gname);
      await p.click('#confirm');
      await p.waitForSelector('#leave', { timeout: 20000 });   // "Inscrito" pairing screen
      guests.push({ c, p, gname });
      log('guest joined', gname);
    }

    // ---- TO absorbs the 4 registrations ----
    await TO.waitForFunction(() => typeof state!=='undefined' && state.players.length >= 4, null, { timeout: 30000 });
    await TO.click('nav.tabs button[data-tab="registro"]').catch(() => {});
    await sleep(500);
    await shot(TO, 'e2e-1-registro-absorbed');
    log('absorbed players:', await TO.evaluate(() => state.players.length));

    // ---- start the tournament ----
    await TO.click('#start-tournament');
    await TO.waitForFunction(() => typeof state!=='undefined' && state.started === true, null, { timeout: 20000 });
    await sleep(800);
    await shot(TO, 'e2e-2-round1-pairings');
    log('started; round', await TO.evaluate(() => state.currentRound), 'of', await TO.evaluate(() => state.maxRounds));

    // ---- a LATE ENTRY joins mid-event ----
    const lc = await browser.newContext({ viewport: VP });
    const LP = await lc.newPage();
    await LP.goto(BASE + '/u/?torneo=' + code, { waitUntil: 'load' });
    await LP.waitForSelector('#confirm', { timeout: 20000 });
    const lateText = await LP.textContent('#player');
    log('late card offers entrada tardía:', /entrada tard/i.test(lateText));
    await LP.fill('#gname', 'QA-Late');
    await LP.click('#confirm');
    await LP.waitForSelector('#leave', { timeout: 20000 });
    await TO.waitForFunction(() => typeof state!=='undefined' && state.players.length >= 5, null, { timeout: 30000 });
    const lateHasLoss = await TO.evaluate(() => { const p = state.players.find((x) => x.name === 'QA-Late'); return !!(p && p.lateEntry); });
    log('late entry absorbed; lateEntry flag:', lateHasLoss);
    await shot(TO, 'e2e-3-late-entry-absorbed');

    // ---- report every round to the finish ----
    for (let i = 0; i < 8; i++) {
      if (await TO.evaluate(() => !!state.finished)) break;
      await TO.click('nav.tabs button[data-tab="rondas"]').catch(() => {});
      await sleep(300);
      // Click each real match's p1 BY ID (reporting re-renders the round, which
      // detaches plain element handles — selecting by id each time survives it).
      const ids = await TO.evaluate(() => {
        const r = (state.rounds || []).find((x) => x.roundNumber === state.currentRound);
        return r ? r.matches.filter((m) => !m.isBye && !m.isLateLoss && m.p1Id && m.p2Id).map((m) => m.id) : [];
      });
      for (const id of ids) { await TO.click('#tab-rondas button.pick[data-result="p1"][data-id="' + id + '"]').catch(() => {}); await sleep(200); }
      await sleep(300);
      await TO.click('#advance-round').catch(() => {});
      await sleep(500);
      const ok = await TO.$('#confirm-modal.open #confirm-ok');
      if (ok) { await ok.click(); await sleep(600); }
      log('round step', i + 1, '→ currentRound', await TO.evaluate(() => state.currentRound), 'finished', await TO.evaluate(() => !!state.finished));
    }
    const finished = await TO.evaluate(() => !!state.finished);
    await TO.click('nav.tabs button[data-tab="standings"]').catch(() => {});
    await sleep(700);
    await shot(TO, 'e2e-4-standings');
    log('finished:', finished);

    // ---- a player sees results ----
    const pg = guests[0].p;
    await pg.reload({ waitUntil: 'load' });
    await sleep(2500); // poll picks up finished → results view
    await shot(pg, 'e2e-5-player-results');

    // Hard assertion: the report loop must have driven the tournament to the
    // finish. The report-click race (DOM re-renders on each report, detaching
    // handles) can leave it stuck mid-event — without this check the script
    // would still print "OK". Fail loud and non-zero so a flake is visible.
    if (!finished) throw new Error('tournament never reached finished state — rounds did not advance (report-click race); re-run');
    console.log('\nE2E OK — tournament', JSON.stringify(name), 'code', code);
  } finally {
    await sleep(500);
    await browser.close();
  }
})().catch((e) => { console.error('E2E FAILED:', e.message); process.exit(1); });