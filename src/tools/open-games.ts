// warapp_list_open_games: the open games war.app's OpenGames page lists, decoded
// from the page's embedded payload (src/open-games.ts) — a page GET, so it works
// over the direct transport with no browser. Read-only.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  filterOpenGames,
  joiningPolicy,
  lotteryOf,
  lotteryShape,
  markJoined,
  withLottery,
  OPEN_GAMES_URL,
  parseOpenGamesPage,
  type OpenGame,
} from '../open-games.js';
import { readAnnotations, respond, untrustedDescription } from './common.js';
import { noBrowserNote } from './session.js';
import { lookupMeta } from './hints.js';
import type { LiveContext } from './live-context.js';

/** The OpenGames page as text, or a tool error with a hint. */
export async function openGamesPage(ctx: LiveContext): Promise<string> {
  try {
    return await ctx.fetchPage(OPEN_GAMES_URL);
  } catch (e) {
    throw new McpToolError(`Could not read war.app's open games page: ${e instanceof Error ? e.message : String(e)}`, {
      kind: 'unknown',
      hint:
        (ctx.hosted ? 'Make sure' : 'Link a session with warapp_link_session to read it without a browser, or make sure') +
        ' a signed-in war.app tab is open and paired (reload or focus it if it is frozen), then retry.',
      cause: e,
    });
  }
}

/** At most this many lobbies' maps are fetched from GameFeed per call to tell a lottery (#217). */
export const LOTTERY_LOOKUPS = 5;

/** A lobby's map size: the cached map, else (when `fetch`) GameFeed's; undefined when unread. */
async function territoryCount(ctx: LiveContext, game: OpenGame, fetch: boolean): Promise<number | undefined> {
  const cached = ctx.client.cachedMap(game.mapId);
  if (cached) return cached.territories.length;
  if (!fetch) return undefined;
  try {
    return (await ctx.client.getGame(game.id))?.map?.territories.length;
  } catch {
    return undefined;
  }
}

/**
 * `games` with `lottery` / `lotteryBasis` set where the data says so (#217, {@link lotteryOf}): a
 * cached map is used for every game; GameFeed is asked (map included) only for lobbies whose
 * settings fit the lottery shape, at most {@link LOTTERY_LOOKUPS} per call. Never throws.
 */
export async function markLotteries(ctx: LiveContext, games: readonly OpenGame[]): Promise<OpenGame[]> {
  let lookups = 0;
  const fetchFor = games.map((g) => lotteryShape(g) && !ctx.client.cachedMap(g.mapId) && lookups++ < LOTTERY_LOOKUPS);
  return Promise.all(
    games.map(async (g, i) => {
      const verdict = lotteryOf(g, await territoryCount(ctx, g, fetchFor[i]!));
      return verdict ? withLottery(g, verdict) : g;
    }),
  );
}

export function registerOpenGamesTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_list_open_games',
    {
      title: 'List open war.app games to join',
      description: untrustedDescription(
        'Open war.app (Warzone) games you could join, from war.app\'s Open Games page: each with its id, name, url, ' +
          'pace (multi-day or real-time), boot time, players seated, open seats, seats in all, team game or not, ' +
          'map id, entry fee and prize in coins, cards, rules (the settings flags the game carries, in war.app\'s ' +
          'wording) and plannerGaps — rules the turn planner does not model yet. joined: true marks a game you ' +
          'already hold a seat in (when the signed-in account can be told). By default only free, multi-day, ' +
          'no-team games. policyBreaks lists the joining-policy rules a game breaks (Commerce, mods, custom ' +
          'scenarios, more than four seats, a boot time under 12 hours, a lottery (a likely one too)); the neutral cost is checked by ' +
          'warapp_join_game\'s preview. lottery: true marks a lottery from the data, never the name — a map of at ' +
          'most four territories (its size read from GameFeed for lobbies with base income 0 and overridden ' +
          'bonuses, or from a map already cached); lottery: null is that settings shape with the map size unread; ' +
          'lotteryBasis says which. hiddenByPrerequisites counts games war.app hides from this account.' +
          `${noBrowserNote(ctx.hosted)} Read-only.`,
      ),
      _meta: lookupMeta(['open games', 'find a game', 'join a game', 'new warzone game', 'games to join']),
      annotations: readAnnotations('List open war.app games'),
      inputSchema: z.object({
        pace: z
          .enum(['multi-day', 'real-time', 'both'])
          .optional()
          .describe('Game pace (default multi-day).'),
        max_players: z.number().int().positive().optional().describe('At most this many seats in the game.'),
        free_only: z.boolean().optional().describe('Only games without a coin entry fee (default true).'),
        exclude_teams: z.boolean().optional().describe('Leave out team games (default true).'),
        limit: z.number().int().positive().max(200).optional().describe('At most this many games (default 25).'),
      }),
    },
    async ({ pace, max_players, free_only, exclude_teams, limit }) => {
      const [html, myId] = await Promise.all([openGamesPage(ctx), ctx.myInGameId()]);
      const parsed = parseOpenGamesPage(html, await ctx.bundle());
      const marked = myId === undefined ? parsed.games : markJoined(parsed.games, parsed.lobbies, myId);
      const filtered = filterOpenGames(marked, {
        ...(pace ? { pace } : {}),
        ...(max_players !== undefined ? { max_players } : {}),
        ...(free_only !== undefined ? { free_only } : {}),
        ...(exclude_teams !== undefined ? { exclude_teams } : {}),
        limit: limit ?? 25,
      });
      // #134: advisory — the neutral-cost part needs each lobby's GameFeed settings, so only the join preview has it.
      const games = (await markLotteries(ctx, filtered)).map((g) => {
        const { breaks } = joiningPolicy(g, null);
        return breaks.length ? { ...g, policyBreaks: breaks } : g;
      });
      return respond(undefined, ['compact'], () => ({
        games,
        count: games.length,
        listed: parsed.games.length,
        ...(parsed.hiddenByPrerequisites !== undefined ? { hiddenByPrerequisites: parsed.hiddenByPrerequisites } : {}),
        ...(parsed.note ? { warning: parsed.note } : {}),
      }));
    },
  );
}
