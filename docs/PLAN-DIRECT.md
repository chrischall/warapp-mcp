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
- **Hosted, direct mode runs only on the token mcp-host captured (#333, superseding "local-only").**
  The owner chose "Build it, token only": the war.app password is asked once in an mcp-host
  `authFlow` and **never stored**; only war.app's `AuthToken` is captured, as the per-user secret
  `WARAPP_AUTH_TOKEN`, and the hosted child reads it into memory (`hostedSession`,
  `src/direct/session.ts`), never into a file. The bridge stays the fallback on the same
  registration. A hosted child still never reads or writes a session file and never registers
  `warapp_link_session`; without the captured token it is pinned to the bridge exactly as before.
  Part A (built) is the transport, status and hints; part B is the war.app sign-in tool the
  `authFlow` calls (`warapp_sign_in`, built from the form and endpoint the owner's play session
  traced live, never guessed) and the `mint.yaml` flow (`auth.flow: docs/examples/warapp-auth-flow.json`,
  declared; see "Hosted direct mode" below).
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
  `{ authToken: string, capturedAt: ISO string, host: 'war.app' }`. Dir `0700` (an existing
  one of ours tightened, another user's refused, root's refused when others can write to it; on
  macOS every ACL stripped from the directory and the file), file `0600`, atomic
  write (a random tmp name created exclusively, then rename).
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
  `SessionExpiredError`. Both typed errors feed `shouldFallBack`. Since #131 a 401 or 403 is a
  signed-out session too, and an edge challenge (read from the kept response headers and the
  body by mcp-utils `detectEdgeBlock`) is an `EdgeBlockedError` that falls back without marking
  the token stale. UNVERIFIED: war.app has not been seen answering 401/403 or a challenge to the
  direct leg; the classification follows the HTTP meanings.
- `createDirectFirstBridge({ store, makeBridge, mode })` (named `createWarappBridge` when planned; renamed so it no longer collides with the fetchproxy `createWarappBridge` in `src/transport-bridge.ts`): wires `createDirectFirstTransport({ direct:
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
  security note), CLAUDE.md (a new bullet: the AuthToken fact, the one-injection
  design, hosted only from the host-captured token, never log the token), `docs/WEB-PROTOCOL.md` (AuthToken cookie
  authenticates `/Services` and the pages — mark **verified 2026-11-12**), `docs/WARAPP-API.md`
  if it lists transports, and the skill if it documents transports. `mint.yaml`: a comment on
  how hosting reaches the direct leg (#333: a host-captured token only, never a stored session).
- **Strict surface lint 0 warnings** (same recipe as `docs/PLAN-TURN.md` T4).

## Hosted direct mode (#333, owner choice "Build it, token only")

### Design
- **The login is an mcp-host `authFlow` with a `capture`** (mcp-host `docs/REGISTERING.md`,
  "`authFlow`"; the flow is `docs/examples/warapp-auth-flow.json`). The email and the API token stay
  `authFields` (GameFeed needs them on every call). The flow then asks for the war.app password on one
  page, as a masked **prompt**, so it lives only in the flow's value bag for that one exchange: never
  an `authField`, never a stored secret, redacted by mcp-host out of every upstream text it quotes.
- **The sign-in is the capture.** `capture` calls `warapp_sign_in` with
  `{ email: {from: WARAPP_EMAIL}, password: {from: password} }` and keeps its result key `authToken`
  as the per-user secret `WARAPP_AUTH_TOKEN` (`HOST_TOKEN_ENV`), injected on every later spawn. A
  `capture` is its own tool call after the steps, and a prompt belongs to a step, so the one step is
  a carrier for the password page: it calls `warapp_session_status` (read-only, no arguments, no
  network), and the sign-in runs right after it in the same request. Doing the sign-in as the
  capture, not as a step, means one war.app attempt per login, and the token goes straight from the
  child's result to the sealed principal secret, never through the gateway-readable bag (a `carry`).
- **The hosted child** reads `WARAPP_AUTH_TOKEN` into memory (`hostedSession`, part A, built) and
  serves the direct leg from it, the bridge its fallback; no session file is ever read or written
  hosted, and `warapp_link_session` stays unregistered. Signed out, every hint says "Sign in" on the
  connection, or reconnect it, which re-runs the same flow (admin portal **Sign in**, or reconnecting).
- **`mint.yaml` declares the flow** as `auth.flow: docs/examples/warapp-auth-flow.json`. mcp-host reads
  a string there as a path inside the package (`flowPath`, fetched at the registration's pin: jsDelivr
  for an npm source), so the document is in `package.json` `files`. Both are checked by
  `tests/auth-flow-doc.test.ts`. The manifest is a proposal at registration, never applied to an
  existing registration by itself: the owner adds the flow (steps below).
- **`warapp_sign_in` (part B, built: `src/direct/sign-in.ts`, `src/tools/sign-in.ts`).** Built from
  #333's sign-in trace (`https://war.app/LogIn`, a plain form POST of exactly `Email`, `Password`,
  `KeepSignedIn=on`, no hidden fields, no captcha); how a success answers and where `AuthToken` is set
  are still unverified live, so it accepts the cookie on ANY hop after the POST. The exchange: GET the
  page and keep its cookies (`jses_WS60`, `FirstReferrer`, `AWSELB`); refuse before sending any
  password when the page shows a bot check or no password form; ONE POST carrying those cookies;
  follow at most 3 redirects per phase by hand, each as a GET (the password is never re-sent, a
  307/308 included), only within the exact origin `https://war.app` (anywhere else refused without
  being requested); netguard's public-only dispatcher, one 30 s deadline, a 2 MiB cap per body. Never
  retried (a refused credential is terminal in mcp-host, and war.app may count failures). Refusals are
  each told apart in an `isError`: `credential_rejected` (the form came back), `edge_blocked`
  (mcp-utils `detectEdgeBlock`, captcha markup, 403, 429), `transport` / `timeout` (saying whether the
  POST had gone), `http` / `unknown`; their text never holds the email, the password or a cookie value
  (scrubbed by value, the cause dropped). A token the hosted child would read as malformed
  (`isPlausibleAuthToken`) is refused, not returned. On success the result is exactly
  `{ "authToken": … }`, a JSON object in one text block (mcp-host's `toolCallResultFrom` reads the
  capture's `path` from it). **That result is the one documented exception to "the token is never in
  a tool result"**: the capture needs it there, and the caller already holds the password, so it
  grants nothing new. Registered only hosted (locally `warapp_link_session` stays the way). It is
  not confirm-gated, so the flow sends only the two arguments its document declares; instead the
  registration should hide it from the connector's menu: leave it out of `enabledTools` (`--tools`).
  mcp-host never checks a flow's step or capture tool against that allowlist (`packages/core/src/wire.ts`
  `toolCallRequestSchema`: "a login tool is often hidden from the menu"), so the flow still calls it
  while no chat client sees it. It takes no cookie argument (see "Not built" below). The flow
  document is part of the contract: `tests/auth-flow-doc.test.ts` checks it against mcp-host's rules
  offline (every `{from}` provided earlier, the capture never over an `authField`, a host-set or
  loader variable, `perUserChild`, the step tools and the capture tool registered hosted with exactly
  the arguments sent).

### The security trade-off the owner accepted
This reverses the "direct mode is local-only" rule. War.app's `AuthToken` is a full-account
credential, and it is now stored hosted, as a per-user mcp-host secret (sealed to the account key),
rather than only on the owner's machine. Accepted with these mitigations: the password is never
stored (asked once per sign-in, held only for that exchange); the token is per user (a child per
caller), held in memory by the child, scrubbed by value from every upstream string (`stripBearer` /
`scrubToken`), never in a log, error, hint or any tool result but the capture's own; revoking the
connection deletes it and **Sign in** replaces it in place; egress stays `war.app` and
`warappcdn.com`. Still unknown and owner-verified live: the token's lifetime, and whether war.app
binds it to the IP or user agent (a hosted child's egress IP differs from the browser's).

### Not built: a paste-the-cookie fallback (captcha, or an account with no war.app password)
If war.app ever puts a captcha or bot check in front of a server-side sign-in (none on the page as
traced), or for an account that signs in through Facebook and has no password, a flow could ask for
the `AuthToken` cookie from the browser's developer tools instead of the password. **It is not built,
and no flow document for it ships:** `warapp_sign_in` takes only `email` and `password`, both
required, so a capture sending `{ auth_token }` would be a schema `isError`, which mcp-host reads as a
refused credential (the login ends and the collected credentials are deleted). Building it means an
`auth_token` mode on `warapp_sign_in` (one cookie-only GET to war.app to check the session, then
`{ authToken }`), its flow document, and the capture-args check in `tests/auth-flow-doc.test.ts`
extended to it. Until then a bot check on the sign-in (`edge_blocked`) leaves the connection on the
browser bridge, which the registration keeps as its fallback.

### Registration change for the owner to apply (after part B ships in a release)
On the hosted registration (`warapp`, today `authFields` `WARAPP_EMAIL` + `WARAPP_API_TOKEN`,
`perUserChild`, `dataDir`, `bridge: true`, `bridgePortEnv: WARAPP_WS_PORT`): **add** the `authFlow`,
**keep** everything else (the bridge stays the fallback on the same registration: a session that
stops working, or a connection that has not signed in yet), and **hide** `warapp_sign_in` from the
menu. The exact steps:

1. **Wait for the release.** `npm view @chrischall/warapp-mcp version` shows the version with
   `warapp_sign_in`, and the registration's pin is on it (`mcp-host get <id>`: `source.version`;
   a `latest` pin resolves at the next spawn, an exact pin needs `mcp-host set <id> --data
   '{"source":{"type":"npm","pkg":"@chrischall/warapp-mcp","version":"<new>"}}'`).
2. **Register the flow**, either way:
   - on the existing registration: `mcp-host set <id> --data "$(jq -c '{authFlow: .}'
     docs/examples/warapp-auth-flow.json)"` (the control API's `PUT /api/v1/registrations/<id>` with
     the whole `authFlow` document; it is not part of `configHash`, so no running child is retired
     and nobody connected is signed out), or
   - by re-registering from the package: the preview reads `mint.yaml`'s `auth.flow` path from the
     tarball and proposes the flow; accept it (`mcp-host register … --auth-flow
     docs/examples/warapp-auth-flow.json` gives the same document explicitly).
   A refusal at this step (a `{from}` nothing fills, a capture over an `authField`) is mcp-host
   reading the document: report its text verbatim; `tests/auth-flow-doc.test.ts` should have caught it.
3. **Hide `warapp_sign_in`** from the connector's menu: `mcp-host set <id> --tools <every other
   tool>` (an `enabledTools` list). The flow still calls it; mcp-host never checks a flow's step or
   capture tool against that list.
4. **Connect.** On the connection (admin portal), run **Sign in** (or disconnect and connect again):
   the page asks only for the war.app password, masked. Enter it once.
5. **Verify.** Call `warapp_session_status` on that connection. Expected:
   `{ hosted: true, linked: "host-captured", activeTransport: "direct" }` and a `hostedNote` saying
   war.app calls go directly to war.app. Then one live read (`warapp_my_games`) and call
   `warapp_session_status` again: `activeTransport` still `direct`, no `sessionExpired`. If it says
   `linked: false` with `activeTransport: "fetchproxy"`, the child is still the one spawned before
   the sign-in (see UNVERIFIED below): wait for it to idle out, or retire it, and check again.

**What to report** (on #333; never the token, the password or the email): the release and pin; the
step-2 command's answer (accepted, or the refusal text); what the Sign in page showed (one password
field, the help text) and whether it succeeded, or the `warapp_sign_in` refusal kind it named
(`credential_rejected`, `edge_blocked`, `transport`, `timeout`, `http`, `unknown`); the
`warapp_session_status` answers from step 5 (`linked`, `activeTransport`, `pushTransport` once a turn
wait has run, `sessionExpired` if present); whether the first calls after Sign in rode the bridge
until the child respawned; and, over the following days, when (if ever) the session went stale
(`sessionExpired: true`), which measures the token's lifetime from a hosted egress IP.

**UNVERIFIED, to be checked by those steps:**
- **A re-run Sign in may not restart a running child.** mcp-host injects `WARAPP_AUTH_TOKEN` at
  spawn; a child already running when the token is captured (or replaced) may keep the
  environment it started with until it idles out or is retired, so the first calls after Sign in
  may still use the bridge (or the old, signed-out token, reported stale) until the respawn.
- **The hosted push WebSocket depends on mcp-host's egress.** The turn-notification socket
  upgrades to `wss://war.app/socket.io/1/websocket/<sid>` from the child itself; that works only if
  mcp-host's egress fence lets the upgrade through to `war.app`. If it does not, the listener falls
  back to xhr-polling over the bridge (`pushTransport: "xhr-polling"`), which still needs the
  user's tab: report which `pushTransport` a hosted turn wait shows.

## Not in scope (note as follow-ups)
- Joining games (no `/Services` method decoded yet — still a browser action).
- Measuring AuthToken lifetime (owner re-runs the direct probe over days).
- Encrypting the session file at rest beyond `0600` (OS keychain) — a later hardening.
