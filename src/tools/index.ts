import type { McpServer } from '@modelcontextprotocol/server';
import { WarappClient, type WarappClientOptions } from '../client.js';
import { registerBoardTool } from './board.js';
import { registerGameTool } from './game.js';
import { registerHealthcheckTool } from './healthcheck.js';
import { registerMapTool } from './map.js';
import { registerRouteTool } from './route.js';
import { createWarappBridge, type WarappBridge } from '../transport-bridge.js';

export type ToolDeps = Pick<WarappClientOptions, 'env' | 'fetchImpl' | 'sleep' | 'mapCache'> & {
  /**
   * The process's browser bridge to war.app. index.ts builds one and passes it
   * to every connection; absent, a fresh one is built (it binds nothing until
   * its first request).
   */
  bridge?: WarappBridge;
};

/** Every tool this server serves. index.ts and the tests share this list. */
export function registerAllTools(server: McpServer, deps: ToolDeps = {}): void {
  // One client for the game tools, so they share the map cache. Config is
  // deferred: the client reads credentials per call, never at construction.
  const client = new WarappClient(deps);
  const bridge = deps.bridge ?? createWarappBridge(deps.env ? { env: deps.env } : {});
  registerHealthcheckTool(server, bridge, deps);
  registerGameTool(server, client);
  registerMapTool(server, client);
  registerBoardTool(server, client);
  registerRouteTool(server, client);
}
