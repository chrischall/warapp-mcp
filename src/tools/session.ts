// The direct-transport session tools:
//
// - `warapp_link_session` (write, confirm-gated, owner-only intent) captures
//   the signed-in war.app session cookie once through the browser bridge and
//   stores it, so later calls skip Chrome (src/direct/link.ts). It reports only
//   success + when it was captured + the active transport — NEVER the token.
// - `warapp_session_status` (read) reports whether a session is linked, when it
//   was captured and how old it is, and which leg (direct vs the browser
//   bridge) is serving calls now — again never the token. While the direct leg's
//   last answer was a `SessionExpiredError`, it surfaces "session expired — run
//   warapp_link_session" so the owner relinks; a relink clears it.
//
// SECURITY: the AuthToken is a full-account credential. Neither tool returns,
// logs, or previews it; the status output carries only `capturedAt`/`host`/age.
import { CONFIRM_INJECTION_RULE, defineWrite, registerWrite, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { linkSession, type LinkResult, type LinkSessionOptions } from '../direct/link.js';
import { readSession, SESSION_HOST, type Session } from '../direct/session.js';
import type { PushTransportName } from '../push/socketio.js';
import { lookupMeta, mintMeta, withToolConfig } from './hints.js';
import { readAnnotations, respond, untrustedDescription } from './common.js';

/** Which leg serves calls now, and whether the linked token went stale this run. */
export interface SessionTransportView {
  /** The leg the next call rides. */
  activeLeg(): 'direct' | 'fetchproxy';
  /** True while the linked token is known to be signed out (cleared by a direct success or a relink). */
  sessionStale(): boolean;
  /** A new session was linked: clear the stale flag and let `auto` retry the direct leg. */
  sessionLinked(): void;
}

/** What {@link registerSessionTools} needs. */
export interface SessionToolsDeps {
  /** The active transport, for "which leg is serving calls". */
  transport: SessionTransportView;
  /** Env for the stored-file path and the capture port. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Test seam: read the linked session. Defaults to M1's {@link readSession}. */
  read?: () => Promise<Session | null>;
  /** Test seam: capture + store a session. Defaults to {@link linkSession}. */
  link?: (opts?: LinkSessionOptions) => Promise<LinkResult>;
  /** The push socket's transport (websocket / xhr-polling); undefined before it has run. */
  pushTransport?: () => PushTransportName | undefined;
  /** Clock for age. Defaults to `Date.now`. */
  now?: () => number;
}

const HINT_NOT_LINKED =
  'No war.app session is linked. Run warapp_link_session to use the direct (no-browser) transport; the browser ' +
  'bridge is used until then.';
const HINT_EXPIRED =
  'The linked war.app session is signed out (war.app answered a direct call signed-out this run). Run ' +
  'warapp_link_session to relink.';

export function registerSessionTools(server: McpServer, deps: SessionToolsDeps): void {
  const read = deps.read ?? (() => readSession(deps.env));
  const link = deps.link ?? ((opts?: LinkSessionOptions) => linkSession({ ...(deps.env ? { env: deps.env } : {}), ...opts }));
  const now = deps.now ?? Date.now;

  server.registerTool(
    'warapp_session_status',
    {
      title: 'war.app direct-transport session status',
      description: untrustedDescription(
        'Report whether a signed-in war.app session is linked for the direct (no-browser) transport, when it was ' +
          'captured and how old it is, which transport is currently active (direct, or the browser bridge), and ' +
          'which transport the turn-notification push socket rides (websocket or xhr-polling) once it has run. ' +
          'Never shows the session cookie. Read-only; use warapp_link_session to link or relink.',
      ),
      _meta: lookupMeta(['war.app session', 'is war.app linked', 'direct transport status']),
      annotations: readAnnotations('war.app session status'),
      inputSchema: z.object({}),
    },
    async () => {
      const session = await read();
      const activeTransport = deps.transport.activeLeg();
      const pt = deps.pushTransport?.();
      const push = pt ? { pushTransport: pt } : {};
      return respond(undefined, ['compact'], () => {
        if (!session) return { linked: false, activeTransport, ...push, hint: HINT_NOT_LINKED };
        const ageSeconds = Math.max(0, Math.round((now() - Date.parse(session.capturedAt)) / 1000));
        const base = { linked: true, host: session.host, capturedAt: session.capturedAt, ageSeconds, activeTransport, ...push };
        return deps.transport.sessionStale() ? { ...base, sessionExpired: true, hint: HINT_EXPIRED } : base;
      });
    },
  );

  withToolConfig(
    server,
    {
      title: 'Link a war.app session (direct transport)',
      _meta: mintMeta('change', ['link war.app', 'connect war.app session', 'relink war.app']),
    },
    () =>
      registerWrite(
        server,
        defineWrite({
          name: 'warapp_link_session',
          description:
            'Link your signed-in war.app session for the direct (no-browser) transport: capture the session cookie ' +
            'from your signed-in war.app tab once and store it on THIS machine, so later war.app calls go straight ' +
            'to war.app without the browser bridge. The stored cookie is a full-account credential kept locally ' +
            `(file mode 0600); it is never shown here or sent anywhere but war.app. ${CONFIRM_INJECTION_RULE}`,
          annotations: toolAnnotations({
            title: 'Link a war.app session',
            readOnly: false,
            destructive: false,
            idempotent: false,
            openWorld: true,
          }),
          inputSchema: z.object({}),
          plan() {
            return {
              gate: {
                action: 'warapp.link_session',
                summary: 'Capture your signed-in war.app session and store it locally for the direct transport',
                account: undefined,
                payload: {
                  action: 'link-session',
                  host: SESSION_HOST,
                  stores: 'the war.app session cookie, locally (file mode 0600), for the no-browser transport',
                },
                preview: {
                  note:
                    'Captures the session cookie from your signed-in war.app tab and stores it on this machine ' +
                    'only (file mode 0600). It is a full-account credential — it is never shown here or sent ' +
                    'anywhere but war.app.',
                },
              },
              state: {} as Record<string, never>,
            };
          },
          async execute() {
            const result = await link();
            // The old token's stale flag and the router's fallback were about
            // the OLD session: reset them so the direct leg is tried again.
            deps.transport.sessionLinked();
            return {
              status: 'linked' as const,
              host: result.host,
              capturedAt: result.capturedAt,
              transport: deps.transport.activeLeg(),
            };
          },
          render: (r) => respond(undefined, ['compact'], () => r),
          batchable: false,
        }),
      ),
  );
}
