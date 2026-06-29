---
name: swissygo-verify
description: Verify a merged SwissYGO change actually deployed to torneodev.elbunkers.com — watch the GitHub Actions deploy run(s) to success, then curl the live assets/endpoints to confirm the new code is being served. Use right after a PR merges into develop.
---

# Verify a SwissYGO deploy on torneodev

Run this after a PR merges into `develop`. Production `torneo.elbunkers.com` is separate and
must stay untouched — only check `torneodev`.

## 1. Sync + find the deploy run(s)

```bash
git checkout develop && git pull --ff-only origin develop
gh run list --repo AyanezLimon/SwissYGO --limit 4 --json name,conclusion,headSha,event \
  | node -e 'JSON.parse(require("fs").readFileSync(0)).forEach(x=>console.log((x.conclusion||"running").padEnd(9),x.name,"|",x.headSha.slice(0,9)))'
```

- Frontend-only PR (`app/web/**`) → only **Deploy Web (dev)** fires.
- Backend PR (`app/server/**`) → **Deploy API (dev)** fires (and Web too if both changed).
- Confirm the run(s) on the **merge commit** show `success` (or `gh run watch <id> --exit-status`).

⚠️ **If NO deploy ran after a merge:** the merge was likely made via `GITHUB_TOKEN` (e.g. an
auto-merge enabled by a GitHub Action) — GitHub doesn't trigger workflows from `GITHUB_TOKEN`
pushes. Dispatch them by hand on the merged HEAD:

```bash
gh workflow run deploy-web.yml --ref develop    # and/or:
gh workflow run deploy-api.yml --ref develop
```

To avoid this, auto-merge is enabled per-PR by a real account (see `swissygo-ship`), not a workflow.

## 2. Confirm the new code is live

The dev site sends `Cache-Control: no-store`, so a plain fetch returns fresh files. Check the
specific markers your change introduced (don't just trust the deploy went green). Examples:

```powershell
$base="https://torneodev.elbunkers.com"; $h=@{ "Cache-Control"="no-cache" }
function get($p){ (Invoke-WebRequest -Uri "$base$p" -Headers $h -UseBasicParsing).Content }
# API up + public endpoints:
(Invoke-WebRequest "$base/api/health" -UseBasicParsing).StatusCode      # 200
(Invoke-WebRequest "$base/api/tournaments/active" -UseBasicParsing).StatusCode  # 200
# a changed asset actually contains the new code + the bumped version is wired:
(get "/js/connect.js") -match "someNewSymbolFromThisPR"
(get "/")     -match "connect.js\?v=N"
(get "/u/")   -match "player.js\?v=M"
```

Pick markers from THIS PR's diff (a new function name, a CSS class, the bumped `?v=`).

## 3. Exercise the change end-to-end (don't just curl the asset)

For a **backend** change, drive the real endpoint against torneodev with the **qa accounts**
(`qa-player` / `qa-to`; password in the `swissygo-qa-accounts` memory) — login → call the new
endpoint → assert the response → clean up anything you created. This catches deploy/runtime
issues a static fetch can't (e.g. a route not registered, a 400/500 in the live container). It's
the same loop used during development; prefer it over deferring to the owner's manual QA.

## 4. Flag what can't be checked headlessly

Canvas rendering, CSS animations, audio/vibration/Notifications, drag-and-drop, and any
multi-actor timing (TO absorb → player pairing) need a real browser — list them explicitly
for the owner's manual QA instead of claiming they pass.

## Notes

- `/public` for an **ongoing** tournament returns 403 unless creator/participant/TO — that's
  correct, not a failure.
- The admin tool (:8788) is LAN-only (not on the tunnel); verify it on the Pi/LAN, not via
  `torneodev`.

Workflow context: [[swissygo-pr-workflow]]. Build rules: invoke `swissygo-ship`.