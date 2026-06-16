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
  Dockerfile          single image: Fastify serves the SPA + API
  docker-compose.yml  dev stack for the Pi (CasaOS)
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
origin in dev. In production the same Fastify process serves the built SPA too (one origin).

**Run the whole stack like production (Docker):**

```bash
cp app/.env.example app/.env   # set a real JWT_SECRET
docker compose -f app/docker-compose.yml up -d --build   # http://localhost:8787
```

## Deploy (Pi / CasaOS)

The Pi runs CasaOS (Docker). The overhaul deploys as **one self-contained container** —
Fastify serves both the built SPA and the `/api` — published on host port **8787**. The
Cloudflare tunnel routes `torneodev.elbunkers.com` to it. The production Caddy container
(`torneo.elbunkers.com`, serving the single `SwissYGO.html` from `/DATA/AppData/swissygo`) and
its tunnel route are **completely untouched** — separate container, separate config.

Pushing `app/**` to the long-lived `develop` branch triggers
[`.github/workflows/deploy-dev.yml`](../.github/workflows/deploy-dev.yml) on the self-hosted
`swissygo-pi` runner: it runs `docker compose ... up -d --build` (the image build does the SPA
build + native deps internally — the runner only needs Docker) and smoke-tests `/api/health`.

**One-time setup:**

1. Add a repo Actions **secret** `JWT_SECRET` (Settings → Secrets and variables → Actions).
   Generate one: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
2. In the **Cloudflare Zero Trust dashboard** → your tunnel → Public Hostnames, add
   `torneodev.elbunkers.com` with the **same Service URL as the existing `torneo` hostname but
   port `8787`** (e.g. if `torneo` → `http://<pi>:8090`, set `torneodev` → `http://<pi>:8787`).
3. First deploy: push to `develop` (or run the workflow manually). SQLite persists in the
   bind-mounted `/DATA/AppData/swissygo-dev/data` (override via `SWISSYGO_DATA_DIR`).

## Status

- **Done:** ported & unit-tested core logic (pairing, tiebreaks, bulk-paste, timer math);
  offline TO app (Setup/Round/Standings) wired through the Pinia store + localStorage adapter;
  backend skeleton (Fastify + SQLite schema + JWT auth + tournament/registration routes);
  dev deploy pipeline.
- **Next (later PRs):** connected-mode UI (login, create/join, live pairing view, QR), TO &
  player history, finished-tournament public results, share-image / projection-window port,
  full visual parity polish.
