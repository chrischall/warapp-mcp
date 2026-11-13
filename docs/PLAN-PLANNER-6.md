# warapp-mcp — phase 11 plan: net income, frontier cost, offence (#70, #71, #72)

Hard rules as every planner phase (see docs/PLAN-PLANNER-4.md preamble): no live network in tests
or agents, synthetic fixtures only (made-up maps, ids, names; never a real map, game, player or
territory name), the planner stays **pure and deterministic** (ties on ascending id), TDD, green =
`npm run build` then `npm test`, strict surface lint 0 warnings when a tool surface changes.
Existing expectations change only where intended; list each in the commit with why.

Tracks (stacked, one PR each): H1 `fix/negative-bonuses` (off main) → H2 `feat/frontier-cost`
(stacked on H1) → H3 `feat/planner-offence` (stacked on H2, starts after PRs #79 game profile and
#81 opponent tracking are merged into main; rebase H1/H2 first).

## H1 — captures are scored by their net effect on income (#70)

Read `gh issue view 70` (and its comments). Maps with overlapping bonuses (e.g. each sea tile a
single-territory −4 bonus and a member of a +22 four-tile group) make the planner take tiles that
complete negative bonuses while "advancing" a far-off positive one: nextIncome fell 12 → 0 → −12.

- Every capture's score accounts for **every bonus it completes or breaks**, negative ones
  included: the income delta this turn. A capture that completes a negative bonus is only taken
  when (a) the positive bonus it serves completes **this turn** in the same plan, or (b) it is
  focused, or (c) the positive bonus completes within PAYBACK_TURNS and the summed per-turn penalties
  until then are repaid by the bonus within PAYBACK_TURNS after completion (state the rule).
- **Cluster as a unit:** for a positive bonus whose members carry negative bonuses, its worth is
  its value minus the penalties of members not yet held while incomplete; its remaining cost is all
  missing members. Prefer completing a whole cluster in one turn (combined plans across the
  missing members, existing capture/combined rules) over partial steps; a partial step that only
  adds penalties is never "advances bonus …".
- **Guard:** after planning, if `expected.nextIncome` < current income because of negative
  bonuses completed by planned captures, drop the offending captures (latest-added first) unless
  focused; if one remains (focused), warn loudly with the numbers. *As built (a deliberate
  widening):* the guard also keeps staging steps (rule c already justified their cost), commander
  strikes (they eliminate a player) and finishing-off captures; any it keeps is in the warning.
  Rule c counts its turns-to-finish at the income left **after** the staging step, since the step
  itself lowers income.
- Check `(hidden)` bonuses: confirm the planner sees every bonus in the map data regardless of how
  `warapp_get_map`'s default view presents them; if the map tool hides them by default, say so in
  its output (a count of hidden bonuses) rather than changing the default.
- Superbonuses and overlapping bonuses: income delta is `boardIncome(after) − boardIncome(now)`
  (#85's one income rule, which `nextIncome` uses; never a parallel one), so per-territory income
  and the 0 floor are counted as war.app pays them.
- **Tests:** synthetic sea map: four tiles each a −4 single-territory bonus and together a +22
  bonus. (a) Only one tile affordable → no sea capture, income unchanged. (b) All four affordable
  this turn → the whole cluster is taken, nextIncome +6. (c) Two of four already held (paying −8):
  completing the last two this turn is preferred over a +3 elsewhere when worth more (+22 −…).
  (d) A plain negative single-territory bonus next to my land is never taken unless focused.
  (e) The guard: a constructed plan path that would lower nextIncome drops the capture.
  (f) Default maps (no negative bonuses) → today's plans exactly.

## H2 — every capture pays for the frontier it adds (#71)

Read `gh issue view 71` and the dev comment. R3 checks the frontier only when a capture completes a
bonus; plain expansion adds borders for free.
- **Marginal frontier cost:** for each candidate capture, the change in my frontier (territories of
  mine adjacent to a non-mine territory, after the capture) and the hold cost of the borders it
  adds that face an **enemy** (at the per-opponent deploy estimate, existing hold arithmetic);
  borders facing only neutrals cost a small fixed weight (state it). Fold it into the capture's
  score as a cost in armies (score = value gained / (capture cost + frontier cost)), so a capture
  that closes a gap ranks above one that opens new fronts.
- **Frontier budget:** the plan reports `frontier: { borders, enemyBorders, holdCost, income }`
  (full view; compact: one line). When holdCost at expected deploy exceeds income and grew this
  plan, warn ("frontier grows faster than income") and stop expansion that adds enemy borders
  without completing a bonus.
- No separate adjacency/"compact core" bonus (it would double-count the frontier term).
- **Tests:** a capture that closes a gap beats an equal-value one that opens two enemy borders;
  neutral-only borders barely matter; the budget warning and expansion stop; 60/70 default boards
  with no enemy contact unchanged; exact numbers in test comments.

## H3 — offence: break inferred bonuses, concentrate, and "behind on income" means strike (#72)

Starts after #79 (game profile: `src/analysis/profile.ts`) and #81 (opponent tracking:
`src/analysis/opponents.ts`) are on main. Read `gh issue view 72` with comments.
- **Break inferred bonuses:** besides fully visible enemy bonuses, a bonus is a break candidate
  when the opponent tracker lists it in every candidate combination for that opponent (or it is
  visibly held except fogged members that the tracker's single best fit includes); the rationale
  says "probable". Target its cheapest visible member.
- **Size a break to land, not to survive:** a break needs the defenders present plus the luck
  margin (or `min_win_chance`), not the opponent's full deploy; value = the opponent's lost income
  this turn + the armies it must spend to retake (≥ armiesToTake of my survivors), compared on the
  same per-army scale as holds and expansion.
- **Profile rule change (S1):** in a 1v1, standing `behind` on **income** → offence: break bonuses
  with minimal attacks before expansion that completes nothing; holds of my own bonuses still come
  first when they pay for themselves. Behind on **armies** (my total visible < 0.8× theirs) →
  avoid trades below even (attacks into stacks larger than the attacker) — the old "defend" bias.
- **Concentrate:** a deploy proxy for a strike stack: borders not worth holding get no deploys
  (conceded per #56's unit rule); remaining deploys beyond holds go to one stack on the border
  facing the opponent with the highest tracked income, not spread; rationale names it.
- **Counter-attack:** an enemy stack that shrank last turn by attacking me (visible both turns,
  F1 rules) and is now cheaper than its prior size → a strike candidate scored like a break.
- Report `offence: [{ target, kind: 'break'|'strike'|'counter', cost, value, taken, why }]` in the
  full view.
- **Tests:** a fogged opponent with a tracker-inferred +5 → its visible member is attacked at the
  landing size; behind on income in 1v1 → break chosen over a neutral; behind on armies → no bad
  trade; deploys concentrated on the strongest opponent's border; counter-attack after a failed
  enemy attack; FFA and ahead cases unchanged except where stated.
