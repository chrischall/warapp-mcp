# warapp-mcp — plan: next income counts conceded bonuses (#109)

Worktree `/Users/chris/git/warapp-mcp-109`, branch `fix/next-income-conceded` (from `origin/main`). Never switch
branches, never push, never touch other worktrees. Hard rules: no live network (never call war.app); synthetic
fixtures only (made-up names — the issue quotes real ones); no email; never read session.json or .env. Planner
stays pure and deterministic. TDD; green = `npm run build` AND `npm test`. Read `gh issue view 109` (read-only).
(A parallel branch is changing rule 4e in planner.ts; keep this change local to the `expected` / frontier
output and the concession bookkeeping so the two merge cleanly.)

## N1 — report the income a plan puts at risk
Live: income 19 (5 base + four bonuses); the plan concedes two bonuses (+3, +4; "conceding bonus …") and
withdraws from one of their borders, yet `expected.nextIncome` stays 19. If the conceded borders fall, next
income is 12.
- Keep `expected.nextIncome` meaning "if every territory the plan keeps and captures is held" — but a bonus the
  plan **withdraws from** (moves armies out of a conceded member, or concedes a member with no garrison left)
  is not "kept". Decide carefully and document in the header: the clean contract is two figures:
  `expected.nextIncome` (held, as today) and a new `expected.nextIncomeIfConcededFall` (number) plus
  `expected.bonusesAtRisk: [{ bonusId, name, value, conceded: territoryIds[] }]` — the bonuses held now (or
  completed this turn) with at least one member the plan concedes; `nextIncomeIfConcededFall` = income without
  them, computed by the single income rule (`boardIncome` via `incomeAfter`, negatives/overlaps included).
  Omit both (or empty/equal) when nothing is conceded.
- A warning when the at-risk figure is lower: "This plan concedes bonus X (+3), Y (+4): next income 19 if they
  hold, 12 if the conceded borders fall."
- The frontier rationale line's "next income" names both when they differ.
- `warapp_plan_turn` compact view (`src/tools/turn.ts`) includes the new fields when present; tool description
  mentions them; SKILL.md's "Supervising the planner" mentions reading `nextIncomeIfConcededFall`.
- **Tests:** the #109 shape (synthetic: four held bonuses, two conceded) → nextIncome 19, ifConcededFall 12,
  bonusesAtRisk lists both, warning text; nothing conceded → fields absent and today's output; a conceded
  border of a bonus completed this turn counts; overlapping/negative bonus handled by the income rule; tool
  output test.

## Ship
PR `fix(planner): report the next income a plan's concessions put at risk (#109)`, body `Closes #109`.
