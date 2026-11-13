// The process's war.app turn-notification listener: one push socket per
// process (many processes sharing the bridge port collide — it must live in
// the MCP server's own long-lived process), started lazily on first use,
// subscribed to `Game.<id>` for every game anyone has asked to watch. Each
// GameUpdated push becomes `{ gameId, at }`; the push carries no detail, so a
// consumer re-reads GameFeed for that game.
//
// Transport: the direct WebSocket while the active transport is the direct leg
// (src/push/websocket.ts), else — and as the fallback when the WebSocket
// cannot be brought up — xhr-polling over the bridge. After any reconnect,
// pushes sent during the gap are lost: `onConnect` (every connect, the first
// included — a turn that resolved before the first Subscribe sent no push
// either) and `onReconnect` tell consumers to re-read GameFeed. A Subscribe that
// failed (not sent, or refused) and later goes through on the same session is
// such a gap too: `onConnect` fires again with `resubscribed: true`.
import type { ExtrasUp } from '../protocol/codec.js';
import { gameTopic } from '../protocol/methods.js';
import {
  CLIENT_VERSION,
  INITIAL_SERVER_INFO_A,
  INITIAL_SERVER_INFO_B,
  PLATFORM_WEBSITE,
} from '../protocol/rpc.js';
import {
  DEFAULT_INITIAL_BACKOFF_MS,
  DEFAULT_MAX_BACKOFF_MS,
  parsePushFrame,
  SocketIoClient,
  subscribeFrameHex,
  type PushTransportName,
  type SocketIoClientOptions,
  type SocketTransport,
} from './socketio.js';
import { realSetTimer, type SetTimer, type WebSocketLeg } from './websocket.js';

export interface GameUpdate {
  gameId: number;
  /** ISO time the push was received. */
  at: string;
}

/** A connect, or a Subscribe that went through after one failed: pushes before it were lost. */
export interface ConnectEvent {
  /** A connect after the first of this run. */
  reconnect: boolean;
  /** Not a connect: a Subscribe that had failed on this session went through on a retry. */
  resubscribed?: true;
}

export interface PushStatus {
  started: boolean;
  connected: boolean;
  /** Game ids subscribed (or to be subscribed on connect). */
  watching: number[];
  /** Topics war.app refused, with its error code. */
  refused: Record<string, number>;
  /** Watched games not yet subscribed on the live session (a Subscribe failed and is retried); absent when none. */
  pending?: number[];
  /** The push transport of the current (or last) session, once one has started. */
  transport?: PushTransportName;
  lastError?: string;
}

export interface PushListenerOptions {
  transport: () => Promise<SocketTransport>;
  /** The direct WebSocket leg (src/push/websocket.ts `pushWebSocketLeg`); absent: xhr-polling only. */
  webSocket?: WebSocketLeg;
  /** The WebSocket heartbeat timer (tests). */
  setTimer?: SetTimer;
  /** MessageExtrasUp for Subscribe frames (default: the web client's values). */
  extras?: () => ExtrasUp;
  /** How many recent events to keep. Default 100. */
  maxEvents?: number;
  now?: () => number;
  /** Passed to the socket (tests). */
  sleep?: SocketIoClientOptions['sleep'];
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Stop the socket this long after the last watch is released (default 10 min). */
  idleMs?: number;
  /** The idle timer (tests). */
  idleTimer?: SetTimer;
}

export const DEFAULT_MAX_EVENTS = 100;
export const DEFAULT_IDLE_MS = 10 * 60_000;
/** Failed Subscribes in a row retried on the live session before leaving it to the next reconnect. */
export const MAX_SUBSCRIBE_RETRIES = 5;

const defaultExtras = (): ExtrasUp => ({
  dict: new Map(),
  client: CLIENT_VERSION,
  serverInfoVersionA: INITIAL_SERVER_INFO_A,
  serverInfoVersionB: INITIAL_SERVER_INFO_B,
  fDb: null,
  kFa: null,
  platform: PLATFORM_WEBSITE,
});

export class PushListener {
  private readonly socket: SocketIoClient;
  private readonly extras: () => ExtrasUp;
  private readonly maxEvents: number;
  private readonly now: () => number;
  private readonly games = new Set<number>();
  /** Game ids sent in a Subscribe on the current session. */
  private subscribed = new Set<number>();
  private readonly refused = new Map<string, number>();
  private readonly events: GameUpdate[] = [];
  private readonly listeners = new Set<(u: GameUpdate) => void>();
  private readonly reconnectListeners = new Set<() => void>();
  private readonly connectListeners = new Set<(e: ConnectEvent) => void>();
  private connects = 0;
  private nextMsgNum = 1;
  /** Open watches per game (a wait holds its games until it releases them). */
  private readonly holds = new Map<number, number>();
  /** The games each Subscribe this session carried, by message number. */
  private readonly sentBy = new Map<number, number[]>();
  private retrying = false;
  private subscribeFailures = 0;
  private subscribeError: string | undefined;
  /** A Subscribe failed on this session: the next one that goes through tells the connect listeners. */
  private resubscribeOwed = false;
  private cancelIdle: (() => void) | undefined;
  private readonly opts: PushListenerOptions;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(opts: PushListenerOptions) {
    this.opts = opts;
    this.sleep =
      opts.sleep ??
      ((ms) =>
        new Promise<void>((resolve) => {
          const t = setTimeout(resolve, ms);
          (t as { unref?: () => void }).unref?.();
        }));
    this.extras = opts.extras ?? defaultExtras;
    this.maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.now = opts.now ?? Date.now;
    this.socket = new SocketIoClient({
      transport: opts.transport,
      now: this.now,
      onMessage: (data) => this.onMessage(data),
      onReconnect: () => {
        for (const fn of this.reconnectListeners) fn();
      },
      ...(opts.webSocket ? { webSocket: opts.webSocket } : {}),
      ...(opts.setTimer ? { setTimer: opts.setTimer } : {}),
      onConnect: async () => {
        this.subscribed = new Set();
        this.sentBy.clear();
        this.subscribeFailures = 0;
        this.resubscribeOwed = false;
        await this.subscribePending();
        const e: ConnectEvent = { reconnect: ++this.connects > 1 };
        for (const fn of this.connectListeners) fn(e);
      },
      ...(opts.sleep ? { sleep: opts.sleep } : {}),
      ...(opts.initialBackoffMs !== undefined ? { initialBackoffMs: opts.initialBackoffMs } : {}),
      ...(opts.maxBackoffMs !== undefined ? { maxBackoffMs: opts.maxBackoffMs } : {}),
    });
  }

  /**
   * Watch these games: start the socket if needed and subscribe to any not
   * yet subscribed. Never throws for a socket failure — the socket keeps
   * reconnecting in the background and subscribes on connect.
   */
  async watch(gameIds: readonly number[]): Promise<void> {
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    for (const id of gameIds) {
      this.games.add(id);
      this.holds.set(id, (this.holds.get(id) ?? 0) + 1);
    }
    this.socket.start();
    if (this.socket.connected) {
      try {
        if (await this.subscribePending()) this.resubscribed();
      } catch (e) {
        // Retried on this session (with backoff); a reconnect re-subscribes everything anyway.
        this.subscribeFailed(e);
      }
    }
  }

  /**
   * End a watch (each `watch` is released once). When no watch is left, the socket stops after
   * the idle delay — and forgets its games — unless a new watch comes first.
   */
  release(gameIds: readonly number[]): void {
    for (const id of gameIds) {
      const n = (this.holds.get(id) ?? 0) - 1;
      if (n > 0) this.holds.set(id, n);
      else this.holds.delete(id);
    }
    if (this.holds.size || this.cancelIdle || !this.socket.started) return;
    const timer = this.opts.idleTimer ?? realSetTimer;
    this.cancelIdle = timer(this.opts.idleMs ?? DEFAULT_IDLE_MS, () => {
      this.cancelIdle = undefined;
      if (this.holds.size) return;
      this.socket.stop();
      // The next watch starts a new run: its first connect is not a reconnect (#131).
      this.connects = 0;
      this.games.clear();
      this.subscribed = new Set();
      this.sentBy.clear();
      this.refused.clear();
      this.subscribeError = undefined;
      this.subscribeFailures = 0;
      this.resubscribeOwed = false;
    });
  }

  /** Stop watching games that cannot change any more (finished): they are not re-subscribed. */
  forget(gameIds: readonly number[]): void {
    for (const id of gameIds) {
      this.games.delete(id);
      this.subscribed.delete(id);
    }
  }

  /** Listen for GameUpdated pushes; returns the unsubscribe. */
  onUpdate(fn: (u: GameUpdate) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * Listen for reconnects (every connect after the first, once re-subscribed):
   * pushes during the gap were lost, so re-read GameFeed. Returns the unsubscribe.
   */
  onReconnect(fn: () => void): () => void {
    this.reconnectListeners.add(fn);
    return () => {
      this.reconnectListeners.delete(fn);
    };
  }

  /**
   * Listen for every connect, the first included, once subscribed: a game's turn that resolved
   * before its Subscribe sent no push here, so re-read GameFeed (#131). `reconnect` is false for
   * the first connect of the process. Also fired, with `resubscribed: true`, when a Subscribe that
   * failed on this session goes through on a retry: a turn that resolved in between sent no push
   * either. Returns the unsubscribe.
   */
  onConnect(fn: (e: ConnectEvent) => void): () => void {
    this.connectListeners.add(fn);
    return () => {
      this.connectListeners.delete(fn);
    };
  }

  /** The most recent events, newest first. */
  recent(limit = this.maxEvents): GameUpdate[] {
    return this.events.slice(-limit).reverse();
  }

  status(): PushStatus {
    const s: PushStatus = {
      started: this.socket.started,
      connected: this.socket.connected,
      watching: [...this.games].sort((a, b) => a - b),
      refused: Object.fromEntries(this.refused),
    };
    const transport = this.socket.transport;
    if (transport !== undefined) s.transport = transport;
    const err = this.subscribeError ?? this.socket.lastError;
    if (err !== undefined) s.lastError = err;
    if (this.socket.connected) {
      const pending = s.watching.filter((g) => !this.subscribed.has(g));
      if (pending.length) s.pending = pending;
    }
    return s;
  }

  stop(): void {
    this.cancelIdle?.();
    this.cancelIdle = undefined;
    this.socket.stop();
    this.connects = 0;
  }

  /** Send a Subscribe for every game not yet subscribed; true when one was sent. */
  private async subscribePending(): Promise<boolean> {
    const pending = [...this.games].filter((g) => !this.subscribed.has(g));
    if (!pending.length) return false;
    for (const g of pending) this.subscribed.add(g);
    const msgNum = this.nextMsgNum++;
    this.sentBy.set(msgNum, pending);
    try {
      await this.socket.sendMessage(subscribeFrameHex(pending.map(gameTopic), msgNum, this.extras()));
    } catch (e) {
      this.sentBy.delete(msgNum);
      for (const g of pending) this.subscribed.delete(g);
      throw e;
    }
    return true;
  }

  /** A Subscribe went through on the live session: if an earlier one failed, the games it carried may have missed a push. */
  private resubscribed(): void {
    if (!this.resubscribeOwed) return;
    this.resubscribeOwed = false;
    const e: ConnectEvent = { reconnect: false, resubscribed: true };
    for (const fn of this.connectListeners) fn(e);
  }

  /** A Subscribe failed (not sent, or refused by the server): note it and retry with backoff. */
  private subscribeFailed(e: unknown): void {
    this.subscribeError = e instanceof Error ? e.message : String(e);
    this.subscribeFailures++;
    this.resubscribeOwed = true;
    if (this.retrying || this.subscribeFailures > MAX_SUBSCRIBE_RETRIES) return;
    this.retrying = true;
    void (async () => {
      try {
        const initial = this.opts.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
        const max = this.opts.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
        while (this.subscribeFailures <= MAX_SUBSCRIBE_RETRIES) {
          await this.sleep(Math.min(max, initial * 2 ** (this.subscribeFailures - 1)));
          // Not connected: the next connect subscribes every game.
          if (!this.socket.connected) return;
          if (![...this.games].some((g) => !this.subscribed.has(g))) return;
          try {
            if (await this.subscribePending()) this.resubscribed();
            return;
          } catch (err) {
            this.subscribeError = err instanceof Error ? err.message : String(err);
            this.subscribeFailures++;
          }
        }
      } finally {
        this.retrying = false;
      }
    })();
  }

  private onMessage(data: string): void {
    const msg = parsePushFrame(data);
    if (!msg) return;
    if (msg.kind === 'subscribe-reply') {
      const games = this.sentBy.get(msg.msgNum) ?? [];
      this.sentBy.delete(msg.msgNum);
      if (msg.error !== undefined) {
        // The Subscribe was refused as a whole: those games are not subscribed (#131).
        for (const g of games) this.subscribed.delete(g);
        this.subscribeFailed(new Error(`war.app refused the push Subscribe (server error ${msg.error}).`));
        return;
      }
      this.subscribeError = undefined;
      this.subscribeFailures = 0;
      for (const [topic, code] of msg.rejected) this.refused.set(topic, code);
      return;
    }
    if (msg.kind !== 'game-updated') return;
    const update: GameUpdate = { gameId: msg.gameId, at: new Date(this.now()).toISOString() };
    this.events.push(update);
    if (this.events.length > this.maxEvents) this.events.splice(0, this.events.length - this.maxEvents);
    for (const fn of this.listeners) fn(update);
  }
}

const perTransport = new WeakMap<object, PushListener>();

/**
 * The one listener for a bridge (so for the process: index.ts shares one
 * bridge across connections). Built on first use; the socket starts on the
 * first `watch`.
 */
export function pushListenerFor(key: object, opts: PushListenerOptions): PushListener {
  let l = perTransport.get(key);
  if (!l) {
    l = new PushListener(opts);
    perTransport.set(key, l);
  }
  return l;
}
