# Plan: decision log v2 — capture what the strategy review had to reconstruct (#437)

The 2026-11-20 strategy review (36 finished + 17 running games, turn by turn against end-of-game truth)
found that #412's decision log covers most of what a review needs, but not everything. This plan closes the
rest so the next review runs from stored data alone. Read #437 (`gh issue view 437 --repo chrischall/warapp-mcp`)
and the decision-log code first: `src/decision-log.ts`, `src/tools/decision-capture.ts`, `src/tools/end-of-game.ts`,
`src/analysis/decision-truth.ts`, `src/finished-store.ts`, `src/lessons-store.ts`, `scripts/replay-decisions.mjs`,
and CLAUDE.md's decision-log and end-of-game bullets.

Conventions: everything name-free (player ids, never names; no free text from other players). Additive only: a
new optional field on an entry or log; the log `version` stays 1 unless a reader would misread old files (then
bump and keep reading v1). Old logs must still read. 0600/0700, atomic, path-locked, best effort, never throws
into a tool. TDD (failing test first), tests in `tests/`. `npm test` (typecheck + lint + vitest) and `npm run
build` green at the end of every task. Every new env var declared in manifest.json, server.json and mint.yaml
(CI strict surface lint). Never `rm -rf` a variable path. Compaction (#412 rule (b)) must keep every new
per-turn field below — they are small — except bulky ones you mark as replay-only.

## Task 1 — per-turn additions
- `planner`: add `build` — the git commit when the server runs from a checkout (read once at startup from
  `.git` without spawning a process if feasible, else a hash of `dist/bundle.js`), beside `version`.
- `times`: `plannedAt` (ISO, set by recordDecision), `sentAt` (set by recordSent), and the turn's boot deadline
  when the game read gives it. (This log may hold wall-clock times; note it in the header comment.)
- `firstMover`: the plan's `firstMover` (who, source).
- `cards`: the hand (card types and counts, mine only), the plan's card advice offered (`cards.advice`: kind,
  target ids, reason code — no prose) and which were played (from `sent`).
- `checks`: at submit, the preview's commander check result, the weakest 5 headroom rows (territory, take-at,
  protects), `belowPlan` entries, chat warnings if any; and when `warapp_check_plan` runs for that turn, its
  `safe`, `worst` (summary numbers), `atRisk` counts. Latest per turn wins.
Tests: each field written by the capture points (plan, check_plan, submit), kept through compaction, old logs
still read.

## Task 2 — per-game events and context
- `events: { turn, kind, player?, detail? }[]` on the log (bounded, e.g. 500): seat state changes read from
  GameFeed on any tool that reads the game (booted, surrendered, surrender-accepted, eliminated, turned-AI,
  ended-by-vote — diff against the last seen states kept in the log), a pending surrender seen (`surrenderPending`),
  my acceptance sent (warapp_accept_surrender confirmed), my own surrender (warapp_surrender confirmed) with my
  income, the strongest estimate and the outlook state at that moment. Never twice for the same change.
- `join`: when warapp_join_game confirms, the lobby's name-free settings template key (the `nameFreeSettings`
  shape hash plus a few readable flags: format, players, LD, commanders, kill rates, luck, fog, cards on) and
  which join-policy checks it passed/broke (from the open-games record the tool already reads).
- `opponents`: per opponent id, first-seen turn and their level / ranked record if any tool already read it
  (warapp_scout_player, GameFeed player fields) — never an extra request just for this.
Tests per event kind, dedup, bound, hosted path unaffected.

## Task 3 — the picks phase
- A `picks` block on the log: warapp_plan_picks' output summary (primary ids, fallback ids, the top scores,
  warnings' codes, award orders judged, coverage alternative if any), the list warapp_submit_picks sent and
  read back, and on turn 1 the award read (`loadAward`: which picks were granted, the opponents' proven starts).
Tests: each written once by its tool; re-plan replaces the advisor summary.

## Task 4 — finished-record and aggregate hygiene
- Game kind tags in the end-of-game record and the aggregates: `lottery` (lotteryOf), `no-show` (I never
  committed a turn / booted before turn 2), `legacy` (no decision log and no board cache for it), `team`.
  `lessons.json`, `maps-record` and the profile folds skip lottery and no-show games (counted apart:
  `excluded: { lottery, noShow }`); the summary views say so.
- `howLost.turn` for surrenders (the turn my seat left, from the history or GameFeed), commander armies counted
  (not null) where a commander stood, and `failedAttacks` without exit-turn artefacts (orders of the turn I left).
- `maps-record` entries carry the format/settings key; `mapRecordSummary` and the views filter by the current
  game's format (and LD/commanders) and say how many records matched.
Tests for each; existing records still read.

## Task 5 — review export, docs
- `scripts/review-export.mjs` (local dev script like calibrate/replay; reads `dist/`): `--data-dir`, `--out <dir>`,
  `--game <id>`; writes one JSON per game joining the decision log (boards rebuilt per turn on request with
  `--boards`), the finished record, the map record entry, events, picks and join context, plus an `index.json`
  (game id, kind, format, map, outcome, turns, which sources exist). Name-free. 0600 files in a 0700 dir.
- CLAUDE.md and README: the new fields, the export script, the kind tags. Note in docs/PLAN-DECISIONS-412.md
  that v2 extends it.
