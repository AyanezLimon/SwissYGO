# SwissYGO — security model & data-integrity notes

This documents how the overhaul (`app/`) protects **server-side data integrity**:
what a client is allowed to assert, what the server always re-verifies, and the
hardening added for issue #38 ("no client tampering, verified requests").

## Threat model

The frontend is static, public JavaScript. Assume a hostile client: it can read
and rewrite anything in its own `localStorage`/`sessionStorage`, replay requests,
craft arbitrary request bodies, and inspect all client code. **Nothing the browser
stores or sends may be trusted on its own.** The server is the only authority over
tournament state, roles, and results.

## What the client stores locally, and why none of it is trusted

| Stored (browser) | Purpose | Why tampering is harmless |
| --- | --- | --- |
| `ygo_token` | Auth bearer token (**signed** JWT) | Signature is HMAC'd with the server's secret. Editing the payload (e.g. flipping `role` to `to`) invalidates the signature → `jwtVerify` rejects it. It cannot be forged without the secret. |
| `ygo_role`, `ygo_username`, `ygo_user` | UI hints only (which buttons to show) | The server **never** reads these. Authorization re-reads `role`/`disabled` from the DB on every protected request (`requireTO`/`requireOrganizer`/`/auth/me`). Faking `ygo_role=to` only changes what the *tamperer's own* UI draws; every write still 403s. |
| `ygo_gtok` (per-code guest token) | Guest identity for a tournament | The token is a **server-issued random 128-bit value** (`crypto.randomBytes(16)`), stored server-side keyed by `(tournament_id, guest_token)` and matched on every request. It is opaque and unguessable — a guest cannot mint one or impersonate another guest. |

### On the "encrypted token" ask (#38)

The issue asks that locally-stored info sent to the API be "an encrypted token the
server decrypts." The property actually required is **integrity/authenticity** (the
client must not be able to *change* what it claims), and that is what we use:

- The account token is a **signed** JWT. Signing — not encryption — is the correct
  primitive here: the payload (`{ id, username, role }`) is not secret, and `role`
  is re-verified from the DB regardless, so there is nothing to hide. Encrypting it
  would add key-management cost and no integrity we don't already have.
- The guest token carries **no data at all** — it's a random handle the server
  resolves to a row. There is nothing in it to tamper with.

So both credentials already satisfy "the server can trust what the client sends
back" without a bespoke encryption layer. Encrypting these values *at rest* in
`localStorage` would be security theatre: the page's own JavaScript (the only code
with the plaintext need) could always decrypt them, so it adds no trust boundary.

## Server-side integrity guarantees

- **Single-writer state.** Only an organizer writes `state_json`
  (`PUT /api/tournaments/:id`, behind `requireOrganizer` + `canManage`). Players and
  guests can never write tournament state directly.
- **Player result reporting is server-adjudicated.** `/report` + `/report/confirm`
  resolve the caller's identity server-side (JWT or guest token → `participantId`),
  verify the caller is actually *in* the current-round match, allow only "I won" /
  "double loss" claims, and require the opponent to confirm. The TO console absorbs
  only confirmed reports.
- **Identity is server-derived, not client-supplied.** An account's `display_name`
  comes from the DB username, not the request body. Deck registration checks the
  deck belongs to the caller (`WHERE id = ? AND user_id = ?`). Disabled accounts are
  rejected live on join and on every protected request.
- **No cookies → no CSRF.** Auth is a `Authorization: Bearer` header the page adds
  explicitly; a cross-site page cannot read the token or set the header.

## Hardening added for #38

- **Fail-closed JWT secret.** A real (listening) server refuses to start if
  `JWT_SECRET` is missing or left at the public dev default — a token signed with
  the repo's default secret would otherwise be forgeable by anyone. `buildApp()`
  still accepts the default for tests/local dev. (`docker-compose.yml` also requires
  the secret via `${JWT_SECRET:?}`; this is the defense-in-depth backstop.)
- **Bounded token lifetime.** Issued JWTs now carry a 30-day `exp` (configurable via
  `JWT_TTL`), capping how long a leaked token stays usable. (Pre-existing tokens have
  no `exp` and stay valid — no forced mass logout on deploy.)
- **Rate limiting** on the credential/abuse endpoints (`/auth/login`, `/register`,
  `/forgot`, `/reset`) via a small dependency-free per-IP limiter
  (`src/lib/rate-limit.js`). Ceilings are deliberately generous because a whole
  tournament venue can share one public IP — they clear a real event while stopping
  scripted brute force. `/join` is intentionally **not** IP-limited for the same
  shared-IP reason.

## Known, accepted limitations

- Rate-limit counts are in-memory (reset on restart) and keyed on proxy-supplied
  IP headers, which are spoofable by a host with direct LAN access. The limiter is a
  speed bump; the hard controls are bcrypt cost and the reset code's 5-try burn.
- Multi-organizer edits to one tournament are last-write-wins (by design for now).
- Request bodies are validated ad hoc (no JSON schema layer). All *authorization* is
  server-side; malformed input is a robustness, not an integrity, concern.
