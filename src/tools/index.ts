import type { McpServer } from '@modelcontextprotocol/server';
import { WarappClient, type WarappClientOptions } from '../client.js';
import type { ClassReader } from '../live.js';
import { registerBoardTool } from './board.js';
import { registerChatTools } from './chat.js';
import { registerGameTool } from './game.js';
import { registerHealthcheckTool } from './healthcheck.js';
import { createLiveContext } from './live-context.js';
import { registerLiveTools } from './live.js';
import { registerMapTool } from './map.js';
import { registerPushTools } from './push.js';
import { registerRouteTool } from './route.js';
import { registerTurnTools } from './turn.js';
import { pushListenerFor, type PushListener } from '../push/listener.js';
import { createWarappBridge, type WarappBridge } from '../transport-bridge.js';

export type ToolDeps = Pick<WarappClientOptions, 'env' | 'fetchImpl' | 'sleep' | 'mapCache'> & {
  /**
   * The process's browser bridge to war.app. index.ts builds one and passes it
   * to every connection; absent, a fresh one is built (it binds nothing until
   * its first request).
   */
  bridge?: WarappBridge;
  /** Test seam: the client bundle, instead of discovering and downloading it. */
  bundle?: () => Promise<ClassReader>;
  /** The turn-notification listener; default: the bridge's one per process. */
  push?: PushListener;
};

/** Every tool this server serves. index.ts and the tests share this list. */
export function registerAllTools(server: McpServer, deps: ToolDeps = {}): void {
  // One client for the game tools, so they share the map cache. Config is
  // deferred: the client reads credentials per call, never at construction.
  const client = new WarappClient(deps);
  const bridge = deps.bridge ?? createWarappBridge(deps.env ? { env: deps.env } : {});
  const live = createLiveContext({
    client,
    bridge,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.bundle ? { bundle: deps.bundle } : {}),
  });
  registerHealthcheckTool(server, bridge, deps);
  registerGameTool(server, client);
  registerMapTool(server, client);
  registerBoardTool(server, client, live);
  registerRouteTool(server, client);
  registerLiveTools(server, live);
  registerTurnTools(server, live);
  registerChatTools(server, live);
  // One push socket per bridge (= per process): connections share it.
  const push =
    deps.push ?? pushListenerFor(bridge, { transport: () => bridge.ready(), extras: () => live.rpc.extras });
  registerPushTools(server, live, push);
}
