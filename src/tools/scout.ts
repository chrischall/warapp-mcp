// warapp_scout_player: an opponent's public stats and my head-to-head record
// with them, from war.app's Profile and CommonGames pages (GETs through the
// signed-in tab). Only allowlisted fields leave src/scout.ts — never location
// or any other personal detail.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { commonGamesUrl, isProfile, parseCommonGames, parseProfile, profileUrl } from '../scout.js';
import { gameIdArg, readAnnotations, respond, untrustedDescription } from './common.js';
import { lookupMeta } from './hints.js';
import type { LiveContext } from './live-context.js';
import { resolvePlayer } from './resolve.js';

/** The player's invite token (= GameFeed player id): looked up in a game, or given raw. */
async function tokenOf(ctx: LiveContext, gameId: string | number | undefined, player: string | number): Promise<string> {
  const raw = String(player).trim();
  if (gameId === undefined) {
    if (/^\d{5,20}$/.test(raw)) return raw;
    throw new McpToolError(`Pass game_id to look up ${JSON.stringify(raw)} by name, or pass the player's id.`, {
      hint: 'warapp_get_game lists each player with their id; warapp_my_games lists game ids.',
    });
  }
  const game = await ctx.client.getGame(gameId, { map: false });
  const p = resolvePlayer(game.players, raw);
  return p.feedId ?? String(p.id);
}

async function page(ctx: LiveContext, url: string, what: string): Promise<string> {
  try {
    return await ctx.fetchPage(url);
  } catch (e) {
    throw new McpToolError(`Could not read the player's ${what} page: ${e instanceof Error ? e.message : String(e)}`, {
      kind: 'unknown',
      hint: 'Make sure a signed-in war.app tab is open and paired (reload or focus it if it is frozen), then retry.',
      cause: e,
    });
  }
}

export function registerScoutTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_scout_player',
    {
      title: 'Scout a war.app player',
      description: untrustedDescription(
        'Scout a war.app (Warzone) player: name, level, multi-player games played and real-time share, when last ' +
          'seen, boot count and boot rate, ranked totals and per-format records ({format, wins, games, pct}), and your ' +
          'head-to-head — the games you share with them (id, name, started, teams, your state) with your wins, ' +
          'losses (games without teams only: in a team game they may have been your teammate, so those are counted ' +
          'as `teamGames`) and games in progress. Name the player with game_id + player (name or id), or pass just their ' +
          'player id. Reads war.app pages through your signed-in tab (ContextMint Bridge). Fields a new player ' +
          'lacks are null. Read-only.',
      ),
      _meta: lookupMeta(['scout player', 'opponent stats', 'warzone player', 'head to head', 'who am i playing']),
      annotations: readAnnotations('Scout a war.app player'),
      inputSchema: z.object({
        game_id: gameIdArg.optional(),
        player: z
          .union([z.string(), z.number()])
          .describe('The player: a name (or part of one) in game_id, or their player id (GameFeed id / invite token).'),
      }),
    },
    async ({ game_id, player }) => {
      const token = await tokenOf(ctx, game_id, player);
      const [profileHtml, commonHtml] = await Promise.all([
        page(ctx, profileUrl(token), 'profile'),
        page(ctx, commonGamesUrl(token), 'common games'),
      ]);
      const profile = parseProfile(profileHtml);
      if (!isProfile(profile)) {
        throw new McpToolError(`war.app's page for player ${token} is not a player profile.`, {
          kind: 'unknown',
          hint:
            'Either the war.app tab is signed out (sign in, or reload or focus the tab if it is frozen) or no ' +
            'player has this id — check it with warapp_get_game.',
        });
      }
      const headToHead = parseCommonGames(commonHtml);
      const { name, ...stats } = profile;
      return respond(undefined, ['compact'], () => ({
        player: { id: token, name },
        profile: stats,
        headToHead,
      }));
    },
  );
}
