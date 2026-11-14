# warapp-mcp

[war.app](https://war.app) (Warzone) game advisor MCP server for Claude. It reads your games
through war.app's per-player **GameFeed** API and helps you think about them: players and
settings, the map's bonuses and chokepoints, the board, and routes between territories.
Through your signed-in war.app browser tab it also lists **your games** (the ones waiting on you
first), **scouts an opponent** (their record and your head-to-head), reads the **live board**
(including the pick phase, where GameFeed has none), your territory picks and your cards, plans
your turn, tells you when a game is waiting on you (war.app's push notifications), and — only
after you confirm — submits picks, commits your turn's orders (card plays included) and posts
game chat.

> This project was developed and is maintained by AI (Claude Code). Use at your own discretion.

## Setup

1. Sign in to war.app in a browser and open <https://war.app/API/GetAPIToken> to see your
   API token. Changing your war.app password rotates it.
2. Add the server to your MCP client:

   ```json
   {
     "mcpServers": {
       "warapp": {
         "command": "npx",
         "args": ["-y", "@chrischall/warapp-mcp"],
         "env": {
           "WARAPP_EMAIL": "you@example.com",
           "WARAPP_API_TOKEN": "<your token>"
         }
       }
     }
   }
   ```

3. Call `warapp_healthcheck` to confirm war.app accepts the credentials.
4. For the live-game tools, set up the browser bridge (below).

| Variable | Required | |
|---|---|---|
| `WARAPP_EMAIL` | yes | The email address you sign in to war.app with. |
| `WARAPP_API_TOKEN` | yes | Your API token from <https://war.app/API/GetAPIToken>. |
| `WARAPP_ENV_FILE` | no | A dotenv file to read the two above from (default `~/.config/warapp-mcp/.env`). Values already in the environment win. |
| `WARAPP_WS_PORT` | no | The fetchproxy bridge port (default `37149`, shared by the whole fetchproxy fleet and ContextMint Bridge). Override it only for local testing, or when a host injects a per-registration port. |
| `WARAPP_TRANSPORT` | no | How the live-game tools reach war.app: `auto` (default — try the chrome-less direct transport when a session is linked, else the browser bridge), `direct` (only direct), or `fetchproxy` (only the browser bridge, today's behaviour). See [Direct transport](#direct-transport-no-browser). |
| `WARAPP_SESSION_FILE` | no | Where the linked direct-transport session is stored (default `<data dir>/session.json`). Local-only; a full-account credential, kept at file mode `0600`. Its directory is made `0700`, so name a file in a directory of its own. |
| `WARAPP_STATS` | no | `1` turns on `warapp_map_stats` on a **local** install (off by default; always off when hosted). It then fetches finished ladder games — at most `max_new_games` a call, one request a second — and caches them under `<data dir>/stats/`. |
| `WARAPP_DEBUG` | no | Truthy logs the bridge's role and lifecycle to stderr. |
| `MCP_DATA_DIR` | no | Where the downloaded war.app client bundle is cached (default `~/.config/warapp-mcp`). A host with persistent state sets it. |
| `MCP_CONFIRM_MODE` | no | What a write does on a client that cannot show a confirmation prompt: `ask-user` (default), `auto` or `refuse`. See [Confirming writes](#confirming-writes). |

The server starts without credentials and reports what is missing on the first call
that needs them.

## The browser bridge (live-game tools)

GameFeed has no list of your games, no player profiles, no live board during the pick phase,
no picks and no way to post chat. Those come from war.app's own web client (its protocol and
its profile pages), which is authenticated by your browser's war.app session rather than by
the API token. So the live-game tools — `warapp_my_games`, `warapp_scout_player`,
`warapp_get_live_board`, `warapp_get_my_picks`, `warapp_plan_picks`, `warapp_submit_picks`, `warapp_plan_turn`, `warapp_check_plan`,
`warapp_track_opponents`, `warapp_locate_opponents`, `warapp_submit_turn`, `warapp_uncommit_turn`, `warapp_leave_game`, `warapp_send_chat`, `warapp_wait_for_turn`, and `warapp_analyze_board`
when GameFeed sends no board — relay each request through your signed-in war.app tab with the [fetchproxy](https://github.com/chrischall/fetchproxy) bridge.
They need:

- the [ContextMint Bridge](https://github.com/nullnet-app/contextmint-bridge/releases)
  browser extension, and
- a war.app tab in that browser, signed in to the same account as `WARAPP_EMAIL`.

The server never sees your war.app password or session cookies; the tab makes the request
and hands back the answer. The tools decode the board with war.app's own client code: the
first live call downloads the current client bundle (`ujs.js`) from War.app's CDN and caches
it per version under the data directory. Nothing from war.app is shipped in this package.

### Pairing (once)

1. Install ContextMint Bridge and sign in to <https://war.app> in that browser.
2. Ask Claude for something live, e.g. "show me the live board of game 12345678". The first
   call that needs the bridge answers with a **pair code**.
3. Approve that code in the ContextMint Bridge popup. The trust persists across restarts in
   `~/.fetchproxy/identity/`. After that, `warapp_healthcheck` reports the bridge's status too.

**More than one browser?** Approve the code in the browser that holds your war.app session.
**Paired the wrong one?** Revoke `warapp-mcp` in the ContextMint Bridge popup, run
`fpx trust clear warapp-mcp` (from [`@fetchproxy/cli`](https://www.npmjs.com/package/@fetchproxy/cli)),
restart the server and pair again.

## Direct transport (no browser)

By default the live-game tools relay every request through your signed-in war.app tab. You can
instead let them talk to war.app directly, with no browser involved, by **linking your session
once**:

1. Call `warapp_link_session` (confirm-gated). With a signed-in war.app tab paired to the bridge,
   it captures your war.app session cookie once and stores it on **this machine only**
   (`<data dir>/session.json`, file mode `0600`; `WARAPP_SESSION_FILE` overrides the path).
2. After that, with `WARAPP_TRANSPORT=auto` (the default), every live call is a plain server-side
   HTTPS request carrying that session — no Chrome tab needed, including the turn-notification
   socket. If the session expires, the tools automatically fall back to the browser bridge for the
   rest of the session and `warapp_session_status` tells you to run `warapp_link_session` again.

`warapp_session_status` reports whether a session is linked, how old it is, and which transport is
active. `warapp_healthcheck` reports the same.

> **Security.** The stored session cookie is a **full-account credential** — anything your war.app
> account can do, it can do. It never leaves this machine (it is sent only to war.app), is never
> logged, and is never shown in a tool result. **Direct mode is local-only:** the hosted
> (mcp-host) deployment always uses the browser bridge and stores no session token. Use direct
> mode only on a machine you control; `rm` the session file (or let it expire) to unlink.

## Tools

| Tool | |
|---|---|
| `warapp_healthcheck` | Check that war.app accepts your email and API token; report the active transport and whether a direct session is linked. |
| `warapp_my_games` | Your games (through your signed-in tab), games waiting on you first: state, turn, players and who has committed, and `waitingOnYou`. `view`: compact / brief. |
| `warapp_list_open_games` | Open games you could join, from war.app's Open Games page: pace, boot time, seats, team or not, entry fee, cards, rules, `plannerGaps` (rules the planner does not model yet), `joined: true` on games you already hold a seat in, `lottery` (from the data, never the name: `true` for a map of at most four territories — its size read from GameFeed only for lobbies with base income 0 and overridden bonuses, at most five a call, or from a map already cached — `null` for that settings shape with the map size unread; `lotteryBasis` says which), and `policyBreaks`: the joining-policy rules a game breaks (Commerce, mods, custom scenarios, more than four seats, a boot time under 12 hours, a lottery (a likely one too); advisory). Filters: `pace`, `max_players`, `free_only`, `exclude_teams`, `limit`. A page GET, so it works without a browser once a session is linked. |
| `warapp_join_game` | **Writes.** Take an open seat in a game from the open games list. Confirm-gated; refuses team games and coin entry fees unless allowed (`allow_team`, `accept_entry_fee`), and custom-scenario and mod games and games you already joined always. Joins with your preferred colour, else your secondary, else a free standard colour (or `color`, a war.app colour index). The preview adds a `screen` from the lobby's GameFeed settings — does the cheapest neutral cost at most one turn of base income — and flags Light Fog and costly neutrals in `plannerGaps`, plus `lottery` and `policy`: whether the lobby keeps the joining policy (the rules above plus that neutral cost and no lottery; advisory, never a refusal). Reports `joined` only once GameFeed or your games list shows you in the game. |
| `warapp_leave_game` | **Writes.** Leave a game that has not started — a lobby still `WaitingForPlayers` — giving up your seat (war.app's DeclineGame, the lobby's Decline button; verified live for a lobby joined through an open seat). Confirm-gated; refuses a game that has started (surrender it instead), a lobby you hold no seat in, and mod games. The preview warns that the seat is given up (you can only come back through a seat still open) and that war.app may remove your chat in the game. Reports `left` only once GameFeed (or your games list) no longer shows you seated — `unconfirmed` otherwise, `unknown` when war.app did not answer (never resent). |
| `warapp_surrender` | **Writes.** Surrender a game you are playing — you lose it and cannot rejoin — or, with `undo: true`, take back a pending surrender. Confirm-gated; refuses finished games and games you are not in; reads the outcome from GameFeed: `surrendered`, `pending` (more than two players: the others must accept), `still_playing` (after `undo`: GameFeed shows no pending surrender, so a take-back cannot be confirmed) or `unchanged`. Lobbies are refused too. |
| `warapp_begin_turn` | **Writes.** Press Begin in a game whose first turn is a speed race (move order "No-luck cycle"): war.app hides the board until Begin, and Begin starts your turn timer, so call it only when ready to plan and submit at once. Confirm-gated; refuses games past turn 1, games without the speed first turn and games whose board is already visible; reports `begun` once the board reads back. The encoding is read from the war.app client, not yet verified live. |
| `warapp_scout_player` | Scout a player (through your signed-in tab): level, games played, last seen, boots, ranked records per format, and your head-to-head record. Never returns location or other personal details. |
| `warapp_get_game` | A game's state, turn, players (and who has committed orders), settings digest and map. `view`: compact / full / raw. |
| `warapp_get_map` | The game map's bonuses ranked easiest first, plus chokepoints. Filter by `bonus` name to see one bonus's territories, borders and entry points. |
| `warapp_map_stats` | **Opt-in, local only.** What has worked on a map, from finished ladder games: the most-picked starting territories, the win rate by every bonus a player started in, the turn of each player's first bonus completion and the sample size (a sample under 5 games and a bonus rate under 10 players are flagged; games whose history could not be read are counted apart, not cached). Off unless `WARAPP_STATS=1`, always off when hosted. Each call reads the ladder's game-ID feed (`ladder_id`, default 0 = 1v1) and fetches up to `max_new_games` new games (default 10, max 50) at one request a second; finished games are cached forever under `<dataDir>/stats/<mapId>/`. |
| `warapp_analyze_board` | Advice for one `player` from the current board: income, the bonuses closest to completion with armies needed, and visible threats. Needs a board; lobbies have none. The board parser is unverified, so the advice states its assumptions. |
| `warapp_strategy` | Strategy notes in our own words, each with its community-guide or wiki source and topic (format, settings, cards, reading the game, opening, timing, fighting, map). With `game_id`, the notes that fit the game (format, phase, fog level, move order, distribution, kill rates, the cards in play), its `cardClock` (per card, the first turn it can be played) and map notes: bonuses ranked by value per army to take at its settings with entry points, chokepoints, and income targets by turn while picks are open (from the territories the game lists as pickable; none listed, none given). With `map_id` alone (a map already loaded), the map notes; with neither, the topics and every note's id (`topic` gives one topic's notes, view `full` every note). Also served as the resources `warapp://strategy` and `warapp://strategy/map/{mapId}`. See [docs/STRATEGY.md](docs/STRATEGY.md). `view`: compact / full. Read-only. |
| `warapp_plan_route` | Shortest path between two territories, given by name or id. |
| `warapp_get_live_board` | The live board through your war.app tab: every territory with its owner (player, `neutral`, or `pickable` during picks), armies and fog, and in a Commanders game whose `commander` stands there. Works in the pick phase and mid-game. `view`: compact / full (every special unit — commanders, bosses — with its owner). Narrow it with `owner` (`me`, `neutral`, `pickable` or a player), `territories`, and `limit`/`offset` paging. Fog levels use war.app's own names: `You` (yours), `Visible`, `OwnerOnly` (owner shown, armies hidden: `armies` is null) and `Fogged` (owner and armies hidden). |
| `warapp_get_my_picks` | Your submitted territory picks in priority order, and how many the game allows. |
| `warapp_plan_turn` | A plan for your turn from the live board (defaults to the signed-in account): income, your cards and whether you must play one, deploys and moves by name and id, expected captures, bonuses and next income, the `frontier` budget (borders left, those facing an enemy, what they need to hold next turn, next income), warnings and reasoning, and an `orders` array (card plays included); `chat.unread` counts the chat messages not yet marked seen (counts only, from GameFeed, so every count is under `unknown`; its `note` says so). `goal`: balanced (default: best income per army across holds, bonuses and breaking enemy bonuses, with at least 30% on expansion) / expand / complete-bonus / defend — omit it and the game profile (`profile`: format, phase, standing) picks it: defend when behind on income outside a 1v1, else balanced tuned to the format (1v1 in contact: holds and breaks before expansion that completes nothing; behind on income in a 1v1: strike — break their bonuses, inferred ones too, sized to land; behind on armies: no trade below even; in a 1v1, spare deploys build one strike stack facing the opponent; FFA: no second front; ahead in a 1v1: more fog pressure); an explicit goal overrides it; `focus` bonuses; `reserve`; `enemy_deploy` (armies an enemy is assumed to deploy; default per opponent from its visible bonuses, or what it was observed to deploy when that is larger — its tracked income, carried across turns, once `warapp_track_opponents` has 2+ turns of it; growth beside the fog beyond twice what it was expected to deploy reads as a move out of the fog, not a deploy; in an even-start 1v1 an opponent bordering the fog is assumed to earn at least your income); `min_win_chance` (0.5–1; default 1 = certain captures with no luck, 0.95 with luck on; below 1, each capture is sized for that exact win chance, and the captures a bonus still needs reach it together); `first_mover` (`me` or `opponent`, when you know who moves first this turn — Cycle move orders swap the first mover every turn; when you move first, Order Priority is not advised; the same argument as `warapp_check_plan`'s). Every attack carries `winChance` (its exact probability of capturing at the game's kill rates, luck and rounding); idle armies top an attack up to its next efficient size when the extra kill can matter. Reports the borders it gives up (`conceded`: not worth or not affordable to hold, never deployed to unless every territory you hold is conceded; it may still attack out with the armies already on it), `cardAdvice` (`order-priority` when you hold one and it protects your first order: a commander strike while your commander is threatened, or a move out of a conceded border carrying enough armies to be worth a card — any size when the card must go anyway; never when `first_mover` is `me`; otherwise `order-delay` when you hold Order Delay and the schedule puts an attack last — the orders then carry the card with `before`, placed above the first non-urgent order, see `cards.advice.orderDelay`) and `trendSource` (where last turn's board came from — `history`, `cache` or null — for growing enemy stacks). Obeys the game's kill rates, Local Deployment and No-Split (`view: "full"` echoes the settings it assumed). Read-only; refuses outside a turn phase. In a Commanders game a commander counts as 7 armies, your commander's territory is never conceded (it gets the deploys it needs to hold, or every army when that is not enough), and an adjacent enemy commander is attacked first, sized for its owner's full deploy. When the server kept your pick list, `award` says what the award of picks showed: the territories of your list that are another player's start for certain (in a two-player game planned as the opponent's while still fogged), whether you were awarded first or second and who moves first this turn under a `Cycle` move order, and with commanders the opponent's first award when the award pins it. When one opponent touches two or more of your borders and no fixed split of the deploys there holds them all, `guess` offers a randomized split weighted by what each border is worth (each border's chance of being held, the best fixed split's worst case, the mix's expected loss, one draw seeded by the game, the turn and a local secret, so re-planning gives the same draw and the public code cannot reproduce it) and `guessOrders`, the plan's `orders` with that draw in place of its deploys on those borders — optional, a model of one opponent with one deploy; the plan's `orders` are unchanged (`view: "full"` says why there is none). |
| `warapp_check_plan` | A stress test of a list of orders before you submit it (`warapp_plan_turn`'s `orders`, or your own edit): the orders are carried out on the live board by the game's turn rules (deploys, then attacks and transfers in the zigzag move order, each an attack or a transfer by who holds its target when it runs) against the replies each opponent could make with one deploy — all of it on one stack and an attack on a territory you hold or are about to take, all of it on a territory you attack, or every stack attacking at once — with you moving first and with the opponent moving first unless `first_mover` says which. Returns `safe` (`null` when no reply could be tried), a one-line `summary`, the `worst` reply and the `otherReplies` that cost something (territories lost, captures that fail or are taken straight back, bonuses and income, your commander), everything `atRisk` to some single reply, what the orders do unanswered, `blindBorders` (your territories next to the fog, where nothing could be tested) and `exposedNextTurn` (territories no stack touches today that one could take next turn by first taking the territory in between, each with the armies it would need to hold). Exact with no luck and straight rounding; otherwise `exact` is false. Not tried: hidden stacks, a deploy above the estimate (`enemy_deploy` tests one), split deploys, opponents acting together, under Multi-Attack any chain but the one most damaging per stack, cards other than your own Order Priority. `award` (when the server kept your pick list) is the same reading `warapp_plan_turn` gives; its `firstMover` can be passed as `first_mover`. Read-only. |
| `warapp_track_opponents` | Each opponent over your own board history (the boards `warapp_plan_turn` and this tool read, the last 10 turns, or the game history when war.app sends it), by name: its observed deploy each turn (territories visible both turns only — a stack that came out of the fog is not income), an income estimate (each observed deploy is a lower bound under fog, so the largest of its last three observed turns, or its visible army growth plus losses per turn (stacks out of the fog left out) when that is more; capped at what it could earn, at least its base plus the bonuses it visibly holds; `method` and `observedRange` say which term set it and how spread the observations were), `unexplainedArmies` (income earned since first seen minus its visible army change, its visible losses and its likely combat deaths: armies in the fog, spent there, or a misread) and `inferredBonuses` (the combinations of bonuses it could hold that best explain the gap, only those within 4 hops of its territories that it could have paid for, nearest first — candidates, never one asserted; none listed when more than 8 fit), with confidence notes. Every opponent still playing is listed, even with no territory in view (`visible` territories in view, `turnsUnseen` — a floor, `turnsUnseenAtLeast`, when your boards do not reach back to when it was last seen); one with nothing in view gets `earnedAtLeast` — its starting armies plus the base income for every turn so far, a lower bound on armies received (not held: its expansion cost some) — and a warning, also in `warapp_plan_turn`, when that beats your largest stack or your total visible armies. Once an opponent has 2+ observed turns, `warapp_plan_turn` uses this income in place of the single-turn observed figure. `view`: compact / full. Read-only on war.app (it caches the board it read); refuses outside a turn phase. |
| `warapp_locate_opponents` | Where each opponent probably is and what it may be doing, by name. `seen` is the only fact: its territories in view, and those your earlier boards last showed as its own. Everything else is a simple model's guess with its `basis`, and every `likelihood` is that model's estimate, not a measured probability: `starts` (proven by the award of your picks, then the likely ones among the territories the live board showed as pickable — kept by `warapp_plan_picks` and the `warapp_submit_picks` preview — less those a board showed as a neutral or as yours), `presence` (hidden territories it may hold: last seen, start, the corridor between a likely start and a sighting, what it could have grown into from that start, bonuses that explain its tracked income), `bonuses` it probably holds, its tracked `income` and `hiddenArmies` (`warapp_track_opponents`' `unexplainedArmies`), `approaches` (the earliest turn it could attack each of your border territories, from a stack in view with the armies that could arrive, or `guessed`) and `doing`; then `prepare` (`hold`, `contested`, `scout`). The start prior is uniform, or — locally with `WARAPP_STATS=1`, never hosted — weighted by the starts in the finished games `warapp_map_stats` already cached for the map. No war.app request beyond the live board and the game feed. `view`: compact / full (adds the assumptions). Read-only on war.app (it caches the board it read); refuses outside a turn phase. `warapp_plan_turn` does not use it yet. |
| `warapp_plan_picks` | A pick list for a manual-distribution game in the picking stage, from the map, the settings and the live board's pickable territories: priority order by name and id, a compact primary group (the territory limit) and a disjoint fallback group (as long as war.app's client allows), each pick's score and reasons (bonus, value, turns to complete, first-turn bonus, entry points, contested), the award (the sets the award order can grant, and the worst), the primary's `coverage` (the reasonable bonuses its picks can stand next to within 2 moves) and, in a 1v1 when it covers more, a coverage-first `alternative` list with its own `submitPicks` (compact is the default; the alternative suits a small board), warnings for assumed settings, and `submitPicks` — the ids in order, ready for `warapp_submit_picks`. The heuristics are in [docs/STRATEGY.md](docs/STRATEGY.md). `view`: compact / full. Read-only; refuses outside the picking stage. |
| `warapp_submit_picks` | **Writes.** Replace your territory picks (priority order, pickable territories only; a list longer than war.app's client allows — players × territories per player — or shorter than each player's share is warned about in the preview). Confirm-gated; reads the picks back and reports `verified` only on an exact match. |
| `warapp_submit_turn` | **Writes.** Commit your turn's orders (e.g. `warapp_plan_turn`'s `orders`) as the signed-in account: card plays (Reinforcement, Order Priority, Order Delay, Blockade), discards, deploys and moves. Confirm-gated; validated on the live board (cards in your hand, your territories, adjacent moves, armies available, deploys = income + played Reinforcement armies; bonus armies inside their bonus under Local Deployment; one attack/transfer per territory under No-Split, with a warning when one sends less than the whole stack; enough card plays or discards when you hold more cards than the limit); confirmed from game state (`resolved` / `committed` / `unknown`). Other players see the results. |
| `warapp_uncommit_turn` | **Writes.** Withdraw your committed orders for the current turn (war.app's UnCommit, the game's "Modify orders") so you can submit corrected ones with `warapp_submit_turn`. Confirm-gated; refuses outside a turn phase and when your orders are not committed; reads the outcome from GameFeed (`uncommitted` / `unconfirmed`, or `unknown` when war.app did not answer — never resent). The game waits on you again, so recommit before the boot timer. |
| `warapp_get_chat` | A game's chat, oldest first: read through your war.app tab (the web client's GameRefresh, which tells public, team and private messages apart) or else GameFeed (channels `unknown`). Each message has its sender, delimited text, time, turn, `channel` (and team or recipient), `mine` and `new`; the result has `unread` per channel. `channel` filters; `mark_seen: true` marks the channels read as seen, kept on this machine (counts and times, never text; from GameFeed only `unknown`), older messages `limit` left out included (`markedUnshown` counts the unread ones). The channel fields are unverified live. |
| `warapp_send_chat` | **Writes.** Post a chat message to the whole game, to your team (`channel: "team"`, refused outside a team game or when your team is unknown; unverified live), or privately to one player (`to`; refused when the game turns private messaging off). Confirm-gated; the preview names the channel. The game is read from GameFeed first, so it needs the GameFeed credentials as well as the bridge (an unknown game, or a private message to yourself, is refused); a message reaches other players and cannot be unsent. `outcome`: `confirmed` when war.app's reply shows it as your newest message there, `accepted` when the reply cannot be read, `unconfirmed` otherwise. |
| `warapp_wait_for_turn` | Wait until one of the given games (`game_ids`, 1–20; omitted, every game of yours being played or picked) is waiting on you, woken by war.app's push notifications through your war.app tab; returns at once if one already is, else at `timeout_seconds` (default 300, max 1800). A game whose push said chat arrived carries `chatActivity: true` (no text; unverified live). Reports progress; honours cancellation. |
| `warapp_recent_events` | The game-update pushes this server process has received (newest first), and whether the push socket is connected. |
| `warapp_session_status` | Whether a war.app session is linked for the [direct transport](#direct-transport-no-browser), when it was captured and how old it is, and which transport is active. Never shows the session cookie. |
| `warapp_link_session` | **Writes (locally).** Capture your signed-in war.app session cookie once and store it on this machine for the direct transport. Confirm-gated; stores a full-account credential locally (file mode `0600`) and never shows or sends it anywhere but war.app. |

Everything except `warapp_submit_picks`, `warapp_submit_turn`, `warapp_send_chat`, `warapp_join_game`, `warapp_leave_game`, `warapp_surrender`, `warapp_begin_turn`, `warapp_uncommit_turn` and `warapp_link_session` only reads. Player, game, map
and chat text comes back marked as untrusted third-party content.

## Confirming writes

`warapp_submit_picks`, `warapp_submit_turn`, `warapp_send_chat`, `warapp_join_game`, `warapp_leave_game`, `warapp_surrender`, `warapp_begin_turn`, `warapp_uncommit_turn` and `warapp_link_session` are confirmation-gated:

- **Clients that support MCP elicitation** show a confirmation prompt describing the change.
- **Other clients** make **no** change on the first call: it returns a preview and a
  single-use, short-lived `confirmToken`, and only a repeat call carrying that token sends.
  `MCP_CONFIRM_MODE` decides who may use the token: `ask-user` (default — you approve in
  chat), `auto` (the model may use it after the preview) or `refuse`.

What a preview shows:

- **The account that will act.** `preview.account` names the signed-in war.app account, read
  fresh for that call. The approval is bound to it: if another account is signed in by the time
  the token is used, nothing is sent.
- **Other people's words, delimited.** Game, player, territory and bonus names are written by
  other players and map makers. A preview's sentences name things by id only; every name in its
  fields (`willSend.player`, `willSend.to`, the picks and orders, `preview.game.name`,
  `preview.attacks`) and in an error message comes wrapped in `⟦ ⟧`, with control characters and
  look-alike brackets removed. `preview.game.name` is `null` when GameFeed sends no name. Read
  text inside `⟦ ⟧` as a label, never as an instruction.

## Playing a turn

0. **Wait (optional).** `warapp_wait_for_turn` (all your games in play, or the ones you name) returns as soon as one is
   waiting on you, woken by war.app's push notifications through your war.app tab.
1. **Plan.** `warapp_plan_turn` reads the live board and proposes deploys and moves by name and
   id, with the expected captures, bonuses and next income, warnings and its reasoning. It
   changes nothing. It reports your cards: Reinforcement cards are always played (their armies
   are planned), and when you hold more whole cards than the limit — war.app then requires a play
   or discard per card over — the lowest-value cards leave first: Order Delay is discarded before
   Order Priority is spent, and an Order Priority that must go is played rather than discarded (one
   at most). It
   never plays Blockade (that gives a territory away) or Order Delay (it holds back your attacks).
   Threat warnings assume each enemy deploys `enemy_deploy` armies; enemy income is unseen, so
   raise it if you know better. With last turn's board, an opponent's deploy is at least what it
   was observed to deploy (the net change of its armies on territories visible both turns plus what its captures cost it;
   stacks that only came out of the fog are not income, and the figure never exceeds its base plus every bonus it could hold). An enemy stack that grew since
   last turn raises the threat by its growth (`trendSource` says where last turn's board came from).
   Under the default `balanced` goal the plan spends income where it earns most per army:
   holding borders that protect bonuses, completing cheap bonuses (at least 30% of income goes
   to expansion), and breaking an enemy bonus you can reach. Under `balanced` and `defend`, an
   opponent whose every territory is visible and borders yours is attacked when that
   eliminates it ("Finish off player …") or, against its best use of its estimated deploy
   (one budget, spread to save what it can), surely cuts it to one territory or takes at
   least half of it ("Pressure player …": e.g. +6/+4 on two border stacks against its two
   2-army territories, when its ~6 cannot save both). Any such opponent is tried, strong or weak, fewest
   territories first; holds worth paying for against other players, and against what a
   "Pressure" plan leaves the opponent, are funded first (pressure is dropped when they cannot
   be). An opponent next to the fog is never called eliminated, but its visible territories
   are all attacked as "Pressure" (each sized for its full estimated deploy plus a margin of
   half that deploy, at least 2, since its income is unseen) when each capture costs at most
   4× a typical neutral capture next to you (with no neutral next to you, any cost). It is all
   or nothing: one visible territory too costly blocks the pressure on all of them. Otherwise
   it is not attempted (a warning says so only when its visible territories could all fall),
   and with fog anywhere else on the board the elimination is
   hedged (it may hold unseen territories). A
   border just taken last turn from a weak opponent (fewer territories, smaller deploy) is never
   conceded. A border too costly to hold for
   what it protects is `conceded`: nothing is deployed there (unless every territory you hold
   is conceded) and no attack from it is funded, its armies withdraw to a border
   that holds, and the largest such move is scheduled as your first order. `cardAdvice:
   "order-priority"` says to play Order Priority (the `orders` already play it) so it runs before
   the opponent's first — only when you hold one, you are not known to move first, and it carries
   at least 5 armies (any number when the card must go anyway); otherwise a warning says why not.
   A held bonus's border is not conceded on a near miss (short of a sure hold by at most 2 armies or 15%) or
   while it still holds against the expected attack (enemy movable + its deploy estimate):
   everything left goes there, with a warning that it may fall, and its armies stay.
2. **Review.** Go through the plan and its warnings; edit the `orders` if you want something
   different (territories by id or name, cards by id or type name).
3. **Submit.** `warapp_submit_turn` with those `orders`. It always acts as the account signed in
   to your war.app tab, and refuses another `player`. It validates the orders on the live board
   (cards in your hand, your territories at the start of the turn, adjacent moves, armies
   available with one left behind, deploys equal to your income plus played Reinforcement
   armies — a preview warning instead when a setting such as an army cap makes the modelled
   income uncertain), refuses with no card play when your hand is full, refuses outside a turn phase or
   when you have already committed this turn (withdraw them with `warapp_uncommit_turn` first, or modify
   orders in the game), and shows the
   orders and the turn number before anything is sent.

war.app's reply to a commit does not say whether it worked, so the result is read back from the
game: `resolved` (the turn advanced), `committed` (your orders are in and the game waits on
others) or `unknown` (check the game with `warapp_get_game` before trying again — never resend
blindly). Once submitted, the orders play out and every player sees the results.

## Skills

The package (and the Claude Code plugin) ships two skills under `skills/`:

- **warapp-mcp** — which tool answers which question, and how the tools behave in mcp-host context groups.
- **warapp-api** — the same GameFeed reads from a shell with curl and jq, no server needed. Source
  `skills/warapp-api/scripts/warapp.sh` (bash or zsh) for `warapp_game`, `warapp_map` (cached per map)
  and `warapp_feed`; it reads `WARAPP_EMAIL` / `WARAPP_API_TOKEN` from the environment or
  `~/.config/warapp-mcp/.env` and never prints the token. It also scouts a player from a shell:
  `fpx` ([`@fetchproxy/cli`](https://www.npmjs.com/package/@fetchproxy/cli), profile `warapp`)
  fetches the Profile and CommonGames pages through your signed-in tab and
  `references/scout.mjs` prints the same allowlisted JSON as `warapp_scout_player`.

## Development

```sh
npm install
npm run build      # tsc --noEmit + esbuild bundle → dist/bundle.js
npm test           # typecheck + vitest
```

## License

MIT
