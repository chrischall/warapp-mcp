// The fetchproxy browser bridge to war.app.
//
// The web-client protocol (docs/WEB-PROTOCOL.md) is authenticated by the
// browser's war.app cookies, not by anything in the frame, so every
// `/Services` call is relayed through the user's signed-in war.app tab by the
// ContextMint Bridge extension. The GameFeed API (src/client.ts) does not use
// this — it authenticates with the API token and is called directly.
import { readPortEnv } from '@chrischall/mcp-utils';
import {
  createFetchproxyTransport,
  createLazyTransport,
  type CreateFetchproxyTransportOptions,
  type FetchproxyTransport,
  type LazyTransport,
} from '@chrischall/mcp-utils/fetchproxy';
import { VERSION } from './version.js';

export const SERVER_NAME = 'warapp-mcp';
/** Env var overriding the fetchproxy concentrator port. */
export const WS_PORT_ENV = 'WARAPP_WS_PORT';
/** The fleet's shared fetchproxy concentrator port. */
export const DEFAULT_WS_PORT = 37149;
/** The extension's trust boundary: requests may only target war.app. */
export const BRIDGE_DOMAINS: readonly string[] = ['war.app'];

export interface BridgeTransportOptions {
  env?: NodeJS.ProcessEnv;
  /** Test seam: build the underlying FetchproxyServer (see createFetchproxyTransport). */
  createServer?: CreateFetchproxyTransportOptions['createServer'];
}

/** Build (but do not start) the war.app bridge transport. */
export function createBridgeTransport(opts: BridgeTransportOptions = {}): FetchproxyTransport {
  const env = opts.env ?? process.env;
  return createFetchproxyTransport({
    serverName: SERVER_NAME,
    version: VERSION,
    domains: [...BRIDGE_DOMAINS],
    port: readPortEnv(WS_PORT_ENV, DEFAULT_WS_PORT, { env }),
    debugEnvVar: 'WARAPP_DEBUG',
    env,
    ...(opts.createServer ? { createServer: opts.createServer } : {}),
  });
}

/** The process's one bridge: built on first use, started exactly once. */
export type WarappBridge = LazyTransport<FetchproxyTransport>;

export function createWarappBridge(opts: BridgeTransportOptions = {}): WarappBridge {
  return createLazyTransport(() => createBridgeTransport(opts));
}
