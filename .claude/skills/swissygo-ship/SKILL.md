---
name: swissygo-ship
description: Build and ship a change in the SwissYGO overhaul (app/). Encodes the hard rules (verbatim app.js/styles.css, additive connect.js layer, single-writer, durable metadata, cache-bust bumps) and the PR-into-develop → Codex → merge → verify workflow. Use for ANY code change under app/.
---

# Shipping a SwissYGO change

Repo `AyanezLimon/SwissYGO`. The overhaul lives in **`app/`** on branch **`develop`**,
deployed to **`torneodev.elbunkers.com`**. Production `torneo.elbunkers.com` (the single
`SwissYGO.html`) is **untouched** until a deliberate cutover — never break it.

**Architecture (lean — the Pi is RAM-tight):** static frontend `app/web/` (`index.html` +
`css/` + `js/`, **no build step**) served by the existing CasaOS Caddy; a tiny **Fastify +
better-sqlite3 + JWT** API in `app/server/` (host :8787); LAN-only admin tool on :8788. No
heavy deps, no per-push Docker churn beyond the API image.

## Hard rules (don't violate)

- **NEVER edit `app/web/js/app.js` or `app/web/css/styles.css`.** They are the real prod
  page split verbatim. To change console behaviour, layer in **`js/connect.js`**:
  - `app.js` exposes globals (function declarations + `let state`). Reassign `window.<fn>`
    to redirect functions app.js calls **by name** (e.g. `save`, `buildStandingsImageBlob`).
  - `app.js` binds DOM handlers **by reference and registers first**, so to intercede on a
    control (`#start-tournament`, `#reset-all`, `[data-action="remove"]`) add a **document
    capture-phase** listener and `e.stopImmediatePropagation()`, then re-invoke as needed.
  - You CAN add markup to `index.html` and rules to `css/connect.css` (those aren't verbatim).
- **Single-writer:** the TO is the sole writer of `state_json` (PUT). Players only INSERT
  into `registrations`; the console **absorbs** registrations into `state.players`.
- **Auth:** `requireTO` re-reads role/disabled from the DB live; `findOr404` lets ANY TO act
  (role is system-wide; `to_user_id` is just creator metadata).
- **Durable metadata goes in columns**, not `state_json` (e.g. `tournaments.name`). `state_json`
  is mutable/rebuildable — don't let it shadow a column.
- **Cache-bust:** when you change a `js/`/`css/` file, bump its `?v=N` in `app/web/index.html`
  and/or `app/web/u/index.html`. (Dev sends `no-store`, but keep it consistent.) The admin
  tool's `admin.html` is served by the API (no query bust; picked up on API rebuild).
- **Verbatim guard:** if a task seems to need an `app.js`/`styles.css` edit, find the additive
  workaround instead.

## Workflow

0. **PREFLIGHT (every time, before branching):** `git fetch origin --prune`, then branch from
   **`origin/develop`** directly — never a stale local `develop`. Run `gh pr list --state merged
   --limit 10` and `--state open` so you KNOW what's already merged vs still in flight. The owner
   merges without always announcing it; branching on a stale base (thinking a feature is "still
   in PR" when it actually merged) causes avoidable merge conflicts / duplicate work. See memory
   `never-assume-repo-state`.
1. **Branch off `origin/develop`** with a descriptive name (`feat/…`, `fix/…`) — never name it
   after the reviewer ("codex", "review"). If a change depends on an unmerged PR, stack on that
   branch and set the PR base to it; retarget to `develop` once the base merges.
2. Implement. Keep code in the surrounding style; match comment density.
3. **Validate:** `node --check` every changed JS file. If you touched `app/server/migrations/`,
   apply the chain on a throwaway DB to confirm it runs:
   `node --experimental-sqlite -e "const{DatabaseSync}=require('node:sqlite');const fs=require('fs');const d=new DatabaseSync(':memory:');d.exec('PRAGMA foreign_keys=ON');for(const f of fs.readdirSync('app/server/migrations').filter(f=>f.endsWith('.sql')).sort())d.exec(fs.readFileSync('app/server/migrations/'+f,'utf8'));console.log('ok')"`
4. **Commit** (end the message with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`),
   push, and `gh pr create --base develop` (PR body ends with the Generated-with footer).
5. **Codex reviews.** Fix worthwhile comments; decline others with a stated reason in the reply.
6. After the owner **merges**, the merge commit triggers deploys — then run **`swissygo-verify`**.

## Project board (issue-centric — applies to ANY agent working this repo)

Work is tracked on the GitHub Project **https://github.com/users/AyanezLimon/projects/1**.
The rule: **cards are issues; PRs are associated to a card via the issue's
Development section** (a `Closes #N` reference) — PRs are NOT added as their own cards,
and cards are never deleted. Follow this regardless of which agent/tooling you use.

- **Before working a backlog item, check for an existing card** (`gh issue list
  --search "…"`); reuse it — do not create duplicates. Only if none exists, create the
  issue first (`gh issue create … --label v2-backlog`), then it shows on the board.
- **Open the PR with `Closes #N` in its body while the PR is OPEN** → that links it to
  the issue's Development section automatically. (A keyword added to an already-merged
  PR does not link; that has to be done in the GitHub UI.)
- **Cards are the living design spec.** When a design aspect is discussed and a
  decision/agreement is reached, **update the issue body** (`gh issue edit N --body …`)
  so the cards stay an accurate, documented record of each feature.
- Status moves (Todo → In Progress → Done) and any manual linking are the owner's to
  make. Don't restructure the board. (We merge to `develop`, not the default branch, so
  `Closes #N` links but does NOT auto-close the issue — the card moves to Done manually
  or via the optional `chore/project-card-sync` Action.)

## Deploys (auto on push/merge to develop)

- `app/web/**` → **Deploy Web** (rsync file copy; near-instant, no restart).
- `app/server/**` / Dockerfile / compose → **Deploy API** (`docker compose up -d --build` +
  health smoke test). Both fire if a PR touches both.

See [[swissygo-overhaul-state]] for current state, [[swissygo-pi-deployment]] for infra,
[[swissygo-pr-workflow]] for the PR gate.