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
- **Caps:** at most `MAX_DECISION_GAMES = 1000` games and `MAX_DECISION_BYTES = 500 MB` in total; oldest
  *finished* games dropped first, never a game still running. `WARAPP_DECISION_LOG=off` switches capture
  off; `WARAPP_DECISION_LOG=full` skips compaction (keep everything while collecting data on purpose).
- **No analysis gaps (owner requirement 2026-11-19).** The log exists so every game can later be analysed
  TURN BY TURN with the true end-of-game figures — closing today's gaps (the board cache keeps only the
  newest 10 turns; the finished record keeps only the first and last 30 history boards; turns played without
  a plan are not recorded at all). So: (a) every turn of every game the account plays gets an entry — a
  planned turn a full one, any other turn the server sees (a board read by any tool that writes the board
  cache) at least an observation entry (board + what was sent if known); (b) compaction NEVER drops a turn's
  fogged board, decision, rationale/warnings, sent orders, override, `next`, `truth` or `accuracy` — it may
  only drop the bulky replay `input` of uninteresting turns; (c) the end-of-game truth is taken from the FULL
  history the pass reads, before finished-store's head/tail cut, for every turn — including turns with no
  logged entry (a `truth`-only entry), so the true course of the whole game is kept even for turns played
  in the web client; (d) the caps above are generous on purpose; a game is only ever pruned whole, never
  thinned below (b).

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
- Observation entries (no-gaps rule (a)): wherever the board cache is written for a turn with no entry yet
  (`writeBoardCache` callers: warapp_track_opponents, warapp_locate_opponents, warapp_get_relations,
  warapp_plan_turn what-ifs, and `boardHistory` when it fills missing turns from GameFeed history),
  record an entry `{ kind: 'observed', board, source: 'live' | 'history' }` — never overwriting a planned
  entry; a later plan of that turn upgrades it. `warapp_submit_turn` with no planned entry records
  `sent` on the observation (or a new minimal entry).
- Tests: tool-level tests in the style of the existing turn/submit tests (mocked bridge/feed) proving an
  entry is written, what-ifs aren't, re-plan replaces, submit records `sent` and override + reason, `next`
  gets filled. No player name appears anywhere in the written file (assert on a fixture with named players).

## Task 3 — pruning, compaction, portability

- `compactDecisionLog`: once a game is finished (hook into the end-of-game pass in
  src/tools/end-of-game.ts, after the record is captured, and also the `warapp_my_games` sweep path that
  runs the pass), unless `WARAPP_DECISION_LOG=full`: per the no-gaps rule (b), EVERY turn keeps its fogged
  board, decision (goal, profile, orders, expected, conceded, offence, enemyDeploy), rationale, warnings,
  sent, override, next, truth and accuracy. Only the replay `input` is dropped, and only for uninteresting
  turns; *interesting* turns keep it — any override, any turn whose outlook state changed from the previous
  turn, the last 5 turns before an elimination/loss, the first 3 turns, turns where actual next income fell
  short of `expected.nextIncome` by ≥ 20%, and turns whose accuracy shows an estimate off by > 1.5× or
  < 0.5×. Status → `compacted`. Idempotent. A test asserts no turn loses its board, decision or truth.
- **End-of-game truth beside the estimates (owner request 2026-11-19).** When the end-of-game pass captures
  a finished game's history (src/tools/end-of-game.ts, `captured` status), BEFORE compacting, write into the
  decision log a `truth` block for EVERY turn of the game (no-gaps rule (c): read from the full history the
  pass reads, before finished-store's head/tail cut; a turn with no entry gets a truth-only entry), from the history board for that turn (the same board
  index the #318 calibration uses: estimate on turn T vs the opponent's income on history board T − 1 — reuse
  that alignment, don't invent another): for each opponent its true income (`boardIncome`), armies,
  territories, full bonuses, and its true start-of-turn armies on every territory my logged board showed
  fogged or owner-only. Beside it an `accuracy` block comparing what the turn's entry logged with the truth:
  per opponent estimate ÷ true income (and the estimate's source/coverage/thin flags as logged), my outlook
  state vs the state the true figures give (`gameOutlook` on true incomes/armies), and how many fogged
  territories hid an enemy stack ≥ my income. Also a per-game `accuracySummary` (mean/geo-mean
  estimate÷truth, share under 0.5 / over 1.5, outlook right/wrong counts, by coverage band as #318 does).
  The truth and accuracy blocks are KEPT by compaction for every turn (they are small numbers), and the
  summary is kept. Ids/numbers only, never names. A turn the history itself lacks is listed in
  `truthMissing` (never because of finished-store's cut, which this must run before).
  Tests: a synthetic finished game whose history differs from the logged estimates produces the right
  ratios, outlook verdicts and summary; re-running the pass is idempotent.
  (Review: compaction runs only once the history is captured — a failed read leaves the log whole for the
  `include_history` retry, which writes the truth and then compacts; the truth starts no log for a game
  with none logged, so truth-only files never crowd real logs out of the prune budget.)
  (Review: a finished game whose pass captured no history — `read-failed`, `history-unreadable` — or ran no
  pass at all — `WARAPP_PLAYER_PROFILE=off`, from the finished read or the `warapp_my_games` sweep window — has
  its log marked `finished` without compacting (`finishDecisionLogs`), so only games still running stay
  protected from the prune; the `include_history` retry still writes the truth and compacts.)
- `pruneDecisionLogs` runs after writes (like `pruneBoardCaches`), at most once per process interval.
- Add `decisions` to `STORES` + `RULES` in src/state-bundle.ts (per game: `/^(\d{1,12})\.json$/`, kept for
  finished games too — `allGames: true`) so export/import carries it; update the state-bundle tests.
  (Review: export carries the decision logs newest first up to `MAX_EXPORT_DECISION_BYTES` = 16 MiB, the
  rest counted in `leftOut.decisionLogs`, so they can never push a bundle past what import accepts.)
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
- The script also reports estimate accuracy from Task 3's `truth`/`accuracy` blocks: per game and overall,
  estimate ÷ truth by coverage band and by estimate source, outlook right/wrong — and, under a scenario that
  changes estimation (e.g. a planner/estimate option), how the new estimates would have scored against the
  same truth (`--accuracy` prints just this section).
- Document how to run it in docs/PLAN-PROFILES.md's calibration section or a short README dev note.

## Task 5 — docs and wrap-up

- CLAUDE.md: a bullet for the decision log (store, capture points, compaction, caps, env switch, replay script) in the same style as the neighbouring store bullets, and the new submit inputs where `warapp_submit_turn` is described.
- README: the new `warapp_submit_turn` inputs; a short "Decision log" section (what is kept, the env
  switch, the caps, the replay script). Keep this file (docs/PLAN-DECISIONS-412.md) as the design record.
- `npm test` green; `npm run build` green; `node scripts/replay-decisions.mjs --help` works after build.

## Extended by v2 (#437)

`docs/PLAN-DECISION-LOG-V2.md` extends this design, additively (the log `version` stays 1, old logs read as
they are): per turn the planner build, wall-clock `times`, `firstMover`, `cards` and `checks`; per game
`events`, `seats`, `join`, `opponents` and the `picks` phase; the finished record's game kinds (lottery,
no-show, legacy, team) kept out of the aggregates; and `scripts/review-export.mjs`, which joins each game's
log with its end-of-game record and aggregate entries into one file per game for a strategy review.
