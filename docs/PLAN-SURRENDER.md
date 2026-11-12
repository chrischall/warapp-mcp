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
