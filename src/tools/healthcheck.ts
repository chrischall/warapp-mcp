import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError } from '@chrischall/mcp-utils';
import { registerAdaptiveHealthcheckTool } from '@chrischall/mcp-utils/fetchproxy';
import { AUTH_FAILED_HINT, PROBE_GAME_ID, WarappClient, type WarappClientOptions } from '../client.js';
import { readCredentials, TOKEN_URL, WarappConfigError } from '../config.js';
import type { WarappBridge } from '../transport-bridge.js';

/**
 * `warapp_healthcheck` — does war.app accept the configured email + token?
 *
 * The probe ({@link WarappClient.probeAuth}) asks GameFeed for a game id that
 * does not exist. war.app checks the credentials first, so the two answers
 * separate cleanly: `Auth failed` is a rejected credential,
 * `ServerGameKeyNotFound` proves the credential works without loading (or
 * caching) any real game.
 *
 * The live-game tools reach war.app a second way — the web-client protocol,
 * relayed through the user's signed-in tab by the fetchproxy bridge — so this
 * is ONE adaptive tool: it answers from the bridge arm once the bridge has
 * carried a request in this process (its role is elected on the first verb),
 * and from the credential arm before that. The bridge probe GETs war.app's
 * home page through the tab, which proves the round trip without sending a
 * protocol frame.
 */

export { PROBE_GAME_ID };
const PROBE_PATH = `/API/GameFeed?GameID=${PROBE_GAME_ID}&GetMap=false`;

/** The page the bridge arm round-trips through the user's war.app tab. */
export const BRIDGE_PROBE_PATH = '/';

export type HealthcheckDeps = Pick<WarappClientOptions, 'env' | 'fetchImpl' | 'sleep'>;

export function registerHealthcheckTool(server: McpServer, bridge: WarappBridge, deps: HealthcheckDeps = {}): void {
  registerAdaptiveHealthcheckTool({
    server,
    prefix: 'warapp',
    hostLabel: 'war.app',
    usingBridge: () => bridge.transport().role !== null,
    bridge: {
      probePath: BRIDGE_PROBE_PATH,
      transport: () => bridge.transport(),
      probeFn: async (path) => {
        const res = await (await bridge.ready()).fetch({ method: 'GET', path });
        if (res.status !== 200) {
          throw new McpToolError(`war.app answered HTTP ${res.status} through the bridge.`, {
            status: res.status,
            kind: 'http',
          });
        }
        return res.body;
      },
    },
    credential: {
      probePath: PROBE_PATH,
      resolveCredential: async () => {
        try {
          readCredentials(deps.env);
          return { source: 'env' };
        } catch (e) {
          if (e instanceof WarappConfigError) return { source: null, detail: { reason: e.message } };
          throw e;
        }
      },
      probeFn: () => new WarappClient(deps).probeAuth(),
      classifyThrown: (err) =>
        err instanceof McpToolError && err.kind === 'credential_rejected'
          ? { kind: 'credential_rejected', hint: AUTH_FAILED_HINT }
          : undefined,
      hints: { no_credential: `Set WARAPP_EMAIL and WARAPP_API_TOKEN (token from ${TOKEN_URL}).` },
    },
  });
}
