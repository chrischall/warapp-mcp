// warapp_map_stats: what has worked on a map, learned from finished ladder
// games — OPT-IN (WARAPP_STATS=1) and never on a hosted server. See
// src/stats.ts (collection, throttle, cache) and src/map-stats.ts (the pure
// aggregation).
import { McpToolError, type EnvSource } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { MapCache } from '../client.js';
import { MIN_RATE_SAMPLE, MIN_SAMPLE, mapStats, type MapStats } from '../map-stats.js';
import type { GameMap } from '../normalize.js';
import { DEFAULT_NEW_GAMES, MAX_NEW_GAMES, STATS_ENV, statsGate, type CollectResult, type StatsCollector, type StatsGate } from '../stats.js';
import { readAnnotations, respond, untrustedDescription } from './common.js';
import { lookupMeta } from './hints.js';

function refusal(gate: Exclude<StatsGate, { enabled: true }>): McpToolError {
  if (gate.reason === 'hosted') {
    return new McpToolError('Map statistics are off on a hosted server.', {
      hint:
        'They make many war.app requests and keep a cache on disk, so they run only on a local install with ' +
        `${STATS_ENV}=1 set. Use warapp_get_map for the map's bonuses meanwhile.`,
    });
  }
  return new McpToolError('Map statistics are off (opt-in).', {
    hint:
      `Set ${STATS_ENV}=1 in this server's environment (or its .env file) on a local install and restart it. ` +
      `Each call then fetches up to ${DEFAULT_NEW_GAMES} new finished ladder games (at most ${MAX_NEW_GAMES}), ` +
      'one request a second, and caches them forever.',
  });
}

/** Attach territory and bonus names when the map is known (cached this process). */
function named(stats: MapStats, map: GameMap | undefined) {
  const territory = new Map(map?.territories.map((t) => [t.id, t.name]));
  const bonus = new Map(map?.bonuses.map((b) => [b.id, b.name]));
  return {
    ...stats,
    mostPicked: stats.mostPicked.map(({ territoryId, ...rest }) => ({
      territoryId,
      ...(territory.has(territoryId) ? { name: territory.get(territoryId) } : {}),
      ...rest,
    })),
    winRateByStartingBonus: stats.winRateByStartingBonus.map(({ bonusId, ...rest }) => ({
      bonusId,
      ...(bonus.has(bonusId) ? { name: bonus.get(bonusId) } : {}),
      ...rest,
    })),
  };
}

export function registerMapStatsTool(
  server: McpServer,
  deps: { collector: StatsCollector; mapCache: MapCache; env?: EnvSource },
): void {
  server.registerTool(
    'warapp_map_stats',
    {
      title: 'war.app map statistics',
      description: untrustedDescription(
        'Statistics for a war.app (Warzone) map learned from finished ladder games: the most-picked starting ' +
          'territories (and how often their pickers won), the win rate by every bonus a player started in, the ' +
          'turn of each player’s first bonus completion, and the sample size — a sample under ' +
          `${MIN_SAMPLE} games and a bonus rate under ${MIN_RATE_SAMPLE} players are flagged, and games whose history ` +
          'could not be read are counted apart, never cached. Each call reads the ladder’s game-ID feed and fetches up to ' +
          `max_new_games new games (default ${DEFAULT_NEW_GAMES}, max ${MAX_NEW_GAMES}, one request a second); ` +
          'finished games are cached forever, so stats grow across calls. OPT-IN: off unless the server runs ' +
          `locally with ${STATS_ENV}=1, and always off when hosted. Read-only.`,
      ),
      _meta: lookupMeta(['map stats', 'best starting picks', 'ladder statistics', 'which bonus wins']),
      annotations: readAnnotations('war.app map statistics'),
      inputSchema: z.object({
        map_id: z.number().int().positive().describe('The map id (warapp_get_game names it under settings.mapId).'),
        ladder_id: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('The ladder whose games to learn from: 1v1 is 0 (default), 2v2 is 1, 3v3 is 4.'),
        max_new_games: z
          .number()
          .int()
          .min(0)
          .max(MAX_NEW_GAMES)
          .optional()
          .describe(`New games to fetch this call (default ${DEFAULT_NEW_GAMES}, max ${MAX_NEW_GAMES}); 0 reads the cache only.`),
      }),
    },
    async ({ map_id, ladder_id, max_new_games }) => {
      const gate = statsGate(deps.env);
      if (!gate.enabled) throw refusal(gate);
      const ladderId = ladder_id ?? 0;
      // 0 reads the cache only: no feed request, so no throttle either.
      let collected: CollectResult | { ladderId: number; cacheOnly: true } | undefined = { ladderId, cacheOnly: true };
      let warning: string | undefined;
      let feedError: unknown;
      if (max_new_games !== 0) {
        try {
          collected = await deps.collector.collect(ladderId, max_new_games ?? DEFAULT_NEW_GAMES);
        } catch (e) {
          collected = undefined;
          feedError = e;
        }
      }
      const records = await deps.collector.records(map_id);
      if (feedError !== undefined) {
        // The feed failed: the cache can still answer; with nothing cached the error stands.
        if (records.length === 0) throw feedError;
        const why = feedError instanceof Error ? feedError.message : String(feedError);
        warning = `The game-ID feed failed (${why}), so no new games were collected; these stats are from the cache.`;
      }
      const [stats] = mapStats(records);
      const map = deps.mapCache.get(map_id);
      return respond(undefined, ['compact'], () => ({
        map: map ? { id: map.id, name: map.name } : { id: map_id },
        ...(collected ? { collected } : {}),
        ...(warning ? { warning } : {}),
        ...(stats
          ? { stats: named(stats, map) }
          : {
              message:
                `No finished games on map ${map_id} are cached yet. Ladder games use many maps: call again to ` +
                'collect more, or try the ladder this map is played on.',
            }),
        assumptions:
          'Starting territories are read from the first history board where players hold land (a game with no ' +
          'such board is left out and counted in unreadableGames), a player counts toward every bonus holding one ' +
          'of its starts, and a bonus ' +
          'turn is the history entry (completed turns) on which a player first held a whole positive bonus. ' +
          'The game-ID feed and history shapes are unverified (docs/WARAPP-API.md).',
      }));
    },
  );
}
