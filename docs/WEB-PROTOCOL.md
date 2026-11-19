# War.app web-client protocol (reverse-engineered)

The official API (`/API/GameFeed`) returns **no board for an in-progress game** — not
standings, not the pick-phase map — and has no way to submit orders. The web client
talks to its server over a private binary RPC protocol instead. This document records
that protocol as read from the client bundle (`warappcdn.com/js/Release/ujs.js`), first from
client `v6.07.0.1` / protocol 242 and checked against captured traffic, and since #340 for client
`v6.08.0.2` / **protocol 243** (what changed is in [Protocol 243](#protocol-243-client-608)). How war.app releases new clients, and how to move
this document and the decoder to one, is in [CLIENT-RELEASES.md](CLIENT-RELEASES.md).

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
int16   version | flags     243 (0xF3); bit 15 set = reply  →  F3 00 request, F3 80 reply
int32   preamble            1514664249  (39 F1 47 5A) — anything else is rejected
int32   messageNumber       per-session counter; a reply echoes the request's
int32   methodId            see table
--- request only ---
MessageExtrasUp             (below)
[auth]                      only for methods that take one (GetMapDetails has none)
params                      per method
```

Every reader (the bundle's and `methods.ts`) reads protocol 243's layout, so `WarappRpc` refuses a
reply whose header names another version rather than decode it into wrong values (#131). war.app
answers in the protocol a request declares, and the method ids are that protocol's (see below).

### MessageExtrasUp (`warlight.shared.MessageExtrasUp`)

```
dict<int,string>  (present, here empty)
string   clientVersion        "v6.08.0.2"
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

## Methods (from `warlight.shared.messages.MessageType`)

Ids are protocol 243's; the 242 id each had is in brackets. 243 inserted six methods
(ChangeCommitConfirmation 26, TeamSurrender 70, TournamentGroup 94, UploadSharedImage 129,
ChatRoomReactionsChanged 247, SetReaction 285) and renumbered everything after each, so a method id is
only meaningful with its protocol: a 242 id sent as 243 asks for another method. Method numbers given
elsewhere in this document beside a method's name are protocol 242's unless marked.

| Id | Name | Notes |
|---|---|---|
| 10 [10] | GetOpenGames | exists, but the web client never calls it — the open games list comes from a page payload (see [Open games](#open-games)); do not use |
| 39 [38] | GetGameDetails | |
| 40 [39] | **GameRefresh** | params: int32 gameId, bool chat, bool nonChat, string "-1", string "-1", bool lobby, optional dict, optional dict, and since 243 an optional last value (a nullable number written as text; sent absent); reply `GameDetailsAndChat` — see [Chat](#chat) (the chat-only read of public messages VERIFIED live 2026-11-14; the rest UNVERIFIED) |
| 41 [40] | GetLatestGameInfo | params: int32 gameId; reply class `NE` — expected to carry the board |
| 44 [43] | **RegisterChatView** | params: int32 gameId, string public mark, string team mark, optional dict private counterpart → mark, optional dict game group → mark; no result — marks a game's chat read, see [Notifications and read marks](#notifications-and-read-marks) (VERIFIED live 2026-11-16, direct transport) |
| 49 [48] | GetGameSettings | |
| 61 [60] | AcceptGame | accept an invitation (not used) |
| 62 [61] | **AcceptOpenSeat** | take an open seat — see [Open games](#open-games) |
| 63 [62] | AcceptOpenAutoGame | not used |
| 64 [63] | GetOpenAutoGame | not used |
| 65 [64] | **DeclineGame** | params: int32 gameId, bool modHook — read from the bundle, **verified live 2026-11-14** (open-seat lobby); see [DeclineGame](#declinegame-leaving-a-lobby) |
| 68 [67] | **Surrender** | params: int32 gameId, bool surrender, bool false — see [Surrender](#surrender) |
| 69 [68] | **AcceptSurrender** | params: int32 gameId, int32 in-game player id, bool accept, bool modHook — read from the bundle, UNVERIFIED live; sent by `warapp_accept_surrender` (accept only); see [Accepting a surrender](#accepting-a-surrender) |
| 75 [73] | GetMapDetails | no auth; params: int32 mapId — read by `warapp_get_map`'s full view for the distribution modes' territories, and by `warapp_locate_opponents` for the start candidates of a game dealt automatically from a map mode, see [Map details](#map-details-distribution-modes) |
| 76 [74] | **SendOrders** | the turn commit — not yet captured |
| 77 [75] | SendInProgressOrders | draft save of orders |
| 78 [76] | SendTerritoryPicks | params: int32 gameId, bool present, int list territoryIds (priority order), bool, bool |
| 79 [77] | SendInProgressPicks | as 76 without the two trailing bools (draft save) |
| 80 [78] | **BeginFirstTurn** | params: int32 gameId — read from the bundle, not verified live; see [Begin first turn](#begin-first-turn) |
| 81 [79] | GetTerritoryPicks | params: int32 gameId, int32 in-game player id; verified for my own id. `warapp_get_team` also asks it with a teammate's id while picking (UNVERIFIED, V6); a refusal reads as unknown |
| 82 [80] | **UnCommit** | params: int32 gameId — see [UnCommit](#uncommit) |
| 83 [81] | GetTurns | |
| 323 [317] | **GetInAppNotifications** | params: int32 start index, int32 page size (the client sends 30); reply `GetInAppNotificationsReturn` — see [Notifications and read marks](#notifications-and-read-marks) (VERIFIED live 2026-11-16, direct transport) |
| 324 [318] | **DeleteInAppNotification** | params: string notification id (decimal text); no result (VERIFIED live 2026-11-16, direct transport) |
| 325 [319] | **AcknowledgeInAppNotifications** | params: optional list of string notification ids (decimal text); no result — marks them read (VERIFIED live 2026-11-16, direct transport) |
| 242 [238] | Subscribe | push channel only, **no auth**; params: bool true, list of topic strings, string null; reply dict topic→int32 error |
| 245 [241] | GameUpdated | server push, **no auth**; msgNum `0x80000000`, 61 bytes: the game id, then bools `chat` and `nonChat` (named by the client's own log line; UNVERIFIED live) and an optional dict — re-read GameFeed |

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
`Ao` float32 · `ak`/`uy` float64 (8 bytes the client reassembles as a double — kill rates, luck, TimeSpans in ms; not an int64) · `Td` datetime · `tL` GUID (16 bytes, .NET order:
3,2,1,0,5,4,7,6,8…15) · `sL` int32-length bytes · `Sd`/`ms`/`uL` int32-count list (-1 = null) ·
`ef` int32-count dict (-1 = null).

**Checked against the bundle at load (#131, #148).** These primitives are built in (`DEFAULT_DIALECT`,
pinned to one client release) and shadow the bundle's own definitions, while the bundle itself
floats. So loading a bundle runs `verifyDialect`: each `P.*` static above is evaluated from the
bundle's own definition on a few probe byte strings and must read the same value, call its item
readers in the same order at the same positions, and read the same number of bytes as the
built-in; a mismatch refuses the bundle (`dialect-mismatch`). Every definition of a name counts:
`P.x=function…`, an alias `P.x=Q.y` (checked as `Q.y`'s definition) and a property of an object
literal assigned to `P` (`P={x:function…}`, or one aliasing a static); all of them must agree.
What that check covers:

- **verified:** a `P.*` static whose bundle definition the interpreter evaluates on the probes and
  that reads alike on at least one probe that shows its reads — for a helper taking item readers
  (a list or dictionary), one on which it read items; a `-1 → null` answer alone does not count.
  A dictionary or collection that builds a client object (`new Je`) is compared by its item reads
  and the bytes consumed, so one that reads the value before the key, or an item twice, is
  **mismatched**.
- **unverified (reported, with a reason):** a definition the interpreter cannot evaluate, one
  assigned in a form the check cannot follow (anything but a function, an alias of a static's
  function, or an object-literal property), and a builder never seen reading an item. On the
  client cached on 2026-11-13: `P.Td` (datetime) and `P.tL` (GUID) cannot be evaluated, and
  `P.ef` and `P.uL` build client collections through methods the interpreter does not run (11
  verified, none mismatched). `P.ef` is how every standing is read, so a swap of its key and value
  reads is caught (it differs on its first item read) but nothing more is proven about it.
- **refused when unverified:** `P.Ya`, `P.Yc` and `P.uq` (`REQUIRED_HELPERS`) read every army
  count, fog flag and unit count; a bundle whose definition of one of them cannot be verified is
  refused (`dialect-unverified`) and, like a mismatch, remembered for five minutes. So is a bundle
  that references one of them (`P.Ya`, `P["Ya"]`) but defines it in a form the scan does not find
  at all (`P["Ya"]=…`, `Object.assign(P,{…})`): for these three, absent from the check is not
  verified.
- **not checked:** the reader methods called on the reader itself (`a.Og()`, `a.Ua()` and the
  rest, the dialect's `readerMethods`), and any other helper given to `P` some other way
  (`Object.assign`, a computed key). A client release that renames or repurposes one of these
  decodes through the old read without an error; suspect them first when a new client misreads a
  reply.

The result is shown (#148): `warapp_session_status` reports the loaded bundle (`decoder`: version,
whether a cached stand-in is decoding, the helpers verified and the unverified ones with why;
absent after a load that failed or was refused, so an earlier bundle is never shown as decoding),
and `warapp_get_live_board` carries the same `decoder` on its full view (on compact only when a
cached stand-in decoded the board).

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
                18 Blockade, 12 Airlift, 14 Diplomacy; UNVERIFIED live: 6 Spy, 13 Gift,
                15 Sanctions, 16 Reconnaissance, 17 Surveillance, 20 Bomb,
                8 Emergency Blockade), card fields,
                GUID cardInstanceId, base
Discard         byte 09, GUID cardInstanceId, base
```

**Order options — from the client bundle, UNVERIFIED live (#165).** The bundle's
`GameOrderAttackTransfer` writer is the layout above; `warapp_submit_turn` sets its options when a
move asks: `mode` 2 (Transfer Only) or 1 (Attack Only), `byPercent` (the count is then the
percentage, 1–100), `attackTeammates`, and the commander as one special unit in `Armies`
(`byte 1` count, then `byte 1` Commander tag, `GUID unitId`, `int32 ownerId` — the GUID and owner as
the live board reads them; a commander alone sends count 0). The server's validator (bundle,
`GameValidateOrders`) refuses byPercent unless `AllowPercentageAttacks` (error 360
`CannotDoPercentageAttackWhenDisabled`), mode 2 unless `AllowTransferOnly` (361), mode 1 unless
`AllowAttackOnly` (362). Golden tests pin the bytes; no commit with an option set has been sent.

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
| Discard | 9 | 10 — from the bundle (`GameOrderDiscard`'s writer: tag 9, GUID, base; its phase is 10); **not yet live-verified** |
| Order Priority | 10 | 12 — played live again 2026-11-16 (card by name, no target, a strike as the first move): committed and resolved; whether my first move ran first cannot be told from the result, so that effect stays UNVERIFIED |
| Reinforcement | 5 | 20 |
| (deploys) | 2 | 25 |
| (attacks/transfers) | 1 | 50 |
| Order Delay | 11 | **50** — placed in phase 12 (with Order Priority) it was refused with error 10 |
| Blockade | 18 | 60 — verified live 2026-11-16 (card by name, target territory by id): the territory turned neutral at the end of the turn at its armies × the game's multiplier |
| Spy, Reconnaissance, Surveillance | 6, 16, 17 | 15 — bundle, **UNVERIFIED live** |
| Airlift | 12 | 43 — bundle, verified live 2026-11-16 (card by name, `from`, `to`, `armies`): the source lost the armies, the target gained them, the card left the hand |
| Gift | 13 | 47 — bundle, **UNVERIFIED live** |
| Diplomacy | 14 | 75 — bundle, verified live 2026-11-18 (card by name, `players`): played through `warapp_submit_turn`, it was in force on the later boards (the planner's cards in effect read it) until the turn expected |
| Sanctions | 15 | 80 — bundle, **UNVERIFIED live** |

Within one phase the encoder writes card plays after the other orders (an Order Delay after
every AttackTransfer): the shape of the 2026-11-12 commit that verified phase 50, and still the
default.

**Order Delay placed among the moves (#186) — accepted live (2026-11-13), ordering effect UNVERIFIED.** A live 1v1 commit with the card `before: 1` was accepted (no error 10), the card left the hand at resolution, and every order ran; whether the later moves waited for the opponent's was not observable (no opponent order touched them, and no tool reads a resolved turn's order list yet). `warapp_submit_turn` takes
`before: <move>` on an Order Delay card order (1-based, counting the moves of the given list in
order; one past the last move, or no `before`, is the default above). The encoder
(`sendOrderSequence`, `beforeMove` 0-based) then writes the card just above that move — after
every deploy, still in phase 50 — e.g. `[deploy, attack, OrderDelay, transfer]`; golden tests pin
the bytes. `warapp_plan_turn` emits it in `orders` (and in `cards.advice.orderDelay` with `before` and the
ready card order) whenever it advises the card. The preview
of a placed card says UNVERIFIED. **Reading the result back** after the first live commit that
uses it: (1) a refusal with error 10 `OrdersInIncorrectOrder` means card plays must close the
phase — nothing is committed, and the tool says to resend without `before`; (2) accepted, the card
leaves the hand (the next turn's `cards.hand`), and in the resolved turn's order list (the game's
replay, the `GameTurn` in `LatestGameInfo`) my moves from the placed one on run after the
opponents' phase-50 orders instead of alternating with them. Then mark this verified and let
`warapp_plan_turn` emit the card.

How the client places it (bundle, read 2026-11-13): `GameOrderPlayCardOrderDelay` writes tag 11,
the card GUID and the order base — **no position or index field** — and `Vd()` (its phase) is 50, the
moves' phase. So the card's place in the order list is its position. The turn executor runs each
phase from per-player queues: a player whose next order is an Order Delay waits while the others'
orders of that phase run, and the Delay cards are taken off only when every player still holding
orders in the phase is at one (or out). So an Order Delay above move *k* holds moves *k*… until the
opponents' attacks/transfers have run; at the end of the list it holds nothing.

What the client bundle says (read 2026-11-13, not live): a new order is inserted after the last
order of its phase or an earlier one, so a freshly played Order Delay lands after every move; the
order list's move-up / move-down buttons swap an order only with a neighbour of the **same** phase,
so a player can raise an Order Delay among the moves but never above the deploys; and
`GameValidateOrders` answers error 10 only when an order's phase is lower than an earlier order's
(orders of one phase may come in any order). So the bundle expects `[deploy, OrderDelay, attack]`
to be accepted — consistent with the 2026-11-12 refusal, which put the card in phase 12 ahead of
the deploys — but no such commit has been sent, so the position stays unverified on the wire.

**Targeted card plays (PLAN-TEAMS part D) — from the client bundle; the Airlift play verified live 2026-11-16 and the Diplomacy play 2026-11-18, the rest UNVERIFIED live (V9).** Each
layout is read from its `warlight.shared.GameOrderPlayCard<X>` class: the writer puts the tag, the
card's own fields, then the base play-card part (the card GUID, then the order base); the class's
phase method gives the phase. Golden tests pin the bytes. An Airlift (card by name, `from`, `to`,
`armies`) was committed live 2026-11-16 and resolved as the layout says: on the next board the source
had lost the armies, the target had gained them, and the card had left the hand. A Diplomacy (card by name,
`players`) was committed live 2026-11-18 and was in force on the later boards — the planner's cards in effect
read it — until the turn expected (#369). A Sanctions was committed once (2026-11-18) but its effect is not
yet checked, so it stays unverified. No commit carrying any other card in this table (Spy, Reconnaissance,
Surveillance, Gift, Bomb, Emergency Blockade) has been sent: those, and Sanctions, stay UNVERIFIED live.

| Card (class) | Tag | Fields after the tag, in write order | Phase |
|---|---|---|---|
| Spy (`…Spy`) | 6 | int32 target player (in-game id; 0 the neutral) | 15 |
| Reconnaissance (`…Reconnaissance`) | 16 | int32 target territory | 15 |
| Surveillance (`…Surveillance`) | 17 | int32 target bonus | 15 |
| Airlift (`…Airlift`) | 12 | bool present + `Armies` (bool fogged, int32 count, byte special-unit count, units — as in an AttackTransfer), int32 from, int32 a legacy count the client leaves 0, int32 to | 43 |
| Gift (`…Gift`) | 13 | int32 recipient player, int32 territory | 47 |
| Diplomacy (`…Diplomacy`) | 14 | int32 player one, int32 player two | 75 |
| Sanctions (`…Sanctions`) | 15 | int32 sanctioned player | 80 |
| Bomb (`…Bomb`) | 20 | int32 target territory | 30 |
| Emergency Blockade (`…Abandon`) | 8 | int32 target territory | 37 |

The bundle's `GameValidateOrders` refuses, and `warapp_submit_turn` refuses up front: Spy on myself or a
teammate (80), a player not playing (79), or the neutral (target 0) unless the game's Spy card has
`CanSpyOnNeutral` (`CardGameSpy`, GameFeed `SpyCard.CanSpyOnNeutral`; 225 otherwise; -1 and -2 are 81); a Gift of a territory
not mine (212), to myself (211), of one territory twice (213), to a player not playing (210), or of a
territory carrying a commander or other special unit (536 — a special unit's "can be gifted" is false for
a commander and the bosses); an Airlift to its own source (184), from a territory not mine (182), to one
neither mine nor a teammate's (183), or carrying a commander or boss to a teammate's territory (537) — the
validator does not check the army count, so an Airlift of the commander alone sends 0 armies (`armies: 0`
with `commander`; 0 without it is ours to refuse); a Diplomacy naming one player twice or two teammates
(214) or a player not playing (381, checked for the first named player and then the second, so either one
out is refused); Sanctions on a
player not playing (219); Surveillance on a bonus worth 0 (224); Reconnaissance on a territory not on the
map (41); a Bomb on a territory whose owner is me or a teammate (526 `CannotBombTeammates`) or none of
whose neighbours (the map's list for the target) is mine (527 `CannotBombNonAdjacent`) — a neutral target
passes; an Emergency Blockade on a territory not mine (95 `AbandonCardMustTargetYourTerritory`) or on one
territory twice (96). Ours, not the validator's: an Emergency Blockade on my commander's territory (it
would be lost with it), or on a territory an Airlift of the same orders leaves or lands on (the wall, phase
37, comes first); Sanctions on myself or a teammate (on an opponent instead when the
game's `SanctionsCard.Percentage` is negative, a boost), more armies airlifted than stand on the source
after the deploys, and a card the game's settings do not put in play. The executor runs an Airlift after
the deploys, so `warapp_submit_turn` takes what it sends off its source's later moves (the armies it lands cannot move again that turn, per the wiki); a Gift runs before
the moves, so a move from the gifted territory does not run (a preview warning); a Gift to an opponent
(not me, not a teammate) gets its own preview line naming the recipient by id as an opponent. The preview warns that
the encoding is unverified, and the result carries `cardPlayCheck`: after the first live commit of each,
read back that the card left the hand and did what it should, then mark it verified here and drop it from
the code's list of unverified plays, `UNVERIFIED_CARD_PLAYS` in `src/protocol/methods.ts` (the targeted plays
are `TARGETED_CARD_PLAYS`). Airlift (#296) and Diplomacy (#369) have left that list: their previews carry no
encoding warning.

**The hold limit (#20).** A play or discard is required only when the hand holds **more** whole
cards than `MaxCardsHold`: live, a commit with no card was accepted at 4/4 and refused with error
51 at 5/4. The bundle's `GameValidateOrders` agrees: it removes every played and discarded
instance from a copy of the hand, then answers 51 while `remaining > MaxCardsHold` — so each card
over the limit needs its own play or discard.

**The hand is the current `GameStanding`'s.** `LatestGameInfo` holds the pending orders, the
current `GameStanding`, the last `GameTurn` and the previous `GameStanding`, and card instances
appear in all of them. Only the current standing's cards are playable: an instance that survives
only in the previous standing or the turn's receive/play orders was already played, and playing
it is refused with error 50 `CardInstanceUnavailable`.

**The cards in effect (PLAN-TEAMS D3) — from the client bundle, UNVERIFIED live.** The current
`GameStanding` also carries `ActiveCards`: a list of `warlight.shared.ActiveCard { Card, ExpiresAfterTurn }`,
`Card` being the `GameOrderPlayCard<X>` play order that started it (Diplomacy: two int32 player ids;
Sanctions: the int32 target; then the base's card GUID and player). ExpiresAfterTurn = the card's
duration + the turn number processed + 1, and an `EndOfTurn` card (Diplomacy, Sanctions) is removed at
the end of the turn that reaches it, so a card in the current standing binds the whole turn being
ordered. `readActiveCards` (`src/cards.ts`) reads them; `src/analysis/cards-in-effect.ts` decides which
the planner may rely on (docs/WARAPP-API.md). A Diplomacy played live 2026-11-18 was read in effect on the
later boards until the turn expected (#369), so the Diplomacy entry has been seen decoding; the decoder as a
whole (Sanctions and the rest) is still marked unverified in `cardsInEffect` until each is checked against the game.

**Teammates' entered orders and picks (C1) — from the client bundle, UNVERIFIED live (V5).** After the
standings, `LatestGameInfo` carries a dict in-game player id → `warlight.shared.TeammateOrders`
`{ int32 stamp, list<GameOrder> orders (a turn), list<int32> picks (while distributing) }`, each list
behind its present flag. The client renders a teammate's picks from the int list when present, else
its orders, and counts the `GameOrderPlayCard*` and `GameOrderDiscard` orders in it against the team's
hand. My own pending orders and picks are separate fields of `LatestGameInfo`. `src/team-orders.ts`
finds the dict by the type name of its values (the reader fills it through a closure, which
`fieldsReadAs` does not follow) and reads each order by its class and read order: `GameOrderDeploy`
(territory, free flag, armies), `GameOrderAttackTransfer` (attack-teammates flag, mode byte, by-percent
flag, from, `Armies`, to), a card play (its own fields, the card GUID; the card from the class name,
`Abandon` being the Emergency Blockade card), `GameOrderDiscard` (the GUID), each then the base
(player, optional result, optional standing updates). An order it cannot read is listed as unread; no
dict, or no entry for a teammate, is unknown — not "nothing entered". Whether war.app fills it before
the teammate commits is the open question (V5). `warapp_get_team` reports it; the planner does not
use it yet.

**An unreadable hand (#130) — unverified.** The hand sits under a per-player entry keyed by the
in-game id. When cards are in play and the current standing has no entry for my id,
`handReadable` is false: `warapp_plan_turn` reports `cards.handReadable: false` with a warning, and
`warapp_submit_turn` warns in its preview, instead of treating the hand as empty. That every
player's entry is sent even with no cards is assumed from the synthetic shape, not checked live.

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

**Unverified: the whole-body rule (#131).** `readLatestGameInfo` refuses a `GetLatestGameInfo` reply
with any bytes left after the `LatestGameInfo` (`LiveBoardFormatError`), on the strength of the
capture above, which was consumed to the last byte. No live reply has been read since the rule
went in: if war.app ever appends trailing bytes to that reply, every live board read fails with
"bytes left unread after the LatestGameInfo". The owner confirms it on the next live board read.

`TerritoryStanding`: territory id, owner, `Armies { count, fogged, specialUnits }`, fog level.
Owner `0` = neutral, `-2` = available to pick, otherwise an in-game player id.
Fog level (`StandingFogLevel`, from the bundle): 1 You, 2 Visible, 3 OwnerOnly, 4 Fogged. The client
refuses a deploy on 3 or 4 as "fogged"; a fully fogged standing is fog level 4, owner `-1`,
`Armies(0, fogged)`. The reader keeps an owner-only territory's owner but not its army count (#69). Whether the owner
shows is read from the fog level alone: a Light Fog owner-only standing carries a real owner under
`Armies(…, fogged)` (#131, seen in a live board's raw standing).

**The army count cannot be misread quietly (#148).** The count is the `Armies` record's one number
(fogged flag, count, units — the client's constructor assigns exactly one, checked on the bundle
cached 2026-11-13). A record carrying two numbers is refused (`LiveBoardFormatError`): nothing
says which is the count. And a board on which every territory of mine (fog level You) reads 0
armies is refused as a misread count; one empty territory of mine among others is a board (a
commander standing alone, or a game without "one army stands guard").

**The current standing, never last turn's (#131, #148).** `LatestGameInfo` carries the current
`GameStanding` and the previous turn's; the current one is the first field its reader fills from
`GameStanding` (`fieldsReadAs`, read from the reader's source). When the reader's source does not
show it (the standings read in another class, through a local closure or an own-class helper the
check does not follow), the board is refused rather than taking the first standing present.

**Special units (from the bundle, #61; the commander layout matches a live standing decoded
for the issue).** `Armies` is read as `bool fogged, int32 count`, then — protocol ≥ 107 — a
`byte` unit count and that many `SpecialUnit`s (count 0 = none); the reader builds it through
its constructor (`new Armies(count, units, fogged)`), so the decoded fields are fogged, count,
units. Each `SpecialUnit` is a `byte` tag, the subclass's own fields, then the shared base
fields `GUID id, int32 ownerId` (in-game id):

| Tag | Class | Own fields before the base |
|---|---|---|
| 1 | `Commander` | none |
| 2 | `Boss1` | int32 health (400 at creation) |
| 3 | `Boss2` | int32 |
| 4 | `Boss3` | int32 |
| 5 | `Boss4` | int32 health |
| 6 | `CustomSpecialUnit` | bool present + int32, string metadata |

Any other tag makes the client throw "Unexpected token". The board reader takes the kind from
the class name and the GUID and owner from the last two fields; a fogged territory's units
are not reported.

**Commander combat (from the bundle, #61; not verified in a live battle).** The `Commander`
class reports attack power and defence power both as `armies + 7`, a combat order of 10000
(it takes damage after every army: "armies protect the commander"), and absorbs damage only
in a whole 7 — less than 7 left over after the armies with it are dead does nothing (the
in-game guide: "Commanders are worth 7 armies … cannot be partially damaged"; losing one
turns its owner's territories neutral and eliminates them). So `d` armies plus a commander
defend exactly as `d + 7` armies, which is what the planner uses
(`COMMANDER_STRENGTH`, `src/analysis/combat.ts`). The planner never carries the commander; a
move sent with `commander: true` (#165) writes it into the order's `Armies` (see Orders).

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
  id, name, map id and state codes.
  **The default is the dashboard's short list (#260, live):** with `{4, 10, 2}` an account in 41
  games (15 running, 7 lobbies) got 10: 7 finished, 2 playing, 1 distributing. From the bundle:
  `warlight.shared.MyGamesFilterType` is `ActiveGames` 0, `ActiveNotEliminated` 1, `YourTurn` 2,
  `All` 3, `Default` 4, `YourTurnOrPendingChat` 5, `ActiveGameOrPendingChat` 7, `Finished` 8 (6
  unused; the client's own labels: "Active games", "All Games", "Finished Games", …), written as a
  byte (`EnumSerialization_MyGamesFilterType`); the count is an int32 (the "most games" — the one
  other client list asks `Finished` with 100 and says "one of the last 100 games you played"); the
  sort is a byte (`EnumSerialization_MyGamesSort`, values unnamed; the default 2, that list 3).
  `MyGamesFilters.get_Default` is `{4, 10, 2}`. The client's GetMyGames writer sends the four
  values after the filters as constants (bool false, int32 0, bool false, bool false): **the
  client never pages GetMyGames**, so there is no start index to send. This server therefore asks
  `{All (3), 100, 2}` and, while a reply fills its count, again with 400 and then 1600
  (`MY_GAMES_WINDOWS`, `src/tools/my-games.ts`); a reply that fills 1600, or a wider read that
  fails, is reported as possibly partial. Golden-pinned (`01 03 64000000 02 00 00000000 00 00`)
  but **UNVERIFIED live**: that `All` lists lobbies and finished games together and that a count
  above 10 is honoured. `MyGamesReturn` also carries an int32 after a bool behind the list (the
  `MyTournamentsReturn` analogue is a total used for paging); it is not read.
- `GetFullProfile` (180): auth, int32 in-game player id. Reply
  `warlight.shared.FullProfileData`: name, level, member-since, per-format records
  (`{Wins, Games, NumTeams, TeamSize}`) and many counters. It also carries the player's
  self-reported location — a scouting tool must not surface it.
- Server errors arrive as envelope kind 5: `{ int32 code, string message }`; the message can
  be a long server stack trace — log the code, show a short message.

## Map details: distribution modes

GameFeed's map names a map's distribution modes (id, name, type) but not the territories each lets a
player start on; the client's map preview (`SinglePlayer?PreviewMap=<id>`) reads them from
`GetMapDetails` (73: no auth block, params int32 map id; reply `warlight.shared.MapDetails`). Traced in
the browser on 2026-11-16 (#328): the preview makes that one call, and the CDN `.map` file it also loads
is drawing data with no mode names.

`MapDetails` reads its modes fourth (of fourteen fields, in read order): an int32-count dict of mode id →
`warlight.shared.DistributionMode` (bool present, then the mode). The mode is read by a byte tag:

- 0 → `NormalDistribution`: bool present + an int32-count list of int32 territory ids, then the base
  fields: a description string, the int32 mode id, the name string.
- 1 → `ScenarioDistribution`: bool present + a dict of uint16 slot → slot name, bool present + a dict of
  int32 territory id → uint16 slot, then the same base fields. Its territories are that dict's keys.

So a normal mode's bytes read: int32 mode id (the dict key), `01 00 01` (present, tag 0, present), int32
count, that many int32 territory ids, `00` (a null description), int32 mode id again, the name — as #328
read them by hand. The client's built-in modes (0 full, -1 random warlords, -2 random cities, -3 custom
scenario) are not in the dict.

`src/map-details.ts` decodes it with the bundle's own readers by type name (`MapDetails`,
`NormalDistribution`, `ScenarioDistribution`; field counts checked, and each mode's own id must equal its
key), and checks every id against the map's territories (one it lacks is dropped, with a warning).
`warapp_get_map` (view `full`, no bonus filter) and `warapp_locate_opponents` (a game whose settings say
`AutomaticTerritoryDistribution` "Automatic" with a `DistributionMode` of the map, and no pickable territories
kept: the mode's territories are its start candidates) ask only when a mode of the map has no territories yet,
at most once per map per process; the territories are kept with the map in the store
(`distributionModes[].territories`, `src/map-store.ts`) and age out with it (carried onto a fresh download
of the same map, they keep the stored copy's `storedAt`; a mode whose stored ids the fresh map does not all
have is not carried, and is read again). A failed read, a mode the
reply lists none for, or one whose every id is dropped, is unknown (`null`), never empty (an empty list is
never kept, and a stored one reads as not read yet). **Verified live 2026-11-16** (normal modes): through the bundle's
readers on a 761-territory map, all seven modes' counts matched the hand-read trace in #328 (79, 32, 24, 80,
12, 18, 63), mode 1's ids exactly, the three starts dealt to the account among them, no id dropped; and
`warapp_locate_opponents` took mode 1's territories less mine as every opponent's start candidates. The
scenario mode (`ScenarioDistribution`) is UNVERIFIED live.

## Chat

Everything below was read from the client bundle. **The chat-only `GameRefresh` read of public
messages is VERIFIED LIVE 2026-11-14** (the owner's play session, at main 5832977, check V4 in
`docs/PLAN-TEAMS.md`): in two games with public chat, `warapp_get_chat`'s web source matched GameFeed
`GetChat=true` message for message — the count, the time (to the second), the turn (field 9 absent
→ `null`, `0` → 0, a later turn as sent), the sender (field 1 is the in-game id: the GameFeed id
`fromId` maps it to, stripped of two digits each end, is GameFeed chat's `playerID`) and channel
public (`-1`); six games with no chat read a count of 0. **Still UNVERIFIED live:** team and
private channels (fields 2, 6 with a team, 7), `mark_seen` and the cursor, `warapp_plan_turn`'s
`chat.unread`, `chatActivity` on a push, and sending (checks V2, V3 and V10).

- **Read (web client):** `GameRefresh` (39): auth, int32 gameId, bool chat, bool nonChat, the public
  and team "last seen" markers as decimal text (a client that has seen nothing sends `"-1"`; the
  client writes `"null"` for none), bool lobby (true while the game waits for players), then two
  optional int32→string dicts (game-group chat views; sent absent). `warapp_get_chat` asks for the
  chat only (`chat` true, `nonChat` false). Reply: bool present, then
  **`warlight.shared.GameDetailsAndChat`**, whose first field is the chat: an optional list of
  optional **`warlight.shared.GameMessage`** (then the game details `GameWL`, a dict, the players,
  the game groups — all optional, absent when `nonChat` is false). `src/chat.ts` reads both by
  type name through the interpreter and takes the message fields by read order:

  | # | Field | Read as |
  |---|---|---|
  | 0 | date | datetime |
  | 1 | sender | optional int32: the in-game player id; absent on a system line |
  | 2 | game group | optional int32: a game-group message (no channel of ours: `unknown`) |
  | 3 | (unknown) | optional int32 |
  | 4 | message id | string, parsed by the client as a long |
  | 5 | text | string |
  | 6 | channel | int32: `-1` public, else the team |
  | 7 | private counterpart | optional int32: the recipient's in-game id; set means a private message |
  | 8 | (unknown) | optional int32 |
  | 9 | turn | optional int32 |

  The client sorts a message into its tabs the same way: a private counterpart first, then a game
  group, then the channel. The bundle's registration of `GameMessage` has a line break right after
  its `=`, so the interpreter's registration scan allows whitespace there.
- **Read (GameFeed):** `GetChat=true` adds a `chat` list of `{ playerID, date, turn, message }`.
  `playerID` there is the **in-game id**, not the check-digit-wrapped id GameFeed uses for players.
  It names no channel or recipient, and whether it returns team or private messages is unknown: a
  message there is `unknown` unless it carries a channel or recipient field. `warapp_get_chat`
  uses it when GameRefresh cannot be read (no signed-in account readable, a refusal, a reply it
  does not understand), and beside it when GameRefresh returns fewer messages (#313: on one finished
  game ended by surrender GameRefresh returned none while GameFeed held the surrender line; why is not
  known — GameRefresh may not carry a finished game's or a surrender turn's messages): GameFeed's list
  stands in when the web read is empty, else its messages no web message matches (sender, time within a
  second) are added as `unknown` (the result's `source` stays `web`, flagged `filledFromGamefeed`, #321); `warapp_plan_turn` counts unread chat from it (the game read carries it).
- **Send:** `SendChat` (42): auth, int32 gameId, string text, int32 channel (`-1` = public,
  otherwise the sender's team: the client sends its own player's team), optional int32 private
  recipient (the client then sends channel `-1`; server error 201 is "cannot specify team in a
  private message"), optional int32 game-group id, two marker strings (the last message seen on
  each channel, `-1` for none: war.app parses them as numbers, and null markers are refused with
  server error 1, `ParseLongSafe(null)`, seen live 2026-11-19), two optional "last seen"
  dicts. With `-1` markers a team-channel send was verified live on 2026-11-19: the message shows in
  the game's Team tab in the official app. The channel value (my team, read from GameFeed) is right.
  The same game's `GameRefresh` read, during territory picks, returned no messages at all, so that
  read missed it. Reply: bool present, then the updated message list straight after it (no second flag),
  each a present flag and a `GameMessage`. `warapp_send_chat` reads it back: `confirmed` when my
  newest message on that channel has the text sent, `unconfirmed` when it is another, `accepted`
  when the reply cannot be read. Server errors the client names: 36 rate-limited, 33 too long,
  88 game deleted, 333 game archived, 17 not in the game, 202 private messaging disabled. A send
  reaches other people, so it is always confirm-gated, and a refusal is never retried.
- **Marking chat read:** 43 RegisterChatView — see [Notifications and read marks](#notifications-and-read-marks).
- **Other chat methods** (not used): 44 RetrieveChat (gameId and the two
  markers), 45 RetrievePrivateMessageHistory, 46 RetrieveGameGroupMessageHistory. Push 242
  `ChatRoomNewMessage` is the site's chat rooms, not a game's chat.
- **Push:** `GameUpdated` (245 in 243, 241 in 242) carries, after the game id, two bools the client's handler logs as
  `chat=` and `nonChat=`. `src/push/socketio.ts` reads the first when present: a push with it set is
  chat activity (`warapp_wait_for_turn` reports `chatActivity: true` for the game, no text), and
  the game is re-read as for any push.

## Notifications and read marks

**Read from the client bundle (cached client `v6.07.0.1`, 2026-11-16, issue #311); UNVERIFIED live.**
Nothing here has been sent to war.app yet. Each method goes through `WarappRpc` like every other one,
with the auth block first; field orders are the client writers' and readers' read order.

### In-app notifications (the client's "In App Notifications" screen)

- **List: `GetInAppNotifications` (317)**, `POST /Services?m=GetInAppNotifications&js=1`. After the auth
  block:
  1. `int32` start index — the paging offset (the first page is 0);
  2. `int32` page size — the client always sends 30.

  Reply: a present flag, then **`warlight.shared.GetInAppNotificationsReturn`**:
  1. an optional list (present flag, int32 count) of optional **`warlight.shared.InAppNotification`**
     (each a present flag, then the record);
  2. `int32` the total number of notifications (the client's pager uses it with the page size).

  `InAppNotification`, 7 fields in read order (0-based):

  | # | Field | Read as |
  |---|---|---|
  | 0 | sent | datetime (the screen shows it as "Sent …") |
  | 1 | data | string: a JSON object the client parses for the detail view — `Body`, a `Url` with `UrlText`, or `Urls` (each `Url`, `Label`, `Color`, `Icon`), and sometimes a `NotificationQuestion` (a group invite or a poll) |
  | 2 | id | string the client parses as a number (a long; the client holds it as a double) — the id the delete and acknowledge calls send back |
  | 3 | (unknown) | int32 — the client never reads it |
  | 4 | (unknown) | string — the client never reads it |
  | 5 | title | string: the one line the list shows per notification |
  | 6 | unread | bool: the list highlights the row while it is set |

  The client orders the page by the sent date. The `data` JSON is third-party-shaped
  text: anything a tool shows from it must go through `untrustedText`/`untrustedBody`, and a
  `NotificationQuestion` answer (method 335, `NotificationQuestionResponse`) or a group join is out of scope.
- **Mark read: `AcknowledgeInAppNotifications` (319)**, `POST /Services?m=AcknowledgeInAppNotifications&js=1`.
  After the auth block: an optional list — present flag, `int32` count, then each id as a string
  (present flag + decimal text; the client writes `"null"` for none). The client sends it when a
  notification whose unread flag is set is opened, with a one-element list. **No result payload**,
  so success can only be read back from a later `GetInAppNotifications` (the unread flag cleared).
  The client throws on any error.
- **Delete: `DeleteInAppNotification` (318)**, `POST /Services?m=DeleteInAppNotification&js=1`. After
  the auth block: one string, the id as decimal text. **No result payload.** The client treats
  server error **699** `InAppNotificationKeyNotFound` as already deleted and throws on any other.
  Deleting is not marking read: marking read needs only 319.
- **How this server uses them (#311, VERIFIED live 2026-11-16, direct transport):** `warapp_get_notifications` sends 317 (start index, 30)
  and decodes the reply by type name (`src/notifications.ts`: the record must have its 7 fields; the interpreter
  hands the id back as the decimal text it parsed). It reports ids, the sent time and the unread flag, a `gameId`
  taken from a war.app link (`Url`, else the first of `Urls`, with `GameID=`) in the data JSON, and a kind:
  `game-ended` only when the title has the client's own wording, `Game "<name>" has ended. You can now view its
  history` (from an owner's screenshot, 2026-11-16; matched on that structure, anchored at `Game "` and
  `" has ended.`), else `other`. Field 4, a string the client never reads, is unverified free text: it is neither
  reported nor used to classify. The title and the body are never passed on. `warapp_dismiss_notification` sends
  319 with the unread ids the list holds and reads the effect back by listing again (at most 5 pages): an id read
  back read, or seen gone (the pages cover the whole list, or reach past where it stood by as many as the list
  grew), confirms it; an id not found otherwise is "not seen in the pages read", `unconfirmed`.
  `warapp_delete_notification` sends 318 once per listed id, in order, never retried: 699 counts as already gone,
  any other refusal stops the rest (an error when nothing was deleted yet), no answer stops too (`unknown`, not
  read back). It reads the effect back by the same listing: deleted once seen gone, else `unconfirmed`.
- **The unread badge** comes with every reply: `warlight.shared.MessageExtrasDown`'s last optional
  field is **`warlight.shared.UnreadMailCheckResults`** — `bool`, `datetime`, `bool` (`src/protocol/codec.ts`
  already decodes it as `unreadMail`). The datetime is what the next request echoes as
  `MessageExtrasUp`'s last-notification time (`kFa`). The client keeps both bools (which one is mail and
  which is notifications is not named in the bundle) and, when it opens the notifications screen,
  clears both locally if either is set; that clearing sends nothing.

### Marking a game's chat read

- **`RegisterChatView` (43)**, `POST /Services?m=RegisterChatView&js=1`. After the auth block:
  1. `int32` game id;
  2. string — the **public** mark: the highest public message id seen, as decimal text (present
     flag + text);
  3. string — the **team** mark, the same for the team channel;
  4. an optional dict (present flag, `int32` count, then `int32` key, string value…): per private
     conversation, the counterpart's in-game id → the highest private message id seen;
  5. an optional dict, the same per game group: game-group id → the highest message id seen.

  **No result payload.** A mark is a `GameMessage` message id (field 4 of [Chat](#chat)'s table).
  The client keeps, per channel, the highest id it has received and the highest it has shown while
  that tab was open (its `HighestPublicChatIDSeen` / `HighestTeamChatIDSeen`), and sends 43 whenever a
  shown mark passes the one it last registered — only while the account is a player in the game.
  When it marks only a private conversation or a game group it sends `-1` for both channel marks,
  which suggests `-1` leaves a channel's mark alone (UNVERIFIED). These are the same markers
  `GameRefresh` (39) takes as its "last seen" strings. So marking a channel read is: read the chat,
  take the newest message id on that channel, send it as that channel's mark (others `-1` or
  absent), then read back.
- **Where the read state shows: `GetMyGames` (50)**, per game in `warlight.shared.GameInfo` (27 fields,
  0-based read positions, the same numbering as `src/my-games.ts`), four bools the dashboard prints as
  "Unread … messages":

  | # | Flag |
  |---|---|
  | 8 | unread group (game-group) messages |
  | 17 | unread private messages |
  | 18 | unread public chat messages |
  | 23 | unread team chat messages |

  The open-games payload carries the same record, and a `GameInfo` the client builds for itself
  sets all four false. They are the read-back for `RegisterChatView`: after a mark, the game's
  flag for that channel should read false (UNVERIFIED live). `MyGamesFilterType` 5
  (`YourTurnOrPendingChat`) and 7 (`ActiveGameOrPendingChat`) presumably filter on the same state.
- **How this server uses them (#311, VERIFIED live 2026-11-16, direct transport):** `warapp_mark_chat_read` (confirm-gated) sends 43
  (`writeRegisterChatViewParams`, golden-pinned) for one game, only from a web read (GameFeed gives no message ids)
  with the signed-in account known: per channel marked, the
  highest message id among the messages read, mine included (`chatViewMarks`); a private conversation is keyed by
  its counterpart (the recipient of a message I sent, else its sender — field 7 of `GameMessage` is the
  recipient); a game group (this server's `unknown` channel from the web read) by its group id; a channel not
  marked goes as `-1`, an empty dict as absent. The effect is read back from `GetMyGames` (the four flags above,
  `RawMyGame.unreadChat`): `read` (`confirmed`) when every marked channel's flag is clear, else `unconfirmed`; no
  answer is `unknown` and is never resent; a refusal is an error (nothing changed). It refuses a game its list
  already shows read. It reaches no other player and posts nothing. **Limit (#313):** when GameRefresh answers with
  no message while GameFeed's chat holds some (seen on a finished game ended by surrender), there is no message id
  to send — GameFeed's messages carry none — so the tool refuses, saying the web read returned no messages and how
  many GameFeed holds; a retry from a fresh tab reads the same. Whether war.app's own client can clear such a
  game's unread flags is unknown. `mark_seen: true` on `warapp_get_chat` and
  `warapp_chat_inbox` marks only this machine's cursor and sends nothing to war.app. The inbox lists a finished game
  when one of its flags is set, or when its flags do not read as booleans (a misread position must not hide its
  chat; the answer's `finishedUnflagged` counts those, read unjudged).

## Open games

**The list is a page payload, not a `/Services` call** (verified live 2026-11-12). A signed-in
`GET https://war.app/MultiPlayer/OpenGames` — the direct transport's cookie or the bridge's page
fetch, so no browser is needed once a session is linked — returns HTML holding
`<script type="text/plain" id="AllOpenGamesData">…</script>`: the payload as **uppercase hex**
(~68 KB for ~75 games). The client hex-decodes it into a reader and reads an **int32 count**, then
that many **`warlight.shared.GameInfo`** records, each with the bundle's registered reader for that
type (no present flag before each record). `src/open-games.ts` does the same through the
interpreter (`ClassReader.readClass`). `GetOpenGames` (10) exists in the method table but the web
client never calls it.

`GameInfo` fields are minified, so they are identified by read order and checked by type, never by
name: random-teams size, entry fee and prize (coins), boot time (a float64 TimeSpan in ms), game id,
map id, the mega-game player cap, name, the open seats, the players
(`warlight.shared.GameInfoPlayer`: an optional `GameColor` first, the in-game player id 7th, the
player state 8th and the team 9th), a real-time flag, and a
`warlight.shared.GameInfoSettings` record (distribution — custom scenario included — commanders,
commerce, kill rates, local deployments, luck, wastelands, army cap, ranked, the move order, and a
settings string whose fields carry the card ids and a mods marker). The move order is the 17th field
(a `MoveOrderEnum` byte: 0 Random, 1 Cycle, 2 NoLuckCycle — read from the bundle, where the record is
built from the game settings' move order, not verified live, #132); `NoLuckCycle` is listed as a
speed first turn in `rules` and `plannerGaps`. The record carries no fog level and no neutral
sizes: `warapp_join_game` reads those from the lobby's GameFeed settings for its screen. The plan expected the open seats as
`warlight.shared.GameOpenSeat` records; inside `GameInfo` they read as a plain int32 list with one
**team per open seat** (`-1` = no team), and that team is what a join sends. With open seats on several
teams the client asks which team to join and sends the chosen one in the same int32 (`warapp_join_game`'s
`team`, C4 of docs/PLAN-TEAMS.md: read from the bundle 2026-11-15, UNVERIFIED live). `GameInfoPlayer`'s 5th
field is the client's IsAI (the record is built from `GamePlayer.get_IsAI` there; read from the bundle, not
verified live): the join preview names each seat on the chosen team `human` or `ai`. Anything the reader
cannot place is omitted, never guessed. Each `GameInfo`, `GameInfoPlayer` and `GameInfoSettings`
must have exactly the client's field count (27, 10 and 24, read from the bundle 2026-11-14; GetMyGames
checks the same counts): a field inserted or dropped would shift every position, so it fails with a
typed `OpenGamesFormatError` (`MyGamesFormatError` for GetMyGames), never a silently wrong list (#133).
A record whose positions do not hold their types is skipped and a payload that stops decoding keeps
what was read. A missing tag or bad hex is an empty list with a note.

**Team games** (verified from the bundle; the live "…-Teams V4" lobby that read as no-team is not
yet explained). The client's own "Team Game" test, the one behind its settings icon, uses exactly
three signals of `GameInfo`: the random-teams size (first field) above zero, **any** player record
carrying a team other than `-1` (whatever its state — declined and removed players count), or any
open seat carrying one. There is no other team field: neither `GameInfo` nor `GameInfoSettings`
has a teams-per-game or team-size field besides the random-teams size. A random-teams lobby's seats
carry `-1` until the game starts, so the random-teams size is what marks it. `src/open-games.ts`
applies the same test (it used to skip declined players' teams).

**Already joined.** `warapp_list_open_games` marks `joined: true` on a lobby where the signed-in
account (its invite token, minus the check digits — as every live tool finds "me") holds a seat
(a player record with its in-game id that is not invited, declined or removed — the one test in
`src/player-states.ts`, shared with the join read-back and the game profile); `warapp_join_game`
refuses such a lobby up front. A seat kept for an invited player is no player yet but counts in the
lobby's `seats`.

The page hides games the account fails the prerequisites for and says so in its text
("N games are being hidden due to prerequisites"); that count is reported when present.

**Joining is `AcceptOpenSeat` (61)**, `POST /Services?m=AcceptOpenSeat&js=1` through `WarappRpc`
like every other method. Parameters after the auth block, in the client writer's order:

1. `int32` game id;
2. the colour: a present flag, then a `warlight.shared.GameColor` record — **required**: sent
   absent, war.app refuses the join with server error 1, `AssertFailedException: color is null`
   (**verified live**, 2026-11-12). The record is a single `int32` colour index (the writer writes one
   `int32`; the 436-colour range, 0–435, comes from the bundle's colour-count getter); 0–23 are the standard colours, the rest need an unlock;
3. `int32` team — the open seat's team from the `GameInfo` record (`-1` in a no-team game);
4. an optional `int32` start slot (present flag + value) — sent **absent**; custom-scenario games
   need one, so they are refused;
5. a `bool` the client sets when one of the game's mods hooks the join — sent `false`, so mod
   games are refused.

The reply is `warlight.shared.AcceptOpenSeatReturn`: a present flag, a "vacation ended" bool and an
optional `int32` game id (what war.app means by that id is unverified). The reply is not proof of
the join: `warapp_join_game` reports `joined` only when GameFeed (or `GetMyGames`) then lists the
account in the game. Error codes the client handles on a join, with its wording: **254** your slot
was assigned to someone else by the game creator, **473** not enough coins, **750** the slot you
joined is no longer available (these three are in the RPC error table); also 4 already begun,
7 removed by the host, 15 full, 120 seat no longer available, 227 on the creator's block list,
239 prerequisites not met, and **121** already in the game (the client treats it as joined).
The encoder is pinned by a golden test built from synthetic ids. The client also handles 8, 75 and
390 ("That color is not available. Please pick a different color"), and 88 (the game was deleted).
Error 1 with "color is null" is named as a missing colour.

**Which colour** (verified from the bundle). Before joining, the web client resolves a colour: the
account's **preferred** colour if no player record in the lobby has it, else its **secondary**
colour on the same condition, else it asks the player to pick from the colours still free (the
standard colours 0–23 that no lobby player holds, plus unlocked ones). `warapp_join_game` does the
same without the prompt: preferred, else secondary, else the lowest standard colour no lobby
player holds — or the `color` index the caller passes (refused when a lobby player holds it). The
lobby players' colours are the `GameColor` of each `GameInfoPlayer` in the open-games payload.

**Where the account's colours come from** (verified from the bundle; not yet seen in a live
page). Every page that runs the client starts it with its startup parameters,
`warlight.shared.InitParameters`, passed to the client's init function as one string of two
characters per byte: each character minus 62 (`>`) is a nibble, the first carrying the byte's
even bits (0, 2, 4, 6) and the second its odd bits (1, 3, 5, 7). Among the parameters is the
signed-in `warlight.shared.Player` record, whose two `GameColor` fields are the colours: the 19th
field in read order is the **secondary** colour, the 33rd the **preferred** (each optional). The
parameters also carry the session's auth string, so only those two fields are read out.
`src/join-color.ts` scans the OpenGames page (already fetched for the list) for runs of that
alphabet, decodes them with the bundle's InitParameters reader, and falls back to a free standard
colour when none reads (the client, or the page, changed). The same Player record is what the
client's `SignIn` (66) refresh returns; that method is not used.

## Surrender

**Verified live 2026-11-12 (issue #30).** Surrendering — and taking back a pending surrender — is
`Surrender` (67), `POST /Services?m=Surrender&js=1` through `WarappRpc` like every other method.
Parameters after the auth block, in the client writer's order:

1. `int32` game id;
2. `bool` surrender — `true` surrenders, `false` takes back a pending surrender;
3. the per-method trailing `bool`, the same "ends vacation" flag `AcceptOpenSeat` sends — sent
   `false`.

There is **no result payload** on success, so the reply proves nothing about the account's state:
`warapp_surrender` re-reads GameFeed afterwards and reports what the feed shows (surrendered,
pending, still playing after an undo — GameFeed has no pending-surrender state, so a take-back is never confirmed — or unchanged). A transport failure after the send is reported as unknown — the
surrender may already have gone through — and is never retried. Error codes, with the client's
meaning: **4** the game is over; **7** and **230** you are no longer in the game.

**In a game of more than two players a surrender is not immediate.** It waits for the others to
accept it (the client marks it as pending; accepting is `AcceptSurrender`, 68: see [Accepting a surrender](#accepting-a-surrender)): the player stays
`Playing` in GameFeed until then, so the tool reports `pending`, not surrendered, and a pending
surrender is what `surrender = false` takes back. With two players a surrender ends the game at once
(GameFeed shows `SurrenderAccepted`), so there is nothing to take back. The encoder is pinned by a
golden test built from synthetic ids.

## Accepting a surrender

**Read from the client bundle, UNVERIFIED live (#317).** Where a pending surrender lives, how the
client decides that my acceptance is owed, and how it sends one. Nothing here has been checked
against a live game yet.

**Where a pending surrender is represented.** Only in the game details: `warlight.shared.GameWL`
(the second field of GameRefresh's `GameDetailsAndChat` reply, and the whole reply of
`GetGameDetails`, 38). Its eighth field, in read order (index 7), is the players: an optional dict
of int32 → `warlight.shared.GamePlayer`. A `GamePlayer` record has 36 fields; the ones that matter
here, by read-order index:

| Index | Type | Meaning (the client's own names) |
|---|---|---|
| 0 | optional int32 | the AI id; present means the seat is an AI (`IsAI`) |
| 14 | bool | `HumanTurnedIntoAI` |
| 20 | optional int32 | the in-game player id (`ID`; when absent, the AI id stands in) |
| 21 | optional dict int32 → date | `PlayersAcceptedMySurrender`: the in-game ids that accepted this player's surrender, each with the time it did |
| 28 | GamePlayerState | the seat's state (2 `Playing`, 7 `SurrenderAccepted`, …) |
| 29 | bool | `Surrendered`: the player has asked to surrender and it is still pending |
| 30 | int32 | the team |

Neither `GetMyGames`' `GameInfoPlayer` nor `GetLatestGameInfo`'s `LatestGameInfo` carries any
surrender field, and GameFeed keeps the player `Playing` with no pending state, so the game details
are the only source. (In the client's writer `GetGameDetails` sends no auth block, just the int32
game id; this server does not call it — GameRefresh, already used for chat, carries the same record.)

**How this server reads it (#317).** GameRefresh with `chat = false`, `nonChat = true` (one request per
game; the chat is not asked). `GameWL` has 14 fields in read order. The client's `GamePlayer` reader, when
called inside a game, first sets a link back to the game being built, so the decoded record carries that
game as an extra first value: it is dropped before the 36 fields are counted. Any count or type that does
not match reads as unknown (`null` in the tools), never as "no surrender pending". Checked offline only: a
synthetic frame in this layout decodes through the cached real bundle's readers; no live reply has been
read. `warapp_wait_for_turn` reads it at every check; once one read fails in a wait (a frozen tab times
out every bridged POST) it is not asked again in that wait.

**When my acceptance is owed.** The client asks whether to accept that player's surrender when all of
these hold: the game is not `InstantSurrender`; my seat is `Playing` and not turned into an AI; the
other player's seat is `Playing` with `Surrendered` set; and my in-game id is not in that player's
`PlayersAcceptedMySurrender`. (Dismissing that question is remembered in the browser only, per game and
player.) Each such player also gets an accept button, which becomes a take-back button once my id is in
the dict; the client asks for confirmation either way.

**When the server grants it.** The pending surrender goes through once every other seat that is
`Playing` and neither an AI nor a human turned into an AI has accepted it (with `InstantSurrender`
it goes through at once). The seat then becomes `SurrenderAccepted` (7) — or, when the game's
`SurrenderedPlayersTurnIntoAIs` is on and the player is not already an AI, it is handed to an AI.

**The send.** `AcceptSurrender` (68), `POST /Services?m=AcceptSurrender&js=1` through `WarappRpc`.
Parameters after the auth block, in the client writer's order:

1. `int32` game id;
2. `int32` the in-game id of the player whose surrender is accepted;
3. `bool` accept — `true` accepts, `false` takes back an acceptance (the take-back button);
4. the per-method `bool` the client sets when one of the game's mods hooks this method — sent
   `false`.

There is **no result payload** on success: the outcome must be read back from the game details
(my id in the dict, or the seat no longer `Playing`), never from the reply. Error codes, by what
each means (our wording): **4** the game has ended; **186** (`CannotAcceptSurrenderOfPlayerNotSurrendered`)
that player has withdrawn its surrender; **7** one of the two seats has left the game; **230** my own
seat is no longer taking part. The encoder (`writeAcceptSurrenderParams`) is pinned by a golden
test built from synthetic ids.

**How this server sends it (#317).** `warapp_accept_surrender`, confirm-gated, sends accept = `true` only
(it never takes an acceptance back). Before sending it reads the game details and refuses unless that
player's surrender is pending and my acceptance is owed by the test above. After sending it reads GameFeed
(the seat `SurrenderAccepted`, handed to an AI, or the game over: `accepted`) and the game details again (my
id in `PlayersAcceptedMySurrender` with the surrender still pending: `pending`, others still owe theirs);
anything else is `unconfirmed`, and no answer is `unknown`. Nothing is resent.

## Begin first turn

**Read from the client bundle, not verified live (issue #44).** In a game whose move order is
`NoLuckCycle` ("No-luck cycle") the first turn is a speed race: "the players who enter orders for
the first turn the fastest will move first in the move cycle" (with manual distribution: the
players who pick fastest get their picks in a conflict). war.app withholds the player's standing
— `GetLatestGameInfo` carries none — until they press **Begin**, and Begin starts their turn
timer. The client shows Begin whenever a `Playing` seat has no standing; GameFeed names the
setting as `MoveOrder` (`Random`, `Cycle` or `NoLuckCycle`).

Begin is `BeginFirstTurn` (78), `POST /Services?m=BeginFirstTurn&js=1` through `WarappRpc`.
Parameters after the auth block, in the client writer's order:

1. `int32` game id — and nothing else (no trailing bools).

The reply is a present flag then the player's `GameStanding` (the client installs it as the
latest standing). The client ignores server error **4** and refreshes as on success; any other
error is thrown. `warapp_begin_turn` (confirm-gated) refuses games past turn 1, games whose move
order is known and not `NoLuckCycle`, seats not `Playing`, and games whose board is already
visible; after the send it reads the board back with `GetLatestGameInfo` and reports `begun` only
when a standing arrives (`unconfirmed` otherwise; after an error 4 with the board read back and
still hidden, `not_begun` — what error 4 means is unverified, so the board alone decides; a read-back
that fails stays `unconfirmed`, since nothing was read; a transport failure is `unknown` and never
retried). The encoder is pinned by a golden test built from synthetic ids; the owner verifies it
live.

## UnCommit

**Read from the client bundle's writer; not yet verified live.** Withdrawing committed orders for
the current turn (the client's "Modify orders") is `UnCommit` (80),
`POST /Services?m=UnCommit&js=1` through `WarappRpc`. After the auth block the writer sends only:

1. `int32` game id.

No trailing bools (unlike `Surrender`), and **no result payload** on success: the client keeps the
orders it had and re-opens them for editing itself, so nothing about the account's state comes back.
`warapp_uncommit_turn` refuses outside a turn phase and when GameFeed's `hasCommittedOrders` is false,
then re-reads GameFeed after sending and reports `uncommitted` (the flag cleared on the same turn) or
`unconfirmed` (still committed, the turn already resolved, or the feed could not be read). A transport
failure is `unknown` — the withdrawal may have gone through — and is never retried. The client warns
that modifying orders close to the boot timer risks a boot, since the game waits on the player again.
Error codes, with the client's meaning: **99** the other players committed first and the turn is
advancing; **4** the game is over; **7** and **230** you are no longer active in the game. The
encoder is pinned by a golden test built from synthetic ids.

## DeclineGame (leaving a lobby)

**Verified live 2026-11-14** (read from the client bundle's writer): `warapp_leave_game` left a 36-seat lobby joined through an open seat — `{status: left, outcome: confirmed}`, and GameFeed then answered that game id with "This API can only be used for games you are in…" (which the tool takes as confirmation). Not yet checked: a seat taken by invitation, and a hosted (bridge) run. The lobby's Decline button (`LobbyVM`)
sends `DeclineGame` (64), `POST /Services?m=DeclineGame&js=1` through `WarappRpc`. It is enabled for
a seat that is `Invited` or `Playing` in a game still `WaitingForPlayers` (not for ladder or
tournament games), so it is both "decline an invitation" and "leave a game I joined". After the
auth block the writer sends:

1. `int32` game id.
2. `bool` — set when one of the game's mods hooks this method (the same per-method flag as
   `AcceptOpenSeat`'s last bool); sent `false`, and mod games are refused.

The reply is **one bool** (no present flag): when true the client says "Since you left the game, all
chat messages that you sent to this game were removed." It is not a success signal.
`warapp_leave_game` refuses a game that is not `WaitingForPlayers` (a started game is surrendered),
a seat the account does not hold (absent, invited or declined) and a game whose GameFeed settings
name mods; after sending it reports `left` only once GameFeed shows the account without a seat
(declined, or no longer listed) — else, when GameFeed cannot be read, once `GetMyGames` lists the
game with the account's seat given up (a game missing from that list proves nothing: it may be partial) — and
`unconfirmed` otherwise. A transport failure is `unknown` and is never retried. In a team game the
client first warns that declining leaves the teammates a player short; the preview says so.
Error codes, with the client's handling: **191** `CannotDeclineYourOwnOpenGame` (delete it
instead); **88** the game was deleted; **17** `NotInGame`, **4** and **7** `InvalidPlayerState` are
swallowed by the client. The tool reads back after 17, 4 and 7 (the seat may already be gone) rather than guessing a
wording for them. The encoder is pinned by a golden test built from synthetic ids.

## Push channel (socket.io)

Turn notifications arrive on war.app's **socket.io v0.9** channel. Two transports are advertised
and both are used: **xhr-polling** (plain HTTP, so it rides the browser bridge —
`src/push/socketio.ts`) and **websocket** (chrome-less, with the linked `AuthToken` cookie —
`src/push/websocket.ts`, used while the direct leg is active). Both verified live.

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
no auth) with message number `0x80000000`, 61 bytes, that **starts with the game id**; the bools
after it are the chat and non-chat flags (see [Chat](#chat), UNVERIFIED live). On receipt, re-read the game from GameFeed — it arrives within ~1 s of the turn
resolving. `src/push/listener.ts` holds one socket per process, (re)subscribes to every watched
`Game.<id>` on each connect, answers heartbeats, and reconnects with backoff. A Subscribe that fails
(not sent, or answered with a server error) is retried on the same session; when the retry goes
through, consumers are told to re-read GameFeed too, since a turn that resolved before it sent no
push. A game is watched only while a wait holds it and only after the wait has checked the account
plays in it; no Unsubscribe is sent, so a released game stays subscribed until the session ends but
is not re-subscribed, and a push for it (or for any game no wait watches) is ignored, not recorded
(#148). When the retries on a session run out (five) with games still unsubscribed, the listener
starts a new session itself rather than leave them unwatched until war.app drops the socket (#148).
Two waits on one game: the second's `watch` waits for a Subscribe the first has in flight, or sees
one that went through after it started reading (`mark`), and re-reads (#148). Over xhr-polling, a
poll answered at once with nothing to say — an empty body, a noop, a heartbeat — is paced (doubling
from the initial backoff, capped at 5 s), so a push is at most a few seconds late.

### WebSocket transport (verified live 2026-11-12, GitHub issue #32)

**Handshake.** The same `GET https://war.app/socket.io/1/?t=<ms>`, sent with the
`Cookie: AuthToken=<token>` header instead of through the browser → `sid:heartbeat:close:transports`,
whose transports include `websocket`.

**Socket.** `wss://war.app/socket.io/1/websocket/<sid>` with the same `Cookie` header (Node's
built-in `WebSocket` accepts a `headers` option). The server opens with `1::`.

**Subscribe / heartbeat / push.** `3:::<UPPERCASE HEX Subscribe frame>` — the same method-238 frame
as over xhr-polling — is acknowledged with a 238 reply. `2::` heartbeats must be answered with
`2::`. Pushes arrive as `3:::<hex>`, method **241 `GameUpdated`** with the game id, within ~1 s.

**Reconnect.** The server once closed a healthy socket after ~60 s; a reconnect (new handshake,
new sid, re-subscribe) restored it. **Pushes sent during the gap are lost**, so after any
reconnect a consumer must re-read GameFeed — `warapp_wait_for_turn` re-checks every watched game.
The client treats a close, an error or a missed heartbeat (the handshake's heartbeat timeout) as a
disconnect. If the handshake or upgrade fails (no session linked, signed out, `websocket` not
offered) it falls back to xhr-polling over the bridge.

## Protocol 243 (client 6.08)

Read from client `v6.08.0.2` (bundle 639304508939095333) against `v6.07.0.1` (protocol 242) on
2026-11-17 (#340): every class's reader and writer compared after renaming every minified name to its order of
appearance, so only real layout changes show.

- **Header:** version 243 (`F3 00` / `F3 80`). `MessageExtrasUp` and `MessageExtrasDown` are unchanged; the
  client string is `v6.08.0.2`.
- **Method ids:** renumbered (the [Methods](#methods-from-warlightsharedmessagesmessagetype) table).
- **Requests:** `GameRefresh` gained a last optional value (a nullable number written as text) and `SendChat`
  a last optional list of strings (the shared images a message carries); this server sends both absent.
  Every other request this server sends (orders and every card play, picks, RegisterChatView, the
  notification calls, join and leave, surrender and accept, begin, uncommit, GetMyGames' filters, Subscribe)
  is written exactly as in 242.
- **Replies:** `GameMessage` has 12 fields: date, sender, game group, an optional int, the id, **the shared
  images (optional list of strings)**, the text, **the reactions (optional list of `MessageReaction`: an
  id, a reaction name, a nested value)**, the channel, the private counterpart, an optional int, the turn.
  `GameDetailsAndChat` gained a string after the game and a dict of reactions after its list;
  `GamePlayer` has 37 fields (an int32 inserted at 31; the fields read for surrenders, 0, 14, 20, 21, 28
  and 29, did not move). The board (`LatestGameInfo`, `GameStanding`, territories, armies, special units,
  cards), `GameInfo`/`GameInfoPlayer`, `InAppNotification`, `MapDetails` and `GameWL` read as in 242.
- **Pushes:** `GameUpdated` is 245 and reads as in 242; Subscribe is 242.
- **Live, read-only (2026-11-17, direct transport):** boards decoded on 243 matched the 242 decode of the same
  turn territory for territory (131 and 2,770 territories); my games, the game details' surrender read, the
  notifications and the chat inbox read; the push socket connected and subscribed. Not seen live on 243: a
  web chat message (none of the games read had one on the channels GameRefresh returns), a push, and every
  write.

## Commerce games (#332)

In a commerce game players earn **gold**, not armies, and spend it on armies and (where the game allows) cities.
Everything here was read from the client bundle (client 6.08.0.2, by stable type name; nothing quoted, nothing
run) and, where marked, checked live on two commerce games on 2026-11-17 (direct transport).

**Settings (VERIFIED live).** GameFeed's `settings.Commerce` object, `{}` in every plain game:

| Key | Meaning |
|---|---|
| `ArmyCostMultiplier` | the army price (below); `0` = one gold per army |
| `CityBaseCost` | the first city's cost; absent when the game allows no cities |
| `TerritoryCityCostIncrease` | added per city already on that territory |
| `GlobalCityCostIncrease` | added per city I already own anywhere, and per earlier city in the same order |
| `CityIncome` | gold each city pays per turn |

One game sent only `{ ArmyCostMultiplier: 0 }`; one with cities sent all five (`0, 5, 1, 0, 1`).

**The army price (from the bundle; the multiplier-0 case VERIFIED live).** `GameSettings` holds both directions:
with multiplier `m = 0` an army costs 1 gold. With `m > 0` armies are bought in batches of `m` each turn, the first
batch at 1 gold each, the next at 2 each, and so on: gold → armies walks the batches while the gold lasts; armies →
gold is `Σ price × min(m, rest)`. The client's own guide text says the same ("the first army you purchase each turn
costs 1 gold, and then the next … 2 gold" for `m = 1`). A turn-1 deploy of 25 armies with 25 gold and `m = 0`
committed live.

**A deploy is the purchase.** "Armies are automatically purchased as you deploy." `GameOrderDeploy`'s bool is the
**Free** flag: a deploy that is not free costs `cost(already deployed this turn + n) − cost(already deployed)` gold;
this server always sends `false` (paid), which is what a commerce game needs (VERIFIED live: the turn above).
Server refusals the client names: 593 `ExpectedCostInaccurate`, 596 `DeploymentsCannotBeFree`, 597
`InsufficientGold`; `warapp_submit_turn` refuses a deploy the gold cannot pay for before sending (597) and allows a
smaller one, since unspent gold carries over (carry-over is the standing's gold being more than the turn's income:
read from the bundle's resource store, not yet seen live).

**Gold on the board (VERIFIED live).** `GameStanding`'s 7th field (`Resources`) is a dict player (in-game id) →
dict resource type → amount; `ResourceType.Gold = 1`. Live it held only my own entry (`[[me, [[1, 25]]]]` and
`[[me, [[1, 8]]]]`, each the turn's income with nothing carried), so another player's gold is not visible.
`standingGold` (`src/live.ts`) reads it by shape (the one field of that shape; two refuse).

**Cities (from the bundle; the empty case VERIFIED live).** `TerritoryStanding`'s last field is an optional dict
structure type (a string) → count; a City is `"1"` (`StructureType2`). No territory on either live board carried
one, so a non-empty dict is UNVERIFIED live. The purchase order is `GameOrderPurchase`: tag **24**, an optional dict
int32 territory → int32 cities, then the order base; its turn phase is 0 (before every other order); one per turn
(599). Its cost, per city, is `CityBaseCost + (cities already on that territory) × TerritoryCityCostIncrease +
(cities I already own everywhere, then each earlier city in this order) × GlobalCityCostIncrease` — the global
count starts at 0 only when `GlobalCityCostIncrease` is 0. Refusals: 600 (not my territory), 601 (negative), 602
(no cities in this game). Each city pays `CityIncome` gold a turn, added to the income like a bonus (before the army
cap). `warapp_submit_turn`'s `cities` sends it (encoder golden-pinned to the bundle's writer: `18 01
<count> (<territory> <cities>)… <player> 00 00`, little-endian int32s); no purchase has been sent live yet.

## Data handling

Request frames contain the account email in plaintext. Treat captures as personal data:
keep them out of the repository, logs and tool output. Test fixtures are built from
synthetic values with the encoder.
