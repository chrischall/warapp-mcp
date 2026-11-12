import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError } from '@chrischall/mcp-utils';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import { AUTH_FAILED_HINT, PROBE_GAME_ID, WarappClient, type WarappClientOptions } from '../client.js';
import { readCredentials, TOKEN_URL, WarappConfigError } from '../config.js';

/**
 * `warapp_healthcheck` — does war.app accept the configured email + token?
 *
 * The probe ({@link WarappClient.probeAuth}) asks GameFeed for a game id that
 * does not exist. war.app checks the credentials first, so the two answers
 * separate cleanly: `Auth failed` is a rejected credential,
 * `ServerGameKeyNotFound` proves the credential works without loading (or
 * caching) any real game.
 */

export { PROBE_GAME_ID };
const PROBE_PATH = `/API/GameFeed?GameID=${PROBE_GAME_ID}&GetMap=false`;

export type HealthcheckDeps = Pick<WarappClientOptions, 'env' | 'fetchImpl' | 'sleep'>;

export function registerHealthcheckTool(server: McpServer, deps: HealthcheckDeps = {}): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'warapp',
    hostLabel: 'war.app',
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
  });
}
