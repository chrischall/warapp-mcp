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
import { untrustedEnvelope } from '@chrischall/mcp-utils';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { briefGameLine, isFinished, readMyGames, summarizeMyGames, type MyGame, type RawMyGame } from '../my-games.js';
import { Method, MY_GAMES_DEFAULT_SORT, MyGamesFilterType, writeGetMyGamesParams, type MyGamesFilters } from '../protocol/methods.js';
import { readAnnotations, respond, untrustedDescription, WARAPP_UNTRUSTED_NOTE } from './common.js';
import { canonicalMeta } from './hints.js';
import type { LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { accountUnknown } from './write-kit.js';

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
    throw accountUnknown(ctx.hosted, 'its games cannot be listed');
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

export function registerMyGamesTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_my_games',
    {
      title: 'List my war.app games and which need me',
      description: untrustedDescription(
        'Your war.app (Warzone) games, games waiting on you first: each with its id, name, state ' +
          '(WaitingForPlayers, DistributingTerritories, Playing, Finished), turn, players (name, state, whether ' +
          'they have committed this turn) and waitingOnYou — true when the game is being played or distributing ' +
          'territories, you are still playing, and you have not committed. Finished games are left out unless ' +
          '`include_finished` (`finishedLeftOut` counts them). `listed` is how many games war.app returned and ' +
          '`complete` false (with a `warning`) means the list may be partial. Use the id with the other warapp tools. ' +
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
              'state when not being played) — "waiting on you" or "waiting on others", inside the untrusted-data ' +
              'envelope as data: string[]; "-- none" when there are no games, and a last "-- the list may be ' +
              'partial…" line when it may be.',
          ),
        include_finished: z
          .boolean()
          .optional()
          .describe('List finished games too (default false: lobbies and games being picked or played).'),
      }),
    },
    async ({ view, include_finished }) => {
      const { me, games: raw, partial } = await fetchMyGames(ctx);
      const kept = include_finished ? raw : raw.filter((g) => !isFinished(g));
      const games = summarizeMyGames(kept, me);
      if (view === 'brief') return briefResult(games, partial ? raw.length : undefined);
      const finishedLeftOut = raw.length - kept.length;
      return respond(undefined, ['compact'], () => ({
        games,
        count: games.length,
        waitingOnYou: games.filter((g) => g.waitingOnYou).length,
        listed: raw.length,
        ...(finishedLeftOut ? { finishedLeftOut } : {}),
        complete: !partial,
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
