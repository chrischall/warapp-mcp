# warapp-mcp — plan: rule 4e fires live, and in contact (#107)

Worktree `/Users/chris/git/warapp-mcp-107`, branch `fix/stand-still-107` (from `origin/main`). Never switch
branches, never push, never touch other worktrees. Hard rules: no live network in tests or agents (never call
war.app); synthetic fixtures only — made-up maps, ids, territory/bonus/player names (the issue quotes real
names; translate them); never the real account email; never read `~/.config/warapp-mcp/session.json` or `.env`.
The planner stays pure and deterministic (ties on ascending id). TDD; green = `npm run build` AND `npm test`.
Every plan in a test must pass `validateTurn` with the same settings.

Read `gh issue view 107 --comments` and `gh issue view 104 --comments` (read-only), and rule 4e in
`src/analysis/planner.ts` (header + `// ---- 4e. never stand still` block) and its tests
(`tests/analysis/stand-still.test.ts`).

## S1 — find out why 4e did not fire live, and fix it
Live (#107): a 7-player FFA, profile `ffa, opening`, turn 2, income 5 (base 2... check the issue), army cap 8×
income. My biggest stack 6 (11 after deploying 5) borders a 4-army neutral, a member of a +2 bonus of 3
territories ("36 armies to finish" by the plan's count); other neutrals 4 and 12; no holds (frontier needing 0).
The plan: every bonus "Skip bonus … uneconomic", deploy 5 to the biggest stack ("my biggest stack"), one
interior transfer, `offence: []`, no captures, and **no rule-4e rationale line**. (Whether a "Standing still"
warning or a rule-4d frontier line appeared is being asked of the play session — do not wait for it.)
- Build synthetic boards of that shape — several variants: 7 players with most of the board fogged; enemies
  2–3 territories away; a +2 bonus whose other members are fogged or 12-army neutrals; the starting stack on a
  territory with many neutral neighbours; FFA comfort margins; base income 2 with bonuses; `armyCap: 8`; with
  and without `previousBoard`; through the `warapp_plan_turn` tool path too (`plannerSettings`, `adapt` on) —
  and find every reason 4e can stay silent where it should capture: e.g. the gate (`captured.size`, phase,
  goal), `finishCost` (a bonus with `cost: Infinity` sorting, NaN comparisons when fogged), the steps filter
  (`targets`, `gainWith`), `tryExpand` refusals (rule 4d `outgrows`, R3, sizing that ignores the deploy still
  to come), the budget/reserve that 4e may spend vs. what comfort margins or leftover rules take later, or
  rationale/warning lines removed afterwards. Fix each real cause, test first, with a test per cause.
- When 4e cannot capture, the warning must name the **actual** reason (holds leave too little / rule 4d's
  frontier stop / sizing), not always "does not fit what the holds leave".
- If 4e was in fact refused by rule 4d in an opening: in the opening phase with no capture, the frontier stop
  must not make the plan stand still — one capture that grows the frontier is still better than none (keep
  4d for every further capture). Say so in the rationale.

## S2 — contact phase falls back too (#107's second case)
Live: an 8-player FFA, profile `ffa, contact`, every neutral 15, my 15-stacks next to opponent territories
holding 4 and 0. The plan makes no capture. Agreed with the reporter: in the contact (and late) phase, a plan
with **no capture at all** falls back as well — the cheapest capture among (a) neutral captures toward the
cheapest bonus (as 4e does) and (b) enemy territories it can take at a trade of at least even (expected kills
≥ expected losses), win chance at the plan's threshold, leaving every hold covered, never one that lowers
income; prefer the one that breaks or advances a bonus, then cheapest, then id. In an FFA respect rule 2
(no second front) only when the fallback would open a front against a player that cannot currently attack
me — say which in the rationale. A warning names the attack's assumption that the owner does not reinforce
first, like other enemy attacks.
- Tests: the #107 contact shape (synthetic) → one capture of the 0-army or 4-army enemy territory from a
  15-stack, sized, holds intact; a contact board where the only enemy capture trades below even → no
  capture, warning; opening/expansion behaviour from #104 unchanged; header rule list updated (4e).

## Ship
One PR, `fix(planner): never stand still in an FFA opening or in contact (#107)`, body `Closes #107`.
