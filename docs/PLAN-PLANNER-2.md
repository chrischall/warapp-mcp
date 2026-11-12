# warapp-mcp — phase 6 plan: a smarter turn planner

Worktree `/Users/chris/git/warapp-mcp-planner6`, branch `feat/smarter-planner` (from `origin/main`).
Never switch branches, never push, never touch other worktrees. Same hard rules as every phase: no
live network in tests or agents, no captured data, synthetic fixtures only (made-up maps, ids and
names), the real account email never in the repo. **Never put a real game id, player name or
opponent name in code, tests or docs** — the lessons below are described generically.

## Why: a lost 1v1, turn by turn

A 1v1 on a 129-territory world map was lost on turn 22. Combat had **0% luck** (every fight was
exactly attackers kill `round(0.6 × a)`, defenders kill `round(0.7 × d)`). The full history showed:

| Turn | My income | Their income | My territories | Theirs | My armies | Theirs |
|---|---|---|---|---|---|---|
| 5 | 14 | 23 | 24 | 21 | 35 | 46 |
| 9 | 41 | 32 | 42 | 48 | 85 | 106 |
| 12 | 35 | 46 | 45 | 59 | 136 | 166 |
| 14 | 35 | 49 | 43 | 61 | 173 | 234 |
| 17 | 27 | 54 | 36 | 68 | 71 | 222 |

Lessons, each of which the planner got wrong (it was used every turn, and overridden by hand
several times):

1. **Expansion stopped at turn 9.** Bonus income sat at +30 for six turns with two attacks in
   turns 11–16, while the opponent grew from +31 to +44. Cheap bonuses were available: a +3 needing
   neutrals of 4, 2 and 2 (~14 armies) on turn 9, a +4 needing 2, 2 and 10 on turn 11. Under
   `goal: 'defend'` the planner spent the whole income on threatened borders first, so expansion
   never had a budget.
2. **An enemy +4 bonus bordered me at a 2-army territory** for several turns and was never broken;
   it became the opponent's staging area. The planner never considers enemy targets unless
   `goal: 'complete-bonus'`.
3. **Unholdable borders swallowed the income.** Twice the planner put ~all income on a 1-army
   border facing 38–51 visible enemy armies (holding would have needed ~52) — the "leftover goes to
   the most exposed border" rule picks the border with the MOST enemy armies, i.e. the hopeless one.
   Defence also triages in territory-id order, not by what each border protects.
4. **Spread vs concentration.** From turn 12 the opponent had ~1 idle army; I had 15–23 on
   interior territories while holding 4–5 fronts with 40–60 each. They then hit one front at a time
   with 105, 76, 63 and 50.
5. **Growing stacks were visible two turns early.** One enemy stack went 51 → 76 → 105 over two
   turns before it broke a 67-army border. The planner sees one board and cannot see growth.
6. **A withdrawal failed.** Moving 14 armies off a doomed border failed because the border was
   captured first in the turn's order sequence; Order Priority (which the hand held) would have put
   the withdrawal first.

## Design rules (apply to every task)

- `src/analysis/planner.ts` stays **pure and deterministic** (ties break on ascending id; no I/O).
  New helpers may live in new files under `src/analysis/`.
- Use the exact combat model (`armiesToTake`, kill rates, luck margin via `captureCost`) for every
  hold/take judgement; add a helper for "how many defenders survive `a` attackers" if needed.
- Every new decision adds a `rationale` line; every concession or skipped hold adds a `warning`.
- Keep the plan valid: outgoing ≤ armies + deploys − guard, armies move once, captured armies do
  not attack, deploys sum to income.
- Existing tests may change only where the behaviour change is intended — say which in the commit.

## Tasks

### L1 — Value-aware defence: triage, concede, withdraw
- **Protected value** of each of my threatened border territories: the sum of the values of my
  *complete* bonuses that contain it, plus bonuses I'd lose access to (a bonus counts once even if
  several of its territories are threatened), plus its own per-territory income if any. A territory
  in no held bonus protects 0.
- **Hold cost** = the fewest deploys making `armiesToTake(armies + d) > threat` (the existing rule).
- **Triage:** defend in order of protected value per army of hold cost (ties: lower hold cost, then
  id) instead of id order. A border is **conceded** when its hold cost exceeds the remaining budget
  or exceeds `CONCEDE_FACTOR` (export, 3) × its protected value — warn
  `"<T> cannot be held economically (needs N, protects +V): conceded"`.
- **Withdraw:** a conceded border with more than the guard moves its movable armies to the
  adjacent territory of mine that (a) is not itself conceded/threatened beyond hope and (b) is
  closest to the next border that can hold (prefer one that protects the most value). Emit a
  warning that a withdrawal only executes if the territory is still mine when the order runs, and
  set `cardAdvice: 'order-priority'` on the plan when any withdrawal is planned (submission can
  then play Order Priority, which the cards code already supports; the planner itself never plays
  cards).
- **Leftover deploy** never goes to a conceded territory. Order: the held border with the highest
  protected value that is still short of a comfortable margin, else the source of the top
  expansion, else the biggest stack — the old "most enemy armies next to it" rule is removed.
- Applies under every goal (warnings always; deploys/withdrawals under `defend` and the new
  `balanced`).
- **Regression tests (synthetic):** (a) a 1-army border next to 50 visible enemies protecting +4,
  income 35 → conceded, nothing deployed there, its armies withdrawn behind; (b) two threatened
  borders, the one with the higher id protecting +5 and the lower id protecting 0 → the +5 one is
  defended first when the budget covers only one; (c) leftover never lands on a conceded border.

### L2 — `goal: 'balanced'` (new default): income-aware allocation, enemy bonus breaking
- New goal `'balanced'`, the new default for `planTurn` and `warapp_plan_turn`. `'expand'`,
  `'defend'` and `'complete-bonus'` keep their meanings.
- Candidates, all priced with exact costs and scored as **income per army**:
  - *Hold* a threatened border (L1): protected value / hold cost.
  - *Complete or advance* a bonus (existing passes): value / remaining cost.
  - *Break an enemy bonus*: a visible enemy territory in a bonus whose every territory is visible
    and owned by that one enemy; score = bonus value / capture cost, times `BREAK_WEIGHT`
    (export, 1.0 — denying +V to the opponent is as good as gaining +V when there is one
    opponent; divide by the number of other living players otherwise). Prefer a break target whose
    capture can survive the counter-attack (warn when it cannot; still allowed: a break that costs
    the opponent a turn's bonus is worth it if the score wins).
- Greedy by score (ties: cheaper, then id), respecting the reserve, until the budget runs out.
  A minimum expansion share: when any economic bonus candidate exists, at least
  `MIN_EXPANSION_SHARE` (export, 0.3) of income goes to expansion/breaking before holds that
  protect less than the expansion's value — so a turn is never 100% passive while cheap income
  sits next door.
- `warapp_plan_turn` accepts `goal: 'balanced'` and defaults to it; its description explains the
  four goals in one sentence each.
- **Regression tests (synthetic):** (d) a cheap +3 (neutrals 4, 2, 2) next door and two threatened
  low-value borders → balanced completes the +3 and defends only what pays; (e) an enemy-owned
  complete +4 bordering me at a 2-army territory → balanced attacks it with the exact cost
  (rationale says "breaks enemy bonus …"); (f) `'defend'` keeps its old all-defence behaviour
  except for L1's triage/concede.

### L3 — Threat trend from the previous turn
- `PlanInput.previousBoard?: BoardState` (the same player's view one turn earlier). For each
  visible enemy territory adjacent to me, growth = armies now − armies then (only when visible
  both times and same owner). Projected threat next turn = movable now + max(enemyDeploy, growth).
  Warn `"<E> is building: +G/turn (A → B); at this rate <T> needs N to hold next turn and M the
  turn after"` and use the projected threat for that border's hold cost.
- Tool layer (`warapp_plan_turn`): obtain the previous board best-effort, in order: GameFeed
  `GetHistory=true` standing for the previous turn **if present** (unverified for games in
  progress — mark it so in `docs/WARAPP-API.md`, parse loosely, never throw), else an on-disk cache
  of the last board this server planned on for that game at `<dataDir>/boards/<gameId>.json`
  (`MCP_DATA_DIR`, else `~/.config/warapp-mcp`; written after each successful plan with its turn
  number; used only when its turn is exactly the previous one). Report `trendSource:
  'history' | 'cache' | null` in the payload. The cache holds only the player's own fogged view.
- **Regression tests:** (g) an enemy stack 51 → 76 next to my 67 with deploy estimate ~38 →
  without trend the border looks safe-ish; with `previousBoard` the projected threat breaks it and
  the plan deploys enough or concedes per L1; (h) tool-level: history standing used when present,
  cache used otherwise, neither → `trendSource: null` and no throw; the cache file is written.

### L4 — The lost-game scenario suite, docs and packaging
- `tests/analysis/lessons.test.ts`: a synthetic map (≈20 territories, 5 bonuses, two players)
  that reproduces the arc above in miniature — one test per lesson 1–6 asserting the smarter plan
  (expansion share used, enemy bonus broken, hopeless border conceded and withdrawn with
  `cardAdvice`, leftover not wasted, trend raises the hold, idle interior armies moved toward a
  held front rather than a conceded one). Name it "lessons from a lost game" with no real names.
- `warapp_plan_turn` payload: `goal`, `conceded` (territories), `cardAdvice`, `trendSource`, and the
  existing fields; brief/compact views updated if the tool has them.
- Docs: README tool table, CLAUDE.md (planner rules summary + the concede/withdraw and trend
  behaviour), `skills/warapp-mcp/SKILL.md` (how to read a balanced plan, when to pick
  `defend`), `docs/WARAPP-API.md` (GetHistory in progress: unverified). Strict surface lint 0
  warnings (same recipe as `docs/PLAN-TURN.md` T4).
