import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { shortestPath } from '../analysis/index.js';
import type { WarappClient } from '../client.js';
import { gameIdArg, graphOf, readAnnotations, respond, untrustedDescription, untrustedText } from './common.js';
import { lookupMeta } from './hints.js';
import { mapOf } from './map.js';
import { resolveTerritory } from './resolve.js';

const territoryArg = (end: string) =>
  z.union([z.string(), z.number()]).describe(`The ${end} territory: its id, its name, or a unique part of its name.`);

export function registerRouteTool(server: McpServer, client: WarappClient): void {
  server.registerTool(
    'warapp_plan_route',
    {
      title: 'Plan a route between two war.app territories',
      description: untrustedDescription(
        'Find the shortest path between two territories on a war.app (Warzone) game\'s map — how many moves apart ' +
          'they are and every territory on the way, by name. Territories can be given by id or by name. ' +
          'Map-only (ignores who holds what). Read-only.',
      ),
      _meta: lookupMeta(['warzone route', 'path between territories', 'how far is']),
      annotations: readAnnotations('Plan a war.app route'),
      inputSchema: z.object({ game_id: gameIdArg, from: territoryArg('starting'), to: territoryArg('destination') }),
    },
    async ({ game_id, from, to }) => {
      const game = await client.getGame(game_id);
      const map = mapOf(game);
      const a = resolveTerritory(map, from);
      const b = resolveTerritory(map, to);
      const path = shortestPath(graphOf(map), a.id, b.id);
      // Territory and map names are map-maker text: delimited, since errors sit outside the untrusted envelope.
      if (!path) {
        throw new McpToolError(
          `No route connects ${untrustedText(a.name)} (${a.id}) and ${untrustedText(b.name)} (${b.id}) on map ${map.id} (${untrustedText(map.name)}).`,
        );
      }
      const byId = new Map(map.territories.map((t) => [t.id, t.name]));
      return respond(undefined, ['compact'], () => ({
        from: { id: a.id, name: a.name },
        to: { id: b.id, name: b.name },
        hops: path.length - 1,
        path: path.map((id) => ({ id, name: byId.get(id)! })),
      }));
    },
  );
}
