# warapp-mcp — phase 7 plan: a chrome-less "direct" transport

Worktree `/Users/chris/git/warapp-mcp-direct`, branch `feat/direct-mode` (from `origin/main`).
Never switch branches, never push, never touch other worktrees. Same hard rules as every phase:
**no live network in tests or agents, no captured data, synthetic fixtures only, the real account
email and the real AuthToken never in the repo.**

## Why

Live verification on 2026-11-12 established that war.app's signed-in session is carried by a
durable **`AuthToken`** cookie, and that this cookie **alone** authenticates:
- direct browser-less GETs of the server-rendered pages (InviteToken, Profile, CommonGames,
  MultiPlayer), and
- direct browser-less POSTs to the binary `/Services` protocol (`GetLatestGameInfo` returned a
  valid 3 KB reply frame with only `Cookie: AuthToken=…`, no browser).

So every call the bridge relays can instead be a plain HTTPS request with that cookie — removing
the need for a persistent Chrome tab in normal operation. Chrome is then only needed once, to
capture (or re-capture) the token.

## Security posture (applies to every task — read first)

- **`AuthToken` is a full-account credential.** Treat it exactly like `WARAPP_API_TOKEN`:
  never log it, never put it in a tool result, never in an error or hint string (scrub it **by
  value** from every upstream string, the way `src/config.ts` already scrubs the email and API
  token — reuse mcp-utils `stripBearer`/the existing scrubber). The session file is `0600`, its
  dir `0700`, written atomically (tmp + rename).
- **Tests and agents never see the real token and never hit war.app.** Use a fake token
  (`"test-auth-token"`) and a stubbed `fetch`/bridge. `git grep` the real email before any commit.
- **Direct mode is LOCAL-ONLY.** The hosted path (`mint.yaml`, `identity.perUserChild` + the
  GameFeed token) is **unchanged** — do not store an AuthToken on mcp-host. Direct mode is a
  local-runtime transport the owner opts into; say so in the docs.
- **The owner does the live capture and verification.** No agent captures or replays the real
  token; the capture flow is exercised in tests with a synthetic cookie string only.

## What is already in place (use it, don't reinvent)

- **One injection point.** `WarappRpc` (`src/protocol/rpc.ts`), the page fetches
  (`src/tools/live-context.ts` `fetchText`), the healthcheck (`src/tools/healthcheck.ts`) and the
  push socket (`src/push/socketio.ts`) **all** call `(await bridge.ready()).fetch({ method, path,
  headers?, body? })` returning a `FetchproxyFetchResult` (`{ status, … }`). Replace that one
  bridge with a direct-first bridge and all of them get direct mode at once.
- **mcp-utils `./fetchproxy`:** `createDirectFirstTransport` (router: `direct` | `fetchproxy` |
  `auto`, lazy bridge, fallback when a direct call throws a "walled" error, healthcheck slice,
  stats), `readTransportMode(envVar)`, `captureRequestHeader` / `captureBearerHeader` (capture a
  request header through the bridge), `stripBearer` (scrub a credential from a string). Bump the
  consumer's `@chrischall/mcp-utils` range only if a needed symbol is missing (a `fix:` PR).
- **mcp-utils `./netguard`:** `fetchPublic` for the direct leg's HTTPS (war.app is a fixed public
  host). Peer `undici`.

## Tasks

### M1 — the session token store (`src/direct/session.ts`)
- Read / write / clear the AuthToken at `<dataDir>/session.json` (`MCP_DATA_DIR`, else
  `~/.config/warapp-mcp`; same `dataDir` the bundle cache uses), shape
  `{ authToken: string, capturedAt: ISO string, host: 'war.app' }`. Dir `0700`, file `0600`,
  atomic write (tmp + rename), same hygiene as `src/trend.ts`'s board cache.
- Deferred: the server boots without it; a missing or corrupt file reads as `null`, never throws.
- A `scrubToken(s, token)` helper (reuse mcp-utils `stripBearer`; wire it into the existing
  config scrubber so the AuthToken is removed from every upstream error string, by value).
- **Tests:** write→read roundtrip; file is `0600`; missing / corrupt file → `null`; the token is
  scrubbed from a sample error string; a fake token only.

### M2 — the direct leg and the direct-first bridge (`src/direct/transport.ts`)
- `DirectBridge` implements the bridge's `.fetch(init)` surface used today: it issues a real
  HTTPS request (mcp-utils `fetchPublic`) to `init.path` on `war.app`, adding `Cookie:
  AuthToken=<token>` and copying `init.method` / `init.headers` / `init.body`, and maps the
  response into the same `FetchproxyFetchResult` shape the fetchproxy bridge returns (status, the
  body text, etc.). It reads the token from the store (M1) per call; no token → it throws a typed
  `SessionNotLinkedError` so the router falls back.
- Detect an expired/absent session: a login redirect, a sign-in page body, or a `/Services`
  reply that is not a valid reply frame when one was expected → throw a typed
  `SessionExpiredError`. Both typed errors feed `shouldFallBack`.
- `createWarappBridge({ store, makeBridge, mode })`: wires `createDirectFirstTransport({ direct:
  new DirectBridge(store), bridge: makeBridge, mode: readTransportMode('WARAPP_TRANSPORT'),
  serverName: 'warapp-mcp', hostLabel: 'war.app', shouldFallBack: <SessionExpired|SessionNotLinked
  |default edge-block> })` and returns an object shaped like today's bridge
  (`ready()` → `{ fetch }` that calls `legs.run((leg) => leg.fetch(init))`, plus
  `bridgeTransport()` / `status()` for the healthcheck). On a direct→bridge fallback it marks the
  stored token stale (so the next call doesn't retry a dead token every time) and emits the
  standard switch notice (never printing the token).
- **Tests** (stubbed `fetch` + fake bridge, no network): direct leg sets the `Cookie: AuthToken`
  header and the token appears in **no** log/error; mode `direct` / `fetchproxy` / `auto` from the
  env respected; a `SessionExpiredError` on the direct leg falls back to the bridge and marks the
  token stale; `status()`/`stats()` report the leg; `GetMapDetails`-style no-auth path still works.

### M3 — linking / relinking the session (`src/direct/link.ts` + a tool)
- `linkSession(bridge, store)`: capture the `Cookie` request header on a war.app request through
  the **bridge** (mcp-utils `captureRequestHeader`, host `war.app`), extract the `AuthToken=…`
  value from it, and store it via M1 (`capturedAt` = now). Ignore every other cookie. Never
  return or print the value.
- Tool `warapp_link_session` (write, confirm-gated via `defineWrite`/`registerWrite` like the
  other writes; owner-only intent): runs `linkSession`, reports **only** success + `capturedAt` +
  which transport is now active (never the token). A companion read `warapp_session_status`
  reports linked / not-linked, `capturedAt`, age, and the active leg — again never the token.
- On a direct-leg `SessionExpiredError` the router already fell back to the bridge for that call;
  the status tool surfaces "session expired — run warapp_link_session" so the owner relinks.
- **Tests:** `linkSession` parses the AuthToken out of a synthetic captured cookie string
  (`"FirstReferrer=x; AuthToken=abc123; AWSELB=y"` → stores `abc123`), ignores the others, stores
  it; a cookie with no AuthToken → a clear typed error, nothing stored; the tools never emit the
  token (assert the value is absent from the result).

### M4 — index wiring, config, healthcheck, docs, packaging
- `src/index.ts`: build the direct-first bridge from the session store + the existing fetchproxy
  bridge and pass it everywhere the bridge is passed today (one change — `WarappRpc`,
  live-context, healthcheck, push listener all already take the same bridge). The push socket
  rides it too, so chrome-less turn notifications come for free; keep that best-effort (if the
  direct socket path misbehaves, the router falls back to the bridge).
- Config: `WARAPP_TRANSPORT` = `auto` (default) | `direct` | `fetchproxy`, and
  `WARAPP_SESSION_FILE` (default `<dataDir>/session.json`). Document that `auto` tries direct when
  a token is linked and falls back to the bridge, and that `fetchproxy` is today's behaviour.
- Healthcheck: `registerAdaptiveHealthcheckTool` reports which leg is active and whether a session
  is linked + its age (never the token); on `direct` the probe is the credential probe, on
  `fetchproxy` the bridge probe — keep both working.
- Docs: README (a "Direct transport (no browser)" section: link once, then no Chrome; the
  security note; local-only), CLAUDE.md (a new bullet: the AuthToken fact, the one-injection
  design, local-only, never log the token), `docs/WEB-PROTOCOL.md` (AuthToken cookie
  authenticates `/Services` and the pages — mark **verified 2026-11-12**), `docs/WARAPP-API.md`
  if it lists transports, and the skill if it documents transports. `mint.yaml`: a comment that
  direct mode is local-only and hosting keeps the bridge (no stored token on the host).
- **Strict surface lint 0 warnings** (same recipe as `docs/PLAN-TURN.md` T4).

## Not in scope (note as follow-ups)
- Joining games (no `/Services` method decoded yet — still a browser action).
- Measuring AuthToken lifetime (owner re-runs the direct probe over days).
- Encrypting the session file at rest beyond `0600` (OS keychain) — a later hardening.
