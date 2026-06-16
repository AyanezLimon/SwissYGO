# SwissYGO — Overhaul (`app/`)

The modular, multi-user evolution of SwissYGO. Lives **alongside** the legacy single-file
`SwissYGO.html` (production, untouched) and deploys independently to a **dev** environment at
`torneodev.elbunkers.com`. Cutover to production happens later, by choice.

Full design rationale and phased roadmap: see the approved plan
(`.claude/plans/gentle-crunching-pizza.md`).

## What it is

One **Vue 3 + Vite** SPA that runs in two modes against the **same ported core logic**:

- **Local mode** (default, no backend): persists to `localStorage` (`ygo_swiss_v1` — the same
  key the legacy app uses). TO-only, register players by hand, works fully offline. Feature
  parity with today is the goal of this mode.
- **Connected mode** (logged in, backend reachable): state persists to the Pi backend; players
  self-register via code/QR and poll for their pairing; finished tournaments become history.

Networked features are **purely additive** — nothing about the offline experience requires them.

## Layout

```
app/
  web/      Vue 3 + Vite SPA
    src/
      lib/        pure logic ported near-verbatim from SwissYGO.html (unit-tested)
      stores/     Pinia: tournament (model/controller)
      services/   api.js + storage adapters (local | api)
      views/      Setup / Round / Standings (+ player/auth views in later phases)
      assets/css/ brand theme ported from the legacy <style>
  server/   Fastify + better-sqlite3 + JWT (auth, tournaments, registrations)
    src/{server,db,auth,routes}/...
    migrations/   SQL schema (hybrid: state_json blob + minimal relational tables)
  deploy/   Caddyfile snippet, systemd unit, notes
```

## Local development

**Frontend only (offline mode)** — no backend needed:

```bash
cd app/web
npm install
npm run dev        # http://localhost:5173
npm test           # vitest: parity tests for the ported logic
```

**With the backend (connected mode):**

```bash
cd app/server
npm install        # builds better-sqlite3 (native)
JWT_SECRET=dev DB_PATH=./data/dev.sqlite npm run dev   # 127.0.0.1:8787
```

Vite proxies `/api` → `127.0.0.1:8787` (see `vite.config.js`), so the SPA and API share an
origin in dev, mirroring the Caddy reverse-proxy in production.

## Deploy (Pi dev environment)

The overhaul lives on the long-lived `develop` branch. Pushing `app/**` to `develop` triggers
[`.github/workflows/deploy-dev.yml`](../.github/workflows/deploy-dev.yml) on the self-hosted
`swissygo-pi` runner: it builds the SPA → `/var/www/swissygo-dev`, syncs the backend →
`/opt/swissygo-dev`, installs deps, and restarts the `swissygo-dev` systemd service.

One-time Pi setup:

1. `app/deploy/Caddyfile.snippet` → add the `torneodev.elbunkers.com` block to your Caddyfile
   (behind the existing Cloudflare tunnel) and reload Caddy.
2. `app/deploy/swissygo-dev.service` → install the systemd unit; create
   `/opt/swissygo-dev/.env` from `app/server/.env.example` (set a strong `JWT_SECRET`).
3. Optionally set repo Actions **variables** `DEV_WEB_PATH` / `DEV_SERVER_PATH` to override the
   default paths.

Production (`torneo.elbunkers.com`, the single file) and its workflow are entirely separate.

## Status

- **Done:** ported & unit-tested core logic (pairing, tiebreaks, bulk-paste, timer math);
  offline TO app (Setup/Round/Standings) wired through the Pinia store + localStorage adapter;
  backend skeleton (Fastify + SQLite schema + JWT auth + tournament/registration routes);
  dev deploy pipeline.
- **Next (later PRs):** connected-mode UI (login, create/join, live pairing view, QR), TO &
  player history, finished-tournament public results, share-image / projection-window port,
  full visual parity polish.
