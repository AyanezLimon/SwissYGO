# SwissYGO — Overhaul (`app/`)

The modular, multi-user evolution of SwissYGO. Lives **alongside** the legacy single-file
`SwissYGO.html` (production, untouched) and is published independently to a **dev** site at
`torneodev.elbunkers.com`. Cutover to production happens later, by choice.

Design principle: **stay lean.** It's still just a website — plain static files plus a tiny
API for the things a static site can't do (accounts, shared data). No build step, no bundler,
nothing heavy running idle on the Pi.

## What it is

A plain **static SPA** (vanilla JS, no framework, no build) that runs in two modes against the
**same core logic** (`js/lib/*`, ported near-verbatim from `SwissYGO.html`):

- **Local mode** (default, no backend): persists to `localStorage` (`ygo_swiss_v1` — the same
  key the legacy app uses). TO-only, register players by hand, works fully offline.
- **Connected mode** (logged in, API reachable): state persists to the tiny Pi API; players
  self-register via code/QR and poll for their pairing; finished tournaments become history.

The heavy pairing/tiebreak math runs in the **browser**; the server is just CRUD + auth.
Networked features are **purely additive** — offline mode needs no backend at all.

## Layout

```
app/
  web/                 static SPA — served directly by Caddy, NO build
    index.html
    css/styles.css
    js/
      lib/             pure logic ported from SwissYGO.html (vanilla ESM, unit-tested)
      store.js         state + persistence (localStorage / API)
      api.js           fetch wrapper for connected mode
      app.js           vanilla UI controller
    package.json       dev-only (vitest); never shipped to the Pi
  server/              tiny Fastify + better-sqlite3 + JWT API (only for connected mode)
    src/{server,db,auth,routes}/...
    migrations/        SQL schema (state_json blob + minimal relational tables)
  Dockerfile           API-only image (no SPA inside)
  docker-compose.yml   backend container for the Pi (run only when you want accounts)
  deploy/Caddyfile     two-site config for the EXISTING Caddy (torneo + torneodev)
```

## Local development

**Frontend (offline mode)** — no backend, no build. Serve the static folder with anything:

```bash
cd app/web
python3 -m http.server 5173      # or any static server → http://localhost:5173
npm install && npm test          # vitest: parity tests for js/lib (dev-only)
```

(ES modules need http, not `file://`.)

**Backend (only for connected mode):**

```bash
cd app/server
npm install                                   # better-sqlite3 (prebuilt on most arches)
JWT_SECRET=dev DB_PATH=./data/dev.sqlite npm run dev   # API on :8787
```

## Deploy (Pi / CasaOS)

The Pi runs CasaOS (Docker) with one Caddy container already serving prod. The overhaul reuses
that Caddy: a second site (`torneodev`) serves the static files and reverse-proxies `/api` to
the backend container. **Prod (`torneo` → `SwissYGO.html`) is untouched.**

- **Frontend** = plain file copy, no build, no Docker.
  [`deploy-web.yml`](../.github/workflows/deploy-web.yml) (auto on `develop` when `app/web/**`
  changes) rsyncs the static files to `/DATA/AppData/swissygo-dev` on the self-hosted runner.
- **Backend** = [`deploy-api.yml`](../.github/workflows/deploy-api.yml), **manual**
  (`workflow_dispatch`). Builds the small API image and starts the `swissygo-api` container.
  Nothing runs idle until you choose to enable accounts.

**One-time Pi setup:**

1. **Reuse Caddy:** in the CasaOS Caddy app, mount `app/deploy/Caddyfile` → `/etc/caddy/Caddyfile`
   and `/DATA/AppData/swissygo-dev` → `/srv/swissygo-dev`, then reload Caddy. (Prod's existing
   `/DATA/AppData/swissygo` → `/usr/share/caddy` mount stays.)
2. **Tunnel:** in the Cloudflare Zero Trust dashboard, add the `torneodev.elbunkers.com` public
   hostname with the **same Service URL as `torneo`** (it routes to the same Caddy; Caddy splits
   by hostname).
3. **For connected mode only:** add the repo Actions secret `JWT_SECRET`
   (`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`), then run the
   **Deploy API** workflow. SQLite persists in `/DATA/AppData/swissygo-dev/data`.

## Status

- **Done:** ported & unit-tested core logic (pairing, tiebreaks, bulk-paste, timer math, 13
  tests); static offline TO app (Registro / Rondas / Standings + manual tie resolution) on
  localStorage; tiny API skeleton (Fastify + SQLite + JWT, auth + tournament/registration
  routes) ready for connected mode; lean deploy (static copy + manual API).
- **Next:** connected-mode UI (register/login, create/join via code+QR, live pairing view),
  TO & player history, finished-tournament public results, visual parity polish (timer,
  champion screen, shareable image, print).
