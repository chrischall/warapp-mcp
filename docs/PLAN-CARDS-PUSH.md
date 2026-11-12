# warapp-mcp — phase 5 plan: cards, turn notifications, a threat-aware planner

Worktree `/Users/chris/git/warapp-mcp-cards`, branch `feat/cards-push` (from `origin/main`;
another build runs in `/Users/chris/git/warapp-mcp-scout` — never touch it or any other
worktree, never switch branches, never push). Same hard rules as earlier phases: no live
network in tests or agents, no captured data, synthetic fixtures, real email never in the repo.

## Facts verified live on 2026-11-12

**Cards.**
- GameFeed `GetSettings=true` carries the card rules: `MaxCardsHold` (4 in the test game),
  `NumberOfCardsToReceiveEachTurn`, and per card `{ NumPieces, InitialPieces, … }`, with
  `ReinforcementCard.FixedArmies` (5) giving the armies a Reinforcement card adds. A card that
  is `'none'` is not in play.
- When the hand is at the hold limit the server refuses `SendOrders` that play no card:
  **server error 51 `MustUseCard`**. Map it in the RPC error table with that wording.
- The hand is in the live board: `LatestGameInfo.rf` (GameStanding) → the player entry keyed by
  the in-game id (`Db`) → a dict `GUID string → CardInstance` (`warlight.shared.ReinforcementCardInstance`
  `{ W: guid, Gb: cardType, tc: armies }`, `warlight.shared.NoParameterCardInstance { W, Gb }`).
  Read it through the bundle interpreter by type name.
- Card type ids (client registry): 1 Reinforcement, 2 Spy, 3 Emergency Blockade, 4 Order Priority,
  5 Order Delay, 6 Airlift, 7 Gift, 8 Diplomacy, 9 Sanctions, 10 Reconnaissance,
  11 Surveillance, 12 Blockade, 13 Bomb.
- Play-card orders (inside `SendOrders`, each with the usual present flag):
  `byte tag, <card fields>, GUID cardInstanceId, int32 playerId, bool false, bool false`.
  Tags: **5 Reinforcement** (no fields — verified live: two plays added +10 armies to the deploy
  budget), 10 Order Priority (no fields), 11 Order Delay (no fields), 18 Blockade
  (`int32 targetTerritory`). A GUID is written as its 16 bytes in .NET order: from the 32-char
  hex string take byte pairs in positions 3,2,1,0,5,4,7,6,8…15 (no length prefix). Golden:
  Reinforcement for card `00112233445566778899aabbccddeeff`, player 777 =
  `0533221100554477668899AABBCCDDEEFF090300000000`.
- Card plays are written before deploys in the order list (that order was accepted live).

**Turn notifications.**
- war.app pushes over socket.io v0.9. Transports: `websocket,xhr-polling`; xhr-polling is plain
  HTTP and works through the bridge (the tab's session authenticates it).
- Handshake `GET https://war.app/socket.io/1/?t=<ms>` → `sid:heartbeat:close:transports`
  (heartbeat 15000, close 10000). Then the **first** `GET …/socket.io/1/xhr-polling/<sid>?t=<ms>`
  must return the connect packet `1::…` **before** any POST — a POST first is HTTP 400.
- Subscribe: `POST …/xhr-polling/<sid>?t=<ms>` body `3:::<UPPERCASE HEX FRAME>` (content-type
  `text/plain;charset=UTF-8`) where the frame is method 238 `Subscribe` with **no auth block**:
  params `bool true, int32 count, strings…, string null`. Topics: `Game.<gameId>`. The reply
  (frame on the socket, method 238) holds a dict topic → error (null dict = all accepted).
- Polls return packets; several are framed `�<len>�<packet>`. Types: `1` connect,
  `2::` heartbeat (answer with a POST of `2::`), `3:::<hex>` message, `0` disconnect, `8` noop.
- A push is a frame with method **241 `GameUpdated`**, message number `0x80000000`, 61 bytes,
  carrying the game id; it carries no detail — on receipt, re-read GameFeed for that game. It
  arrived within a second of each turn resolving (6 observations).
- Many processes sharing the bridge port collide; the listener must live in the MCP server's
  own long-lived process and use its bridge transport.

**Planner threat model.** It assumed an unseen opponent deploys ~5. Live, a player showing 13
armies in Tennessee broke a 12-army Florida (needs ≥20) — they deployed far more.

## Tasks

### K1 — Cards in the protocol and the turn tools
- `src/cards.ts`: card type table; read the hand from the live board (by type name); card rules
  from GameFeed settings (`MaxCardsHold`, Reinforcement armies).
- `src/protocol/methods.ts`: encoders for the four play-card orders; `writeSendOrdersParams`
  accepts card plays and writes them before deploys. Golden test with the bytes above.
- `src/protocol/rpc.ts`: error 51 → "You hold the maximum number of cards, so war.app requires
  you to play one this turn."
- `warapp_plan_turn`: report the hand (names), whether a play is required (hand ≥ MaxCardsHold),
  and when required (or always for Reinforcement, which only adds armies) include a card play:
  Reinforcement first (adds its armies to income before planning), else Order Priority, else
  Order Delay; never auto-play Blockade (it gives a territory away). Include the plays in `orders`.
- `warapp_submit_turn`: accept card plays in `orders` (`{ kind: 'card', card: <guid or type name>,
  target? }`); validate the card is in the hand; income check = income + Reinforcement armies of
  played cards; refuse up front with the error-51 wording when a play is required and missing.

### K2 — Turn notifications in the MCP
- `src/push/socketio.ts`: an xhr-polling socket.io v0.9 client over the bridge transport
  (GET via the transport, POST via the transport), with the connect-before-POST rule, heartbeat
  replies, packet framing, reconnect with backoff, and a `Subscribe` sender.
- `src/push/listener.ts`: one per process, started lazily on first use, subscribes to
  `Game.<id>` for the given games, emits `{ gameId, at }` on `GameUpdated`.
- Tool `warapp_wait_for_turn` (read): `game_ids` (required, 1–20; game discovery arrives with
  `warapp_my_games` on another branch and will be wired in after both merge). Resolves as soon as GameFeed shows one of them waiting on me (my player Playing,
  not committed, game Playing or DistributingTerritories) — checking once at start and again on
  every GameUpdated — or at `timeout_seconds` (default 300, max 1800). Honours cancellation
  (`currentCallSignal`) and sends progress notifications when the caller wants them.
- Tool `warapp_recent_events` (read): the last N push events seen by this process.
- Tests drive the client against a fake bridge that scripts handshake / connect / heartbeat /
  message / disconnect packets, including the POST-before-connect 400.

### K3 — Threat-aware planner
- Default enemy deploy estimate = max(5, round(0.75 × the largest visible enemy stack)), exposed
  as `enemyDeploy` in planner options and `enemy_deploy` on `warapp_plan_turn`; warnings state the
  estimate used and that unseen income is unknown. Regression test: the Florida case (13 visible
  next door) must make `defend` hold a border that 12 armies could not.

### K4 — Docs and packaging
README, CLAUDE.md, skills, manifest roster, hints table (wait_for_turn: intent `whats-new`),
strict surface lint 0 warnings (same recipe as docs/PLAN-TURN.md T4).
