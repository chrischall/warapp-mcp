# warapp-mcp — phase 9 plan: the planner obeys the game's rules (kill rates, Local Deployment, No-Split)

Worktree `/Users/chris/git/warapp-mcp-planner4`, branch `feat/planner-game-rules`, **stacked on
`feat/planner-defensibility` (phase 8, PR #33)** — it builds on the R1–R4 planner. Never switch
branches, never push, never touch other worktrees. Same hard rules as phase 8: **no live network in
tests or agents, synthetic fixtures only (made-up maps, ids, names), the real account email never in
the repo, never a real game id, player name or opponent name in code, tests or docs.**

## Why

Live play found three game settings that `warapp_plan_turn` / `warapp_submit_turn` ignore (GitHub
issues #28, #29, #31). Each makes the planner propose turns that are wrong or refused on games that
use them. The planner stays **pure and deterministic** (ties on ascending id; no I/O); every new
decision adds a `rationale` line, every refusal/concession a `warning`. Keep plans valid. Existing
tests change only where the behaviour change is intended — say which in the commit. Default
settings (60/70 kill rates, global deployment, splitting allowed) must produce **exactly** today's
plans.

## Tasks

### G1 — Kill rates and rounding everywhere (issue #28)
`armiesToTake` and `plannerRates` already take the game's `offensiveKillRate`/`defensiveKillRate`,
but the issue reports attacks sized as if 60/70. **First audit** every combat computation and trace
the settings into it: capture cost, the threat/holdability checks (what an enemy needs to take my
border, what survives), R1's estimates, R3's defence cost, R4's multi-source arithmetic (kills per
attack, survivors), guards/garrisons, `warapp_analyze_board`/`analyzePlayer`, card advice, and
`validateTurn` in `src/tools/turn.ts`. Confirm `warapp_plan_turn` and `warapp_submit_turn` pass the
GameFeed rates (`plannerSettings(game.settings)`) all the way down, and that no path computes with a
hard-coded 0.6/0.7, 60/70 or the defaults when the game supplies rates. Fix every gap.
- Report the audit (each path: already correct / fixed) in the commit message.
- **Tests:** (a) at 60/70 every existing expectation is unchanged; (b) at **20/80** a 2-army neutral
  costs `armiesToTake(2, {20, 80})` (assert the exact number, derived by hand in the test comment),
  the plan sends that many, and a threat check against my border uses 20/80 too; (c) at **30/75**
  (an FFA seen live) a 1-army neutral and a player-held territory are sized correctly; (d) a
  `warapp_plan_turn` tool test with a synthetic GameFeed whose settings carry
  `OffensiveKillRate: 20`, `DefensiveKillRate: 80` shows the sized attack; (e) R4's combined capture
  arithmetic under non-default rates (exact attack sizes and order).
- Rounding: keep straight-round exact arithmetic; under `WeightedRandom` rounding keep (and make sure
  every path emits) the existing assumption warning. Do not invent a weighted model.

### G2 — Local Deployment (issue #29)
With `localDeployments` on (GameFeed `LocalDeployments`, already parsed in `src/normalize.ts`), armies
earned from a bonus must be deployed **inside that bonus**; only the base income (and
per-territory/`bonusArmyPer` income, and card armies such as Reinforcement — check how war.app
treats these and document what you assume as unverified in `docs/WARAPP-API.md`) may go anywhere.
- Planner: when the flag is on, budget the global pool (base income) and one pool per held bonus
  (its value, deployable only on that bonus's territories I hold). Every deploy is charged to a pool;
  the plan never deploys a bonus's armies outside it. Bonus pools that cannot be used usefully are
  still deployed inside the bonus (deploys must sum to income), choosing the most threatened member
  (ties by id). A rationale line names each pool. Superbonuses: a superbonus's armies go inside the
  superbonus's territories.
- `validateTurn` (submit_turn) refuses a turn whose deploys break a bonus pool, naming the bonus and
  the overspend, before anything is sent.
- **Tests:** (a) flag off → today's plans exactly; (b) flag on, holding a +3 bonus, base 5: the plan
  deploys ≤5 outside the bonus and exactly 3 inside it, even when the best target is outside;
  (c) two held bonuses, each pool used only inside its own bonus; (d) a bonus pool with no threatened
  member still deploys inside the bonus; (e) `validateTurn` refuses a pooled-income deploy that
  spends bonus armies outside the bonus, and accepts the correct split; (f) a `warapp_plan_turn` tool
  test with `LocalDeployments: true` in the synthetic GameFeed settings.

### G3 — No-Split (issue #31)
Read GameFeed's `NoSplit` (boolean, `GetSettings=true`) into `GameSettings.noSplit` in
`src/normalize.ts` (verified key; mark it in `docs/WARAPP-API.md`).
- When `noSplit` is on, the planner issues **at most one AttackTransfer per source territory**
  (attack or transfer), choosing the best target for that source by the planner's existing scoring;
  a source that would have split keeps only its best order and the rest is not planned (warn which).
  Multi-source captures (R4) stay allowed — each source still issues one order. Whether No-Split
  also *requires* sending all movable armies is **unverified**: keep the planned amount (do not force
  all-in), and say so in a warning and in `docs/WARAPP-API.md` (a live turn that sent all movable
  armies from each source in one attack was accepted — that is consistent with either rule).
- `validateTurn` refuses a turn with two AttackTransfers from one source when `noSplit` is on,
  naming the territory, before anything is sent.
- **Tests:** (a) flag off → today's plans exactly; (b) flag on, a source next to two cheap neutrals:
  one attack only (the better one), a warning names the dropped one; (c) a transfer and an attack
  from one source → only one kept; (d) R4 combined capture still planned under No-Split (one order
  per source); (e) `validateTurn` refuses a split, accepts one order per source; (f) normalize reads
  `NoSplit: "True"`/`true`/`"False"`; (g) a `warapp_plan_turn` tool test with `NoSplit: true`.

### G4 — Docs, surface, regression
- `warapp_plan_turn`: the `full` rung's `settings` echo shows `localDeployments` and `noSplit`; the
  tool descriptions of plan/submit mention that kill rates, Local Deployment and No-Split are obeyed.
- Extend the lessons suite (`tests/analysis/lessons-*.test.ts`) with a "game rules" group: one
  synthetic board planned under all four combinations of {localDeployments, noSplit} at 20/80, each
  plan validated by `validateTurn` with the same settings (the planner must never propose a turn the
  validator refuses).
- CLAUDE.md: one sentence per rule in the planner bullet; planner header comment rule list.
  `docs/WARAPP-API.md`: `NoSplit` (verified key), the Local Deployment pool assumptions (unverified).
  Strict surface lint 0 warnings (same recipe as docs/PLAN-TURN.md T4).

## Not in scope
- Modelling weighted-random rounding or luck beyond today's margin.
- Commanders, army cap, and other settings not raised by an issue.
