import type { McpServer } from '@modelcontextprotocol/server';
import { defaultMapCache, WarappClient, type WarappClientOptions } from '../client.js';
import { captureSeats } from './decision-capture.js';
import { dataDir } from '../config.js';
import { StatsCollector } from '../stats.js';
import type { ClassReader } from '../live.js';
import { registerBeginTurnTool } from './begin-turn.js';
import { registerBoardTool } from './board.js';
import { registerChatTools } from './chat.js';
import { registerChatInboxTool } from './chat-inbox.js';
import { registerMarkChatReadTool } from './chat-read-mark.js';
import { registerCheckPlanTool } from './check-plan.js';
import { registerGameTool } from './game.js';
import { registerHealthcheckTool } from './healthcheck.js';
import { createLiveContext } from './live-context.js';
import { registerJoinGameTool } from './join-game.js';
import { registerLiveTools } from './live.js';
import { registerMapTool } from './map.js';
import { registerMapStatsTool } from './map-stats.js';
import { fetchMyGames, registerMyGamesTool } from './my-games.js';
import { registerNotificationTools } from './notifications.js';
import { registerOpenGamesTool } from './open-games.js';
import { registerOpponentsTool } from './opponents.js';
import { registerPickTools } from './picks.js';
import { registerPushTools } from './push.js';
import { registerRelationsTools } from './relations.js';
import { registerDiplomacyTool } from './diplomacy.js';
import { registerModAlliancesTool } from './mod-alliances.js';
import { registerRouteTool } from './route.js';
import { registerScoutTool } from './scout.js';
import { registerSessionTools } from './session.js';
import { paceStatus } from './pace.js';
import { registerStrategyTool } from './strategy.js';
import { registerSurrenderTool } from './surrender.js';
import { registerAcceptSurrenderTool } from './accept-surrender.js';
import { registerTeamTool } from './team.js';
import { registerTeamBriefTool } from './team-brief.js';
import { registerTurnTools } from './turn.js';
import { registerMyOrdersTool } from './my-orders.js';
import { registerUncommitTool } from './uncommit.js';
import { registerLeaveGameTool } from './leave-game.js';
import { registerWhereTool } from './where.js';
import { registerStateTools } from './state.js';
import { blobStoreFromEnv, type BlobStore } from '@chrischall/mcp-utils/export';
import { registerProfileOpponentsTool } from './profile-opponents.js';
import { pushListenerFor, type PushListener } from '../push/listener.js';
import { pushWebSocketLeg } from '../push/websocket.js';
import { readSession } from '../direct/session.js';
import { createDirectFirstBridge, type DirectFetch } from '../direct/transport.js';
import { isHosted } from '../hosted.js';
import { registerSignInTool, type SignInToolDeps } from './sign-in.js';
import { createWarappBridge, type WarappBridge } from '../transport-bridge.js';

type ToolDeps = Pick<WarappClientOptions, 'env' | 'fetchImpl' | 'sleep' | 'mapCache'> & {
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
  /** Test seam: the direct leg's HTTPS primitive (default netguard `fetchPublic`, through the egress proxy when one is set). */
  directFetch?: DirectFetch;
  /** Test seam: warapp_sign_in's sign-in (hosted only; default src/direct/sign-in.ts). */
  signIn?: SignInToolDeps['signIn'];
  /** The mcp-host blob store (default: from `MCP_BLOB_BASE_URL`; `null`: none). With one, warapp_upload_slots and warapp_import_state are registered. */
  blobStore?: BlobStore | null;
};

/** Every tool this server serves. index.ts and the tests share this list. */
export function registerAllTools(server: McpServer, deps: ToolDeps = {}): void {
  // One client for the game tools, so they share the map cache. Config is
  // deferred: the client reads credentials per call, never at construction.
  // The map cache is kept on disk too (`<dataDir>/maps/`, src/map-store.ts),
  // local and hosted (a hosted child's per-user data dir persists).
  const client = new WarappClient({ ...deps, dataDir: () => dataDir(deps.env) });
  const env = deps.env as NodeJS.ProcessEnv | undefined;
  // The process's browser bridge (fetchproxy), shared across connections.
  const fetchproxy = deps.bridge ?? createWarappBridge(env ? { env } : {});
  // Wrap it in the direct-first router: the chrome-less AuthToken leg
  // (src/direct/) serves calls when a session is linked and falls back to the
  // browser bridge otherwise (WARAPP_TRANSPORT: auto default | direct |
  // fetchproxy). WarappRpc, the page fetches, the healthcheck and the push
  // socket all take this one bridge, so they all gain direct mode at once.
  // Hosted (src/hosted.ts) no session file is read or written and
  // warapp_link_session is not registered: the direct leg serves only from the
  // AuthToken mcp-host captured at sign-in (WARAPP_AUTH_TOKEN, in memory,
  // #333), and without one the router is pinned to the browser bridge.
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
  // #437: every game read diffs the seats into the game's decision log (no request of its own).
  client.observeGames((game) => captureSeats(live, game));
  registerHealthcheckTool(server, fetchproxy, bridge, { ...deps, standIn: () => live.decoderReport()?.standIn });
  // The signed-in account names a finished game's player for its end-of-game pass when no board was cached (#312).
  registerGameTool(server, client, () => dataDir(deps.env), deps.env, () => live.myInviteToken());
  registerMapTool(server, client, live);
  // Opt-in (WARAPP_STATS=1), never hosted: the tool refuses before any request
  // when off. One collector per registration, so its 1 s throttle spans calls.
  registerMapStatsTool(server, {
    collector: new StatsCollector({
      client,
      dir: () => dataDir(deps.env),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    }),
    mapCache: deps.mapCache ?? defaultMapCache,
    dataDir: () => dataDir(deps.env),
    ...(deps.env ? { env: deps.env } : {}),
  });
  registerBoardTool(server, client, live);
  registerRouteTool(server, client);
  registerStrategyTool(server, client, live);
  registerLiveTools(server, live);
  registerPickTools(server, live, deps.env ? { env: deps.env } : {});
  registerMyGamesTool(server, live, deps.env ? { env: deps.env } : {});
  registerOpenGamesTool(server, live);
  registerJoinGameTool(server, live);
  registerLeaveGameTool(server, live);
  registerSurrenderTool(server, live);
  registerAcceptSurrenderTool(server, live);
  registerBeginTurnTool(server, live);
  registerScoutTool(server, live, deps.env ? { env: deps.env } : {});
  registerTurnTools(server, live, deps.env ? { env: deps.env } : {});
  registerCheckPlanTool(server, live);
  registerOpponentsTool(server, live, deps.env ? { env: deps.env } : {});
  // Reads the map statistics cache only when they are on (WARAPP_STATS=1, never hosted).
  registerWhereTool(server, live, deps.env ? { env: deps.env } : {});
  // Opponent profiling, read-only: habits counted from the boards seen (on unless WARAPP_PLAYER_PROFILE=off).
  registerProfileOpponentsTool(server, live, deps.env ? { env: deps.env } : {});
  registerUncommitTool(server, live);
  // Read-only: my own orders this turn read back from the live board, in warapp_submit_turn's shape.
  registerMyOrdersTool(server, live);
  registerChatTools(server, live, deps.env ? { env: deps.env } : {});
  registerChatInboxTool(server, live);
  // Local and hosted: war.app's own chat read mark, confirm-gated (#311).
  registerMarkChatReadTool(server, live);
  // Local and hosted: the account's own notifications, through its war.app tab.
  registerNotificationTools(server, live, deps.env ? { env: deps.env } : {});
  registerTeamTool(server, live);
  // C4: the team brief, read-only — the facts for a team-chat message, never sent.
  registerTeamBriefTool(server, live);
  // The agreement ledger: one read-only tool, and one that writes only the local ledger (not confirm-gated).
  registerRelationsTools(server, live, deps.env ? { env: deps.env } : {});
  // B3: truce advice (read-only): prices a deal by planning with and without it; reads no chat.
  registerDiplomacyTool(server, live, deps.env ? { env: deps.env } : {});
  registerModAlliancesTool(server, live);
  // One push socket per process: keyed on the shared fetchproxy bridge so
  // connections share it, with requests routed through the direct-first bridge.
  // While the direct leg is active the push rides a direct WebSocket (the
  // cookie goes only to war.app); otherwise, or when the WebSocket cannot come
  // up, it keeps xhr-polling over the bridge.
  const push =
    deps.push ??
    pushListenerFor(fetchproxy, {
      transport: () => bridge.ready(),
      webSocket: pushWebSocketLeg(bridge, () => readSession(deps.env), {}, deps.env ?? process.env),
      extras: () => live.rpc.extras,
    });
  registerSessionTools(server, {
    transport: {
      activeLeg: () => bridge.status().transport,
      sessionStale: () => bridge.sessionStale(),
      wall: () => bridge.wall(),
      sessionLinked: () => bridge.sessionLinked(),
    },
    pushTransport: () => push.status().transport,
    decoder: () => live.decoderReport(),
    // Pace (owner decision 2026-11-23): with no game list read yet in this process, read it now (one request).
    pace: async (now, mayRead) => {
      const kept = paceStatus(live, now);
      if (kept) return kept;
      if (!mayRead)
        return { error: 'No game list read yet in this process, and no working direct session to read one without the browser bridge: call warapp_my_games.' };
      try {
        await fetchMyGames(live);
      } catch (e) {
        return { error: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
      }
      return paceStatus(live, Date.now());
    },
    identityChanged: () => live.forgetIdentity(),
    hosted,
    ...(env ? { env } : {}),
  });
  registerPushTools(server, live, push, deps.env ? { env: deps.env } : {});
  // Moving a local install's history in (hosted: only with mcp-host's blob store) and the end-of-game backfill.
  registerStateTools(server, live, {
    ...(deps.env ? { env: deps.env } : {}),
    store: deps.blobStore === undefined ? blobStoreFromEnv(deps.env ?? process.env) : deps.blobStore,
  });
  // Hosted only: the war.app sign-in mcp-host's authFlow captures the AuthToken from (#333 part B).
  // Locally warapp_link_session stays the way to the direct transport.
  if (hosted) registerSignInTool(server, deps.signIn ? { signIn: deps.signIn } : {});
}
