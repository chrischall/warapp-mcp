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
`docs/PLAN-PICKS.md` (the pick advisor; its heuristics and sources are in `docs/STRATEGY.md`) and
`docs/PLAN-TEAMS.md` (chat, truces in free-for-alls and team play).

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
- **Nine tools write, all confirm-gated:** `warapp_submit_picks`, `warapp_submit_turn`,
  `warapp_send_chat`, `warapp_join_game`, `warapp_leave_game`, `warapp_surrender`, `warapp_begin_turn`, `warapp_uncommit_turn` and `warapp_link_session` (local only:
  it stores a session cookie on this machine and is not registered hosted), registered with mcp-utils' `defineWrite` / `registerWrite`
  (`confirmWrite`: elicitation, or a preview + single-use `confirmToken` per
  `MCP_CONFIRM_MODE`). Each gate binds the signed-in account read fresh in `plan` (`writeAccount`), the
  preview names it, and `execute` refuses if it changed (`requireApprovedAccount`, `src/tools/live-context.ts`),
  so an approval for one account never acts as another. The shared pieces are in `src/tools/write-kit.ts`:
  `requireMe` / `requireMySeat` (every write refuses an unreadable signed-in account, one wording),
  `sendAndVerify` (a refusal throws; no answer is `unknown` and is never read back or resent), and
  `defineGatedWrite`. Every write result carries `outcome` (`confirmed`, `accepted`, `unconfirmed`,
  `unknown`, `not_applied`; the per-tool mapping is in that file's header) beside its own `status`,
  which callers still read. `warapp_submit_picks` validates against the live board and reports
  `verified` only when `GetTerritoryPicks` reads back exactly what was sent. `warapp_record_agreement`
  also writes, but only the server's own agreement ledger and player record (nothing reaches war.app or a
  player), so it is not confirm-gated and not counted above. Chat (owner decisions of 2026-11-14,
  `docs/PLAN-TEAMS.md` §5): D1 chat proceeds with every send confirm-gated; D2 the play session sends
  within the honesty line without the owner approving each message; D3 the honesty line is the plan's
  default (no false statement of fact, no promise the plan does not intend, withholding is free, never
  claim to be human, a truce ends with the agreed notice). Every other tool
  is read-only, `warapp_plan_turn` and `warapp_track_opponents` included. The two-step token
  confirmation verifies no person — on a client that cannot prompt it is advisory (the model itself
  supplies the token) — so a write preview's sentences name things by id only, and every
  third-party name in a preview or a thrown error goes through `untrustedText` (`src/tools/common.ts`:
  delimited ⟦ ⟧, control characters, quotes and non-ASCII brackets neutralised, capped).
- **The plan stress test is `warapp_check_plan`** (read-only; it writes nothing, not the board cache
  either). `src/analysis/turn-sim.ts` resolves one turn from every player's orders by the wiki's rules
  (`docs/STRATEGY.md` "Turn resolution" links each page: deploys first, then attacks and transfers
  in the zigzag, an order that moves no armies taking no slot; attack or transfer decided when the
  order runs; the guard army, which an arrived army can be and a commander cannot; each army
  moving once; mutual destruction leaves one defender; Order Priority makes its player the first
  mover for the turn; commanders as 7). What the wiki does not state is assumed and named in the
  result (an order sends what is left; an order from a territory captured first does nothing;
  losses fall on movable armies first; the mutual wipe with the guard off), and with luck or
  weighted rounding battles are resolved at their expectation (`exact: false`). A territory whose
  armies are hidden is unknown to it whoever holds it. `src/analysis/stress.ts` runs a list of
  orders against each opponent's single-deploy replies (attack from one stack with its commander,
  sit on a territory I attack, every stack at once, spread and concentrated; #180: a struck stack
  dodging first, two opponents on one territory — teammates, or any two when I lead a free-for-all
  — and under Multi-Attack each stack's best chain; Local Deployment bounds each deploy), under both move
  orders unless `first_mover` is given, with the same per-opponent deploy estimates as the
  planner; the opponents are whoever holds a stack on the board, not only players GameFeed calls
  `Playing`. "Safe" means safe against those replies only: fog-hidden stacks (`blindBorders`,
  `unseenOpponents`), a deploy above the estimate, split deploys, other joint attacks, more than
  one chain per stack and cards are not tried, and `safe` is `null` when nothing could be tried. It also looks one turn ahead
  (`exposedNextTurn`, #156): a territory of mine that a stack two steps away could take next turn by
  first taking the territory in between (mine or neutral), with the armies it would need to hold, on
  the assumption that I add nothing next turn; this never changes `safe`. Both modules are pure and
  deterministic like the planner, and neither is called by it. The look-ahead itself lives in
  `src/analysis/lookahead.ts` (`twoStepReaches`), one computation shared with the planner's two-step
  hold (#172, applied wherever armies leave a guarded territory: attacks and their softeners,
  transfers, staging, top-ups): change it there, and `exposedNextTurn` and the planner move together.
- **Strategy notes are data in `src/strategy/notes.ts`**, served by the read-only `warapp_strategy` and the
  `warapp://strategy` resources: each in our own words (at most 340 characters) with one source link from the
  researched pages — the war.app wiki and forum, or a community guide the wiki links to — marked `source` or
  `derived`; never paste guide text. Eight topics (`NOTE_TOPICS`: format, settings, cards, reading, opening, timing,
  fighting, map). A note says which games it is for as data (`NoteCondition`: format, phase, standing, fog level,
  move order, distribution, kill rates, the guard, cards in play, and so on), tested against the profile and
  `noteContext(settings)`; a condition on something the game did not state does not hold, and a card condition
  falls back to "any card" when the list is unknown. `docs/STRATEGY.md` names every note id (a test checks it, and
  another that some game reaches every note). With a game the profile comes from GameFeed alone (`feedProfile`,
  standing `unknown`) and the answer carries the game's `cardClock` (`src/strategy/card-clock.ts`: per card, the
  capturing turns to the first one, fastest and guaranteed, from the pieces, starting pieces, minimums and pieces
  per turn in the settings; whether a commerce game is on is read from a non-empty `Commerce` object, unverified).
  With no game and no topic the compact answer is the topic index, with `notes` as ids and topics only. A `map_id` alone works only for
  a map this process has cached, since GameFeed serves maps only with a game.
- **The pick advisor `warapp_plan_picks` is read-only** and refuses outside `DistributingTerritories` or when the
  live board has nothing pickable. Its scorer (`src/analysis/picks.ts`) is pure and deterministic like the turn
  planner; neutral sizes come from the live board when shown (wastelands at their real size), else the settings.
  Its opening simulation keeps armies where they stand (an attack is funded by its bordering source plus that
  turn's deploys, never by pooling another pick's armies — that made it promise first-turn bonuses `plan_turn`
  could not deliver, #47; at 0% luck, straight rounding and No-Split off, a neutral one order cannot pay for
  may be taken in two, the first only wearing it down, #166: `twoOrderCaptures`). A bonus's defensibility
  counts an entry point once per member it borders (a double border twice), and a completed bonus is credited
  by who can reach it (`THREAT_LOSS` × the chance an opponent starts on a pickable territory whose lone stack
  stands in or next to it by its completion turn; a pick of mine is no threat, #166). A group is compact,
  a 1v1 included (one cluster linked in steps of at most 2 hops
  on the route tool's graph), relaxed one hop at a time with a warning when no such group exists; a spread 1v1
  primary meant a frontier on every bonus from turn 1 (#73). In a two-player game with a primary of 2 to 4 picks
  the fallback is not a group: each pick is chosen for the award outcomes that grant it (my opening there less
  `OPPONENT_WEIGHT` × the opponent's from the picks lost, #166), and is chosen again when the award order
  reorders the primary; any other 1v1 fallback goes to another area when one scores as much. In a 1v1 entry
  points weigh twice as much. The old bounded 1v1 spread
  survives only behind `spread: true`. The rationale reports real hop
  distances and never calls a group compact unless it is one such cluster. The primary is the best-scoring
  group any of the best seeds grows, and the fallback is scored with the primary taken (it is granted only
  then); a list past twice the limit (the client allows players × territories per player,
  `clientPickLimits`, docs/WARAPP-API.md) runs in tiers of the primary's size. The list is judged by the award
  order (rounds in a reversing move order, each player getting their best free pick: `pickOutcomes`), reporting
  the worst set it can yield and the other players' starts that implies; the primary is reordered only when that
  raises the worst outcome. With commanders on, the primary's safest pick (fewest other pickables within 2 hops)
  is listed first, since the first pick awarded carries the commander (#129).
  Its `submitPicks` (ids in order) is what `warapp_submit_picks` takes; in a two-player game without `spread` it also offers a
  coverage-first `alternative` (a pair, then the picks that most raise `coverage` — the reasonable bonuses reached within 2 moves
  past no wasteland; `coverageModel`) with its own `submitPicks`, only when it covers more, the primary unchanged (#166). `docs/STRATEGY.md` states the community
  heuristics in our own words with source links (cite, never copy) and marks which are encoded.
- **The award of picks is read once, from my own list (#166).** The list war.app read back
  (`warapp_submit_picks`, or `warapp_get_my_picks` during distribution for the signed-in account) is kept at
  `<dataDir>/picks/<gameId>.json` (`src/pick-list.ts`, territory ids only). On turn 1 `loadAward`
  (`src/tools/award.ts`) reads it against the territories I hold (`readAward`, `src/analysis/award.ts`: with two
  players every award that fits is enumerated and only what holds in all of them is kept) and stores the result;
  later turns reuse it, and a list that cannot explain the start gives nothing. `warapp_plan_turn` and
  `warapp_check_plan` report it as `award` and, in a two-player game, plan on the opponent's proven starts while
  they are fogged (owner, plus the starting armies on turn 1); the board cache and opponent tracking keep the
  board war.app showed. The move order (`award.firstMover`, `Cycle` only: under `NoLuckCycle` play speed sets
  the first order, not the award) and the commander start are the wiki's rules, not verified live: never used
  to narrow the stress test, to place a commander or to size a hold (#215); `warapp_plan_turn` defaults its first mover to it.
- **Who moved first is kept between turns (#127, `src/move-order.ts`).** In a two-player game under `Cycle`
  or `NoLuckCycle` the first mover alternates every turn, so `warapp_plan_turn` keeps one known turn at
  `<dataDir>/move-order/<gameId>.json` (turn, `me`/`opponent`, source) and later turns default to it,
  alternated. Sources, best first: `first_mover` given now; a kept explicit turn; the award; a kept award
  turn. Disagreement is a warning; `firstMover` reports `{ who, source, from? }`. The game history is not
  read for it (UNVERIFIED whether an in-progress `GetHistory` carries the orders in the order they ran).
  `warapp_check_plan` writes nothing and still tries both orders unless `first_mover` is given.
- **Chat has channels (part A1 of `docs/PLAN-TEAMS.md`).** The `GameRefresh` read of **public** messages is
  VERIFIED LIVE 2026-11-14 (count, time, turn, sender and channel matched GameFeed `GetChat=true`); team and
  private channels, `mark_seen` / the cursor, `warapp_plan_turn`'s `chat.unread`, `chatActivity` and sending
  remain UNVERIFIED. `warapp_get_chat` reads
  `GameRefresh` (39, chat only) → `GameDetailsAndChat` → `GameMessage` by type name (`src/chat.ts`:
  fields by read order, a private counterpart first, then a game group (`unknown`), then the channel,
  -1 public else the team), but only when the signed-in account can be read; otherwise, or on any
  failure, GameFeed's `chat` (no channel: `unknown`). Bodies go out through `untrustedBody` (the
  `untrustedText` cleaning, capped at 2,000). "New" is a name-free cursor at `<dataDir>/chat/<gameId>.json`
  (`src/chat-cursor.ts`: per channel the count and newest time marked seen, plus the whole chat, against
  which every message is judged too — a named channel by time only: seen by either mark is not new); only
  `mark_seen: true` writes it (from GameFeed only `unknown` and the whole chat, never a named channel, so a
  later web read keeps what was seen; `markedUnshown` counts unread messages `limit` cut); mine are never
  new. GameFeed chat in a shape no reader knows goes out as `raw` with every string through `untrustedBody`. `warapp_plan_turn` reports `chat.unread` from the GameFeed chat of its own
  game read (no extra request), so every count is under `unknown` (its `note` says so). Third-party names in
  results (sender, recipient, game) go through `untrustedText`.
  `warapp_send_chat` takes `channel: 'team'` (the channel value is my GameFeed `team`; refused without
  one) and refuses `to` when `PrivateMessaging` is false; it reads the reply's message list back
  (`confirmed` / `unconfirmed`, `accepted` when unreadable). `GameUpdated`'s first bool after the game id
  is the client's `chat` flag: `chatActivity` in `warapp_wait_for_turn`. The interpreter's registration
  scan allows whitespace after `=` (the real bundle wraps `GameMessage`'s with CRLF).
- **The agreement ledger (part A2 of `docs/PLAN-TEAMS.md`).** An agreement (a truce) exists only when
  recorded with `warapp_record_agreement` (structured terms; chat is never parsed into one), at
  `<dataDir>/relations/<gameId>-<playerId>.json` (`src/relations-store.ts`: one file per account, ids,
  turns and statuses only, 0600, atomic; registered hosted too, on the per-user data dir). The model is pure in
  `src/analysis/relations.ts`: the status table (terminal: ended, broken-by-them / -by-me), the state on a
  turn (over when the partner is out or turned AI, two players remain, or its turn / player / notice end
  came), `breachWatch` over consecutive cached boards from the turn agreed (visibility as `observeDeploy`:
  a fog reveal is no event; an attack is read only with my cached orders and only when the partner alone,
  visibly, borders the territory, and no transfer of mine in came from a source taken or hit; anything the
  fog leaves open is `massing`, never `broken`; massing reach is plain graph distance 2, not
  `twoStepReaches`, which asks what a stack could take and hold, not where armies stand), `tacitTruces` (3 quiet turns, reported only), the endgame
  (no other opponent ≥ 0.5 × the larger income) and `trust`. Refused: me, an AI, a player out, a
  teammate, a 1v1, two left, and no third player or team outside me, my team and the partner's; an
  `until_turn` before this turn. Massing needs its growing pairs to end at the newest board. The ledger's `usage` (armies a truce freed, loss if broken, per planned turn)
  is a stub that part B2 fills. Nothing in the planner reads the ledger yet. Its read-modify-write runs
  under an in-process per-path lock (`src/path-lock.ts`; another process sharing the data dir is not
  covered). **The cross-game player record** (owner decision D5 of 2026-11-14: on, local AND hosted —
  registered and enabled on a hosted child, in its per-user data dir) is `src/player-record-store.ts` at
  `<dataDir>/relations/players.json` (version 3; versions 1 and 2 read loosely): per player, keyed by an
  HMAC of the GameFeed id under the salt `relations/players.salt` (made only on the write path; a salt
  file that exists but is malformed is never regenerated, and a `players.json` that exists but does not
  parse — bad JSON, not an object — is never overwritten or moved aside: the write reports `failed`, reads
  `unreadable`), name-free entries per agreement (its key an HMAC of my account, game and agreement —
  entries keyed by game and agreement alone before that are read as they are and updated in place: format, turns
  agreed and ended, terms shape, outcome with notice honoured or not, break turn and strongest flag, the
  context at the break from the cached boards — endgame, leader, outgrowing — retaliated, proposed
  again) and tallies (`src/analysis/player-record.ts`: `recordDelta` moves each once, on the transition
  that earns it, so they never double-count and outlive entries dropped past the bound; 30 entries per
  player, 300 players). `warapp_record_agreement` updates it inside the ledger's lock (its own lock, a
  different path), so entries land in the order the ledger changed. `WARAPP_PLAYER_RECORD=off` switches it off. The tools report `playerRecord`
  (`warapp_record_agreement`: `updated` / `off` / `failed`; `warapp_get_relations`: `on` / `off` /
  `unreadable`).
- **Surrender is `Surrender` (67) via `warapp_surrender`, confirm-gated** (`undo` takes back a
  pending one). It refuses finished games and games the account is not playing, and reads the
  outcome from GameFeed (`surrendered` / `pending` — more than two players need the others'
  acceptance — / `still_playing` after an undo — GameFeed has no pending state — / `unchanged`; lobbies refused), never from the reply, which has no result.
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
- **Leaving a lobby is `DeclineGame` (64) via `warapp_leave_game`, confirm-gated** (#217): the lobby's
  Decline button, also how a seated player leaves a game still `WaitingForPlayers`. Its parameters
  (the int32 game id, then a "mod hooks the decline" bool sent false) are read from the bundle's writer
  and golden-pinned; **verified live 2026-11-14** for a seat taken through an open seat (an invited
  seat and a hosted bridge run are not yet checked). It refuses a started game (surrender instead), a seat the
  account does not hold, and mod games; reports `left` only once GameFeed (else a `GetMyGames` entry)
  shows the seat given up — never from the reply, whose bool means "your chat was removed"; a transport
  failure is `unknown`, never retried. 17, 4 and 7 are read back from game state (the client swallows
  them); 191 (your own open game) and 88 are refusals. After a leave GameFeed refuses the game ("This API
  can only be used for games you are in…"), which confirms it.
- **A lottery is read from the data, never the name** (#217, `lotteryOf` in `src/open-games.ts`): a
  map of at most `LOTTERY_MAX_TERRITORIES` (4) territories is one; base income 0 with overridden
  bonuses and the map size unread is a likely one (`lottery: null`, a policy break
  too). The open-games record carries no map size, so `markLotteries` asks GameFeed (map included)
  only for lobbies with that settings shape, at most `LOTTERY_LOOKUPS` (5) per call, else uses a
  cached map. A lottery breaks the joining policy.
- **Open games come from the `/MultiPlayer/OpenGames` page payload (`AllOpenGamesData`), not a `/Services` call; joining is `AcceptOpenSeat` (61) via `warapp_join_game`, confirm-gated** and reported `joined` only once GameFeed or `GetMyGames` shows the account seated (`docs/WEB-PROTOCOL.md` "Open games").
- **Turn submission (`warapp_submit_turn`) sends `SendOrders`** (card plays, then deploys, then moves;
  encoders in `src/protocol/methods.ts` are golden-pinned to a live commit), turn number =
  GameFeed `numberOfTurns` + 1 — every tool reports this as `turn` (`currentTurn()`); the
  completed count is `turnsCompleted` (#130). It always acts as the signed-in account (refuses any other
  `player`, and refuses when that account cannot be determined), validates on the live board
  (own deploys and sources — under Multi-Attack a move, never a deploy, may also go from a territory an
  earlier move in the list enters; each move out counts the armies moved in earlier in the list, an upper
  bound — adjacent moves, armies ≤ armies + deployed − 1, deploys = planner income —
  the server's error 11 otherwise; only a preview warning when `incomeUncertainties` names a
  setting the income model does not compute, e.g. an army cap; after an error 11 the caller passes
  the game's own number as `income`, which replaces the model for the check), and refuses outside a turn phase or when my
  `hasCommittedOrders` is already true (a second `SendOrders` replacing the first is
  unverified; the client uses "Modify orders" = `UnCommit`, which `warapp_uncommit_turn` sends). **Success is read from game state, never
  from the reply:** its bool is the "vacation ended" flag. After sending, GameFeed is re-read:
  `numberOfTurns` advanced → `resolved`; my `hasCommittedOrders` true → `committed`; neither,
  or a transport failure after sending → `unknown` (never suggest resending blindly).
  A move's options (#165: `mode` transfer-only/attack-only, `percent`, `commander`,
  `attack_teammates`, checked in `src/tools/order-options.ts`) are each refused unless the game
  allows it (`AllowTransferOnly`, `AllowAttackOnly`, `AllowPercentageAttacks`, `Commanders`, a
  teammate); their encoding follows the client bundle, golden-pinned but UNVERIFIED live.
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
  Reinforcement (its armies join the income); when cards must go, the lowest-value cards leave
  first (#127: Order Delay is discarded before Order Priority is spent; an Order Priority that
  must go is played, not discarded, one at most) — never playing Blockade (it gives a territory away) or
  Order Delay (it holds back my attacks). A discard (`GameOrderDiscard`) is tag 9, the GUID, the
  base — from the bundle's writer, not yet live-verified. Card plays must come in war.app's
  turn-phase order or the server answers **error 10 `OrdersInIncorrectOrder`**, so
  `writeSendOrdersParams` sorts every order by `TurnPhase` (discards 10, Order Priority 12,
  Reinforcement 20, deploys 25, moves 50, Order Delay 50, Blockade 60). Order Delay (tag 11) runs
  in phase 50, verified live 2026-11-12 (sent in phase 12 it drew error 10). Within a phase,
  card plays are written after the other orders (an Order Delay after every move, wherever it
  was listed: the live-verified shape); that war.app accepts it ahead of a move is unverified,
  so an Order Delay play delays nothing and the submit preview warns so. Order Delay may be
  combined with other card plays.
  Play-card encoders are golden-pinned; a GUID is written as its 16 bytes in .NET order.
- **Turn notifications are a socket.io v0.9 client with two transports.** While the active
  transport is the direct leg, a **WebSocket** (`src/push/websocket.ts`): handshake GET with the
  `AuthToken` cookie (host-locked to war.app), then `wss://war.app/socket.io/1/websocket/<sid>`
  with the same `Cookie` header. Otherwise — and as the fallback when the WebSocket cannot come up
  (no session, signed out, no `websocket` transport, failed upgrade) — **xhr-polling over the
  bridge** (`src/push/socketio.ts`): the first poll must return the connect packet `1::` before
  any POST (a POST first is HTTP 400). Both answer `2::` heartbeats and send `Subscribe`
  (method 238, no auth block) to `Game.<id>`. A push is method 241 `GameUpdated` carrying the game
  id and its chat flags (no text), so `warapp_wait_for_turn` re-reads GameFeed after one (debounced per game, below). **A reconnect loses the
  pushes sent during the gap** (war.app has closed a healthy socket after ~60 s): close, error
  or a missed heartbeat reconnects (new handshake, new sid, re-subscribe) and `onReconnect`
  fires, on which `warapp_wait_for_turn` re-reads every watched game — as it does when a failed
  `Subscribe` goes through on a retry (`onConnect` with `resubscribed: true`). A wait checks every
  game (membership included) before it watches any, so a game not mine is never subscribed; a
  released game is unwatched (not re-subscribed on a reconnect); at most `MAX_WATCHED_GAMES` games
  are watched at once; and GameFeed re-reads are debounced per game (one in flight, one queued).
  A wait that starts the socket reads each game twice up front (its check, then the re-read on
  the first connect): accepted, since skipping it could miss a turn. A push for a game no wait
  watches is not recorded. Two waits on one game: the second's `watch` waits for a Subscribe the
  first has in flight, or sees (`mark`) one that went through after it began reading, and
  re-reads. When the Subscribe retries on a session run out (five), the listener starts a new
  session itself. An instant `2::` heartbeat reply is paced like an empty poll.
  The push transport shows
  in `warapp_session_status` (`pushTransport`) and the push tools. One listener per process
  (`src/push/listener.ts`), started lazily: many processes sharing the bridge port collide.
  Tests drive a scripted fake bridge and a fake WebSocket, never a real socket.
- **Threat model.** Enemy income is unseen, so the planner estimates each opponent's deploy
  separately: base income + the bonuses it visibly holds in full, never below the game's base
  income (at least 5) (`enemyDeploy` / `enemy_deploy` overrides all of them). Its stack next to
  me is no part of the estimate: a stack says what can move, not what can be deployed (capping
  the figure at 0.75 × a small stack read a visible +10 holder as 5; guessing 0.75 × a 15-stack
  on the opening board read every base-income opponent as ~11). On the opening board (every visible
  player territory holds the same count; neutrals aside, and only on the first turn: no previous
  board and the turn unknown or 1, #128) every opponent gets that floor.
  The threat at a border (#128, `forceAt`) is the larger of one attack of a player's stacks plus
  its deploy and the single attack equal to its stacks attacking separately (each rounds on its
  own); opponents on one team combine, FFA players do not (a warning when two together could take
  a border); teammates are never a threat or a target; under Local Deployment an opponent's
  visible bonus pools reach only their own territories (its free base income still lands anywhere,
  even when its estimate leaves the pools out). A warning
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
  says when; #226: with per-territory income the base counts every territory it could hold — its
  visible ones and every one whose owner is hidden — and a reveal whose armies exceed its estimate
  is named in a warning, still not income), and a rationale line names the turns compared and the
  reveals skipped. #226: given my orders on the previous turn (`PlanInput.previousOrders`, from the
  cached orders), the defenders my failed attack killed on a territory that stayed its count back
  into its growth there (`failedAttackKills`, shared with `measureOrders`; within #123's bound
  beside the fog). The
  estimate is max(visible-bonus figure, observed)
  and the warning names the source ("observed +N/turn" vs "base + visible bonuses"). **The fog
  prior (#119):** in a 1v1 or (#226) a free-for-all that started even (no teams, every seated
  player still playing — not once a player is out; `PlanGameContext.symmetricStart`, set by
  `warapp_plan_turn` from `symmetricStart(settings, map)`: any distribution but a map scenario),
  every opponent bordering the fog is estimated at least at my own income (card armies out) — or, on
  turns 1–4 when the award of picks proved all its starts, at the income the pick advisor's opening
  simulation gives it from them when that is larger (`openingIncome`, `PlanGameContext.opening`, #166) — capped
  at what it could earn on the board, and the warning calls it a prior — every observed figure is
  a lower bound under fog, and without it a finished game's true deploys read 2–3× low. Each border
  is sized for its opponent's whole deploy: that is its worst case (the opponent picks where to
  land), not a double count.
  With a previous board (`previousBoard`), an adjacent enemy stack that grew raises that
  border's threat to movable + max(that opponent's deploy, growth). `warapp_plan_turn` gets it from
  `<dataDir>/boards/<gameId>.json` first — the verified live boards written after each plan or
  track (newest ten turns kept, so re-planning a turn keeps the trend and opponent tracking has a
  history) — and from GameFeed `GetHistory` (unverified in progress, parsed loosely in
  `src/trend.ts`) only for turns the cache lacks, not at all when the two previous turns are
  cached; it reports `trendSource`. A board the decoder refuses is never written there. Each
  write keeps the game's settings beside it (`<dataDir>/games/<gameId>.json`, see "Offline replay").
- **Opponent tracking (`src/analysis/opponents.ts`, `warapp_track_opponents`) reads that board
  history** with the same rules, consecutive turns only: per opponent the observed deploy each
  turn, income = the most of the last three observed turns (or its stock and flow when more),
  floored at base + visibly held bonuses — and never decaying (#119): an earlier figure is carried
  until a bonus it visibly held is visibly broken (less its value) or it could no longer earn it;
  my own orders on a turn are measurements (`measureOrders`): `warapp_submit_turn` caches the
  deploys and moves it sent beside the boards, and `boardHistory` attaches them as
  `TurnBoard.orders` (orders sent from the web client stay unknown, which changes nothing;
  `warapp_uncommit_turn` drops the turn's cached orders once the withdrawal is confirmed),
  unexplained armies (earned since first seen − visible army change − visible losses − likely
  combat deaths) and inferred bonuses (combinations of up to three bonuses it could hold that
  best fit the income gap, within reach and affordable, none listed when too many fit — see the
  #123 rules below; candidates, never asserted). With 2+ observed turns the planner uses
  the tracked income in place of the single-turn observed figure (`PlanInput.tracks`) and says so
  in its rationale; fewer, and the plan is exactly what it was without tracking.
- **Locating opponents (`src/analysis/whereabouts.ts`, pure; `warapp_locate_opponents` in
  `src/tools/where.ts`, read-only)** reads the same board history and tracks, plus the starts the
  award proves (`loadAward`), the pickable territories kept in the pick record (`pickable` in
  `src/pick-list.ts`, written by `warapp_plan_picks` and the `warapp_submit_picks` preview; a record
  may now hold `pickable` without a `list`, which gives no award) and, only when `statsGate` is on
  (`WARAPP_STATS=1`, never hosted), the finished games already cached for the map
  (`cachedRecords` in `src/stats.ts`: the cache alone, never a request) as start candidates and
  prior. `seen` is the only fact in its output; everything else is a `likelihood` from a simple
  model, with its `basis`. The planner does not use it yet. It writes the board cache like
  `warapp_track_opponents`.
- **The turn planner (`src/analysis/planner.ts`) is pure and deterministic** (ties on
  ascending id, no I/O; its header comment is the full rule list) and judges every hold and
  capture with the exact combat model (`armiesToTake`, `captureCost`). Its rules, learnt from
  a lost game (`tests/analysis/lessons.test.ts` replays each lesson in miniature):
  - **Triage by protected value.** A threatened border's protected value is my complete
    bonuses containing it, plus bonuses I'd lose all access to, plus its share (value × members
    held ÷ size) of a bonus I am building — every missing member a visible neutral, finishing it
    economic (#122) — plus per-territory income; its
    **worth** adds the armies a hold saves as income (armies / `PAYBACK_TURNS`), so a big stack
    is topped up rather than abandoned. Holds go in order of worth per army of hold cost. A
    border is **conceded** when holding costs more than `CONCEDE_FACTOR` (3) × its worth or than the income left
    (a warning either way; in the opening, never on worth when the hold costs no more than the
    armies already there, #122): triage deploys nothing there (unless every territory I hold is
    conceded), it attacks out only with the armies already on it, and idle armies never move
    into it. It can still get deploys as a finish-off source (rule 1e runs first) and, under Local
    Deployment, from its held bonus's own pool (which lands only inside that bonus).
  - **Held bonuses first (#51)** (under `balanced`/`defend`): a bonus I hold in full is one
    unit — all its threatened borders are held or none (a border shared by two held bonuses is
    paid once). A unit whose summed hold cost ≤ `PAYBACK_TURNS` × its value (and, like any
    border, ≤ `CONCEDE_FACTOR` × its worth) is funded before any capture that completes no bonus
    (advances, breaks, other expansion); completions still compete on score but never starve a
    unit unless their bonus earns more — and (#122) never one that would then be conceded
    unless one turn of the completion beats `PAYBACK_TURNS` × what is lost, while one left only
    a near miss yields to a completion that pays for itself within a turn — and finishing off
    keeps its place. One that does not
    pay is not conceded yet (#118): the captures go first, and it is held whole from what they
    leave when that covers it. One a deploy must choose among (its every threatened border
    faces a player with two or more of my threatened borders) is **floored** when it cannot be
    held whole — every border first beats the armies already next to it — and kept: the rest
    is spread over its borders against the one shared enemy deploy, never conceded or withdrawn
    from; a warning per opponent says what its one deploy can still break at once ("+V at
    risk"), which may be all of them. Otherwise, one that does not pay or that the income left cannot cover is conceded
    whole ("conceding bonus …") and its borders are judged alone without that bonus.
    `expand` is unchanged but warns.
  - **Withdraw** (under `balanced`/`defend`): a conceded border's movable armies go first to
    the neighbour nearest a border that holds — except from a bonus I hold in full (#118),
    whose garrison stays unless it makes that neighbour, a valued enemy-facing border, hold
    this turn — and is my first order, because a withdrawal only executes while the border is
    still mine. Order Priority moves only that first order ahead of the opponent's first, so the
    plan sets `cardAdvice: 'order-priority'` only when I hold one (`holdsOrderPriority`), I am
    not known to move first (`movesFirst`), and the order it protects carries at least
    `ORDER_PRIORITY_MIN_ARMIES` (#127; waived by `orderPriorityForced`, when the hand is over the
    limit and the card is played anyway). The protected order is checked against the schedule:
    if a move it depends on runs first, that move is my first order and the card is judged for
    it; a strike is protected only when rule 1s advised the card for it (my commander
    threatened), never because a withdrawal did. The planner never plays cards itself;
    `warapp_plan_turn` adds the Order Priority I hold to `orders` when `cardAdvice` asks for it.
  - **Move order (#127).** Orders zigzag (the first mover's 1st, the other's 1st and 2nd, …), so
    the plan's `moves` are scheduled last (`src/analysis/schedule.ts`): the protected order, then
    withdrawals and transfers into enemy-facing borders, attacks that land even if the owner
    deploys there first, filler (uncontested neutrals, interior transfers), and last the attacks
    into a stack that can fight back (attacking second fights survivors) and contested neutrals
    whose survivors would not hold — softeners before finishers, moves into a territory before
    moves out of it; early moves largest first. With one opponent in view a "Move position" line
    gives each move put last its place in the zigzag (`opponentOrdersBefore` / `indexAfterAll`;
    known, Order Priority, or both cases). Deploys are listed next to a visible enemy first.
  - **The game profile (`src/analysis/profile.ts`, S1)** is on every plan (`profile`): format
    (players' teams — the shared `carriesTeam` test in `src/teams.ts` — and who is still
    playing), phase, standing (my income vs the strongest opponent's estimate; the armies on
    the board overrule it — never `ahead` while my visible armies are below 0.8 × an opponent's
    in view, and `behind` when below half, fog or not, since what it shows is the least it has)
    and the strategy settings. `warapp_plan_turn` passes `adapt: true`: with no `goal` the profile picks
    it (behind → `defend`, else `balanced`) and its rules fire (1v1 in contact: advances rank
    below holds and breaks; FFA with 2+ opponents: no second front; behind: no pressure margin;
    ahead in a 1v1: pressure at `AHEAD_PRESSURE_FACTOR`). An explicit `goal` overrides it, and the plan warns that the format rules are off (a script that always passed `goal: balanced` played two 1v1s without them).
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
    visible missing member. An FFA lead step into it (an enemy member, #203) is sized to land
    even if its owner deploys there first; when the turn cannot fund that for the closest bonus or
    a completion, it is taken at the bare cost that ranking used (#214), after every sibling's
    sure try, with #120's warning — only while rule 4f commits to the closest bonus, and never
    with the armies a hold gets: `planTurn` plans again without bare steps and keeps that plan
    (saying so) when the bare one leaves a border it holds without its hold.
  - **The economy test charges armies lost (#125).** A capture costs the economy the armies its
    attackers lose plus the one left on it (waived when an idle stack beside it, facing no enemy,
    takes it), not the armies sent; a bonus's worth adds its members' per-territory income; plain
    expansion (pass 3) repays its losses with the income it adds within `PAYBACK_TURNS`, or loses
    at most `PLAIN_EXPANSION_LOSS` (2) for +0. Turns to finish are never fewer than a bonus's depth.
    A capture rule 4e/4f names but cannot afford gets the leftover on its source, and idle stacks
    facing no enemy stage one step toward it.
  - **One surplus per territory (#121).** A border that holds at the start of the turn keeps
    what holds it, as my commander's territory does: a capture from it spends only the armies
    above that (plus deploys), so a capture never leaves a safe border takeable. Idle armies
    transfer toward the enemy front first (the nearest non-held territory only when no enemy is
    reachable), a capture of a player's territory sized without a reserve does not make the
    garrison beside it idle, and my commander's stack beside a conceded border stays.
  - **Attacks on a player are sized for its owner's deploy (#120).** When the armies beyond what
    holds the source cover it, an attack on a player's territory (break, counter-attack, strike,
    rule 4e capture) is sized for its defenders plus the owner's deploy estimate (or its growth
    there, when larger), and counts as landing; otherwise its "assumes its owner does not
    reinforce" warning gives the win chance against the reinforced target. The 1v1 strike stack
    goes to the border with the most to spare after its best such strike (most armies only when
    none can strike), and fog pressure paid outright from idle armies is not priced against
    expansion (`PRESSURE_FACTOR`). #226: once the transfers have run, such an attack (not a
    combined capture, not under No-Split) also takes the armies still idle on its source beyond
    what holds it — even if the attacks on players beside it fail (#128), the owner's other stacks
    beside each target having moved in first — as a margin over an
    estimate that is only a floor; a "Margin on the attack on …" line says what deploy it covers.
  - **A hold is sized for the worse move order (#215).** Armies withdrawn into a border land by my
    own order, after the opponent's first attack when it moves first: unless `movesFirst` is true,
    the leftover makes each open border that falls without them hold on its own (when it can
    afford the whole hold; the armies the border's own orders send out still stand then, since the
    opponent's first order precedes all of mine, so it leaves out only the withdrawal less those,
    `lateNet`; never from what another open border needs to hold whoever moves first: moving
    first, only my first order lands before the opponent's first, so a border another withdrawal
    goes into needs its worse-order hold either way, and it is kept back from the one my first
    order goes into; two such borders go most at stake first, neither reserving for the other) — after #121 has held a conceded border after all when the leftover would
    buy comfort margins (a conceded border falls whoever moves first; that one falls only if the
    opponent does), and #121 may then take back a withdrawal the border it went to needs, paying the
    deploy that holds that border without it (spent either way) — what a border keeps from captures and
    top-ups (`keepFor`) leaves them out, and a border that still holds only with them is warned
    "holds only if I move first" (naming why no deploy was made only when that was the reason).
    Known to move first, they count as before (#127). Known means the user said so (`first_mover`,
    now or on a remembered turn): a first move only the award of picks gives (the wiki's rule, not
    verified live) still orders the moves and decides card advice, but holds treat it as unknown
    (`movesFirstUnverified`) and the warning names the award; so do they when an opponent may hold
    an Order Priority card (`opponentsMayHoldOrderPriority`: played, its first order runs before mine). Idle armies rule 6 transfers into a
    border never count toward its hold; when the border holds only with them the same warning says
    so (moving first, only my first order lands before the opponent's first: it names the one transfer
    that must be that order; known to move first, "holds only if my first order is …").
  - **A contested held bonus comes before an advance in a 1v1 in contact (#215, rule 0p.1).** A held
    bonus whose hold pays back within `PAYBACK_TURNS` but costs more than `CONCEDE_FACTOR` × its
    worth is contested (#118: the captures go first). Under rule 0p.1 an advance ranks below every
    hold, so before the first advance it is held whole when what is left covers it (best worth per
    army first, never weighed against spreading); otherwise it stays contested as before. Live, a +4
    bonus's one border was floored and spread on 9 armies while 15 went to an advance into a bonus
    47 armies from done, and fell to the 33 that could reach it whoever moved first.
  - **Leftover** goes to the held border with the most at stake still short of a comfortable
    margin (with several, each is brought to its margin first, and a conceded border the leftover
    can make hold is held after all before any margin, #121), else the top expansion's stack — never to a conceded border (the old "most enemies
    next to it" rule picked the hopeless border).
  - **Trend:** with `previousBoard`, growth of a visible adjacent enemy stack projects into
    the threat (see the threat model above), and warns "is building" — less what a visible
    neighbour of the same owner sent (unless it shrank beside another player's shrinking stack:
    a fight, not a transfer), and at most its observed deploy with every ambiguous army
    read as deploy (`high`; #123: a transfer is a one-off, a stack walking in beside the fog is
    still massing — lesson 5).
  - **One-off movements are not income (#123, `observeDeploy`).** Growth on its territory next
    to the fog and the surplus of a capture whose visible attacker shrank are ambiguous: both read
    as deploy up to one bound, `HIDDEN_INCOME_FACTOR` (2) × what it was expected to deploy
    (visible income, the fog prior in the planner, or tracked/carried income — so a steady hidden
    bonus is still seen; a carry only bound-cut readings reached ends at a later turn read in full
    that observed less) and at most what it could earn; beyond it, a stack out of the fog. A capture from me is
    priced at the guard unless my cached orders say what stood there. Each observed turn has a low–high range for the ambiguity. The
    tracker's `unexplained` armies leave out likely combat deaths (its stack and a neighbour of
    another player both shrank), and inferred bonuses must lie within `INFER_REACH` hops and be
    affordable — none listed when more than `MAX_LISTED_COMBINATIONS` fit.
  - **Lessons from three more lost games** (`tests/analysis/lessons-defensibility.test.ts`):
    - **Border value after captures (#18).** Triage runs before captures are known, so after
      the capture passes a conceded border in a bonus this turn's captures complete is kept —
      never withdrawn from, garrisoned from the leftover, warned when that still cannot hold.
      Since #122 a member of a bonus completed this turn that faces an enemy is garrisoned right
      after the completion, before later captures, when the hold pays as a held bonus's would.
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
      Except in the contact/late no-capture fallback (rule 4e, #114), where it is a cost instead:
      the survivors a capture leaves on a border it cannot hold next turn count as armies at risk.
  - **Game rules** (`docs/PLAN-PLANNER-4.md`, `tests/analysis/lessons-game-rules.test.ts`; the
    full-rung `settings` echo shows each):
    - **Kill rates (#28).** Every combat computation uses the game's offensive/defensive kill
      rates; only settings without them fall back to 60/70, with a warning.
    - **Local Deployment (#29).** With `localDeployments`, a held bonus's value is a pool
      deployable only on its own territories and only the rest of the income goes anywhere
      (pool rules unverified, `docs/WARAPP-API.md`); `warapp_submit_turn` refuses a broken split.
      A bonus's own pool defends it (#103): its hold cost is judged net of the pool, the pool
      goes to its most threatened border and stays there, and a conceded bonus's garrisons are
      withdrawn only when one of its borders needs more than its pools plus every free army.
    - **No-Split (#31, #124).** With `noSplit`, a territory issues at most one attack or transfer
      (its best; the rest are dropped with a warning), and it sends the whole stack — this turn's
      deploys there included, less the guard (verified live with the guard off; whether the guard
      stays is unverified). A territory that must hold issues no order; a strike stack's one order
      goes to the strike before a small expansion. `warapp_submit_turn` refuses a split and warns
      when an order sends less than the whole stack.
- **The border guess (`src/analysis/guess.ts`, `warapp_plan_turn`'s `guess` / `guessOrders`)** is a
  randomized deploy split against an opponent who would read a fixed one: pure and deterministic like
  the planner (seeded by `guessSeed(game, turn, salt)`, mulberry32; the salt is a local secret at `<dataDir>/guess-salt`, `src/guess-salt.ts`, because the code is public), solved exactly as a small matrix game
  (allocations at threshold levels × the border the deploy lands beside, a simplex). Only when exactly
  one opponent has visible stacks next to 2–7 of my borders, combat is exact, Local Deployment is off,
  no fixed split holds them all and the mix beats it by `MIN_GUESS_GAIN` of the worth at stake. It
  redistributes only the plan's deploys on those borders and never changes the planner or the plan's
  `orders`; with no guess both fields are absent, and the skip reason is `guessSkipped` in `full` only.
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
- **A chrome-less "direct" transport, LOCAL-ONLY** (`src/direct/`, phase 7 — `docs/PLAN-DIRECT.md`).
  The signed-in session is carried by a durable **`AuthToken`** cookie, and that cookie **alone**
  authenticates both the server-rendered pages and a `/Services` POST (**verified 2026-11-12**).
  So the bridge has a direct-first router wrapped around it (`createDirectFirstBridge` in
  `src/direct/transport.ts`, over mcp-utils `createDirectFirstTransport`; the fetchproxy bridge
  itself is `createWarappBridge` in `src/transport-bridge.ts`): the direct leg issues a plain
  server-side HTTPS request carrying the cookie, falling back to the browser bridge when no session
  is linked or it has expired. Signed out means a sign-in page or redirect, a 401 or 403 from war.app,
  or a 200 `/Services` reply that is not a frame — a 5xx passes through as an `http` error. A non-GET
  that reached war.app on the direct leg is **never re-sent over the bridge** (a write must not be
  sent twice); later calls use the bridge. The one reply that is re-sent is an edge challenge (a
  CDN/WAF page or `cf-mitigated` header, mcp-utils `detectEdgeBlock`), which never reached war.app —
  and a 200 that is a valid frame is war.app's answer, never a challenge, whatever header sits beside
  it. The direct leg sends the cookie to the exact origin `https://war.app` only: a GET follows
  redirects within it, a non-GET follows none. A relink (`warapp_link_session`, or a new `capturedAt` on disk) clears the stale flag
  and returns `auto` to the direct leg.
  `WARAPP_TRANSPORT` = `auto` (default) | `direct` | `fetchproxy`; the session is stored at
  `WARAPP_SESSION_FILE` (default `<dataDir>/session.json`). One injection point: `index.ts` builds
  this one bridge and passes it to `WarappRpc`, the page fetches, the healthcheck and the push
  socket, so they all get direct mode at once. `warapp_link_session` (write, confirm-gated,
  local-only) captures the cookie once through the bridge; `warapp_session_status` reports the
  linked state, age and active leg. **The `AuthToken` is a full-account credential:** file `0600`,
  dir `0700` (macOS: no ACL on either), atomic write; scrubbed by value from every upstream error string (mcp-utils
  `stripBearer` + `scrubToken`); never logged, never in a tool result, never in an error/hint.
  **Direct mode is local-only, enforced in code:** on a hosted child (`isHosted`, `src/hosted.ts`)
  `warapp_link_session` is not registered, the session store reads as empty and refuses writes
  (`src/direct/session.ts`), the router is pinned to the browser bridge whatever `WARAPP_TRANSPORT`
  says (`createDirectFirstBridge`), and no hint suggests linking; `mint.yaml` keeps the bridge.
- **End of game (#178).** `Game.endRules` holds the surrender, boot and AI settings; whether a surrender
  needs acceptance comes from `InstantSurrender`, not the player count (the count is only the fallback).
  `warapp_plan_turn` logs each turn's outlook name-free at `<dataDir>/outlook/<gameId>.json`
  (`warapp_get_game` adds the final result); the surrender preview reads the latest from there.
  An opponent the outlook cannot measure (nothing in view now, or no observed income) gets a
  peer-paced likely high (#214, `peerPace` in `src/analysis/outlook.ts`, pure and exported for the
  planner): each turn 2 × the higher of my income and the most any opponent was tracked earning, the
  map's even share only a ceiling — never sized by the map; it can still block `winning`. Every likely
  high starts symmetric: the given start, the even share under full distribution (the real start
  then), else my opening board, else the default territory limit (3) at the starting armies — never
  the territories I hold on a later board; my income before my first board ramps up from that
  opening's.
- **One healthcheck for both transports** (`registerAdaptiveHealthcheckTool`): the credential
  probe while the direct leg serves (and until the bridge has carried a request), the bridge probe
  only when this connection's router is on the bridge leg (the fetchproxy bridge is shared
  process-wide, so its role alone is not enough; `WARAPP_TRANSPORT=direct` never probes it); either way it reports the active leg and whether a direct session is linked and
  its age (never the token). The bridge port is `WARAPP_WS_PORT` (default 37149); hosting needs
  `bridge: true` and `bridgePortEnv: WARAPP_WS_PORT` on the registration.
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
  `HOSTED_MARKERS` in `src/hosted.ts`), and `mint.yaml` never sets `WARAPP_STATS`. GameIDFeed + GameFeed
  `GetHistory=true` through `WarappClient`, ≥ 1 s apart, finished games cached forever as
  name-free records at `<dataDir>/stats/<mapId>/<gameId>.json`. Each game is read with
  `GetMap=false` (a cached map is attached by its id); only a finished game on an uncached map
  costs one more request, for the map.
- **All GameFeed traffic goes through `WarappClient` (`src/client.ts`)**, including the
  credential healthcheck probe; all `/Services` traffic goes through `WarappRpc`
  (`src/protocol/rpc.ts`), which echoes the reply extras into the next request. Maps are
  cached in memory (`MapCache`) and on disk (`src/map-store.ts`, local and hosted: the per-user
  `state.dataDir` persists): `<dataDir>/maps/<mapId>.json` holds the normalized map with its BASE
  bonus values (overrides are per game, applied by `mapOf`), at most `MAX_STORED_MAPS`, the least
  recently used evicted (a memory hit marks the file used, and stores it again if it has gone, so a
  game played all session keeps its map for replay); `<dataDir>/maps/games.json` says which map a game is on (bounded), so a
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
  that never uses the map (the turn wait, surrender, uncommit, chat, join-game, scout, begin-turn,
  submit-turn's read-back) always asks `GetMap=false`, even for a game it has not seen.
- **Offline replay (`src/replay.ts`).** Wherever the board cache is written (plan_turn,
  track_opponents, locate_opponents, get_relations) the game's settings are kept at
  `<dataDir>/games/<gameId>.json`: name-free (players by id, team, state and AI flags; raw settings
  through `sanitizeSettings` — numbers, booleans, numeric strings, a few enum words and a card's
  `Mode` word (`cardArmyCeiling` reads it), no free text,
  no mod entries, nothing equal to a player's or the game's name; overrides re-written in their
  verified shape), 0600, atomic, best effort, the newest `MAX_GAME_RECORDS` kept and a game not
  written for 60 days deleted, like the boards. `loadReplay(dataDir, gameId)` rebuilds the planner's
  inputs from the data directory alone: `{ game, settings, map, playerId, boards, orders }`
  (`undefined` without a settings record; `map` absent when the store evicted it).

## Commands

`npm run build` (tsc --noEmit + esbuild bundle) · `npm test` (typecheck + lint + vitest) ·
`npm run test:coverage` (what CI runs: `npm test` plus the coverage thresholds in `vitest.config.ts`) · `npm run typecheck` ·
`npm run lint` (Biome, lint only — no formatter; `biome.json` turns off the house-style rules such as
`noNonNullAssertion`, which `noUncheckedIndexedAccess` makes the idiom). `exactOptionalPropertyTypes`
is off until `src/analysis/planner.ts` is clean under it.
