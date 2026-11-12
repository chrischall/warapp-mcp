// warapp_list_open_games: the open games war.app's OpenGames page lists, decoded
// from the page's embedded payload (src/open-games.ts) — a page GET, so it works
// over the direct transport with no browser. Read-only.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { inGameId } from '../live.js';
import { filterOpenGames, markJoined, OPEN_GAMES_URL, parseOpenGamesPage } from '../open-games.js';
import { readAnnotations, respond, untrustedDescription } from './common.js';
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
        'Link a session with warapp_link_session to read it without a browser, or make sure a signed-in war.app tab ' +
        'is open and paired (reload or focus it if it is frozen), then retry.',
      cause: e,
    });
  }
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
          'no-team games. hiddenByPrerequisites counts games war.app hides from this account. Works without a ' +
          'browser once a session is linked (warapp_link_session). Read-only.',
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
      const [html, token] = await Promise.all([openGamesPage(ctx), ctx.myInviteToken()]);
      const parsed = parseOpenGamesPage(html, await ctx.bundle());
      const marked = token === undefined ? parsed.games : markJoined(parsed.games, parsed.lobbies, inGameId({ id: token }));
      const games = filterOpenGames(marked, {
        ...(pace ? { pace } : {}),
        ...(max_players !== undefined ? { max_players } : {}),
        ...(free_only !== undefined ? { free_only } : {}),
        ...(exclude_teams !== undefined ? { exclude_teams } : {}),
        limit: limit ?? 25,
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
