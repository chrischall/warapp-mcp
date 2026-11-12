# warapp-mcp — turn planner plan

Branch `feat/turn-planner` in the worktree `/Users/chris/git/warapp-mcp-planner` (never switch
branches, never touch `/Users/chris/git/warapp-mcp` — another build is running there).
Pure analysis: **no tools, no I/O, no network, no changes under `src/tools/`** (tool wiring
comes later, after the live-board branch merges). Build on `src/analysis/*` and `src/board.ts`.

## P1 — `src/analysis/planner.ts`: plan one turn

`planTurn(input) → TurnPlan`.

Input: the map graph + bonuses (existing analysis types), a `BoardState`, `me` (player id),
`income` (armies to deploy this turn — the caller computes it; also expose a helper using the
existing income code), settings `{ offensiveKillRate, defensiveKillRate, luckModifier,
roundingMode, oneArmyStandsGuard, multiAttack, allowTransferOnly }`, and options
`{ goal?: 'expand' | 'complete-bonus' | 'defend', focusBonusIds?, reserve? }`.

Output:
```
TurnPlan {
  deploys: { territoryId, armies }[]          // sums to income exactly
  moves:   { from, to, armies, kind: 'attack' | 'transfer', reason }[]
  expected: { captures: territoryId[], bonusesCompleted: bonusId[], nextIncome }
  warnings: string[]                           // e.g. luck > 0 → margins added, fogged neighbours
  rationale: string[]                          // one line per decision, for a human
}
```

Rules the plan must obey (each with a test):
- **Army accounting.** A territory's outgoing armies ≤ its armies after deploy − (1 when
  `oneArmyStandsGuard`). Without `multiAttack`, armies that move this turn do not move again,
  and armies arriving by capture cannot attack this turn.
- **Capture cost** uses `armiesToTake` (0% luck, straight round). With `luckModifier > 0` add a
  safety margin (document the rule) and say so in `warnings`.
- **Targets:** only visible neutrals (and visible enemy territories when `goal` allows) adjacent
  to a territory I own; never fogged targets (army count unknown) — warn instead.
- **Bonus focus:** prefer captures that complete or advance the bonus with the best
  value per remaining capture cost, with ties broken by fewest external borders; a bonus that
  can be completed this turn is taken first; never plan into a bonus containing a territory
  whose armies make it uneconomic (e.g. a 10-army wasteland) unless `focusBonusIds` asks.
- **Deploys** go where they enable the chosen captures; leftover income goes to the most
  exposed border territory (adjacent to a visible enemy, else to the most fogged neighbours).
- **Defence:** when a visible enemy with E armies borders my territory T, warn if T could be
  taken next turn (`armiesToTake(armies(T)) ≤ E + their likely deploy`), and in `defend` goal
  deploy to prevent it before expanding.
- Deterministic: same input → same plan (stable ordering by id).

Tests:
- A synthetic replica of a real opening (3 starts, each with 4 armies, 2-army neutral
  neighbours, income 5, kill rates 60/70, guard on): the plan deploys 5 to the start in the
  best bonus and makes exactly the 3-army captures that fit (no plan ever leaves a capture
  under-armed).
- Completion: a bonus one capture from done is completed before other expansion.
- Wasteland bonus avoided; fogged target produces a warning, not a move.
- Accounting property test over random small boards: deploys sum to income, no territory
  over-commits, every attack meets `armiesToTake`.
- Defence: a visible 6-army enemy next to a 2-army border triggers the warning and, under
  `defend`, a deploy that makes the border hold.

## Rules
TDD; `npm run build`, `npm test`, `npm run test:coverage` (keep the repo's thresholds),
`npm run typecheck` green. Stage exact paths; commit `feat: turn planner …` with the
Co-Authored-By trailer. No real account data or captures in fixtures.
