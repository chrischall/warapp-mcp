# Strategy notes

What this server believes about playing war.app, written in our own words: first territory picks
(the pick advisor, `warapp_plan_picks`, scorer in `src/analysis/picks.ts`), then the rest of the
game (the strategy notes served by `warapp_strategy`, data in `src/strategy/notes.ts`). The community guides below
were the research for `docs/PLAN-PICKS.md`; they are linked, never quoted or copied. Each
heuristic says whether it is **encoded** (the scorer acts on it) or **not encoded** (advice for
the person reviewing the list).

## Sources

- 1v1 ladder picking guide — <https://war.app/Forum/434535-1v1-ladder-strategic-picking-guide>
- General strategy guidelines — <https://war.app/Forum/811395-general-strategy-guidelines>
- Good 1v1 strategies — <https://war.app/Forum/99097-good-1v1-strategies>
- FFA strategy — <https://war.app/Forum/621189-ffa-strategy>
- Combat basics (kill rates, how many armies a capture needs) — <https://war.app/wiki/Combat_Basics>
- Luck modifier — <https://war.app/wiki/Luck_Modifier>
- Cards (how card pieces are earned) — <https://war.app/wiki/Cards>

# Territory picks

## How picks are granted

A game allows twice its territory limit in picks, but grants only the territory limit, in list
order, skipping territories another player was granted first. So the list is two plans: the
first `TerritoryLimit` picks are the plan you want, the rest a fallback that still makes sense
when some of the first ones are lost. **Encoded:** the primary group is exactly the territory
limit and the fallback is disjoint from it, each group built by the same rule on its own: compact,
a 1v1 included, relaxed one hop at a time, with a warning, when the remaining picks allow nothing
tighter. The fallback is what covers a counter-pick — when the primary picks are taken, the next
ones are granted in order from it — so in a 1v1 it goes to a different area: among equally scored
compact fallbacks, the one farthest from the primary wins (never at the cost of its own
compactness). A fallback that outscores the primary is warned about.

## Heuristics

1. **Safety and room to grow before greed.** A pick set should not lose outright to one bad
   draw, and every pick should have neutral territory to expand into. **Encoded in part:** each
   group is compact by default, in a 1v1 as with more players (one cluster whose picks link up in
   steps of at most two hops, measured on the map graph `warapp_plan_route` uses) so its armies
   can support each other and the start has one front; when no compact group of the territory
   limit exists the limit relaxes one hop at a time, with a warning. A 1v1 primary spread over
   several bonuses against a counter-pick meant a frontier on each of them from turn 1, broken one
   at a time (#73); the fallback group is the counter-pick insurance instead. A pick is
   only worth what its own armies can capture next to it. **Not encoded:** judging whether a
   specific opponent's likely picks would trap yours (counter-picking needs their history).
2. **Income by turn.** Early income compounds: a bonus finished on turn 1 (a first-turn bonus,
   using the pick's starting armies plus base income) pays every turn after, and a pick that
   finishes a second bonus soon after is better still. A single-territory bonus pays at once.
   **Encoded:** a three-turn opening simulation credits each bonus by the turns it pays out,
   flags first-turn bonuses and single-territory bonuses in the reasons. Armies attack only from
   a territory held at the start of the turn that borders the target, plus that turn's deploys;
   armies on another pick never help, and captured armies wait a turn. Each pick's first reason
   names the bonus it anchors and when it completes (or how much of it is held by turn 3).
3. **Efficient bonuses.** Prefer bonuses that give the most income for the armies it takes to
   finish them, and that have few territories outside them to watch (entry points) — they are
   cheaper to hold. **Encoded:** captures are costed exactly at the game's kill rates against the
   neutrals' real sizes, and a bonus's worth is discounted per entry point — ×1/(1 + 0.05 ×
   entry points × hardness), twice as steep in a 1v1 (0.1 per entry point: the one opponent finds
   every way in), so there a bonus with few entry points wins ties against a wide one.
4. **Settings change the arithmetic.** Small neutrals make every neighbour cheap, so a pick
   bordering many small bonuses is strong; a wasteland inside a bonus makes it slow or not worth
   taking; harsh kill rates (e.g. 30% offence / 75% defence) make attacking players expensive, so a
   defensible bonus beats a contested one; luck adds a margin to every capture; base income and
   per-territory bonuses set the pace (with per-territory income on, the base is a floor:
   income is the larger of the two, plus bonuses). **Encoded:** all of these feed the simulation (neutral sizes
   from the live board when shown, else the settings), and assumed settings are stated as warnings.
   **Not encoded:** local deployments are modelled as pooled income (a warning says so).
5. **Many players: stay off the middle.** In a free-for-all the central, high-value bonuses draw
   several neighbours at once; a compact cluster on the edge of the map tends to survive and grow.
   **Encoded:** a pick's score drops with its centrality among the pickable territories, by more
   the more players there are (no penalty in a 1v1).
6. **1v1: do not put everything in one basket — but do not split the start either.** Ladder
   guides for small 1v1 templates spread picks over adjacent bonuses so one counter-pick cannot
   wipe the plan; on a large multi-continent map that leaves a frontier on every continent from
   turn 1. **Encoded:** by default a 1v1 primary is compact like any other, and the fallback, in
   another area, is the insurance (see "How picks are granted"). Only `spread: true` on
   `warapp_plan_picks` restores the old rule — usually worse on large maps: a pick may join the
   primary group by anchoring a bonus no other pick anchors, even when it is not within two hops,
   but only within four, unless a group spread farther scores at least 1.5× as much (or no bounded
   group exists), which is warned about. Either way the rationale states the group's real spread
   (the hops between its two farthest picks and the longest step linking them) and calls it
   compact only when it is.
7. **Read the opponent.** Strong picks depend on what the other player is likely to pick and
   where they will start. **Not encoded** — a later strategy phase (it needs their history).

# The rest of the game — `warapp_strategy`

`warapp_strategy(game_id?, map_id?, topic?)` serves the notes below. With a game it picks the
notes whose condition fits the game's profile (`feedProfile`: format, settings and phase from
GameFeed alone — the standing needs the board, so notes for ahead and behind both apply until
`warapp_plan_turn` judges it) and adds map notes; with only a map it gives the map notes; with
neither, every note. The general notes are also the MCP resource `warapp://strategy`, and a map
this process has loaded is `warapp://strategy/map/{mapId}`.

Each note is marked **encoded** (where the server acts on it) or **advice only**, and with its
basis: *source* — the linked page states the idea; *derived* — our reasoning from the rule or
advice the linked page gives (the listed pages do not cover Local Deployment, No-Split, team
play or the effect of each card, so those notes are reasoned from the game rules and say so).
The pages were read on 2026-11-13; nothing is quoted.

## Map notes (computed, no extra traffic)

- **Bonuses by value per army** — each positive bonus's value over the armies it takes to capture
  every territory from neutral at the game's kill rates, luck and neutral size, with its entry
  points (the territories outside it that touch it). **Encoded:** `src/strategy/map-notes.ts`.
  Wastelands and picked territories are not known from the map, so every territory is costed as
  a neutral of the settings' size (an assumption the notes state).
- **Chokepoints** — articulation points, bridges between bonus clusters and narrow connectors
  (`findChokepoints`, as `warapp_get_map`). **Encoded.**
- **Income targets by turn** — while picks are open, the pick advisor's opening simulation run
  with every territory pickable: the base income plus the bonuses its best group completes,
  turn by turn. **Encoded**, as a pace to aim for (`warapp_plan_picks` uses the live pickables).

## Format

- `1v1-break-bonuses` — at contact, cut income by taking a territory in each enemy bonus
  rather than trading armies. **Advice only.** Source: Good 1v1 strategies.
- `1v1-contact-ground` — foresee where you will meet; a bonus behind a narrow front is worth some
  income. **Advice only** (the map notes list the bottlenecks). Source: Good 1v1 strategies.
- `ffa-strike-last` — let rivals fight each other and move in after. **Advice only.** Source: FFA strategy.
- `ffa-pick-fights` — avoid a war on two borders at once. **Advice only**, derived. Source: FFA strategy.
- `ffa-diplomacy` — truces free armies; guard against betrayal. **Advice only.** Source: FFA strategy.
- `ffa-big-stack` — fill behind a giant stack, wall it, or wait in the fog. **Advice only.** Source: FFA strategy.
- `teams-focus` — teammates attack the same opponent so its one income covers two fronts.
  **Advice only**, derived from the combat rules. Source: Combat basics.

## Settings

- `settings-efficient-sizes` — attack at the breakpoint; armies between breakpoints are wasted.
  **Encoded:** the planner sizes attacks at their breakpoints (`src/analysis/combat.ts`). Source: Combat basics.
- `settings-defend-with-three` — three defenders cost an attacker five, two only three.
  **Advice only.** Source: General strategy guidelines.
- `settings-poke` — a one-army attack can break an exact-size attack. **Advice only.** Source:
  General strategy guidelines.
- `settings-move-order` — learn the move order and sort orders by when they should land.
  **Advice only.** Source: General strategy guidelines.
- `settings-no-luck-exact` — with no luck, results are exact. **Encoded:** `armiesToTake`. Source: Luck modifier.
- `settings-luck-guaranteed` — with luck, count only the kills the roll cannot remove and add a
  margin. **Encoded:** `winChance`, `guaranteedKills`, `min_win_chance`. Derived. Source: Luck modifier.
- `settings-weighted-rounding` — weighted rounding makes breakpoints uncertain. **Encoded:**
  `winChance` models it. Derived. Source: Luck modifier.
- `settings-local-deployments` — each bonus pays only inside itself. **Encoded:** deploy pools
  (`src/analysis/local-deploy.ts`). Derived. Source: General strategy guidelines.
- `settings-no-split` — one move per territory a turn; stage armies ahead. **Encoded:** one move
  per source in the planner. Derived. Source: General strategy guidelines.

## Cards

- `cards-piece-each-turn` — one capture a turn earns the piece; more earn nothing. **Advice
  only.** Source: Cards.
- `cards-order-delay` — orders go last: for an attack that should land after the defender
  moves. **Advice only**, derived. Source: Cards.
- `cards-order-priority` — orders go first: withdraw from a doomed territory or strike a stack.
  **Encoded:** the planner's `cardAdvice` (`warapp_plan_turn`). Derived. Source: Cards.
- `cards-blockade-own-bonus` — when weaker, blockade your own border to wall a bonus. **Advice
  only**, derived; shown when behind or the standing is unknown. Source: Cards.

## Reading the game

- `reading-count-armies` — the armies an opponent gains beyond losses are its income.
  **Encoded:** per-opponent deploy estimates and the profile's standing. Source: Good 1v1 strategies.
- `reading-infer-bonuses` — deploys minus base income are the bonuses held. **Advice only**,
  derived. Source: Good 1v1 strategies.
- `reading-border-neutrals` — hold off on neutrals next to an enemy. **Advice only.** Source:
  General strategy guidelines.
- `reading-idle-armies` — walk backline armies to the front. **Advice only.** Source: FFA strategy.
- `reading-ahead` — ahead, trade and keep pressure. **Encoded:** 1v1 pressure when ahead (profile
  rule 0p). Derived. Source: Good 1v1 strategies.
- `reading-behind` — behind, avoid even trades and defend. **Encoded:** the defend goal and
  minimal sizes when behind (profile rule 0p). Derived. Source: Good 1v1 strategies.

## Map (general)

- `map-defensible-bonuses` — weigh a bonus by the cost to take and to keep it. **Encoded:** the
  map notes' ranking and entry points; the pick advisor's entry-point discount. Source: Good 1v1 strategies.
- `map-chokepoints` — hold the bottlenecks in front of your bonuses. **Encoded:** chokepoints in
  the map notes and `warapp_get_map`. Source: Good 1v1 strategies.
