# SwissYGO — Overhaul (`app/`)

The modular, multi-user evolution of SwissYGO. Lives **alongside** the legacy single-file
`SwissYGO.html` (production, untouched) and is published independently to a **dev** site at
`torneodev.elbunkers.com`. Cutover to production happens later, by choice.

**Design principle — stay lean.** It's still just a website: plain static files plus a tiny
API for the things a static site can't do (accounts, shared data). No build step, no bundler,
nothing heavy idling on the RAM-tight Raspberry Pi. Occasional heavy work (rendering deck
images) is **offloaded to free external services** so the Pi only ever stores a URL.

## What it is

A plain **static site** (vanilla JS, no framework, no build) that runs in two modes:

- **Local mode** (default, no backend): the organizer console — the real prod page split
  **verbatim** into `js/app.js` + `css/styles.css` — persists to `localStorage` (`ygo_swiss_v1`,
  the legacy key). TO-only, register players by hand, works fully offline.
- **Connected mode** (logged in, API reachable): accounts + a tiny Pi API. A TO publishes a
  tournament and shares a **5-character join code** (no QR); players self-register from the
  phone page `/u/` (as an **account** or a **guest**), live-poll for their table/opponent, and
  report their own results. Finished tournaments become history; ranked events feed an Elo
  leaderboard.

The heavy pairing/tiebreak math runs in the **browser**; the server is just CRUD + auth.
Connected features are layered **additively**: `js/app.js` and `css/styles.css` are verbatim
copies of prod and are **never edited** — the console's cloud behaviour is layered in
`js/connect.js`, and the phone page is a separate `js/player.js` at `/u/`. Offline mode needs
no backend at all.

## Tech stack

**Frontend** — vanilla ES, classic `<script>` tags, **no build/bundler**. Cache-busting via
`?v=N` query params on each asset. Served as static files by Caddy.

**Backend** (`app/server`) — **Fastify** + **better-sqlite3** (SQLite) + **@fastify/jwt** +
**bcryptjs**, on **Node 22** (alpine in Docker). Two Fastify apps share one DB: the public API
(`:8787`, exposed via Caddy + Cloudflare tunnel under `/api`) and a LAN-only admin tool
(`:8788`, never on the tunnel).

**External services** (connected mode only — keep heavy work off the Pi):

| Service | Used for |
|---|---|
| **Supabase Storage** | Public bucket hosting generated deck images + covers. The Pi stores only the URL. |
| **omega-api-decks** | External **PHP** service on **Render** (free tier) that renders the YGOPro-style deck image from a decklist (ydk / ydke / Omega code) and uploads it to Supabase. Fork: `AriesYL/omega-api-decks`. |
| **YGOProDeck** | Card **art** (cropped images, loaded directly as `<img>`) and card **names** (`cardinfo` API, CORS-enabled, resolved client-side). |
| **Resend** | Transactional email (password-reset codes) via its HTTP API — no SMTP. Optional: unset key → send is a logged no-op. |

**Infra** — Raspberry Pi running **CasaOS** (Docker). The existing **Caddy** serves both the
prod and dev sites (split by hostname); **Cloudflare Tunnel** exposes them. CI/CD via **GitHub
Actions** (a self-hosted Pi runner performs the deploys).

## Layout

```
app/
  web/                     static site — served directly by Caddy, NO build
    index.html             organizer console (landing gate + the offline app)
    u/index.html           phone-first player page (/u/)
    css/
      styles.css           VERBATIM prod styles — never edited
      connect.css          additive styles for the connected layer
    js/
      app.js               VERBATIM prod page — offline console (pairing/tiebreaks/timer)
      connect.js           additive cloud layer for the console (accounts, publish, sync)
      player.js            the /u/ player page (join, live pairing, history, Mis Decks)
      api.js               tiny fetch wrapper + JWT token store
      standings-image.js   shareable standings/podium image (canvas)
      brand-logos.js, names-data.js
  server/                  Fastify + better-sqlite3 + JWT API (connected mode only)
    src/
      server.js, db.js, auth.js
      routes/              auth · tournaments · decks · admin
      lib/                 email (Resend) · leaderboard (Elo) · roster · tiebreak
    migrations/            SQL schema (state_json blob + relational tables)
  Dockerfile               API-only image (no SPA inside)
  docker-compose.yml       backend container for the Pi
  deploy/Caddyfile         two-site config for the EXISTING Caddy (torneo + torneodev)
```

## Connected-mode features

- **Accounts + guests.** Username/password (JWT in `localStorage`; bcrypt hashes server-side).
  Guests join with a typed display name — no saved stats.
- **Self-registration** by **5-character code** (no QR). The TO console auto-absorbs registrants
  into the player list (single-writer: only the TO writes `state_json`).
- **Live pairing** — the player page polls `/me` (~4 s) for "Mesa N · vs Rival", with a chime +
  vibration + OS/in-app notification when a new round's pairing appears.
- **Personal match history** — under the live pairing box, the player's own results for that
  tournament (round · opponent · W/L/BYE) + a running record.
- **Player-driven result reporting** — the winner reports, the opponent confirms; the TO console
  picks it up.
- **Ranked / Elo** — a per-event ranked flag (`#32`) feeds an Elo **leaderboard**; a **casual**
  organizer role can only create unranked events. Optional Elo-influenced first-round seeding.
- **Profile cosmetics** — borders/banners/badges (catalog + seasonal grants).
- **Mis Decks** — save up to 5 decks; see the decks architecture below.
- **Self-service password reset** — emailed 6-digit code (Resend).

## Decks architecture (`#84` — hybrid, $0)

When a player saves a deck, the Pi POSTs the decklist to **omega-api-decks** (Render), which
renders the deck image + a cover and uploads both to **Supabase**; the Pi persists **only the
URLs** (`user_decks`), never the image blob. Idempotent by a hash of the decklist. Card **names**
for the readable decklist table are resolved **client-side** from YGOProDeck `cardinfo`. The
external host cold-starts, so the UI pre-warms it and the Pi uses a long timeout + one retry.
(The Omega "Clipboard recipe" / names input format is intentionally unsupported; ydk / ydke /
Omega code all work.)

## Local development

**Frontend (offline mode)** — no backend, no build. Serve the static folder with anything:

```bash
cd app/web
python3 -m http.server 5173      # or any static server → http://localhost:5173
```

Validate with `node --check js/*.js` and by loading it in a browser. The console is TO-gated;
to see it without a backend, set `localStorage` `ygo_token=x; ygo_role=to` and reload. To drive
it headlessly (+ screenshots), use the **`run-swissygo`** skill.

**Backend (connected mode):**

```bash
cd app/server
npm install                                          # better-sqlite3 prebuilt on Node 22
JWT_SECRET=dev DB_PATH=./data/dev.sqlite npm run dev  # API on :8787
npm test                                             # node:test unit suite (lib + routes)
```

> **better-sqlite3 won't build on Node 24 / Windows** (no prebuilt binary, node-gyp needs MSVC +
> Python). Use **Node 22 LTS** or the Docker path. The frontend driver sidesteps this (offline
> mode needs no API).

## Deploy (Pi / CasaOS)

The Pi runs CasaOS (Docker) with one Caddy container already serving prod. The overhaul reuses
that Caddy: a second site (`torneodev`) serves the static files and reverse-proxies `/api` to the
backend container. **Prod (`torneo` → `SwissYGO.html`) stays untouched.** `develop` is the
**default branch**; merges into it auto-deploy:

- **Frontend** — [`deploy-web.yml`](../.github/workflows/deploy-web.yml): on push to `develop`
  touching `app/web/**`, rsyncs the static files to `/DATA/AppData/swissygo-dev`. No build, no
  Docker.
- **Backend** — [`deploy-api.yml`](../.github/workflows/deploy-api.yml): on push to `develop`
  touching `app/server/**` / Dockerfile / compose, runs `docker compose up -d --build` + a health
  smoke test. Also available via `workflow_dispatch`.
- **CI gate** — [`ci.yml`](../.github/workflows/ci.yml) runs `node --check` + the API `node --test`
  suite on every PR. Branch protection requires it + an owner review (`.github/CODEOWNERS`) before
  merge.

**Secrets** (GitHub Actions → injected into the compose env on deploy): `JWT_SECRET`,
`ADMIN_PASSWORD`, `DECKS_REQUEST_TOKEN`, `RESEND_API_KEY` / `RESEND_FROM`. `DECKS_API_URL` is
public (in compose). **Supabase keys live on the external omega-api-decks host (Render), not the
Pi.** SQLite persists in `/DATA/AppData/swissygo-dev/data`.

**One-time Pi setup:** mount `app/deploy/Caddyfile` → `/etc/caddy/Caddyfile` and
`/DATA/AppData/swissygo-dev` → `/srv/swissygo-dev` in the CasaOS Caddy app and reload; add the
`torneodev.elbunkers.com` hostname in Cloudflare Zero Trust with the **same Service URL as
`torneo`** (Caddy splits by hostname); set the Actions secrets above and run **Deploy API**.

## Status

Connected mode is **live on `torneodev`**: accounts + guests, 5-char join, live pairing with
notifications, personal match history, player-driven reporting, ranked/Elo leaderboard + casual
role, profile cosmetics, Mis Decks (deck images), and password reset. Next big arc: using the
saved decks (standings deck art `#107`, deck stats `#108`, ranked deck registration `#109`).
Production cutover (`develop` → `main`) — including a refreshed root `README` + `CHANGELOG` — is
still deliberate and pending.
