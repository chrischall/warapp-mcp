# warapp-mcp — plan: turn notifications over a direct WebSocket (#32)

Worktree `/Users/chris/git/warapp-mcp-push`, branch `feat/direct-push` (from `origin/main`). Never
switch branches, never push, never touch other worktrees. Hard rules: **no live network in tests or
agents (tests drive a fake socket), synthetic fixtures only, never the real AuthToken, account email,
game id or player name. The AuthToken is scrubbed by value from every error** (reuse
`src/direct/session.ts` `scrubToken`/`scrubError`).

## Facts (verified live 2026-11-12, from GitHub issue #32)
- `GET https://war.app/socket.io/1/?t=<ms>` with the `AuthToken` cookie →
  `sid:heartbeat:close:transports`; transports include `websocket`.
- `wss://war.app/socket.io/1/websocket/<sid>` with the same `Cookie` header (Node's built-in
  `WebSocket` accepts a `headers` option) → server sends `1::`; then `3:::<HEX Subscribe frame>` (the
  same method-238 frame as today, `subscribeFrameHex`) is acknowledged with a 238 reply.
- `2::` heartbeats must be answered with `2::`. Pushes arrive as `3:::<hex>`, method **241
  `GameUpdated`** with the game id, within ~1 s.
- The server once closed a healthy socket after ~60 s; a reconnect (new handshake, new sid,
  re-subscribe) restored it. Pushes during the gap are lost, so after a reconnect callers must
  re-read GameFeed.

## Tasks

### P1 — WebSocket transport for the push client
Today `src/push/socketio.ts` (`SocketIoClient`) speaks socket.io v0.9 xhr-polling through the
browser bridge, and `src/push/listener.ts` owns one listener per process.
- Add a WebSocket transport alongside xhr-polling: handshake over the direct leg (HTTPS GET with the
  cookie, host locked to war.app like `warappUrl`), then open the `wss://` URL with the cookie header
  through an injectable WebSocket factory (default: global `WebSocket`; tests pass a fake). Reuse
  `parseHandshake`, `parsePacket`, `subscribeFrameHex`, `parsePushFrame`.
- Answer `2::` with `2::`; treat close/error/missed heartbeats (heartbeat timeout from the
  handshake) as a disconnect → reconnect with the existing backoff constants (new handshake, new
  sid, re-subscribe), and emit a "reconnected" signal so the listener/`warapp_wait_for_turn` re-reads
  GameFeed after a gap.
- **Selection:** when the active transport is `direct` (or `auto` while still on the direct leg,
  with a linked session) the listener uses the WebSocket transport; otherwise (and as the fallback
  when the WebSocket handshake/upgrade fails or the session is signed out) it keeps today's
  xhr-polling over the bridge. Never send the cookie anywhere but war.app.
- **Tests (fake socket + fake HTTPS):** handshake parse → wss URL and Cookie header; `1::` then the
  subscribe frame sent (exact hex from `subscribeFrameHex`); heartbeat answered; a 241 push delivers
  the game id; a server close → reconnect with a new sid and a re-subscribe, plus the reconnected
  signal; heartbeat timeout → reconnect; handshake 200 without `websocket` in transports or a
  signed-out reply → falls back to xhr-polling; errors never contain the token; bridge-mode never
  touches the WebSocket.

### P2 — Wiring, docs
- `warapp_wait_for_turn`: after a reconnect it re-reads GameFeed before waiting again (no missed
  turn). Healthcheck/session status report which push transport is active if that fits cleanly.
- CLAUDE.md push bullet (WebSocket in direct mode, xhr-polling fallback, reconnect rule),
  `docs/WEB-PROTOCOL.md` push section (the WebSocket facts above, marked verified). Strict surface
  lint 0 warnings (recipe in docs/PLAN-TURN.md T4).
