# warapp-mcp — plan: the contact fallback ranks by losses (#112)

Worktree `/Users/chris/git/warapp-mcp-112`, branch `fix/contact-fallback-rank` (from `origin/main`). Never switch
branches, never push, never touch other worktrees. Hard rules: no live network (never call war.app); synthetic
fixtures only (made-up names); no email; never read session.json or .env. Planner stays pure and deterministic
(ties on ascending id). TDD; green = `npm run build` AND `npm test`. Read `gh issue view 112` and `gh issue view
107` (read-only), and rule 4e in `src/analysis/planner.ts` (header + the `// ---- 4e` block, contact part).

## C1 — rank contact/late fallback candidates by the armies they lose
Live (#112): 8-player FFA, contact, 60/70, every neutral 15. The fallback took a 15-neutral with 25 (≈11 lost)
toward a big bonus, while enemy territories of 4 (taken with 8, ≈3 lost) and 0 (taken with 1–2, nothing
lost) bordered my 15-stacks. Cause: the #107 ordering "breaks or advances a bonus, then cheapest".
- In the contact and late phases, rank fallback candidates (neutral and enemy) by: affordable this turn first
  (as today), then **expected armies lost** by the capture (defensive kills on the attackers, at the game's
  rates, for the size actually sent — for a combined capture, the total over its attacks), then armies sent,
  then breaks/advances a bonus as a tie-break, then id. Opening/expansion ranking (#111) is unchanged.
- **Free captures:** after the fallback's capture, also take every other candidate that loses **no** armies
  (e.g. a 0-army enemy territory taken with 1–2), keeps every hold covered and does not lower income, each a
  rationale line ("costs nothing"). Deterministic order (by armies sent, then id).
- The reason text names what it costs ("loses ~3 armies") instead of only the bonus.
- **Tests:** the #112 shape (synthetic): a 15-neutral toward a big bonus vs an enemy 4 and an enemy 0 next to
  15-stacks at 60/70 → the enemy 4 or 0 is taken first (whichever loses fewer — the 0), and the 0-loss capture
  is also taken in addition when the first pick was the 4; the 15-neutral is not taken; holds intact;
  validateTurn passes. A board where only the neutral exists → unchanged. Opening/expansion tests unchanged.
  Header rule 4e updated.

## Ship
PR `fix(planner): the contact fallback takes the capture that loses the fewest armies (#112)`, `Closes #112`.
