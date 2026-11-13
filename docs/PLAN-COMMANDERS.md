# warapp-mcp — plan: commanders and uncommit (#61)

Worktree `/Users/chris/git/warapp-mcp-cmdr`, branch `feat/commanders` (from `origin/main`). Never switch
branches, never push, never touch other worktrees. Hard rules: no live network in tests or agents,
synthetic fixtures only, never the real account email, a real game id or player name (the issue quotes
real names and ids — never copy them); never read `~/.config/warapp-mcp/session.json` or `.env`. The
cached client bundle (`~/.config/warapp-mcp/bundle/*.js`) may be READ to learn encodings and rules,
never copied. Read GitHub issue #61. TDD; green = `npm test` AND `npm run build`.

### C1 — Read commanders; show them on the live board
A `TerritoryStanding`'s armies record carries a list of special units (`Commander { guid, ownerId }`).
Decode special units into the live board / `BoardState` (territory → units with kind and owner) via
the existing interpreter path, and show them in `warapp_get_live_board` (compact: a `commander` flag
with owner on the territory; full: the unit list). Synthetic decode tests built like the existing
board tests. Document in `docs/WEB-PROTOCOL.md` (from the bundle).

### C2 — Planner: commanders matter
Verify commander combat strength from the bundle (the issue says a commander fights as 7 — confirm the
attack and defence values and whether it dies last). Count special units in attack/defence arithmetic
(a stack with a commander defends as armies + its value). My commander's territory is must-hold:
never conceded, never left takeable at the worst-case enemy deploy if the budget allows (warn if it
cannot), and the plan never moves the commander out into danger (keep it out of planned moves unless
its destination is safer). An enemy commander that is reachable is a priority target: size the
attack against its defence plus the owner's full estimated deploy and prefer it over expansion
(rationale: killing a commander eliminates that player). Tests: my commander's border not conceded
in the issue-like case; an adjacent 0-army enemy commander attacked first; a commander counted in a
threat check.

### C3 — `warapp_uncommit_turn`
Confirm-gated (`defineWrite`/`registerWrite`) tool calling **`UnCommit` = method 80** with its
parameters from the bundle's writer (golden bytes). Refuse when the game is not in progress or my
orders are not committed; after sending, read back via GameFeed/live board that the orders are no
longer committed (`uncommitted` / `unconfirmed`); a transport failure reports `unknown`, never
retried. Mention in `warapp_submit_turn`'s "already committed" error that `warapp_uncommit_turn`
exists. Mark the encoding verified-from-bundle, not live. Register it everywhere other write tools
are listed (README, skill, manifest, CLAUDE.md, packaging/annotation tests).
