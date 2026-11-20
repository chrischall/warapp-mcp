# Plan: the Westeros-relevant batch (2026-11-20)

Issues found in the strategy review that help large free-for-alls on city/castle maps (and every game).
Two PRs, built in order on stacked branches:

- **PR 1 — expansion and reporting** (branch `feat/westeros-expansion`): #438, #439, #440, #441, #442, #443,
  #444, #424.
- **PR 2 — contact play** (branch `feat/westeros-contact`, cut from the end of PR 1): #417, #418, #420, #421.

Out of scope: #419 and #436 (owner decisions pending), #415 and #437 (their own branches, in flight).

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
