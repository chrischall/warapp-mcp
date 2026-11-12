# warapp-mcp — phase 10 plan: find and join open games without Chrome (#27)

Worktree `/Users/chris/git/warapp-mcp-opengames`, branch `feat/open-games` (from `origin/main`).
Other builds run in other `~/git/warapp-mcp-*` worktrees — never touch them, never switch
branches, never push. Hard rules as before: no live network in tests or agents (agents never call
war.app), no captured data in the repo, synthetic fixtures built by the encoder (`test@example.com`,
made-up ids), the client bundle is never committed or quoted — tests use the hand-written
mini-bundle pattern already in `tests/` (see how `src/protocol/interp.ts` is tested).

Agents MAY read the locally cached client bundle (`~/.config/warapp-mcp/bundle/*.js`) to confirm
a reader's field order; describe what they find in prose in `docs/WEB-PROTOCOL.md`, never paste it.

## Facts verified live on 2026-11-12

**The open-games list is embedded in a page, not a `/Services` call.**
- `GET https://war.app/MultiPlayer/OpenGames`, signed in (the direct transport's `AuthToken`
  cookie, or the bridge's page fetch — the existing `LiveContext.fetchPage`), returns HTML containing
  `<script type="text/plain" id="AllOpenGamesData">UPPERCASE HEX</script>` (~68 KB for ~75 games).
- The client decodes it as: hex → bytes → a reader; an **int32 count** (the same reader op used for
  list counts elsewhere), then that many **`warlight.shared.GameInfo`** records, each read by the
  bundle's registered reader for that type. So: hex-decode, then use the bundle interpreter
  (`ClassReader.readClass('warlight.shared.GameInfo', reader)`) in a loop.
- `GameInfo` fields are minified; identify them by type name / read order like the existing
  readers (`src/live.ts`, `src/cards.ts`) — never key on minified names. Needed per game: game id,
  name, number of players / open seats (the open-seat records are `warlight.shared.GameOpenSeat`,
  each with a team), boot time / pace (multi-day vs real-time), the template/map id if present,
  entry fee if present, and the settings flags the record carries. Whatever cannot be read reliably
  is omitted, never guessed; the reader stays loose (an unexpected record is skipped, never throws).
- The page hides games the account fails prerequisites for; that count is in the page text
  ("N games are being hidden due to prerequisites") — report it when found.
- Method ids (client method table): `GetOpenGames` 10 exists but the web client never calls it
  (do not use it); `AcceptGame` 60; **`AcceptOpenSeat` 61**; `AcceptOpenAutoGame` 62;
  `GetOpenAutoGame` 63; `DeclineGame` 64; `GetGameSettings` 48; `GetGameDetails` 38.

**Joining is `AcceptOpenSeat` (61)**, posted to `/Services?m=AcceptOpenSeat&js=1` like every other
method (through `WarappRpc`). Parameters after the frame header, in order (from the client's writer):
1. the auth block (as every authenticated method writes it),
2. `int32 gameId`,
3. the colour: present flag + `GameColor` record — **corrected 2026-11-12 (#37)**: war.app refuses an
   absent colour ("color is null", server error 1); send the account's colour (docs/WEB-PROTOCOL.md),
4. `int32 team` — the team of the open seat being taken (from that seat's `GameOpenSeat` record; a
   non-team game's open seats carry the no-team value — read it from the record, don't hard-code),
5. an optional `int32` start slot: present flag + value — send **absent** (custom-scenario games
   need one; refuse those),
6. a `bool` — confirm its meaning in the cached bundle (the client passes a per-method flag);
   the live join from the web client is the reference behaviour.
Reply: `warlight.shared.AcceptOpenSeatReturn`. Error codes the client handles: **254** "your slot was
assigned to someone else by the game creator", **750** "the slot you joined is no longer available",
**473** "not enough coins"; map them in the RPC error table with that wording.
Confirm the exact field order of steps 3–6 against the cached bundle before encoding, and pin the
encoder with a golden test (synthetic ids).

## Tasks

### G1 — Read the open-games list (`warapp_list_open_games`, read-only)
- `src/open-games.ts`: `parseOpenGamesPage(html, bundle)` → `{ games: OpenGame[], hiddenByPrerequisites?: number }`
  (hex extraction + count + `GameInfo` records via the interpreter, normalized). Loose: missing
  script tag → `[]` with a note, a bad record → skipped.
- Tool `warapp_list_open_games` (read-only annotations, untrusted-content wrapper like other tools
  that return player-written names): fetches the page through the live context's page fetch (works
  in direct mode with no browser), filters: `pace` (`multi-day` | `real-time` | `both`, default
  multi-day), `max_players`, `free_only` (default true), `exclude_teams` (default true),
  `limit`. Each game also gets `plannerGaps`: rule flags the planner does not model yet
  (non-default kill rates → #28, local deployment → #29, commerce, custom scenario, …) — only for
  flags actually read from the record.
- Tests: a synthetic page whose hex is built with the encoder + mini-bundle `GameInfo` reader;
  filters; malformed hex; missing tag; the hidden-count text.

### G2 — Join a game (`warapp_join_game`, confirm-gated write)
- `src/protocol/methods.ts`: add the method ids above; `writeAcceptOpenSeatParams` with a golden test.
- Tool `warapp_join_game` via mcp-utils `defineWrite`/`registerWrite` (same pattern as
  `warapp_send_chat`): input `game_id`. It re-reads the open-games list, refuses a game not listed,
  a full game, a team game (unless `allow_team: true`), a coin entry fee (unless
  `accept_entry_fee: true`), a custom-scenario game; the preview names the game, pace, seats and
  rule flags. After the join, report success only when GameFeed (or `warapp_my_games`) lists the
  game for the account; otherwise say it is unconfirmed.
- Tests with the mocked RPC: preview, confirm, each refusal, error 254/750/473 wording.

### G3 — Docs and packaging
- `docs/WEB-PROTOCOL.md`: the AllOpenGamesData page payload and AcceptOpenSeat (prose, no bundle
  code); `docs/WARAPP-API.md` if it lists tools; README/tool list; the repo CLAUDE.md gains one
  line: open games come from the page payload, joining is AcceptOpenSeat (confirm-gated).
- Tool-annotation and packaging tests updated for the two new tools.

Every task: `npm test` (typecheck + vitest) green; `git grep` the diff for a real email before
committing; stage exact paths; one conventional commit per task (`feat(games): …`).
