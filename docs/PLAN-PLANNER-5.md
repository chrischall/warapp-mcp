# warapp-mcp — plan: planner fixes from live play, round 5 (#57, #59, #60)

Worktree `/Users/chris/git/warapp-mcp-live2`, branch `fix/planner-live-2` (from `origin/main`). Never
switch branches, never push, never touch other worktrees. Hard rules: no live network in tests or
agents, synthetic fixtures only (made-up maps, ids, names), never the real account email, a real game
id or a real player name (issues quote real names — never copy them). TDD; green = `npm test` AND
`npm run build`. The planner stays pure and deterministic; plans stay valid. Each task: read its
GitHub issue (`gh issue view <n>`) for the live evidence.

### P1 — Enemy income from observed growth (#57)
Under fog, "base + visible bonuses" said ~5 while the opponent's visible armies grew 56 → 93 in one
turn. With `previousBoard`, estimate each opponent's deploy from what it visibly gained: the sum of
positive army growth over its territories visible on both boards (same owner) plus armies it lost
attacking me/others where observable (my territories it took or attacked: armies I lost), plus newly
visible territories' armies only if they were visible-and-neutral before (captures it made). Use
`max(visible-bonus estimate, observed estimate)` — still capped by nothing smaller than the
observation (the stack-based cap must not cut an observed figure). The warning names the source
("observed +37/turn" vs "base + visible bonuses"). Without `previousBoard`, today's behaviour.
Tests: #57-like case (visible growth +37 with no visible bonus → estimate ≥ 37, holds sized to it);
growth on a territory that changed owner is not counted as deploy; no previous board → unchanged;
the warning text.

### P2 — Never withdraw a near-miss garrison from a held bonus (#59)
A held +7 bonus's border had 44 armies facing 69; the plan said "needs 13, only 12 left: conceded",
then moved all 44 out — guaranteeing the loss. (1) A held-bonus border whose hold is short by at most
a small margin (define `NEAR_MISS` — e.g. ≤ 15% of its hold need or ≤ 2 armies, whichever larger;
export it) is funded with everything available rather than conceded, with a warning that it may
fall. (2) Never withdraw an existing garrison from a held bonus's border while the border could still
hold against the expected (not worst-case) attack: expected = enemy movable + its estimated deploy
at the kill rates. (3) Under Local Deployment, a threatened held bonus's own pool goes to its own
threatened border(s) first. Tests: the #59 case (44 vs 69 + ~5, 12 to deploy → all 12 on the border,
no withdrawal, warning); a hopeless border (short by far) still conceded and withdrawn; the LD pool
goes to the bonus's own border.

### P3 — Pressure on a weak opponent's visible territories despite fog (#60)
The finish-off check (rule 1e) skipped an opponent with one visible 0-army territory because more
might be in the fog. When an opponent's visible territories can all be taken at a cost comparable to
normal expansion (sized against that opponent's full estimated deploy on each, as #60 asks), take
them as "pressure" even if fogged territories may remain — never claim elimination. Tests: the #60
case (one visible 0-army territory next to my 7-stack, opponent deploy ~6 → attacked, labelled
pressure); a visible territory too costly → not attacked, warned as today; full visibility still uses
the existing elimination path.
