# warapp-mcp — plan: compact 1v1 picks (#73)

Worktree `~/git/warapp-mcp-picks73`, branch `fix/picks-1v1-compact` (off main). Hard rules as in
`docs/PLAN-PICKS.md`: no live network, synthetic fixtures only (made-up maps, ids, names), never a
real game id, player, map or territory name; the picker stays pure and deterministic.

## Why
Live 1v1 (#73, read `gh issue view 73` and its comments): the advisor spread the three picks over three
continents ("in a 1v1 … picks may spread … so one counter-pick cannot wipe them"), leaving frontier
on three continents from turn 1; each region was broken in turn. The counter-pick risk is already
covered by the fallback group (granted in order when primary picks are lost), so the primary need not
spread.

## K1 — compact by default in a 1v1
- `src/analysis/picks.ts`: a 1v1 builds both groups with the same compactness rule as games with
  three or more players (`COMPACT_DISTANCE`, relaxing one hop at a time with a warning only when no
  compact group exists). Remove the 1v1 spread path (`SPREAD_DISTANCE`, `SPREAD_RELAX_GAIN`) from the
  default; keep it only behind an explicit option `spread: true` (planPicks input and
  `warapp_plan_picks` parameter, described as "spread the 1v1 primary across bonuses against a
  counter-pick; usually worse on large maps").
- The fallback group stays disjoint, and in a 1v1 prefers a **different area** from the primary:
  among equally scored compact fallbacks, prefer the one farthest from the primary (graph
  distance); never at the cost of compactness within the fallback.
- In a 1v1, the per-entry-point discount on a bonus's worth is stronger (state the factor), so
  bonuses with few entry points win ties against wide ones.
- Header comment, reasons and warnings updated; `docs/STRATEGY.md` heuristic 1 and the "how picks
  are granted" paragraph say compact by default, why (fallback = counter-pick insurance, spread =
  many fronts), and the option.
- **Tests:** a synthetic multi-region 1v1 map where the old code spread across regions → now one
  compact primary; `spread: true` reproduces the old behaviour; the fallback is compact, disjoint
  and in another area when one scores equally; stronger entry-point discount changes a tie in a
  1v1 and not in an FFA; FFA outputs unchanged; determinism. Update existing 1v1 expectations that
  encoded spreading, listing each in the commit.
- Tool surface: strict surface lint 0 warnings (recipe in docs/PLAN-TURN.md T4).
