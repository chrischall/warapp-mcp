# warapp-mcp — phase 12 plan: the planner acts on what it builds (#101, #102, #103, #104)

Worktree `/Users/chris/git/warapp-mcp-planner7`, branch `fix/planner-live-7` (from `origin/main`). Tasks run
in order in this one worktree (they all touch `src/analysis/planner.ts`); one PR at the end. Never switch
branches, never push, never touch other worktrees. Hard rules: **no live network in tests or agents (never
call war.app); synthetic fixtures only (made-up maps, ids, names); never a real game id, map, territory,
bonus or player name in code, tests, comments or docs (the issues quote real names: translate them into
made-up ones); never the real account email; never read `~/.config/warapp-mcp/session.json` or `.env`.**

The planner stays **pure and deterministic** (ties on ascending id; no I/O). Every new decision adds a
`rationale` line; every refusal or concession a `warning`. Plans stay valid: the lessons suites
(`tests/analysis/lessons*.test.ts`) must pass, including "every plan passes `validateTurn`". Existing test
expectations change only where the behaviour change is intended — say which, and why, in the commit
message. Update the planner's header rule list (and CLAUDE.md / the skill's "Supervising the planner"
section where an item there is now fixed — trim it) for each rule you add or change. TDD; green =
`npm run build` AND `npm test` (typecheck included).

Read each issue first: `gh issue view <n> --comments` (read-only). They describe live games; reproduce the
*shape* on a synthetic board.

## T1 — never stand still in the opening (#104)
Live: a 7-player FFA, turn 2, income 5, every adjacent neutral 4 or 12. Every bonus failed the economy test
("Skip bonus …: uneconomic"), so the plan deployed everything to one stack and attacked nothing.
- In the opening and expansion phases, when the plan would otherwise make **no capture at all** (no
  expansion, break, finishing off or strike), take the best affordable neutral capture toward the bonus
  with the fewest armies to finish (ties: higher value, then lower id) — the "cheapest bonus" even when it is
  uneconomic — as long as it leaves no hold (rule 1 / rule 1c) uncovered and it uses armies that would
  otherwise sit idle. Use the existing capture sizing (kill rates, luck margin, `min_win_chance`). The
  rationale says why ("nothing passed the economy test; standing still is worse than the cheapest
  expansion"). A negative-value bonus is never the target.
- Army cap (`settings.armyCap`, ×income): when set, armies above the cap are wasted, so spending them is
  free. Apply it as far as it is cheap and exact: if my total armies after deploy exceed `armyCap × income`,
  the fallback capture above fires even outside the opening/expansion phases, and the rationale says so.
  Keep the existing "the model does not apply it" warning only for what is still not modelled (reword it).
- **Tests:** (a) the #104 shape (several players, 5 income, neutrals of 4 and 12, every bonus uneconomic) →
  one capture of a 4-neutral toward the cheapest bonus, sized correctly; (b) a threatened border still gets
  its hold first and the fallback uses only what is left (none left → no capture, a warning); (c) a board
  where an economic bonus exists → today's plan exactly; (d) army cap exceeded in a later phase → the
  fallback fires; (e) only negative bonuses nearby → no fallback capture.

## T2 — commit to the closest bonus (#101)
Live: a 1v1, 5 income, no bonus held by turn 7; over turns 5–7 each plan advanced a different bonus (one
attack each into two large bonuses, then two others), completing none. Overriding to the two small adjacent
bonuses already started left both 2–3 captures from completion. A later turn moved the free deploy away from a
bonus started the turn before, and one bonus's "N to finish" changed from 3 to 6 between consecutive plans.
- While **no bonus is held** (and more generally in the expansion phase), rank expansion targets by how
  soon they complete a *first* bonus: armies (or turns at current income) to finish the bonus, counting
  territories I already hold in it. Concentrate captures on the closest bonus (then the next closest) instead
  of spreading one attack into each of several large bonuses. A capture into a bonus that this turn's plan
  cannot finish and that is not the closest is made only with armies the closer target cannot use.
- **Stability:** given `previousBoard`, a bonus I advanced last turn (captured a member of since then) keeps
  priority unless another bonus is **strictly** closer to completion. Say so in the rationale.
- **"to finish" consistency:** investigate why the same bonus reported "3 to finish" one turn and "6" the
  next (e.g. counting fogged members, other players' members, or territories vs. armies inconsistently).
  Fix the bug if there is one and make the wording say which unit it is; if it is correct, document why in
  the commit message.
- **Tests:** (a) the #101 shape: two large bonuses with many members missing and two small adjacent bonuses
  each with one member held → captures concentrate on the small ones; (b) stability with `previousBoard`:
  the bonus advanced last turn keeps priority over an equally close one, and loses it to a strictly closer
  one; (c) the "to finish" figure for a bonus is the same whether computed with or without unrelated changes
  elsewhere on the board (the regression the issue saw); (d) once a bonus is held, existing behaviour is
  unchanged where it should be (state which expectations moved).

## T3 — Local Deployment: a bonus's own armies defend it (#103)
Live: Local Deployment on, income 15 = 5 free + three bonuses (+3, +4, +3). The plan conceded the +3 bonus
("holding all 2 threatened borders needs 11, more than 3 × its worth"), deployed its 3 local armies on an
**interior** member as "its most threatened member", **transferred them out**, and withdrew 2 each from the
two threatened border garrisons.
- With Local Deployment, the holding cost compared against a bonus's worth **leaves out the bonus's own
  local pool** (those armies cannot be deployed anywhere else): cost = max(0, cost − its pool).
- The bonus's local deploy goes to its **most threatened border member** (a member next to a threatening
  enemy; ties by most threatened, then id) — never an interior member while a border member is threatened.
  Fix "most threatened member" so an interior member (no enemy neighbour) never wins over a threatened one.
- A bonus that is held but may fall keeps its garrisons and its local deploy: armies deployed from its pool
  this turn are never moved out the same turn, and the border garrisons are withdrawn only when the bonus
  truly cannot be held (even with its pool and every free army the plan can give it, the threat exceeds it).
  Withdrawing turns "might lose it" into "certainly loses it"; the warning says which case applied.
- **Tests:** (a) the #103 shape (synthetic): a +3 bonus with two threatened borders of 3 each, enemy 6 and 1
  movable next to them plus ~9 deploy → the 3 local armies go on the more threatened border, no transfer
  out, no garrison withdrawal; (b) cost net of the pool flips a concession to a hold where pool ≥ the gap;
  (c) a bonus that truly cannot be held still concedes, and its local deploy still stays inside it on a
  border; (d) flag off → today's plans exactly; (e) every plan passes `validateTurn` with the same settings.

## T4 — spend the strike stack (#102)
Live: a 1v1, behind on income; the profile switched to strike, conceded 35 territories and deployed
everything to one stack (rule 3c). Next turn the stack held 80, the adjacent enemy territories held 9 and 5
(both in a bonus I had just lost and could retake), and the plan again deployed to the stack and made **no
attack**: `offence` listed only the strike-stack entry (`taken: true`, no move).
- Once a strike stack exists (rule 3c), **spend it**: every turn, from the stack, attack each adjacent enemy
  territory it can take at a good trade (`winChance` ≥ the plan's threshold, sized by the existing capture
  sizing), preferring targets that **break or retake a bonus** (the opponent's or one I just lost), then by
  bonus value, then cheapest. Keep enough on the stack to hold it against the threat it faces after the
  attacks (rule 1 arithmetic); attack until no adjacent target is worth it. Only grow the stack (deploy
  without attacking) when nothing in reach is worth taking — the rationale says which.
- `offence` reports each strike attack (target, armies, win chance, what it breaks/retakes); the
  strike-stack entry no longer reports `taken: true` without a move.
- Out of scope: moving other stacks toward the opponent (note it in the PR body as a follow-up).
- **Tests:** (a) the #102 shape (synthetic): an 80-stack next to enemy territories of 9 and 5 that are two of
  three members of a +5 bonus I lost last turn (`previousBoard`) → attacks both, sized, stack keeps a hold;
  (b) nothing adjacent worth taking → the stack grows, rationale says so; (c) a target that would leave the
  stack below its hold is not attacked; (d) FFA and non-adapting plans unchanged; (e) lessons/validity green.

## Ship
One PR, title `fix(planner): commit to the closest bonus, never stand still, defend local bonuses and spend
the strike stack` (or close), body `Closes #101`, `Closes #102`, `Closes #103`, `Closes #104`.
