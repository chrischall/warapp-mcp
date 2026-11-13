import type { McpServer } from '@modelcontextprotocol/server';
import { defaultMapCache, WarappClient, type WarappClientOptions } from '../client.js';
import { dataDir } from '../config.js';
import { StatsCollector } from '../stats.js';
import type { ClassReader } from '../live.js';
import { registerBeginTurnTool } from './begin-turn.js';
import { registerBoardTool } from './board.js';
import { registerChatTools } from './chat.js';
import { registerCheckPlanTool } from './check-plan.js';
import { registerGameTool } from './game.js';
import { registerHealthcheckTool } from './healthcheck.js';
import { createLiveContext } from './live-context.js';
import { registerJoinGameTool } from './join-game.js';
import { registerLiveTools } from './live.js';
import { registerMapTool } from './map.js';
import { registerMapStatsTool } from './map-stats.js';
import { registerMyGamesTool } from './my-games.js';
import { registerOpenGamesTool } from './open-games.js';
import { registerOpponentsTool } from './opponents.js';
import { registerPickTools } from './picks.js';
import { registerPushTools } from './push.js';
import { registerRouteTool } from './route.js';
import { registerScoutTool } from './scout.js';
import { registerSessionTools } from './session.js';
import { registerStrategyTool } from './strategy.js';
import { registerSurrenderTool } from './surrender.js';
import { registerTurnTools } from './turn.js';
import { registerUncommitTool } from './uncommit.js';
import { pushListenerFor, type PushListener } from '../push/listener.js';
import { pushWebSocketLeg } from '../push/websocket.js';
import { readSession } from '../direct/session.js';
import { createDirectFirstBridge, type DirectFetch } from '../direct/transport.js';
import { isHosted } from '../hosted.js';
import { createWarappBridge, type WarappBridge } from '../transport-bridge.js';

export type ToolDeps = Pick<WarappClientOptions, 'env' | 'fetchImpl' | 'sleep' | 'mapCache'> & {
  /**
   * The process's browser bridge to war.app (the fetchproxy leg). index.ts
   * builds one and passes it to every connection; absent, a fresh one is built
   * (it binds nothing until its first request). It is the FALLBACK leg: the
   * direct-first router below wraps it and prefers the chrome-less direct leg.
   */
  bridge?: WarappBridge;
  /** Test seam: the client bundle, instead of discovering and downloading it. */
  bundle?: () => Promise<ClassReader>;
  /** The turn-notification listener; default: the bridge's one per process. */
  push?: PushListener;
  /** Test seam: the direct leg's HTTPS primitive (default netguard `fetchPublic`). */
  directFetch?: DirectFetch;
};

/** Every tool this server serves. index.ts and the tests share this list. */
export function registerAllTools(server: McpServer, deps: ToolDeps = {}): void {
  // One client for the game tools, so they share the map cache. Config is
  // deferred: the client reads credentials per call, never at construction.
  const client = new WarappClient(deps);
  const env = deps.env as NodeJS.ProcessEnv | undefined;
  // The process's browser bridge (fetchproxy), shared across connections.
  const fetchproxy = deps.bridge ?? createWarappBridge(env ? { env } : {});
  // Wrap it in the direct-first router: the chrome-less AuthToken leg
  // (src/direct/) serves calls when a session is linked and falls back to the
  // browser bridge otherwise (WARAPP_TRANSPORT: auto default | direct |
  // fetchproxy). WarappRpc, the page fetches, the healthcheck and the push
  // socket all take this one bridge, so they all gain direct mode at once.
  // Direct mode is LOCAL-ONLY (src/hosted.ts): on a hosted child the router is
  // pinned to the browser bridge, the session store reads as empty and
  // warapp_link_session is not registered.
  const hosted = isHosted(env ?? process.env);
  const bridge = createDirectFirstBridge({
    store: { read: () => readSession(deps.env) },
    makeBridge: () => fetchproxy,
    ...(env ? { env } : {}),
    ...(deps.directFetch ? { directFetch: deps.directFetch } : {}),
  });
  const live = createLiveContext({
    client,
    bridge,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.bundle ? { bundle: deps.bundle } : {}),
    // The cached signed-in account is discarded whenever the account behind the router may have changed.
    identity: () => bridge.identityState(),
  });
  registerHealthcheckTool(server, fetchproxy, bridge, deps);
  registerGameTool(server, client);
  registerMapTool(server, client);
  // Opt-in (WARAPP_STATS=1), never hosted: the tool refuses before any request
  // when off. One collector per registration, so its 1 s throttle spans calls.
  registerMapStatsTool(server, {
    collector: new StatsCollector({
      client,
      dir: () => dataDir(deps.env),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    }),
    mapCache: deps.mapCache ?? defaultMapCache,
    ...(deps.env ? { env: deps.env } : {}),
  });
  registerBoardTool(server, client, live);
  registerRouteTool(server, client);
  registerStrategyTool(server, client);
  registerLiveTools(server, live);
  registerPickTools(server, live);
  registerMyGamesTool(server, live);
  registerOpenGamesTool(server, live);
  registerJoinGameTool(server, live);
  registerSurrenderTool(server, live);
  registerBeginTurnTool(server, live);
  registerScoutTool(server, live);
  registerTurnTools(server, live);
  registerCheckPlanTool(server, live);
  registerOpponentsTool(server, live);
  registerUncommitTool(server, live);
  registerChatTools(server, live);
  // One push socket per process: keyed on the shared fetchproxy bridge so
  // connections share it, with requests routed through the direct-first bridge.
  // While the direct leg is active the push rides a direct WebSocket (the
  // cookie goes only to war.app); otherwise, or when the WebSocket cannot come
  // up, it keeps xhr-polling over the bridge.
  const push =
    deps.push ??
    pushListenerFor(fetchproxy, {
      transport: () => bridge.ready(),
      webSocket: pushWebSocketLeg(bridge, () => readSession(deps.env)),
      extras: () => live.rpc.extras,
    });
  registerSessionTools(server, {
    transport: {
      activeLeg: () => bridge.status().transport,
      sessionStale: () => bridge.sessionStale(),
      sessionLinked: () => bridge.sessionLinked(),
    },
    pushTransport: () => push.status().transport,
    decoder: () => live.decoderReport(),
    identityChanged: () => live.forgetIdentity(),
    hosted,
    ...(env ? { env } : {}),
  });
  registerPushTools(server, live, push);
}
