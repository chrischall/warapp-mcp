# warapp-mcp — phase 4 plan: my games, opponent scouting, shell skill

Worktree `/Users/chris/git/warapp-mcp-scout`, branch `feat/scouting` (from `origin/main` with #9
merged). Never switch branches, never push, never touch other worktrees. Same hard rules as
before (`docs/PLAN-LIVE.md`): no live network in tests or agents, no captured data, synthetic
fixtures only, real account email never in the repo.

Facts observed live (2026-11-12), all through the browser bridge:

- **`GetMyGames` (50)** — params: auth, bool present + `MyGamesFilters { byte filterType = 4,
  int32 count = 10, byte sort = 2 }` (REQUIRED — absent filters make the server throw a
  NullPointerException), then bool false, int32 0, bool false, bool false. Reply
  `warlight.shared.MyGamesReturn`: field 1 is a list of `warlight.shared.GameInfo`. GameInfo's
  reader (in read order): int32, int64, string, int32, int32, int64, fog enum, **int32 gameId**,
  bool, date, **int32 mapId**, int32, optional int32, **string name**, **int32 lastTurn**
  (TurnNumber = lastTurn + 1; -1 before turn 1), optional int list, optional list of
  `warlight.shared.GameInfoPlayer`, 4 bools, optional settings, **GameState enum** (read via the
  GameState enum class), bool, int64, optional object, int64. Decode it with the bundle
  interpreter by stable type name — do not hand-transcribe the layout.
  GameState: 2 WaitingForPlayers, 3 Playing, 4 Finished, 5 DistributingTerritories.
  `GameInfoPlayer`: optional object, bool, **bool committed** (`lh`: the client sets it after
  a successful commit), int32, bool, **string name**, **int32 in-game player id**,
  **GamePlayerState enum** (1 Invited, 2 Playing, 3 Eliminated, 4 Won, 5 Declined,
  6 RemovedByHost, 7 SurrenderAccepted, 8 Booted, 9 EndedByVote), int32, bool.
- **Profile page** `GET https://war.app/Profile?p=<invite token>` (server-rendered HTML, a GET the
  extension makes — no frame): title `<name> - War.app …`; text lines
  `Level 55`; `Played in 1606 multi-player games (87.1% real-time)`;
  `Last seen less than 15 minutes ago`; `Booted 200 times (14% of their last 100)`; and a Ranked
  Games block: `Completed</font> 1582 ranked games (485 / 1582)` followed by rows
  `<font class="text-muted">LABEL:</font> W / G (P%)` (labels like `1v1`, `9 player FFA`, `2v2`).
  The page also shows personal details (e.g. self-reported location): **never parse or return
  them** — project an allowlist of the fields above.
- **Common games page** `GET https://war.app/CommonGames?p=<invite token>`: `<h1>N Common Game(s)
  with NAME</h1>` then a `dataTable` whose rows are
  `<td><a href="MultiPlayer?GameID=ID">NAME</a></td><td>DATE</td><td>TEAMS</td><td>YOUR STATE</td>`.
- Invite token = the GameFeed player id (string of digits); the in-game id is that minus two
  check digits each end.

## S1 — `warapp_my_games` (read)
`GetMyGames` through the bridge, decoded by type name. Output per game: id, name, state (named),
turn (lastTurn + 1, or null before turn 1), players (name, state named, committed), and
`waitingOnYou` = game is Playing or DistributingTerritories, my player is Playing, and my
`committed` is false (my player = the signed-in account by invite token; in-game id match).
Sort games waiting on you first. Untrusted framing (names). `_meta.mint`: intent `whats-new`,
canonical, with a `view: 'brief'` rung (one line per game: `name — <turn or state> — waiting on
you | waiting on others`) per the context-group contract in the hints test. Tests with a
synthetic MyGamesReturn built by the mini-bundle approach used by the live-board tests.

## S2 — `warapp_scout_player` (read)
Input: game_id + player (name or id), or a raw player id/token. Fetches the Profile and
CommonGames pages through the bridge (GET) and returns ONLY: name, level, multiplayer games
played and real-time share, last seen (text), boot count and boot rate, ranked totals and the
per-format records `{format, wins, games, pct}`, and head-to-head: the common games list
(id, name, started, teams, my state) with counts of my wins/losses/in-progress. Never return
location or any other personal field; a test feeds HTML that contains a location line and
asserts it is absent from the output. Parsing must tolerate missing blocks (a new player has
no ranked games) and report `null`, not throw. Untrusted framing. `_meta.mint`: intent `lookup`.

## S3 — `skills/warapp-api`: bridge recipes
Extend the shell skill with `fpx` (profile `warapp`, domain `war.app`) recipes for the two pages
(profile stats, common games) using a dependency-free `references/scout.mjs` that reads HTML
on stdin and prints the same allowlisted JSON (EPIPE-safe). Document the one-time
`fpx profile add warapp --domain war.app` + pairing, the frozen-tab gotcha, and that the
official-API recipes need no bridge. Execute every documented pipeline against a saved
SYNTHETIC html fixture under bash and zsh in tests (the existing skills test pattern).

## S4 — Docs and packaging
README tool table, CLAUDE.md (the two pages, the no-personal-fields rule), skills/warapp-mcp
SKILL.md (scouting + "which games need me" + the in-context-groups section), manifest.json
roster, hints test table. Strict surface lint 0 warnings (same recipe as PLAN-TURN.md T4).
