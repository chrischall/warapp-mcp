# warapp-mcp — phase 8 plan: a defensibility-aware planner (live-play fixes)

Worktree `/Users/chris/git/warapp-mcp-planner3`, branch `feat/planner-defensibility` (from
`origin/main`). Never switch branches, never push, never touch other worktrees. Same hard rules:
**no live network in tests or agents, no captured data, synthetic fixtures only (made-up maps, ids,
names), the real account email never in the repo. Never put a real game id, player name or opponent
name in code, tests or docs** — describe the lessons generically.

## Why

Three live games were lost or badly damaged by the same expansion flaws (GitHub issues #17, #18,
#19). The planner is good at scoring captures by income-per-army but blind to **defensibility** and
to the opponent's real income. Each task below closes one gap, with synthetic regression tests.

`src/analysis/planner.ts` stays **pure and deterministic** (ties on ascending id; no I/O). Use the
exact combat model (`armiesToTake`, `captureCost`, kill rates, luck) for every judgement. Every new
decision adds a `rationale` line; every concession/skip adds a `warning`. Keep plans valid (outgoing
≤ armies + deploys − guard; armies move once; captured armies don't attack; deploys sum to income).
Existing tests change only where the behaviour change is intended — say which in the commit.

## Tasks

### R1 — Income-aware enemy deploy estimate (issue #17, part 1)
Today `defaultEnemyDeploy` = max(5, round(0.75 × the largest visible enemy stack)). On an opening
board where every territory (neutrals included) starts at 15, this estimated ~11 for opponents whose
real income was the 5-army minimum, so every border looked doomed and the plan spent the turn on
useless holds.

- Add a **per-opponent** income estimate used for that opponent's threat (not one global number):
  for a visible enemy player, estimate their next deploy as **base income + the value of the bonuses
  they visibly hold in full** (reuse `analyzeBonus`/`incomeFor`-style logic against that player),
  clamped **below** by `MIN_ENEMY_DEPLOY` and **above** by the existing stack-based figure
  (`round(ENEMY_STACK_SHARE × their largest stack adjacent to me)` — a big adjacent stack still
  implies they *can* move a lot). So: `estimate = clamp(base + visibleBonusIncome, MIN_ENEMY_DEPLOY,
  stackBasedCap)`. Keep `enemyDeploy`/`enemy_deploy` as a global override.
- **Opening guard:** when every visible territory on the board holds the same army count (the initial
  allotment — no one has deployed yet), use `MIN_ENEMY_DEPLOY` for every opponent (the stack rule is
  meaningless at turn 0).
- Warnings state the estimate and its basis per opponent. Keep the current warning when a global
  override is supplied.
- **Tests:** (a) an opponent holding no complete bonus with a 15-stack → estimate `MIN_ENEMY_DEPLOY`,
  not 11; (b) an opponent visibly holding a +5 bonus → estimate base+5 (above the floor); (c) the
  all-equal opening board → every opponent estimated at the floor; (d) the Florida/trend cases from
  phase 6 still behave (a genuinely large adjacent stack still raises the estimate via the cap).

### R2 — Value a border by the bonuses held AFTER this turn's captures (issue #18)
`protected value` is computed from `mineSet` (holdings at the **start** of the turn), so a territory
that this turn's captures will turn into a bonus member — or complete a bonus around — scores +0 and
gets conceded/withdrawn, defeating the capture.

- Compute protected value against the ownership the plan will hold **after** its planned captures
  (the `captured` set ∪ `mineSet`): a border in a bonus that this turn's captures complete, or keep
  me the sole holder of, protects that bonus's full value.
- Because defence (rule 1) currently runs before captures are known, either (a) compute a border's
  protected value with a **lookahead** over the bonuses the turn's candidate captures would complete,
  or (b) re-evaluate concede/withdraw decisions after the capture passes and *un-concede* a border
  that the completed captures now make valuable (don't withdraw from it; garrison it from leftover).
  Pick the cleaner one; keep the planner pure.
- **Test (issue #18's):** I hold all but one territory of a +5 bonus; the missing one is a cheap
  neutral captured this turn; a held member of the bonus borders an enemy. The plan completes the
  bonus **and** keeps/garrisons that bordering member (never concede-and-withdraw it).

### R3 — Defensibility-aware bonus completion (issue #19)
The fatal recurring pattern: the planner completes a large bonus by taking its last neutrals,
spending the whole income on captures and leaving every border of the bonus at 0–2 armies; the
opponent then rolls the whole bonus back next turn. Completing a +7 continent you hold for one turn
is worth ~0.

- When scoring completing/advancing a bonus, estimate the **defense cost** of the frontier it
  creates: over the new/zeroed borders the completion exposes, the deploys needed next turn to hold
  each against its adjacent visible enemy force (reuse R1's per-opponent estimate + the trend).
- **Rule:** never spend the LAST armies completing a bonus if doing so leaves a member bordering a
  visible enemy stack that can take it next turn for less than my projected next income (the bonus is
  lost immediately) — warn `"completing <bonus> leaves <border> indefensible (<enemy> can take it for
  N; next income M): not completed"` and skip the completion, preferring a tighter holdable frontier
  or a garrison. Discount a completion's income-per-army score by its defense cost so a defensible
  smaller bonus can win over an indefensible big one.
- Expose a `DEFENSE_DISCOUNT`/threshold constant (exported). Applies under `balanced`/`defend`;
  `expand` keeps completing (it is the "ignore defence" goal) but still warns.
- **Test:** a bonus one neutral short; completing it exposes a member to a visible enemy stack that
  breaks it next turn; income can't both complete AND garrison → the plan garrisons / does not sink
  the whole income into the completion, and warns. A control where the frontier IS defensible → it
  still completes.

### R4 — Combined (multi-source) attacks (issue #17, part 2)
Every capture is funded from one source, so a 15-army neutral that needs 25 can never be taken when
the adjacent stacks are 15 + 5 income. Under 0% luck two attacks on one target in one turn work: the
first wears the defenders down, the second takes it.

- When a target's `captureCost` exceeds what the best single source can afford (after its guard and
  this turn's deploys), and **two or more** of my adjacent sources together can, plan a **sequence**
  of attacks on it with exact arithmetic: each attack kills `round(off × armies)` defenders; apply
  kills cumulatively; the final attack must leave ≥1 to occupy. Only under straight rounding and
  **luck 0** (otherwise a single-source capture only — multi-source sequencing isn't luck-safe; warn
  if a multi-source capture is skipped for luck). Respect the move-once / captured-can't-attack rules
  (sources are my existing territories, not captured ones).
- Keep it opt-in to the existing passes: a multi-source capture is considered only when no single
  source suffices and it is economic by the same bonus/expansion scoring.
- **Tests:** (b from #17) two of my 15-stacks next to one 15-army neutral, income 5, luck 0 → the
  plan takes it with two attacks (exact armies, order asserted); the same with luck > 0 → not
  attempted, warned; a three-source case; a case where even all sources can't afford it → not planned.

### R5 — Docs, packaging, regression suite
- Extend `tests/analysis/lessons.test.ts` (or a sibling) with a "lessons from the FFA and the two
  1v1s" group: the opening-income case (R1), the complete-then-lose case (R3), the can't-reach-a-
  neutral case (R4), the bonus-completed-this-turn border (R2) — each on a synthetic map, no real
  names.
- `warapp_plan_turn`: surface the per-opponent enemy-deploy basis and any "not completed for
  defensibility" / multi-source notes in the existing `warnings`/`rationale`; add fields only if a
  clean addition (e.g. `multiSourceCaptures`), else keep to warnings.
- Update CLAUDE.md's planner bullet (R1–R4 in one or two sentences each) and the planner header
  comment (the rule list). Strict surface lint 0 warnings (same recipe as docs/PLAN-TURN.md T4).

## Not in scope
- Card fixes (#20) — a separate phase; the card-completeness data structure must be decoded live
  first.
- Multi-player diplomacy / team play.
