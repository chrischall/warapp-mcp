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

Every reader (the bundle's and `methods.ts`) reads protocol 242's layout, so `WarappRpc` refuses a
reply whose header names another version rather than decode it into wrong values (#131).

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
| 10 | GetOpenGames | exists, but the web client never calls it — the open games list comes from a page payload (see [Open games](#open-games)); do not use |
| 38 | GetGameDetails | |
| 39 | GameRefresh | params: int32 gameId, bool, bool, string "-1", string "-1", bool, dict, dict |
| 40 | GetLatestGameInfo | params: int32 gameId; reply class `NE` — expected to carry the board |
| 48 | GetGameSettings | |
| 60 | AcceptGame | accept an invitation (not used) |
| 61 | **AcceptOpenSeat** | take an open seat — see [Open games](#open-games) |
| 62 | AcceptOpenAutoGame | not used |
| 63 | GetOpenAutoGame | not used |
| 64 | **DeclineGame** | params: int32 gameId, bool modHook — read from the bundle, not verified live; see [DeclineGame](#declinegame-leaving-a-lobby) |
| 67 | **Surrender** | params: int32 gameId, bool surrender, bool false — see [Surrender](#surrender) |
| 68 | AcceptSurrender | accept another player's pending surrender (not used) |
| 73 | GetMapDetails | no auth; params: int32 mapId |
| 74 | **SendOrders** | the turn commit — not yet captured |
| 75 | SendInProgressOrders | draft save of orders |
| 76 | SendTerritoryPicks | params: int32 gameId, bool present, int list territoryIds (priority order), bool, bool |
| 77 | SendInProgressPicks | as 76 without the two trailing bools (draft save) |
| 78 | **BeginFirstTurn** | params: int32 gameId — read from the bundle, not verified live; see [Begin first turn](#begin-first-turn) |
| 79 | GetTerritoryPicks | |
| 80 | **UnCommit** | params: int32 gameId — see [UnCommit](#uncommit) |
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
                18 Blockade), card fields, GUID cardInstanceId, base
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
| Order Priority | 10 | 12 |
| Reinforcement | 5 | 20 |
| (deploys) | 2 | 25 |
| (attacks/transfers) | 1 | 50 |
| Order Delay | 11 | **50** — placed in phase 12 (with Order Priority) it was refused with error 10 |
| Blockade | 18 | 60 |

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
  id, name, map id and state codes (mapping the codes is still to do).
  **Unverified (#130):** whether `count` (10, the client default, always sent) caps the reply —
  an account in more than ten games may see only ten in `warapp_my_games` and
  `warapp_wait_for_turn` with no truncation marker. Needs a live check with an account in at
  least ten games before the count is raised or a marker added.
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
**team per open seat** (`-1` = no team), and that team is what a join sends. Anything the reader
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
accept it ("Pending surrender"; accepting is `AcceptSurrender`, 68, not used): the player stays
`Playing` in GameFeed until then, so the tool reports `pending`, not surrendered, and a pending
surrender is what `surrender = false` takes back. With two players a surrender ends the game at once
(GameFeed shows `SurrenderAccepted`), so there is nothing to take back. The encoder is pinned by a
golden test built from synthetic ids.

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

**UNVERIFIED live: read from the client bundle's writer.** The lobby's Decline button (`LobbyVM`)
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
game with the account's seat given up (a game missing from that paged list proves nothing) — and
`unconfirmed` otherwise. A transport failure is `unknown` and is never retried. In a team game the
client first warns that declining leaves the teammates a player short; the preview says so.
Error codes, with the client's handling: **191** `CannotDeclineYourOwnOpenGame` (delete it
instead); **88** the game was deleted; **17** `NotInGame`, **4** and **7** `InvalidPlayerState` are
swallowed by the client. The tool reads back after 17 and 7 (the seat may already be gone) and words
4 as "the game has already begun". The encoder is pinned by a golden test built from synthetic ids;
the owner verifies it live.

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
no auth) with message number `0x80000000`, 61 bytes, that **starts with the game id and carries no
other detail**. On receipt, re-read the game from GameFeed — it arrives within ~1 s of the turn
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

## Data handling

Request frames contain the account email in plaintext. Treat captures as personal data:
keep them out of the repository, logs and tool output. Test fixtures are built from
synthetic values with the encoder.
