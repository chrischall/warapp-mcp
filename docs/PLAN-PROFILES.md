# PLAN-PROFILES — reading opponents, and using the read next time

Implementation plan by the research session, 2026-11-15, against `origin/main` at `fb2644a`.
Committed as `docs/PLAN-PROFILES.md`. The owner answered section 5's decisions on 2026-11-15 (see
there).

## 1. Summary

A profile is a set of counted habits: how often a player did X when X was possible. It is kept at
three levels, each falling back on the next:

1. **This game so far** — what the boards and my own orders showed of this opponent.
2. **This player in earlier games** — the same counts, under the deal record's hashed key.
3. **All players** — the same counts pooled by format, as the prior for someone never met.

It is used in rising order of risk: **reported** (a tool, a block in the plan), then **estimates the
planner guesses anyway** (income in the fog, starts, how likely each stress-test reply is), then
**planner choices**, each only after a measurement and the owner's approval.

Build order: collect and report first (parts A, B, D), read finished games (part C), and only then
touch estimates (part E) and the planner (part F). Part 0, the measurement, starts at once and gates
E and F, not the collecting: without collecting there is never enough to measure.

## 2. Where the code stands (checked at `fb2644a`)

- **Board cache:** `src/trend.ts` — `writeBoardCache`, `readBoardHistory`, `readCachedOrders`,
  `CACHED_TURNS = 10`, deleted after `BOARD_CACHE_MAX_AGE_MS` (60 days). My cached orders are
  `{ deploys: [{territoryId, armies}], moves: [{from, to, armies}], sent? }` per turn.
- **Who writes it:** `warapp_plan_turn` (`src/tools/turn.ts:1789`, with `writeGameRecord` and
  `recordOutlook` on the next two lines), `warapp_track_opponents`, `warapp_locate_opponents`
  (`src/tools/where.ts:205`), `warapp_get_relations`.
- **History of my views:** `boardHistory(ctx, game, me, turn)` in `src/tools/turn.ts:1198` returns
  `TurnBoard[]` with my orders attached.
- **Offline replay:** `src/replay.ts` — `<dataDir>/games/<gameId>.json` (name-free settings and
  players, newest 200) and `loadReplay(dataDir, gameId)`, which rebuilds planner inputs with no
  request. Part 0 runs on this.
- **Visibility rules:** `visibleState` and `ownerShown` in `src/analysis/plan/shared.ts:993`. A fog
  reveal is not a change (#69); the new code must use these, not its own test.
- **Income tracking:** `src/analysis/opponents.ts` (`trackOpponents`, `ObservedTurn`,
  `measureOrders`). It answers "how much", not "where" or "whether".
- **The deal record:** `src/analysis/player-record.ts`, `src/player-record-store.ts` (`playerKey`,
  the salt at `relations/players.salt`, `updatePlayerRecord`, `playerRecordEnabled`). The pattern to
  copy: HMAC keys, name-free, 0600, atomic under `withPathLock`, bounded, a corrupt file never
  overwritten, an off switch, on locally and hosted.
- **Finished games:** `historyBoards(history, players)` in `src/trend.ts:103` reads standings
  loosely. Nothing reads orders from a history. `src/map-stats.ts` builds a `GameRecord` (starts,
  first-bonus turn, won) from ladder games only, opt-in, never hosted.
- **Game end:** `warapp_get_game` calls `recordFinalResult` (`src/tools/game.ts:102`).
- **The fog prior:** `fogPrior` in `src/analysis/plan/estimates.ts:66` and `EnemyIncomePrior` in
  `plan/shared.ts` (`myIncome`, `format`, `opening`, `opponents`).
- **Attack sizing:** the "assumes its owner does not reinforce it first" warning at
  `plan/captures.ts:556` and `:724`, `planner.ts:2410–2615`, `plan/strike.ts:1325`; tests in
  `tests/analysis/reinforced-attacks.test.ts`.
- **The stress test:** `StressReply` in `src/analysis/stress.ts:134`, kinds `attack`, `reinforce`,
  `all-attack`, `dodge`, `joint`, `chain`; no likelihood on any.
- **A name already taken:** `src/analysis/profile.ts` and the plan's `profile` field are the *game*
  profile. New module: `src/analysis/opponent-profile.ts`. New plan field: `reads`.

## 3. Evidence (local caches, 2026-11-15, counts only, nothing fetched)

| Measure | Value |
|---|---|
| Games with cached boards | 33 |
| Distinct opponents seen | 45 |
| Seen in two or more of my games | 7 (16%) |
| Games holding an opponent met in another cached game | 14 of 33 |
| Turns an opponent was visible | median 6, top quartile 10, most 25 |
| Territory readings hidden or owner-only | 87% |
| Turns with my orders cached | 98 |
| Games with settings kept for replay | 10 (9 with exact combat: 0% luck, straight rounding) |
| AI seats in those 10 games | 3 of 49 |
| Finished games with history cached | 0 |

- Repeat meetings are a minority, so levels 1 and 3 must pay on their own.
- A live game shows little; a finished game's history is the lever on volume (part C).
- The play log has three attacks that failed because the owner deployed on the target, in three
  different games (reported at turns 6, 17 and 21).

## 4. Principles every part obeys

1. **Security first.** A read may make the plan bolder only where the loss is the armies sent. No
   hold of my commander, a held bonus or a truce-relaxed border is ever sized down on a read.
2. **Counts, not stories.** Every habit is events and opportunities. Each reported value carries its
   `n`, `confidence` and `basis`. One sighting asserts nothing.
3. **Gameplay only.** No name, id, chat text, hour of play or personal field in any profile file. No
   profiling of teammates. Never used to tailor persuasion.
4. **Pure and deterministic.** `opponent-profile.ts` has no I/O and no clock; ties on ascending id.
   With no `reads` passed in, every golden-corpus plan is byte-identical (`GOLDEN_FULL=1`).
5. **Never throws, never blocks a plan.** Every store call is best effort, like the board cache.
6. **Unverified stays soft.** A history shape nobody has seen live is read loosely and marked.
7. **Tests and agents never call war.app.** Synthetic fixtures only; no captures in the repo.

## 5. Owner decisions (answered 2026-11-15)

The owner accepted every default below: P1 inform only until measured, then each hook approved on its
numbers; P2 yes, local and hosted; P3 only games the account played; P4 hashed, local and hosted,
fading, with an off switch.

| # | Decision | Default the plan builds to |
|---|---|---|
| P1 | May a read change the plan, or only inform it? | Inform only (parts A–E1/E3 as reported values) until part 0 is reported; then each part F hook is approved on its numbers |
| P2 | Read each finished game's history once at its end (one more GameFeed request per finished game) | Yes locally and hosted. It is the owner's quota |
| P3 | How far collection reaches | Only games the account played in |
| P4 | Storage | Hashed and hosted like the deal record, counts fade per game, `WARAPP_PLAYER_PROFILE=off` |

Ask the owner before part C (P2) and before part F (P1). Parts A, B and D do not depend on either.

## 6. Live checks only the owner can do

- **V1:** a finished game's `GetHistory` shows every territory un-fogged, turn by turn.
- **V2:** whether its `turn<N>` entries carry orders (deploys, attacks with their results, card
  plays), and under which keys. The owner describes the keys; no capture enters the repo.
- **V3:** that a finished game's GameFeed read gives every player one of the states in
  `PLAYER_STATE_NAMES` (`src/player-states.ts`: `Won`, `Eliminated`, `SurrenderAccepted`, `Booted`,
  `EndedByVote`), and what an AI-replaced player shows.
- **V4:** whether anything says the turn a player turned into an AI.

## 7. Part 0 — the measurement (no PR, report to the owner)

Run offline with `loadReplay` over `<dataDir>/games` and `boards` (never `.env` or `session.json`;
print aggregates only). Use part A's `observeBehaviour` as soon as it exists; before that, a
throwaway script is fine.

1. **How much is there?** Opportunities per habit across the 98 order-turns. Under 30 for a habit:
   say "not measurable yet" and stop there for that habit.
2. **Is a habit a trait?** Per opponent with at least 4 opportunities, split its turns in half. Does
   the first half predict the second better than the pooled rate does?
3. **Does it beat today's rule?** For "reinforces the target": error of "never reinforces" (today's
   sizing when armies are short), of the pooled rate, and of the in-game read, on held-out turns.
4. **Would H1 have helped?** Replay part F's H1 over the cached turns: attacks it changes, and what
   the next board shows happened.
5. **Recurrence:** section 3's table again.

Verdict per habit: `trait`, `pooled only`, or `not measurable yet`. Repeat after part C has read
twenty finished games; the second report is the one P1 is decided on.

### Calibration and the opening benchmark (#318): `scripts/calibrate.mjs`

A local dev script, not a tool and not run in CI; it prints aggregates only (no game id, player id or
name). Its pure parts are `src/analysis/calibrate.ts` (tested in `tests/analysis/calibrate.test.ts`).

```sh
npm run build                                   # tsc emits dist/**, which the script imports
node scripts/calibrate.mjs                      # the data dir: MCP_DATA_DIR, else ~/.config/warapp-mcp
node scripts/calibrate.mjs --data-dir <dir> --turns 8 --json
```

**How to get the data:** the harness makes no request and has no `--fetch`. The normal end-of-game
pass fills the store, one history read per finished game: the `warapp_my_games` sweep (two games a
call), `warapp_get_game` on a finished game, `warapp_wait_for_turn`'s read, or a game-ended
notification in `warapp_get_notifications`. Let those run, then run the harness.

- **Truth** is each finished game's history as the end-of-game pass kept it: the record
  `<dataDir>/finished/<hmac>.json` (E1, `src/finished-store.ts`) holds the history's boards (the first 30
  and the last 30), owners by `playerKey`, a board that lists the same territories as the one before
  kept as its changes. The harness keeps no store of its own and never reads a history itself; it reads
  every record (`calibrationSources`, `src/calibration-source.ts`). A record whose game still has its
  settings record in `<dataDir>/games` gets its ids back by matching keys against that record's ids
  (`historyOfRecord`; a key is never reversed) and my cached boards and orders. A record whose settings
  record aged out (200 kept, 60 days) is read on its own: the settings shape the record keeps, the stored
  map by the record's map id (any age), the players labelled by position (`anonymousHistoryOfRecord`) and
  no cached boards — those are found by game id, which the record does not hold — so it feeds the opening
  benchmark (b) only. One history read per finished game (P2) so feeds the profiles, the lessons and the
  harness, under one bound (500 records) and one name-free store (P4). With `WARAPP_PLAYER_PROFILE=off`
  nothing is read. **Until a pass has run there is no truth and no number:** the harness says so. It
  prints, with its approximations, what it skipped and why: records with no settings shape or no stored
  map, records whose pass kept no history (`read-failed`, `history-unreadable`: never re-read), settings
  records whose game has no record yet (`missing`: the pass has not run), and how many records were read
  on their own (benchmark only).
- **(a) Calibration.** On every turn T with a cached board whose history board T − 1 is kept, per
  opponent with land there: the tracker's income (`calibrationSamples`, E2), the fog prior (#119, before
  #235's blend) and the plan's estimate (`planEnemyEstimates`, as `warapp_plan_turn` calls it: my income,
  the previous cached board and my orders on it, the tracks), each ÷ its true income (`turnIncomes`), by
  format and coverage band (#294). Printed per band: `n`, mean, geometric mean, sd, and the shares under
  0.5 and over 1.5. These are the numbers `LOW_COVERAGE_FACTOR` (1.5), `PRIOR_EVIDENCE_TURNS` (4) and
  `HIDDEN_INCOME_FACTOR` (2) are judged on; changing one goes through the owner.
- **(b) Opening benchmark.** My real start (history board 0) replayed for 8 turns on today's planner,
  my deploys and moves resolved with `simulateTurn`, and after each turn the opponents put back where
  the history shows them (`overlayHistory`). Compared by turn: my replayed income, my real income and the
  winner's; after turn 4, the games with land without bonuses (11+ territories on 8 or less) and with an
  opponent at 1.5× my income, replayed and real. **Approximated, and printed with the result:** the
  planner sees the whole board (no fog); the opponents never attack me (no interaction) — they hold the
  land and armies the history shows, except land I hold in the replay; a territory I really took but did
  not take in the replay keeps its replayed state; card plays are left out; with luck or weighted
  rounding a battle is resolved at its expectation (counted as inexact).

## 8. Part A — the in-game read

### A1. Observing (`src/analysis/opponent-profile.ts`, pure)

`observeTurn(input)` takes the board of turn T (`previous`), the board of turn T+1 (`current`), my
orders on T (may be absent), the graph, the settings and the players, and returns one **primitive**
record per opponent for turn T. Territory states go through `visibleState`; a territory not shown
on both boards contributes nothing.

```
interface TurnPrimitives {
  contact: boolean;                 // previous shows a territory of its next to one of mine
  attackedMe: boolean | null;       // null: cannot tell
  iAttacked: boolean;               // I sent a non-transfer move onto a territory it held
  reinforce: { n: number; e: number; extra: number };
  stack: { top: number; total: number } | null;
  tookFromMe: number[];             // territory ids, ascending
  lostToMe: number[];
}
```

Exact definitions:

- **`attackedMe`:** true when a territory I held on `previous` is its on `current`, or a territory
  of mine next to a stack of its holds fewer armies than `previous + my deploys − my moves out + my
  transfers in`. That second test needs my orders; without them it is true only on a capture and
  otherwise `null`. Survivors of a move out of the border that did not end on a territory of mine (a
  failed attack, or a transfer that met a territory taken first) may come back and cover a hit, so
  such a border still reads true on a drop below that figure but never counts toward a `false`.
  The same holds for a border a move of mine enters from a territory not mine on `previous` (a
  Multi-Attack chain through a territory I took that turn): those armies are left out of the figure
  and may cover a hit. Under Multi-Attack (or when the settings do not say, `ObserveInput.settings
  .multiAttack` absent) a border is tested only when every territory within two steps has its owner
  shown on `previous` and none is a third player's: such a player may have chained through the shown
  neighbour (or a neutral) into my border, and the drop would be blamed on the neighbour. A chain
  longer than two steps is not ruled out.
- **`reinforce`:** one opportunity per move of mine onto a territory X that `previous` shows as its
  with `D` armies, when all of these hold: combat is exact (0% luck, straight rounding); it is my
  only move onto X that turn; my source S ends the turn mine with exactly the armies my orders
  leave (so S was not hit first); and `current` shows X with its armies.
  - It is an **event** when X stood stronger than `D` when my attack ran: X not captured although
    `armies ≥ armiesToTake(D)`; or captured with fewer survivors than the exact result against `D`;
    or, for an attack that could not capture, more defenders left than the exact result.
  - An X weaker than `D` (more survivors on a capture, more of mine back on a failure) is an
    opportunity without an event, never dropped: dropping it would push the rate up. A source holding
    a special unit of mine gives no reading (a commander going along fights as 7).
  - `extra` adds the armies above `D` implied by the result (the least that explains it).
  - A deploy and a transfer in cannot be told apart under fog. Both count: either way the target was
    stronger than it looked, which is what sizing needs.
- **`stack`:** over its territories shown on both boards with the same owner, `growth = max(0,
  current − previous)`. With at least two such territories and total growth ≥ 1: `top` is the
  largest growth, `total` the sum. Else `null`.
- **`tookFromMe` / `lostToMe`:** ownership changes between it and me.

`habitsOf(turns)` derives the habits from the ordered primitives, so habits that span turns are
recomputed, never double-counted:

| Habit | Kind | From the primitives |
|---|---|---|
| `reinforce` | rate | Σ `reinforce.e` ÷ Σ `reinforce.n`; `reinforceExtra` is the mean `extra` per event |
| `attack` | rate | turns with `contact` and `attackedMe === true` ÷ turns with `contact` and `attackedMe !== null` |
| `firstStrike` | rate | of its first contacts with me that lasted two turns, those where it attacked me within two turns |
| `stacking` | size | mean of `top ÷ total` over turns with a `stack` |
| `retaliate` | rate | of turns where `iAttacked`, those where `attackedMe` is true on one of the next two turns |
| `retake` | rate | of territories in `lostToMe`, those back in `tookFromMe` within two turns |

A rate is `{ e, n }`; a size is `{ n, sum, sq }`. An AI seat (`isAI` or `humanTurnedIntoAI`) is
observed the same way and flagged; part B pools it.

**Tests** (`tests/analysis/opponent-profile.test.ts`, synthetic boards from `helpers.ts`): each
definition in miniature, including each "no opportunity" exit (luck on, two moves onto X, source
hit first, a fog reveal on X, orders unknown; for `attackedMe`, a chained move in and, under
Multi-Attack, another player or a hidden owner within two steps), and that re-deriving from the same
turns is stable.

### A2. Keeping the turns (`src/profile-store.ts`)

- `<dataDir>/profiles/games/<gameId>-<myId>.json`: `{ version: 1, gameId, playerId, turns: {
  "<T>": { "<opponentId>": TurnPrimitives } }, folded?: source }`. It holds real ids, like the board
  cache beside it, and is deleted once folded (part B).
- `recordBehaviour(dir, game, me, boards)`: for every consecutive pair in the boards handed to it,
  observe and overwrite that turn's entry. Planning a turn twice rewrites, never adds. The boards
  cache keeps ten turns; this file keeps every turn observed.
- Same guarantees as the board cache: 0600 in a 0700 folder, atomic, best effort, never throws; the
  newest `MAX_PROFILE_GAME_FILES` (200) kept.
- **Hook it** after each existing `writeBoardCache` call in the four tools above, never on a
  `what_if` plan. `warapp_uncommit_turn` already drops the turn's cached orders; the next write
  re-observes that turn without them.
- With `WARAPP_PLAYER_PROFILE=off` nothing is read or written.
- Never a teammate (principle 3): nothing is kept in a game of more than two seats whose teams
  `resolveTeams` could not read (`known: false`: GameFeed carries a team on some seats but not all, or
  none and the game list failed, did not hold the game, left a seat out or was not trusted), since any
  player may be my teammate; the tool then reports `profile: not-kept` and flags every other player
  `mayBeTeammate: true`. Every write also drops what the file holds for a player now
  known as my teammate.

### A3. The tool (`src/tools/profile-opponents.ts`)

`warapp_profile_opponents` (`game_id`, `player?`, `detail: compact | full`), read-only on war.app,
shaped like `warapp_locate_opponents`: load the game with settings, the live board and
`boardHistory`; observe; write the caches the others write; report per opponent:

```
{ player: { id, name ⟦…⟧ }, ai: boolean,
  seen: { turnsObserved, gamesMet },            // the only facts
  habits: { reinforce: { value, n, confidence, basis }, … },
  labels: string[], counter: string[] }
```

In part A `basis` is `this-game` or `default` and `gamesMet` is absent. Names go through
`untrustedText`. Registered locally and hosted. `full` adds the per-turn primitives.

**Done when** a synthetic game in which one opponent reinforces every attacked territory and
another never does reports them apart, with counts, and planning the same turn twice changes
nothing in the file.

## 9. Part B — across games

### B1. The estimate (pure, in `opponent-profile.ts`)

```
value      = (p0 × K + e) / (K + n)        K = PROFILE_PRIOR_WEIGHT = 4
confidence = n / (n + K)
```

- `e` and `n` pool this game's counts in full with the player's faded totals from earlier games.
- `p0` falls back: all players in this format (`1v1`, `ffa`, `team`) → all players → a constant.
  The constants start neutral (`reinforce` 0.5, `attack` 0.4, `firstStrike` 0.3, `stacking` 0.7,
  `retaliate` 0.5, `retake` 0.4) and are replaced by part 0's pooled rates when it reports.
- `basis` is `this-game`, `past-games`, `population` or `default`, by which contributed most.
- A size shrinks the same way, toward the prior mean.
- **Labels** (text for readers; code reads the numbers), only at `confidence ≥
  PROFILE_MIN_CONFIDENCE` (0.5): `reinforcer` (≥ 0.6), `rarely-reinforces` (≤ 0.3), `stacker`
  (stacking ≥ 0.75), `spreader` (≤ 0.45), `rusher` (`firstStrike` ≥ 0.6 and `attack` ≥ 0.6),
  `turtle` (`attack` ≤ 0.2), `avenger` (`retaliate` ≥ 0.6), `retakes` (≥ 0.6).
- *As built, after the first part-0 report (2026-11-15):* `stacker`, `spreader` and `rusher` are withheld
  until the second report (the pooled stacking mean is ~0.74, so the fixed bars label most opponents or
  none, and `rusher`'s `firstStrike` confidence needs about a fifth meeting with one player), and
  `turtle` is given only on this game's counts (the report could not separate a quiet player from a
  quiet game). The first report reads `attack` as persisting within a game, not shown to be a
  person's trait, and `stacking` as resting largely on one opponent-game.
- *As built, #264:* `turtle` is also withheld when the opponent attacked me within the last two turns
  (`TURTLE_QUIET_TURNS`), and every read reports `lastAttackTurn` beside the labels (the tool and the
  plan's `reads`), from the primitives (`attackedMe` or a capture from me).
- **Counter-play**, one fixed line per label:

| Label | Line |
|---|---|
| reinforcer | Attack two of its territories in one turn (it deploys on one), or size for its deploy |
| rarely-reinforces | Attack at the bare cost; spend the saving elsewhere |
| stacker | Hold in full where its stack is; expect one push |
| rusher | Garrison at first contact; no leftover on expansion |
| turtle | Out-expand it; a quiet border with it tends to stay quiet |
| avenger | Do not poke; strike only to cripple, and garrison the source |
| retakes | A capture from it needs a garrison that survives its counter |

### B2. The stores (`src/profile-store.ts`)

- `<dataDir>/profiles/players.json` (version 1): per player, keyed by the deal record's
  `playerKey(salt, id)` under the same salt, so the two join in memory and neither file holds an id.
  Each holds up to `MAX_PROFILE_ENTRIES` (30) per-game entries and the faded totals by format.
  At most `MAX_PROFILE_PLAYERS` (1000), least recently updated dropped first.
- An entry: `{ key: HMAC(my account, game), format, players, turnsSeen, source: 'live' | 'history',
  habits, ending? }`. No id, no game id, no name.
- `<dataDir>/profiles/population.json`: totals per format, a pooled `ai` profile, and a games count.
- **Folding a game** (`foldGame`): totals are updated by the difference between the new entry and
  the entry already stored under the same key (zero the first time), so folding twice, or replacing
  a `live` entry with a `history` one, never double-counts. When a game is new for that player, the
  player's totals are first multiplied by `PROFILE_DECAY` (0.9).
- **AI seats** go to `population.ai` only, never to a player key. A human who became an AI is left
  out of that game altogether unless V4 gives the turn.
- **When:** on the first read that shows the game finished — in `warapp_get_game` beside
  `recordFinalResult`, and in `warapp_wait_for_turn`'s re-read (`src/tools/push.ts`, which already
  treats `Finished` as terminal). `ending` comes from the player's final `state` through
  `PLAYER_STATE_NAMES` (`Won`, `SurrenderAccepted`, `Booted`, `Eliminated`, `EndedByVote`; anything
  else is `unknown`).
- **The per-game file after a fold:** marked `folded: 'live'` and kept until part C has tried the
  game's history once (or P2 is off), then deleted. A file untouched for `BOARD_CACHE_MAX_AGE_MS` is
  folded with `ending: unknown` and deleted, so no id-bearing file outlives the board cache.
  *As built in part B (C not built yet):* a folded file is kept until that age rule deletes it; the
  file keeps the game's seats (format, seat count, AI seats) so the age rule can fold it unread.
  *As built, #264 (backfill):* a finished game with cached boards but no per-game file (it finished
  before #263) is observed once from those boards and my cached orders and folded as `live`, the file
  marked `backfill` and dated as the board cache so it is deleted with it. It runs in `warapp_get_game`
  and in `warapp_profile_opponents`, which accepts a finished game for it; no request is made (teams only
  from GameFeed, two seats or the kept team record), and a game the stores already hold is never folded
  again. Nothing to fold reports "counts start with games played on this build"; a fold that failed
  (`failed`: a store that cannot be read or written; the next read tries again) and no data directory
  (`no-data-dir`) report their own notes.
- **The salt:** `playerRecordSalt` only reads; the code that makes the salt is private to the deal
  store's write path. Export one shared "read or make" function and use it from both stores, so two
  salts can never exist and a malformed one is still never replaced.
- Guarantees as the deal record: a missing file is empty; a corrupt file or salt is never
  overwritten (reads say `unreadable`, writes fail); everything under the path lock.
- Declare `WARAPP_PLAYER_PROFILE` in `manifest.json`, `server.json` and the README, as
  `WARAPP_PLAYER_RECORD` is.

**Tests:** fold twice gives the same totals; live then history replaces; the fade applies once per
new game; the bounds evict the least recent; an AI never reaches a player key; a corrupt file is
left alone; no id, game id or name appears anywhere in either file (assert on the serialized text).

**Done when** `warapp_profile_opponents` on a second synthetic game against the same player reports
`gamesMet: 1` and a `past-games` basis, and on a first meeting reports the `population` basis.

## 10. Part C — the finished game's history (needs P2; C1 after V1, C2 after V2)

- **C1, from standings.** After the fold, one `client.getGame(id, { history: true, settings: true })`
  with the map from the store; `historyBoards` gives un-fogged boards. From consecutive boards, for
  every player but me and my teammates:
  - **pace:** its income (base + bonuses held, exact on a clear board) ÷ the mean income of the
    players still in, at turns 3, 5, 8 and 12. A size.
  - **firstBonusTurn**, as `map-stats.ts` reads it.
  - **attack** and **targets:** of its captures from players, the share taken from the income
    leader, from its weakest neighbour, and of a member of a bonus its owner held in full.
  - **retake** and **ending**, exactly.
  The history entry replaces the live one for that game. An unreadable history keeps the live entry,
  is counted, and is not fetched again (as #132 does for stats).
- **C2, from orders**, only once V2 names the keys: a loose `historyOrders` in `src/trend.ts`, then
  `reinforce`, `stacking`, `firstStrike` and `retaliate` exactly for every pair of players, and card
  habits (a Reinforcement card held unplayed; Order Priority use).
- **Where the read happens (#312 E1, built):** the end-of-game pass (`src/tools/end-of-game.ts`)
  makes the one read, on the first read that shows the game finished — `warapp_get_game`, and (owner
  request of 2026-11-16, superseding "not inside the wait") `warapp_wait_for_turn`'s read — on a
  game-ended in-app notification in `warapp_get_notifications` (at most 2 games per call, the rest
  `pending`), and in the `warapp_my_games` sweep over the account's finished games not yet processed (`END_OF_GAME_PER_CALL`,
  2, per call, newest first, among the newest 250 only: half the store bound, their records refreshed
  each call and never pruned by the sweep's writes). The history read asks `GetMap=false` (a cached map is
  attached by id, and the client's map refresh, which would repeat the read, never runs); with no map
  cached one map-only read follows, never a second history read. It keeps the capture name-free at `<dataDir>/finished/<hmac>.json`
  (`src/finished-store.ts`: the key an HMAC of my account and the game under the shared salt; players by
  `playerKey`; 0600, atomic, at most 500, an unparsable file never overwritten), which is a processed
  mark — and so is a lasting one, `<dataDir>/finished/processed.json` (hashed record keys only, at most
  5000), written once the request is spent or the history `warapp_get_game` read with `include_history` is consumed, so a game whose record the 500 bound pruned is still never
  read again (the one exception: a game whose record and mark both aged out). The record keeps: outcome (from the player states) and the turn I was out, my pick list and award,
  every player's income (`boardIncome`), territories, armies and full bonuses on each history board,
  the boards themselves (owners by key, at most the first 30 and the last 30, `boardsOmitted` counting
  the rest; the calibration harness's truth, #318),
  what stood on each target my cached orders failed to take, the settings shape and the map id
  (`src/analysis/finished-game.ts`, pure), and on any status the final outlook line this server logged
  (`outlook`: the newest planned turn's state, held turns, ratio, `estimated` / `thin`; no id, no words;
  absent when it never planned the game). A failed request is `read-failed`, an unreadable history
  `history-unreadable` with #315's reason; neither is retried by a trigger, only by an explicit
  `warapp_get_game` with `include_history`, from that call's own read. The sweep also folds each game's
  live profile (`foldFinished`), so #273 needs no `warapp_get_game` per game; so does the notification
  trigger.
- **Processing the history (#312 E2, built):** right after a `captured` record, the same pass (no
  further request) folds the opponent profiles from the history boards — `observeTurn` over each pair
  of full boards with my cached orders where present (`observeHistory`, `src/analysis/game-lessons.ts`),
  the primitives of part A rather than C1's standing-only habits above, folded as `history` so the entry
  replaces the live one. The double count named in section 9 is guarded: when the game was folded
  before (the population holds it, or the per-game file is marked folded), a player with no entry for
  it is skipped if its entry list is full, and the population is skipped if it no longer holds the game.
  The same pass keeps the game in its map's record (`<dataDir>/maps-record/<mapId>.json`: outcomes, my
  start region and income curve, each winner's start region and income after turns 4 and 8) and adds
  its lessons (`<dataDir>/lessons.json`: per format the outcomes, how each lost game was lost, the
  turn my income first went flat, and the tracker's estimates over my cached boards against the
  history's true incomes by frontier coverage — part 0's measurement, aggregates only). Both are
  name-free (keyed by `finishedGameKey`), bounded, 0600, and never overwritten when they do not parse.
  **Read back (#312 E3), reported only (P1: no plan, ranking or estimate reads them):** `warapp_plan_picks`'
  `mapRecord` (games, my results by start bonus, the bonuses winners started in, the winners' and my median income
  after turns 4 and 8), `warapp_plan_turn`'s `pace` after turns 4 and 8, `warapp_map_stats`' `myGames`, and
  `warapp_track_opponents` full's `pastGames` (the lessons; the calibration as estimate ÷ truth by format and coverage
  band: count, mean, geometric mean, shares under half and over 1.5×). A habit whose past weighs most, at least half of
  it folded from finished histories, reads `basis: history` in `warapp_profile_opponents` and the plan's `reads`.
  **#312 item 4 is only partly met:** the calibration from past games is reported in
  `warapp_track_opponents` full (`pastGames`) only; the outlook and the estimate warnings do not report it yet.
- One request per finished game, through `WarappClient`, never retried in a loop, never for a game
  the account did not play. A request spent with no record left (the write failed; the reply showed the
  game not mine) still leaves the lasting mark; one whose reply showed the game not finished is remembered
  for the life of the process only (it may end later), so no trigger repeats it.
  With profiling off the pass makes no request at all, the signed-in account's page included.

**Done when** a synthetic finished game folds to the same habits as the same game observed live
with the fog off, and a history that does not parse changes nothing.

## 11. Part D — reporting it where it gets used

- **`warapp_plan_turn`:** a compact `reads` block — per opponent in contact, its labels and the
  habits at the confidence bar, with `n` and `basis`. No planner input yet.
- **`warapp_scout_player`:** adds `met` (games met, the read) when the store has the player.
- **`warapp_advise_diplomacy`:** shows `retaliate` and `attack` beside the deal record; its ranking
  is unchanged in this part.
- **The skill** (`skills/warapp-mcp/SKILL.md`): read `reads` at first contact and in the three-turn
  review; treat a label as a likelihood; never quote a read to another player.
- **Docs:** a CLAUDE.md paragraph, the README tool table, `docs/WARAPP-API.md` for every history
  fact with verified or unverified.

## 12. Part E — estimates the planner guesses anyway (after part 0's first report)

- **E1, income in the fog.** `EnemyIncomePrior` gains `pace?: ReadonlyMap<number, number>`; for a
  player in it, `fogPrior` uses `myIncome × pace`, every existing cap kept. Passed only at the
  confidence bar; the AI pool's pace applies to AI seats. Absent, plans are byte-identical.
- **E2, starts.** The share of a player's starts that were in the pick advisor's own list (from
  C1's boards) scales `whereabouts`' start prior. The planner does not read whereabouts.
- **E3, reply likelihoods.** `StressReply` gains `likelihood` (`reinforce` kinds from the reinforce
  rate, attack kinds from the attack rate, concentrated against spread from stacking; `null` where
  no habit speaks), and the report gains `likelyWorst`. `safe` keeps its meaning.

## 13. Part F — planner choices (each needs P1, one PR each)

Passed as `PlanInput.reads`, pure data like `tracks`. Every use blends, never trusts: `used = λ ×
read + (1 − λ) × today's assumption`, `λ = min(0.8, confidence)`.

- **H1, attack sizing.** Where armies do not cover the deploy-proof size (the sites in section 2):
  attack at the bare cost when the blended reinforce rate is ≤ 0.3; keep the armies when ≥ 0.6;
  otherwise today's behaviour. The warning states the rate and its `n`.
- **H2, two prongs.** Against a reinforcer, prefer two affordable targets of its in one turn to one
  deploy-proof one.
- **H3, front choice.** In a free-for-all, between two neighbours: attack the one that retaliates
  less, hold first against the one that attacks more.
- **H4, quiet borders.** `TACIT_QUIET_TURNS` (`src/analysis/relations.ts:72`) scales with the
  player's `firstStrike`. Still a report, never planned on.
- **H5, the border guess.** Blend `guess.ts`'s equilibrium mix with a best response to stacking.

Each ships with a miniature in a new `tests/analysis/lessons-reads.test.ts` and the golden corpus
unchanged where no read is passed.

## 14. Order of pull requests

| # | PR | Part | Waits on |
|---|---|---|---|
| — | The measurement, reported | 0 | nothing; repeat after C |
| 1 | Observe, keep the turns, `warapp_profile_opponents` for this game | A | — |
| 2 | The estimate, the stores, the fold, the AI pool | B | — |
| 3 | `reads` in the plan, scouting, diplomacy advice, the skill | D | — |
| 4 | Finished games from standings | C1 | P2, V1 |
| 5 | Finished games from orders | C2 | V2 |
| 6 | Fog income from pace; start prior; reply likelihoods | E1–E3 | the first report |
| 7 | H1–H5, one each | F | the second report, P1 |

House rules as ever: test first; `npm run test:coverage` and the typecheck before every PR;
synthetic fixtures only; `git grep` for the real account email; title each PR for the release it
should cut; never merge.

## 15. Out of scope

- Profiling teammates, or anyone in a game the account did not play.
- Any model call inside the server, or learning beyond counting.
- Timing, online hours, location or anything about the person rather than the play.
- Sharing profiles between accounts or users.
- Quoting or hinting at a read in chat.
