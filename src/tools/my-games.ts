// warapp_my_games: the signed-in account's games through the web client's
// GetMyGames, with which ones are waiting on me — the group's canonical
// "what's new" tool, so it also answers `view: 'brief'`.
//
// The whole list (#260): the client's default filters (`Default`, 10 games) are the dashboard's
// short list, so every caller asks `All` with a count, widened while war.app fills it
// (MY_GAMES_WINDOWS). The client itself never pages GetMyGames (its writer sends the int32 after
// the filters as a constant 0, and the one other list it asks takes `count` 100), so a wider
// count is how the whole list is read. UNVERIFIED live: that `All` lists lobbies and finished
// games together and that the server honours a count above 10.
import { untrustedEnvelope, type EnvSource } from '@chrischall/mcp-utils';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { briefGameLine, gameStateName, isFinished, readMyGames, summarizeMyGames, type MyGame, type RawMyGame } from '../my-games.js';
import { Method, MY_GAMES_DEFAULT_SORT, MyGamesFilterType, writeGetMyGamesParams, type MyGamesFilters } from '../protocol/methods.js';
import { readAnnotations, respond, untrustedDescription, untrustedText, WARAPP_UNTRUSTED_NOTE } from './common.js';
import { canonicalMeta } from './hints.js';
import type { LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { holdsSeat, playerStateName } from '../player-states.js';
import { sweepFinished } from './end-of-game.js';
import { accountUnknown } from './write-kit.js';
import { pendingSurrenders, surrenderOwed } from '../surrender-pending.js';
import { readDetailsSeats, SURRENDER_PENDING_NOTE, surrenderMayBePending, type PendingSurrenderView } from './surrender-pending.js';

const VIEWS = ['compact', 'brief'] as const;

/** The note line a brief answer ends with when the list may be partial (a `-- ` line is never a game). */
const partialLine = (listed: number) =>
  `-- the list may be partial: war.app returned ${listed} games, the most this server asks for`;

function briefResult(games: readonly MyGame[], partialOf?: number): CallToolResult {
  const lines = games.length ? games.map(briefGameLine) : ['-- none'];
  if (partialOf !== undefined) lines.push(partialLine(partialOf));
  return { content: [{ type: 'text', text: JSON.stringify(untrustedEnvelope(lines, { note: WARAPP_UNTRUSTED_NOTE })) }] };
}

/**
 * The counts GetMyGames is asked for, in turn (#260): a reply that fills its count may have left games out,
 * so the list is asked again with the next; one that fills the last is reported as possibly partial.
 */
export const MY_GAMES_WINDOWS: readonly number[] = [100, 400, 1600];

/** The game list GetMyGames gave, and whether games may be missing from it. */
export interface MyGamesList {
  games: RawMyGame[];
  /** The last reply filled its count (or a wider read failed): games may be missing. */
  partial: boolean;
  /** GetMyGames requests made. */
  requests: number;
}

/**
 * Every game of the account through `read` (one GetMyGames request with these filters): `All` (lobbies, games
 * being picked or played, finished games), asked with each count of `windows` in turn until a reply does not
 * fill it. A failed first read throws; a failed wider read keeps the last list, as partial.
 */
export async function listMyGames(
  read: (filters: MyGamesFilters) => Promise<RawMyGame[]>,
  windows: readonly number[] = MY_GAMES_WINDOWS,
): Promise<MyGamesList> {
  let games: RawMyGame[] = [];
  let requests = 0;
  for (const count of windows) {
    const filters = { filterType: MyGamesFilterType.All, count, sort: MY_GAMES_DEFAULT_SORT };
    requests++;
    if (requests === 1) games = await read(filters);
    else {
      try {
        games = await read(filters);
      } catch {
        return { games, partial: true, requests };
      }
    }
    if (games.length < count) return { games, partial: false, requests };
  }
  return { games, partial: true, requests };
}

/** The signed-in account's in-game id; refuses when it cannot be read. */
async function myInGameId(ctx: LiveContext): Promise<number> {
  const me = await ctx.myInGameId();
  if (me === undefined) {
    throw accountUnknown(ctx, 'its games cannot be listed');
  }
  return me;
}

/** The signed-in account's in-game id and every game of its, through GetMyGames ({@link listMyGames}). */
export async function fetchMyGames(ctx: LiveContext): Promise<{ me: number } & MyGamesList> {
  const read = async (filters: MyGamesFilters) => {
    const env = await ctx.rpc.call('GetMyGames', Method.GetMyGames, (w) => writeGetMyGamesParams(w, filters));
    return readMyGames(await ctx.bundle(), env.body);
  };
  const [me, list] = await Promise.all([myInGameId(ctx), listMyGames(read)]);
  return { me, ...list };
}

/** #317: the most games whose details one call reads for a pending surrender (the rest are `null`). */
export const MAX_SURRENDER_READS = 20;
/** Details read at once. */
const SURRENDER_READ_BATCH = 4;

/**
 * #317: each game's pending surrenders, by game id: read for a game being played or picked where my seat
 * still plays (at most {@link MAX_SURRENDER_READS}, war.app's order; `null` when unreadable, and absent —
 * so `null` — past the bound); every other game is an empty list, read from nothing (#327: a lobby or a
 * finished game has none, and a game I am out of owes none from me).
 * GetMyGames carries no GameFeed id, so `player` is `null`; the name is the list's, untrusted.
 */
export async function myGamesSurrenders(
  ctx: Pick<LiveContext, 'rpc' | 'bundle'>,
  games: readonly RawMyGame[],
  me: number,
): Promise<{ byGame: Map<number, PendingSurrenderView[] | null>; skipped: number }> {
  const byGame = new Map<number, PendingSurrenderView[] | null>();
  const eligible = games.filter((g) => {
    const mine = g.players.find((p) => p.id === me);
    return surrenderMayBePending(gameStateName(g.stateCode), mine ? playerStateName(mine.stateCode) : undefined);
  });
  for (const g of games) if (!eligible.includes(g)) byGame.set(g.id, []);
  const read = eligible.slice(0, MAX_SURRENDER_READS);
  for (let i = 0; i < read.length; i += SURRENDER_READ_BATCH) {
    const batch = read.slice(i, i + SURRENDER_READ_BATCH);
    const seats = await Promise.all(batch.map((g) => readDetailsSeats(ctx, g.id)));
    batch.forEach((g, j) => {
      const s = seats[j];
      const names = new Map(g.players.map((p) => [p.id, p.name]));
      byGame.set(
        g.id,
        s
          ? pendingSurrenders(s, me).map((p) => ({ ...p, name: names.has(p.inGameId) ? untrustedText(names.get(p.inGameId)) : null }))
          : null,
      );
    });
  }
  return { byGame, skipped: eligible.length - read.length };
}

/**
 * The finished games of `me` (in-game id) in a GetMyGames list where its seat was held, newest first: the
 * end-of-game sweep's candidates (#312).
 */
export function finishedGamesOf(games: readonly RawMyGame[], me: number): number[] {
  return games
    .filter((g) => isFinished(g) && g.players.some((p) => p.id === me && holdsSeat(playerStateName(p.stateCode))))
    .map((g) => g.id)
    .sort((a, b) => b - a);
}

/**
 * Also the end-of-game sweep (#312, src/tools/end-of-game.ts): the account's finished games not yet
 * processed get their pass, at most `END_OF_GAME_PER_CALL` per call (`endOfGame` in the compact answer).
 */
export function registerMyGamesTool(server: McpServer, ctx: LiveContext, deps: { env?: EnvSource } = {}): void {
  const env = deps.env ?? process.env;
  server.registerTool(
    'warapp_my_games',
    {
      title: 'List my war.app games and which need me',
      description: untrustedDescription(
        'Your war.app (Warzone) games, games waiting on you first: each with its id, name, state ' +
          '(WaitingForPlayers, DistributingTerritories, Playing, Finished), turn, players (name, state, whether ' +
          'they have committed this turn) and waitingOnYou — true when the game is being played or distributing ' +
          'territories, you are still playing, and you have not committed — and surrenderPending: the surrenders other ' +
          'players asked for that are still pending, each with owedByMe (true: waiting for you to accept it), read from ' +
          'the game details (unverified live; null when not read or unreadable, never "none"; empty without a read ' +
          'for a lobby, a finished game or a game you no longer play in, where none can wait on you); the top-level ' +
          'surrenderPending counts the games where one waits on you, and those games come first too. ' +
          'Each game also carries unreadChat, from the game list itself (no extra request): whether war.app shows unread ' +
          'chat per channel (public, team, private, group) and toMe (unread private chat is addressed to you) — flags, ' +
          'not counts; null when they did not read. Games with unread private chat come right after the ones waiting on ' +
          'you, and the top-level unreadPrivateGames counts them; read them with warapp_chat_inbox. ' +
          'Finished games are left out unless ' +
          '`include_finished` (`finishedLeftOut` counts them). `listed` is how many games war.app returned and ' +
          '`complete` false (with a `warning`) means the list may be partial. Use the id with the other warapp tools. ' +
          'Each call also gives up to two of your newest 250 finished games not yet processed their end-of-game pass (`endOfGame`: ' +
          'each game\'s history read once from GameFeed and kept name-free for later games; `pending` counts the rest). ' +
          `${BRIDGE_NOTE} Read-only.`,
      ),
      _meta: canonicalMeta('whats-new', ['my games', 'warzone', 'whose turn', 'games waiting on me', 'which games need me']),
      annotations: readAnnotations('List my war.app games'),
      inputSchema: z.object({
        view: z
          .enum(VIEWS)
          .optional()
          .describe(
            '"compact" (default): the games as described. "brief": one line per game — name — "turn N" (or the ' +
              'state when not being played) — "waiting on you" or "waiting on others", then " — unread private" and ' +
              '" — unread public, team, group" when war.app shows unread chat there, inside the untrusted-data ' +
              'envelope as data: string[]; "-- none" when there are no games, and a last "-- the list may be ' +
              'partial…" line when it may be. Brief reads no game details, so it says nothing of pending surrenders.',
          ),
        include_finished: z
          .boolean()
          .optional()
          .describe('List finished games too (default false: lobbies and games being picked or played).'),
      }),
    },
    async ({ view, include_finished }) => {
      const { me, games: raw, partial } = await fetchMyGames(ctx);
      // #312: the end-of-game sweep, bounded per call; best effort, never throws.
      const token = ctx.dataDir ? await ctx.myInviteToken().catch(() => undefined) : undefined;
      const sweep =
        token !== undefined ? await sweepFinished({ client: ctx.client, dataDir: ctx.dataDir, env }, token, finishedGamesOf(raw, me)) : undefined;
      const endOfGame = sweep && (sweep.processed.length || sweep.pending) ? { endOfGame: sweep } : {};
      const kept = include_finished ? raw : raw.filter((g) => !isFinished(g));
      const summary = summarizeMyGames(kept, me);
      if (view === 'brief') return briefResult(summary, partial ? raw.length : undefined);
      const finishedLeftOut = raw.length - kept.length;
      // #317: the surrenders pending in each game (the game details; null: not read or unreadable, never "none";
      // #327: [] without a read where none can wait on me).
      const { byGame, skipped } = await myGamesSurrenders(ctx, kept, me);
      const withSurrenders = summary.map((g) => ({ ...g, surrenderPending: byGame.get(g.id) ?? null }));
      // A game waiting on my acceptance waits on me too: it goes first with the turns waiting on me.
      const first = (g: (typeof withSurrenders)[number]) => g.waitingOnYou || surrenderOwed(g.surrenderPending);
      const games = [...withSurrenders.filter(first), ...withSurrenders.filter((g) => !first(g))];
      const unread = games.filter((g) => g.surrenderPending === null && byGame.has(g.id)).length;
      return respond(undefined, ['compact'], () => ({
        games,
        count: games.length,
        waitingOnYou: games.filter((g) => g.waitingOnYou).length,
        unreadPrivateGames: games.filter((g) => g.unreadChat?.private === true).length,
        surrenderPending: games.filter((g) => surrenderOwed(g.surrenderPending)).length,
        surrenderNote:
          SURRENDER_PENDING_NOTE +
          (unread ? ` The details of ${unread} game(s) could not be read.` : '') +
          (skipped ? ` ${skipped} more game(s) were not read (at most ${MAX_SURRENDER_READS} per call).` : ''),
        listed: raw.length,
        ...(finishedLeftOut ? { finishedLeftOut } : {}),
        complete: !partial,
        ...endOfGame,
        ...(partial
          ? {
              warning:
                `The list may be partial: war.app returned ${raw.length} games, the most this server asks for. ` +
                'A game missing here can still be read by id with warapp_get_game.',
            }
          : {}),
      }));
    },
  );
}
