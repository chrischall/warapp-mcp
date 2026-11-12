# warapp-mcp — build plan (phase 1: advisor, no order submission)

Repo: `~/git/warapp-mcp` (local git, branch `main`, NO remote yet — do not create one, do not push).
npm name `@chrischall/warapp-mcp`, bin `warapp-mcp`, registry name `io.github.chrischall/warapp-mcp`,
tool prefix `warapp_`. Sibling to copy skeleton/packaging from: `~/git/workvivo-mcp`
(read through `git -C ~/git/workvivo-mcp show origin/main:<path>` — not the working tree).
Deps: `@chrischall/mcp-utils ^3.8.1`, `@modelcontextprotocol/server ^2.4.0`, `zod ^4.6.7`,
`dotenv`; `@fetchproxy/server ^3.8.0` is NOT added in phase 1.

## Facts (live-verified 2026-11-12)

- API: `POST https://war.app/API/GameFeed?GameID=<n>` with form body `Email=<email>&APIToken=<token>`
  (application/x-www-form-urlencoded). Optional query: `GetHistory=true`, `GetSettings=true`,
  `GetChat=true`, `GetMap=false`.
- Errors come back as HTTP 200 JSON `{"termsOfUse": "...", "error": "..."}`:
  bad token → `"Auth failed"`; unknown game → `"Loading the game produced an error: ServerGameKeyNotFound"`;
  non-int id → `"GameID must be an integer"`. Validate GameID locally as a positive integer < 2^31.
- EVERY scalar is a STRING (`"numberOfTurns": "-1"`, `"isAI": "False"`, territory `"id": "1"`,
  bonus `"value": "6"`); `connectedTo` / `territoryIDs` are number arrays. Normalize to real types.
- Bonuses can contain OTHER BONUSES (ids in `territoryIDs` that are bonus ids, not territory ids —
  superbonuses). Some bonuses have value 0 or negative.
- Lobby fixture: `tests/fixtures/gamefeed-lobby-map39905.json` (anonymized, `GetSettings=true`),
  761 territories, 372 bonuses, symmetric graph, state `WaitingForPlayers`, no standings.
- The ToS asks callers to cache: map data is immutable per map id — cache it in memory per
  process (and do not re-fetch the map when cached: pass `GetMap=false`).
- UNVERIFIED (doc-derived): in-progress board state. Docs: a "standing" has one entry per
  territory with armies, owner and fog level; `GetHistory` returns turns "assuming it's
  finished". The live in-progress shape is NOT known — parse standings LOOSELY (zod passthrough,
  tolerate absence), mark it unverified in docs/WARAPP-API.md, and keep the analysis core fed by a
  source-agnostic `BoardState` type so a browser-tab source can be added later.
- Credentials: env `WARAPP_EMAIL`, `WARAPP_API_TOKEN` (deferred-config: server boots without them;
  read with `requireEnvVar` inside try/catch; token `{ trim: false }` not needed — it's hex).
  Optional `WARAPP_ENV_FILE` / default `~/.config/warapp-mcp/.env` loaded via `loadDotenvSafely`.
  Register the token with the redactor (`redactValues`) so no error ever echoes it.

## Tasks

### T1 — Scaffold + packaging
Copy workvivo-mcp's skeleton shape: package.json (scoped name, `repository.url`
`git+https://github.com/chrischall/warapp-mcp.git`, `publishConfig.access: public`, `files`
incl. `dist`, `skills`, `mint.yaml`, `.claude-plugin`, `manifest.json`, `server.json`, `.mcp.json`,
`allowScripts: {esbuild:false, fsevents:false}`, scripts build/test/test:coverage/typecheck),
tsconfig.json (rootDir src, types node), tsconfig.test.json, vitest config, `.gitignore`
(incl coverage/, .env*), `.mcpbignore`, `src/version.ts` (`0.0.0` + release-please marker),
`.github/workflows/*` stubs + `dependabot.yml` copied from workvivo origin/main verbatim,
`release-please-config.json` (`initial-version: 0.1.0`, `bump-minor-pre-major: true`, extra-files
for every version file) + `.release-please-manifest.json` `0.0.0`, `manifest.json`, `server.json`
(description ≤100 chars, neutral), `.claude-plugin/plugin.json` + `marketplace.json`, `.mcp.json`,
`mint.yaml` (env WARAPP_EMAIL secret required, WARAPP_API_TOKEN secret required — prefer
`identity.perUserChild: true` + `auth.fields` for both since they are a person's credentials;
egress `war.app`), README.md, CLAUDE.md (repo-specific only), a minimal `src/index.ts` running
`runMcp` with only the healthcheck. Tests: `versionSyncTest`, `tests/packaging.test.ts`
(repository.url, scoped name, access public, files ⊇ skills+mint.yaml), server-boot smoke test.
`npm install && npm run build && npm test && npm run typecheck` green. Commit.

### T2 — API client
`src/client.ts`: `WarappClient` with deferred config, `getGame(id, {history, settings, chat})`
→ normalized `Game` (typed players/state/settings, `map` from cache or fetched), error mapping:
`Auth failed` → `McpToolError` kind auth with hint (regenerate token at
https://war.app/API/GetAPIToken while signed in; changing password rotates it); not-found →
not_found; other `error` strings → upstream error (redacted). Use `createApiClient` (form body,
timeout, retry on 429/5xx) and `parseJsonBody`. Map cache per map id. Normalizers in
`src/normalize.ts` (string→number/bool, superbonus split into `territoryIds` vs `bonusIds`).
`src/board.ts`: `BoardState` type + `boardFromStanding(raw)` loose parser (unverified).
`registerCredentialHealthcheckTool` (prefix `warapp`, probe = GameFeed of a nonexistent id
expecting the not-found error → healthy; `Auth failed` → rejected; skipped without creds).
TDD with the lobby fixture and stubbed fetch. Write `docs/WARAPP-API.md` (verified vs unverified).

### T3 — Map analysis core (pure)
`src/analysis/`: graph from map; per-bonus: territories (flattening superbonuses), value,
border territories (in bonus, adjacent to outside), entry points (outside neighbours),
`valuePerTerritory`, `valuePerBorder`, ranked "easiest bonuses" score; chokepoints (articulation
points + low-degree bridges between bonus clusters); BFS shortest path / distance. With a
`BoardState` + player id: my income (base + held bonuses), bonuses I'm closest to completing
(missing territories, armies needed vs visible neutral/enemy counts using offensive kill rate
from settings, straight-round), visible threats (enemy armies adjacent to my borders).
All pure + deterministic; tests on the fixture plus small hand-built graphs.

### T4 — MCP tools
`warapp_get_game` (summary: state, turn, players + committed flags, settings digest; `view`
compact/full/raw, compact default; `untrustedResult` since names/messages are third-party text),
`warapp_get_map` (bonus table + chokepoints, compact by default, filter by bonus name),
`warapp_analyze_board` (needs a standing — returns a clear "board state not available from the
API for this game yet" error when absent), `warapp_plan_route` (path between two territories by
name or id). All read-only, annotated via `toolAnnotations({readOnly:true})`, `openWorldHint`,
`_meta.mint` hints (domain `work`, intent `lookup`, no canonical), descriptions written for
search. Served-list hints test + annotations meta-test. `manifest.json` tools roster == served.

### T5 — Skills
`skills/warapp-mcp/SKILL.md` (how to use the MCP's tools + "In context groups" section) and
`skills/warapp-api/SKILL.md` (curl skill over GameFeed using `~/.config/warapp-mcp/.env`, jq
recipes for players/bonuses/standing, never prints the token; helper script tested under bash
AND zsh, no shell var named `path`/`status`). Execute every documented recipe against the
fixture (and live against game 45670418 with the real env file, writing output only to the
scratch dir, never committing it).

## Out of scope for this run
Order submission (`warapp_submit_turn`) — needs a live in-tab capture on the owner's turn;
creating the GitHub repo, pushing, labels, rulesets — the orchestrator does those after.
