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
and opponent scouting) and `docs/PLAN-CARDS-PUSH.md` (phase 5, cards, turn notifications,
threat-aware planner).

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
  GameFeed answers as the player whose token is presented (fog of war included). Its
  egress is `war.app` and `warappcdn.com` (the bundle); `state.dataDir` keeps the fetchproxy
  identity and the bundle cache across cold starts.
- **Three tools write, all confirm-gated:** `warapp_submit_picks`, `warapp_submit_turn` and
  `warapp_send_chat`, registered with mcp-utils' `defineWrite` / `registerWrite`
  (`confirmWrite`: elicitation, or a preview + single-use `confirmToken` per
  `MCP_CONFIRM_MODE`). `warapp_submit_picks` validates against the live board and reports
  `verified` only when `GetTerritoryPicks` reads back exactly what was sent. Every other tool
  is read-only, `warapp_plan_turn` included.
- **Turn submission (`warapp_submit_turn`) sends `SendOrders`** (card plays, then deploys, then moves;
  encoders in `src/protocol/methods.ts` are golden-pinned to a live commit), turn number =
  GameFeed `numberOfTurns` + 1. It always acts as the signed-in account (refuses any other
  `player`, and refuses when that account cannot be determined), validates on the live board
  (own sources, adjacent moves, armies ≤ armies + deployed − 1, deploys = planner income —
  the server's error 11 otherwise), and refuses outside a turn phase or when my
  `hasCommittedOrders` is already true (a second `SendOrders` replacing the first is
  unverified; the client uses "Modify orders"). **Success is read from game state, never
  from the reply:** its bool is the "vacation ended" flag. After sending, GameFeed is re-read:
  `numberOfTurns` advanced → `resolved`; my `hasCommittedOrders` true → `committed`; neither,
  or a transport failure after sending → `unknown` (never suggest resending blindly).
- **Cards (`src/cards.ts`).** The hand is read from the live board (`LatestGameInfo` standing →
  my in-game id → GUID → card instance, by bundle type name); the rules from GameFeed settings
  (`MaxCardsHold`, `ReinforcementCard.FixedArmies`; a card set to `'none'` is not in play). At
  the hold limit war.app refuses a `SendOrders` with no card play (**error 51 `MustUseCard`**),
  so `warapp_submit_turn` refuses up front. The planner always plays Reinforcement (its armies
  join the income) and, only when a play is required, Order Priority, else Order Delay — never
  Blockade (it gives a territory away). Card plays must come in war.app's turn-phase order or
  the server answers **error 10 `OrdersInIncorrectOrder`**, so `writeSendOrdersParams` sorts
  every order by `TurnPhase` (Order Priority 12, Reinforcement 20, deploys 25, moves 50,
  Blockade 60). Order Delay's phase is unverified, so `warapp_submit_turn` refuses it alongside
  other card plays.
  Play-card encoders are golden-pinned; a GUID is written as its 16 bytes in .NET order.
- **Turn notifications are a socket.io v0.9 xhr-polling client over the bridge**
  (`src/push/socketio.ts`): handshake GET, then the first poll must return the connect packet
  `1::` before any POST (a POST first is HTTP 400); heartbeats `2::` are answered; `Subscribe`
  (method 238, no auth block) to `Game.<id>`. A push is method 241 `GameUpdated` carrying only
  the game id, so `warapp_wait_for_turn` re-reads GameFeed on each one. One listener per process
  (`src/push/listener.ts`), started lazily: many processes sharing the bridge port collide.
  Tests drive it against a scripted fake bridge, never a socket.
- **Threat model.** The planner assumes an enemy deploys max(5, round(0.75 × the largest visible
  enemy stack)) (`enemyDeploy` / `enemy_deploy`), because enemy income is unseen — live, 13
  visible armies broke a 12-army border.
  With a previous board (`previousBoard`), an adjacent enemy stack that grew raises that
  border's threat to movable + max(enemyDeploy, growth). `warapp_plan_turn` gets it from
  GameFeed `GetHistory` (unverified in progress, parsed loosely in `src/trend.ts`), else from
  `<dataDir>/boards/<gameId>.json`, written after each plan (newest two turns kept, so re-planning a
  turn keeps the trend); it reports `trendSource`.
- **The client bundle is fetched at runtime, never vendored.** Board replies are decoded by
  interpreting war.app's own reader functions (`src/protocol/interp.ts`). `src/protocol/bundle.ts`
  discovers the current `ujs.js?v=<n>` from a war.app page (through the bridge), downloads it
  from `warappcdn.com` and caches it at `<dataDir>/bundle/<version>.js` (`MCP_DATA_DIR`, else
  `~/.config/warapp-mcp`). Never commit the bundle or snippets of it; tests use a hand-written
  mini-bundle in the same shape.
- **No captures in the repo.** No recorded frame, `*.hex` capture, or live reply goes into the
  repo — fixtures are synthetic (built by the encoder), with `test@example.com` and made-up
  ids. `git grep` for the real account email before committing. Tests and agents never call
  war.app; the owner does live verification.
- **The in-game player id is the GameFeed id minus two check digits each end**
  (`id.slice(2, -2)`); the digits vary per player.
- **One healthcheck for both transports** (`registerAdaptiveHealthcheckTool`): the credential
  probe until the bridge has carried a request, the bridge probe after. The bridge port is
  `WARAPP_WS_PORT` (default 37149); hosting needs `bridge: true` and
  `bridgePortEnv: WARAPP_WS_PORT` on the registration.
- **A frozen war.app tab stalls bridged POSTs.** Chrome freezes background tabs; the bridge
  relays `/Services` POSTs through a page tab, so they time out ("did not respond within
  30000ms") while GETs (run by the extension) still work. Reloading or focusing a war.app tab
  clears it. Live verification found this repeatedly — say so in any timeout hint.
- **"Me" is the signed-in account.** The live tools default `player` to the account whose
  invite token (`https://war.app/InviteToken`, read through the bridge) matches a GameFeed
  player id; the bundle is discovered from `https://war.app/MultiPlayer` (the homepage does
  not load the game client).
- **"My games" is `GetMyGames` (method 50)** through the bridge, decoded by the bundle's own
  readers by stable type name (`warlight.shared.MyGamesReturn` / `GameInfo` /
  `GameInfoPlayer`) — never a hand-transcribed layout. Its `MyGamesFilters` argument is
  required (absent, the server throws). `waitingOnYou` = the game is Playing or
  DistributingTerritories, my player is Playing, and my `committed` flag is false.
- **Scouting reads two server-rendered pages** through the bridge (GETs the extension makes):
  `https://war.app/Profile?p=<invite token>` (level, games played, last seen, boots, ranked
  records) and `https://war.app/CommonGames?p=<invite token>` (the head-to-head games). The
  invite token is the GameFeed player id. `src/scout.ts` and the skill's
  `references/scout.mjs` parse them identically (parity is tested) and tolerate missing
  blocks (`null`, never a throw).
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
  cached per process (`MapCache`), and a known game is re-fetched with `GetMap=false`.

## Commands

`npm run build` (tsc --noEmit + esbuild bundle) · `npm test` (typecheck + vitest) ·
`npm run test:coverage` · `npm run typecheck`.
