# War.app web-client protocol (reverse-engineered)

The official API (`/API/GameFeed`) returns **no board for an in-progress game** — not
standings, not the pick-phase map — and has no way to submit orders. The web client
talks to its server over a private binary RPC protocol instead. This document records
that protocol as read from the client bundle (`warappcdn.com/js/Release/ujs.js`,
client `v6.07.0.1`, protocol version 242) and checked against captured traffic.

**Status (2026-11-12):** request framing fully decoded — 7/7 captured requests rebuilt
byte-identical from decoded fields; reply payloads decode generically (every byte consumed on
all captured replies); `SendOrders` layout read from the client's serializers, awaiting a
live capture — now verified (below); picks verified end to end through the bridge. Nothing here
is a captured value; no captures are committed.

## Transport

- `POST https://war.app/Services?m=<MethodName>&js=1`, body = the frame **hex-encoded**
  (uppercase), sent by jQuery `ajax` from the signed-in page. The reply body is hex too.
- When a live connection exists the client may use a socket channel instead; the HTTP
  path is the fallback and is what this project uses.
- **Authentication is the browser's cookies.** The request body carries the account
  email (below) but no token, so a frame is only honoured from a signed-in session —
  build frames anywhere, but send them from the signed-in tab.
- **The `AuthToken` cookie alone authenticates — verified 2026-11-12.** The signed-in
  session is carried by a durable `AuthToken` cookie, and that single cookie is enough to
  authenticate both the server-rendered pages (InviteToken, Profile, CommonGames, MultiPlayer)
  and a `/Services` POST, with no browser involved: a plain HTTPS `POST /Services?m=GetLatestGameInfo&js=1`
  carrying only `Cookie: AuthToken=…` returned a valid reply frame. So a frame can be sent from a
  server-side request too, as long as it carries that cookie — this is the "direct" transport
  (`src/direct/`). `AuthToken` is a full-account credential: it is stored locally only (file mode
  `0600`), never logged, and never returned. Direct mode is a local-runtime option; hosting keeps
  the browser bridge and stores no token.
- The `m=` query parameter is derived from the method id at byte 10 (`fb.WBb`); it is
  informational.

## Primitives (C# `BinaryWriter` style, little-endian)

| Type | Encoding |
|---|---|
| bool | 1 byte, `00`/`01` (anything else is corrupt) |
| int16 / int32 / int64 | little-endian |
| string | bool *present*, then 7-bit-varint byte length, then UTF-8 |
| datetime | float64 **milliseconds since 2000-01-01T00:00Z**; "no date" = `-3.4028235e+54` |
| dict&lt;int,string&gt; | bool *present*, int32 count, then (int32 key, string value)… |
| int list | int32 count, then int32… |

## Frame

```
int16   version | flags     242 (0xF2); bit 15 set = reply  →  F2 00 request, F2 80 reply
int32   preamble            1514664249  (39 F1 47 5A) — anything else is rejected
int32   messageNumber       per-session counter; a reply echoes the request's
int32   methodId            see table
--- request only ---
MessageExtrasUp             (below)
[auth]                      only for methods that take one (GetMapDetails has none)
params                      per method
```

### MessageExtrasUp (`warlight.shared.MessageExtrasUp`)

```
dict<int,string>  (present, here empty)
string   clientVersion        "v6.07.0.1"
int32    serverInfoVersionA   echoed from the last reply (348 observed)
int32    serverInfoVersionB   echoed from the last reply (88732 observed)
datetime fDb                  "no date" observed
datetime kFa                  last-notification time the server sent back; changes over a session
int32    platform             15 = website
```

None of these are secret. They must be plausible; the server-info versions and `kFa`
should be taken from the most recent reply rather than invented.

### Auth (`XP`)

```
bool   present (01)
byte   tag 04
string email                  the signed-in account's email
```

## Methods (from `H4.ic`)

| Id | Name | Notes |
|---|---|---|
| 38 | GetGameDetails | |
| 39 | GameRefresh | params: int32 gameId, bool, bool, string "-1", string "-1", bool, dict, dict |
| 40 | GetLatestGameInfo | params: int32 gameId; reply class `NE` — expected to carry the board |
| 73 | GetMapDetails | no auth; params: int32 mapId |
| 74 | **SendOrders** | the turn commit — not yet captured |
| 75 | SendInProgressOrders | draft save of orders |
| 76 | SendTerritoryPicks | params: int32 gameId, bool present, int list territoryIds (priority order), bool, bool |
| 77 | SendInProgressPicks | as 76 without the two trailing bools (draft save) |
| 79 | GetTerritoryPicks | |
| 80 | UnCommit | |
| 81 | GetTurns | |
| 238 | Subscribe | push channel only, **no auth**; params: bool true, list of topic strings, string null; reply dict topic→int32 error |
| 241 | GameUpdated | server push, **no auth**; msgNum `0x80000000`, 61 bytes, starts with the game id; carries no detail — re-read GameFeed |

Server error codes seen in the client: 11 = deployed armies ≠ income, 208 = game already
advanced to the next turn, 88 = game deleted, 483 = game started without you.

## Replies

```
frame header (flags F2 80)
byte    1 → MessageExtrasDown follows (warlight.shared.MessageExtrasDown)
        MessageExtrasDown carries ServerInfo { serverInfoVersionA, serverInfoVersionB, … } —
        the values the next request's MessageExtrasUp should echo
byte    5 → ServerException { code, message } follows instead of a result
        anything else → bool present, then the method's result class
```

Result classes are the client's generated readers (`<Class>.Ha` in the bundle). Rather than
transcribe each one, they are decoded by **interpreting the bundle's own reader functions**
against the bytes (a ~250-line evaluator over the small JS subset those readers use: primitive
reads, present-flag ternaries, lists/dicts of nested classes, version checks, `switch` on a
type tag). Verified on captured replies, every byte consumed:

| Method | Result class | Bytes |
|---|---|---|
| GetMapDetails | `warlight.shared.MapDetails` (27 bonuses, 129 territories, map 79472) | 14869/14869 |
| GameRefresh | `warlight.shared.GameDetailsAndChat` → `GameWL` summary | 358/358, 362/362 |

Reader primitives (`P.*`): `Ya` int32 · `wc` string · `Yc` bool · `uq` byte · `Z5` uint16 ·
`Ao` float32 · `ak`/`uy` int64 · `Td` datetime · `tL` GUID (16 bytes, .NET order:
3,2,1,0,5,4,7,6,8…15) · `sL` int32-length bytes · `Sd`/`ms`/`uL` int32-count list (-1 = null) ·
`ef` int32-count dict (-1 = null).

The project does not redistribute the bundle: the decoder loads it from War.app's CDN at
runtime, so class layouts track the live client. Field names in the bundle are minified and
change between releases; semantic mapping is by class name (`W["warlight.shared.*"]`, stable)
and field read order.

## Orders (`SendOrders`, method 74) — verified against a live turn commit

```
params: auth, int32 gameId,
        bool present, int32 count, then per order: bool present + order,
        int32 turnNumber, bool, bool
GameOrder base (after each order's own fields):
        int32 playerId (in-game id), bool hasResult (00), bool hasStandingUpdates (00)
Deploy          byte 02, int32 territoryId, bool flag, int32 armies, base
AttackTransfer  byte 01, bool attackTeammates, byte mode (1 Attack, 2 Transfer,
                3 AttackTransfer), bool byPercent, int32 from,
                Armies { bool fogged, int32 count, byte specialUnitCount, units… },
                int32 to, base
PlayCard*       byte <card tag> (5 Reinforcement, 10 Order Priority, 11 Order Delay,
                18 Blockade), card fields, GUID cardInstanceId, base
```

**Verified 2026-11-12** against a real turn-1 commit (1 deploy + 4 attacks): the captured
frame parses with 0 bytes left over, and the encoder's parameter bytes for the same orders
are byte-identical (132/132). Observed values: `mode` 3 (AttackTransfer) is what the client
sends for an ordinary attack; `turnNumber` is the turn being submitted (GameFeed
`numberOfTurns` + 1 — it was 0 before turn 1); the trailing two bools were `false`; the
client also sends `SendInProgressOrders` (75) drafts as orders are built, which a tool does
not need.

**Sent from code, 2026-11-12:** a turn built entirely by this project's encoder (3 deploys +
3 attacks, `turnNumber` 2) and delivered through the bridge was accepted, resolved the turn
(GameFeed `numberOfTurns` 1 → 2) and every planned capture happened. The reply's result bool
was `false` even though the commit advanced the game, so it is **not** a success signal:
confirm a commit from game state (turn count, the committed flag in `GetMyGames`, the board).
A controlled check with the real client (opponent already committed, so the commit resolved
the turn) also got `false`. The client's commit callback uses that value only to show "This
action has ended your vacation" — it is a **vacation-ended flag**, `false` in normal play.

Server checks seen in the client: error 11 (deployments ≠ income) and 208 (turn already
advanced).

**Card plays and turn phases (verified live 2026-11-12).** Orders must be sent in
`warlight.shared.TurnPhase` order or the server refuses the turn with error 10
`OrdersInIncorrectOrder`. The card tags and phases this project encodes:

| Card play | Order tag | Phase |
|---|---|---|
| Order Priority | 10 | 12 |
| Reinforcement | 5 | 20 |
| (deploys) | 2 | 25 |
| (attacks/transfers) | 1 | 50 |
| Order Delay | 11 | **50** — placed in phase 12 (with Order Priority) it was refused with error 10 |
| Blockade | 18 | 60 |

Within one phase the encoder writes card plays after the other orders (an Order Delay after
every AttackTransfer); that within-phase position is unverified.

**The hand is the current `GameStanding`'s.** `LatestGameInfo` holds the pending orders, the
current `GameStanding`, the last `GameTurn` and the previous `GameStanding`, and card instances
appear in all of them. Only the current standing's cards are playable: an instance that survives
only in the previous standing or the turn's receive/play orders was already played, and playing
it is refused with error 50 `CardInstanceUnavailable`.

## Verified end to end through the browser bridge

Frames built outside the browser (by this project's encoder) and sent through the
fetchproxy bridge, so the request runs inside the signed-in tab:

| Call | Result |
|---|---|
| `GetMapDetails` (no auth) | full 14869-byte `MapDetails`, our message number echoed |
| `GetLatestGameInfo` (auth) | `LatestGameInfo` → `GameStanding` with one `TerritoryStanding` per territory (129), every byte consumed |
| `SendTerritoryPicks` (auth, write) | accepted; result bool `false` (also what the real client got) — not a success signal |
| `SendOrders` (auth, write) | accepted, turn resolved, captures happened — see Orders |
| `GetTerritoryPicks` (auth) | read back exactly the submitted ids in priority order |

`TerritoryStanding`: territory id, owner, `Armies { count, fogged, specialUnits }`, fog level.
Owner `0` = neutral, `-2` = available to pick, otherwise an in-game player id.

**Player ids.** GameFeed and the invite token give a player's id wrapped in two leading
and two trailing check digits; the in-game id is the middle: `id[2:-2]` (e.g. a token
`AB1234567CD` → `1234567`). The digits vary per player — do not assume a fixed `64…16`.
`GetTerritoryPicks` and `GetFullProfile` take the in-game id; `GameStanding` keys players by
it but lists only players the viewer can see (an opponent hidden by fog is absent).

**Gotcha.** A war.app tab that is blocked (e.g. waiting on a browser permission prompt) makes
bridged POSTs time out while GETs still work; reloading the tab clears it.

## My games and profiles (verified through the bridge)

- `GetMyGames` (50): auth, bool present + `MyGamesFilters { byte filterType, int32 count,
  byte sort }` — **required**: absent filters make the server throw a NullPointerException
  (`ServerError … MyGamesFilters.Filter()`); the client's default is `{4, 10, 2}` — then
  bool, int32 0, bool, bool. Reply `warlight.shared.MyGamesReturn`: one entry per game with
  id, name, map id and state codes (mapping the codes is still to do).
- `GetFullProfile` (180): auth, int32 in-game player id. Reply
  `warlight.shared.FullProfileData`: name, level, member-since, per-format records
  (`{Wins, Games, NumTeams, TeamSize}`) and many counters. It also carries the player's
  self-reported location — a scouting tool must not surface it.
- Server errors arrive as envelope kind 5: `{ int32 code, string message }`; the message can
  be a long server stack trace — log the code, show a short message.

## Chat

- **Read:** the official `GameFeed` answers `GetChat=true` with a `chat` list of
  `{ playerID, date, turn, message }` — use that. `playerID` there is the **in-game id**, not
  the check-digit-wrapped id GameFeed uses for players.
- **Send:** `SendChat` (42): auth, int32 gameId, string text, int32 channel (`-1` = public,
  otherwise a team), optional int32 private recipient, optional int32 game-group id, two
  marker strings, two optional "last seen" dicts. Reply: the updated message list
  (`uv` objects). Server errors the client names: 36 rate-limited, 33 too long, 88 game
  deleted, 333 game archived. A send reaches other people, so it is always confirm-gated.

## Push channel (socket.io)

Turn notifications arrive on war.app's **socket.io v0.9** channel over **xhr-polling** (the other
advertised transport is `websocket`; xhr-polling is plain HTTP, so it rides the same browser
bridge). Decoded from `src/push/socketio.ts` and verified live.

**Handshake.** `GET https://war.app/socket.io/1/?t=<ms>` → a colon-joined
`sid:heartbeat:close:transports` (heartbeat/close in seconds; `15`/`10` observed). Then open a
long poll `GET …/socket.io/1/xhr-polling/<sid>?t=<ms>`. **The first poll of a session must return
the connect packet `1::` before anything is POSTed** — a POST before the connect is answered is
HTTP 400.

**Packets.** A poll body is a single packet, or several framed as `�<len>�<packet>` (delimiter
U+FFFD; `<len>` is the packet's character length). Types: `0` disconnect, `1` / `1::` connect,
`2::` heartbeat (answered with a POST of `2::`), `3:::<data>` message, `8` noop. A message
packet's `<data>` is a web-client frame (the same framing as `/Services`) as **uppercase hex**.

**Send.** `POST …/socket.io/1/xhr-polling/<sid>?t=<ms>`, content-type
`text/plain;charset=UTF-8`, body `3:::<UPPERCASE HEX FRAME>`.

**Subscribe (method 238).** A message frame with the usual `MessageExtrasUp` but **no auth block**
(the poll is already authenticated by the browser session). Params: `bool true`, a list of topic
strings, then a trailing `string null`. A game's topic is `Game.<gameId>`. The reply is a frame
(method 238) whose body is `bool present` then a dict `topic → int32 error`; an absent or empty
dict means every topic was accepted.

**GameUpdated (method 241).** The server push: a request-shaped frame (carries `MessageExtrasUp`,
no auth) with message number `0x80000000`, 61 bytes, that **starts with the game id and carries no
other detail**. On receipt, re-read the game from GameFeed — it arrives within ~1 s of the turn
resolving. `src/push/listener.ts` holds one socket per process, (re)subscribes to every watched
`Game.<id>` on each connect, answers heartbeats, and reconnects with backoff.

## Data handling

Request frames contain the account email in plaintext. Treat captures as personal data:
keep them out of the repository, logs and tool output. Test fixtures are built from
synthetic values with the encoder.
