# warapp-mcp — phase 3 plan: plan and submit a turn

Worktree `/Users/chris/git/warapp-mcp-turn`, branch `feat/turn-tools` (built on `feat/live-board`,
PR #6; never switch branches, never push, never touch `/Users/chris/git/warapp-mcp`). Read
`docs/WEB-PROTOCOL.md` (Orders) and `CLAUDE.md` first. Same hard rules as phase 2
(`docs/PLAN-LIVE.md`): no live network, no captured data, no vendored bundle, synthetic
fixtures, real account email never in the repo.

Live-verified facts this plan relies on (2026-11-12, three real turns):
- `SendOrders` (74) params: int32 gameId, bool present, int32 count, per order (bool present +
  order), int32 turnNumber, bool false, bool false. Orders as the existing
  `writeDeployOrder` / `writeAttackTransferOrder` (golden-pinned). The client sends all deploys
  first, then moves, and an ordinary attack/transfer uses mode 3 (AttackTransfer).
- `turnNumber` = GameFeed `numberOfTurns` + 1 (0 before turn 1).
- The reply's result bool is the "vacation ended" flag — **never** a success signal. A commit is
  confirmed from game state: GameFeed `numberOfTurns` advanced, or my player's
  `hasCommittedOrders` is true.
- UNVERIFIED: whether a second `SendOrders` in the same turn replaces the first (the client uses
  "Modify orders" / `UnCommit` for that). So `warapp_submit_turn` refuses when my
  `hasCommittedOrders` is already true for this turn, and says to modify orders in the game.
- Error 11 = deployments ≠ income; 208 = the turn already advanced.

## T1 — Orders plumbing (`src/protocol/methods.ts`, `src/live-board.ts` or similar)
- `writeSendOrdersParams(w, gameId, orders, turnNumber)` where `orders` is a typed union
  `{ kind: 'deploy', territoryId, armies } | { kind: 'move', from, to, armies }` plus playerId;
  deploys written first, then moves in the given order. Golden test: bytes for a synthetic turn
  (game 12345, player 777: deploy 5→9, move 9→10 ×3, move 6→4 ×1, turn 2) equal exactly
  `39300000010300000001020900000000050000000903000000000101000300090000000003000000000A00000009030000000001010003000600000000010000000004000000090300000000020000000000`
  (produced by the encoder that matched a live client commit byte for byte).
- `boardStateFromLive(territories, me)` → the analysis `BoardState` (owner kinds: player /
  neutral / available / unknown when fogged; armies null when fogged). Tests.

## T2 — `warapp_plan_turn` (read)
Live board + map graph + game settings → `planTurn`. Inputs: game_id, optional player (defaults to
the signed-in account like the live tools), goal (expand | complete-bonus | defend), focus bonus
names/ids, reserve. Output (compact by default): income, deploys and moves **by name and id**, the
expected captures / bonuses / next income, warnings, rationale, and an `orders` array in exactly
the shape `warapp_submit_turn` accepts. Refuses with a clear message when the game is not in a turn
phase. Untrusted framing (names). Annotated read-only, `_meta.mint` hinted.

## T3 — `warapp_submit_turn` (write, confirm-gated)
`defineWrite` / `registerWrite` like `warapp_submit_picks`. Inputs: game_id, optional player,
`orders` (territories by id or name). `plan`: read GameFeed + live board, validate — every deploy
and move source is mine at the start of the turn; every move is to an adjacent territory; per
source, outgoing armies ≤ armies + deployed − 1 (one army stands guard when the setting is on);
deploys total exactly the income the planner computes (if they differ, refuse and say both
numbers — the server would answer error 11); turn number = numberOfTurns + 1; refuse when the
game is not in a turn phase, and refuse when my `hasCommittedOrders` is already true. The preview shows each order by name and the turn number. `execute`: send `SendOrders`, then confirm from
game state (re-read GameFeed: `numberOfTurns` advanced → `resolved`; my `hasCommittedOrders` true →
`committed`; neither → `unknown`, with what to check). Never report the reply bool as success.
A transport failure after sending → `status: 'unknown'` (do not suggest re-sending blindly).
Description says orders reach the game and other players see the results.

## T4 — Docs and packaging
README tool table, CLAUDE.md (turn submission now exists, how it is confirmed), skills/warapp-mcp
SKILL.md (plan → review → submit flow), manifest.json tools roster, hints test table, mint.yaml if
needed. The strict surface lint must stay at 0 warnings
(`node <mcp-utils v3.0.2>/scripts/audit-annotations.mjs dist/bundle.js --strict` — extract
`scripts/` from `git -C ~/git/mcp-utils archive v3.0.2 scripts` into a temp dir inside the
worktree, run, delete it).
