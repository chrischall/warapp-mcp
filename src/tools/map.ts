import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { analyzeBonuses, applyBonusOverrides, findChokepoints, type BonusAnalysis, type MapGraph } from '../analysis/index.js';
import type { WarappClient } from '../client.js';
import type { Game, GameMap } from '../normalize.js';
import { gameIdArg, graphOf, mapSummary, readAnnotations, respond, round2, untrustedDescription, untrustedText, viewArg } from './common.js';
import { lookupMeta } from './hints.js';

const VIEWS = ['compact', 'full'] as const;
const DEFAULT_LIMIT = 25;
const COMPACT_CHOKEPOINTS = 20;

type Sort = 'easiest' | 'value' | 'name';

const SORTS: Record<Sort, (a: BonusAnalysis, b: BonusAnalysis) => number> = {
  easiest: (a, b) =>
    b.score - a.score || b.value - a.value || a.territoryIds.length - b.territoryIds.length || a.bonusId - b.bonusId,
  value: (a, b) => b.value - a.value || b.score - a.score || a.bonusId - b.bonusId,
  name: (a, b) => a.name.localeCompare(b.name) || a.bonusId - b.bonusId,
};

/**
 * The game's map with the game's bonus values (its `OverriddenBonuses` applied —
 * load the game with `settings: true`), or a clear error when the feed did not send one.
 */
export function mapOf(game: Game): GameMap {
  if (game.map) return applyBonusOverrides(game.map, game.settings);
  throw new McpToolError(`war.app sent no map for game ${game.id}.`, {
    hint: 'Try again in a moment; if it persists the game may not have a map assigned yet.',
  });
}

const named = (g: MapGraph, ids: readonly number[]) =>
  ids.map((id) => ({ id, name: g.territoryById.get(id)?.name ?? String(id) }));

const row = (b: BonusAnalysis) => ({
  bonusId: b.bonusId,
  name: b.name,
  value: b.value,
  territories: b.territoryIds.length,
  borders: b.borderTerritoryIds.length,
  entryPoints: b.entryPointIds.length,
  valuePerTerritory: round2(b.valuePerTerritory),
  score: round2(b.score),
});

function detail(g: MapGraph, b: BonusAnalysis) {
  const out: Record<string, unknown> = {
    bonusId: b.bonusId,
    name: b.name,
    value: b.value,
    territories: named(g, b.territoryIds),
    borders: named(g, b.borderTerritoryIds),
    entryPoints: named(g, b.entryPointIds),
    valuePerTerritory: round2(b.valuePerTerritory),
    valuePerBorder: round2(b.valuePerBorder),
    score: round2(b.score),
  };
  if (b.isSuperbonus) {
    out.memberBonuses = b.memberBonusIds.map((id) => ({ id, name: g.bonusById.get(id)?.name ?? String(id) }));
  }
  return out;
}

function chokepoints(g: MapGraph, limit?: number) {
  const all = findChokepoints(g);
  const bonusName = (id: number | null) => (id === null ? null : (g.bonusById.get(id)?.name ?? String(id)));
  return (limit === undefined ? all : all.slice(0, limit)).map((c) => ({
    territoryId: c.territoryId,
    name: c.name,
    degree: c.degree,
    reasons: c.reasons,
    bonus: bonusName(c.bonusId),
    connects: c.connectsBonusIds.map((id) => bonusName(id)),
  }));
}

export function registerMapTool(server: McpServer, client: WarappClient): void {
  server.registerTool(
    'warapp_get_map',
    {
      title: 'Get a war.app game map: bonuses and chokepoints',
      description: untrustedDescription(
        'Analyze the map of a war.app (Warzone) game: a bonus table ranked easiest-to-take first (army value, ' +
          'territory count, border territories to defend, entry points, value per territory, ease score) and the ' +
          'map\'s chokepoints (articulation points, bridges between regions, narrow connectors). Filter with ' +
          '`bonus` (part of a bonus name) to see one bonus\'s territories, borders and entry points by name. ' +
          'Map-only — needs no board, so it works in a lobby. Read-only.',
      ),
      _meta: lookupMeta(['warzone map', 'best bonuses', 'easiest bonus', 'chokepoints']),
      annotations: readAnnotations('Get a war.app map'),
      inputSchema: z.object({
        game_id: gameIdArg,
        bonus: z.string().optional().describe('Only bonuses whose name contains this (case-insensitive); rows list member territories by name.'),
        sort: z
          .enum(['easiest', 'value', 'name'])
          .optional()
          .describe('Bonus order: "easiest" (default — ease score = value / (territories + borders)), "value", or "name".'),
        limit: z.coerce.number().int().min(1).max(1000).optional().describe(`Max bonus rows (default ${DEFAULT_LIMIT} on compact; all on full).`),
        view: viewArg(
          VIEWS,
          `compact (default) keeps positive-value bonuses as one-line rows (counts, value per territory, score) and the top ${COMPACT_CHOKEPOINTS} chokepoints; ` +
            '"full" lists every bonus (zero and negative included) with member, border and entry-point territories by name, and every chokepoint.',
        ),
      }),
    },
    async ({ game_id, bonus, sort, limit, view }) => {
      // Settings carry the game's overridden bonus values, which the bonus table reports.
      const game = await client.getGame(game_id, { settings: true });
      const map = mapOf(game);
      const g = graphOf(map);
      const order = SORTS[sort ?? 'easiest'];
      return respond(view, VIEWS, (rung) => {
        const all = analyzeBonuses(g);
        if (bonus !== undefined && bonus.trim()) {
          const q = bonus.trim().toLowerCase();
          const hits = all.filter((b) => b.name.toLowerCase().includes(q)).sort(order);
          if (!hits.length) {
            // The map name is map-maker text: delimited, since errors sit outside the untrusted envelope.
            throw new McpToolError(`No bonus on map ${map.id} (${untrustedText(map.name)}) matches ${JSON.stringify(bonus)}.`, {
              hint: 'Use part of the bonus name as the game spells it, or omit `bonus` to list the ranked table.',
            });
          }
          const shown = hits.slice(0, limit ?? DEFAULT_LIMIT);
          return { map: mapSummary(map), bonuses: shown.map((b) => detail(g, b)), bonusesShown: `${shown.length} of ${hits.length}` };
        }
        if (rung === 'full') {
          const sorted = all.sort(order);
          const shown = limit === undefined ? sorted : sorted.slice(0, limit);
          return {
            map: mapSummary(map),
            bonuses: shown.map((b) => detail(g, b)),
            bonusesShown: `${shown.length} of ${sorted.length}`,
            chokepoints: chokepoints(g),
          };
        }
        const positive = all.filter((b) => b.value >= 1).sort(order);
        const shown = positive.slice(0, limit ?? DEFAULT_LIMIT);
        const hidden = all.length - positive.length;
        return {
          map: mapSummary(map),
          bonuses: shown.map(row),
          bonusesShown: `${shown.length} of ${positive.length}`,
          // #70: say what compact leaves out (the turn planner always counts every bonus).
          ...(hidden
            ? {
                bonusesHidden: `${hidden} zero- or negative-value bonuses not listed (view "full" or a \`bonus\` filter shows them; the turn planner counts every bonus)`,
              }
            : {}),
          chokepoints: chokepoints(g, COMPACT_CHOKEPOINTS),
        };
      });
    },
  );
}
