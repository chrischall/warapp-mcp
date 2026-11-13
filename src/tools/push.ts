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
import { gameIdArg, readAnnotations, respond, untrustedDescription } from './common.js';
import { lookupMeta, mintMeta } from './hints.js';
import type { LiveContext } from './live-context.js';
import { fetchMyGames } from './my-games.js';

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
}

export function checkOf(game: Game, playerId: number): GameCheck {
  return {
    id: game.id,
    name: game.name ?? null,
    state: game.state,
    turn: game.numberOfTurns !== undefined && game.numberOfTurns >= 0 ? game.numberOfTurns + 1 : null,
    waitingOnYou: isWaitingOn(game, playerId),
  };
}

export interface WaitOptions {
  gameIds: readonly number[];
  timeoutMs: number;
  /**
   * `onConnect` (else `onReconnect`), when present: pushes before a connect's Subscribe are lost —
   * a reconnect gap, or the first connect of the process after the initial check — so every game
   * is re-read.
   */
  push: Pick<PushListener, 'watch' | 'onUpdate'> &
    Partial<Pick<PushListener, 'onReconnect' | 'onConnect' | 'release' | 'forget'>>;
  /** Read one game's current state from GameFeed. */
  check: (gameId: number) => Promise<GameCheck>;
  signal?: AbortSignal;
  /** Called at start, on each relevant push, and every `progressEveryMs` while waiting. */
  progress?: (elapsedMs: number, message: string) => void;
  progressEveryMs?: number;
  now?: () => number;
}

export interface WaitOutcome {
  status: 'your_turn' | 'timed_out';
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
 * reason.
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
    queue.push(u.gameId);
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
  const offReconnect = opts.push.onConnect
    ? opts.push.onConnect((e) => requeue(e.reconnect))
    : opts.push.onReconnect?.(() => requeue(true));
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let watched = false;
  /** A finished game cannot need me again: the listener stops watching it. */
  const settle = (c: GameCheck) => {
    if (TERMINAL_STATES.has(c.state)) opts.push.forget?.([c.id]);
  };
  let onAbort: (() => void) | undefined;
  try {
    opts.signal?.throwIfAborted();
    await opts.push.watch([...ids]);
    watched = true;
    const latest = new Map<number, GameCheck>();
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
    if ([...latest.values()].some((c) => c.waitingOnYou)) return outcome('your_turn');
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
    if (watched) opts.push.release?.([...ids]);
    timers.forEach((t) => clearTimeout(t));
    if (onAbort) opts.signal?.removeEventListener('abort', onAbort);
  }
}

export function registerPushTools(server: McpServer, ctx: LiveContext, push: PushListener): void {
  server.registerTool(
    'warapp_wait_for_turn',
    {
      title: 'Wait for my turn in war.app games',
      description: untrustedDescription(
        'Wait until one of the given war.app (Warzone) games is waiting on you — the game is being played or its ' +
          'territories picked, you are still playing, and you have not committed — and return as soon as it is, ' +
          'or at the timeout (default 300 s, max 1800 s). It checks each game once at the start, then listens to ' +
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
      const token = await ctx.myInviteToken();
      if (token === undefined) {
        throw new McpToolError('Could not tell which war.app account is signed in, so there is no turn to wait for.', {
          hint:
            'Turns are watched for the account signed in to your war.app tab. Make sure a signed-in war.app tab is ' +
            'open and paired (ContextMint Bridge), focus or reload it, then retry.',
        });
      }
      const check = async (id: number) => {
        const game = await ctx.client.getGame(id);
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
