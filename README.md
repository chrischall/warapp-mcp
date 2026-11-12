# warapp-mcp

Read-only [war.app](https://war.app) (Warzone) game advisor MCP server for Claude. It reads
your games through war.app's per-player **GameFeed** API and helps you think about them:
players and settings, the map's bonuses and chokepoints, the board, and routes between
territories. It never submits orders.

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

| Variable | Required | |
|---|---|---|
| `WARAPP_EMAIL` | yes | The email address you sign in to war.app with. |
| `WARAPP_API_TOKEN` | yes | Your API token from <https://war.app/API/GetAPIToken>. |
| `WARAPP_ENV_FILE` | no | A dotenv file to read the two above from (default `~/.config/warapp-mcp/.env`). Values already in the environment win. |

The server starts without credentials and reports what is missing on the first call
that needs them.

## Tools

| Tool | |
|---|---|
| `warapp_healthcheck` | Check that war.app accepts your email and API token. |
| `warapp_get_game` | A game's state, turn, players (and who has committed orders), settings digest and map. `view`: compact / full / raw. |
| `warapp_get_map` | The game map's bonuses ranked easiest first, plus chokepoints. Filter by `bonus` name to see one bonus's territories, borders and entry points. |
| `warapp_analyze_board` | Advice for one `player` from the current board: income, the bonuses closest to completion with armies needed, and visible threats. Needs a board; lobbies have none. The board parser is unverified, so the advice states its assumptions. |
| `warapp_plan_route` | Shortest path between two territories, given by name or id. |

All tools are read-only. Player, game, map and chat text comes back marked as untrusted third-party content.

## Skills

The package (and the Claude Code plugin) ships two skills under `skills/`:

- **warapp-mcp** — which tool answers which question, and how the tools behave in mcp-host context groups.
- **warapp-api** — the same GameFeed reads from a shell with curl and jq, no server needed. Source
  `skills/warapp-api/scripts/warapp.sh` (bash or zsh) for `warapp_game`, `warapp_map` (cached per map)
  and `warapp_feed`; it reads `WARAPP_EMAIL` / `WARAPP_API_TOKEN` from the environment or
  `~/.config/warapp-mcp/.env` and never prints the token.

## Development

```sh
npm install
npm run build      # tsc --noEmit + esbuild bundle → dist/bundle.js
npm test           # typecheck + vitest
```

## License

MIT
