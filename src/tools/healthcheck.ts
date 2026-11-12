import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError } from '@chrischall/mcp-utils';
import {
  registerAdaptiveHealthcheckTool,
  type DirectFirstStatus,
  type HealthcheckPath,
} from '@chrischall/mcp-utils/fetchproxy';
import { AUTH_FAILED_HINT, PROBE_GAME_ID, WarappClient, type WarappClientOptions } from '../client.js';
import { readCredentials, TOKEN_URL, WarappConfigError } from '../config.js';
import { readSessionSync } from '../direct/session.js';
import type { WarappDirectBridge } from '../direct/transport.js';
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
 * The live-game tools reach war.app a second way — the web-client protocol —
 * now over a direct-first transport: a chrome-less HTTPS leg carrying the
 * linked `AuthToken` session, falling back to the browser bridge. So this is
 * ONE adaptive tool: it answers from the bridge arm once the browser bridge has
 * carried a request in this process (i.e. after the router fell back to it —
 * "on fetchproxy, the bridge probe"), and from the credential arm before that,
 * which is the whole time the direct leg is serving calls ("on direct, the
 * credential probe"). Either way the result carries which leg is active and
 * whether a direct session is linked and how old it is — never the token.
 */

export { PROBE_GAME_ID };
const PROBE_PATH = `/API/GameFeed?GameID=${PROBE_GAME_ID}&GetMap=false`;

/** The page the bridge arm round-trips through the user's war.app tab. */
export const BRIDGE_PROBE_PATH = '/';

export type HealthcheckDeps = Pick<WarappClientOptions, 'env' | 'fetchImpl' | 'sleep'> & {
  /** Clock for the linked session's age. Defaults to `Date.now`. */
  now?: () => number;
};

/** The non-secret facts about the linked direct session — never the token. */
function sessionSummary(env: NodeJS.ProcessEnv | undefined, now: () => number) {
  const s = readSessionSync(env);
  if (!s) return { linked: false as const };
  const ageSeconds = Math.max(0, Math.round((now() - Date.parse(s.capturedAt)) / 1000));
  return { linked: true as const, capturedAt: s.capturedAt, ageSeconds };
}

/** Which leg is active (+ its configured mode) and the linked-session summary. */
function transportHealth(status: DirectFirstStatus, env: NodeJS.ProcessEnv | undefined, now: () => number): HealthcheckPath {
  return { ...status, session: sessionSummary(env, now) };
}

export function registerHealthcheckTool(
  server: McpServer,
  bridge: WarappBridge,
  direct: Pick<WarappDirectBridge, 'status'>,
  deps: HealthcheckDeps = {},
): void {
  const now = deps.now ?? Date.now;
  registerAdaptiveHealthcheckTool({
    server,
    prefix: 'warapp',
    hostLabel: 'war.app',
    // The browser bridge is on the path once the direct-first router fell back
    // to it (or was pinned to fetchproxy); until then the direct leg serves and
    // the credential arm answers.
    usingBridge: () => bridge.transport().role !== null,
    bridge: {
      probePath: BRIDGE_PROBE_PATH,
      transport: () => bridge.transport(),
      path: () => transportHealth(direct.status(), deps.env, now),
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
        const health = transportHealth(direct.status(), deps.env, now);
        try {
          readCredentials(deps.env);
          return { source: 'env', detail: health };
        } catch (e) {
          if (e instanceof WarappConfigError) return { source: null, detail: { ...health, reason: e.message } };
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
