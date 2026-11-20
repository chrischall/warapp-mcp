# Plan: per-turn decision log, replay and pruning (#412)

Goal: for every turn this server plans, keep what was seen (the fogged board), what the planner decided and
why, what was actually sent (and any override), and what happened next — then use that log offline to test
strategy changes and scenarios, and prune it once a game is decided.

Owner decisions on the issue's open questions (2026-11-19):

- **Reasons:** keep the plan's `rationale` and `warnings` lines verbatim (they are already name-free: player
  ids, and the map's own territory/bonus names, which are public) AND the structured fields (goal, profile,
  offence candidates with `taken`/`why`/`cost`/`value`, conceded, expected). No player name is ever written.
- **Replay:** a LOCAL dev script (`scripts/replay-decisions.mjs`, like `scripts/calibrate.mjs`), never a
  tool, never run in CI; its pure logic lives in `src/analysis/` and is unit-tested.
- **Caps:** at most `MAX_DECISION_GAMES = 200` games and `MAX_DECISION_BYTES = 50 MB` in total; oldest
  *finished* games dropped first, never a game still running. `WARAPP_DECISION_LOG=off` switches capture
  off; `WARAPP_DECISION_LOG=full` skips compaction (keep everything while collecting data on purpose).

Conventions every task follows (read the neighbouring stores first and match them):
`src/outlook-log.ts`, `src/bonus-attempt-store.ts`, `src/trend.ts` (board cache), `src/finished-store.ts`,
`src/replay.ts`. Files 0600 in 0700 folders, atomic writes (`writeJsonAtomic` in src/map-store.ts) under
the path lock where neighbours use it, best effort (never throws into a tool), a file that exists but does
not parse is never overwritten, a `version` field. Tests live in `tests/` (vitest), TDD: write the failing
test first. `npm test` runs typecheck + biome lint + vitest — it must pass at the end of every task.
Never `rm -rf` a variable path in shell or tests (use the test helpers' temp dirs).

---

## Task 1 — the store: `src/decision-log.ts`

File `<dataDir>/decisions/<gameId>.json`, version 1, `{ version, gameId, playerId, status: 'active' |
'finished' | 'compacted', turns: { [turn]: DecisionEntry } }`.

`DecisionEntry` (name-free):
- `board`: the board as seen this turn, fog levels included — reuse the `BoardState` shape/encoding the
  board cache uses; store it delta-encoded against the previous logged turn's board (only territories whose
  owner/armies/fog changed), with a full board every 10th turn and at the first logged turn so any turn is
  rebuildable. Provide `boardAt(log, turn)` to rebuild.
- `input`: what the planner read that cannot be rebuilt from the map store + settings record
  (`src/replay.ts`) + the board: e.g. income, cards/hand, opponent estimates and tripwires/untrusted,
  truces/relations, siege and bonus-attempt memory, goal requested, avoid, enemy_deploy… Decide the exact
  field list from `PlanInput` (src/analysis/plan/shared.ts) and `livePlanSetup` (src/tools/turn.ts).
  INVARIANT (tested in Task 4): with the same code, re-running `planTurn` on the rebuilt input reproduces
  the logged deploys and moves.
- `planner`: `{ version }` (package version from src/version.ts).
- `decision`: goal, profile (format/standing/etc.), deploys, moves, expected (nextIncome, captures,
  bonusesCompleted, nextIncomeIfConcededFall, bonusesAtRisk), conceded, offence entries, enemyDeploy,
  rationale lines, warnings lines, outlook state.
- `sent?`: the orders actually sent (deploys/moves/cards) and `override?: { by: 'hand' | 'agent'; reason?:
  string }` when they differ from `decision`.
- `next?`: what happened, filled when the following turn is logged: actual income, territories
  gained/lost vs the plan's captures/holds, bonuses held, whether I was eliminated.

API: `recordDecision`, `recordSent`, `recordOutcome` (or one `updateDecisionLog` with a mutator),
`readDecisionLog`, `boardAt`, `listDecisionLogs`, `pruneDecisionLogs` (caps above, finished first, never
active), `compactDecisionLog` (Task 3). Planning a turn again replaces that turn's entry. Unit tests cover
encode/decode round trip, delta + periodic full boards, replace-on-replan, unparseable file untouched,
caps/pruning order, `off` mode writes nothing.

## Task 2 — capture wiring

- `warapp_plan_turn` (src/tools/turn.ts, beside `writeBoardCache`/`recordOutlook`): write the entry for a
  non-what-if plan (same `whatIf` rule as the board cache: an explicit `goal` or `enemy_deploy` is a
  what-if and is NOT logged as the turn's decision). When the previous turn has an entry without `next`,
  fill its `next` from this turn's board/income.
- `warapp_submit_turn`: after a confirmed send (where `writeOrdersCache` runs), `recordSent` with the sent
  orders; mark `override` when they differ from the logged decision for that turn (`by: 'agent'` unless
  the caller says otherwise). Add an optional input `override_reason` (string, ≤ 500 chars, stored as
  given) and optional `override_by: 'hand' | 'agent'`; update the tool description briefly. If no decision
  was logged for that turn, record `sent` with `override: { by: 'hand' }` only if orders came from outside
  the planner — else just `sent`.
- Tests: tool-level tests in the style of the existing turn/submit tests (mocked bridge/feed) proving an
  entry is written, what-ifs aren't, re-plan replaces, submit records `sent` and override + reason, `next`
  gets filled. No player name appears anywhere in the written file (assert on a fixture with named players).

## Task 3 — pruning, compaction, portability

- `compactDecisionLog`: once a game is finished (hook into the end-of-game pass in
  src/tools/end-of-game.ts, after the record is captured, and also the `warapp_my_games` sweep path that
  runs the pass), unless `WARAPP_DECISION_LOG=full`: keep full entries for *interesting* turns — any
  override, any turn whose outlook state changed from the previous turn, the last 5 turns before an
  elimination/loss, the first 3 turns, turns where actual next income fell short of `expected.nextIncome`
  by ≥ 20%; every other turn keeps only a summary (`goal`, `expected.nextIncome`, `next`, outlook state) and
  drops `board`/`input`/`rationale`. Re-base the delta encoding so kept boards stay rebuildable. Status →
  `compacted`. Idempotent.
- `pruneDecisionLogs` runs after writes (like `pruneBoardCaches`), at most once per process interval.
- Add `decisions` to `STORES` + `RULES` in src/state-bundle.ts (per game: `/^(\d{1,12})\.json$/`, kept for
  finished games too — `allGames: true`) so export/import carries it; update the state-bundle tests.
- `warapp_healthcheck` (or wherever stores are summarised) reports the decision-log count/bytes if the
  other stores are reported there; skip if not.

## Task 4 — replay and scenarios

- Pure module `src/analysis/decision-replay.ts`: given a decision log + the `Replay` from src/replay.ts
  (game, settings, map), rebuild each logged turn's `PlanInput`, run `planTurn` (optionally with a scenario
  patch: `goal`, `enemyDeploy`, estimate overrides, any planner option/flag object the planner accepts),
  and return per turn: same/different deploys+moves, the logged vs new goal, expected next income old vs
  new, and a score against `next` (did the logged plan's expectation hold; would the new plan's captures
  have been possible given what happened). Aggregate: turns compared, % identical, differences by goal.
- Test the INVARIANT: an entry written by Task 2's capture, replayed with unchanged code and no scenario,
  reproduces the logged deploys/moves exactly. Plus scenario tests.
- `scripts/replay-decisions.mjs` (reads `dist/`, like calibrate.mjs): `--data-dir`, `--game <id>`
  (default all), `--goal`, `--enemy-deploy`, `--scenario <json file>`, `--json`, and
  `--export-fixtures <dir>` which writes each interesting turn (see Task 3's rule) as a standalone JSON
  fixture (rebuilt full board + input + logged decision + next), name-free. Prints aggregates only by
  default (no ids/names), per-turn detail with `--json`.
- Document how to run it in docs/PLAN-PROFILES.md's calibration section or a short README dev note.

## Task 5 — docs and wrap-up

- CLAUDE.md: a bullet for the decision log (store, capture points, compaction, caps, env switch, replay script) in the same style as the neighbouring store bullets, and the new submit inputs where `warapp_submit_turn` is described.
- README: the new `warapp_submit_turn` inputs; a short "Decision log" section (what is kept, the env
  switch, the caps, the replay script). Keep this file (docs/PLAN-DECISIONS-412.md) as the design record.
- `npm test` green; `npm run build` green; `node scripts/replay-decisions.mjs --help` works after build.
