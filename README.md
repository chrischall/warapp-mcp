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
| `WARAPP_SESSION_FILE` | no | Where the linked direct-transport session is stored (default `<data dir>/session.json`). Local-only; a full-account credential, kept at file mode `0600`. |
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
`warapp_get_live_board`, `warapp_get_my_picks`, `warapp_submit_picks`, `warapp_plan_turn`,
`warapp_submit_turn`, `warapp_send_chat`, `warapp_wait_for_turn`, and `warapp_analyze_board`
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
| `warapp_list_open_games` | Open games you could join, from war.app's Open Games page: pace, boot time, seats, team or not, entry fee, cards, rules, and `plannerGaps` (rules the planner does not model yet). Filters: `pace`, `max_players`, `free_only`, `exclude_teams`, `limit`. A page GET, so it works without a browser once a session is linked. |
| `warapp_join_game` | **Writes.** Take an open seat in a game from the open games list. Confirm-gated; refuses team games and coin entry fees unless allowed (`allow_team`, `accept_entry_fee`), and custom-scenario and mod games always. Reports `joined` only once GameFeed or your games list shows you in the game. |
| `warapp_surrender` | **Writes.** Surrender a game you are playing — you lose it and cannot rejoin — or, with `undo: true`, take back a pending surrender. Confirm-gated; refuses finished games and games you are not in; reads the outcome from GameFeed: `surrendered`, `pending` (more than two players: the others must accept), `taken_back` or `unchanged`. |
| `warapp_scout_player` | Scout a player (through your signed-in tab): level, games played, last seen, boots, ranked records per format, and your head-to-head record. Never returns location or other personal details. |
| `warapp_get_game` | A game's state, turn, players (and who has committed orders), settings digest and map. `view`: compact / full / raw. |
| `warapp_get_map` | The game map's bonuses ranked easiest first, plus chokepoints. Filter by `bonus` name to see one bonus's territories, borders and entry points. |
| `warapp_analyze_board` | Advice for one `player` from the current board: income, the bonuses closest to completion with armies needed, and visible threats. Needs a board; lobbies have none. The board parser is unverified, so the advice states its assumptions. |
| `warapp_plan_route` | Shortest path between two territories, given by name or id. |
| `warapp_get_live_board` | The live board through your war.app tab: every territory with its owner (player, `neutral`, or `pickable` during picks), armies and fog. Works in the pick phase and mid-game. `view`: compact / full. |
| `warapp_get_my_picks` | Your submitted territory picks in priority order, and how many the game allows. |
| `warapp_plan_turn` | A plan for your turn from the live board (defaults to the signed-in account): income, your cards and whether you must play one, deploys and moves by name and id, expected captures, bonuses and next income, warnings and reasoning, and an `orders` array (card plays included). `goal`: balanced (default: best income per army across holds, bonuses and breaking enemy bonuses, with at least 30% on expansion) / expand / complete-bonus / defend; `focus` bonuses; `reserve`; `enemy_deploy` (armies an enemy is assumed to deploy; default from the largest visible enemy stack). Reports the borders it gives up (`conceded`: not worth or not affordable to hold, never deployed to unless every territory you hold is conceded; it may still attack out with the armies already on it), `cardAdvice` (`order-priority` when a withdrawal from a conceded border must run first) and `trendSource` (where last turn's board came from — `history`, `cache` or null — for growing enemy stacks). Read-only; refuses outside a turn phase. |
| `warapp_submit_picks` | **Writes.** Replace your territory picks (priority order, pickable territories only, at most twice the territory limit). Confirm-gated; reads the picks back and reports `verified` only on an exact match. |
| `warapp_submit_turn` | **Writes.** Commit your turn's orders (e.g. `warapp_plan_turn`'s `orders`) as the signed-in account: card plays (Reinforcement, Order Priority, Order Delay, Blockade), deploys and moves. Confirm-gated; validated on the live board (cards in your hand, your territories, adjacent moves, armies available, deploys = income + played Reinforcement armies; a card play when your hand is full); confirmed from game state (`resolved` / `committed` / `unknown`). Other players see the results. |
| `warapp_get_chat` | A game's chat, from GameFeed. |
| `warapp_send_chat` | **Writes.** Post a chat message to the whole game or privately to one player. Confirm-gated; a message reaches other players and cannot be unsent. |
| `warapp_wait_for_turn` | Wait until one of the given games (`game_ids`, 1–20; omitted, every game of yours being played or picked) is waiting on you, woken by war.app's push notifications through your war.app tab; returns at once if one already is, else at `timeout_seconds` (default 300, max 1800). Reports progress; honours cancellation. |
| `warapp_recent_events` | The game-update pushes this server process has received (newest first), and whether the push socket is connected. |
| `warapp_session_status` | Whether a war.app session is linked for the [direct transport](#direct-transport-no-browser), when it was captured and how old it is, and which transport is active. Never shows the session cookie. |
| `warapp_link_session` | **Writes (locally).** Capture your signed-in war.app session cookie once and store it on this machine for the direct transport. Confirm-gated; stores a full-account credential locally (file mode `0600`) and never shows or sends it anywhere but war.app. |

Everything except `warapp_submit_picks`, `warapp_submit_turn`, `warapp_send_chat`, `warapp_join_game` and `warapp_surrender` only reads. Player, game, map
and chat text comes back marked as untrusted third-party content.

## Confirming writes

`warapp_submit_picks`, `warapp_submit_turn`, `warapp_send_chat`, `warapp_join_game` and `warapp_surrender` are confirmation-gated:

- **Clients that support MCP elicitation** show a confirmation prompt describing the change.
- **Other clients** make **no** change on the first call: it returns a preview and a
  single-use, short-lived `confirmToken`, and only a repeat call carrying that token sends.
  `MCP_CONFIRM_MODE` decides who may use the token: `ask-user` (default — you approve in
  chat), `auto` (the model may use it after the preview) or `refuse`.

## Playing a turn

0. **Wait (optional).** `warapp_wait_for_turn` (all your games in play, or the ones you name) returns as soon as one is
   waiting on you, woken by war.app's push notifications through your war.app tab.
1. **Plan.** `warapp_plan_turn` reads the live board and proposes deploys and moves by name and
   id, with the expected captures, bonuses and next income, warnings and its reasoning. It
   changes nothing. It reports your cards: Reinforcement cards are always played (their armies
   are planned), and when your hand is at the hold limit — war.app then requires a play — it
   plays Order Priority or Order Delay. It never plays Blockade (that gives a territory away).
   Threat warnings assume each enemy deploys `enemy_deploy` armies; enemy income is unseen, so
   raise it if you know better. An enemy stack that grew since last turn raises the threat by
   its growth (`trendSource` says where last turn's board came from).
   Under the default `balanced` goal the plan spends income where it earns most per army:
   holding borders that protect bonuses, completing cheap bonuses (at least 30% of income goes
   to expansion), and breaking an enemy bonus you can reach. A border too costly to hold for
   what it protects is `conceded`: nothing is deployed there (unless every territory you hold
   is conceded) and no attack from it is funded, its armies withdraw to a border
   that holds, and `cardAdvice: "order-priority"` says to play Order Priority (add it to the
   `orders` if you hold one) so the withdrawal runs before the border falls.
2. **Review.** Go through the plan and its warnings; edit the `orders` if you want something
   different (territories by id or name, cards by id or type name).
3. **Submit.** `warapp_submit_turn` with those `orders`. It always acts as the account signed in
   to your war.app tab, and refuses another `player`. It validates the orders on the live board
   (cards in your hand, your territories at the start of the turn, adjacent moves, armies
   available with one left behind, deploys equal to your income plus played Reinforcement
   armies), refuses with no card play when your hand is full, refuses outside a turn phase or
   when you have already committed this turn (modify orders in the game instead), and shows the
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
