# warapp-mcp — plan: the contact fallback weighs the frontier, not filters on it (#114)

Worktree `/Users/chris/git/warapp-mcp-114`, branch `fix/fallback-frontier-cost` (from `origin/main`). Never switch
branches, never push, never touch other worktrees. Hard rules: no live network (never call war.app); synthetic
fixtures only (made-up names); no email; never read session.json or .env. Planner stays pure and deterministic
(ties on ascending id). TDD; green = `npm run build` AND `npm test`. Read `gh issue view 114`, `112`, `107`
(read-only), and rule 4e (contact part: ranking, `lossOf`, free captures, `holdLeftShort`) and rule 4d
(`outgrows`) in `src/analysis/planner.ts`, and `tests/analysis/stand-still.test.ts`.

## F1 — rule 4d is a cost in the contact/late fallback
Live (#114): 8-player FFA, contact, 60/70, every neutral 15, income 5. The fallback took a 15-neutral with 25
(loses ~11). A 0-army enemy territory next to a 15-stack was refused by rule 4d ("adds a border facing an enemy
… frontier would then need 12 … more than the next income of 5"); a 4-army enemy territory next to another
15-stack left no line at all.
- In the contact/late fallback (only there — passes 1–3, opening/expansion 4e and every other rule keep 4d as
  today), 4d's frontier stop does not refuse a candidate. Instead the candidate's ranking cost is
  `expected armies lost + armies at risk`, where armies at risk = the survivors left on the captured territory
  when it cannot be held next turn at the expected enemy deploy (the same hold arithmetic 4d/R3 use; 0 when it
  can be held or faces no enemy). Rank: second front last (0p.2, as now), affordable, then this cost, then
  armies sent, then bonus tie-break, then id. Free captures (#112) stay "loses no armies" and additionally
  need armies at risk ≤ the armies sent (always true) — i.e. 4d no longer blocks them either; their rationale
  says when the new border may fall next turn.
- Rationale for the pick names both parts ("loses ~3, and its 5 survivors may fall next turn"); the 4d
  refusal line is not emitted for a candidate the fallback then takes.
- Find why the 4-army enemy capture next to a 15-stack produced no line (candidate filter, `holdLeftShort`,
  sizing, second-front, commander, `gainWith`…) and fix the cause if it is a bug; in any case every candidate the
  fallback considers and drops leaves a reason in the plan (rationale or warning, one line listing them is
  fine).
- **Tests (synthetic #114 shape):** 15-stacks, a 15-neutral toward a big bonus, a 0-army and a 4-army enemy
  territory whose capture grows an enemy frontier beyond next income → the 0 is taken (and the 4 if it is free
  or cheaper than the neutral by the new cost — assert exactly what the arithmetic gives), not the neutral;
  4d still refuses the same capture outside the fallback (a board where another capture is planned);
  opening/expansion unchanged; every dropped candidate has a reason; validateTurn passes. Header rule 4e
  updated.

## Ship
PR `fix(planner): the contact fallback counts the frontier as armies at risk, not a veto (#114)`, `Closes #114`.
