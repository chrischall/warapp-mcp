# Plan: Westeros batch, round 2 (2026-11-20)

Finishes the owner-approved work from the strategy review. Every decision is recorded as an "Owner decisions
(2026-11-20)" comment on its issue: read the issue and its comments (`gh issue view <n> --repo
chrischall/warapp-mcp --comments`) before writing anything. Each task ships the issue's remaining items so the
issue can be CLOSED, or names exactly what is left and why.

- **PR 3, estimates and outlook** (branch `feat/westeros-batch-2`):
  - #419: the fog ceiling is the median map-winner pace, needing 3 or more records filtered by format and settings (#437's `maps-record`).
  - #436: outlook states, and the surrender line as advice only.
  - #418: the under-read floor from proof, and the gradual over-read tripwire.
- **PR 4, contact play** (branch `feat/westeros-batch-2b`, cut from the end of PR 3):
  - #417: the 1v1 race for vacated land, the breach force, and the hidden-land line in the accept-surrender preview.
  - #420: P1 amended for never-attacking neighbours only; total holds capped at 50% of income (70% when behind); full deploy on each opponent's most valuable border.
  - #421: 25% of income to the strike stack each turn; break and all-in completion spends.

Rules (same as `docs/PLAN-WESTEROS-BATCH.md`):
- TDD.
- The planner stays pure and deterministic.
- Measure golden-corpus churn (`tests/analysis/planner-golden.test.ts`, all 6253 plans, old vs new) and report it in each commit: plans and orders changed, captures, next income, concessions. Update hashes only for explained changes. A regression needs a justification or a narrower rule.
- Report-only changes assert that orders are unchanged.
- Name-free.
- Update the CLAUDE.md bullet each change touches.
- Declare any new env var in manifest.json, server.json and mint.yaml.
- `npm test` and `npm run build` green before each commit. One commit per issue (or per item for big ones).
- In each PR body, use `Closes #n` only when every item of that issue is shipped; otherwise use `Refs` and list what remains.

#419 caveat (owner): every map record so far is a loss. Report the replay error (estimate ÷ truth) before and after, using the decision-log truth and `lessons.json` calibration.
#436: the surrender line is advice only (`surrenderLine`); the server never acts on it. Play policy lives outside the repo.
