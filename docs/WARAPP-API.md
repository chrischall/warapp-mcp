# war.app GameFeed API — what this server relies on

Each fact is marked **verified** (seen live against war.app on 2026-11-12) or
**unverified** (taken from war.app's API docs, not yet seen live). Code that relies on an
unverified fact parses loosely and must not throw.

## Request — verified

```
POST https://war.app/API/GameFeed?GameID=<n>[&GetHistory=true][&GetSettings=true][&GetChat=true][&GetMap=false]
Content-Type: application/x-www-form-urlencoded

Email=<sign-in email>&APIToken=<token>
```

- The token is shown at <https://war.app/API/GetAPIToken> while signed in. Changing the
  account password rotates it.
- `GameID` is checked locally (`parseGameId`): a positive whole number below 2^31.
- The feed answers as the player whose token is presented, so fog of war applies.
- `src/client.ts` sends it through `createApiClient`: 30 s timeout, one retry on
  429/500/502/503/504, `idempotent: true` (a read sent as POST), same-origin redirects only.

## Errors — verified

Failures are **HTTP 200** JSON `{ "termsOfUse": "…", "error": "…" }`:

| `error` | Meaning | Mapped to |
|---|---|---|
| `Auth failed` | wrong email or token | `McpToolError` kind `credential_rejected`, hint to regenerate the token |
| `Loading the game produced an error: ServerGameKeyNotFound` | no such game | `WarappNotFoundError` (`code: 'not_found'`, status 404) |
| `GameID must be an integer` | non-integer id | prevented by local validation |
| anything else | — | `McpToolError` kind `http`, message redacted (email + token scrubbed by value) |

war.app checks credentials before it loads the game. The healthcheck relies on this: it asks for
game `2147483647`, and `ServerGameKeyNotFound` from that request shows the credentials work.

## Game body — verified (lobby)

- **Every scalar is a string:** `"id": "45670418"`, `"numberOfTurns": "-1"`,
  `"isAI": "False"`. Player ids can exceed 2^31, but they stay within JS safe integers.
- Top-level keys in a lobby: `termsOfUse, id, state, name, numberOfTurns, created,
  lastTurnTime, players, settings (GetSettings), map`.
- `created` / `lastTurnTime` live format: `M/D/YYYY HH:MM:SS` (e.g. `11/11/2026 00:20:04`).
  The fixture uses ISO, which is synthetic. Both are kept as strings.
- Player: `id, name, isAI, humanTurnedIntoAI, hasCommittedOrders, color, state`
  (`state` is `Playing` even in a lobby).
- `settings` uses real JSON types (numbers, booleans, objects). A card is enabled when its
  `<Name>Card` value is an object and disabled when the value is the string `"none"`.
  `ArmyCap` is the string `"null"` when there is no cap. `Map` is the map id.

## Map — verified

- `map: { id, name, territories[], bonuses[], distributionModes[] }`. Territory and bonus
  scalars are strings. `connectedTo` and `territoryIDs` are number arrays.
  `coords` is `"x,y"`.
- **With `GetMap=false` the feed sends `"map": {}`** (an empty object).
- The adjacency graph is symmetric (fixture: 761 territories, 372 bonuses).
- **Territory and bonus ids overlap.** On map 39905, ids 1–382 name both a territory and a
  bonus, and every bonus member is a territory. A bonus member id is therefore read as a
  territory whenever a territory has that id. Otherwise it is a member bonus (a superbonus),
  and failing both it goes into `unknownIds`. *Superbonus encoding is unverified:* this map
  has none.
- Bonus values can be 0 or negative (e.g. `The Sorrows` = -4).
- Maps never change for a given map id, and the feed's terms of use ask callers to cache.
  `MapCache` keeps maps per process. A game whose map is already cached is fetched with
  `GetMap=false`. A new game is fetched once with its map, because its map id is unknown
  until the response arrives.

## Board state — UNVERIFIED

- No in-progress game has been seen live; every game seen so far was `WaitingForPlayers`. The docs
  describe a *standing* with one entry per territory, giving its armies, owner and fog level.
- `boardFromStanding` (`src/board.ts`) reads `standing` / `standings` / `latestStanding`
  with any of these layouts: an array of entries, `{ territories: [...] }`, or an object
  keyed by territory id. It accepts these key spellings:
  - id: `terrID` / `territoryID` / `id`
  - owner: `ownedBy` / `ownerID` / `owner` / `playerID`, where the value is a player id,
    `Neutral` or `AvailableForDistribution`
  - armies: `armies` / `numArmies`, as a number or `{ numArmies }`
  - fog: `fogLevel` / `fog`
- A fogged entry's owner and armies are read as unknown. The result is a source-agnostic
  `BoardState` with `verified: false`, or `undefined` when the parser can't use it.
- `GetHistory` returns turns ("assuming it's finished", per the docs). The client passes it
  through raw. `GetChat` is passed through raw too, and it is third-party text.

When an in-progress game is captured live, record its shape here, add an anonymized fixture,
tighten `boardFromStanding`, and set `verified: true`.
