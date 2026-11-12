import type { McpServer } from '@modelcontextprotocol/server';
import { WarappClient, type WarappClientOptions } from '../client.js';
import { registerBoardTool } from './board.js';
import { registerGameTool } from './game.js';
import { registerHealthcheckTool } from './healthcheck.js';
import { registerMapTool } from './map.js';
import { registerRouteTool } from './route.js';

export type ToolDeps = Pick<WarappClientOptions, 'env' | 'fetchImpl' | 'sleep' | 'mapCache'>;

/** Every tool this server serves. index.ts and the tests share this list. */
export function registerAllTools(server: McpServer, deps: ToolDeps = {}): void {
  // One client for the game tools, so they share the map cache. Config is
  // deferred: the client reads credentials per call, never at construction.
  const client = new WarappClient(deps);
  registerHealthcheckTool(server, deps);
  registerGameTool(server, client);
  registerMapTool(server, client);
  registerBoardTool(server, client);
  registerRouteTool(server, client);
}
