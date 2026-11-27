# CLAUDE.md — warapp-mcp

Advisor MCP for war.app (Warzone) with two transports:

- **GameFeed (direct API):** `POST https://war.app/API/GameFeed?GameID=<n>` with a form body
  `Email=…&APIToken=…` — games, maps, chat, the board when GameFeed has one.
- **Web-client protocol (browser bridge):** binary frames POSTed to
  `https://war.app/Services?m=<name>&js=1`, relayed through the user's signed-in war.app tab
  by the fetchproxy bridge (ContextMint Bridge), because they are authenticated by the
  browser's cookies — the live board, territory picks, turn orders and chat sends. The spec is
  `docs/WEB-PROTOCOL.md`. War.app's socket.io push channel (turn notifications) rides the
  same bridge.

Build plans: `docs/PLAN.md` (phase 1, GameFeed), `docs/PLAN-LIVE.md` (phase 2, live board),
`docs/PLAN-TURN.md` (phase 3, plan and submit a turn), `docs/PLAN-SCOUT.md` (phase 4, my games
and opponent scouting), `docs/PLAN-CARDS-PUSH.md` (phase 5, cards, turn notifications,
threat-aware planner), `docs/PLAN-PLANNER-2.md` (phase 6, a smarter planner, from a lost game),
`docs/PLAN-PICKS.md` (the pick advisor; its heuristics and sources are in `docs/STRATEGY.md`),
`docs/PLAN-TEAMS.md` (chat, truces in free-for-alls and team play) and `docs/PLAN-PROFILES.md`
(opponent profiling: reading opponents' habits, and using the read next time).

## What is true only of this repo

- **Errors are HTTP 200.** GameFeed answers failures as 200 JSON `{ termsOfUse, error }`
  (`Auth failed`, `…ServerGameKeyNotFound`, `GameID must be an integer`). Never decide
  success from the status alone.
- **The healthcheck probes a game that does not exist** (`GameID=2147483647`): war.app
  checks credentials first, so `ServerGameKeyNotFound` proves the token works without
  loading a real game, and `Auth failed` is a rejected credential.
- **Credentials:** `WARAPP_EMAIL` + `WARAPP_API_TOKEN`, deferred (the server boots
  without them). `src/index.ts` loads `WARAPP_ENV_FILE` / `~/.config/warapp-mcp/.env`
  with `loadDotenvSafely` (host env wins). The token and email are scrubbed by value
  from every upstream error string. Never print or commit the real env file.
- **Hosted per user.** `mint.yaml` uses `identity.perUserChild` + `auth.fields`, because
  GameFeed answers as the player whose token is presented (fog of war included), and `auth.flow`
  (`docs/examples/warapp-auth-flow.json`, a path, so the document ships in the npm package's `files`):
  the war.app sign-in that captures the hosted direct leg's token (#333, below). Its
  egress is `war.app` and `warappcdn.com` (the bundle); `state.dataDir` keeps the fetchproxy
  identity and the bundle cache across cold starts.
- **Fifteen tools write, all confirm-gated:** `warapp_submit_picks`, `warapp_submit_turn`,
  `warapp_send_chat`, `warapp_join_game`, `warapp_leave_game`, `warapp_close_finished_game` (below), `warapp_surrender`, `warapp_accept_surrender`, `warapp_begin_turn`, `warapp_uncommit_turn`, `warapp_dismiss_notification` (marks war.app notifications read; reaches no other player), `warapp_delete_notification` (deletes war.app notifications, for good; reaches no other player), `warapp_mark_chat_read` (marks a game's chat read on war.app; reaches no other player, posts nothing), `warapp_import_state` (hosted only: this server's own state; below) and `warapp_link_session` (local only:
  it stores a session cookie on this machine and is not registered hosted), registered with mcp-utils' `defineWrite` / `registerWrite`
  (`confirmWrite`: elicitation, or a preview + single-use `confirmToken` per
  `MCP_CONFIRM_MODE`). Each gate binds the signed-in account read fresh in `plan` (`writeAccount`), the
  preview names it, and `execute` refuses if it changed (`requireApprovedAccount`, `src/tools/live-context.ts`),
  so an approval for one account never acts as another. The shared pieces are in `src/tools/write-kit.ts`:
  `requireMe` / `requireMySeat` (every write refuses an unreadable signed-in account, one wording),
  `sendAndVerify` (a refusal throws; no answer is `unknown` and is never read back or resent; #272: a
  failure before the request left — no email, the bridge not ready, marked by `WarappRpc.call`, `notSent` —
  throws "The request was not sent …, so nothing changed"; a failure inside the bridge's fetch, such as
  "fetch failed", may have left and stays `unknown`), and
  `defineGatedWrite`. Every write result carries `outcome` (`confirmed`, `accepted`, `unconfirmed`,
  `unknown`, `not_applied`; the per-tool mapping is in that file's header) beside its own `status`,
  which callers still read. `warapp_submit_picks` validates against the live board and reports
  `verified` only when `GetTerritoryPicks` reads back exactly what was sent. `warapp_record_agreement`
  also writes, but only the server's own agreement ledger and player record (nothing reaches war.app or a
  player), so it is not confirm-gated and not counted above. Nor is `warapp_sign_in` (hosted only, the
  sign-in mcp-host's authFlow calls; see the direct transport below): it starts a war.app session and
  reaches no player. `mark_seen: true` on `warapp_get_chat` and
  `warapp_chat_inbox` writes only this machine's chat cursor: both stay read-only, and war.app's own read mark is
  `warapp_mark_chat_read` (#311). Chat (owner decisions of 2026-11-14,
  `docs/PLAN-TEAMS.md` §5): D1 every send confirm-gated; D2 automated chat is off unless `WARAPP_CHAT_AUTOMATION=on`
  (#415, 2026-11-20, superseding 2026-11-15's plain OFF: chat is read, labelled and advised on always; only an
  agent's own reply is gated, below); D3 the honesty line is the plan's
  default (no false statement of fact, no promise the plan does not intend, withholding is free, never
  claim to be human, a truce ends with the agreed notice). Every other tool
  is read-only, `warapp_plan_turn`, `warapp_track_opponents` and `warapp_advise_diplomacy` included. The two-step token
  confirmation verifies no person — on a client that cannot prompt it is advisory (the model itself
  supplies the token) — so a write preview's sentences name things by id only, and every
  third-party name in a preview or a thrown error goes through `untrustedText` (`src/tools/common.ts`:
  delimited ⟦ ⟧, control characters, quotes and non-ASCII brackets neutralised, capped).
- **The client bundle is fetched at runtime, never vendored.** Board replies are decoded by
  interpreting war.app's own reader functions (`src/protocol/interp.ts`). `src/protocol/bundle.ts`
  discovers the current `ujs.js?v=<n>` from a war.app page (through the bridge), downloads it
  from exactly `https://warappcdn.com/js/Release/ujs.js` (any other host or path is refused; a
  timeout and a byte cap bound the download) and caches it at
  `<dataDir>/bundle/<version>.<sha256>.js` (`MCP_DATA_DIR`, else `~/.config/warapp-mcp`), deleting
  older versions once the current one loads. A cached copy is loaded only when its bytes still hash
  to the digest in its name; when the page naming the version cannot be read, the newest copy that
  verifies stands in for 5 minutes. Loading checks the built-in reader helpers against every
  definition the bundle gives them — `P.x=function`, an alias, an object-literal property — and
  builders by their item reads (`verifyDialect`, docs/WEB-PROTOCOL.md): a mismatch refuses the
  bundle, and so does an unverifiable `P.Ya`/`P.Yc`/`P.uq` (they read every army count); the
  result and the stand-in flag show in `warapp_session_status` and the live board's full view
  (`decoder`). A board whose `Armies` carry two numbers, on which every territory of mine reads 0
  armies, or whose current standing the reader's source does not name is refused, never shown as
  verified (#148). **The bundle is treated as hostile code:** the interpreter
  reads own properties only, refuses `constructor` / `__proto__` / `prototype`, lets natives call
  only interpreter closures (and the load-time check's own item readers), and bounds every read by a step budget, a call depth, size caps and a
  wall-clock deadline (`InterpError` kinds `forbidden` and `budget`) — the load-time helper check
  runs under the same rules. Never commit the bundle or snippets of it; tests use a hand-written
  mini-bundle in the same shape.
- **No captures in the repo.** No recorded frame, `*.hex` capture, or live reply goes into the
  repo — fixtures are synthetic (built by the encoder), with `test@example.com` and made-up
  ids. `git grep` for the real account email before committing. Tests and agents never call
  war.app; the owner does live verification.
- **The in-game player id is the GameFeed id minus two check digits each end**
  (`id.slice(2, -2)`); the digits vary per player.
- **A chrome-less "direct" transport** (`src/direct/`, phase 7 — `docs/PLAN-DIRECT.md`; hosted, #333).
  The signed-in session is carried by a durable **`AuthToken`** cookie, and that cookie **alone**
  authenticates both the server-rendered pages and a `/Services` POST (**verified 2026-11-12**).
  So the bridge has a direct-first router wrapped around it (`createDirectFirstBridge` in
  `src/direct/transport.ts`, over mcp-utils `createDirectFirstTransport`; the fetchproxy bridge
  itself is `createWarappBridge` in `src/transport-bridge.ts`): the direct leg issues a plain
  server-side HTTPS request carrying the cookie, falling back to the browser bridge when no session
  is linked or it has expired. **A sign-out is suspected, then confirmed:** a sign-in page or
  redirect, a 401 or 403 from war.app, a 200 `/Services` reply that is not a frame, or **war.app's own
  signed-out answer — a valid `/Services` frame carrying server error 3, `AuthFailed`** (live 2026-11-17:
  with no or a bogus AuthToken war.app answers exactly that, never a non-frame body, and a signed-out page
  such as `/MultiPlayer` is a plain 200 with no sign-in form) — is confirmed with one GET of
  `/InviteToken` with the cookie (`signInVerdict`: signed in is 200 "Your invite token is N", signed out a
  302 to `/LogIn?AuthNeeded=true`). Signed in → the reply passes through as an ordinary failure (rpc
  names error 3 `AuthFailed`), no wall; signed out or cannot tell → expired, as before. A GET of
  `/InviteToken` is its own probe. A 5xx passes through as an `http` error. A non-GET
  that reached war.app on the direct leg is **never re-sent over the bridge** (a write must not be
  sent twice); later calls use the bridge. The one reply that is re-sent is an edge challenge (a
  CDN/WAF page or `cf-mitigated` header, mcp-utils `detectEdgeBlock`), which never reached war.app —
  and a 200 that is a valid frame is war.app's answer, never a challenge, whatever header sits beside
  it. The direct leg sends the cookie to the exact origin `https://war.app` only: a GET follows
  redirects within it, a non-GET follows none. **Hosted, a wall is retried after a backoff:** a
  hosted child cannot be relinked in-process (its token's `capturedAt` is the constant
  `HOST_CAPTURED_AT`), so `WALL_RETRY_BASE_MS` (60 s) after the router leaves the direct leg — doubling for
  each wall in a row up to `WALL_RETRY_MAX_MS` (30 min), reset by a direct 200 — the next call tries direct
  again (a write that reaches war.app signed out is still never re-sent); before one odd reply kept a
  hosted child on the (usually unpaired) bridge until the process restarted. `wall()` (kind, reason, since,
  `retryAt`, `null` locally) shows in `warapp_session_status` and the healthcheck; `checkSession()` probes
  the session and, signed in, lifts any wall at once. A relink (`warapp_link_session`, or a new `capturedAt` on disk) clears the stale flag
  and returns `auto` to the direct leg. **Hosted, the direct leg and `warapp_sign_in` go through mcp-host's egress proxy**
  (`src/direct/egress.ts`): with `HTTPS_PROXY` set they send through an undici `ProxyAgent` for it instead of
  netguard's public-only dispatcher (which ignores the proxy, and a direct socket is dropped there), the war.app-only
  check kept in our code; an unusable proxy URL is refused, never a direct connection; and the push stays on
  xhr-polling over the router (no direct WebSocket) while a proxy is set. GameFeed and the bundle use global fetch.
  `WARAPP_TRANSPORT` = `auto` (default) | `direct` | `fetchproxy`; the session is stored at
  `WARAPP_SESSION_FILE` (default `<dataDir>/session.json`). One injection point: `index.ts` builds
  this one bridge and passes it to `WarappRpc`, the page fetches, the healthcheck and the push
  socket, so they all get direct mode at once. `warapp_link_session` (write, confirm-gated,
  local only) captures the cookie once through the bridge; `warapp_session_status` reports the
  linked state, age and active leg. **The `AuthToken` is a full-account credential:** file `0600`,
  dir `0700` (macOS: no ACL on either), atomic write; scrubbed by value from every upstream error string (mcp-utils
  `stripBearer` + `scrubToken`); never logged, never in a tool result (the one exception is
  `warapp_sign_in`'s, below), never in an error/hint.
  **Hosted, the direct leg serves only from the token mcp-host captured (#333, owner choice "token
  only"), enforced in code:** on a hosted child (`isHosted`, `src/hosted.ts`) `warapp_link_session` is
  not registered and the session FILE is never read or written (`writeSession` refuses;
  `src/direct/session.ts`). The war.app password is asked once in an mcp-host `authFlow` and never
  stored; only war.app's `AuthToken` is captured, as the per-user secret `WARAPP_AUTH_TOKEN`
  (`HOST_TOKEN_ENV`). `hostedSession` reads it into memory, read-only (trimmed, a leading
  `AuthToken=` dropped; a value that is not 16–4096 printable characters without `;` `,` `"` `\`
  is `malformed`, treated as absent and never echoed; `capturedAt` is `HOST_CAPTURED_AT`,
  `origin: 'host'`). With it, `createDirectFirstBridge` resolves `WARAPP_TRANSPORT` as locally
  (`auto`: direct first, the bridge its fallback, the non-GET never re-sent) from that token alone
  (the given store is not consulted); `warapp_session_status` and the healthcheck say
  `linked: true` with `linkedBy: 'host'` (`linked` stays a boolean, #335) (no capture time, no age); a signed-out session's errors, log line and
  hints say to use "Sign in" on the connection, or reconnect it, and that a paired war.app tab works meanwhile
  (`HOST_SIGN_IN_ADVICE`; mcp-host runs the login again, the router falls back to the bridge), never
  `warapp_link_session` (`LiveContext.hostSignIn`, `accountUnknown(ctx)`).
  Without it a hosted child is byte-identical to before: the store reads as empty, the router is
  pinned to the browser bridge whatever `WARAPP_TRANSPORT` says, and no hint suggests linking.
  Locally `WARAPP_AUTH_TOKEN` is ignored: only the session file counts. The flow is
  `docs/examples/warapp-auth-flow.json` (one masked password prompt on a step that calls the
  read-only `warapp_session_status`; the capture is the sign-in itself, `warapp_sign_in` with
  `email` from `WARAPP_EMAIL` and that password, `authToken` into `WARAPP_AUTH_TOKEN`: one war.app
  attempt, the token never in the gateway-readable bag). No paste-the-cookie fallback ships:
  `warapp_sign_in` takes no cookie argument, so such a flow would be an `isError` that ends the
  login (a test keeps the document, the hint and the manifest from offering one until it is built).
  `mint.yaml` declares the password flow as `auth.flow` (a path inside the package). **Once a
  registration carries the flow, every new connection needs one successful war.app password sign-in:**
  mcp-host ends the login with no grant on ANY `isError` from the capture (`credential_rejected`,
  `edge_blocked`, `transport`, `timeout`, `http`, `unknown`), so a captcha, an outage or a network fault
  ends it like a wrong password and may clear the fields already entered, and an account with no war.app
  password (Facebook sign-in) cannot connect. The bridge is the fallback only for a connection made before
  the flow was added and for a session that expires later. Adding the flow is the owner's decision.
  `tests/auth-flow-doc.test.ts` checks it against mcp-host's rules offline. **`warapp_sign_in` (part B, `src/direct/sign-in.ts`, `src/tools/sign-in.ts`)
  is registered ONLY hosted** (locally `warapp_link_session` stays the way). It takes `email` and
  `password` and makes ONE attempt, never retried (war.app may count failed sign-ins): GET
  `https://war.app/LogIn` for its cookies (`jses_WS60`, `FirstReferrer`, `AWSELB`; a page without its
  password form, or a bot check, refuses before any password is sent), then one form POST to the same
  URL (`Email`, `Password`, `KeepSignedIn=on`, those cookies); redirects are followed by hand, at most 3
  per phase, every one as a GET (the password is never re-sent, a 307/308 included) and only within
  the exact origin `https://war.app` (anywhere else is refused unrequested), through netguard's
  public-only dispatcher, one 30 s deadline, a 2 MiB cap per body. Success is an `AuthToken` set on any
  hop after the POST (one the page sets alone does not count; a deletion does not count; one that fails
  `isPlausibleAuthToken`, the hosted child's own shape check, is refused rather than kept). Refusals:
  `credential_rejected` (the form came back), `edge_blocked` (detectEdgeBlock, captcha markup, 403,
  429), `transport` / `timeout` (saying whether the POST had gone), `http` / `unknown`; the email (any
  case), the password and every cookie value of 6+ characters are scrubbed by value and the cause is
  dropped. **Its result `{ authToken }` is the single documented exception to "never in a tool
  result":** mcp-host's capture reads the credential from the capture tool's result, and the caller
  already holds the password, so it grants nothing new; nothing else about the account is returned.
  Not confirm-gated (the flow sends only the arguments its document declares); annotated not
  read-only, not destructive, not idempotent, open-world. Hiding it from the
  menu (`enabledTools` left without it) is an owner choice, off by default: mcp-host never checks a flow's
  step or capture tool against that allowlist (`wire.ts` `toolCallRequestSchema`), but the gate is
  fail-closed, so once set the connection's resources (`warapp://strategy`) and prompts are gone, and every
  tool a later release adds stays hidden until the list is edited by hand. The design, trade-off, registration change
  and the unbuilt paste fallback are in `docs/PLAN-DIRECT.md`.
- **A frozen war.app tab stalls bridged POSTs.** Chrome freezes background tabs; the bridge
  relays `/Services` POSTs through a page tab, so they time out ("did not respond within
  30000ms") while GETs (run by the extension) still work. Reloading or focusing a war.app tab
  clears it. Live verification found this repeatedly — say so in any timeout hint. Every bridged
  `/Services` timeout carries `FROZEN_TAB_HINT` (`src/tools/live-context.ts`), and the write tools'
  `unknown` warnings repeat it (`failureText`).
- **"Me" is the signed-in account.** The live tools default `player` to the account whose
  invite token (`https://war.app/InviteToken`, read through the bridge) matches a GameFeed
  player id; the bundle is discovered from `https://war.app/MultiPlayer` (the homepage does
  not load the game client).
- **Scouting never returns personal fields.** The Profile page also shows self-reported
  details such as location: the parser projects an **allowlist** (name, level, games, real-time
  share, last seen, boots, ranked records, common games) and nothing else. Never add location
  or any other personal field to the output, a fixture's expected output, or a doc example;
  the tests feed a page that carries a location and assert it is absent.
- **Every GameFeed scalar is a string** (ids, counts, booleans); normalize before use —
  see `docs/PLAN.md` "Facts". Fixtures under `tests/fixtures/` are anonymized.
- **API facts live in `docs/WARAPP-API.md`**, each marked verified or unverified. The board
  standing parser (`src/board.ts`) is unverified and must stay loose (never throw). Territory
  and bonus ids overlap, so a bonus member is a territory first and a superbonus only otherwise.
- **All GameFeed traffic goes through `WarappClient` (`src/client.ts`)**, including the
  credential healthcheck probe; all `/Services` traffic goes through `WarappRpc`
  (`src/protocol/rpc.ts`), which echoes the reply extras into the next request. Maps are
  cached in memory (`MapCache`) and on disk (`src/map-store.ts`, local and hosted: the per-user
  `state.dataDir` persists): `<dataDir>/maps/<mapId>.json` holds the normalized map with its BASE
  bonus values (overrides are per game, applied by `mapOf`), at most `MAX_STORED_MAPS`, the least
  recently used evicted (a memory hit marks the file used, and stores it again if it has gone, so a
  game played all session keeps its map for replay; #586: the map of a game with a decision log is pinned in
  `<dataDir>/maps/pinned.json` by `capturePlan` — the log keeps `mapId` — never evicted and not counted toward the cap, and
  unpinned when `pruneDecisionLogs` drops the log); `<dataDir>/maps/games.json` says which map a game is on (bounded), so a
  known game is re-fetched with `GetMap=false` after a restart too. That index is written only for
  a caller that wants the map, on a game not finished (map statistics and `GetMap=false` callers
  spend no entry; a game read back from it after a restart moves to the newest). **A map is not immutable:** its maker can publish an edit under the same id and
  GameFeed sends no map version, so a stored map carries `storedAt` and is trusted for
  `MAX_MAP_AGE_MS` (30 days); older, or with no `storedAt`, it reads as absent and the game is
  fetched with its map again (the fresh copy replaces it). Within that time, a feed standing that
  names a territory the cached map lacks has the game fetched with its map again (once per map per
  process). Offline replay reads a stored map
  whatever its age. A bad file is ignored and
  replaced; the disk never fails a call. A tool
  that never uses the map (the turn wait, surrender, uncommit, chat — a send with `commitments` aside, which
  plans — join-game, scout, begin-turn, submit-turn's read-back) asks `GetMap=false` for its own reads, even for a game
  it has not seen. The one exception is the end-of-game pass that the turn wait (like `warapp_get_game`, the
  `warapp_my_games` sweep and `warapp_get_notifications`) runs on a finished game: its history read asks
  `GetMap=false` too, but with no map cached it makes one more read for the map (#312).

## Where the rest lives

Detail on each area loads with the folder it describes:

- `src/analysis/CLAUDE.md`: the planner, the estimates, opponent tracking and profiles, picks, the turn simulator and the self-play arena.
- `src/tools/CLAUDE.md`: the tools, the stores they keep and the protocol calls behind each feature.
- `src/protocol/CLAUDE.md`: the client protocol, the bundle reader and its dialect.
- `src/push/CLAUDE.md`: turn notifications (the socket.io push channel).

## Commands

`npm run build` (tsc, which emits `dist/**` — what `scripts/calibrate.mjs` imports — then the esbuild bundle) · `npm test` (typecheck + lint + vitest) ·
`npm run test:coverage` (what CI runs: `npm test` plus the coverage thresholds in `vitest.config.ts`) · `npm run typecheck` ·
`npm run lint` (Biome, lint only — no formatter; `biome.json` turns off the house-style rules such as
`noNonNullAssertion`, which `noUncheckedIndexedAccess` makes the idiom). `exactOptionalPropertyTypes`
is off until `src/analysis/planner.ts` is clean under it.
