# src/push/ — warapp-mcp

What is true of turn notifications (the socket.io push channel). The repo-wide rules are in the root `CLAUDE.md`.

- **Turn notifications are a socket.io v0.9 client with two transports.** While the active
  transport is the direct leg, a **WebSocket** (`src/push/websocket.ts`): handshake GET with the
  `AuthToken` cookie (host-locked to war.app), then `wss://war.app/socket.io/1/websocket/<sid>`
  with the same `Cookie` header. Otherwise — and as the fallback when the WebSocket cannot come up
  (no session, signed out, no `websocket` transport, failed upgrade) — **xhr-polling over the
  bridge** (`src/push/socketio.ts`): the first poll must return the connect packet `1::` before
  any POST (a POST first is HTTP 400). Both answer `2::` heartbeats and send `Subscribe`
  (method 242, no auth block) to `Game.<id>`. A push is method 245 `GameUpdated` carrying the game
  id and its chat flags (no text), so `warapp_wait_for_turn` re-reads GameFeed after one (debounced per game, below). **A reconnect loses the
  pushes sent during the gap** (war.app has closed a healthy socket after ~60 s): close, error
  or a missed heartbeat reconnects (new handshake, new sid, re-subscribe) and `onReconnect`
  fires, on which `warapp_wait_for_turn` re-reads every watched game — as it does when a failed
  `Subscribe` goes through on a retry (`onConnect` with `resubscribed: true`). A wait checks every
  game (membership included) before it watches any, so a game not mine is never subscribed; a
  released game is unwatched (not re-subscribed on a reconnect); at most `MAX_WATCHED_GAMES` games
  are watched at once; and GameFeed re-reads are debounced per game (one in flight, one queued).
  A wait that starts the socket reads each game twice up front (its check, then the re-read on
  the first connect): accepted, since skipping it could miss a turn. A push for a game no wait
  watches is not recorded. Two waits on one game: the second's `watch` waits for a Subscribe the
  first has in flight, or sees (`mark`) one that went through after it began reading, and
  re-reads. When the Subscribe retries on a session run out (five), the listener starts a new
  session itself. An instant `2::` heartbeat reply is paced like an empty poll.
  The push transport shows
  in `warapp_session_status` (`pushTransport`) and the push tools. One listener per process
  (`src/push/listener.ts`), started lazily: many processes sharing the bridge port collide.
  Tests drive a scripted fake bridge and a fake WebSocket, never a real socket.
