# src/tools/ — warapp-mcp

What is true of the tools, the stores they keep and the protocol calls behind each feature. The repo-wide rules are in the root `CLAUDE.md`.

- **Moving history between servers (`src/state-bundle.ts`, `src/state-cli.ts`, `src/tools/state.ts`).**
  `warapp-mcp export-state --out <file>` (dispatched in `src/index.ts` before the env file is read: no credential
  is ever loaded) writes one gzipped JSON bundle, 0600: a manifest (format `warapp-state`, version 1, account id,
  created time, each file's path, sha256 and size) and the files. It carries only paths the `RULES` table owns:
  the salt, `relations/players.json`, the account's ledgers, `profiles/players.json` and `population.json`,
  `lessons.json`, `maps-record/`, `finished/` (processed marks included), and for games still in play only
  (finished: an end-of-game record or processed mark, else a game record saying `Finished`; no record and no
  mark: unknown, left out) the boards, game records, outlook, picks, move order, teams, per-game profile turns and
  siege memory and contested-bonus attempts; and every game's decision log, finished games too (#412: newest first up to
  `MAX_EXPORT_DECISION_BYTES`, the rest counted in `leftOut.decisionLogs`). Never credentials, the bundle cache, the guess salt, chat cursors, maps or stats. The account is
  `--account`, else the one the board caches' `playerId` names, else the one the per-account file names name.
  The CLI prints counts and sizes only. Hosted (only with mcp-host's blob store, `blobStoreFromEnv`),
  `warapp_upload_slots` mints a signed PUT (`mintUploadSlot`) and `warapp_import_state` (confirm-gated, a
  write) reads it back (`resolveUploadSource`), verifies every file (`decodeBundle`: paths, the
  account of per-account files, size, sha256, JSON, a salt; never echoing contents), refuses another account
  and a different or malformed salt unless `replace`, which moves `relations/`, `profiles/`, `finished/`,
  `maps-record/` and `lessons.json` into `state-backups/<time>/` (0700, never deleted). Without `replace` a file
  that differs is kept; under it the displaced file goes to the backup. The salt is written first (by `link`, never
  over one made meanwhile), then each file atomically, 0600 in 0700 folders, under its store's path lock
  (`profiles/.store` for the two profile stores). The upload is deleted after an import and when it is no bundle;
  an account or salt refusal keeps it for a retry. `warapp_backfill_history` (not confirm-gated: this server's
  state only, never war.app) runs `sweepFinished` with `limit` (default 10, max 25) and an optional `window` (at
  most `MAX_FINISHED_RECORDS`), so each game's history is still read once; it then fills the winners' income curves
  of map-record entries kept before #419 from the kept histories (`winnerCurves`, no request). It lists every game
  considered one by one (`games`, `gameStanding`: recorded — status, failure code, history turns, boards, stats version,
  `collector` and `outdated` — not-processed, processed-record-pruned, record-unreadable; and `thisCall` read / reread /
  waiting), from this server's state alone; `game_ids` limits it (others in `notFinishedOrNotMine`). **Re-reads (owner
  request 2026-11-25):** every record carries `collector` = `COLLECTOR_VERSION` (src/finished-store.ts; absent on
  records kept before it, read as 0) — bump it whenever the capture or its processing gains or changes a metric — and
  `reread` (`failed`, `outdated`, `all`) reads the history AGAIN, past the processed marks (`EndOfGameOptions.reread`,
  once per game per process): the record and everything processed from it are rebuilt, each store replacing the
  game's share; a re-read that does not capture never replaces a captured record (`keptPrevious`).
- **Strategy notes are data in `src/strategy/notes.ts`**, served by the read-only `warapp_strategy` and the
  `warapp://strategy` resources: each in our own words (at most 340 characters) with one source link from the
  researched pages — the war.app wiki and forum, or a community guide the wiki links to — marked `source` or
  `derived`; never paste guide text. Nine topics (`NOTE_TOPICS`: format, settings, cards, reading, opening, timing,
  fighting, diplomacy, map). A note says which games it is for as data (`NoteCondition`: format, phase, standing, fog level,
  move order, distribution, kill rates, the guard, cards in play, private messaging on or off, and so on), tested against the profile and
  `noteContext(settings)`; a condition on something the game did not state does not hold, and a card condition
  falls back to "any card" when the list is unknown. `docs/STRATEGY.md` names every note id (a test checks it, and
  another that some game reaches every note). With a game the profile is `feedProfile` (standing `unknown`) on GameFeed's
  players and settings, judged for the signed-in account's seat when it is seated and still playing (a seat that is out is ignored: judged for it, every player left would count as an opponent) (#309: GameFeed's board for a game in
  progress has no standing, so the phase never read contact or late): while the game is played and that seat plays,
  the phase reads the live board (`loadLiveGame`, as warapp_plan_turn; read-only, nothing kept), else — or on any
  failure — GameFeed's standing as before; `profile.source` says `live` or `gamefeed`, and a failed live board read is
  said as `profile.liveError` (a short reason, `FROZEN_TAB_HINT` after a bridged timeout), never dropped. `warapp_plan_turn`'s full view
  adds `notes`, the ids of `notesFor` its own profile (never compact; the plan never reads them). The answer carries the game's `cardClock` (`src/strategy/card-clock.ts`: per card, the
  capturing turns to the first one, fastest and guaranteed, from the pieces, starting pieces, minimums and pieces
  per turn in the settings; whether a commerce game is on is read from a non-empty `Commerce` object, verified 2026-11-17).
  With no game and no topic the compact answer is the topic index, with `notes` as ids and topics only. A `map_id` alone works only for
  a map this process has cached, since GameFeed serves maps only with a game.
- **Who moved first is kept between turns (#127, `src/move-order.ts`).** In a two-player game under `Cycle`
  or `NoLuckCycle` the first mover alternates every turn, so `warapp_plan_turn` keeps one known turn at
  `<dataDir>/move-order/<gameId>.json` (turn, `me`/`opponent`, source) and later turns default to it,
  alternated. Sources, best first: `first_mover` given now; a kept explicit turn; last turn `inferred` (#299,
  `inferFirstMover`: my first order last turn captured a territory it could not have taken from the armies there
  at the start of the turn, so the opponent's order ran first — 0% luck and straight rounding only, no card of mine
  touching it, no Order Priority the opponent may hold; never verified, so it orders moves but never sizes a hold);
  a kept inferred turn; the award; a kept award turn. Disagreement is a warning; `firstMover` reports
  `{ who, source, from?, line }` (`line`: "You move first on turn N (…)"). The game history is not
  read for it (UNVERIFIED whether an in-progress `GetHistory` carries the orders in the order they ran).
  `warapp_check_plan` writes no move order and still tries both orders unless `first_mover` is given.
- **Chat has channels (part A1 of `docs/PLAN-TEAMS.md`).** The `GameRefresh` read of **public** messages is
  VERIFIED LIVE 2026-11-14 (count, time, turn, sender and channel matched GameFeed `GetChat=true`); team and
  private channels, `mark_seen` / the cursor, `warapp_plan_turn`'s `chat.unread`, `chatActivity` and sending
  remain UNVERIFIED. `warapp_get_chat` reads
  `GameRefresh` (40, chat only) → `GameDetailsAndChat` → `GameMessage` by type name (`src/chat.ts`:
  fields by read order (243: 12 fields, the shared images at 5 and the reactions at 7, both optional lists), a private counterpart first, then a game group (`unknown`), then the channel,
  -1 public else the team), but only when the signed-in account can be read; otherwise, or on any
  failure, GameFeed's `chat` (no channel: `unknown`). **GameRefresh leaves out messages war.app counts as seen
  (#363: an own team message), so the web read also asks `RetrieveChat` (45) and, unless private messaging is off,
  `RetrievePrivateMessageHistory` (46) per other human seat (at most `MAX_PRIVATE_HISTORY`, 8)** — the client's "show
  older messages", markers the oldest id received or `999900000000000000` (`OLDEST_CHAT_MARKER`) — merged by id; a
  failed one is named in `olderUnread`. A private message to me carries `toMe: true`; inbox entries count them (#387). **A web read with fewer messages than GameFeed's chat (#313:
  a finished game's surrender line was missing) uses GameFeed's too**, from the GameFeed read the tool already made
  (`readChat` in `src/tools/chat.ts`, no extra request): with no web message GameFeed's list stands in, else the
  GameFeed messages no web message matches (same sender, times within a second, or the same text when either has no
  time; `fillFromFeed` in `src/chat.ts`) are added under `unknown` by time (the mark then records the named channels
  too). **`source` keeps its contract (#321): `web` | `gamefeed`, the read that answered** — a filled web read is
  `web`; the fill shows only in the additive `filledFromGamefeed: true` and `feedFill` (counts and a note), so no
  caller meets a new enum value. `warapp_mark_chat_read` takes a filled read with web messages (their ids) and
  refuses one whose web read returned none (no id to mark: it says so, never "retry"). Bodies go out through `untrustedBody` (the
  `untrustedText` cleaning, capped at 2,000). "New" is a name-free cursor at `<dataDir>/chat/<gameId>.json`
  (`src/chat-cursor.ts`: per channel the count and newest time marked seen, plus the whole chat, against
  which every message is judged too — a named channel by time only: seen by either mark is not new); only
  `mark_seen: true` writes it (from GameFeed only `unknown` and the whole chat, never a named channel, so a
  later web read keeps what was seen; `markedUnshown` counts unread messages `limit` cut); mine are never
  new. GameFeed chat in a shape no reader knows goes out as `raw` with every string through `untrustedBody`. `warapp_plan_turn` reports `chat.unread` from the GameFeed chat of its own
  game read (no extra request), so every count is under `unknown` (its `note` says so). Third-party names in
  results (sender, recipient, game) go through `untrustedText`.
  `warapp_chat_inbox` (#256, read-only, hosted too; a tool of its own, since it takes no game and pages a list)
  reads exactly `game_ids` when given (#260), else every game `GetMyGames` lists but a finished one (`chatGameIds`:
  lobbies, picking, playing; `gamesFrom`, with `listed`/`complete` and a warning when the list may be partial), in
  ascending id order, one at a time and at most `MAX_INBOX_GAMES` (10) per call (`next` = the last id read,
  passed back as `cursor`), each exactly as `warapp_get_chat` reads it; a game with new messages shows only
  those (`limit` newest, `markedUnshown`), the others are `quiet`, and a failed read is in `failed`, never
  thrown. Only `mark_seen: true` writes the cursor (every channel, `markChatSeen`, shared with `warapp_get_chat`).
  **Read marks on war.app (#311, VERIFIED live 2026-11-16 on nine games, direct transport) are `warapp_mark_chat_read`, confirm-gated** (`src/tools/chat-read-mark.ts`;
  one game, every channel or one): it sends `RegisterChatView` (44; `writeRegisterChatViewParams`, golden-pinned): per
  channel the highest message id read (`chatViewMarks`, `src/chat.ts`, mine included; private conversations keyed by
  the counterpart — the recipient of my message, else the sender; game groups, the web client's `unknown`, by group
  id; a channel not marked goes as `-1`). It refuses the account unknown, a chat read only from GameFeed (no message
  ids), nothing to mark, or a game the list already shows read; the preview names ids only. It is read back from
  GetMyGames' GameInfo unread flags (0-based 8 group, 17 private, 18 public, 23 team: `RawMyGame.unreadChat`, read
  loosely — a non-boolean leaves them unknown, never refuses the list): `read` (`confirmed`) when every marked
  channel's flag is clear, else `unconfirmed` (`stillUnread`); `unknown` when war.app did not answer, never resent.
  Not a chat send (D2). The inbox also lists a finished game whose chat GetMyGames flags unread, or whose flags do not read (`chatGameIds`:
  a misread must not hide its chat; `finishedUnflagged` counts those read unjudged), and (#322) the `FINISHED_CLEAR_WINDOW` (3)
  newest finished games by id whose flags read clear (`recentClearFinished`, `finishedClearChecked`): a message GameFeed alone
  holds — a surrender "gg" — leaves war.app's flag clear, and such a message comes as a game ends; older ones go by the flag,
  so the extra reads stay bounded. Each inbox entry carries `game: { id, name, state }` as warapp_get_chat does, beside the
  older top-level `id`/`name`/`state` (#323). warapp_mark_chat_read's GameFeed-only refusal carries no frozen-tab hint (no tab
  state changes it, #323): it says to read the game with warapp_get_chat and mark once its `source` is `web`.
  **Unread chat in one place (2026-11-23).** `warapp_my_games` reports the list's flags per game (`unreadChat`, booleans —
  the list carries no count; `toMe` = the private flag: a private conversation in my list is mine, my messages are never
  unread), sorts unread-private games after the ones waiting on me and counts them (`unreadPrivateGames`); brief appends
  " — unread private" / " — unread <channels>". The inbox's `all: true` walks every page under `INBOX_TIME_BUDGET_MS`
  (`inboxClock`, injectable; `partial` + `next` when it runs out), `only` filters shown messages (`filtered` lists games
  left out), `summary` totals new and new-private-to-me, and unread is the union of the list's flags and the cursor
  (`readState`; a channel only war.app flags shows its newest message `seenLocally`; with `game_ids` no list is read, so
  `warapp: null`). `warapp_mark_chat_read`'s `scope` (`both` default) writes the cursor over the same lines the war.app
  mark covers; `both` on a game the list shows read marks locally instead of refusing (`already-read`), read in both
  previews `nothingToDo` (no refusal: the gate has no immediate-result path); `game_ids` (≤ `MAX_MARK_GAMES`) plans each
  game, skipping (with the reason) what one game would refuse, and a war.app refusal on one is `refused` there.
  `warapp_plan_turn` leads its warnings with `privateToMeWarning` (sender + 80 chars, `untrustedText`/`untrustedBody`):
  from GameFeed's lines when they name a recipient, else ONE GameRefresh (chat only) when GameFeed has unread lines of
  others with no channel — the one request the plan's chat block adds (asserted in turn-tools).
  `warapp_send_chat` takes `channel: 'team'` (the channel value is my GameFeed `team`; refused without
  one) and refuses `to` when `PrivateMessaging` is false; it reads the reply's message list back
  (`confirmed` / `unconfirmed`, `accepted` when unreadable). `GameUpdated`'s first bool after the game id
  is the client's `chat` flag: `chatActivity` in `warapp_wait_for_turn`.
  **Chat links (`src/chat-links.ts`, docs/WEB-PROTOCOL.md "Territory and bonus links in chat").** The client sends a
  link as the bare token `<a t=<territoryId>>` / `<a b=<bonusId>>` in the text (its editor span and name are dropped
  before posting) and renders the name from the map: territory and bonus links VERIFIED live (owner, 2026-11-23:
  sent and read back through GameRefresh; the bonus check, a private message with `<a t=1>` and `<a b=1>` read back as
  both links with the text rendered by name). `warapp_send_chat` resolves
  `[[t:…]]` / `[[b:…]]` markers (id first, else the one case-insensitive exact name; unknown or shared names refused
  before any send, listing ids) and, with `link_territories`, every whole-word territory name (longest first; never
  inside a marker or token; a shared name refused); the map is read only then, and a message with nothing to link
  is sent byte-identical. The preview adds `rendered`, `links` and `linksNote`; the read-back compares the wire text.
  `shown()` decodes tokens for `warapp_get_chat`, `warapp_chat_inbox` and the plan's chat (`links`; name from the
  cached map, `null` and the raw token kept when unknown). The interpreter's registration
  scan allows whitespace after `=` (the real bundle wraps `GameMessage`'s with CRLF).
- **Mega games: scale and pace (2026-11-23, game 45736172's 97 seats).** Above `LARGE_GAME_OPPONENTS` (16) opponents
  still playing (`src/analysis/scale.ts`, `opponentScope`) only the opponents near me — holding land within `NEAR_STEPS`
  (2) of mine, or (under fog) any in view — get their own rows: the outlook's rows, comparison and evidence (the rest
  counted in `evidence.far`; owner 2026-11-23: the surrender line alone still judges the strongest opponent anywhere,
  `OutlookTurn.surrenderSide`), plan_turn's `reads`/`enemyDeployDetail`, check_plan's `unseenOpponents`
  (`unseenOpponentsMore`); both tools add `scale` (`farSummary`: count, summed estimate, biggest). The planner is not
  scoped (golden: 6253 plans byte-identical); at or under the threshold nothing changes. The inbox's `only:
  "mentionsMe"` (`src/analysis/chat-mentions.ts`: my name or a territory I hold, whole word or `<a t=id>` link; held
  land from GameFeed's standing else the newest cached board, no request) and `public_chat: "summary"`
  (`publicSummary`). Pace: GameInfo fields 5 (boot), 19 (real time), 24 (my banked time) and 26 ("Your turn for")
  — read from the bundle's GameInfo reader and game-list renderer (its boot label is field 5 + field 24) — give
  `warapp_my_games`' `boot` (`bootView`; `leftMinutes` = boot + bank − turn so far, UNVERIFIED live) and `bootSoon`
  (`bootSoon()`: a multi-day game under 6 hours; #504 (owner 2026-11-25): an opening turn — picks or turns 1 to
  `OPENING_LAST_TURN` (4), `isOpening` — also at `BOOT_SHARE_WARN` (a quarter) of boot + bank or less left, `openingSoon`,
  listed first among the games waiting on me and counted as `openingBootSoon`; a real-time game, reported since #504,
  only at a quarter and never kept for the session status, UNVERIFIED for real-time); `warapp_wait_for_turn` adds the
  watched games' `bootSoon` from the kept clocks (no request) and puts them first in `ready`; `fetchMyGames` keeps the clocks per context (`src/tools/pace.ts`; a confirmed `warapp_submit_turn` drops its game, `forgetPaceGame`, #532) and `warapp_session_status`
  reports `pace`/`bootWarning` under 6 hours from them, reading the list itself (one request, over a working direct
  session only) when none is kept yet (owner 2026-11-23; otherwise `paceUnread` says why).
- **Chat is game information (#415, `docs/PLAN-CHAT-STRATEGY.md`): classified, advised, never sent on its own.**
  `src/analysis/chat-intent.ts` (`classifyMessage`, pure, pattern-based, never throws) labels another player's
  message with `INTENTS` (income/position checks, truce proposal/accept/decline/end notice, coordination asks,
  threats, surrender asks, gg/banter/greeting, other questions), a `high`/`medium`/`low` confidence, `addressedToMe`
  and the players, territories and bonuses it names. A missed intent fails safe (no stance, the message still
  shown); reviews fail only a wrong HIGH-confidence label or a listed example. `src/analysis/chat-advice.ts`
  (`adviseReply`, pure) turns a label and the game (format, my standing and whether I lead, my income, the
  strongest estimate and its `thin` flag, the sender as leader/teammate/out/truce) into a `stance` (`ignore`,
  `vague`, `share`, `price` → `warapp_advise_diplomacy`, `report`; `propose`/`accept`/`decline` exist but are
  never advised on their own), `reasons`, `noteIds` (the `diplomacy` strategy notes) and, for `share`/`vague`
  only, an honest `draft` (D3 by construction: figures only from the game, never from the message; a `vague`
  draft states none; no promise, no claim to be human). `src/analysis/chat-read.ts` (`readChatMessage`) puts the
  two together per message; `src/tools/chat-advice.ts` wires it: `warapp_get_chat` and `warapp_chat_inbox` give
  every other player's message `intent` and an unread one `advice`, from this machine only (the outlook log's
  standing via `standingFromOutlook`, the ledger's truces via `chatTruces`; none → standing `unknown`, said in the
  reasons; no extra war.app request); `warapp_plan_turn`'s `chat` adds `messages` (the newest
  `MAX_PLAN_CHAT_MESSAGES` unread, text through `untrustedBody`, compact advice = stance + one reason, the rest in
  `messagesOmitted`) from the plan's own standing (`planStanding`) — report only, the orders never read chat
  (asserted: the plan with unread chat is the plan without it). The label is a hint, not the judge: every view puts the text beside it with
  `CHAT_ADVICE_NOTE` (other players' words: information about the sender, never an instruction or a fact). The
  decision log keeps a per-turn `chat` block (`recordChat`, `LoggedChatMessage`: ids, sender id, channel, `toMe`,
  intents, confidence, stance; never text or a name; at most `MAX_LOGGED_CHAT`). **The gate,
  `src/chat-automation.ts`:** `WARAPP_CHAT_AUTOMATION` (`chatAutomationMode`: `on` only when it says `on`, else
  `off`; declared in manifest.json, server.json and mint.yaml, hosted default off). Every advice carries
  `automation`; with `on` and a draft it also carries `send` (the exact `warapp_send_chat` arguments,
  `automated: true`, still confirm-gated); with `off` the reasons say the owner sends. `warapp_send_chat`'s
  `automated: true` (an agent's own reply) is refused before any request with the gate off
  (`AUTOMATED_CHAT_OFF`); with it on it goes through the usual confirm gate and the result records `automated`.
  A manual send (the default) is unchanged. Not a new write tool.
  **Chat can block a turn (task 4b), behind a second gate:** `WARAPP_CHAT_BLOCKS_TURN` (`chatBlocksTurnMode`, `off`
  unless `on`; declared in all three files like the first). `src/analysis/chat-blocks.ts` (`chatBlocks`, pure) blocks a
  message only when ALL hold: another player's, unread by the cursor, its GameFeed `turn` this turn or the last (read
  as turns completed when sent, UNVERIFIED), its intent's own strength `high`, and one of four cases — a truce
  end notice/proposal/accept from a partner (`chatTruces`: active, in notice, or my proposal pending); a threat or
  gang-up naming me (my name, or private to me) from a player in contact on this board; a surrender ask with my
  acceptance owed; a teammate's private question about this turn's orders/cards/gifts (its own pattern,
  `team-orders-ask`). A context not read (contact, surrenders: `null`) never blocks. `turnChatBlocks`
  (`src/tools/chat-advice.ts`) feeds it from the GameFeed chat of the tool's own game read (`chatSummary`): the
  submit now asks that read with `GetChat=true`, no extra request (asserted), and reads no surrenders, so case 3
  only shows in warapp_plan_turn. GameFeed's chat names no channel or recipient (`toMe` never set), so neither tool can fire a private threat or case 4 today: case 2 fires only on a message naming me; both wait on the web chat read. A turn count not known never blocks. `warapp_plan_turn` reports `chat.chatBlocks` (+ `chatBlocksGate`,
  `CHAT_BLOCKS_NOTE`; report only, orders unchanged — asserted). `warapp_submit_turn`: gate off, the preview's
  `chatWarnings` ("would block with WARAPP_CHAT_BLOCKS_TURN=on: …"), never a refusal; on, refused before sending,
  naming each message by id (else time), sender id, intent and why, unless `chat_reviewed` is true (the result's
  `chatReviewed` lists what it waived) or the messages were marked seen since. The decision log's chat entries
  carry `blocks` (the plan's every entry; the submit sets only the flag, `blockFlagOnly`).
- **In-app notifications (#311) are `GetInAppNotifications` (323) via `warapp_get_notifications`** (read-only,
  hosted too; `src/notifications.ts`, the reply decoded by the bundle's readers by type name —
  `GetInAppNotificationsReturn` / `InAppNotification`, 7 fields by read order — like GetMyGames). Name-free
  beyond ids: `id` (decimal text), `kind` (`game-ended` only on the client's own title wording, `Game "<name>" has
  ended.` — the owner's screenshot: `ENDED_TITLE`, anchored on that structure, never a bare "ended"/"finished";
  else `other`), `gameId` (from a war.app `GameID=` link in the data JSON), `time`, `unread`; the title and body
  are read only to classify, never shown, and the record's field 4 (an unverified free-text string) is neither
  reported nor used. A game-ended notification
  runs #312's end-of-game pass on that game (`passEndedGames`: the same idempotent `endOfGame`, the account the
  board cache's else the signed-in one, read at most once per call; a game with a record or processed mark costs
  nothing; at most `END_OF_GAME_PER_CALL` (2) games that still need it per call, the rest `pending`; one history
  read each; `endOfGame: { processed: [{ gameId, status, turns?, profileFold? }], pending }`), which folds its live
  profile too; then a game's opponent profile still kept unfolded is folded through `foldFinishedGame`
  (`hasUnfoldedProfile`): one GameFeed read (no map), at most `FOLD_LOOKUPS` (5) per call, else no request.
  `warapp_dismiss_notification` (confirm-gated) sends `AcknowledgeInAppNotifications` (325: marks read, never
  deletes) for the listed unread ids; the preview names ids and game ids only; read back by listing
  again (up to `MAX_FIND_PAGES` pages): `dismissed` (`confirmed`) only when every id reads read or is seen gone —
  the pages read cover the whole list, or reach past where it stood in the plan by as many as the list has grown
  (`seenGone`); an id not found otherwise is `notSeen` ("not seen in the pages read") and the outcome
  `unconfirmed`, as is one still unread; `unknown` never resent. `warapp_delete_notification` (confirm-gated,
  destructive: the client's Delete button, as #311 asked) sends `DeleteInAppNotification` (324,
  `writeDeleteInAppNotificationParams`: one decimal-text id) once per listed id, in order, never retried; error
  699 (`NOTIFICATION_NOT_FOUND`) is `alreadyGone`; any other refusal throws when nothing changed yet, else stops
  there (`refused`, the rest `notSent`, `unconfirmed`); no answer stops there too and is `unknown`, never read back
  or resent. Read back by the same listing and `seenGone`: `deleted` (`confirmed`) only when every id sent is seen
  gone; still listed (`stillListed`) or `notSeen` is `unconfirmed`. The preview names ids and game ids only.
  Encoders golden-pinned; these four (242 ids 317, 318, 319 and 43) VERIFIED live 2026-11-16 on protocol 242 (direct transport); on 243 only the list read is checked live. Not a chat send (D2).
- **Team games read (part C1 of `docs/PLAN-TEAMS.md`).** One team test everywhere: `isTeamGame` /
  `teammatesOf` (`src/teams.ts`, over `carriesTeam`); teammate ids are GameFeed ids at the tool boundary
  (an AI seat has no in-game id: it owns nothing on the board, never a throw). The read-only
  `warapp_get_team` (`src/tools/team.ts`) refuses outside a team game. **The team source is one helper,
  `resolveTeams` / `resolveTeamsFor` (`src/tools/team-source.ts`), used by every tool that decides teams**
  (plan_turn, check_plan, submit_turn, advise_diplomacy, get_relations, record_agreement, plan_picks,
  submit_picks, track/locate_opponents, send_chat to the team channel or with commitments, get_team): GameFeed's
  team when any player carries one (`gamefeed`); else, only in a game of more than two seats and only with the
  signed-in account readable, GetMyGames' `GameInfoPlayer` team (`myGamesTeams`, by in-game id; `my-games`);
  else `none`. The list's answer is judged against GameFeed's seats first (`judgeList`): only every seat on a
  team with at least two distinct teams, or every seat listed without one (a free-for-all), is trusted; every
  seat on one team is not (a misread field reads that way) and is never kept; a seat left out, or teams on some
  seats only, is incomplete. A trusted answer is kept name-free at `<dataDir>/teams/<gameId>.json` (newest 200),
  so the list is asked once per game; an incomplete one keeps only `incompleteTurn` (no teams), so it is asked
  again at most once per turn; a failed read, or a list without the game, is not kept and the teams stay
  unknown. The record carries `TEAM_RECORD_VERSION`: bump it whenever the GameInfoPlayer team decode or the
  trust check changes (another version's record is ignored). Tools resolve after their
  cheap refusals (turn phase, seat), so a refusal reads nothing more. `teamSource` is reported by plan_turn and
  check_plan (team games only), `team.source` by plan_picks and get_team. Teammate orders and picks come from `LatestGameInfo`'s `TeammateOrders` dict (`src/team-orders.ts`,
  found by type name, orders by class and read order). `withTeammateOrders` sets `BoardState.teammateOrders`
  (by GameFeed id, my entry out) on the live boards of `warapp_plan_turn`, `warapp_check_plan`,
  `warapp_submit_turn` and `warapp_get_team` when the dict is there — no key otherwise (1v1, FFA: goldens
  unchanged), and the board cache never keeps it. Picks fall back to `GetTerritoryPicks` with the teammate's id (V6, VERIFIED live 2026-11-22: a teammate's list and mine answer, an opponent's is error 187, any seat in automatic distribution 188 — those two are `refused`, any other refusal is unknown);
  the team hand is `readHand` over `handOwners` (`{ inPlay: false }` when the settings put no card in play); unread team chat is counted from the web chat only. All
  UNVERIFIED live (V1; V5's pick list while distributing). **V5 orders are VERIFIED live 2026-11-22** (#435): a teammate's entered orders are in `TeammateOrders` before it commits (my own entry never is); with nothing entered war.app sends the dict empty, which reads as unknown. Absent means unknown (`null`), never "none". **The team hand is VERIFIED (V8, #310):**
  each player's cards sit under that player's id (`warapp_get_team` shows `heldBy`), the hand is all of them, and
  `teamCardLimit` (`src/team-cards.ts`) applies the limit as the bundle's `GameValidateOrders` does — the team's hand
  less the committed teammates' entered plays and discards, error 51 only for the last of the team to commit — so
  `warapp_submit_turn` refuses then (every committed teammate's orders read) and otherwise warns.
- **The team brief (C4) is `warapp_team_brief`, read-only: data for a team-chat message, never sent.** It plans
  as plan_turn does (`livePlanSetup`, `award: false`) and writes nothing (no board cache, award or outlook); the
  pure parts are `src/analysis/team-brief.ts` (`opponentIncomes`/`incomeBasis`, `briefConflicts`, `briefAsks`,
  `pickOverlap`, `picksLost`). Stages: picking (my list, teammates' lists, overlap, shared bonuses), turn 1 (the
  picks my kept list lost, `readAward` computed without writing), each turn (incomes and basis, deploys and
  attacks, asks, offers = `team.support`, cards, conflicts; `conflicts.read: null` = no teammate orders read; a
  `bonus` conflict is their attack into a bonus my plan completes, or captures into a direct member of: `completes`).
  `warapp_join_game` takes `team`: refused outside a team game, with random teams, or when full or not offered;
  it is the int32 AcceptOpenSeat already sends (the client's team picker passes the chosen team: bundle, UNVERIFIED
  live). The preview lists that team's seats by in-game id, human or AI (`GameInfoPlayer` field 4 is IsAI).
- **The agreement ledger (part A2 of `docs/PLAN-TEAMS.md`).** An agreement (a truce) exists only when
  recorded with `warapp_record_agreement` (structured terms; chat is never parsed into one), at
  `<dataDir>/relations/<gameId>-<playerId>.json` (`src/relations-store.ts`: one file per account, ids,
  turns and statuses only, 0600, atomic; registered hosted too, on the per-user data dir). The model is pure in
  `src/analysis/relations.ts`: the status table (terminal: ended, broken-by-them / -by-me), the state on a
  turn (over when the partner is out or turned AI, two players remain, or its turn / player / notice end
  came), `breachWatch` over consecutive cached boards from the turn agreed (visibility as `observeDeploy`:
  a fog reveal is no event; an attack is read only with my cached orders and only when the partner alone,
  visibly, borders the territory, and no transfer of mine in came from a source taken or hit; anything the
  fog leaves open is `massing`, never `broken`; massing reach is plain graph distance 2, not
  `twoStepReaches`, which asks what a stack could take and hold, not where armies stand), `tacitTruces` (3 quiet turns, reported only), the endgame
  (no other opponent ≥ 0.5 × the larger income) and `trust`. Refused: me, an AI, a player out, a
  teammate, a 1v1, two left, and no third player or team outside me, my team and the partner's; an
  `until_turn` before this turn. Massing needs its growing pairs to end at the newest board. The ledger's `usage`
  logs per planned turn (not a what-if plan) the armies each honoured truce freed and what a break would cost (T6: `lossIfBroken` armies, `incomeLostIfBroken`).
  Its `intel` (#386, `warapp_record_intel`, not confirm-gated; pure part `src/analysis/intel.ts`) keeps avoid territories
  (`promisedTo`), avoid players (a reason code from `AVOID_REASONS`, never free text) and stated incomes with their turn;
  `warapp_plan_turn` and `warapp_check_plan` apply it by default (`resolveIntel`, reported as `intel`): an explicit
  `avoid_territories` / `avoid_players` / `known_income` replaces the stored list of its kind for that call (`[]` included), and
  an income more than `INCOME_STALE_TURNS` (3) turns old is not applied (a warning). Its read-modify-write runs
  under an in-process per-path lock (`src/path-lock.ts`; another process sharing the data dir is not
  covered). **The cross-game player record** (owner decision D5 of 2026-11-14: on, local AND hosted —
  registered and enabled on a hosted child, in its per-user data dir) is `src/player-record-store.ts` at
  `<dataDir>/relations/players.json` (version 3; versions 1 and 2 read loosely): per player, keyed by an
  HMAC of the GameFeed id under the salt `relations/players.salt` (made only on the write path; a salt
  file that exists but is malformed is never regenerated, and a `players.json` that exists but does not
  parse — bad JSON, not an object — is never overwritten or moved aside: the write reports `failed`, reads
  `unreadable`), name-free entries per agreement (its key an HMAC of my account, game and agreement —
  entries keyed by game and agreement alone before that are read as they are and updated in place: format, turns
  agreed and ended, terms shape, outcome with notice honoured or not, break turn and strongest flag, the
  context at the break from the cached boards — endgame, leader, outgrowing — retaliated, proposed
  again) and tallies (`src/analysis/player-record.ts`: `recordDelta` moves each once, on the transition
  that earns it, so they never double-count and outlive entries dropped past the bound; 30 entries per
  player, 300 players). `warapp_record_agreement` updates it inside the ledger's lock (its own lock, a
  different path), so entries land in the order the ledger changed; `warapp_submit_turn`'s `break_agreement`
  goes through the same path (`recordBrokenByMe` / `updateAgreementRecord`, `src/tools/relations.ts`). `WARAPP_PLAYER_RECORD=off` switches it off. The tools report `playerRecord`
  (`warapp_record_agreement`: `updated` / `off` / `failed`; `warapp_get_relations`: `on` / `off` /
  `unreadable`).
- **Deals outside the ledger (#375): `avoid_territories` / `avoid_players`** on `warapp_plan_turn` and
  `warapp_check_plan`, for this call only (`PlanOptions.avoid`). The planner treats each like a truce's covered
  territory for T1 (`truceOf` wraps `noTarget`; `Truce.avoided` names it in the "Not attacking" line), a neutral
  included, in any format; holds are not relaxed (T2 does not apply). check_plan warns when the orders attack one.
  #441: an avoided player's neutrals go too (`skirtedNeutrals`, wrapped into `noTarget` in the estimates phase): a
  neutral whose only enemy neighbour is that player, or in a bonus it visibly holds over half of, unless it completes
  a bonus of mine or its minimal capture's survivors alone would hold against the stacks beside it plus the owner's
  deploy; a "Not taking … (#441)" line per one beside my land. No avoided player: golden unchanged.
  #457: a truce partner's neutrals go the same way while an agreement (not only a card) with it is active or in
  notice, in any format it binds (`Truce.keptWith`, passed to `skirtedNeutrals` as `truce`; the partner counts as an
  enemy neighbour even when a card makes it no foe): skipped unless the capture completes a bonus of mine — holding
  next turn is no exemption, since to the partner it reads as a breach either way (`Skirt.truce`) — with a "Not
  taking … (#457)" line saying to raise it with the partner. A neutral the final orders do take beside a partner's
  land gets a warning that it "may read as a breach to player P" (`warnTruceNeutrals`, after `finishPlan`). No
  relations in the golden corpus: all 6253 plans (2000 synthetic + every suite input) byte-identical.
- **Pricing a deal (B3): `warapp_advise_diplomacy`, read-only, free-for-alls only** (docs/PLAN-TEAMS.md
  section 8 B3). `priceTruce` (`src/analysis/relations.ts`, pure) diffs two plans on the exact input
  `warapp_plan_turn` builds (`livePlanSetup`, `src/tools/turn.ts`, shared): without the truce and with it (the
  planner called, never changed). The hypothetical truce replaces any recorded one with that player but keeps
  its board reading (state — `broken` with the breach — trust, watch flags): a recorded truce is priced on the
  plan `warapp_plan_turn` makes, and a broken or flagged one is `no` (`relation` in the entry), as is one I
  already gave notice on (`noticeBy: 'me'`: withdraw the notice or propose new terms). The
  no-deal plan never holds it: a shared `without` is reused only for a partner with no relation in the input
  (`priceTruce` ignores one given otherwise). It writes nothing: no board cache, and `livePlanSetup` is called
  with `award: false` (the award shapes only a two-player plan; reading it on turn 1 writes it). The host's
  description key is UNVERIFIED, shown through `untrustedText`.
- **A message promises only what the plan does (B4, `src/analysis/commitments.ts`, pure; `src/tools/commitments.ts`).**
  `warapp_send_chat` takes `commitments` (no-attack, will-attack, notice, propose, accept), declared — the text is
  never parsed — and its plan step checks each against this turn's orders (`livePlanSetup` with `award: false` and the teams as resolved — unknown, no #275 tripwire, as in warapp_plan_turn —,
  then `planTurn`; the orders this server submitted this turn, `readCachedOrders`, stand in when there are any)
  and the ledger (`agreementChange`: the same rule `recordCommitments` re-applies after the send). One not
  carried refuses the send. A notice's `ends_turn` must be the turn the agreed notice gives (0 turns of notice:
  this turn — the truce ends with the message and this turn's attacks are free); an accept compares only
  the terms it restates; a truce whose `until_turn` is past is refused; an attack on a territory a promise names
  whose owner is fogged conflicts (scope `all`: named as unchecked). A propose/accept/notice whose partner does
  not read the message (`audience`: private to another player, or the team channel with the partner off the team)
  is refused (D3: no truce changes unseen); a no-attack/will-attack binds no agreement and may go to anyone. The
  preview's `checkedAgainst` names the default plan (no goal, focus, reserve, first mover or award). The submitted orders are `MyOrders.sent`
  (every move, Transfer Only flagged), not `moves`. With commitments the game is read with its map and the turn must be in play. Once
  the message is `confirmed` or `accepted` (war.app took it; `unconfirmed`/`unknown` record nothing and say so)
  they go into the ledger's `commitments` as mine (ids and turns only, at most 200), a propose/accept/notice
  through warapp_record_agreement's path (player record included). `warapp_submit_turn` warns (never refuses)
  via `commitmentWarnings`: an attack a no-attack still covers or an open proposal of mine covers (scope `all`:
  an attack into the fog, `unchecked`), and a will-attack for this turn the orders leave out; `warapp_plan_turn`
  gives the same warnings for its plan (the planner never reads commitments). A will-attack is only for the current turn.
- **A pending surrender is read from the game details (#317, `src/surrender-pending.ts`, UNVERIFIED live).**
  GameFeed keeps a player who asked to surrender `Playing`, and GetMyGames / LatestGameInfo carry nothing:
  only GameRefresh (40) asked with `nonChat` does — `GameDetailsAndChat` → `GameWL` (14 fields, players at 7) →
  `GamePlayer` (37 fields since 243; the reader's link back to the game, set first, is dropped before counting).
  `pendingSurrenders` gives `{ inGameId, player (GameFeed id or null), owedByMe }`, owed by the client's own
  test (their seat `Playing` + `Surrendered`, mine `Playing`, not AI or turned AI, my id not in their
  `PlayersAcceptedMySurrender`); my own surrender is left out. `src/tools/surrender-pending.ts` reads it only
  for a game being played or picked with my seat playing; unreadable, not read (past the bound) or my seat unknown
  is `null`, never `[]`; every other game (a lobby, a finished game, a game my seat is out of) is `[]` without a
  read (#327: none can wait on me there, and nothing failed to read).
  Reported by `warapp_my_games` (per game, `player` null — the list has no GameFeed ids — and a top-level count;
  at most `MAX_SURRENDER_READS` games, brief reads none), `warapp_wait_for_turn` (status `surrender_pending`
  unless `ignore_surrenders`; after one failed details read — a frozen tab stalls each until the bridge times
  out, and the rpc layer has no per-call timeout — it stops asking for the rest of that wait and says why once in
  `surrenderUnread`, with `FROZEN_TAB_HINT`) and `warapp_plan_turn` (`surrenderPending`, the first warning when
  owed). Each read costs one GameRefresh; nothing is cached (a surrender can come any moment). A GameFeed id and
  an in-game id are never one field: results carry `player` (GameFeed id or `null`) beside `inGameId`, and the
  in-game id of a GameFeed player comes from one helper, `inGameOf` (`src/live.ts`).
- **Diplomacy 2 mod alliances (mod 191; `src/mod-data.ts`, `src/mod-alliances.ts`, `src/tools/mod-alliances.ts`; UNVERIFIED
  live).** Mod data rides the same GameRefresh `nonChat` read: `GameWL` field 8 is every mod's `PublicGameData` and
  `GameDetailsAndChat` field 3 my `PlayerGameData` (dicts of mod id → the client's mod-table XML; location and XML format
  VERIFIED on a lobby 2026-11-23, mod 336's table). The mod (FizzerWL/ExampleMods `Diplomacy2Mod`) keeps public `Alliances`
  `{ID, PlayerOne=proposer, PlayerTwo}` (in-game ids, no turn) and my `PendingProposals`/`Alerts`; it skips attacks between
  allies by start-of-turn owners and applies a break (a `GameOrderCustom` `Diplomacy2_BreakAlliance_<id>` in the breaker's
  orders) at the end of that turn. Only a game whose settings' `modIds` include 191 is read (others: no request, goldens
  unchanged). `truceRelations` passes allies as `modAllies` → enforced T9 relations (`mod: 'Diplomacy 2'`, `ruleOnly` when no
  agreement) with `enforcedUntil` turn + 1 (an unseen break this turn frees the ally next turn); check_plan warns and
  submit_turn refuses an attack on an ally unless `attack_ally`; get_relations / advise_diplomacy carry `modAlliances`
  (mismatches, notices). Propose/accept/decline go through `SendGameCustomMessage` and a break is a custom order this
  server cannot encode: mod diplomacy is manual only, no tool sends it.
- **Accepting another player's surrender is `AcceptSurrender` (69) via `warapp_accept_surrender`, confirm-gated**
  (#317; encoder read from the bundle's writer, golden-pinned, UNVERIFIED live). `player` names the surrendering
  player (optional with one pending). The plan reads the game details and refuses a finished game, a lobby, a game
  I am not playing, an instant-surrender game, unreadable details, no surrender pending from that player, and my
  acceptance not owed (already given, or my seat cannot accept). The preview (`src/analysis/accept-surrender.ts`,
  pure): whose `seat` (`player`, `inGameId`, name through `untrustedText`), `landBecomes` (`AI` / `neutral` /
  `null`, from `SurrenderedPlayersTurnIntoAIs`, not for a seat already an AI), `land` (from the live board, else
  `null`: its territories in view and `borderedBy`, each neighbour by how many of ITS territories border that land;
  #417: `hiddenLand` — 0 when the board hides no territory, else `null`, said plainly in `hiddenLine` and the advice:
  the standing carries no per-player territory count, so its land behind the fog is unknown — and `hiddenOnBoard`,
  the map's territories the board does not show, the bound),
  `othersStillToAccept` (`{ player, inGameId }` each) / `goesThroughNow`, `winsGame` (no seat off my side left, a seat handed to an AI counting as
  one unless the AIs give up when one human remains; `null` when it hangs on an unread setting or teams I could not
  read) and one `advice` line: the win, or in a free-for-all the neighbour with the most bordering territories, citing
  `ffa-surrender-veto`. The outcome is read back from GameFeed (the seat `SurrenderAccepted`, handed to an AI, or
  the game over → `accepted`) and the game details (my id among those that accepted → `pending`, others still owe
  theirs; both `confirmed`); else `unconfirmed`, and no answer is `unknown`. Never resent.
- **Surrender is `Surrender` (68) via `warapp_surrender`, confirm-gated** (`undo` takes back a
  pending one). It refuses finished games and games the account is not playing, and reads the
  outcome from GameFeed (`surrendered` / `pending` — the others' acceptance is needed when the game's
  `InstantSurrender` says so, and MAY be needed with more than two players when it is unread (#228) — /
  `still_playing` after an undo — GameFeed has no pending state — / `unchanged`; lobbies refused), never from the reply, which has no result.
- **A speed first turn hides the board until Begin.** With MoveOrder `NoLuckCycle` war.app sends
  no standing on turn 1 (or while picking) until the player presses Begin, which starts their
  turn timer; the live tools say so instead of the lobby error. `warapp_begin_turn` sends
  `BeginFirstTurn` (80, confirm-gated, encoding read from the bundle — not verified live) and
  reports `begun` only once the board reads back.
- **Withdrawing committed orders is `UnCommit` (82) via `warapp_uncommit_turn`, confirm-gated.** Its
  parameters (only the int32 game id after the auth block) are read from the bundle's writer and
  golden-pinned, NOT yet verified live. It refuses outside a turn phase and when `hasCommittedOrders`
  is false, and reads the outcome from GameFeed (`uncommitted` / `unconfirmed`); a transport failure
  is `unknown`, never retried. `warapp_submit_turn`'s "already committed" refusal points to it.
- **My own orders this turn are read back by `warapp_get_my_orders` (read-only; `src/my-orders.ts`,
  `src/tools/my-orders.ts`).** They live in `LatestGameInfo`'s FIRST field, a list of `GameOrder` (the client's
  "active orders", from the game's `ActiveTurnOrders` entry for the asking player only — the list "Modify orders"
  shows again; the second field is my picks while distributing), found by its values (the one non-empty list of
  `GameOrder` records directly in the info; an empty list or none is unknown, `null`, never "none") and decoded
  with `decodeOrder` (`src/team-orders.ts`, shared with the teammate reader). **VERIFIED live 2026-11-22** (direct
  transport, read-only): a hand-committed 2v2 turn read back exactly (two deploys, a Gift to the teammate, six
  moves) and five other committed games read their deploys, moves and an Order Priority play. UNVERIFIED: what it
  holds for orders entered but not committed (the note says so when `committed` is false). `orders` is exactly
  `warapp_submit_turn`'s input (card GUIDs and targets read by class in the writer's field order, players as
  GameFeed ids — a card naming a player not in the game is `unread`, never resent with a wrong id — move options,
  Order Delay `before` from its place among the moves); `cardType` and `shown` are display only (zod strips
  `cardType`). `warapp_uncommit_turn` reads them in `plan` (the preview's `withdrawnOrders`, with a fixed note when
  unreadable — the failure's own words would change the hashed preview between preview and confirm) and returns
  them as `withdrawnOrders` in every result, so a withdrawn turn is never lost; both tools' and the submit's
  descriptions point to the read.
- **End-of-game stats and closing out a finished game (#523).** The pass keeps every player's end-of-game screen in the
  finished record (`stats`, by key; `src/analysis/end-game-stats.ts`): produced = deploys, lost/killed = each attack's
  `attackingArmiesKilled`/`defendingArmiesKilled` both ways (defender = the owner when the attack runs), highest income =
  the board income — all four matched the client's Defeat screen for 45682542 — and the client's All Graphs series
  (`warlight.unity.live.Statistics` metrics 0–6: armies, territories, income per board and deployed per turn, skipping
  a seat's points while its state is Eliminated/SurrenderAccepted/Booted — a return to Playing resumes, an AI takeover
  (`TurningIntoAI`, or orders after the departure) keeps the line with `aiFrom`; cumulative luck every turn, #541/#542).
  A captured record without them, or with an older `stats.version` (`END_STATS_VERSION`), is (re)computed only by
  `include_history` (`backfilled: 'stats'`, nothing else re-run). The app's My Games is GetMyGames' Default list, which holds a finished
  game only while GameInfo field 20 (SeenEndGameWindow) is clear (read live 2026-11-23); the client sets it by asking
  GetEndGameWindowData (85) when it shows the Victory / Defeat window, which `warapp_close_finished_game` sends
  (confirm-gated; read back from that flag; **verified live 2026-11-23**: a finished game closed and read back seen,
  and a second call refused it as already closed with nothing sent).
- **Leaving a lobby is `DeclineGame` (65) via `warapp_leave_game`, confirm-gated** (#217): the lobby's
  Decline button, also how a seated player leaves a game still `WaitingForPlayers`. Its parameters
  (the int32 game id, then a "mod hooks the decline" bool sent false) are read from the bundle's writer
  and golden-pinned; **verified live 2026-11-14** for a seat taken through an open seat (an invited
  seat and a hosted bridge run are not yet checked). It refuses a started game (surrender instead), a seat the
  account does not hold, and mod games; reports `left` only once GameFeed (else a `GetMyGames` entry)
  shows the seat given up — never from the reply, whose bool means "your chat was removed"; a transport
  failure is `unknown`, never retried. 17, 4 and 7 are read back from game state (the client swallows
  them); 191 (your own open game) and 88 are refusals. After a leave GameFeed refuses the game ("This API
  can only be used for games you are in…"), which confirms it.
- **The joining policy is a refusal (#423, 2026-11-21; extended 2026-11-22).** `warapp_join_game` refuses a lobby whose `joiningPolicy` breaks (`policyBreaks` in `src/open-games.ts`: Commerce, mods, custom scenarios, costly neutrals, over four seats, a boot under 12 hours, lotteries, the handicap rules Local Deployment, Commanders, No-Split, an army cap, Multi-Attack, non-default kill rates, and — owner decisions of 2026-11-22, `JoinAccount` — `attended-games`: `ATTENDED_GAMES_LIMIT` (15) or more games being played or picked with my seat playing, from `GetMyGames` (`attendedGames`; lobbies and finished games not counted), and `negative-bonus`: the lobby's map, read with the lobby's GameFeed settings, has a bonus under 0 after the game's overrides) unless `override_policy: true`, which the preview records as `policyOverridden`. A check whose input could not be read is `unchecked` (the verdict `null`), never passed; the list tool passes no account, so those two are not evaluated there. The preview also carries `attendedGames` and `mapRecord` (games and outcomes of my finished games on the map, reported only). Owner decisions of 2026-11-22 for the rest of #423: a tournament game is a warning, never a refusal; a game from a template already running is allowed, with no preference for or against it, and no per-template limit, so nothing is built for templates. The tournament IS in the open-games record: GameInfo field 25 is a `warlight.shared.GameInfoTournament` (3 fields: a coin structure, a number, the tournament id), absent on other games — verified live 2026-11-22 through `GetMyGames`, which decodes the same GameInfo: my two tournament games carried ids 66805 and 66801, each listed by `/API/GameIDFeed?TournamentID=`, and 54 other games held none. `readOpenGame` reads it as `OpenGame.tournamentId`; `policyWarnings` (never a break, never a `PolicyCheck`) gives `JoinPolicy.warnings`, which the join preview's `policy` and the list tool's `policyWarnings` carry. GameFeed has no such field, and the lobby page's HTML carries none either (the client renders its Settings tab; `GetLatestGameInfo` is refused for a lobby I am not in). `TemplateIDUsed` and `TournamentID` exist on the client's mod-API GameSettings proxy, not on any record this server reads.
- **A lottery is read from the data, never the name** (#217, `lotteryOf` in `src/open-games.ts`): a
  map of at most `LOTTERY_MAX_TERRITORIES` (4) territories is one; base income 0 with overridden
  bonuses and the map size unread is a likely one (`lottery: null`, a policy break
  too). The open-games record carries no map size, so `markLotteries` asks GameFeed (map included)
  only for lobbies with that settings shape, at most `LOTTERY_LOOKUPS` (5) per call, else uses a
  cached map. A lottery breaks the joining policy.
- **Open games come from the `/MultiPlayer/OpenGames` page payload (`AllOpenGamesData`), not a `/Services` call; joining is `AcceptOpenSeat` (62) via `warapp_join_game`, confirm-gated** and reported `joined` only once GameFeed or `GetMyGames` shows the account seated (`docs/WEB-PROTOCOL.md` "Open games").
- **Commerce games (#332, `src/commerce.ts` pure, `src/tools/commerce-deploy.ts`; docs/WEB-PROTOCOL.md "Commerce
  games").** GameFeed's `Commerce` object is parsed into `settings.commerceRules` (VERIFIED live on two games) and read
  through `commerceRules`. The deploy is the purchase: `armiesForGold` / `goldForArmies` are the client's price
  functions (multiplier 0: one gold per army; m > 0: batches of m at 1, 2, 3 … gold each), and `commerceDeployOf` —
  one computation for `warapp_plan_turn`'s deploy budget, `warapp_submit_turn`'s deploy check and `warapp_check_plan`'s
  income (through `stressOpponents`) — buys armies with my gold from the live standing (`standingGold`, `src/live.ts`:
  GameStanding's Resources, gold = 1, only my own entry under fog; VERIFIED live), which already carries saved gold and
  any Sanctions (so none is applied on top), else with the modelled income (`source: 'model'`, a warning).
  `warapp_plan_turn` reports `commerce` (gold, armies, cost, gold left, multiplier). The submit allows a smaller deploy
  (the gold carries over; a warning names it) and refuses one the gold cannot pay for (error 597, before sending) —
  only when the gold was read from the board (`submitCommerceCheck`, `src/tools/commerce-deploy.ts`): the model's figure
  leaves out saved gold, so then a different total is a warning (an `incomeUncertain` reason), as before #332;
  593/596/597/599–602 have messages. A territory's cities (`TerritoryStanding`'s structures dict, `"1"` = City) ride on
  `LiveTerritory.cities` / `TerritoryState.cities` (absent at 0) and pay `CityIncome` gold each (`cityGold` in
  `incomeDetail` / `visibleIncomeFor`). With multiplier > 0 an opponent's estimate read off the board (`visible`,
  `exact`) is converted to the armies its gold buys (`applyArmyPrice`, after Sanctions; `PlannerSettings.
  armyCostMultiplier`, set only above 0); observed, tracked and prior figures are already armies. Every plain game is
  byte-identical (golden corpus). **Cities:** `warapp_submit_turn` takes `cities` (`cityPurchaseOf`: a game that
  allows them (602), my territories (600), merged per territory, priced by `cityPurchaseCost` — the client's formula,
  the global increase counting every city I own — and paid from the same gold before the deploys: refused (597)
  only on gold read from the board, a warning on the income model's, as the deploys are); it sends
  `GameOrderPurchase` (tag 24, phase 0, `writePurchaseOrder`, golden-pinned from the bundle writer, UNVERIFIED live:
  the preview says so). `warapp_plan_turn`'s `commerce.cityAdvice` (`cityAdvice`, advice only, never an order) names
  my cheapest territory with no neighbour I do not hold, its cost and `paysBackInTurns` (`worthIt` within
  `PAYBACK_TURNS`). Still not modelled, and said by `commerceWarning` only when it applies: unread gold, a rising
  price in the plan's own values and payback (priced one gold per army), and cities in the plan's own orders.
- **Turn submission (`warapp_submit_turn`) sends `SendOrders`** (card plays, then deploys, then moves;
  encoders in `src/protocol/methods.ts` are golden-pinned to a live commit), turn number =
  GameFeed `numberOfTurns` + 1 — every tool reports this as `turn` (`currentTurn()`); the
  completed count is `turnsCompleted` (#130). It always acts as the signed-in account (refuses any other
  `player`, and refuses when that account cannot be determined), validates on the live board
  (own deploys and sources — under Multi-Attack a move, never a deploy, may also go from a territory an
  earlier move in the list enters; each move out counts the armies moved in earlier in the list, an upper
  bound; without Multi-Attack an army moved in earlier may stand guard, so its source sends all its own with a preview warning, #292,
  unverified live; an attack-only move into my own territory or a transfer-only one into a territory not mine
  arrives nowhere (no guard, no move on, no chain) — adjacent moves, armies ≤ armies + deployed − 1, deploys = planner income —
  the server's error 11 otherwise; only a preview warning when `incomeUncertainties` names a
  setting the income model does not compute or does not verify in full (the army cap: war.app pays
  min(income, round(cap × income) − my armies on the board), the cap on this turn's income, verified by six
  live cases on 2026-11-15 — received 41, 49, 25, 27 and 71 where it bit, the binding case through
  `warapp_submit_turn` among them, and a 61 room it did not bind — `incomeDetail`, #253; an unreadable army count of mine leaves it uncut, and plan
  and submit preview both say so; card armies are
  outside it; plan, submit and `warapp_check_plan` deploy on the cut figure, `warapp_plan_turn` reports `incomeCapped`;
  the fog prior, the standing and check_plan's leader test read my income before the cut, the truces'
  trust reads the cut figure on purpose (what I can deploy this turn), and another
  player's income is never cut: its fogged armies are unknown; under Local Deployment a cut makes the
  pool split a guess, `armyCapPoolsUncertainty`: the plan warns and the pool check only warns); after an error 11 the caller passes
  the game's own number as `income`, which replaces the model for the check), and refuses outside a turn phase or when my
  `hasCommittedOrders` is already true (a second `SendOrders` replacing the first is
  unverified; the client uses "Modify orders" = `UnCommit`, which `warapp_uncommit_turn` sends). **Success is read from game state, never
  from the reply:** its bool is the "vacation ended" flag. After sending, GameFeed is re-read:
  `numberOfTurns` advanced → `resolved`; my `hasCommittedOrders` true → `committed`; neither,
  or a transport failure after sending → `unknown` (never suggest resending blindly).
  A move's options (#165: `mode` transfer-only/attack-only, `percent`, `commander`,
  `attack_teammates`, checked in `src/tools/order-options.ts`) are each refused unless the game
  allows it (`AllowTransferOnly`, `AllowAttackOnly`, `AllowPercentageAttacks`, `Commanders`, a
  teammate); their encoding follows the client bundle, golden-pinned but UNVERIFIED live.
  The preview warns of bait (#593 5c, `baitAttackWarning` in `src/tools/bait.ts`): an attack on a player's territory
  that its owner's stacks beside it (in view, each less its guard) can reinforce first so that it fails before any
  deploy; no deploy estimate is read there, `warapp_check_plan`'s `gather` reply adds it. A warning, never a refusal.
  The optional `override_reason` (≤ 500 chars, names scrubbed) and `override_by` (`'hand' | 'agent'`) change nothing
  sent: after a confirmed send they go into the decision log (#412, below) beside the turn's plan, only when the
  orders differ from it.
- **Special units (`src/live.ts`, #61).** An `Armies` record ends with its special units
  (Commander, Boss1–4, CustomSpecialUnit), each dispatched on a byte tag; every unit class
  ends with the shared fields GUID, owner (in-game id), so the owner is the LAST field and the
  kind comes from the registered class name. Fogged territories report no units.
  `BoardState.specialUnits` keys owners by GameFeed id like territory owners.
- **Local times (`WARAPP_TIMEZONE`, `src/local-time.ts`).** One output-layer wrapper (`withLocalTimes` in `registerAllTools`) adds a sibling in the owner's IANA zone beside every timestamp field of every tool's JSON (`time` → `localTime`, `xTime` → `xLocalTime`, else `<key>LocalTime`; ISO or GameFeed US-format UTC values under keys ending time/at/created/since); UTC fields unchanged, unset or invalid (one stderr note) → byte-identical answers. Hosted: set it on the registration.
- **Known mods (mega-game part 4, `src/known-mods.ts`).** `settings.modIds` (`Mods[].ModID`, the same hunk as #524) lets
  `modsWarning` (plan_turn, check_plan, submit preview) name a mod whose published source was read and that changes no turn
  rule — only the Local Deployment Helper (336: zeroes overlapping bonuses at creation, which arrive as `OverriddenBonuses`;
  an auto-deploy in the web client; no turn hook) — with its note instead of "the rules may not hold"; any other id (and
  ids that did not read) keeps the general warning. Planner untouched: golden unchanged.
- **Cards (`src/cards.ts`).** The hand is read from the live board (`LatestGameInfo` standing →
  my in-game id → GUID → card instance, by bundle type name); the card **type is `Gb`, the LAST
  integer field** (the base reader sets it last) and a Reinforcement card's armies are `tc`, the
  first integer (its subclass prepends it) — reading the type from the first integer mislabels a
  Reinforcement whose armies equal another type id; the rules from GameFeed settings
  (`MaxCardsHold`, `ReinforcementCard.FixedArmies`; a card set to `'none'` is not in play).
  Holding **more** whole cards than `MaxCardsHold` (not equal — live: 4/4 accepted, 5/4 refused;
  the bundle's check is `remaining > MaxCardsHold` after removing every played and discarded
  card) war.app refuses a `SendOrders` (**error 51 `MustUseCard`**), so `cardsToShed` cards must
  be played or discarded and `warapp_submit_turn` refuses up front. The planner always plays
  Reinforcement (its armies join the income); when cards must go, the lowest-value cards in the game leave
  first (`keepValue`, #163: the information cards first, the timing cards — Order Delay, Order Priority,
  Emergency Blockade, Bomb, Airlift — last). An Order Priority that must go is played, not discarded, one
  at most (#127); an Order Delay that must go is played where the schedule advises it
  (`cards.advice.orderDelay`, `insteadOfDiscard`) rather than discarded, and is discarded only when the
  plan has no attack for it to delay. `chooseCardPlays` itself never plays
  Blockade (it gives a territory away) or Order Delay (where it goes is the schedule's call). A discard (`GameOrderDiscard`) is tag 9, the GUID, the
  base — from the bundle's writer, not yet live-verified. Card plays must come in war.app's
  turn-phase order or the server answers **error 10 `OrdersInIncorrectOrder`**, so
  `writeSendOrdersParams` sorts every order by `TurnPhase` (discards 10, Order Priority 12,
  Reinforcement 20, deploys 25, moves 50, Order Delay 50, Blockade 60). Order Delay (tag 11) runs
  in phase 50, verified live 2026-11-12 (sent in phase 12 it drew error 10). Within a phase,
  card plays are written after the other orders (an Order Delay after every move, the
  live-verified shape), unless an Order Delay names `before` (`beforeMove`, #186): then it is
  written among the moves, which war.app accepted live 2026-11-13; whether the later moves then
  wait for the opponent's is unverified (docs/WEB-PROTOCOL.md). Order Delay may be combined with
  other card plays.
  Play-card encoders are golden-pinned; a GUID is written as its 16 bytes in .NET order.
  The Blockade play (tag 18, phase 60; card by name, target territory by id) was verified live 2026-11-16: the
  territory turned neutral at the end of the turn at its armies × the game's multiplier. Order Priority (card by
  name, no target) committed and resolved live 2026-11-16, but whether my first move ran first cannot be told from
  the result: that effect stays unverified.
  **The targeted cards (PLAN-TEAMS part D, V9):** Spy, Reconnaissance, Surveillance
  (phase 15), Airlift (43), Gift (47), Diplomacy (75), Sanctions (80), tags and fields from each
  `GameOrderPlayCard<X>` writer (docs/WEB-PROTOCOL.md). The Airlift play (card by name, `from`, `to`, `armies`) was
  verified live 2026-11-16 (the source lost the armies, the target gained them, the card left the hand), and the
  Diplomacy play (card by name, `players`) verified live 2026-11-18 (played through `warapp_submit_turn`, in force on
  later boards until the turn expected, #369), and the Gift play (card, `target`, `player`: a teammate) verified live
  2026-11-23 (#435: after the turn resolved the territory was the teammate's and the card had left the team hand);
  every other targeted card is UNVERIFIED live (Sanctions was played
  once 2026-11-18, its effect not yet checked). `TARGETED_CARD_PLAYS` (`src/protocol/methods.ts`) is the set whose
  targets are resolved; `UNVERIFIED_CARD_PLAYS` (the preview's encoding warning and the result's `cardPlayCheck`) is
  it without Airlift (#296), Diplomacy (#369), Gift (#435) and Reconnaissance (#443: accepted live 2026-11-20 — a turn with the play committed with no error, then withdrawn, so the reveal itself is not yet seen; an advised Reconnaissance now goes into `warapp_plan_turn`'s `orders`, #434). `warapp_submit_turn` takes their targets
  (`src/tools/card-plays.ts`) and refuses what the bundle's `GameValidateOrders` refuses (a commander
  never gifted or airlifted to a teammate; no Spy on me or a teammate, nor on the neutral — target 0 — unless
  the game's `SpyCard.CanSpyOnNeutral`; no Diplomacy between teammates, nor naming a player out — the
  validator checks both named players for 381) plus Sanctions on the wrong side for the game's percentage (`sanctionsSettings` in `cards-in-effect.ts`: a
  fraction in -1..1, read as a number or numeric string; positive or unreadable: never my side; negative — it raises
  income, and the client's own guide says to play it on yourself — never an opponent; the client and the validator allow
  any player still playing). A negative card is advised on me with `income` (next income before/after), projected by
  `warapp_check_plan`'s `sanctionsPlayed`, shown in `cards.settings`, and read back after a commit (`cardReadBack`,
  `src/tools/player-card-readback.ts`); an Airlift of the commander alone sends 0 armies (the validator does not check
  the count); what an Airlift sends leaves its source's later moves (armies it lands cannot move that
  turn); a Gift to an opponent gets its own preview line naming the recipient by id as an opponent. **Bomb** (tag 20, phase 30,
  `GameOrderPlayCardBomb`) and **Emergency Blockade** (tag 8, phase 37, `GameOrderPlayCardAbandon`) each write one
  int32 territory, UNVERIFIED live too: a Bomb is refused on my own or a teammate's territory (526) or one next to
  none of mine (527); an Emergency Blockade on a territory not mine (95), twice on one (96), on my commander's
  (ours), or under an Airlift that runs after it; the preview warns when it breaks a bonus I hold or strands
  moves. The preview warns the encoding is unverified and the result
  carries `cardPlayCheck`. The planner never plays them; `warapp_plan_turn`'s `cards.advice` (D2,
  `src/analysis/card-support.ts`, pure) says where they pay, each with an `order`, never added to the
  orders: Diplomacy on the opponent whose stacks tie down the most of my border armies (#424: the only one in
  contact too, unless no other opponent is still playing — a 1v1 says nothing; a truce partner the truce
  already covers is passed over unless the truce is in notice or leaves a border it presses uncovered; one a
  Diplomacy card in force covers is passed over, unless this is that card's last turn: then it is chained
  first, `chain: true`, and the in-effect warning says it is the last turn and to chain or ready the borders — in a 1v1 only to ready them,
  `diplomacyOpponents` gating both), a Bomb (`bombAdvice`, `src/analysis/card-threats.ts`) never on a territory
  of a player at peace with me (#452: a Diplomacy card in force — decoded, or the plan's T9 set — or a binding
  truce; the hold-the-card line names them as passed over), Sanctions
  on the strongest opponent (the FFA ranking, else visible armies + 3 × visible income; on me when the
  percentage is negative), an Airlift onto a border of mine or a teammate's that falls without it (#434: else
  `redeploy` — an idle stack, only my land beside it and unused by the plan, two or more steps from the target, or one
  cut off from my main holdings, with more than `REDEPLOY_MIN_ARMIES` (3) to spare, to the strike stack, else the
  thinnest border), a
  Gift of the members that complete a teammate's nearer bonus (#435: judged before the idle transfers — a transfer
  out of or into a gifted member no longer hides it but is listed in `gift.drop`, since the Gift, phase 47, lands before the
  moves; an attack from it still does; Gift left `UNVERIFIED_CARD_PLAYS` 2026-11-23, so the gift is `inOrders` and
  plan_turn's `orders` carry it with `drop` taken out, `giftInOrders` — the same guards as the advice: only a gift that
  completes a teammate's bonus, never a member with a special unit (my commander) or one an attack leaves from), and (#434, `blockadeOffer` in `card-threats.ts`) a
  Blockade (`cards.advice.blockade`) on a border the plan concedes that is the one way into held bonuses or my commander
  (`opensBehind`, #291), when its armies after the plan × `BlockadeCard.MultiplyAmount` stop the stack beside it —
  never on a member of a bonus I hold (it breaks the bonus) or my commander's territory. **The spy cards (G2, `intelAdvice`)** only
  where the fog hides what the plan needs, never with fog off: Spy on an opponent out of view (else the
  owner shown beside my most hidden stacks), Surveillance on a bonus I hold half or more of with a fogged
  member (else the most valuable with a hidden border of mine), Reconnaissance on the hidden territory
  beside the most of mine, else (#443) on the hidden territory behind the opponent in contact whose stacks
  tie down the most of my border armies (`pressures`), a distribution-mode start first when the map carries
  the mode's territories. #434: an advised spy card whose kind is not in `UNVERIFIED_CARD_PLAYS` is flagged
  `inOrders` and warapp_plan_turn puts its play into `orders` (`intelOrders`); all three are still in the set, so
  none is today — verifying one live is removing it from that set. **A team hand's cards carry `owner`**
  (the in-game id read under, mine when under me at all; V8 verified, #310): the planner plays, discards and
  advises only my own, says how many must go from the teammates', and `warapp_submit_turn` warns on a
  teammate's card. An Order Delay that must leave the hand is played where the schedule advises it, not
  discarded.
  **The cards in effect (D3, UNVERIFIED live: `readActiveCards` is not yet checked on a live board).**
  `src/analysis/cards-in-effect.ts` (pure) keeps a decoded ActiveCard only when sure: turn known, the card
  in play with a `Duration`, its `untilTurn` after this turn and at most Duration turns ahead (the
  bundle's ActiveCard: ExpiresAfterTurn = Duration + turn number + 1, worn off at the end of the turn
  that reaches it), every named player a distinct player still playing. A Diplomacy between me and an
  opponent (never a teammate) is T9: `planRelationsFrom`'s `diplomacy` marks a ledger truce with it
  enforced, else adds a relation `card: 'Diplomacy'` covering everything; an enforced relation binds in
  any format, its player is no foe this turn, and when the card is gone by next turn (`lookAheadFoes`) still
  counts for every next-turn judgement: the two-step hold (#172), the frontier's hold cost (rule 4d) and a
  completion's defensibility (R3) — `nextTurnAt` in `plan/threats.ts` (G2). `warapp_check_plan` keeps the
  player among the opponents, so `exposedNextTurn` counts it anyway. Sanctions on me cut `warapp_plan_turn`'s income by the bundle's
  rule (per card, round((1 − Percentage) × income), .5 up, cap 10000; not under Local Deployment, which
  warns; `warapp_submit_turn`'s deploy-total check applies the same cut, and a modelled cut is no income
  uncertainty). Sanctions on others (G2) show in `cardsInEffect.sanctionsOnOthers` and (owner spec 2026-11-23)
  cut every income figure of that opponent (`applySanctions` in `plan/estimates.ts`, by the same rule): the
  estimate whatever its source, the fog prior and thin evidence's range — except a figure read only from
  deploys on or after `SureSanction.fromTurn` (`untilTurn` − Duration, the turn after the play), which already
  carries the cut (`sanctioned.carried`). check_plan's `enemyDeploy` and plan_turn's `enemyDeployDetail` report
  `sanctionApplied` and the clock's `cardBonus`; check_plan's `assume_enemy_cards: "none"` sizes replies without
  the card. A progressive Reinforcement card is valued by the client's formula, VERIFIED from the client bundle:
  when earned, `ProgressivePercentage` × the territories EVERY player holds (neutrals out; `Mode` 1) or × the turn
  earned (`Mode` 2), round half DOWN, at least 1 — the same for every opponent, counted over the territories in view
  (a floor under fog), or my hand's card when worth more (`reinforcementArmiesFor`; `cardBonusBasis` says which). The
  `SanctionsCard.Percentage` scale (a fraction) is UNVERIFIED for GameFeed. The Sanctions advice passes
  over a truce partner and a player a Diplomacy card keeps at peace with me, saying why. Anything not sure is
  a warning and changes nothing; the plan reports `cardsInEffect` (`verified: false`), and
  `warapp_check_plan` counts a card as a truce (`safeIfTruceHolds`; `safe` still tries its player).
  With no active card every plan is unchanged (golden).
- **The end-of-game pass (#312 E1; owner decisions P2–P4 of 2026-11-16) runs once per finished game the account
  played** (`src/tools/end-of-game.ts`, never throws): it reads the game's history ONCE (`getGame` with history,
  settings and `map: false`: a cached map is attached by its id, and the client's refresh of a cached map lacking
  land the standing names — which would repeat the request — never runs, and `noRetry` keeps the client from
  re-sending it on a 429 or 5xx, so the POST goes out once; with no map cached, one map-only read without the
  history follows, and when that fails the record is kept `noMap`), never retried, and keeps the
  capture name-free at `<dataDir>/finished/<hmac>.json` (`src/finished-store.ts`: the file name `finishedGameKey`, an
  HMAC of my account and the game under the ONE shared salt; players inside by `playerKey`; no clock; 0600, atomic, at
  most `MAX_FINISHED_RECORDS` (500) by last write or the sweep's refresh, never one the writer protects; a file that does not parse is never overwritten and blocks the pass,
  `record-unreadable`). The file is a processed mark: any status stops every trigger. So is the **lasting mark**
  (`markProcessed`, `<dataDir>/finished/processed.json`: the record keys only, hashed, no id; at most
  `MAX_PROCESSED_KEYS` (5000, ten times the record bound), the least recently marked dropped; atomic, 0600, under
  the path lock; a marks file that does not parse is never overwritten and marks then rest on the records), written
  as soon as a pass's request is spent (a failed request included; not when the reply shows the game still in
  play, which may end later) or it consumes the history a caller read (`warapp_get_game` with `include_history`), so a game whose record the bound pruned is never read again. **The one remaining
  exception:** a game whose record and mark have both aged out (5000 later passes) reads again if a trigger names it. `captured` holds
  (`src/analysis/finished-game.ts`, pure) the outcome from my player state (`won`, `lost`, `surrendered`, `eliminated`,
  `booted`, `ended-by-vote`) with the completed turns, the first history board I held no land (`outTurn`) and the
  winners; my pick list and award (`readPickRecord`); each player's start; per history board (`afterTurn` completed
  turns) each player's income by `boardIncome` (base or per-territory, plus full bonuses; cards and the army cap aside),
  territories, armies and full bonuses; for each target my cached orders attacked and did not take (orders of turn T on
  boards T − 1 and T) what stood there before and after; the history's boards themselves (`boards`: `[territory,
  owner, armies]` rows, the owner an index into `boardOwners` (player keys; any other owner unknown, its raw value
  never kept), a board listing the same territories as the one before kept as its changed rows; at most the first
  `MAX_RECORD_BOARDS_HEAD` (30) and the last `MAX_RECORD_BOARDS_TAIL` (30) boards, `boardsOmitted` counting the rest:
  the calibration harness's truth, #318); the settings shape (`nameFreeSettings`, src/replay.ts) and the
  map id. Every status also keeps the final outlook line this server logged for the game (`outlook`: `finalOutlookOf`,
  src/outlook-log.ts, from `<dataDir>/outlook/<gameId>.json` as me — the newest planned turn, its state, held turns,
  ratio, and `estimated` (the outlook log now marks a turn read on the likely high) / `thin`; no id, none of the basis's
  words; absent when it never planned the game). A failed request is `read-failed` (the error kind only), an unreadable history `history-unreadable` with
  #315's reason, each with the outcome the read that showed it finished gives; neither is retried by a trigger — only
  `warapp_get_game` with `include_history` re-runs a failed pass, from that call's own read (no further request).
  Triggers: `warapp_get_game` (the account: the board cache's, else the signed-in one), `warapp_wait_for_turn`'s read,
  a game-ended in-app notification in `warapp_get_notifications` (see "In-app notifications"), and the `warapp_my_games` sweep over its finished games (my seat held) not yet processed, newest first, at most
  `END_OF_GAME_PER_CALL` (2) per call, each also folding its live profile (`foldFinished`, #273); the records are the
  sweep's cursor (`endOfGame: { processed, pending }`). The sweep looks only at the newest `sweepWindow` (half the
  record bound: 250) finished games, refreshes their records each call and protects them from its own writes' prune,
  so the records kept are the newest games'; the lasting marks keep any game from being read twice (P2). A pass that spent its request but left no record (the write
  failed, or the reply showed the game not finished or not mine) is remembered in-process (`attempted`, bounded), so no
  trigger reads that game's history again in this process (`attempted` status). Only a seat of mine (P3);
  `WARAPP_PLAYER_PROFILE=off` or no data dir: nothing — not even the signed-in account is read (`finishedAccount` checks
  first); `warapp_get_game` asks for the account (an InviteToken page read) at most once per finished game per process
  when it cannot be read (the sweep picks the game up later). Registered hosted like the profile store. Inform only (P1): no planner decision reads it (golden
  unchanged).
  **Processing a captured history (#312 E2, `processHistory` in `src/tools/end-of-game.ts`; pure parts in
  `src/analysis/game-lessons.ts`, stores in `src/lessons-store.ts`)** runs right after a `captured` record is written,
  each part on its own, and reports `processed: { profiles, map, lessons }` (`no-map` without the map; profiles
  `teams-unknown` for a game of 3+ seats whose teams `keptTeams` cannot read, `nothing` when no turn was observed).
  (1) **Part C:** `observeHistory` reads each pair of consecutive history boards N, N + 1 as turn N + 1 with my
  cached orders of that turn (`observeTurn`, while I held land), `habitsOf` per opponent (never me, a teammate or a
  human who became an AI; AI seats pooled), folded with `source: 'history'`, which replaces the live entry; the
  per-game file, when there, is marked `folded: 'history'` (`markHistoryFolded`). `foldGame` never counts a game twice
  (`foldedBefore`: the population holds it, or the per-game file was marked): a player with no entry for the game
  is skipped when its entry list is full (one may have been dropped), and the population when it no longer holds
  the game. (2) **The map's record** `<dataDir>/maps-record/<mapId>.json`: games, outcomes, and per game (at most
  `MAX_MAP_ENTRIES`, 50) the format, seats, result, turns, my start region (territories and every bonus they touch,
  `startRegion`), my income curve (by completed turns, at most 60 points) and income after turns 4 and 8, and each
  winner's start region, income curve (#419, as mine; an entry kept before it gets one from its end-of-game record's
  boards through `warapp_backfill_history`'s `winnerCurves`, `backfillWinnerCurves` in `src/tools/map-curves.ts`, winners
  matched by start territories, no request) and income after turns 4 and 8 (the pace to beat); at most `MAX_MAP_RECORDS` (200) maps
  by last write; `mapRecordSummary` gives the medians. (3) **The lessons** `<dataDir>/lessons.json`: per format the
  games, outcomes, lost games by cause (`lessonLoss`: `howLost` on the history boards — `commander`,
  `last-territories`, `unknown` — or `surrendered`, `booted`, `still-holding`), the turn my income first went flat
  (`flatTurn`: from board 1 on, within `FLAT_TOLERANCE` (10%, at least 1) on each of the next `FLAT_TURNS` (3)
  boards; `flat: { n, sum }`), and the calibration (#294, #318 a): for each turn T I cached a board for,
  `trackOpponents` over my cached boards up to T (every seat as still playing) against the opponent's income on
  history board T − 1, estimate ÷ truth counted by coverage bucket (`none`, `under-25`, `25-50`, `50-75`, `75-up`:
  `n`, `sum`, `sq`, `logSum`, `under` < 0.5, `over` > 1.5) — aggregates only, no turn or player. Each game's entry
  (at most `MAX_LESSON_ENTRIES`, 500) holds its own counts, so processing it again replaces its share; a dropped
  entry's counts stay. Both stores: keyed by `finishedGameKey`, no id, name or clock; 0600, atomic, under the path
  lock; a file that does not parse (or a malformed total) is never overwritten (`failed`).
  **Where they are read (#312 E3, `src/tools/past-games.ts`, read-only, never throws; off with profiling off or no data
  dir; every view carries `PAST_GAMES_NOTE` and none is a planner input — P1, the golden corpus is unchanged — save
  #419's fog pace, `fogPaceFor`, above under thin evidence):**
  `warapp_plan_picks`' `mapRecord` (when the map has a game: games, outcomes, `myStarts` — my results per bonus my start
  touched (`mapRecordStarts`), `inPrimary` when this primary touches it — `winnerStarts`, and `pace.afterTurn4/8`: the
  medians of the winners' and my income; compact lists the first `MAP_RECORD_COMPACT` (8) bonuses; `unreadable` when the
  record does not parse); `warapp_plan_turn`'s `pace` (only when `turnsCompleted` is 4 or 8 and the record has a figure
  there: my income now — card armies out — beside the median winner's and my past median, `behindWinners`; read after
  the plan is made); `warapp_map_stats`' `myGames` (the same view in full, no request; the tool stays opt-in); and
  `warapp_track_opponents` full's `pastGames` (`lessonsSummary`: per format the games, outcomes, how lost, the mean flat
  turn, and the calibration per coverage band — `n`, `mean` and `geoMean` of estimate ÷ truth, `low` < 0.5 and `high` >
  1.5 shares — and every format together; `thisFormat` names the game's). The profile reads name a habit's basis
  `history` (`HabitBasis`) when the past weighs most and at least half of its `n` comes from entries folded from a
  finished history (`ProfileHistory.players[].fromHistory`, the player's `history` entries at their weight, this game's
  left out); the value never changes for it. **#312 item 4 is only partly met:** the calibration from past games is
  reported in `warapp_track_opponents` full (`pastGames`) only; the outlook and the estimate warnings
  (`warapp_plan_turn`'s) do not report it yet.
  **Finished-record and aggregate hygiene (#437 task 4, `docs/PLAN-DECISION-LOG-V2.md`; additive, every `version`
  stays 1, older records and stores read):** each finished record carries `kinds` (`gameKinds` in
  `src/analysis/finished-game.ts`): `lottery` (a map of at most `LOTTERY_MAX_TERRITORIES` territories; without the map,
  the decision log's join context read it as one, or the settings fit the lottery shape), `no-show` (a decision log or
  board cache is kept for the game, no won result, and no turn committed — no cached orders, no logged `sent` — or a
  boot seen while turn 1 or 2 was played, or a boot ending the game within one turn), `legacy` (no decision log and no
  board cache: never a no-show for want of orders), `team`. A lottery or no-show game (`excludedKind`, lottery first)
  is counted apart: `processHistory` writes `recordMapExcluded` / `recordLessonsExcluded` instead (`processed` all
  `excluded`; a game counted before has its share taken back), folds no history profile, and the sweep's live fold
  reports `profileFold: { status: 'nothing', reason: 'excluded' }`. Both stores keep `excluded: { lottery, noShow, keys }`
  (keys with their kind, at most `MAX_EXCLUDED_KEYS`, so a game is counted apart once; a game later counted as a game
  leaves it); `lessonsSummary`, `mapRecordSummary` and the views show `excluded` with `EXCLUDED_NOTE`. Every other
  profile fold skips such a game too, whichever tool reads it first (`foldExclusion` in `src/tools/game-kind.ts`, shared
  with the pass's `kindsOf`: the kinds of the game's finished record when there is one, else read now from the game and
  what this server kept as the cached account — its map's size, the log's `join.lottery`, the orders and seat events;
  with no cached account only the map size or the lottery settings shape): `foldFinished` (warapp_get_game,
  warapp_profile_opponents) answers `{ status: 'nothing', reason: 'excluded' }`, and the file-only folds
  (warapp_wait_for_turn's read, a game-ended notification) go through `foldKeptProfile`, which folds nothing for it.
  `outcome.leftTurn` (`leftTurnOf`): for a surrender or a boot the turn being played when the decision log's events saw
  my seat leave (`my-surrender`, my seat's `surrender-accepted` / `booted`; the earliest), else the history's out turn;
  for an elimination the out turn. It is the lessons' `howLost.turn` for a surrender or boot, and `failedAttacks` drops
  my orders of that turn and later (they never ran). **Commander territories in a finished history are counted (#437,
  VERIFIED live 2026-11-20):** GameFeed sends such a territory's armies as `"<N>|cmdr,<GUID>,<owner id>,"`, N the plain
  armies alone (the commander is the unit after the bar, fighting as 7, not in N); `boardFromStanding` reads it as
  `armies: N` plus `specialUnits` (fixture `tests/fixtures/gamefeed-history-commander.json`), so `PlayerTurn.armies` is
  exact there and `PlayerTurn.commanders` counts the player's own commanders on its land (the decision log's truth
  carries `commanders` beside `armies`, `mine` and each opponent). `armiesUnread` remains for a count that does not
  read on a board that hides nothing (records written before this, where a commander stood, carry it: `armies` is a
  lower bound then); only a fogged territory makes `armies` `null`. Map entries keep `kinds` and `settings: { key (`settingsKey`), localDeployments?,
  commanders? }`; `mapRecordSummary` / `mapRecordStarts` take a `MapMatch` (`mapMatchOf`: the current game's format,
  Local Deployment and Commanders — an entry that kept no flag matches on it, counted in `settingsUnknown`), and
  warapp_plan_picks' `mapRecord` and warapp_plan_turn's `pace` read only the matching games, with `matched: { by,
  entries, of, settingsUnknown, note }`; warapp_map_stats (no game) reads them all.
- **End of game (#178).** `Game.endRules` holds the surrender, boot and AI settings; whether a surrender
  needs acceptance comes from `InstantSurrender`, not the player count (the count is only the fallback;
  #228: the surrender preview reads the game with `settings: true`, which carries it — without them it
  always fell back — and unread with more than two players `acceptance.needed` is `null`: it MAY be
  needed, the result reading unchanged).
  `warapp_plan_turn` logs each turn's outlook name-free at `<dataDir>/outlook/<gameId>.json` (per turn
  the strengths, ratio and state, and since #283 the armies and income behind them, `figures`, with the
  strongest side's id; `warapp_get_game` adds the final result); the surrender preview reads the latest from there.
  **How a lost game was lost (#274, `src/analysis/how-lost.ts` pure, `src/tools/how-lost.ts`):**
  `warapp_get_game` on a finished game the cached account did not win reports `howLost`, and (#283) on a
  game still playing once that account's seat is out (`Eliminated`, `Booted`, `SurrenderAccepted`; no
  disk read unless some seat is) — a surrender or boot by its state, with (#283) `turn` (the last turn
  played here: the newest cached board where it held land, or logged outlook) and `outlook`, the newest
  logged one up to then (its state, `held` when the log's latest state held, and `mine` / `strongest`:
  armies and board income, the strongest side's in view, from the log's per-turn `figures` —
  `OutlookTurn.figures`, absent on turns logged before #283), all in its `line`. #522 (owner decision
  2026-11-23): under fog the strongest's board income can sit at the base while it earns several times that,
  so `strongest` adds its `tracked` income and frontier `coverage` (the logged #304 evidence) and, when the
  logged #436 income side is the same side (the log's `income.playerId`/`team`, kept since #522), its calibrated
  range (`estimate`: `low`/`high`/`estimate`/`calibrated`); `incomeLeader` names the strongest on income when it is
  another side — the surrender line's side anywhere in a large game (the log's `surrender`, #530), else the
  outlook's income side; an elimination from the newest
  cached board where it held a territory (the turn, `turnCertain` only when it is the game's newest
  completed turn): my commander there → its territory fell
  (inferred), with what stood there after my cached orders (`low` after my moves out, `high` after my
  moves in) and `armiesToTake(low + 7)` at the game's kill rates (`exact: false` with luck;
  `held.uncertain` when an order `moves` leaves out — kept only in `sent` — or a card play touches it).
  When that turn's cached orders walk the commander (`commander: true` on `MyOrders.moves` / `sent`,
  cached by `myOrdersOf`), it is read at the walk's destination, `territoryCertain: false` (it may
  have fallen on the start before the walk ran), the neighbours of both. No
  commander → the last territories; a Commanders game whose board shows none → `unknown`. The
  neighbours by owner (fog `null`), `by` only when one player alone borders it. Kept as `loss` in the
  outlook log (ids and figures; a log may hold only that; never written over another account's log) and
  read from there once the boards are gone; names go out through `untrustedText`.
  An opponent the outlook cannot measure (nothing in view now, or no observed income) gets a
  peer-paced likely high (#214, `peerPace` in `src/analysis/outlook.ts`, pure and exported for the
  planner): each turn 2 × the higher of my income and the most any opponent was tracked earning, the
  map's even share only a ceiling — never sized by the map; it can still block `winning`. Every likely
  high starts symmetric: the given start, the even share under full distribution (the real start
  then; #428, `fullDistribution`: DistributionMode 0 with no TerritoryLimit — -1 is a limited start,
  TerritoryLimit × InitialPlayerArmiesPerTerritory, verified on three games), else my opening board, else the default territory limit (3) at the starting armies — never
  the territories I hold on a later board; my income before my first board ramps up from that
  opening's.
  #228: the likely high is generous to the opponent (every army received, none lost: a game I lead read
  0.05×), so `losing` on it needs mine at most `LIKELY_LOSING_RATIO` (1/(2.4 × 2)) of it AND
  corroboration — the main front grinding me down, or my income at most `BEHIND_RATIO` × the most an
  opponent is tracked earning (#522, owner decision 2026-11-23: an opponent whose frontier read is thin counts
  at its #436 calibrated estimate when that is higher — capped at what it could earn, never below its tracked
  figure — and `lowLikely.calibrated` says so; a solid read or no calibrated band keeps the tracked figure; the
  surrender line keeps #436's rule that calibration never creates a deficit alone); the turn carries `estimated: true` and `lowLikely`, and the basis says
  which (or, uncorroborated, why it is no loss). That front is always forecast on the incomes read off
  my boards, never the plan's (#228 review): the planner reads the outlook before it plans, and the
  reported one is re-read with the plan's front, so the losing state the plan acts on (rule 3d's decided
  horizon, its line calling it an estimate) is the one shown and logged. `warapp_plan_turn` passes the plan's profile standing
  back (`standing`): an `even`/`stalemate` outlook beside `ahead`/`behind` says why the two differ.
  **What the state rests on (#304).** Every outlook turn carries `evidence` (`OutlookEvidence`, the latest's
  also on `GameOutlook.evidence`): the two incomes compared (mine — my team's in a team game — against the
  side the likely high rests on, else the strongest; tracked off my boards, its visible income at least, else
  in view), and per opponent still playing its income and the share of its frontier that income was read
  from (#294's `TrackCoverage`, `null` when unmeasured), `thin` when the board is not in full view and that
  share is under `LOW_COVERAGE` (0.5) or unmeasured. The basis says them after the state ("Incomes compared
  …", "Frontier read …", and "Thin evidence: … so "even" is not a safe reading"); plan_turn's compact
  outlook, the outlook log (per turn and `latest`, without the coverage's words) and the surrender preview
  carry it. Reporting only: it never changes the state, a ratio or any plan.
  **Leaning behind (#368).** Each outlook turn names the positive bonuses my side held in full on the board
  before and no longer does (`bonusesLost`); when the state is `even` on strength for `OUTLOOK_TURNS` running
  (#436: whatever each turn's income lean, unless the run reports `behind`) and every turn of the run lost one, `GameOutlook.leaning` is `{ toward: 'behind', turns, lost }` and the basis says
  "Leaning behind: …"; plan_turn's compact outlook carries it. Reporting only: the state, its thresholds and
  the profile's standing (#287) are unchanged.
  **Incomes, their trend, and the surrender line (#436, owner decision of 2026-11-20).** Each turn carries `income`
  (`OutlookIncome`): my side's income against the strongest opponent side's by estimate — its range (`low` the
  tracked income, its visible at least; `high` the likely high's income per turn while its evidence is thin, else
  `low`) and its estimate (the tracked figure ÷ past games' estimate ÷ truth in its coverage band, `calibration`
  from lessons.json through `outlookCalibrationFor` in `src/tools/past-games.ts`: this format's band with
  `MIN_CALIBRATION_SAMPLES` (5) or more, else every format's; never below its visible income; uncalibrated, the
  tracked figure; the estimate and `high` never above what it could earn that turn — `capIncome`, the could-earn
  bound `paceIncome` keeps to, or `low` when that is higher — since ÷ ~0.3 at low coverage can read an income it cannot
  reach). Its `lean`: `unknown` when the range spans both lines (`INCOME_BEHIND_RATIO` ⅔ and
  `INCOME_AHEAD_RATIO` 1.5), `behind`/`ahead` when the whole range, else the estimate, is past one, else `even`
  unless each side's change per turn over the turns judged (`trend`), one turn on, crosses a line the ratio heads
  to (`byTrend`). Calibration deepens a deficit the tracked figure shows, never creates one: a `behind` lean on the
  estimate or its trend, and a turn under the surrender line, also need my income under the tracked figure (the
  range's `low`); when only the calibrated estimate reads behind the lean is `unknown` (`calibratedOnly`). In-sample
  replay (10 lost games, 100 turns): truly-even turns past the crossed line 5/25 → 1/25, truly-behind 42/75 → 29/75,
  games crossed 10 → 9 of 10 (`MIN_CALIBRATION_SAMPLES` stays unmeasured). No lead is claimed at low coverage (any `evidence.thin`): `ahead` reads `unknown`, and a win on
  the likely high alone is not read (`noLeadClaim`; a win on the bound still is). **#454: the state keeps its four
  values** (winning, losing, even, stalemate — the tool contract, as #321 kept the chat source's; the planner reads
  only winning and losing): a lean beside an `even` state is the additive `lean` (`ahead`/`behind`/`unknown`, absent
  when the state already says it), per outlook turn and on `GameOutlook` — plan_turn's compact and full outlook, the
  outlook log (per turn and `latest`), `finalOutlookOf`, the surrender preview, how-lost, `MySurrenderDetail`
  (`outlookLean`) and the decision log (`outlookLean`) carry it. The mapping is exact (a lean only ever replaced an
  even state), and the internal readers use the finer `readingOf` (lean, else state): the chat standing, the
  decision log's compaction and truth/accuracy. A log, decision or finished record #453 wrote with the lean as the
  state reads as `even` with that lean (`splitReading`, on read). Turns even on strength are one run for the hold
  whatever their leans: the run's `lean` is set when every turn judged read it, else plain `even` (a slide reading
  even, behind, behind holds `even`, and #368's lean behind still reads). `GameOutlook.pace` is the pace line (both incomes
  and their change per turn) and `surrenderLine` — ADVICE ONLY, the server never acts on it — is present while my
  income is under ⅔ of the strongest estimate, `crossed` after `SURRENDER_TURNS` (3) turns running with no bonus in
  reach closing the gap (`bonusesInReach`: every missing member beside my land, its visible defenders below my
  armies beside them plus my income); plan_turn's compact outlook carries `income`, `pace` and `surrenderLine`, a
  crossed line is a leading warning, and the outlook log keeps `income` per turn and `latest.surrenderLine`. Play
  policy (notify the owner, surrender next turn unless he objects) lives outside the repo. Golden unchanged.
- **One healthcheck for both transports** (`registerAdaptiveHealthcheckTool`): the credential
  probe while the direct leg serves (and until the bridge has carried a request), the bridge probe
  only when this connection's router is on the bridge leg (the fetchproxy bridge is shared
  process-wide, so its role alone is not enough; `WARAPP_TRANSPORT=direct` never probes it); either way it reports the active leg and whether a direct session is linked and
  its age (never the token). With a direct session either arm first checks it (`sessionCheck`, plus
  the router's `wall`): signed out fails as `session_expired` even when the API token is fine (a hosted
  healthcheck said ok while every live tool failed), and on the bridge arm a signed-in check lifts the wall
  and probes over the direct leg. The bridge port is `WARAPP_WS_PORT` (default 37149); hosting needs
  `bridge: true` and `bridgePortEnv: WARAPP_WS_PORT` on the registration.
- **"My games" is `GetMyGames` (method 50)** through the bridge, decoded by the bundle's own
  readers by stable type name (`warlight.shared.MyGamesReturn` / `GameInfo` /
  `GameInfoPlayer`) — never a hand-transcribed layout. Its `MyGamesFilters` argument is
  required (absent, the server throws). `waitingOnYou` = the game is Playing or
  DistributingTerritories, my player is Playing, and my `committed` flag is false.
  **The whole list (#260):** the client's default filters (`Default`, count 10) are the dashboard's
  short list (live: 10 of 41 games), so `fetchMyGames` (`listMyGames`, `src/tools/my-games.ts`) asks
  `MyGamesFilterType.All` with a count of 100, then 400, then 1600 while a reply fills its count
  (`MY_GAMES_WINDOWS`; the client never pages GetMyGames: no start index), and says `partial` when the
  widest is filled or a wider read fails. Every caller gets that list (`warapp_my_games`, the chat inbox,
  the turn wait's default, the team fallback, the join/leave read-backs). `warapp_my_games` leaves finished
  games out unless `include_finished` and reports `listed` and `complete` (a `warning` when partial).
  UNVERIFIED live: `All` with a count above 10.
- **Scouting reads two server-rendered pages** through the bridge (GETs the extension makes):
  `https://war.app/Profile?p=<invite token>` (level, games played, last seen, boots, ranked
  records) and `https://war.app/CommonGames?p=<invite token>` (the head-to-head games). The
  invite token is the GameFeed player id. `src/scout.ts` and the skill's
  `references/scout.mjs` parse them identically (parity is tested) and tolerate missing
  blocks (`null`, never a throw).
- **A distribution mode's starting territories come from `GetMapDetails` (73, no auth; #328)**, never GameFeed
  (which names the modes only): `src/map-details.ts` decodes `MapDetails` → its mode dict (fourth field) →
  `NormalDistribution` (its id list) / `ScenarioDistribution` (its territory → slot dict's keys) by type name
  with the bundle's readers, and drops (with a warning) any id that is not a territory of the map.
  `withModeTerritories` (`src/tools/map-details.ts`; callers: `warapp_get_map`'s full view and
  `warapp_locate_opponents` in an automatic game) asks only when a caller needs them and a mode lacks them,
  at most once per map per process (`MapCache.mapDetailsTried`); a failure, a mode listed without ids or one
  whose every id is dropped is `null` (unknown), never `[]` — an empty list is never kept, and a stored `[]`
  reads as not read yet. Read ids are kept on the cached base map and in the store
  (`distributionModes[].territories`, `writeStoredModeTerritories`: the map's `storedAt` unchanged, so they
  age out with it; a stored mode without them reads as not read yet; a new game on a stored map keeps them, the
  fresh download written with the stored copy's `storedAt` so they still age out on their own clock, and a mode
  whose stored ids are not all territories of the fresh map is not carried, so it is read again).
  Only `warapp_get_map`'s full view (no `bonus` filter) asks; it lists each mode's `territoryCount` and
  `territories`. VERIFIED live 2026-11-16 for normal modes (seven modes on one map matched #328's trace); the scenario
  mode is UNVERIFIED live (docs/WEB-PROTOCOL.md "Map details"). `warapp_locate_opponents` reports where its start
  candidates came from as `startCandidates` (`source`, `count`, and for a distribution mode its id and name).
- **A game's map comes from `mapOf(game)`** (`src/tools/map.ts`), which applies the game's
  `OverriddenBonuses` (`applyBonusOverrides`); load the game with `settings: true` wherever bonus
  values matter. The JSON shape is verified live (an array of `{ bonusID, value }` numbers); overrides
  that do not read in full keep the submit pre-checks soft. Mega-game audit (2026-11-23, game settings
  with 1,067 overrides, 397 paying, MinimumArmyBonus 15): plan_turn, check_plan, plan_picks, get_map,
  the outlook and the stress test already read the game's values and base income, and skip bonuses
  worth 0 or less as targets while still routing through them; the one gap was `recordFromGame`
  (map stats), which now applies the game's overrides (records cached before keep their old reading).
  `warapp_get_map` `income_map: true` (`incomeMap`) lists only the paying bonuses with members and size.
- **Map statistics are opt-in and local-only** (`warapp_map_stats`, `src/stats.ts`): off unless
  `WARAPP_STATS=1`, always off when hosted (recognised by mcp-host's child-only variables —
  `HOSTED_MARKERS` in `src/hosted.ts`), and `mint.yaml` never sets `WARAPP_STATS`. GameIDFeed + GameFeed
  `GetHistory=true` through `WarappClient`, ≥ 1 s apart, finished games cached forever as
  name-free records at `<dataDir>/stats/<mapId>/<gameId>.json`. #302: the history is read from
  `history`, else the reply's top-level `standing<N>` / `turn<N>` / `distributionStanding` keys (shape
  UNVERIFIED, docs/WARAPP-API.md; a `distributionStanding` with no player land is the board before
  picks, so `standing0` is the start), and an unreadable one says why, name-free (`historyReport` in
  `src/trend.ts`: a reason and key names only) — `collected.unreadableGames` here, `historyUnreadable` /
  `historyRead` in `warapp_get_game` with `include_history`. A record keeps the history `layout` it was
  read in: a layout added to `RETIRED_LAYOUTS` (`src/map-stats.ts`, empty until the live check) makes its
  records unreadable, never cached and a cached one deleted and fetched again. Each game is read with
  `GetMap=false` (a cached map is attached by its id); only a finished game on an uncached map
  costs one more request, for the map.
- **Offline replay (`src/replay.ts`).** Wherever the board cache is written (plan_turn,
  track_opponents, locate_opponents, get_relations) the game's settings are kept at
  `<dataDir>/games/<gameId>.json`: name-free (players by id, team, state and AI flags; raw settings
  through `sanitizeSettings` — numbers, booleans, numeric strings, a few enum words and a card's
  `Mode` word (`cardArmyCeiling` reads it), no free text,
  no mod entries, nothing equal to a player's or the game's name; overrides re-written in their
  verified shape), 0600, atomic, best effort, the newest `MAX_GAME_RECORDS` kept and a game not
  written for 60 days deleted, like the boards. `loadReplay(dataDir, gameId)` rebuilds the planner's
  inputs from the data directory alone: `{ game, settings, map, playerId, boards, orders }`
  (`undefined` without a settings record; `map` absent when the store evicted it).
- **The decision log (#412, `src/decision-log.ts`; design record `docs/PLAN-DECISIONS-412.md`).** Per game, one
  account's entry for every turn it plays, at `<dataDir>/decisions/<gameId>.json` (`{ version: 1, gameId, playerId,
  status: 'active' | 'finished' | 'compacted', turns }`), name-free (player ids and the map's own names; every player
  name the game carries is scrubbed from every string, `override_reason` included). A turn `warapp_plan_turn` planned
  (not a what-if: an explicit `goal` or `enemy_deploy`, as the board cache's rule) is a full entry: the fogged board
  (delta-encoded against the previous logged turn, a full board at the first logged turn and every `FULL_BOARD_EVERY` =
  10; `boardAt` rebuilds any turn), the planner's replay `input` (what the map store, the settings record and the board
  cannot give back; `encodeInput`/`decodeInput`), `planner.version`, the `decision` (goal, profile, deploys, moves,
  expected, conceded, offence, enemyDeploy, card advice, the logged estimates, the `rationale` and `warnings` lines verbatim, outlook state), and
  `next` (actual income, captures/holds, bonuses, eliminated; #442: `capturesMissedTo`, the player holding each missed
  capture) filled when the following turn is planned; warapp_plan_turn's `sinceLastTurn` names each capture the logged plan
  expected (kept to the moves sent, when logged) and did not make, with who holds it ("your attack hit their fresh
  capture" when it was not theirs before). Every other
  turn the server sees gets an observation entry (`kind: 'observed'`, `source: 'live' | 'history'`) wherever the board
  cache is written (`src/tools/decision-capture.ts` `captureObservation`: track/locate/profile opponents, get_relations,
  plan_turn what-ifs and `boardHistory`'s history fill); it never overwrites a planned entry, and a later plan upgrades
  it. `warapp_submit_turn` records `sent` after a confirmed send (`captureSent`, where `writeOrdersCache` runs) and an
  `override` (`by: 'agent'` by default, or the caller's `override_by`, with `override_reason` ≤ 500 chars) only when the
  orders differ from the logged decision (`ordersDiffer`); with no plan logged it records `sent` on the observation
  (or a minimal entry). Once a game is finished the end-of-game pass (src/tools/end-of-game.ts, after the record is
  captured) writes every turn's `truth` from the FULL history, before finished-store's head/tail cut (a turn with no
  entry gets a truth-only entry, a turn the history lacks is listed in `truthMissing`; no log is started for a game
  with none), each logged turn's `accuracy` and the game's `accuracySummary` (`recordTruth`, pure part
  `src/analysis/decision-truth.ts`, #318's alignment), then `compactDecisionLog` — which never drops a board, decision,
  rationale/warnings, sent, override, `next`, `truth` or `accuracy`, only the replay `input` of uninteresting turns
  (interesting: an override, an outlook change, the first `KEEP_FIRST` = 3, the last `KEEP_BEFORE_LOSS` = 5 before an
  elimination or loss, next income ≥ 20% short of expected, an estimate off by > 1.5× or < 0.5×). A pass that captured
  no history, or none run (`WARAPP_PLAYER_PROFILE=off`), marks the log `finished` uncompacted (`finishDecisionLogs`).
  Caps: `MAX_DECISION_GAMES` = 1000 games and `MAX_DECISION_BYTES` = 500 MB (`pruneDecisionLogs`, after a write at most
  once per `DECISION_PRUNE_INTERVAL_MS`: oldest finished games first, a game only ever whole, never one still running;
  listing reads only each file's head). `WARAPP_DECISION_LOG=off` writes nothing; `full` skips compaction. 0600 in
  0700, atomic under the path lock, best effort; a file that does not parse or carries another `version` is never
  overwritten, listed or pruned. The state bundle carries it (`decisions`, finished games too, newest first up to
  `MAX_EXPORT_DECISION_BYTES` = 16 MiB, the rest counted in `leftOut.decisionLogs`). Offline replay is the LOCAL dev
  script `scripts/replay-decisions.mjs` (never a tool, never in CI; pure part `src/analysis/decision-replay.ts`): it
  re-plans every turn whose input was kept, under an optional scenario, and reports identical/different orders, a
  score against `next`, the estimate accuracy against the truth and `--export-fixtures`. The invariant — unchanged code
  and no scenario reproduce the logged deploys and moves — is tested from the capture (`tests/decision-replay-tools.test.ts`).
  How to run: `docs/PLAN-PROFILES.md` "Replaying the decision log". No planner decision reads the log.
  **v2 per-turn additions (#437 task 1, `docs/PLAN-DECISION-LOG-V2.md`; additive, `version` stays 1, older entries read
  as they are):** `planner.build` (`src/build-id.ts`, read once per process: `git:<sha>` from this package's own `.git`
  — a worktree's `.git` file, its common dir and packed refs followed, no process spawned; never the `.git` of a project
  it is installed inside — else `sha256:<16 hex>` of the running bundle); `times` (ISO wall-clock: `plannedAt` by
  `recordDecision`, `sentAt` by `recordSubmission`, and from the game read `turnStartedAt` — GameFeed's `lastTurnTime`,
  read as the turn's start, unverified — and `bootAt.auto`/`direct` from AutoBoot/DirectBoot); `firstMover` (`{ who,
  source, verified }`, `null` unknown); `cards` (`hand`: my cards by type and count; `advice`: per card advised its kind,
  target ids, player and a reason code, never prose, `cardAdviceLog`; `played`/`discarded` from `sent`); `checks.submit`
  (the commander check — `null` without one — the weakest 5 headroom rows as `takeAt` and what each protects, the
  below-plan rows and the chat commitments the orders break, by id) and `checks.checkPlan` (`warapp_check_plan`'s `safe`,
  the worst reply in numbers, `harmful`/`considered`, the `atRisk` counts, `whatIf` under `enemy_deploy` or
  `known_income`; `recordCheck`, the latest run per turn wins, starting an entry when the turn has none, and a plan of
  the turn after it keeps it). The pure shapers are in `src/tools/decision-capture.ts`; compaction keeps all of them.
  **v2 per-game additions (#437 task 2; additive, `version` stays 1):** `events` (`{ turn, kind, player?, detail?, at }`,
  `turn` the turn being played when seen — completed + 1, 0 before turn 1 —; the newest `MAX_GAME_EVENTS` = 500 kept,
  `eventsDropped` counting the rest; never twice for the same change): seat changes diffed against `seats` (each seat's
  last state word and turned-AI flag, by GameFeed id; `seatEvents`: `booted`, `surrender-accepted`, `eliminated`,
  `ended-by-vote`, `turned-ai`, any other non-`Playing`/`Invited` word as `seat-state` with the word — a non-word reads
  `other`; at first sight a seat already out is an event too) on EVERY GameFeed game read (`WarappClient.observeGames` →
  `captureSeats`, wired in `src/tools/index.ts`; as the log's own account when seated, else the signed-in account only
  when a read already gave it — `LiveContext.cachedInviteToken`, never a request — and the game not `Finished`, which
  starts a log; an unchanged read is skipped by an in-process signature); `surrender-pending` (player, `owed` /
  `not-owed` / `unknown`) from `readPendingSurrenders` (warapp_wait_for_turn, warapp_plan_turn; warapp_my_games' list
  read carries no GameFeed ids and logs nothing); `surrender-accepted-by-me` (warapp_accept_surrender `confirmed`); and
  `my-surrender` (warapp_surrender `surrendered` or `pending`, `detail`: status, my income and the highest-income opponent
  from the outlook log's latest evidence, its state and turn, `mySurrenderDetail`). `join` (warapp_join_game `confirmed`,
  `joinContextLog`): `settingsKey` (`sha256:<16 hex>` of `nameFreeSettings`, keys sorted; `null` when GameFeed could not read
  the lobby), `flags` (format, seats, pace, boot minutes, and from GameFeed LD, commanders, kill rates, luck, fog, cards)
  and `policy` (`policyChecks` in `src/open-games.ts`: `broke`/`passed`/`unchecked` by code — commerce, mods,
  custom-scenario, neutral-cost, seats, boot-time, lottery), `lottery` when marked. `opponents` (by GameFeed id:
  `firstSeen` turn, `ai` for an AI seat; warapp_scout_player with `game_id` adds `level`, `ranked`, `bootRatePct`,
  `readTurn` to a log that exists, as its account — no extra request; GameFeed's player carries no level). A log holding
  only these (a lobby joined) is finished and compacted like any other (`hasContent`). All kept through compaction.
  **v2 picks phase (#437 task 3; additive, `version` stays 1):** `picks` on the log — `advice` (warapp_plan_picks,
  `picksAdviceLog` → `capturePicksAdvice`: players, territory limit, `maxPicks`, `spread`, the list, primary and fallback
  ids, the first `LOGGED_PICK_SCORES` = 10 picks' scores, both group scores, the warnings by code (`pickWarningCode`,
  each once, unknown wording `other`), the award `outcomes`/`orders` judged/`worst`/`reordered` (`null` when not judged),
  coverage numbers, the `alternative` when offered, and in a team game the teammates' ids, lists read and `mirrored`;
  never a reason, rationale or name; a re-plan replaces it, `advices` counting; logged as the log's own account when
  seated, else the signed-in seat by `myInviteToken` — cached, so usually no request; neither seated: nothing),
  `submitted` (warapp_submit_picks after a send that did not throw, `capturePicksSent`: `sent`, `readBack` or `null`,
  `verified`, `outcome`; the latest send wins, `submits` counting; a preview logs nothing) and `award` (`loadAward` on
  turn 1 when it writes the reading, `capturePicksAward`: `turn` and the `AwardReading` or `null`; written once, never
  over one kept). Each starts a log; a log holding only `picks` is finished and compacted like any other; kept through
  compaction.
  **The review export (#437 task 5, `scripts/review-export.mjs`, LOCAL dev script like the replay: never a tool, never
  in CI; logic in `src/review-export.ts`, tested in `tests/review-export.test.ts`).** `reviewGame` joins one game from
  the data dir alone: the decision log (each turn without its encoded `board` and replay `input` — `hasInput` says
  whether one was kept; `boards: true`/`--boards` adds `boardAt`'s board whole, `null` on a broken chain — plus
  `accuracySummary`, `truthMissing`, `events`, `eventsDropped`, `seats`, `join`, `opponents`, `picks`), the
  finished record, the map-record and lessons entries by `finishedGameKey` (`{ entry }`, or `{ entry: null, excluded }`
  for a game counted apart), the settings record's game by ids only, the stored map's name and size, and
  `kinds`/`format`/`outcome`/`turns` read off them; `sources` says per source `present`/`missing`/`unreadable`
  (`excluded` for the two keyed stores). My account is the log's, else the board cache's, else — a legacy game — the
  settings record seat whose `finishedPath` exists. `reviewGameIds` lists every game with a log (readable or not) or a
  settings record; `exportReview` writes `game-<id>.json` and `index.json` (one line per game: id, kinds, format, map
  id and name, outcome, turns, sources), pretty JSON, atomic, 0600, into a folder it makes 0700 and refuses when an
  existing one is readable by others (never chmod-ed). No request; nothing written to the data dir (reading a stored
  map touches its mtime, as every reader does). Name-free like its sources.
- **Scoring the income estimates from the tool (#569, `warapp_calibration`, read-only, no war.app request).**
  `src/analysis/income-calibration.ts` (pure) reads every finished decision log carrying the end-of-game truth
  (`calibrationGames`, src/tools/calibration.ts: lotteries left out, format from the settings record, else the
  join context, else the seats): one sample per logged estimate (`accuracy.estimates`, the calibration's alignment)
  with its format, seats, phase (`PHASES`), coverage band, source, thin evidence, the tracker's income method
  (`LoggedEstimate.method`, logged since #569 from `PlanInput.tracks`: `rise-capped` is #418's cap) and whether the
  opponent led on true income; `errorView` (mean, median, geoMean, tails, `meanError` in armies) per breakdown;
  `catchUp` (a true jump of `JUMP_FACTOR` 1.5× or more, turns until the estimate reaches `CATCH_UP_SHARE` ⅔ of the
  truth, censored past the logged turns; #586: only a jump on a turn that logged that opponent's estimate counts — the
  truth covers every turn, the estimates only planned ones, so the rest is `unwatched`, never lag); `consequences` (a proxy: turns losing an unconceded territory with an
  estimate under half vs without); the `WORST_LISTED` largest misses. Games numbered by their place in the report,
  never by id; no player in the output. `samples: true` returns the rows (at most `MAX_SAMPLES`); `harness: true`
  adds the #318 harness. #568: each logged estimate also keeps its pipeline `stages` (`EstimateStages`, `estimateStages`: visible, observed,
  tracked, prior, stated, blend, thin, known, card — figures only), the report scores each (`byStage`) and `trackedWhatIf` says what
  dividing the tracked figure by its coverage band's geomean (other games only, at least `WHAT_IF_MIN_SAMPLES`) would have read at
  each damping in `WHAT_IF_DAMPINGS`, overall and by band. #586: each logged estimate also keeps the tracker's own figures (`LoggedEstimate.track`, `loggedTrack`: its income, each income-window turn's observed/raw/low/high/cap/coverage with any capture floor, `accounted` or fog-capture income, and the carry lowered, rise cap, #567 low, tripwire step, #250 jump verdict and top-up — numbers only, no warning or note text), so a finished game shows which step held an estimate down after a jump; it outlives compaction, which drops the replay input that also holds the track. The report's `heldBy` (`heldByOf`) names, per estimate under ⅔ of the truth, the step that held it (`HELD_BY`: after-tracker, rise-cap, tripwire, window, ceiling, ambiguous, readings, no-track; `unlogged` before #586), and each sample row carries it. Reported only (P1).
- **The turn history (#570, `warapp_turn_history`, read-only).** Reads the game's decision log: per turn the board seen
  (`boardSummary`, or whole with `board: true`), `ownerChanges` against the turn before (in view both times), every
  player's visible orders (`seen`), plan, sent and `differsFromPlan` (`ordersDiffer`), outcome, cards, events, truth and
  accuracy; paged (`DEFAULT_HISTORY_TURNS` 5, `MAX_HISTORY_TURNS` 20). The visible orders come from the LatestGameInfo's
  last `GameTurn` (`readSeenTurn`, src/turn-orders.ts: `decodeOrder` per order, the player the order's last int — the
  verified position for card plays, the bundle's for deploys and moves, UNVERIFIED live; other kinds by class name;
  at most `MAX_SEEN_ORDERS`), kept by `captureSeenTurn` (src/tools/decision-capture.ts → `recordSeenTurn`) on the
  resolved turn's entry from warapp_plan_turn (what-ifs too: a fact) and from the tool's `read_last_turn`, only when
  the GameTurn is the turn just before the one played. Attack results are not decoded. No planner reads it.
- **Calibration harness (#318, `scripts/calibrate.mjs`, LOCAL dev script, never in CI; its body is
  `src/tools/calibration-harness.ts` since #569, which `warapp_calibration`'s `harness: true` also runs).** Runs on
  the built `dist/**` over the data dir and prints aggregates only (no id, no name). Pure parts in
  `src/analysis/calibrate.ts`: `estimateSamples` (tracker via E2's `calibrationSamples`, the fog prior and the plan's
  estimate via `planEnemyEstimates`, each ÷ the history's true income, by format and coverage band),
  `openingBenchmark` (my real start replayed 8 turns on `planTurn` + `simulateTurn`, the opponents put back where the
  history shows them by `overlayHistory`: no fog, no attacks on me, no cards — said in the output) and the aggregates.
  Truth is the end-of-game record itself (`<dataDir>/finished/<hmac>.json`, which keeps the history's boards, owners
  by `playerKey`, delta-encoded, bounded): the harness keeps no store and makes NO request (no `--fetch`, no GameFeed
  path of its own). `calibrationSources` (`src/calibration-source.ts`) reads every record: one matched to its game's
  settings record gets the ids back by key (`historyOfRecord`, a key is never reversed) and my cached boards; one
  whose settings record aged out is read on its own (its own settings shape, the stored map by its map id at any age,
  players labelled by position — `anonymousHistoryOfRecord` — and no cached boards, so the opening benchmark only);
  what it skips (no settings, no stored map, a failed pass, a settings record whose pass has not run) is counted and
  printed with the approximations, with why. So one history read per finished game (P2) feeds the profiles, the
  lessons and the harness under one bound and one name-free store (P4). The data comes from the normal end-of-game
  pass (its triggers above); then run the harness. With `WARAPP_PLAYER_PROFILE=off` it reads nothing. Until a pass
  has run there is no truth and the harness says so (no number). No planner decision reads any of it (P1). How to run:
  `docs/PLAN-PROFILES.md` "Calibration and the opening benchmark".
  #503: the opening benchmark is split by era (`openingEra`: turn-1 time, else game id vs `PRE_RULE_4F_GAME_ID`;
  pre-tool when nothing local names the game), with medians beside means and `n` per figure; games with a turn 1–4
  without orders or a boot (`openingFlags`) are reported apart (`benchmarkByEra`).
