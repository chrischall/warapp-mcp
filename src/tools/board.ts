import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { analyzePlayer } from '../analysis/index.js';
import type { TerritoryOwner } from '../board.js';
import type { WarappClient } from '../client.js';
import { gameIdArg, graphOf, readAnnotations, respond, untrustedDescription, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { mapOf } from './map.js';
import { resolvePlayer } from './resolve.js';

const VIEWS = ['compact', 'full'] as const;
const COMPACT_THREATS = 15;

export function registerBoardTool(server: McpServer, client: WarappClient): void {
  server.registerTool(
    'warapp_analyze_board',
    {
      title: 'Analyze a war.app board for a player',
      description: untrustedDescription(
        'Advise one player in an in-progress war.app (Warzone) game from the current board: their territories and ' +
          'armies, income (base + held bonuses), the bonuses they are closest to completing (missing territories, ' +
          'who holds them, armies needed at the game\'s kill rates), and visible enemy threats on their borders, ' +
          'with the assumptions behind the numbers. Needs a board from the API — a lobby has none. For map-only ' +
          'analysis use warapp_get_map. Read-only; it never submits orders.',
      ),
      _meta: lookupMeta(['warzone advice', 'analyze my board', 'what should i attack', 'my income']),
      annotations: readAnnotations('Analyze a war.app board'),
      inputSchema: z.object({
        game_id: gameIdArg,
        player: z
          .union([z.string(), z.number()])
          .optional()
          .describe('The player to advise: a name (or part of one) or player id — usually your own war.app name. Omit to list the players.'),
        limit: z.coerce.number().int().min(1).max(100).optional().describe('Max bonuses in closestBonuses (default 10).'),
        view: viewArg(
          VIEWS,
          `compact (default) labels owners by player name and keeps the top ${COMPACT_THREATS} threats; ` +
            '"full" is the whole analysis with player ids and every threat.',
        ),
      }),
    },
    async ({ game_id, player, limit, view }) => {
      const game = await client.getGame(game_id, { settings: true });
      if (!game.standing) {
        throw new McpToolError(
          `Board state is not available from the API for this game yet (game state: ${game.state}).`,
          {
            hint:
              'war.app\'s GameFeed has not sent a board for this game (a lobby or territory pick has none). ' +
              'warapp_get_map (bonuses, chokepoints) and warapp_plan_route work without one.',
          },
        );
      }
      const map = mapOf(game);
      const me = resolvePlayer(game.players, player);
      const a = analyzePlayer(graphOf(map), game.standing, me.id, game.settings, limit !== undefined ? { limit } : {});
      const nameOf = (id: number) => game.players.find((p) => p.id === id)?.name ?? `player ${id}`;
      const ownerLabel = (o: TerritoryOwner): string =>
        o.kind === 'player' ? nameOf(o.playerId) : o.kind === 'unknown' ? 'unknown' : o.kind;
      const territoryName = (id: number) => map.territories.find((t) => t.id === id)?.name ?? String(id);

      return respond(view, VIEWS, (rung) => {
        if (rung === 'full') {
          return { player: { id: me.id, name: me.name }, players: game.players.map((p) => ({ id: p.id, name: p.name })), ...a };
        }
        return {
          player: { id: me.id, name: me.name },
          boardVerified: a.boardVerified,
          territoryCount: a.territoryCount,
          armies: a.armies,
          income: a.income,
          closestBonuses: a.closestBonuses.map((b) => ({
            bonusId: b.bonusId,
            name: b.name,
            value: b.value,
            owned: `${b.ownedCount} of ${b.territoryCount}`,
            missing: b.missing.map((m) => ({
              territoryId: m.territoryId,
              name: m.name,
              owner: ownerLabel(m.owner),
              armies: m.armies,
              armiesToTake: m.armiesToTake,
            })),
            armiesNeeded: b.armiesNeeded,
            armiesNeededComplete: b.armiesNeededComplete,
          })),
          threats: a.threats.slice(0, COMPACT_THREATS).map((t) => ({
            territoryId: t.territoryId,
            name: t.name,
            player: nameOf(t.playerId),
            armies: t.armies,
            borders: t.adjacentTo.map(territoryName),
          })),
          assumptions: a.assumptions,
        };
      });
    },
  );
}
