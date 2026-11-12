# War.app web-client protocol (reverse-engineered)

The official API (`/API/GameFeed`) returns **no board for an in-progress game** — not
standings, not the pick-phase map — and has no way to submit orders. The web client
talks to its server over a private binary RPC protocol instead. This document records
that protocol as read from the client bundle (`warappcdn.com/js/Release/ujs.js`,
client `v6.07.0.1`, protocol version 242) and checked against captured traffic.

**Status (2026-11-12):** request framing fully decoded — 7/7 captured requests rebuilt
byte-identical from decoded fields. Reply payloads (the board) and `SendOrders` are not
yet decoded. Nothing here is a captured value; no captures are committed.

## Transport

- `POST https://war.app/Services?m=<MethodName>&js=1`, body = the frame **hex-encoded**
  (uppercase), sent by jQuery `ajax` from the signed-in page. The reply body is hex too.
- When a live connection exists the client may use a socket channel instead; the HTTP
  path is the fallback and is what this project uses.
- **Authentication is the browser's cookies.** The request body carries the account
  email (below) but no token, so a frame is only honoured from a signed-in session —
  build frames anywhere, but send them from the signed-in tab.
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

Server error codes seen in the client: 11 = deployed armies ≠ income, 208 = game already
advanced to the next turn, 88 = game deleted, 483 = game started without you.

## Data handling

Request frames contain the account email in plaintext. Treat captures as personal data:
keep them out of the repository, logs and tool output. Test fixtures are built from
synthetic values with the encoder.
