---
name: run-swissygo
description: Run, launch, build, and screenshot the SwissYGO app locally. Drives the real frontend GUI (landing gate, offline tournament console, player page /u/) headlessly with Playwright + a tiny static server, and documents how to run the Fastify/SQLite API. Use to run SwissYGO, take screenshots, or smoke-test the UI on a clean machine.
---

# Run SwissYGO

The overhaul is in **`app/`**: a **static frontend** `app/web/` (plain classic scripts, **no
build step**) + a **Fastify + better-sqlite3 + JWT** API in `app/server/`. The frontend's
**offline tournament console runs fully without the backend** (state lives in `localStorage`)
— that's the core app and what the driver exercises. Connected features (accounts, publish,
`/u/` join, late entry) need the API.

Driven by **`.claude/skills/run-swissygo/driver.mjs`** (Playwright + a dependency-free Node
static server). Paths below are relative to the **repo root**.

## Prerequisites

Node (tested **v24.15.0**) + Playwright with Chromium. From the repo root:

```bash
npm i -D playwright
npx playwright install chromium
```

(No `apt-get` / xvfb — Chromium runs headless. No build step for the frontend.)

## Run (agent path) — the driver

```bash
node .claude/skills/run-swissygo/driver.mjs
```

It serves `app/web/` on `http://localhost:5179`, launches headless Chromium, drives three
surfaces and writes 5 PNGs to `.claude/skills/run-swissygo/screenshots/`:

- `1-gate` — landing gate (Crear cuenta / Iniciar sesión / Ingresar como invitado).
- `2-player-u` — player page `/u/` as a guest.
- `3-console-registro` — offline organizer console, Registro tab, after adding 4 players
  (also shows the Nombre/Fecha fields).
- `4-console-rondas` — after **Iniciar Torneo**: round 1 with Swiss pairings + timer.
- `5-console-standings` — Standings tab.

Pass an output dir as `argv[2]` to change where PNGs land. **Look at the screenshots** to
confirm a real render (not a blank/error page).

**Key trick the driver uses:** the console is **TO-gated** — it only shows when
`localStorage` has `ygo_token` + `ygo_role==='to'`. With no backend, logging in is
impossible, so the driver injects a fake TO session via `context.addInitScript` before
navigating. The app's `API.me()` then 404s and falls back to the stored role, leaving the
fully-functional offline console on screen. Extend the driver by adding pages/clicks in the
same pattern (it's just Playwright).

## Run (human path)

Serve the static folder and open it; offline mode works with no backend:

```bash
node -e "const{createServer}=require('http'),{readFileSync}=require('fs');createServer((q,s)=>{let p=q.url.split('?')[0];if(p==='/'||p.endsWith('/'))p+='index.html';try{s.end(readFileSync('app/web'+p))}catch{s.statusCode=404;s.end()}}).listen(5179,()=>console.log('http://localhost:5179'))"
```

Then browse `http://localhost:5179/`. You'll get the **gate**; "Ingresar como invitado" →
`/u/`. The **organizer console** needs a TO session (log in against a running API, or in
devtools set `localStorage ygo_token=x; ygo_role=to` and reload). Ctrl-C to stop.

## The API (`app/server`) — connected mode

The API needs its native dep built. **On Node 24 / Windows it does NOT build** (see Gotchas).
To run it locally use **Node 22 LTS** (better-sqlite3 ships a prebuilt binary there, no
compiler) or the Docker path used in prod (`app/docker-compose.yml`). Launch reads env
`PORT` (8787), `ADMIN_PORT` (8788), `DB_PATH`, `JWT_SECRET`, `ADMIN_PASSWORD`; entry is
`app/server/src/server.js` (`npm start`). Connected flows were verified against the deployed
**torneodev.elbunkers.com** throughout development; to smoke-test an endpoint:

```bash
curl -fsS https://torneodev.elbunkers.com/api/health
```

## QA against the live server (connected mode)

Two extra drivers exercise the **connected** features against the deployed dev server
(`https://torneodev.elbunkers.com`) — useful when you can't build the API locally. Override the
target with `BASE=...` and credentials with the env vars below.

```bash
# Player side, READ-ONLY (no joins/writes): gate, /u/ join screen, the detail card
# via deep link for a late-open AND a closed tournament (both discovered live), and
# account login → Mi perfil. Screenshots → screenshots-live/.
node .claude/skills/run-swissygo/qa-live.mjs        # creds: QA_PLAYER_USER / QA_PLAYER_PASS

# Full connected E2E (WRITES — needs a TO account): qa-to publishes a fresh tournament,
# 4 guests self-register via the deep link, the console absorbs them, starts, a late
# entry joins mid-event, the TO reports every round to the finish, and a player sees the
# results card. Screenshots → screenshots-e2e/. Exits non-zero if it didn't reach finished.
node .claude/skills/run-swissygo/qa-e2e.mjs         # creds: QA_TO_USER / QA_TO_PASS
```

`qa-e2e.mjs` only writes its **own** qa tournament (owned by the TO account); it leaves
dev-clutter tournaments named `QA-E2E …` you can delete from the LAN admin page → Torneos tab.
Both default to the `qa-to` / `qa-player` accounts on torneodev; supply the password via env
vars (`QA_TO_PASS` / `QA_PLAYER_PASS`) — it is not committed.

## Per-feature screenshots & mockups (the review loop)

Beyond the 5 baseline driver shots, **each UI change gets its own screenshot** for the owner to
review, written to **`.claude/skills/run-swissygo/screenshots-review/`**. Two flavours:

- **Mockup (design approval, before coding):** a throwaway HTML file using the real palette +
  real data, rendered headless at phone width and screenshotted. Present it, iterate, get a
  thumbs-up, THEN implement. Examples produced this way: `standings-107-mock.png`,
  `decks-edit-panel-mock.png`.
- **Live render (verification, after coding):** a tiny static server over `app/web/` + a
  Playwright context that **stubs `/api/**`** (and external calls like ygoprodeck `cardinfo`)
  with fixtures, drives the real `player.js`/`connect.js`, asserts the flow, and screenshots the
  result (e.g. `decks-edit-panel-live.png`, `player-history.png`). This doubles as the headless
  test in the verification bar (see `swissygo-ship`).

Pattern for both: `viewport {width:430,...}, deviceScaleFactor: 2`; inject session state via
`context.addInitScript` (`localStorage` `ygo_token`/`ygo_role`/`ygo_joined`); `context.route`
for fixtures. To share a PNG with the owner, copy it under the workspace and link it with a
relative markdown path (it's clickable in the IDE). **Always open the PNG and look at it.**

## Gotchas

- **`better-sqlite3` won't `npm install` on Node 24 / win-x64**: no prebuilt binary for that
  target, and `node-gyp` fails ("Could not find any Python installation", needs Python 3.6+
  and MSVC). Use Node 22 (prebuilt) or Docker. The frontend driver sidesteps this entirely
  (offline mode needs no API).
- **`page.screenshot({ fullPage: true })` throws** "Unable to capture screenshot" here — the
  landing gate is a fixed-position `.modal-overlay`. The driver uses viewport screenshots with
  an explicit `viewport` instead.
- **The console is TO-only.** A fresh visitor always lands on the gate; players/guests are
  routed to `/u/`. To see the console without a backend, inject `ygo_token` + `ygo_role=to`
  into `localStorage` (the driver does this via `addInitScript`).
- **`/api/*` 404s are expected offline** — `connect.js`'s boot `refreshMe()` calls
  `API.me()`, catches the failure, and falls back to the stored role. Not an error.
- **PowerShell 5.1** (this box's default shell) has no `&&` — chain with `;` or separate lines.

## Troubleshooting

- `node-gyp ... Could not find any Python` on `cd app/server; npm install` → expected on Node
  24/win; switch to Node 22 LTS or run the API via Docker.
- Driver hangs on `waitForSelector('#gate .modal')` → the static server didn't start or
  `app/web` moved; confirm `http://localhost:5179/` serves `index.html`.
- `screenshots/` is git-ignored (regenerated each run); delete it freely.

See also: `swissygo-ship` (how to make changes) and `swissygo-verify` (post-deploy checks).