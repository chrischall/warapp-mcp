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
import { HOST_SIGN_IN_ADVICE, SessionExpiredError, type WarappDirectBridge } from '../direct/transport.js';
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
 *
 * with a direct session (linked, or captured by mcp-host when hosted) the
 * credential arm also asks war.app whether that SESSION is signed in — one GET
 * of the invite-token page with it (`sessionCheck`: signed-in / signed-out /
 * unknown) — and reports the router's `wall` (why it left the direct leg, when,
 * and when it tries again). A session war.app shows signed out fails the check
 * as `session_expired`, even when the API token is fine: before, a hosted
 * healthcheck said ok while every live tool failed.
 */

export { PROBE_GAME_ID };
const PROBE_PATH = `/API/GameFeed?GameID=${PROBE_GAME_ID}&GetMap=false`;

/** The page the bridge arm round-trips through the user's war.app tab. */
export const BRIDGE_PROBE_PATH = '/';

type HealthcheckDeps = Pick<WarappClientOptions, 'env' | 'fetchImpl' | 'sleep'> & {
  /** Clock for the linked session's age. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * The non-secret facts about the linked direct session — never the token. The
 * session mcp-host captured at sign-in (hosted, #333) is `linked: true` with `linkedBy: 'host'` (`linked` stays a boolean), with
 * no capture time or age: this process does not know them.
 */
function sessionSummary(env: NodeJS.ProcessEnv | undefined, now: () => number) {
  const s = readSessionSync(env);
  if (!s) return { linked: false as const };
  if (s.origin === 'host') return { linked: true, linkedBy: 'host' as const };
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
  direct: Pick<WarappDirectBridge, 'status'> & Partial<Pick<WarappDirectBridge, 'wall' | 'checkSession' | 'ready'>>,
  deps: HealthcheckDeps = {},
): void {
  const now = deps.now ?? Date.now;
  /** What this call's session check found, echoed in the result; reset at each check. */
  let lastCheck: { sessionCheck?: string; wall?: unknown } = {};
  /** Check the direct session when there is one and the router may use it; never throws. */
  const checkSession = async (): Promise<string | undefined> => {
    lastCheck = {};
    if (!direct.checkSession || direct.status().mode === 'fetchproxy') return undefined;
    if (!readSessionSync(deps.env)) return undefined;
    const verdict = await direct.checkSession().catch(() => 'unknown' as const);
    if (verdict === 'none') return undefined;
    const wall = direct.wall?.() ?? null;
    lastCheck = { sessionCheck: verdict, ...(wall ? { wall } : {}) };
    return verdict;
  };
  const health = (): HealthcheckPath => ({ ...transportHealth(direct.status(), deps.env, now), ...lastCheck });
  const signedOut = (): SessionExpiredError =>
    new SessionExpiredError({ hostSignIn: readSessionSync(deps.env)?.origin === 'host' });
  const classifySignedOut = (err: unknown) =>
    err instanceof SessionExpiredError
      ? {
          kind: 'session_expired',
          hint:
            'war.app shows the session the live tools use as signed out. ' +
            (err.hostSignIn ? HOST_SIGN_IN_ADVICE : 'Run warapp_link_session to relink.'),
        }
      : undefined;
  /** The session check this call's resolver made, read by its probe. */
  let resolvedVerdict: string | undefined;
  registerAdaptiveHealthcheckTool({
    server,
    prefix: 'warapp',
    hostLabel: 'war.app',
    // The browser bridge is on the path only when THIS connection's
    // direct-first router is on its fetchproxy leg (it fell back, or is pinned
    // to fetchproxy) AND the bridge has carried a request. The fetchproxy
    // bridge is shared process-wide, so its role alone is not enough: another
    // connection may have used it while this one rides the direct leg (always,
    // under WARAPP_TRANSPORT=direct). Otherwise the credential arm answers.
    usingBridge: () => direct.status().transport === 'fetchproxy' && bridge.transport().role !== null,
    bridge: {
      probePath: BRIDGE_PROBE_PATH,
      transport: () => bridge.transport(),
      path: health,
      probeFn: async (path) => {
        // Off the direct leg with a session: ask war.app about the session first. Signed
        // out is the answer; signed in lifts the wall, and the probe then rides the direct leg.
        const verdict = await checkSession();
        if (verdict === 'signed-out') throw signedOut();
        const viaRouter = verdict === 'signed-in' && direct.ready !== undefined;
        const leg = viaRouter ? await direct.ready!() : await bridge.ready();
        const res = await leg.fetch({ method: 'GET', path });
        if (res.status !== 200) {
          throw new McpToolError(`war.app answered HTTP ${res.status}${viaRouter ? '' : ' through the bridge'}.`, {
            status: res.status,
            kind: 'http',
          });
        }
        return res.body;
      },
      classifyThrown: classifySignedOut,
    },
    credential: {
      probePath: PROBE_PATH,
      resolveCredential: async () => {
        resolvedVerdict = await checkSession();
        const detail = health();
        try {
          readCredentials(deps.env);
          return { source: 'env', detail };
        } catch (e) {
          if (e instanceof WarappConfigError) return { source: null, detail: { ...detail, reason: e.message } };
          throw e;
        }
      },
      probeFn: async () => {
        const res = await new WarappClient(deps).probeAuth();
        // The API token works; the live tools ride the session, which war.app says is signed out.
        if (resolvedVerdict === 'signed-out') throw signedOut();
        return res;
      },
      classifyThrown: (err) =>
        err instanceof McpToolError && err.kind === 'credential_rejected'
          ? { kind: 'credential_rejected', hint: AUTH_FAILED_HINT }
          : classifySignedOut(err),
      hints: { no_credential: `Set WARAPP_EMAIL and WARAPP_API_TOKEN (token from ${TOKEN_URL}).` },
    },
  });
}
