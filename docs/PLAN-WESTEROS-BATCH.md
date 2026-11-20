# Plan: the Westeros-relevant batch (2026-11-20)

Issues found in the strategy review that help large free-for-alls on city/castle maps (and every game).
Two PRs, built in order on stacked branches:

- **PR 1 — expansion and reporting** (branch `feat/westeros-expansion`): #438, #439, #440, #441, #442, #443,
  #444, #424.
- **PR 2 — contact play** (branch `feat/westeros-contact`, cut from the end of PR 1): #417, #418, #420, #421.
- **PR 3 — estimates and outlook** (branch `feat/westeros-outlook`, cut from the end of PR 2 after #437 has
  merged and been merged in): #419, #436. Owner decisions are recorded as comments on each issue (read them):
  #419 — the fog ceiling is max(my income, the MEDIAN past winner's income at this turn on this map) with 3+
  records (filtered by format/settings, #437), else a per-format pace; the #368 midpoint stays; report replay
  error before/after (records are all losses). #436 — outlook follows both incomes and trend, `unknown` when
  the range spans both thresholds, no lead claims at low coverage, a pace line; surrender line = my income
  < 2/3 of the strongest opponent's for 3 consecutive turns with no bonus in reach that closes the gap,
  reported as advice only (`surrenderLine`), never acted on by the server.

Out of scope: #445 (open questions), #415 and #437 (their own branches, in flight).

**PR 2 closes none of its issues** (review): each commit ships only part of its issue, so the PR body says
`Refs #417, #418, #420, #421` — never `Closes` — and the issues stay open with the deferred items below until
each is shipped or filed as its own follow-up issue (whoever opens the PR files them first if they are to close):
- #417: the 1v1 "expansion last" lift; keeping the stacks facing the old wall as a breach force; the
  accept-surrender preview's hidden-land count (needs the leaver's total territory count).
- #418: the floor from captures with every source in view (the under-read side); the over-read tripwire.
- #420: full deploy on one border per opponent with stack + top-up on the rest; observed sizing for neighbours
  that never attack (needs opponent-profile reads in the planner, owner decision P1); the 50%/70% cap on
  total holds.
- #421: a fixed share of income for the strike stack ahead of margins; the "break" and "all-in completion"
  stockpile spends.

Each issue is one task. Read the issue (`gh issue view <n> --repo chrischall/warapp-mcp`) and the CLAUDE.md
bullets for the code it touches before writing anything. Rules for every task:
- TDD: failing test first (a miniature board in the style of `tests/analysis/lessons.test.ts` or the
  existing planner tests).
- The planner stays pure and deterministic. A behaviour change must be measured on the golden corpus
  (`tests/analysis/planner-golden.test.ts` + `tests/analysis/golden/`): report in the commit message how
  many plans/orders changed, captures gained/lost, next income up/down, warnings added. Update the golden
  hashes only for changes you have explained; a regression (lower next income, lost captures, new
  concessions) needs an explicit justification or a narrower rule. Keep golden churn small: gate a rule
  to the cases the issue describes.
- Report-only changes (rationale lines, `sinceLastTurn`, card advice) must not change orders: assert it.
- Name-free everywhere; no real player names in tests or docs.
- Update the CLAUDE.md bullet the change touches (concise, same style), and docs/STRATEGY.md if a rule
  changes there.
- `npm test` (typecheck + biome lint + vitest) and `npm run build` green before committing. One commit per
  issue, conventional subject (`feat(planner): …` / `fix(planner): …`), body ends with the two attribution
  lines.
