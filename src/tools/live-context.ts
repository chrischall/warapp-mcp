// What the live-game tools share: the GameFeed client (players, map, settings,
// chat), the web-client RPC channel through the bridge (board, picks, sends),
// and the client bundle whose readers decode the board.
import { McpToolError, type EnvSource } from '@chrischall/mcp-utils';
import type { WarappClient } from '../client.js';
import { dataDir } from '../config.js';
import { readLatestGameInfo, standingFromInfo, type ClassReader, type LiveTerritory } from '../live.js';
import type { Game } from '../normalize.js';
import { BundleProvider } from '../protocol/bundle.js';
import {
  Method,
  readTerritoryPicks,
  writeGetLatestGameInfoParams,
  writeGetTerritoryPicksParams,
} from '../protocol/methods.js';
import { WarappRpc } from '../protocol/rpc.js';
import { BRIDGE_DOMAINS, type WarappBridge } from '../transport-bridge.js';

export interface LiveContext {
  client: WarappClient;
  rpc: WarappRpc;
  /** The loaded client bundle (cached per process). */
  bundle: () => Promise<ClassReader>;
  /**
   * The signed-in account's invite token (= its GameFeed player id), read once from
   * war.app's InviteToken page through the bridge; `undefined` when it cannot be read.
   */
  myInviteToken: () => Promise<number | undefined>;
  /** GET a war.app page as text through the signed-in tab. */
  fetchPage: (url: string) => Promise<string>;
}

/** The token from war.app's `/InviteToken` page ("Your invite token is N"). */
export function parseInviteToken(html: string): number | undefined {
  const m = /Your invite token is\s*(\d{5,20})/.exec(html);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) ? n : undefined;
}

export const INVITE_TOKEN_URL = 'https://war.app/InviteToken';

export interface LiveContextOptions {
  client: WarappClient;
  bridge: WarappBridge;
  env?: EnvSource;
  /** Used for the bundle download from War.app's CDN (not a war.app page). */
  fetchImpl?: typeof fetch;
  /** Test seam: the bundle, instead of discovering and downloading it. */
  bundle?: () => Promise<ClassReader>;
}

const onBridge = (url: URL) => BRIDGE_DOMAINS.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`));

/**
 * GET a URL as text: war.app pages through the signed-in tab (the bridge's
 * only domain), the CDN-hosted bundle directly.
 */
export function bundleFetcher(bridge: WarappBridge, fetchImpl: typeof fetch = fetch) {
  return async (url: string): Promise<string> => {
    const u = new URL(url);
    if (onBridge(u)) {
      const res = await (await bridge.ready()).fetch({ method: 'GET', path: u.href });
      if (res.status !== 200) throw new Error(`war.app answered HTTP ${res.status} for ${u.pathname}`);
      return res.body;
    }
    const res = await fetchImpl(u.href, { redirect: 'error' });
    if (!res.ok) throw new Error(`${u.hostname} answered HTTP ${res.status} for the client bundle`);
    return res.text();
  };
}

export function createLiveContext(opts: LiveContextOptions): LiveContext {
  const rpc = new WarappRpc({
    bridge: () => opts.bridge.ready(),
    ...(opts.env ? { env: opts.env as NodeJS.ProcessEnv } : {}),
  });
  const provider = new BundleProvider({
    dataDir: dataDir(opts.env),
    fetchText: bundleFetcher(opts.bridge, opts.fetchImpl),
  });
  const load = opts.bundle ?? (() => provider.get());
  const fetchText = bundleFetcher(opts.bridge, opts.fetchImpl);
  let token: Promise<number | undefined> | undefined;
  const myInviteToken = (): Promise<number | undefined> => {
    // Cache a success; let a failure (bridge down, signed out) be retried next call.
    token ??= fetchText(INVITE_TOKEN_URL)
      .then(parseInviteToken)
      .catch(() => undefined)
      .then((t) => {
        if (t === undefined) token = undefined;
        return t;
      });
    return token;
  };
  return {
    myInviteToken,
    fetchPage: fetchText,
    client: opts.client,
    rpc,
    bundle: async () => {
      try {
        return await load();
      } catch (e) {
        if (e instanceof McpToolError) throw e;
        throw new McpToolError(`Could not load war.app's client bundle: ${e instanceof Error ? e.message : String(e)}`, {
          kind: 'unknown',
          hint: 'The live-game tools decode the board with the war.app web client. Make sure a signed-in war.app tab is open and paired, then retry.',
          cause: e,
        });
      }
    },
  };
}

/** The game's live board through the bridge; throws when war.app has none for it. */
export async function loadLiveTerritories(ctx: LiveContext, game: Game): Promise<LiveTerritory[]> {
  return (await loadLiveGame(ctx, game)).territories;
}

/** The live board plus the decoded LatestGameInfo (cards live there); throws when war.app has no board. */
export async function loadLiveGame(ctx: LiveContext, game: Game): Promise<{ territories: LiveTerritory[]; info: unknown }> {
  const env = await ctx.rpc.call('GetLatestGameInfo', Method.GetLatestGameInfo, (w) =>
    writeGetLatestGameInfoParams(w, game.id),
  );
  const bundle = await ctx.bundle();
  const info = readLatestGameInfo(bundle, env.body);
  const territories = standingFromInfo(info);
  if (!territories) {
    throw new McpToolError(`war.app has no board for game ${game.id} yet (game state: ${game.state}).`, {
      hint: 'A lobby has no board until territories are distributed. warapp_get_map works without one.',
    });
  }
  return { territories, info };
}

/** A player's current territory picks, in priority order. */
export async function loadPicks(ctx: LiveContext, gameId: number, inGamePlayerId: number): Promise<number[]> {
  const env = await ctx.rpc.call('GetTerritoryPicks', Method.GetTerritoryPicks, (w) =>
    writeGetTerritoryPicksParams(w, gameId, inGamePlayerId),
  );
  return readTerritoryPicks(env.body);
}
