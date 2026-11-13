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
threat-aware planner), `docs/PLAN-PLANNER-2.md` (phase 6, a smarter planner, from a lost game) and
`docs/PLAN-PICKS.md` (the pick advisor; its heuristics and sources are in `docs/STRATEGY.md`).

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
- **Seven tools write, all confirm-gated:** `warapp_submit_picks`, `warapp_submit_turn`,
  `warapp_send_chat`, `warapp_join_game`, `warapp_surrender`, `warapp_begin_turn` and `warapp_uncommit_turn`, registered with mcp-utils' `defineWrite` / `registerWrite`
  (`confirmWrite`: elicitation, or a preview + single-use `confirmToken` per
  `MCP_CONFIRM_MODE`). `warapp_submit_picks` validates against the live board and reports
  `verified` only when `GetTerritoryPicks` reads back exactly what was sent. Every other tool
  is read-only, `warapp_plan_turn` and `warapp_track_opponents` included.
- **Strategy notes are data in `src/strategy/notes.ts`**, served by the read-only `warapp_strategy` and the
  `warapp://strategy` resources: each in our own words with a source link from the researched war.app pages, marked
  `source` or `derived`; never paste guide text. `docs/STRATEGY.md` names every note id (a test checks it). With a
  game the profile comes from GameFeed alone (`feedProfile`, standing `unknown`); a `map_id` alone works only for a
  map this process has cached, since GameFeed serves maps only with a game.
- **The pick advisor `warapp_plan_picks` is read-only** and refuses outside `DistributingTerritories` or when the
  live board has nothing pickable. Its scorer (`src/analysis/picks.ts`) is pure and deterministic like the turn
  planner; neutral sizes come from the live board when shown (wastelands at their real size), else the settings.
  Its opening simulation keeps armies where they stand (an attack is funded by its bordering source plus that
  turn's deploys, never by another pick's armies — pooling them made it promise first-turn bonuses `plan_turn`
  could not deliver, #47). Each group is compact, a 1v1 included (one cluster linked in steps of at most 2 hops
  on the route tool's graph), relaxed one hop at a time with a warning when no such group exists; a spread 1v1
  primary meant a frontier on every bonus from turn 1 (#73). In a 1v1 the fallback (the counter-pick insurance)
  goes to another area when one scores as much, and entry points weigh twice as much. The old bounded 1v1 spread
  survives only behind `spread: true`. The rationale reports real hop
  distances and never calls a group compact unless it is one such cluster.
  Its `submitPicks` (ids in order) is what `warapp_submit_picks` takes. `docs/STRATEGY.md` states the community
  heuristics in our own words with source links (cite, never copy) and marks which are encoded.
- **Surrender is `Surrender` (67) via `warapp_surrender`, confirm-gated** (`undo` takes back a
  pending one). It refuses finished games and games the account is not playing, and reads the
  outcome from GameFeed (`surrendered` / `pending` — more than two players need the others'
  acceptance — / `taken_back` / `unchanged`), never from the reply, which has no result.
- **A speed first turn hides the board until Begin.** With MoveOrder `NoLuckCycle` war.app sends
  no standing on turn 1 (or while picking) until the player presses Begin, which starts their
  turn timer; the live tools say so instead of the lobby error. `warapp_begin_turn` sends
  `BeginFirstTurn` (78, confirm-gated, encoding read from the bundle — not verified live) and
  reports `begun` only once the board reads back.
- **Withdrawing committed orders is `UnCommit` (80) via `warapp_uncommit_turn`, confirm-gated.** Its
  parameters (only the int32 game id after the auth block) are read from the bundle's writer and
  golden-pinned, NOT yet verified live. It refuses outside a turn phase and when `hasCommittedOrders`
  is false, and reads the outcome from GameFeed (`uncommitted` / `unconfirmed`); a transport failure
  is `unknown`, never retried. `warapp_submit_turn`'s "already committed" refusal points to it.
- **Open games come from the `/MultiPlayer/OpenGames` page payload (`AllOpenGamesData`), not a `/Services` call; joining is `AcceptOpenSeat` (61) via `warapp_join_game`, confirm-gated** and reported `joined` only once GameFeed or `GetMyGames` shows the account seated (`docs/WEB-PROTOCOL.md` "Open games").
- **Turn submission (`warapp_submit_turn`) sends `SendOrders`** (card plays, then deploys, then moves;
  encoders in `src/protocol/methods.ts` are golden-pinned to a live commit), turn number =
  GameFeed `numberOfTurns` + 1. It always acts as the signed-in account (refuses any other
  `player`, and refuses when that account cannot be determined), validates on the live board
  (own sources, adjacent moves, armies ≤ armies + deployed − 1, deploys = planner income —
  the server's error 11 otherwise; only a preview warning when `incomeUncertainties` names a
  setting the income model does not compute, e.g. an army cap), and refuses outside a turn phase or when my
  `hasCommittedOrders` is already true (a second `SendOrders` replacing the first is
  unverified; the client uses "Modify orders" = `UnCommit`, which `warapp_uncommit_turn` sends). **Success is read from game state, never
  from the reply:** its bool is the "vacation ended" flag. After sending, GameFeed is re-read:
  `numberOfTurns` advanced → `resolved`; my `hasCommittedOrders` true → `committed`; neither,
  or a transport failure after sending → `unknown` (never suggest resending blindly).
- **Special units (`src/live.ts`, #61).** An `Armies` record ends with its special units
  (Commander, Boss1–4, CustomSpecialUnit), each dispatched on a byte tag; every unit class
  ends with the shared fields GUID, owner (in-game id), so the owner is the LAST field and the
  kind comes from the registered class name. Fogged territories report no units.
  `BoardState.specialUnits` keys owners by GameFeed id like territory owners.
- **Commanders in the planner (#61).** A commander fights as 7 armies (bundle: attack and
  defence `+7`, dies last, no partial damage), counted in every capture cost and threat.
  My commander's territory is must-hold (never conceded; all deploys go there when the hold
  does not fit); an adjacent enemy commander is attacked before anything else spends the
  income (finishing off, triage, holds, expansion; only my commander's own hold is reserved
  first), sized for its armies + 7 + its owner's full deploy. **No vanishing:** war.app
  interleaves both players' attacks, so a strike never removes its owner's other stacks from
  this turn's threats. R3 never vetoes a strike; when what stays on my commander's territory
  after the plan's orders falls to the stacks next to it (the struck one included), `cardAdvice`
  is Order Priority when I hold one. Planned moves never carry the commander.
- **Cards (`src/cards.ts`).** The hand is read from the live board (`LatestGameInfo` standing →
  my in-game id → GUID → card instance, by bundle type name); the card **type is `Gb`, the LAST
  integer field** (the base reader sets it last) and a Reinforcement card's armies are `tc`, the
  first integer (its subclass prepends it) — reading the type from the first integer mislabels a
  Reinforcement whose armies equal another type id; the rules from GameFeed settings
  (`MaxCardsHold`, `ReinforcementCard.FixedArmies`; a card set to `'none'` is not in play).
  Holding **more** whole cards than `MaxCardsHold` (not equal — live: 4/4 accepted, 5/4 refused;
  the bundle's check is `remaining > MaxCardsHold` after removing every played and discarded
  card) war.app refuses a `SendOrders` (**error 51 `MustUseCard`**), so `cardsToShed` cards must
  be played or discarded and `warapp_submit_turn` refuses up front. The planner always plays
  Reinforcement (its armies join the income) and, only when cards must go, one Order Priority,
  then discards the lowest-value cards — never playing Blockade (it gives a territory away) or
  Order Delay (it holds back my attacks). A discard (`GameOrderDiscard`) is tag 9, the GUID, the
  base — from the bundle's writer, not yet live-verified. Card plays must come in war.app's
  turn-phase order or the server answers **error 10 `OrdersInIncorrectOrder`**, so
  `writeSendOrdersParams` sorts every order by `TurnPhase` (discards 10, Order Priority 12,
  Reinforcement 20, deploys 25, moves 50, Order Delay 50, Blockade 60). Order Delay (tag 11) runs
  in phase 50, verified live 2026-11-12 (sent in phase 12 it drew error 10). Within a phase,
  card plays are written after the moves — that position is unverified. Order Delay may be combined with other card plays.
  Play-card encoders are golden-pinned; a GUID is written as its 16 bytes in .NET order.
- **Turn notifications are a socket.io v0.9 client with two transports.** While the active
  transport is the direct leg, a **WebSocket** (`src/push/websocket.ts`): handshake GET with the
  `AuthToken` cookie (host-locked to war.app), then `wss://war.app/socket.io/1/websocket/<sid>`
  with the same `Cookie` header. Otherwise — and as the fallback when the WebSocket cannot come up
  (no session, signed out, no `websocket` transport, failed upgrade) — **xhr-polling over the
  bridge** (`src/push/socketio.ts`): the first poll must return the connect packet `1::` before
  any POST (a POST first is HTTP 400). Both answer `2::` heartbeats and send `Subscribe`
  (method 238, no auth block) to `Game.<id>`. A push is method 241 `GameUpdated` carrying only
  the game id, so `warapp_wait_for_turn` re-reads GameFeed on each one. **A reconnect loses the
  pushes sent during the gap** (war.app has closed a healthy socket after ~60 s): close, error
  or a missed heartbeat reconnects (new handshake, new sid, re-subscribe) and `onReconnect`
  fires, on which `warapp_wait_for_turn` re-reads every watched game. The push transport shows
  in `warapp_session_status` (`pushTransport`) and the push tools. One listener per process
  (`src/push/listener.ts`), started lazily: many processes sharing the bridge port collide.
  Tests drive a scripted fake bridge and a fake WebSocket, never a real socket.
- **Threat model.** Enemy income is unseen, so the planner estimates each opponent's deploy
  separately: base income + the bonuses it visibly holds in full, at most round(0.75 × its
  largest stack next to me) but never below the game's base income (at least 5)
  (`enemyDeploy` / `enemy_deploy` overrides all of them). On the opening board (every visible
  territory holds the same count) every opponent gets that floor — live, the old 0.75 × 15 guess made every base-income opponent look like ~11. A warning
  states each estimate and its basis. With a previous board, each opponent's deploy is also
  *observed* (`observedDeploy`, #57): the *net* change of its armies on territories visible
  both times (shrinks included — a transfer between its own territories is not deploy; counting
  only growth once read a 30-army back-line move as +35 and conceded a bonus), where a territory
  it captured from a player or a visible neutral counts its armies now plus the previous owner's
  armies there, floored at 0 (losses in an attack it did not win are not counted — the
  defender's own orders hide them). **A fog reveal is not income (#69):** a territory counts
  only when last turn's board showed both its owner and its armies (`visibleState`: not owner
  `unknown`, not `null` armies, not fog level `Fogged`/`OwnerOnly`/`3`/`4`) — live, fog lifting
  over existing stacks read as +119 and conceded six held-bonus borders. The observed figure is
  capped at base + every bonus none of whose territories someone else visibly holds (a warning
  says when), and a rationale line names the turns compared and the reveals skipped. The
  estimate is max(visible-bonus figure, observed) — the stack cap never cuts an observed figure —
  and the warning names the source ("observed +N/turn" vs "base + visible bonuses"). Each border
  is sized for its opponent's whole deploy: that is its worst case (the opponent picks where to
  land), not a double count.
  With a previous board (`previousBoard`), an adjacent enemy stack that grew raises that
  border's threat to movable + max(that opponent's deploy, growth). `warapp_plan_turn` gets it from
  GameFeed `GetHistory` (unverified in progress, parsed loosely in `src/trend.ts`), else from
  `<dataDir>/boards/<gameId>.json`, written after each plan or track (newest ten turns kept, so
  re-planning a turn keeps the trend and opponent tracking has a history); it reports `trendSource`.
- **Opponent tracking (`src/analysis/opponents.ts`, `warapp_track_opponents`) reads that board
  history** with the same rules, consecutive turns only: per opponent the observed deploy each
  turn, income = median of the last three observed turns floored at base + visibly held bonuses,
  unaccounted armies (earned since first seen − visible army change − visible losses) and
  inferred bonuses (combinations of up to three bonuses it could hold that best fit the income
  gap, all of them listed — candidates, never asserted). With 2+ observed turns the planner uses
  the tracked income in place of the single-turn observed figure (`PlanInput.tracks`) and says so
  in its rationale; fewer, and the plan is exactly what it was without tracking.
- **The turn planner (`src/analysis/planner.ts`) is pure and deterministic** (ties on
  ascending id, no I/O; its header comment is the full rule list) and judges every hold and
  capture with the exact combat model (`armiesToTake`, `captureCost`). Its rules, learnt from
  a lost game (`tests/analysis/lessons.test.ts` replays each lesson in miniature):
  - **Triage by protected value.** A threatened border's protected value is my complete
    bonuses containing it, plus bonuses I'd lose all access to, plus per-territory income; its
    **worth** adds the armies a hold saves as income (armies / `PAYBACK_TURNS`), so a big stack
    is topped up rather than abandoned. Holds go in order of worth per army of hold cost. A
    border is **conceded** when holding costs more than `CONCEDE_FACTOR` (3) × its worth or than the income left
    (a warning either way): it is never deployed to (unless every territory I hold is
    conceded), it attacks out only with the armies already on it, and idle armies never move
    into it.
  - **Held bonuses first (#51)** (under `balanced`/`defend`): a bonus I hold in full is one
    unit — all its threatened borders are held or none (a border shared by two held bonuses is
    paid once). A unit whose summed hold cost ≤ `PAYBACK_TURNS` × its value (and, like any
    border, ≤ `CONCEDE_FACTOR` × its worth) is funded before any capture that completes no bonus
    (advances, breaks, other expansion); completions still compete on score but never starve a
    unit unless their bonus earns more, and finishing off keeps its place. One that does not
    pay, or that the income left cannot cover, is conceded whole ("conceding bonus …") and its
    borders are judged alone without that bonus.
    `expand` is unchanged but warns.
  - **Withdraw** (under `balanced`/`defend`): a conceded border's movable armies go first to
    the neighbour nearest a border that holds, and the plan sets `cardAdvice:
    'order-priority'` because a withdrawal only executes while the border is still mine. The
    planner never plays cards itself; `warapp_plan_turn` adds the Order Priority I hold to
    `orders` when `cardAdvice` asks for it.
  - **The game profile (`src/analysis/profile.ts`, S1)** is on every plan (`profile`): format
    (players' teams — the shared `carriesTeam` test in `src/teams.ts` — and who is still
    playing), phase, standing (my income vs the strongest opponent's estimate) and the
    strategy settings. `warapp_plan_turn` passes `adapt: true`: with no `goal` the profile picks
    it (behind → `defend`, else `balanced`) and its rules fire (1v1 in contact: advances rank
    below holds and breaks; FFA with 2+ opponents: no second front; behind: no pressure margin;
    ahead in a 1v1: pressure at `AHEAD_PRESSURE_FACTOR`). An explicit `goal` overrides it.
    GameFeed's player `team` is read when sent but unverified.
  - **`balanced` is the default goal**: holds, completing/advancing bonuses and breaking a
    fully visible single-enemy bonus (`BREAK_WEIGHT` / opponents × value / cost) compete by
    income per army; `MIN_EXPANSION_SHARE` (30%) of income goes to expansion before holds that
    protect less than it. A threatened border whose only visible threat is a breakable member
    attacks it on top of its hold (hold + capture deployed there, so it still holds if the
    member is reinforced and the attack fails); unable to afford both, it just holds — never
    a capture instead of the hold. `defend` holds first, `expand` never attacks players.
  - **Commit to the closest bonus (#101, rule 4f).** While no bonus is held, and in the opening
    and expansion phases, completions and advances go to the bonus fewest turns from completion
    first (equally close ones by score); a bonus advanced last turn keeps priority unless another
    is strictly closer. "N armies to finish" counts fogged members at the bonus's costliest
    visible missing member.
  - **Leftover** goes to the held border with the most at stake still short of a comfortable
    margin, else the top expansion's stack — never to a conceded border (the old "most enemies
    next to it" rule picked the hopeless border).
  - **Trend:** with `previousBoard`, growth of a visible adjacent enemy stack projects into
    the threat (see the threat model above), and warns "is building".
  - **Lessons from three more lost games** (`tests/analysis/lessons-defensibility.test.ts`):
    - **Border value after captures (#18).** Triage runs before captures are known, so after
      the capture passes a conceded border in a bonus this turn's captures complete is kept —
      never withdrawn from, garrisoned from the leftover, warned when that still cannot hold.
    - **Defensibility (#19).** A capture that completes a bonus is checked against the frontier
      it leaves: when holding the members a visible enemy could take next turn needs more than
      the next income, `balanced`/`defend` refuse it ("… indefensible …: not completed") and
      keep the armies for defence; `expand`/`complete-bonus` complete it with a warning. A
      completion's score is discounted by that defence cost (`DEFENSE_DISCOUNT`).
    - **Combined attacks (#17).** A target no single source can afford may be taken by two or
      more of my start-of-turn stacks in a fixed order (the first attacks only wear it down),
      with exact arithmetic — only at 0% luck under straight rounding (else skipped with a
      warning), and only for a target the passes already chose. `warapp_plan_turn` lists them
      in `multiSourceCaptures`.
    - **Frontier cost (#71, rule 4d).** Every capture's score pays for the frontier it adds:
      `NEUTRAL_BORDER_COST` per border it opens (minus per border it closes), plus, under
      `balanced`/`defend`, what a new enemy-facing border needs next turn to hold (R3's
      arithmetic; a completion's own members are left to R3's defence cost, never counted
      twice). The plan reports `frontier` (borders, enemy-facing, hold cost, next income —
      conceded borders are not in the hold cost); under `balanced`/`defend` an expansion that
      adds an enemy border without completing a bonus is undone when the hold cost would then
      exceed the next income and the start-of-turn hold cost ("Frontier grows faster than income").
  - **Game rules** (`docs/PLAN-PLANNER-4.md`, `tests/analysis/lessons-game-rules.test.ts`; the
    full-rung `settings` echo shows each):
    - **Kill rates (#28).** Every combat computation uses the game's offensive/defensive kill
      rates; only settings without them fall back to 60/70, with a warning.
    - **Local Deployment (#29).** With `localDeployments`, a held bonus's value is a pool
      deployable only on its own territories and only the rest of the income goes anywhere
      (pool rules unverified, `docs/WARAPP-API.md`); `warapp_submit_turn` refuses a broken split.
    - **No-Split (#31).** With `noSplit`, a territory issues at most one attack or transfer (its
      best; the rest are dropped with a warning, planned amounts kept, not forced all-in);
      `warapp_submit_turn` refuses a split.
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
- **A chrome-less "direct" transport, LOCAL-ONLY** (`src/direct/`, phase 7 — `docs/PLAN-DIRECT.md`).
  The signed-in session is carried by a durable **`AuthToken`** cookie, and that cookie **alone**
  authenticates both the server-rendered pages and a `/Services` POST (**verified 2026-11-12**).
  So the bridge has a direct-first router wrapped around it (`createDirectFirstBridge` in
  `src/direct/transport.ts`, over mcp-utils `createDirectFirstTransport`; the fetchproxy bridge
  itself is `createWarappBridge` in `src/transport-bridge.ts`): the direct leg issues a plain
  server-side HTTPS request carrying the cookie, falling back to the browser bridge when no session
  is linked or it has expired. Only a 200 non-frame `/Services` reply (or a sign-in page/redirect)
  means signed out — a 5xx passes through as an `http` error. A non-GET that reached war.app on the
  direct leg is **never re-sent over the bridge** (a write must not be sent twice); later calls use
  the bridge. A relink (`warapp_link_session`, or a new `capturedAt` on disk) clears the stale flag
  and returns `auto` to the direct leg.
  `WARAPP_TRANSPORT` = `auto` (default) | `direct` | `fetchproxy`; the session is stored at
  `WARAPP_SESSION_FILE` (default `<dataDir>/session.json`). One injection point: `index.ts` builds
  this one bridge and passes it to `WarappRpc`, the page fetches, the healthcheck and the push
  socket, so they all get direct mode at once. `warapp_link_session` (write, confirm-gated,
  local-only) captures the cookie once through the bridge; `warapp_session_status` reports the
  linked state, age and active leg. **The `AuthToken` is a full-account credential:** file `0600`,
  dir `0700`, atomic write; scrubbed by value from every upstream error string (mcp-utils
  `stripBearer` + `scrubToken`); never logged, never in a tool result, never in an error/hint.
  **Direct mode is local-only — `mint.yaml` keeps the browser bridge and stores no token on the host.**
- **One healthcheck for both transports** (`registerAdaptiveHealthcheckTool`): the credential
  probe while the direct leg serves (and until the bridge has carried a request), the bridge probe
  only when this connection's router is on the bridge leg (the fetchproxy bridge is shared
  process-wide, so its role alone is not enough; `WARAPP_TRANSPORT=direct` never probes it); either way it reports the active leg and whether a direct session is linked and
  its age (never the token). The bridge port is `WARAPP_WS_PORT` (default 37149); hosting needs
  `bridge: true` and `bridgePortEnv: WARAPP_WS_PORT` on the registration.
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
- **A game's map comes from `mapOf(game)`** (`src/tools/map.ts`), which applies the game's
  `OverriddenBonuses` (`applyBonusOverrides`); load the game with `settings: true` wherever bonus
  values matter. The JSON shape is verified live (an array of `{ bonusID, value }` numbers); overrides
  that do not read in full keep the submit pre-checks soft.
- **API facts live in `docs/WARAPP-API.md`**, each marked verified or unverified. The board
  standing parser (`src/board.ts`) is unverified and must stay loose (never throw). Territory
  and bonus ids overlap, so a bonus member is a territory first and a superbonus only otherwise.
- **Map statistics are opt-in and local-only** (`warapp_map_stats`, `src/stats.ts`): off unless
  `WARAPP_STATS=1`, always off when hosted (recognised by mcp-host's child-only variables —
  `HOSTED_MARKERS`), and `mint.yaml` never sets `WARAPP_STATS`. GameIDFeed + GameFeed
  `GetHistory=true` through `WarappClient`, ≥ 1 s apart, finished games cached forever as
  name-free records at `<dataDir>/stats/<mapId>/<gameId>.json`.
- **All GameFeed traffic goes through `WarappClient` (`src/client.ts`)**, including the
  credential healthcheck probe; all `/Services` traffic goes through `WarappRpc`
  (`src/protocol/rpc.ts`), which echoes the reply extras into the next request. Maps are
  cached per process (`MapCache`), and a known game is re-fetched with `GetMap=false`.

## Commands

`npm run build` (tsc --noEmit + esbuild bundle) · `npm test` (typecheck + vitest) ·
`npm run test:coverage` · `npm run typecheck`.
