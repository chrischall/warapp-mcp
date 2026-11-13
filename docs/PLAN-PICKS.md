# warapp-mcp — plan: a pick advisor for manual-distribution games (#36)

Worktree `/Users/chris/git/warapp-mcp-picks`, branch `feat/plan-picks` (from `origin/main`). Never
switch branches, never push, never touch other worktrees. Hard rules: **no live network in tests or
agents, synthetic fixtures only (made-up maps, ids, names), never the real account email, a real game
id or a real player name.** The picker is **pure and deterministic** (ties on ascending id, no I/O),
like `src/analysis/planner.ts`, and **read-only** — the owner submits with `warapp_submit_picks`.

## Why

Manual-distribution games need territory picks and there is no advisor (GitHub issue #36): in two
FFAs the pick list took hand analysis of the map, the live board's pickables and the settings.

## Facts and strategy inputs

- Picks allowed: war.app's client lets a list hold players × territories per player (`clientPickLimits`,
  docs/WARAPP-API.md; this plan first assumed `TerritoryLimit × 2`, true only in a 1v1, #129); only `TerritoryLimit`
  are granted, in pick order, skipping ones another player got first. So the list is ordered: the top
  `TerritoryLimit` form one compact primary group; the rest a compact fallback group.
- Settings that change pick value: `InitialNonDistributionArmies` (neutral size; with 0-army
  neutrals any adjacent territory costs 1 army), wastelands (a bonus containing a big neutral is
  slow/never), kill rates (`armiesToTake` with the game's rates — at 30/75 attacking players is
  costly, so a defensible bonus beats a contested one), `minimumArmyBonus` (base income),
  `bonusArmyPer`, `localDeployments`.
- Community picking heuristics (researched; encode in our own words, cite in the doc, never copy
  text): (1) **coverage/safety first** — no pick set that loses outright, and expansion paths; (2)
  **income by turn** — aim for a first-turn bonus (FTB: a bonus a pick completes on turn 1 with its
  starting armies + base income) and fast follow-ups; (3) prefer **efficient bonuses** (value per
  territory to take, few entry points / borders); (4) in many-player games central high-value bonuses
  are contested — **peripheral, compact clusters survive**; in 1v1, spread picks enough not to be
  wiped by one counter-pick.

## Tasks

### K1 — Pick scoring (pure, `src/analysis/picks.ts`)
`planPicks({ graph, pickable, settings, players, territoryLimit, maxPicks })` →
`{ picks: [{ territoryId, group: 'primary'|'fallback', score, reasons[] }], groups, warnings,
rationale }`.
- For each pickable territory, score the bonuses it could anchor: turns-to-complete from a pick there
  given the starting armies of a picked territory (`InitialPlayerArmiesPerTerritory`), base income
  and the neutrals' armies (exact capture costs at the game's kill rates; wastelands count at their
  real size), bonus value per army to finish, entry points (territories outside the bonus adjacent to
  it), and FTB status. Include single-territory bonuses (instant income when picked).
- Contestedness: centrality (e.g. mean graph distance to all pickables, or betweenness) penalised in
  proportion to the number of players (strong with ≥ 6, light in 1v1).
- Build groups greedily: the primary group maximises income-by-turn-3 under a compactness
  constraint (each pick within distance 2 of another primary pick, or anchoring a different bonus
  when the game is 1v1 and spreading is preferred); the fallback group is the best compact set from
  the remaining territories, disjoint from the primary. Order within groups by score. Never list a
  territory that is not pickable; never exceed `maxPicks`.
- Every pick carries reasons (bonus, value, turns to complete, FTB, entry points, contested), and the
  plan carries warnings for unknown settings (assumptions stated).
- **Tests (synthetic maps):** (a) a single-territory bonus and an FTB outrank a big slow bonus; (b)
  with 0-army neutrals a territory next to many small bonuses scores high; (c) a wasteland inside a
  bonus drops it; (d) at 30/75 a defensible bonus (few entry points) beats a contested one; (e) with
  10 players a peripheral cluster beats a central one, with 2 players not penalised; (f) primary group
  of exactly `TerritoryLimit`, fallback disjoint and compact, total ≤ `maxPicks`; (g) determinism
  (same input → same output; ties by id).

### K2 — `warapp_plan_picks` tool + docs
- `warapp_plan_picks(game_id, view?)`: read-only, reads GameFeed (map + settings + players) and the
  live board's pickable territories the same way `warapp_get_live_board` does; refuses when the game
  is not in the picking stage or there is nothing pickable. Returns the ranked list by name and id,
  the groups, reasons, warnings, and a ready-to-use `submit_picks` argument (ids in order). Compact
  vs full view like `warapp_plan_turn`. Annotations: read-only.
- Register it (tool list, README, skill, manifest, CLAUDE.md tool bullet, packaging/annotation/
  server-boot tests). `docs/STRATEGY.md` (new): the picking heuristics in our own words with source
  links (the community guides researched for this plan), marking which are encoded.
- **Tests:** a tool test on a synthetic game in the picking stage (fake GameFeed + fake live board):
  list, groups, `submit_picks` argument; refusal outside the picking stage. Strict surface lint 0
  warnings (recipe in docs/PLAN-TURN.md T4).

Sources for docs/STRATEGY.md (cite, don't copy): war.app/Forum/434535-1v1-ladder-strategic-picking-guide,
war.app/Forum/811395-general-strategy-guidelines, war.app/Forum/99097-good-1v1-strategies,
war.app/Forum/621189-ffa-strategy, war.app/wiki/Combat_Basics, war.app/wiki/Luck_Modifier.

## Not in scope
- Counter-picking from opponents' likely picks (needs their history) — a later strategy phase.
- Submitting picks (the owner uses `warapp_submit_picks`).
