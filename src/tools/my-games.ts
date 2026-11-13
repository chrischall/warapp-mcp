// warapp_my_games: the signed-in account's games through the web client's
// GetMyGames, with which ones are waiting on me — the group's canonical
// "what's new" tool, so it also answers `view: 'brief'`.
import { McpToolError, untrustedEnvelope } from '@chrischall/mcp-utils';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { briefGameLine, readMyGames, summarizeMyGames, type MyGame, type RawMyGame } from '../my-games.js';
import { Method, writeGetMyGamesParams } from '../protocol/methods.js';
import { readAnnotations, respond, untrustedDescription, WARAPP_UNTRUSTED_NOTE } from './common.js';
import { canonicalMeta } from './hints.js';
import type { LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';

const VIEWS = ['compact', 'brief'] as const;

function briefResult(games: readonly MyGame[]): CallToolResult {
  const lines = games.length ? games.map(briefGameLine) : ['-- none'];
  return { content: [{ type: 'text', text: JSON.stringify(untrustedEnvelope(lines, { note: WARAPP_UNTRUSTED_NOTE })) }] };
}

/** The signed-in account's in-game id; refuses when it cannot be read. */
async function myInGameId(ctx: LiveContext): Promise<number> {
  const me = await ctx.myInGameId();
  if (me === undefined) {
    throw new McpToolError('Could not tell which account is signed in to war.app, so its games cannot be listed.', {
      hint: 'Make sure a signed-in war.app tab is open and paired, then retry.',
    });
  }
  return me;
}

/** The signed-in account's in-game id and its games, through GetMyGames. */
export async function fetchMyGames(ctx: LiveContext): Promise<{ me: number; games: RawMyGame[] }> {
  const [me, env] = await Promise.all([
    myInGameId(ctx),
    ctx.rpc.call('GetMyGames', Method.GetMyGames, (w) => writeGetMyGamesParams(w)),
  ]);
  return { me, games: readMyGames(await ctx.bundle(), env.body) };
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
          'territories, you are still playing, and you have not committed. Use the id with the other warapp tools. ' +
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
              'envelope as data: string[]; "-- none" when there are no games.',
          ),
      }),
    },
    async ({ view }) => {
      const { me, games: raw } = await fetchMyGames(ctx);
      const games = summarizeMyGames(raw, me);
      if (view === 'brief') return briefResult(games);
      return respond(undefined, ['compact'], () => ({
        games,
        count: games.length,
        waitingOnYou: games.filter((g) => g.waitingOnYou).length,
      }));
    },
  );
}
