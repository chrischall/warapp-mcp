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
- Player `team` — **UNVERIFIED**: no team game has been read through GameFeed. `normalizePlayer`
  keeps an integer `team` when one is sent, and the game profile (S1) treats a game as a team
  game when any player carries a team other than -1 (the web client's own test, see
  docs/WEB-PROTOCOL.md "Open games"). The in-game `LatestGameInfo` carries no player list (read
  from the client bundle: orders, standings, turn, teammate orders, toasts), so GameFeed is the
  only source the plan reads; without `team` a team game reads as an FFA.
- `settings` uses real JSON types (numbers, booleans, objects). A card is enabled when its
  `<Name>Card` value is an object and disabled when the value is the string `"none"`.
  `ArmyCap` is the string `"null"` when there is no cap. `Map` is the map id.

## Income and "Extra Armies for Territories" (`BonusArmyPer`) — verified (#38)

- Rule: **income = max(`MinimumArmyBonus`, floor(territories held / `BonusArmyPer`)) + held
  bonuses** (+ card armies). The per-territory armies *replace* the base when larger; they never
  add to it. `BonusArmyPer` 0 is off (income = `MinimumArmyBonus` + held bonuses).
- Evidence, from the client bundle's income computation (read-only): it adds
  `floor(territories / BonusArmyPer)` (labelled "Bonus armies for N territories (if more than base
  armies)"), then, if the running total is below `MinimumArmyBonus`, tops it up to it; held
  bonuses are added after. The in-game help agrees: "If you control BonusArmyPer × (MinimumArmyBonus
  + 1) territories or more, then you'll receive [territory armies] instead", and the settings
  summary says "Extra army for every N territories, once base income exceeded".
- Live: `MinimumArmyBonus 4, BonusArmyPer 1`, 1 territory → war.app paid **4**;
  `MinimumArmyBonus 20, BonusArmyPer 1`, 164 territories → war.app paid **164**;
  `MinimumArmyBonus 2, BonusArmyPer 1`, 3 territories → war.app refused a deploy of 5 and accepted
  **3**. The old additive model said 5, 184 and 5.
- Implemented in `territoryIncome` (`src/analysis/player.ts`) and used by `analyzePlayer` /
  `incomeFor`, the planner's protected value of a border, the per-opponent enemy deploy
  base (from that opponent's visible territories, a lower bound), and the pick advisor's
  opening simulation (`src/analysis/picks.ts`).
- **Not modelled** (the same bundle function has these terms): an army cap (`ArmyCap`, can cut
  income), the Sanctions card (cuts a sanctioned player's income by its `Percentage`), income
  from cities, and per-player income mods. Overridden bonus values are modelled since #62 (see
  "Overridden bonus values" below).
  `incomeUncertainties` names the army cap, `OverriddenBonuses` it could not read and an enabled Sanctions card
  (`SanctionsCard` present in the settings) when a game's settings switch them on; then `warapp_plan_turn` warns and
  `warapp_submit_turn`'s deploy-total check becomes a preview warning instead of a refusal.
  Cities and per-player income mods are **not detected** (no known settings key says they
  pay income; the `Commerce` key is present, as `{}`, even in a plain lobby game), so a game
  using them still gets the hard refusal and the owner must fall back to the in-game number.
- **Wastelands and Commerce (#167).** `Wastelands` is `{ NumberOfWastelands, WastelandSize }` (verified
  as zeros on a lobby game; `normalizeSettings` → `settings.wastelands`). With wastelands on, the planner
  costs a fogged missing bonus member with the expected surcharge of being one (the picking board, where
  wastelands are visible in a manual-distribution game, is not kept yet). `Commerce` is `{}` in a plain
  game; a non-empty object is read as a commerce game (`settings.commerce`) and `warapp_plan_turn` warns
  that gold, buying armies and cities are not modelled — **UNVERIFIED**: no commerce game's feed has been
  seen (the bundle's commerce settings are `CommerceArmyCostMultiplier` and `CommerceCityBaseCost`).
- **Trade-off — Sanctions:** the bundle cuts income only when a Sanctions card is actually
  *active* against the player, but this repo does not decode the live board's active-card list
  (its shape in `GetLatestGameInfo` is unverified), so the warning fires whenever the card is
  merely *enabled* — and the lobby settings enable it in many games. Those games lose the hard
  deploy-total refusal even when nobody is sanctioned; the check is a preview warning and war.app's
  error 11 is the backstop. Decoding the active cards would let the warning (and the soft check)
  apply only when I am sanctioned this turn.
- **Active cards (#163) — UNVERIFIED live.** The client bundle's `GameStanding` carries
  `ActiveCards`, a list of `warlight.shared.ActiveCard { Card, ExpiresAfterTurn }` whose `Card` is
  the `GameOrderPlayCard<X>` that started it (read-only, from the bundle's readers: Diplomacy reads
  its two player ids, Sanctions its target, then the base reads the card GUID and the player who
  played it; Emergency Blockade's order class is `GameOrderPlayCardAbandon`). `readActiveCards`
  (`src/cards.ts`) reads them loosely from the current standing; "until turn" follows the client's
  ActiveCard (read-only, from the bundle): `ExpiresAfterTurn` for a card whose expire behaviour is
  `BeginningOfNextTurn` (Spy, Reconnaissance, Surveillance), `ExpiresAfterTurn + 1` for `EndOfTurn`
  (every other built-in card). `warapp_plan_turn` warns of a
  Diplomacy between the user and a player the plan attacks, and of Sanctions on the user. No live
  board with an active card has been decoded, and whether fogged card plays hide them is unknown;
  the income model still does not apply a Sanction (submit's soft deploy check stays).
- **A team's hand (#163) — UNVERIFIED live.** The wiki says a team shares one hand and one card
  limit. `warapp_plan_turn` and `warapp_submit_turn` read the hand as every card under the user's
  and the teammates' in-game ids (each GUID once); how war.app keys a team's hand has not been
  seen on a team board. So `warapp_submit_turn`'s hard error-51 refusal counts only the user's own
  cards (a wrong guess must not block a valid turn); the team's gathered count over the limit is a
  preview warning until a live team board verifies the keying.
- **Bomb reach** — a bomb lands after the deploys, so the advice takes the opponent's worst case:
  with another stack beside the border it deploys there, unhalved (deploy + ⌈bombed/2⌉ + its other
  stacks, less the guards); with only the bombed stack it deploys on it and is halved with it.
- **Bomb and Emergency Blockade (#163) — rounding UNVERIFIED.** The advice reads a bombed stack
  in its worst case for the user (an enemy keeps the larger half, the user the smaller) and the
  wall as `round((armies + deploy) × MultiplyAmount)`; the commander is taken as unharmed by a
  bomb (players' reports, not the wiki).
- **Error 11 hint:** when war.app refuses a deploy total (error 11), the hint names the modelled
  number. The live board (`GetLatestGameInfo`) carries no income figure — the client computes it
  from the standing — so the authoritative number is the game's "armies per turn".

## Income — overlapping, negative and superbonuses — verified from the bundle (#85)

- Rule, read from the client bundle's per-player income function (read-only): after the base /
  per-territory armies above, it walks **every bonus on the map** and asks whether this player
  owns it: a bonus is owned when **all of its territories** belong to one player (any territory
  unowned, neutral or fogged → nobody). Each owned bonus adds its game value once — the game's
  `OverriddenBonuses` value when set, else the map's — **whatever other bonuses it overlaps**:
  a territory in five held bonuses pays all five, and a single-territory "(hidden)" bonus is a
  bonus like any other. There is no superbonus term: a superbonus is one more bonus over all its
  member territories (`bonusTerritories` flattens member bonuses; a member id that is also a
  territory id is the territory).
- **Negative bonuses** are summed apart and subtracted after the positives (and after the base
  top-up): `income = max(base, floor(T / per)) + Σ positive held − Σ |negative held|`, and the
  subtraction **floors at 0** (subtracting at least the total zeroes it). 0-value bonuses add
  nothing. Under Local Deployment the positive bonuses become pools and the negative total is
  taken from the free armies and the pools a little at a time (not modelled: `deployPools`
  takes the net income, so its anywhere pool absorbs the negatives first).
- Then cities, the army cap, Sanctions, and **last the Reinforcement card armies** (added after
  the 0 floor, so a card always pays in full).
- Implemented once, in `boardIncome` (`src/analysis/player.ts`): `incomeFor` (warapp_plan_turn and
  warapp_submit_turn's deploy check), `analyzePlayer` (warapp_analyze_board), the planner's
  `expected.nextIncome` and per-opponent enemy estimate, and the pick advisor's simulated budget.
- **#85 (plan 76 vs submit 58, then 98 vs 80), deduced from the code (not re-checked live):** both tools already shared `incomeFor`; the
  constant gap is the Reinforcement card. `warapp_plan_turn` plays every Reinforcement card it can
  value and counts its armies in `income`, with the card play in `orders`; submit counts card
  armies only for the card plays in the orders it is given. Orders built from the plan's deploys
  without its card order (an overridden plan) carried the card's 18 armies with no card play, so
  submit (and war.app) wanted 58 — and the card, still unplayed, did the same on the next turn.
  Now plan_turn's warnings say how much of `income` is the card's, the submit refusal names an
  unplayed Reinforcement card whose armies explain the surplus, and the planner's next income
  leaves out this turn's card armies (`PlanInput.cardArmies`); the planner had also counted them
  again in `expected.nextIncome`. The bundle check above also led to two model fixes: the 0 floor,
  and the pick advisor counting negative bonuses and superbonuses in its budget.

## Overridden bonus values (`OverriddenBonuses`) — verified (#62)

- Meaning (live, 2026-11-12): a Local Deployment game, base 2, overrode two single-territory
  bonuses to 12 and 7; war.app's deploy panel said 21 = "2 anywhere, 12 in <bonus>, 7 in
  <bonus>", the map values gave 13, and war.app accepted the 21 split per the panel. So an
  override replaces the bonus's value everywhere the value counts: income, Local Deployment
  pools, and so bonus scoring.
- Type, from the client bundle (read-only): the game settings hold `OverriddenBonuses` as a
  dictionary of bonus id → value (the summary shows "None" when it has no keys); the create-game
  check refuses a bonus id not on the map and a value below −1000 or above 1000
  (`OverriddenBonusesInvalid`).
- **GameFeed's JSON shape — verified live (2026-11-12):** an array of
  `{ "bonusID": <int>, "value": <int> }` with JSON **numbers** (unlike most GameFeed scalars), one
  entry per overridden bonus (a game on a large map sent 303), and `[]` when nothing is overridden.
  `parseOverriddenBonuses` (`src/normalize.ts`) reads it loosely, never throwing: string numbers,
  other key spellings, `[id, value]` pairs, an object keyed by bonus id, or any of those as a JSON
  string. A malformed entry is skipped (the rest are kept) and the read flagged
  `overriddenBonusesUnparsed`; an unknown shape gives no values and the same flag.
- Applied at one choke point: `applyBonusOverrides` (`src/analysis/overrides.ts`), called by the
  tools' `mapOf`, returns the map with the game's values (superbonuses included) without touching
  the cached map. Unreadable overrides: the map's own values are used and `incomeUncertainties`
  says so.
- **Pre-checks:** `OVERRIDES_VERIFIED` is `true`, so overrides that read in full keep
  `warapp_submit_turn`'s deploy-total and Local Deployment pre-checks hard. Overrides that did not
  read in full make both warn instead of refuse (war.app enforces both) and `warapp_plan_turn` notes
  it.

## Local Deployment — key verified, pool rules UNVERIFIED

- `settings.LocalDeployments` (boolean, `GetSettings=true`) is read into
  `GameSettings.localDeployments` (verified key: the lobby fixture sends `false`).
- When it is on, armies earned from a bonus must be deployed inside that bonus. **Unverified
  assumptions** the planner (`src/analysis/local-deploy.ts`) and `warapp_submit_turn`'s
  validation make about the rest:
  - only fully held bonuses worth more than 0 form a pool, worth the bonus's value;
  - a superbonus's armies go anywhere inside the superbonus (all of its member territories),
    beside its member bonuses' own pools;
  - base income (`MinimumArmyBonus`), per-territory income (`BonusArmyPer`) and card armies
    (Reinforcement) may be deployed anywhere;
  - a negative bonus only lowers the income; it has no pool.
  A territory in several held bonuses may draw on each. Deploys are charged to the pools by an
  exact matching (a maximum flow from deployed territories to the pools that contain them), so a
  valid split is never refused — whether the bonuses nest (superbonuses) or overlap without
  nesting. war.app's own refusal of a broken split has not been observed.

## No-Split — key and whole-stack rule verified, the guard UNVERIFIED

- `settings.NoSplit` (boolean, `GetSettings=true`) is read into `GameSettings.noSplit`
  (verified key: the lobby fixture sends `false`; string-typed `"True"`/`"False"` are read too).
- When it is on, a territory issues at most one AttackTransfer (attack or transfer) per turn.
  `warapp_plan_turn` keeps each territory's first (best) order and warns which it dropped;
  `warapp_submit_turn` refuses two AttackTransfers from one territory before sending anything.
- **Verified (#124): the order sends the whole stack.** In a live turn with one-army-stands-guard
  off, four orders of 3 from stacks of 8, 7, 4 and 3 left every source at 0, and the captures held
  what the whole stacks would leave; the wiki's No-Split page says the same (all available armies
  attack or transfer; a stack cannot be divided). So `warapp_plan_turn` sizes every order as the
  whole stack — this turn's deploys there included — and a territory that must hold issues none;
  `warapp_submit_turn` warns when an order asks for fewer (war.app sends them all anyway).
- **Unverified:** whether one army stays behind when one-army-stands-guard is on (that game had it
  off). The planner and the validator assume it does (the whole stack less the guard), and the
  plan says so in a warning.

## Move order and the speed first turn — key verified, Begin UNVERIFIED

- `settings.MoveOrder` is a string (verified key: the lobby fixture sends `"Cycle"`), read into
  `GameSettings.moveOrder`. The client's enum is `Random`, `Cycle` and `NoLuckCycle`.
- With `NoLuckCycle` the first turn is a speed race, and war.app shows no board until the player
  presses Begin (`BeginFirstTurn`, 78 — `docs/WEB-PROTOCOL.md` "Begin first turn"). Read from the
  client bundle; the 2026-11-12 live game in issue #44 matched it (no standing until Begin), but
  `warapp_begin_turn`'s encoding has not been sent live.
- **Who moves first (#127) — the rules read from the client's help text, UNVERIFIED live.** Under
  `Cycle` turn 1 is random and each later turn reverses the order ("ABCD becomes DCBA"); with
  manual distribution the award counts as part of the cycle (A awarded first, B moves first on turn
  one). War.app does not say who moves first under `Cycle`: "you must deduce it by observing the
  sequence that orders happen". Under `NoLuckCycle` the first order is set by how fast each player
  played turn one (or the distribution, in a picking game), then swaps every turn, and the game
  shows it (Game → Move Order). So `warapp_plan_turn` keeps one known turn per game at
  `<dataDir>/move-order/<gameId>.json` (from `first_mover`, or the award under `Cycle`) and
  alternates it for later turns (`src/move-order.ts`).
- **Move order in the game history — not read, UNVERIFIED.** The client's turn record carries the
  turn's `MoveOrder` (player ids in the order they moved) beside `Orders`, `TurnNumber` and
  `TurnTime`, and its game record a `CyclicMoveOrder`. Whether GameFeed's `GetHistory` sends either
  (or a game in progress's orders, in the order they ran) has not been seen, and the in-progress
  history shape itself is unverified (below), so nothing reads the first mover from it: one
  off-by-one in the turn numbering would invert every turn after it. When a live history is
  captured, record whether it carries a turn's move order and its turn numbering here, then add it
  as a source in `src/move-order.ts`.

## Order options and mods — keys verified, the options UNVERIFIED live (#165)

- `settings.AllowTransferOnly`, `AllowAttackOnly` and `AllowPercentageAttacks` are booleans
  (verified keys: the lobby fixture sends `false` for each), read into `GameSettings`
  `allowTransferOnly`, `allowAttackOnly` and `allowPercentageAttacks`. The client bundle's order
  validator refuses a Transfer Only order (error 361), an Attack Only order (362) or a percentage
  order (360) when its setting is off; `warapp_submit_turn` refuses them first, and treats a setting
  the feed did not send as off.
- A percentage order's armies are worked out when it runs: the client rounds `percent/100 ×
  available` to nearest (a half rounds down) and never sends more than is available (from the
  bundle). What "available" counts — the guard left out, armies that moved in excluded — is assumed
  from the rules, not read; `warapp_check_plan` resolves it that way and says so.
- Attack teammates has no game setting; `warapp_submit_turn` refuses it outside a team game.
- A commander moves only with an order that carries it (`docs/WEB-PROTOCOL.md`, Orders). No
  setting other than `Commanders` gates it.
- `settings.Mods` is a list (verified key: the lobby fixture sends `[]`); its entries' shape is
  unverified, so only the count is kept (`GameSettings.mods`, -1 when the value is not a list). A
  game with mods gets a warning in every plan that the rules assumed may not hold.
- **Unverified:** none of these options has been sent in a live commit. The owner confirms each
  on a live turn (the order shows in the game as sent).

## Pick-list length — from the client bundle, UNVERIFIED against the server (#129)

- war.app's client gives each player `perPlayer` = floor(pickable territories / players), capped
  by `TerritoryLimit` (0: no cap). Its picking UI stops adding picks at players × `perPlayer`
  (twice the limit only in a 1v1, when enough territories are pickable), and its guide shows
  "Minimum picks" / "Maximum picks" from the same formula. The game's pick validation (shared
  code) rejects a duplicate, a territory that is not pickable, and a list shorter than
  min(10, `perPlayer`); it has no maximum. Whether the server enforces either bound has not been
  sent live, so `warapp_submit_picks` warns in its preview instead of refusing, and
  `warapp_plan_picks` lists as many picks as the client allows.
- Picks are awarded round by round in move order, the order reversing each round, each player
  getting their highest-ranked territory still free (the community wiki; not read from the bundle).
- What the award is read for (#166, `src/analysis/award.ts`) rests on that rule and two more from
  the wiki, none checked against a live game: under a `Cycle` move order the award is turn 0 of the
  cycle (the first awarded moves second on turn 1; the client's help text says so too, and under
  `NoLuckCycle` play speed sets the first order instead, so the award says nothing there), and a commander starts on its owner's first
  awarded territory. UNVERIFIED too: whether `GetTerritoryPicks` still answers once territories are
  distributed, which is why the list is kept locally when it is read during distribution.

## Starting armies and DistributionMode — UNVERIFIED (#94)

- `warapp_track_opponents` gives an opponent with nothing in view a lower bound on the armies
  it has received (`earnedAtLeast`). Its starting-armies term is `TerritoryLimit ×
  InitialPlayerArmiesPerTerritory`, assumed to be what each player starts with under manual
  or automatic distribution. Unverified: manual picks might leave a player fewer territories
  than the limit, and then the term overstates its start.
- `DistributionMode` -1 is taken to be full distribution (every territory split among the
  players, `TerritoryLimit` ignored). Unverified. The bound leaves the starting armies out in
  that case, and for a map distribution whose type is not `normal`.
- #205: the outlook's **upper** bound on a fogged opponent needs a start too. With the start
  unknown under full distribution or without `TerritoryLimit`, it takes ⌈territories ÷ seated
  players⌉ × `InitialPlayerArmiesPerTerritory` (every player gets an even share; unverified that full
  distribution places `InitialPlayerArmiesPerTerritory` on each). Players GameFeed lists who never
  took a seat (`Invited`, `Declined`, `RemovedByHost`) are not counted: they would shrink the share
  below a real player's start. A scenario's starts stay unbounded.
- #205: with cards on, the bound counts a fixed Reinforcement card (`FixedArmies`) by the card
  clock. A `ReinforcementCard.Mode` other than `0`/`Fixed` is taken as progressive and leaves the
  bound open — the field name and values are unverified; a Gift card always leaves it open, and so
  does a missing `NumberOfCardsToReceiveEachTurn` (the random pieces a turn are then unknown).

## Combat (luck and rounding) — verified from the client bundle, not live

Read from war.app's own client bundle (its shared combat code, `warlight.shared`; the same
code the client's single-player games and its attack-odds tool run), 2026-11-13. Not checked
against a live turn's results. Settings: `LuckModifier` is a fraction 0–1 (the client
validates `0 ≤ luck ≤ 1`; `0.16` in its tutorial level), `RoundingMode` is `WeightedRandom`
(0) or `StraightRound` (1), kill rates are fractions (`0.6`, `0.7` by default).

- **Kills.** `n` armies at kill rate `r` and luck `L` kill `x = n·r + (G − n·r)·L`, i.e.
  `(1 − L)·n·r + L·G`, where `G` counts the armies that each kill with probability `r`
  (a Binomial(n, r) draw). With straight rounding at 0% luck the dice are not rolled at all
  (`round(n·r)`).
- **Rounding.** Straight: round half up (`2.5 → 3`). Weighted random: `floor(x) + 1` with
  probability equal to the fraction `x − floor(x)`, else `floor(x)` ("3.3 has a 30% chance of
  rounding to 4", the client's own help text).
- **Capture.** Attackers and defenders fight at once (defenders kill at the defensive rate
  with the same luck and rounding). The client's odds tool counts an attack as a capture when
  the attackers' kills reach the defenders and, when the two sides are equal, the defenders do
  not kill every attacker — the same as "every defender dies and at least one attacker survives",
  since defenders never kill more attackers than they are.
- **What the planner does with it** (`src/analysis/combat.ts`): `winChance` sums the binomial
  distributions exactly (no simulation); `guaranteedKills` is the luck-free share rounded (the
  floor under weighted rounding). The planner's certain sizing (`captureCost` at chance 1, #126)
  is the fewest attackers whose `winChance` is exactly 1 (3 v 2 at 16% luck, 4 v 2 under weighted
  rounding at 0% luck); with luck on ordinary captures default to a 95% chance, and holds are
  judged against the fewest attackers winning more than 5%. `killBreakpoints` lists the efficient attack sizes
  (60%: 1, 3, 5, 6, 8, 10, 11, 13).

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
- The feed's terms of use ask callers to cache maps. A map id does not pin a map's content,
  though: a map maker can publish an edit under the same id, and GameFeed sends no map version
  (UNVERIFIED how often edits reach live games). `MapCache` keeps maps in memory and, with a data
  directory, on disk (`src/map-store.ts`: `<dataDir>/maps/<mapId>.json`, base bonus values,
  LRU-bounded, plus `<dataDir>/maps/games.json` naming each game's map), so the cache survives a
  restart. A stored map carries `storedAt` and is trusted for `MAX_MAP_AGE_MS` (30 days): after
  that the game is fetched with its map again and the fresh copy replaces the stored one. A game whose map is already cached is
  fetched with `GetMap=false`. A new game is fetched once with its map, because its map id is unknown
  until the response arrives — except by a caller that never uses the map (#148): the turn wait,
  surrender, uncommit, chat, join-game, scout, begin-turn and submit-turn's read-back always ask
  `GetMap=false`. Map statistics ask `GetMap=false` with `GetSettings=true`, so a map cached under
  the settings' map id is attached without a download; only a finished game on a map not cached
  yet costs a second request, for the map. The game → map index is written only for a caller that
  wants the map, on a game not finished.

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
- **How a hidden territory reads on each board (#69).** The fog level is war.app's
  `StandingFogLevel` — 1 You, 2 Visible, 3 OwnerOnly, 4 Fogged (verified from the client
  bundle, which refuses a deploy on 3 or 4 as "fogged" and builds a fully fogged standing as
  fog level 4, owner −1, `Armies(0, fogged)`).
  - *Live board and its cache* (`toBoardState`; the cache is the planned board as JSON):
    fogged (level 4 or `Armies.fogged`) → owner `unknown`, armies `null`, `fogLevel: "Fogged"`;
    owner-only (level 3) → the owner, armies `null`, `fogLevel: "OwnerOnly"`.
  - *GameFeed standing / `GetHistory`* (`boardFromStanding`, unverified): a fog level matching
    `fog` or `4` → owner `unknown`, armies `null`; `OwnerOnly` or `3` → armies `null`; an owner
    of 0 is neutral, −2 pickable, any other negative (war.app's fogged −1) `unknown`. Without a
    fog key the entry is taken at face value — a feed that sent fogged land as a plain neutral
    would still read as visible.
  - The planner's trend and observed deploy count a previous-board territory only when it shows
    an owner (player or neutral) *and* armies under a fog level that does not hide them
    (`visibleState`); anything else is a fog reveal. The enemy deploy estimate's base income
    and visible bonuses still count an owner-only territory (its owner shows); only its stack
    is unknown.
  - *Upgrade transition:* a board cache written before #69 named fog level 2 (truly Visible)
    `"OwnerOnly"` and kept its armies (level 3 went unnamed, as `"3"`). Current boards always
    null an owner-only territory's armies, so `visibleState` reads an `"OwnerOnly"` entry that
    still carries a count as that old level 2: visible, not a reveal.
  - The observed-deploy cap counts a bonus out of reach when any of its territories shows
    another owner (a player or a neutral) under a fog level that shows owners — owner-only
    included, whatever its armies.
  - **Which game fog settings show every owner (#164) — UNVERIFIED live.** From the wiki's Fog
    page: `NoFog`, `LightFog` and `ModerateFog` (Dense fog) show every territory's owner, so an
    opponent's income is exactly its base plus the bonuses it holds; `ModerateFog` hides every
    stack, and `VeryFoggy` (Heavy fog) shows the owner of a territory next to mine but not its
    armies. The engine lists Dense before Normal, so the planner matches the setting by name
    (`OWNERS_SHOWN_FOG`) and also requires the board to show every territory's owner; it never
    compares fog levels by position. An owner-only enemy territory next to mine is a threat of its
    owner's unaccounted armies (the tracker's `unexplained`, at most two turns of its income in
    one place; else the guard alone) plus its deploy, and never a target (its defenders are
    unknown). That pool is counted once per border of mine: with several of its owner-only
    territories next to it, the rest stand at the guard alone. Under fog that hides every stack the
    tracker credits each owner-only territory an opponent visibly took (the guard left there and
    the capture's cost), so `unexplained` is not simply everything it earned.
- `GetHistory` returns turns ("assuming it's finished", per the docs). The client passes it
  through raw. `GetChat` is passed through raw too, and it is third-party text: `src/chat.ts` reads
  it loosely (`{ playerID, date, turn, message }`, `playerID` the in-game id — verified live 2026-11-14:
  for public messages it matched the web client's `GameRefresh` chat read in count, time, turn and
  sender, `docs/WEB-PROTOCOL.md` "Chat"). **Whether it returns
  team or private messages, and with which fields, is UNVERIFIED** (V2 in `docs/PLAN-TEAMS.md`): a
  message with no channel field is `unknown`.
- **`GetHistory` for a game in progress — UNVERIFIED.** `warapp_plan_turn` asks for it (a
  second, best-effort GameFeed call) to find the previous turn's standing for the threat
  trend — only when the previous two turns are not both cached, and it only fills turns the cache lacks:
  a cached board is the verified live board, so it always wins (#131). `boardFromHistory` (`src/trend.ts`) reads `game.history` loosely and never throws:
  an array of turns (number from `turnNumber` / `turn` / `number`, else the position), a
  `{ turns: [...] }` wrapper, or an object keyed `turn<N>` / `standing<N>` / `<N>`; each
  entry is a standing itself or carries one under `standing` / `standings` /
  `latestStanding`. **Assumed:** an entry's number is the count of completed turns its
  standing reflects (so the previous board of turn T is entry T − 2), and owners may be
  GameFeed or in-game player ids (both are mapped). When the feed sends nothing usable
  (or errors), the planner falls back to the board it planned on in the previous turn,
  cached at `<dataDir>/boards/<gameId>.json` (the player's own fogged view, the newest two
  planned turns kept so a turn planned twice still finds the one before it, used only when
  cached on exactly the previous turn). Beside it, `<dataDir>/games/<gameId>.json` keeps the
  game's settings name-free, so `loadReplay` (`src/replay.ts`) can rebuild a plan's inputs offline
  with the stored map. When a live in-progress history is seen, record its
  shape here and tighten the parser.
- **My own past orders (#119).** The opponent tracker uses the player's own orders on a turn as
  measurements (`TurnBoard.orders`, `measureOrders` in `src/analysis/opponents.ts`: the defenders a
  failed attack killed, what a hold that fell really killed, and what an opponent's failed attack on
  a hold lost — the loss the orders do not explain, ÷ the offensive kill rate). They come from this server, not from
  war.app: `warapp_submit_turn` caches the deploys and moves it sent (once `SendOrders` returned
  without an error) beside the boards in `<dataDir>/boards/<gameId>.json`, by turn, and
  `boardHistory` attaches them. Orders sent from the web client are unknown, and the tracker reads
  those turns from the boards alone, as before. Whether `GetHistory` carries the player's own
  orders for a game in progress (a finished game's feed shows every side's) is UNVERIFIED and not
  read.

When an in-progress game is captured live, record its shape here, add an anonymized fixture,
tighten `boardFromStanding`, and set `verified: true`.

## End of game, boot and AI seats — keys verified (lobby), meanings UNVERIFIED (#178)

`parseEndRules` (`Game.endRules`) reads, from `settings`: `InstantSurrender`,
`SurrenderedPlayersTurnIntoAIs`, `BootedPlayersTurnIntoAIs`, `TimesCanComeBackFromAI`,
`AIsSurrenderWhenOneHumanRemains`, `DirectBoot` / `AutoBoot` (minutes; `2880.0` on the lobby),
`BankingBootTimes` (`{ BankAmount, InitialBankInMinutes }`) and `AllowVacations`. The keys and
types are verified on the lobby fixture.

- `InstantSurrender` came as the **string** `"Instant"`; the client bundle reads the setting as a
  boolean, and its surrender toast says "has surrendered" when it is on and "'s surrender has been
  accepted" when off. Read: booleans and `True`/`False`, `Instant` = on, a few spellings of "not
  instant" = off; any other string is kept (`instantSurrenderRaw`) and treated as unknown.
  **UNVERIFIED:** the string GameFeed sends when it is off, and whether a two-player game with it off
  really waits for the opponent to accept. `warapp_surrender` reads acceptance from it, falling back
  to the player count (more than two players) when it does not read.
- `AIsSurrenderWhenOneHumanRemains` (wiki): once one human is left the AIs give up, so the profile's
  `endsWith` names the last other human. **UNVERIFIED** live.
- Boots (`leavers`): a human still `Playing` who has not committed, with the minutes left until
  `AutoBoot` / `DirectBoot`, counted from the game's `lastTurnTime`. **UNVERIFIED:** what
  `lastTurnTime` marks (taken as the moment the turn began); banked boot time and vacations are not
  counted. A booted seat becomes an AI when `BootedPlayersTurnIntoAIs`, else its land turns neutral.

## A lobby's settings for the join screen — UNVERIFIED (#132)

`warapp_join_game`'s preview reads the lobby with `GetSettings=true` for what the open-games record
lacks: `InitialNonDistributionArmies` / `InitialNeutralsInDistribution` (the cheapest neutral,
costed with `armiesToTake` at the game's kill rates, no luck margin, against `MinimumArmyBonus`)
and `Fog` (`LightFog` is flagged). The fixture lobby carries these settings, but GameFeed has not
been seen answering for a lobby the account has **not** joined; a failed read leaves the preview
with `screen: null` and a `screenNote`, never a refusal.

## Game-ID feed (`GameIDFeed`) — UNVERIFIED

Used only by the opt-in `warapp_map_stats` (`WARAPP_STATS=1`, never hosted). From war.app's
public wiki page "Game ID feed API" (read 2026-11-12, not called live):

- `https://war.app/API/GameIDFeed?LadderID=<n>` or `?TournamentID=<n>` returns the game ids of
  a ladder or tournament, for use with GameFeed. Ladder ids: 1v1 `0`, 2v2 `1`, 3v3 `4`.
- The wiki says the parameters are "GET parameters" but names **no method, no auth, no reply
  shape, no limit and no terms**. `WarappClient.getGameIds` therefore POSTs the GameFeed
  credentials (harmless if the feed is public), maps `{ error }` bodies like GameFeed, and
  reads the ids loosely (`gameIdsOf`): a bare array, or `gameIDs` / `gameIds` / `GameIDs` /
  `games`, each a number, a numeric string or `{ id | gameID }`. Distinct, highest id first.
- Each listed game is then loaded with `GetHistory=true&GetSettings=true` — the history of a
  **finished** game, which the docs say the feed returns. Its shape is as unverified as the
  in-progress one above: `historyBoards` (`src/trend.ts`) reads it with the same loose parser.
  **Assumed:** the first board where players hold land is the starting picks, and an entry's
  number is the count of completed turns.
- Throttle (ours, not war.app's): at most 50 new games per call (default 10), ≥ 1 s between
  requests, finished games cached forever at `<dataDir>/stats/<mapId>/<gameId>.json` as
  name-free records. A finished game whose history yields no starting board is counted
  (`unreadable`) and **not** cached (#132): it would otherwise sit in every denominator forever.
  A cached record of that kind from an older version is dropped on read and fetched again.
  When the feed is called live, record its method, auth and reply here.

## Chat settings and the Terms — key verified (lobby), the Terms not re-read

- `PrivateMessaging` (bool, in the settings; `privateMessaging` in `GameSettings`): whether players
  may message each other privately. The key is in the lobby fixture; the wiki documents it
  (<https://war.app/wiki/Private_Messaging>, <https://war.app/wiki/Mod_API_Reference:GameSettings>).
  `warapp_send_chat` refuses a private message when it is `false` (the client names server error 202,
  `PrivateMessagingDisabled`).
- **The Terms of Service** (<https://www.war.app/TermsOfService>), as the research for
  `docs/PLAN-TEAMS.md` reported them and **not re-read by anyone since**: section 6 (Prohibited
  Conduct) bans automated systems (bots, scrapers, scripts) except through "authorized APIs", which
  the Terms do not define; section 7 (Communication Rules) bans false, defamatory, harassing or
  offensive messages. The wiki's Rules page (<https://war.app/wiki/Rules>) says players working
  together is not against the rules. Owner decision D1 in `docs/PLAN-TEAMS.md` (decided
  2026-11-14): chat proceeds, and every chat send stays confirm-gated.
