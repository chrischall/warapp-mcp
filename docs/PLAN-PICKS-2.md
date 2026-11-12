# warapp-mcp — plan: pick advisor fixes from live use (#47)

Worktree `/Users/chris/git/warapp-mcp-picks2`, branch `fix/picks-compact` (from `origin/main`). Never
switch branches, never push, never touch other worktrees. Hard rules: no live network in tests or
agents, synthetic fixtures only, never the real account email, a real game id or a real player name;
never read `~/.config/warapp-mcp/session.json` or `.env`. TDD; green = `npm test` AND `npm run build`.
`src/analysis/picks.ts` stays pure and deterministic. Read GitHub issue #47 (`gh issue view 47`).

## E1 — compactness, honest completion turns, reasons that lead with the point
1. **Compactness is not enforced.** A 1v1 primary group came out 5–8 hops apart while the rationale
   claimed "each within 2 hops of another". Measure distance with the same graph `warapp_plan_route`
   uses (`src/analysis/graph.ts` `distance`/route code). Decide one rule and make the code and the
   rationale agree: in games with ≥ 3 players the primary group must be compact (each pick within 2
   hops of another primary pick; if no compact group of `TerritoryLimit` exists, say so in a warning
   and relax step by step); in 1v1 spreading across bonuses is allowed but bounded — the rationale must
   state the actual max pairwise hop distance of the group rather than claim compactness. Test: top-
   scored territories far apart in a ≥ 3-player game → a compact group is chosen; 1v1 → the
   rationale reports the real distances; the group never claims compactness it lacks.
2. **Completion turns too optimistic.** Live: the advisor said a +3 bonus completes on turn 1 and a +5
   on turn 2; on turn 1 `warapp_plan_turn` said 9 and 12 armies were still needed. Audit the opening
   simulation: neutral sizes (use the live board's real neutral armies and wastelands), only
   territories adjacent to what I hold can be attacked each turn (captured armies can't attack the
   same turn), income per turn (base + completed bonuses, per the current income rule incl. #38's
   territory rule), the guard army, and that attacks are funded from armies actually on the bordering
   territory plus that turn's deploy. Fix what is wrong. Test: a synthetic map reproducing "bonus needs
   9 armies to finish on turn 1" → the advisor does not claim turn-1 completion; a genuine first-turn
   bonus still reports turn 1.
3. **Reasons lead with the point.** Each pick's `reasons[0]` names the bonus it anchors/advances and
   its expected completion turn (or the income it adds); negatives come after. Test pins `reasons[0]`.
Update `docs/STRATEGY.md` / CLAUDE.md where a stated rule changes. Commit (fix(picks): ...). Closes #47.
