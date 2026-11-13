# warapp-mcp — plan: defend held bonuses before speculative expansion (#51)

Worktree `/Users/chris/git/warapp-mcp-holds`, branch `fix/hold-bonuses`, **stacked on
`feat/planner-elimination` (PR #52)**. Never switch branches, never push, never touch other
worktrees. Hard rules: no live network in tests or agents, synthetic fixtures only, never the real
account email, a real game id or player name. TDD; green = `npm test` AND `npm run build`. The
planner stays pure and deterministic; plans stay valid. Read GitHub issue #51 (`gh issue view 51`).

## H1 — held-bonus defence first, all-or-nothing per bonus
Live (goal `balanced`): (a) income 14, a held +5 bonus whose one exposed border (1 army) faces an
enemy 9-stack; the plan spent everything on four advances that completed nothing and conceded the
border ("needs 8, protects +5"). (b) income 9, a held +4 bonus with three threatened borders: it
funded two (4 + 4) and conceded the third, which breaks the bonus anyway.
1. **Group holds by held bonus.** For every bonus I hold in full, its threatened borders form one
   unit: hold cost = the sum of each border's hold cost (a border shared by two held bonuses is
   counted once, in both units' feasibility). Fund the whole unit or none of it; never fund part of a
   bonus's borders while conceding another of its borders unless that border's own protected value
   (other bonuses, per-territory income, the stack it saves) justifies it alone — warn when a unit
   is conceded as a whole ("conceding <bonus>: holding all N borders needs X, more than …").
2. **Priority.** A held-bonus unit that pays for itself (hold cost ≤ PAYBACK_TURNS × value — the
   existing payback constant) is funded **before** any capture that does not complete a bonus this
   turn (advances, breaks, other expansion), under `balanced` and `defend`. Completing a bonus this
   turn still competes on its score, and finishing off a weak opponent (rule 1e) keeps its place.
   Under `expand` behaviour is unchanged (it is the ignore-defence goal) but it warns.
3. Only concede a held bonus when its unit's hold cost exceeds what the alternatives earn (the
   existing score comparison, with holds valued at value per turn over PAYBACK_TURNS).
4. **Tests:** both live cases as synthetic boards — (a) the +5 bonus's border gets its full hold
   (exact deploy) and the leftover funds expansion; (b) all three borders of the +4 bonus are held
   when affordable, and when not affordable none of them are (the bonus is conceded as a unit, the
   income goes elsewhere) with the warning; a unit that does not pay for itself (hold cost >
   PAYBACK_TURNS × value) is conceded; `expand` unchanged; the existing suites pass (change
   expectations only where intended, and say which in the commit).
Update CLAUDE.md's planner bullet and the planner header rule list. Commit (fix(planner): ...).
Closes #51.
