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

### C2b — commander rules, decided after three failed review rounds (owner's design decisions)
The C2 commits on this branch are kept; fix them to these decisions (they override C2's text):
1. **No vanishing.** war.app interleaves both players' attacks after deploys; a strike does NOT
   remove the struck player's other territories as threats this turn. My commander's reserve, each
   source's keep, and every border judgement use the full threat including the struck player's other
   stacks. Elimination only changes NEXT turn's picture.
2. **Strike vs commander safety.** My commander's must-hold reserve is funded first. A strike on an
   enemy commander is then funded from what is left plus sources' movable armies beyond their keep;
   a source whose own hold is hopeless may send everything (its armies are lost anyway) — that is not
   "keeping all", fix `keepFor` accordingly.
3. **No R3 veto.** The defensibility rule (completing a bonus I cannot hold next turn) never vetoes
   a commander strike: killing a commander eliminates a player; the bonus side-effect is irrelevant.
4. **Order Priority.** When a strike is planned and my commander's tile is threatened this turn,
   set `cardAdvice` to Order Priority if I hold one (so my attacks resolve first) and say so.
5. **Honest warnings.** A strike that is not planned names the actual reason (reserve for my
   commander, source keep, No-Split, locked/conceded source, unaffordable).
6. **Held-bonus units** (rule 1h) exclude a member already funded as my commander's hold from the
   unit's cost and payback test.

As built (departures the owner should know): decision 2's reserve is held as a deploy on my
commander's territory while the strike is tried, so under Local Deployment it is charged to the
pools that reach it. Decision 4: `warapp_plan_turn` also adds the held Order Priority card to the
submitted `orders` whenever `cardAdvice` is `order-priority`, so submitting the plan spends the card.
Decision 5: "locked/conceded source" is never named — strikes run before triage, when nothing is
locked or conceded yet; when no other reason binds, the warning names what each source can send (and,
under Local Deployment, its pool room).
Tests: the three reviewer repros (strike vs reserve with the struck player's other stacks still
threatening; a doomed source striking; a strike in a bonus R3 would veto, under balanced and defend)
plus the Order Priority advice and each warning reason. Remove the copied territory name from
tests/analysis/commanders.test.ts (synthetic description only).
