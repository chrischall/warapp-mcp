# Strategy notes — territory picks

What the pick advisor (`warapp_plan_picks`, scorer in `src/analysis/picks.ts`) believes about
picking in manual-distribution games, written in our own words. The community guides below
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

## How picks are granted

A game allows twice its territory limit in picks, but grants only the territory limit, in list
order, skipping territories another player was granted first. So the list is two plans: the
first `TerritoryLimit` picks are the plan you want, the rest a fallback that still makes sense
when some of the first ones are lost. **Encoded:** the primary group is exactly the territory
limit and the fallback is disjoint from it, each group built by the same rule on its own (compact
with three or more players, bounded spread in a 1v1 — both relaxed, with a warning, when the
remaining picks allow nothing tighter). A fallback that outscores the primary is warned about.

## Heuristics

1. **Safety and room to grow before greed.** A pick set should not lose outright to one bad
   draw, and every pick should have neutral territory to expand into. **Encoded in part:** with three
   or more players each group is compact (one cluster whose picks link up in steps of at most two
   hops, measured on the map graph `warapp_plan_route` uses) so its armies can support each other; when no compact group
   of the territory limit exists the limit relaxes one hop at a time, with a warning. A pick is
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
   neutrals' real sizes, and a bonus's worth is discounted per entry point.
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
6. **1v1: do not put everything in one basket.** With one opponent, spreading picks over
   different bonuses keeps a single counter-pick from wiping the plan. **Encoded:** in a 1v1 a pick
   may join the primary group by anchoring a bonus no other pick anchors, even when it is not
   within two hops — but only within four, unless a group spread farther scores at least 1.5× as
   much (or no bounded group exists), which is warned about, so the bound never quietly sends the
   best picks to the fallback. The rationale states the group's real spread (the hops between its
   two farthest picks and the longest step linking them) instead of calling it compact.
7. **Read the opponent.** Strong picks depend on what the other player is likely to pick and
   where they will start. **Not encoded** — a later strategy phase (it needs their history).
