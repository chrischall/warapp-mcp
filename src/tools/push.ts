// Turn notifications: wait until one of my games is waiting on me, woken by
// war.app's push socket (src/push/), and list the pushes this process has
// seen. Both are read-only.
import { callerWantsProgress, currentCallSignal, McpToolError, reportProgress } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseGameId } from '../client.js';
import { activeGameIds } from '../my-games.js';
import type { Game } from '../normalize.js';
import type { PushListener } from '../push/listener.js';
import { currentTurn, gameIdArg, readAnnotations, respond, untrustedDescription } from './common.js';
import { lookupMeta, mintMeta } from './hints.js';
import type { LiveContext } from './live-context.js';
import { fetchMyGames } from './my-games.js';
import { requireMe } from './write-kit.js';

/** Game states in which a player has something to submit (picks or orders). */
export const ACTION_STATES: ReadonlySet<string> = new Set(['Playing', 'DistributingTerritories']);

/** Game states that never change again: the push listener forgets such a game. */
export const TERMINAL_STATES: ReadonlySet<string> = new Set(['Finished']);

export const MAX_WAIT_GAMES = 20;
export const DEFAULT_TIMEOUT_SECONDS = 300;
export const MAX_TIMEOUT_SECONDS = 1800;
/** How often a waiting call reports progress, when the caller asked for it. */
export const PROGRESS_EVERY_MS = 15_000;
const VIEWS = ['compact'] as const;

/** Whether the game is waiting on this player: game in a turn/pick phase, my player Playing and not committed. */
export function isWaitingOn(game: Game, playerId: number): boolean {
  if (!ACTION_STATES.has(game.state)) return false;
  const me = game.players.find((p) => p.id === playerId);
  return me !== undefined && me.state === 'Playing' && !me.hasCommittedOrders;
}

export interface GameCheck {
  id: number;
  name: string | null;
  state: string;
  /** The turn being played (GameFeed numberOfTurns + 1), or null. */
  turn: number | null;
  waitingOnYou: boolean;
  /** Set when no turn of mine can come in this game: why (it finished, or my seat is out). */
  ended?: string;
}

/** Why no turn of mine can come in `game` any more, or undefined while one still can (#130). */
export function endedReason(game: Game, playerId: number): string | undefined {
  if (game.state === 'Finished') return 'The game is finished.';
  if (!ACTION_STATES.has(game.state)) return undefined;
  const me = game.players.find((p) => p.id === playerId);
  if (me?.state !== undefined && me.state !== 'Playing') return `You are out of this game (your state: ${me.state}).`;
  return undefined;
}

export function checkOf(game: Game, playerId: number): GameCheck {
  const ended = endedReason(game, playerId);
  return {
    id: game.id,
    name: game.name ?? null,
    state: game.state,
    turn: currentTurn(game),
    waitingOnYou: isWaitingOn(game, playerId),
    ...(ended ? { ended } : {}),
  };
}

export interface WaitOptions {
  gameIds: readonly number[];
  timeoutMs: number;
  /**
   * `onConnect` (else `onReconnect`), when present: pushes before a connect's Subscribe are lost —
   * a reconnect gap, the first connect of the process after the initial check, or a Subscribe that
   * failed and later went through on a retry — so every game is re-read.
   */
  /** `watch` resolving true: it sent a Subscribe on a live session, so every game is re-read (the check-to-Subscribe gap). */
  push: { watch: (gameIds: readonly number[], opts?: { since?: number }) => Promise<boolean | void> } & Pick<PushListener, 'onUpdate'> &
    Partial<Pick<PushListener, 'onReconnect' | 'onConnect' | 'release' | 'forget' | 'mark'>>;
  /**
   * Read one game's current state from GameFeed. Throws for a game the account does not play in:
   * every game is checked before any is watched (#131).
   */
  check: (gameId: number) => Promise<GameCheck>;
  signal?: AbortSignal;
  /** Called at start, on each relevant push, and every `progressEveryMs` while waiting. */
  progress?: (elapsedMs: number, message: string) => void;
  progressEveryMs?: number;
  now?: () => number;
}

export interface WaitOutcome {
  /** `game_over`: every watched game finished or has my seat out — no turn is coming (#130). */
  status: 'your_turn' | 'timed_out' | 'game_over';
  /** The latest view of every game, in the order asked. */
  games: GameCheck[];
  /** Pushes received for these games while waiting. */
  updates: number;
  /** Push-socket reconnects while waiting (each re-read every game). */
  reconnects: number;
  waitedMs: number;
  /** GameFeed re-reads that failed after a push (the wait carried on). */
  errors: string[];
}

/**
 * Resolve as soon as one of `gameIds` is waiting on me — checked once at
 * start, again for a game on every GameUpdated push for it, and again for
 * every game after the push socket reconnects (pushes sent during the gap are
 * lost) — or when `timeoutMs` passes. A cancelled `signal` rejects with its
 * reason. The games are checked before they are watched, so a game the check
 * refuses (not mine) is never subscribed; a finished game, or one where my seat is out, is not watched. Re-reads
 * are debounced per game: at most one in flight and one queued (#131).
 */
export async function waitForTurn(opts: WaitOptions): Promise<WaitOutcome> {
  const now = opts.now ?? Date.now;
  const start = now();
  const ids = new Set(opts.gameIds);
  const queue: number[] = [];
  let wake: (() => void) | undefined;
  let updates = 0;
  let reconnects = 0;
  /** Set by a reconnect: report it once the loop resumes. */
  let reconnectNote = false;
  const errors: string[] = [];
  const off = opts.push.onUpdate((u) => {
    if (!ids.has(u.gameId)) return;
    updates++;
    // Debounced (#131): a burst of pushes while the game is queued is one re-read; one arriving
    // while its re-read is in flight queues one more (the read in flight may predate the change).
    if (!queue.includes(u.gameId)) queue.push(u.gameId);
    wake?.();
  });
  const requeue = (reconnect: boolean) => {
    if (reconnect) {
      reconnects++;
      reconnectNote = true;
    }
    for (const id of ids) if (!queue.includes(id)) queue.push(id);
    wake?.();
  };
  // Every connect, the first included: watch() returns before the socket connects, so a turn
  // that resolves between the initial check and the first Subscribe is only seen by a re-read.
  // Cost, accepted (#148): a wait that starts the socket reads each game twice up front (its check,
  // then the re-read on that first connect), 2N GameFeed reads for N games where N would do when the
  // two are milliseconds apart. Skipping the re-read would trade a few reads for a missed turn
  // whenever they are not; a re-read asked for while one is in flight is coalesced (`coalesced`).
  const offReconnect = opts.push.onConnect
    ? opts.push.onConnect((e) => requeue(e.reconnect))
    : opts.push.onReconnect?.(() => requeue(true));
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  /** The games this wait watches (released when it ends). */
  let watched: number[] = [];
  /** A finished game cannot need me again: the listener stops watching it. */
  const settle = (c: GameCheck) => {
    if (TERMINAL_STATES.has(c.state)) opts.push.forget?.([c.id]);
  };
  let onAbort: (() => void) | undefined;
  try {
    opts.signal?.throwIfAborted();
    // Check first, watch second (#131): the check refuses a game the account does not play in, and
    // such a game must never be subscribed. The gap this opens (a turn resolving between the check
    // and the Subscribe sends no push) is closed by a re-read: on the connect when the socket is not
    // up yet, or right after `watch` when it subscribed on a live session.
    const latest = new Map<number, GameCheck>();
    // Taken before the first checks: a Subscribe for these games that another wait gets through after
    // it (or has in flight when this one watches) makes `watch` say so, and the games are re-read (#148).
    const mark = opts.push.mark?.();
    const first = await Promise.all([...ids].map(async (id) => [id, await opts.check(id)] as const));
    for (const [id, c] of first) {
      latest.set(id, c);
      settle(c);
    }
    const outcome = (status: WaitOutcome['status']): WaitOutcome => ({
      status,
      games: [...ids].map((id) => latest.get(id)!),
      updates,
      reconnects,
      waitedMs: now() - start,
      errors,
    });
    const allEnded = () => [...latest.values()].every((c) => c.ended !== undefined);
    if ([...latest.values()].some((c) => c.waitingOnYou)) return outcome('your_turn');
    // Every game ended (finished, or my seat out): no turn can come, so return before watching (#130).
    if (allEnded()) return outcome('game_over');
    opts.signal?.throwIfAborted();
    // Watch only a game that can still need me: not a finished one (#131), nor one where my seat is out (#130).
    const live = [...ids].filter((id) => !TERMINAL_STATES.has(latest.get(id)!.state) && latest.get(id)!.ended === undefined);
    if (live.length) {
      const subscribedNow = await opts.push.watch(live, mark === undefined ? {} : { since: mark });
      watched = live;
      if (subscribedNow === true) for (const id of live) if (!queue.includes(id)) queue.push(id);
    }
    opts.progress?.(0, `Waiting for your turn in ${ids.size} game(s).`);

    let timedOut = false;
    let aborted = false;
    const ping = () => wake?.();
    timers.push(
      setTimeout(() => {
        timedOut = true;
        ping();
      }, opts.timeoutMs),
    );
    if (opts.progress) {
      const every = opts.progressEveryMs ?? PROGRESS_EVERY_MS;
      const tick = () => {
        opts.progress?.(now() - start, 'Still waiting for your turn.');
        timers.push(setTimeout(tick, every));
      };
      timers.push(setTimeout(tick, every));
    }
    if (opts.signal) {
      onAbort = () => {
        aborted = true;
        ping();
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    for (;;) {
      if (aborted) opts.signal!.throwIfAborted();
      if (reconnectNote) {
        reconnectNote = false;
        opts.progress?.(now() - start, 'Push socket reconnected; re-checking every game (pushes in the gap are lost).');
      }
      const id = queue.shift();
      if (id !== undefined) {
        try {
          const c = await opts.check(id);
          latest.set(id, c);
          settle(c);
          if (c.waitingOnYou) return outcome('your_turn');
          if (allEnded()) return outcome('game_over');
          opts.progress?.(now() - start, `Game ${id} updated; not your turn there yet.`);
        } catch (e) {
          errors.push(`Game ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
        continue;
      }
      if (timedOut) return outcome('timed_out');
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
      wake = undefined;
    }
  } finally {
    off();
    offReconnect?.();
    if (watched.length) opts.push.release?.(watched);
    timers.forEach((t) => clearTimeout(t));
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Coalesce reads per key (#131): at most one read in flight and one queued. A call while a read is
 * in flight gets the queued read, which starts once the one in flight settles, so it sees data read
 * after it asked; every call while that read is queued shares it.
 */
export function coalesced<K, T>(read: (key: K) => Promise<T>): (key: K) => Promise<T> {
  const inFlight = new Map<K, Promise<T>>();
  const queued = new Map<K, Promise<T>>();
  const start = (key: K): Promise<T> => {
    const p: Promise<T> = read(key).finally(() => {
      if (inFlight.get(key) === p) inFlight.delete(key);
    });
    inFlight.set(key, p);
    return p;
  };
  return (key) => {
    const waiting = queued.get(key);
    if (waiting) return waiting;
    const current = inFlight.get(key);
    if (!current) return start(key);
    const next = current.then(
      () => undefined,
      () => undefined,
    ).then(() => {
      queued.delete(key);
      return start(key);
    });
    queued.set(key, next);
    return next;
  };
}

export function registerPushTools(server: McpServer, ctx: LiveContext, push: PushListener): void {
  // One GameFeed read per game at a time across every wait in the process, one queued (#131).
  const readGame = coalesced((id: number) => ctx.client.getGame(id, { map: false }));
  server.registerTool(
    'warapp_wait_for_turn',
    {
      title: 'Wait for my turn in war.app games',
      description: untrustedDescription(
        'Wait until one of the given war.app (Warzone) games is waiting on you — the game is being played or its ' +
          'territories picked, you are still playing, and you have not committed — and return as soon as it is, ' +
          'or at the timeout (default 300 s, max 1800 s) — or at once with `game_over` when every game has finished or ' +
          'your seat is out (each says why in `ended`). It checks each game once at the start, then listens to ' +
          "war.app's push notifications — over a direct WebSocket while a linked war.app session serves calls, else " +
          'through your signed-in war.app tab (ContextMint Bridge) — and re-checks a game whenever war.app says it ' +
          'changed, and every game after the push socket reconnects. Pass the game ids to watch (1–20), or omit them to watch every game ' +
          'of yours being played or picked (the first 20, as warapp_my_games lists them). Reports progress while it ' +
          'waits and stops when the call is cancelled. Then plan with warapp_plan_turn (or pick with ' +
          'warapp_submit_picks). Read-only.',
      ),
      _meta: mintMeta('whats-new', ['is it my turn', 'wait for my turn', 'tell me when it is my turn', 'warzone turn ready']),
      annotations: readAnnotations('Wait for my war.app turn'),
      inputSchema: z.object({
        game_ids: z
          .array(gameIdArg)
          .min(1)
          .max(MAX_WAIT_GAMES)
          .optional()
          .describe(
            'The war.app game ids to watch (the number after GameID= in each game URL). Omit to watch every game ' +
              'of yours being played or picked.',
          ),
        timeout_seconds: z.coerce
          .number()
          .int()
          .min(1)
          .max(MAX_TIMEOUT_SECONDS)
          .optional()
          .describe(`Give up after this many seconds (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).`),
      }),
    },
    async ({ game_ids, timeout_seconds }) => {
      let ids: number[];
      if (game_ids) {
        ids = [...new Set(game_ids.map((g) => parseGameId(g)))];
      } else {
        const { me, games } = await fetchMyGames(ctx);
        ids = activeGameIds(games, me).slice(0, MAX_WAIT_GAMES);
        if (!ids.length) {
          throw new McpToolError('None of your war.app games is being played or picked right now, so there is no turn to wait for.', {
            hint: 'warapp_my_games lists your games and their states; a lobby starts once enough players join.',
          });
        }
      }
      // Turns are watched for the account signed in to the war.app tab.
      const token = await requireMe(ctx, { fresh: false, consequence: 'there is no turn to wait for' });
      const check = async (id: number) => {
        // A turn check reads only the game's state: no map (a cold map is ~190 KB per game, #131).
        const game = await readGame(id);
        if (!game.players.some((p) => p.id === token)) {
          throw new McpToolError(`The signed-in war.app account is not a player in game ${id}.`, {
            hint: 'Watch only games you play in.',
          });
        }
        return checkOf(game, token);
      };
      const timeoutSec = timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
      const progress = callerWantsProgress()
        ? (elapsedMs: number, message: string) => {
            void reportProgress(Math.min(timeoutSec, Math.round(elapsedMs / 1000)), timeoutSec, message).catch(
              () => undefined,
            );
          }
        : undefined;
      const signal = currentCallSignal();
      const out = await waitForTurn({
        gameIds: ids,
        timeoutMs: timeoutSec * 1000,
        push,
        check,
        ...(signal ? { signal } : {}),
        ...(progress ? { progress } : {}),
      });
      const st = push.status();
      return respond(undefined, VIEWS, () => ({
        status: out.status,
        watching: ids,
        ...(out.status === 'your_turn' ? { ready: out.games.filter((g) => g.waitingOnYou).map((g) => g.id) } : {}),
        games: out.games,
        waited_seconds: Math.round(out.waitedMs / 1000),
        updates: out.updates,
        ...(out.reconnects ? { reconnects: out.reconnects } : {}),
        push: {
          connected: st.connected,
          ...(st.transport ? { transport: st.transport } : {}),
          ...(st.lastError ? { last_error: st.lastError } : {}),
        },
        ...(out.errors.length ? { errors: out.errors } : {}),
        next:
          out.status === 'your_turn'
            ? 'Plan the turn with warapp_plan_turn (or, while territories are being picked, warapp_get_live_board and warapp_submit_picks).'
            : out.status === 'game_over'
              ? 'No turn is coming in these games (each finished or your seat is out — see `ended`), so stop watching them.'
              : st.connected
              ? 'No game needed you before the timeout. Call warapp_wait_for_turn again to keep waiting.'
              : 'No game needed you before the timeout, and the push socket was not connected (no war.app tab paired?), ' +
                'so only the start was checked. Open and focus a signed-in war.app tab, then retry.',
      }));
    },
  );

  server.registerTool(
    'warapp_recent_events',
    {
      title: 'Recent war.app push events',
      description:
        'List the war.app game-update pushes this server process has received (newest first): which game ' +
        'changed and when. Only games watched by warapp_wait_for_turn are listened to; a push says only that a ' +
        'game changed, so re-read it with warapp_get_game. Also reports whether the push socket is connected and its ' +
        'transport (websocket or xhr-polling). Read-only.',
      _meta: lookupMeta(['recent game updates', 'warzone notifications']),
      annotations: readAnnotations('Recent war.app push events'),
      inputSchema: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional().describe('How many events (default 20, max 100).'),
        game_id: gameIdArg.optional().describe('Only events for this game.'),
      }),
    },
    async ({ limit, game_id }) => {
      const only = game_id === undefined ? undefined : parseGameId(game_id);
      const events = push
        .recent()
        .filter((e) => only === undefined || e.gameId === only)
        .slice(0, limit ?? 20)
        .map((e) => ({ game_id: e.gameId, at: e.at }));
      const st = push.status();
      return respond(undefined, VIEWS, () => ({
        events,
        listening: {
          started: st.started,
          connected: st.connected,
          watching: st.watching,
          ...(st.transport ? { transport: st.transport } : {}),
          ...(Object.keys(st.refused).length ? { refused: st.refused } : {}),
          ...(st.lastError ? { last_error: st.lastError } : {}),
        },
      }));
    },
  );
}
