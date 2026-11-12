# warapp-mcp — phase 2 plan: live board, picks and chat through the web-client protocol

Branch `feat/live-board` (local; the orchestrator pushes and opens the PR). Read
`docs/WEB-PROTOCOL.md` first — it is the spec. Working prototypes (not in the repo; read
them, port them, do not copy them in verbatim):

- `/private/tmp/claude-501/-Users-chris-git/a9f97c72-9b32-4781-9d11-4eca7cf761fc/scratchpad/warapp/wlproto.py`
  — frame encoder/decoder (Python), incl. `frame()`, `extras_up()`, `auth()`, order encoders.
- `/private/tmp/claude-501/-Users-chris-git/a9f97c72-9b32-4781-9d11-4eca7cf761fc/scratchpad/warapp/interp/interp.mjs`
  — interpreter that evaluates the client bundle's own `<Class>.Ha` reader functions against
  bytes (acorn-based), with `decode.mjs` / `intlist.mjs` / `status.mjs` showing reply envelopes.
- The live bundle is `https://warappcdn.com/js/Release/ujs.js?v=<n>` (~16 MB). A local copy for
  reading only: `/private/tmp/claude-501/-Users-chris-git/a9f97c72-9b32-4781-9d11-4eca7cf761fc/scratchpad/warapp/js/ujs.js`.

## Hard rules for every task

- **No live network in tests or in your own verification.** Never call war.app, never send a
  frame, never run `fpx`/`rpc.sh`. The owner does live verification. Tests use synthetic
  frames built by the encoder and a synthetic mini-bundle.
- **No captured data in the repo.** Nothing under `scratchpad/warapp/frames/` or any `*.hex`
  capture may be copied into the repo. Fixtures use `test@example.com`, made-up ids, and
  synthetic bytes. `git grep` for the real account email (in `~/.config/warapp-mcp/.env`,
  never print it) before committing — zero hits.
- **Do not vendor the bundle or snippets of it.** At runtime the client fetches `ujs.js` from
  War.app's CDN (version discovered from a war.app page's `<script src>`), caches it under the
  data dir, and interprets it. Tests use a hand-written mini-bundle in the same shape.
- TDD; `npm run build`, `npm test`, `npm run test:coverage`, `npm run typecheck` green before
  each commit. Stage exact paths. Conventional commits ending with the Co-Authored-By trailer.

## Tasks

### L1 — Protocol codec (`src/protocol/codec.ts`, `src/protocol/methods.ts`)
Writer/Reader for the primitives in WEB-PROTOCOL.md (bool strict, int16/32/64, float32/64,
7-bit-length strings with present flag, datetime = float64 ms since 2000-01-01 with the
"no date" sentinel, GUID .NET order, lists/dicts with -1 = null). `encodeRequest({ method,
msgNum, extras, email | null, params })`, `decodeReplyEnvelope(bytes)` → `{ method, msgNum,
extrasDown?, error?: { code, message }, body: Reader }` (byte 1 → extras, byte 5 → error).
Method ids as named constants (39, 40, 42, 73, 74, 75, 76, 77, 79, 80, 81). Order encoders for
Deploy and AttackTransfer per the doc, exported but marked unverified. Tests: round-trips,
golden byte vectors computed by hand from the doc for a synthetic GetMapDetails/picks frame,
malformed input (bad preamble, bad bool, truncated) rejected with typed errors.

### L2 — Bundle interpreter (`src/protocol/interp.ts`, `src/protocol/bundle.ts`)
Port `interp.mjs` to TypeScript (add `acorn` as a dependency): class-name index from
`W["…"]=X;`, static resolution with whitespace-tolerant `X.fn=\s*function`, constructors via
`function X(` with `this`, switch/break, instanceof by registered type name, closures for
`P.Sd/ms/uL/ef`. `bundle.ts`: discover the current `ujs.js` URL from a war.app HTML page
(injected fetcher), download, cache to `<dataDir>/bundle/<version>.js`, and expose
`readClass(typeName | var, reader)` keyed by **stable type name** (e.g.
`warlight.shared.LatestGameInfo`), resolving the minified var from the registration. Tests with
a synthetic mini-bundle (a few classes with primitives, a nested class, a list, a dict, a
constructor, a switch, a version check) proving every construct, plus "unknown construct"
errors that name the location.

### L3 — Bridge transport (`src/protocol/rpc.ts`, `src/transport-bridge.ts`)
`createFetchproxyTransport` from `@chrischall/mcp-utils/fetchproxy` (add `@fetchproxy/server`
as a dependency; port from `readPortEnv('WARAPP_WS_PORT', 37149)`; serverName `warapp-mcp`;
domains `['war.app']`), started at boot. `WarappRpc.call(methodName, methodId, writeParams)`:
builds the frame (email from config), POSTs the uppercase hex through the bridge to
`https://war.app/Services?m=<name>&js=1` with content-type
`application/x-www-form-urlencoded; charset=UTF-8`, decodes the envelope, maps server error
codes to `McpToolError` (33, 36, 88, 208, 333, 11 with the client's own wording), and **echoes
`serverInfoVersionA/B` and `kFa` from each reply's extras into the next request**. Message
numbers increase per process. Healthcheck: `registerAdaptiveHealthcheckTool` so the existing
credential check and the bridge status are one tool. Tests with an injected mock server
(`createServer` seam) — no `vi.mock('@fetchproxy/server')`.

### L4 — Tools
- `warapp_get_live_board` (read): `GetLatestGameInfo` → normalized territories (id, name from
  the map, owner as player name / "neutral" / "pickable", armies, fogged) + players; works in
  the pick phase and mid-game; `view` compact/full; untrusted framing for names.
- `warapp_get_my_picks` (read): `GetTerritoryPicks(gameId, myPlayerId)`; the player id is the
  GameFeed player id with its `64…16` wrapper removed (derive, test the derivation).
- `warapp_submit_picks` (write): confirm-gated with `confirmWrite` (`defineWrite` /
  `registerWrite`); validates ids are pickable on the live board and the count ≤ 2×TerritoryLimit;
  after sending, re-reads `GetTerritoryPicks` and reports verified only on an exact match.
- `warapp_get_chat` (read): official `GameFeed` `GetChat=true`; untrusted framing.
- `warapp_send_chat` (write): `SendChat`, public (channel -1) or private to a named player;
  confirm-gated; description says a message reaches other players and cannot be unsent.
- `warapp_analyze_board` accepts the live board when GameFeed has none.
All annotated (`toolAnnotations`), `_meta.mint` hints per the existing hints test (update its
table), manifest roster updated.

### L5 — Docs and packaging
README (bridge requirement: ContextMint Bridge + a signed-in war.app tab; pairing), CLAUDE.md
(no longer read-only: which tools write and how they are gated; the bundle-at-runtime rule; the
"no captures in the repo" rule), `mint.yaml` (state.dataDir true with the reason: fetchproxy
identity + bundle cache; a comment that hosting needs `bridge: true`, `bridgePortEnv:
WARAPP_WS_PORT`), `manifest.json`/`server.json` env (`WARAPP_WS_PORT`), skills/warapp-mcp
SKILL.md tool list. Order submission stays out until a live turn capture verifies `SendOrders`.
