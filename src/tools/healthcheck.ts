import type { McpServer } from '@modelcontextprotocol/server';
import { McpToolError, parseJsonBody, truncateErrorMessage, type EnvSource } from '@chrischall/mcp-utils';
import { registerCredentialHealthcheckTool } from '@chrischall/mcp-utils/healthcheck';
import { readCredentials, TOKEN_URL, WarappConfigError } from '../config.js';

/**
 * `warapp_healthcheck` — does war.app accept the configured email + token?
 *
 * The probe asks GameFeed for a game id that does not exist. war.app checks the
 * credentials first, so the two answers separate cleanly: `Auth failed` is a
 * rejected credential, `ServerGameKeyNotFound` proves the credential works
 * without loading (or caching) any real game. Errors come back as HTTP 200 JSON
 * `{ error }`, so the status alone never decides health.
 */

/** A game id war.app will not have: the largest positive int32. */
export const PROBE_GAME_ID = 2147483647;
const HOST = 'war.app';
const PROBE_PATH = `/API/GameFeed?GameID=${PROBE_GAME_ID}&GetMap=false`;

export interface HealthcheckDeps {
  env?: EnvSource;
  fetchImpl?: typeof fetch;
}

async function probe(deps: HealthcheckDeps): Promise<unknown> {
  const { email, token } = readCredentials(deps.env);
  const redact = (s: string) => truncateErrorMessage(s, 300, { values: [token, email] });
  const res = await (deps.fetchImpl ?? fetch)(`https://${HOST}${PROBE_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams({ Email: email, APIToken: token }).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new McpToolError(`war.app GameFeed answered HTTP ${res.status}`, { status: res.status, kind: 'http' });
  }
  const body = parseJsonBody<{ error?: unknown }>(text, { service: 'war.app', method: 'POST', path: '/API/GameFeed', status: res.status, headers: res.headers });
  const error = typeof body?.error === 'string' ? body.error : undefined;
  if (error === undefined || /ServerGameKeyNotFound/.test(error)) return { authenticated: true };
  if (error === 'Auth failed') {
    throw new McpToolError('war.app rejected the email + API token (Auth failed)', { kind: 'credential_rejected' });
  }
  throw new McpToolError(`war.app GameFeed error: ${redact(error)}`, { kind: 'http' });
}

const REJECTED_HINT =
  `war.app rejected the credentials. Check WARAPP_EMAIL is the email you sign in with, and regenerate ` +
  `WARAPP_API_TOKEN at ${TOKEN_URL} while signed in — changing your war.app password also rotates the token.`;

export function registerHealthcheckTool(server: McpServer, deps: HealthcheckDeps = {}): void {
  registerCredentialHealthcheckTool({
    server,
    prefix: 'warapp',
    hostLabel: HOST,
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
    probeFn: () => probe(deps),
    classifyThrown: (err) =>
      err instanceof McpToolError && err.kind === 'credential_rejected'
        ? { kind: 'credential_rejected', hint: REJECTED_HINT }
        : undefined,
    hints: { no_credential: `Set WARAPP_EMAIL and WARAPP_API_TOKEN (token from ${TOKEN_URL}).` },
  });
}
