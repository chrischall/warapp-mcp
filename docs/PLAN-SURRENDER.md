# warapp-mcp — plan: surrender (and take back) a game without the browser (#30)

Worktree `/Users/chris/git/warapp-mcp-surrender`, branch `feat/surrender`, **stacked on
`feat/open-games` (PR #34)** — reuse its confirm-gated write pattern (`src/tools/join-game.ts`) and
its `src/protocol/methods.ts` additions. Never switch branches, never push, never touch other
worktrees. Hard rules: **no live network in tests or agents, synthetic fixtures only (encoder-built
frames, `test@example.com`, made-up ids), never the real account email, a real game id or a real
player name.**

## Facts (verified live 2026-11-12, from GitHub issue #30)
- The web client posts `/Services?m=Surrender&js=1`, **method 67**. Parameters after the frame
  header: the auth block, `int32 gameId`, `bool surrender` (true = surrender, false = take back a
  pending surrender), then the per-method trailing `bool` — the same "ends vacation" flag
  `AcceptOpenSeat` sends — send `false`.
- No result payload on success. Errors: **4** "the game is over"; **7** / **230** "you are no longer in
  the game".
- In games with more than two players a surrender needs the others' acceptance first ("Pending
  surrender"; `AcceptSurrender` is method 68, not in scope): report that state, not "surrendered".

## Tasks

### S1 — Encoder + tool
- `src/protocol/methods.ts`: `Surrender = 67` and `writeSurrenderParams(w, { gameId, surrender })`
  (auth block handled the same way as the other methods). Golden-bytes tests for surrender=true and
  surrender=false, built by hand in the test comment.
- `warapp_surrender` (`game_id`, `undo?: boolean`), registered with mcp-utils
  `defineWrite`/`registerWrite`. The preview is unmistakable: "This ENDS your game <name> — you lose
  it and cannot rejoin" (undo: "take back your pending surrender in <name>"). Before sending: read the
  game from GameFeed; refuse finished games and games the signed-in account is not playing in
  (`undo` also refuses when there is no pending surrender to take back, if GameFeed shows it).
- After sending: re-read GameFeed and report the account's state — surrendered / surrender pending
  (multi-player) / unchanged — from the feed, never from the reply alone. Map error codes 4, 7, 230 to
  clear messages. A transport failure after sending reports `unknown` (never suggest resending).
- Tool annotations: destructive, not idempotent. CLAUDE.md's "two tools write" bullet becomes the
  current list of write tools including this one; README/skill/manifest tool lists updated; the
  packaging/annotation/server-boot tests updated.
- **Tests:** golden bytes; the confirm gate (no send without confirmation); refusal of a finished game
  and of a game I'm not in; post-send state reporting for a 1v1 (surrendered) and a 3-player game
  (pending); errors 4/7/230 mapped; undo path.

### S2 — Docs
`docs/WEB-PROTOCOL.md`: method 67 parameters and errors (verified), the multi-player pending rule.
Strict surface lint 0 warnings (recipe in docs/PLAN-TURN.md T4).

## Accepting another player's surrender (#317)

Owner request of 2026-11-16 ("Support it"): see a pending surrender, raise it when my acceptance is
owed, and accept it with `AcceptSurrender` (68), confirm-gated. Method 68 was out of scope above.

### S1 — the facts and the encoder (done)
Read from the client bundle locally, UNVERIFIED live; written up in docs/WEB-PROTOCOL.md "Accepting a
surrender": a pending surrender is the `Surrendered` flag on `warlight.shared.GamePlayer` in the game
details (`GameWL`, from GameRefresh), with `PlayersAcceptedMySurrender` (in-game id → time) saying who
accepted; GetMyGames and LatestGameInfo carry nothing. My acceptance is owed when that player is
`Playing` and `Surrendered`, my seat is `Playing` and not turned AI, the game is not
`InstantSurrender`, and my id is not in the dict. The writer sends the game id, the surrendering
player's in-game id, the accept flag and a mod-hook bool (false); no result payload.
`writeAcceptSurrenderParams` in `src/protocol/methods.ts`, golden-pinned.

### S2 — see it and raise it (done)
`src/surrender-pending.ts` decodes the seats from a GameRefresh asked for the details only
(`readGameDetailsSeats`) and gives `pendingSurrenders`: `{ inGameId, player, owedByMe }` per surrender
still pending (mine left out), `owedByMe` `null` when my seat is not known. `src/tools/surrender-pending.ts`
reads it only for a game being played or picked where my seat plays; a failed or unreadable read is
`null`, never an empty list. Reported by `warapp_my_games` (per game and the count `surrenderPending`; those
games first; at most 20 reads a call, none for `brief`), `warapp_wait_for_turn` (returns `surrender_pending`
unless `ignore_surrenders`; `surrenders` names the games; after one failed details read it stops asking
for the rest of the wait, `surrenderUnread` saying why once) and `warapp_plan_turn` (`surrenderPending`, and
the first warning when one is owed). Checked offline: a synthetic frame in the real layout decodes through
the cached real bundle's own readers (14 GameWL fields; the player's link back to the game comes first).

### S3 — accept it (done)
`warapp_accept_surrender` (`src/tools/accept-surrender.ts`; the pure part in `src/analysis/accept-surrender.ts`),
confirm-gated, method 68 with accept = true. Refuses a finished game, a lobby, a game I am not playing, an
instant-surrender game, unreadable game details, no surrender pending from the player named (or none, or several
with none named), and my acceptance not owed. The preview: whose seat (`player`, the GameFeed id or `null`, beside `inGameId`; name
through `untrustedText`); its land neutral or AI (`SurrenderedPlayersTurnIntoAIs`); the players bordering that land on the
live board, each by how many of its territories border it (`null` when the board does not read); who else still
owes an acceptance; whether accepting leaves only my side playing (`winsGame`); and one advice line — the win, or in
a free-for-all the neighbour that gains most, citing `ffa-surrender-veto`. The outcome is read back from GameFeed
and the game details: `accepted` / `pending` (both `confirmed`), `unconfirmed`, `unknown`; never resent. The skill
reads chat for surrender requests before each turn and checks pending surrenders at every status sweep; it
accepts only after the owner says so, unless accepting simply wins the game (then it tells the owner afterwards).
