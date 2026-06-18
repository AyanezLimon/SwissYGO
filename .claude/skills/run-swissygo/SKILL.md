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