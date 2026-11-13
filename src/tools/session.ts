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
// LOCAL-ONLY: on a hosted child (src/hosted.ts) `warapp_link_session` is not
// registered, and `warapp_session_status` reports `hosted: true` and the
// browser bridge without reading the store or suggesting a link.
//
// SECURITY: the AuthToken is a full-account credential. Neither tool returns,
// logs, or previews it; the status output carries only `capturedAt`/`host`/age.
import { CONFIRM_INJECTION_RULE, defineWrite, registerWrite, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { linkSession, type LinkResult, type LinkSessionOptions } from '../direct/link.js';
import { readSession, SESSION_HOST, type Session } from '../direct/session.js';
import { isHosted } from '../hosted.js';
import type { DecoderReport } from '../protocol/bundle.js';
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
  /** What the loaded client bundle's decoding rests on (#148); undefined before one has loaded. */
  decoder?: () => DecoderReport | undefined;
  /** Clock for age. Defaults to `Date.now`. */
  now?: () => number;
  /** A hosted child: no link tool, status reports the bridge. Defaults to {@link isHosted} of `env`. */
  hosted?: boolean;
  /** Called after a successful link: discard the cached signed-in account (the new session may be another one). */
  identityChanged?: () => void;
}

const HINT_NOT_LINKED =
  'No war.app session is linked. Run warapp_link_session to use the direct (no-browser) transport; the browser ' +
  'bridge is used until then.';
const NOTE_HOSTED =
  'This server is hosted: the direct (no-browser) transport is local-only, so war.app calls go through the browser ' +
  'bridge and your signed-in war.app tab.';
const HINT_EXPIRED =
  'The linked war.app session is signed out (war.app answered a direct call signed-out this run). Run ' +
  'warapp_link_session to relink.';

/**
 * The sentence other tools' descriptions carry about the direct transport —
 * empty on a hosted child, where there is no session to link.
 */
export function noBrowserNote(hosted: boolean | undefined): string {
  return hosted ? '' : ' Works without a browser once a session is linked (warapp_link_session).';
}

/** The hint when the signed-in account cannot be told: linking a session is suggested only locally. */
export function signedInHint(hosted: boolean | undefined): string {
  return hosted
    ? 'Open a war.app tab signed in to your account, then retry.'
    : 'Open a war.app tab signed in to your account (or link a session with warapp_link_session), then retry.';
}

export function registerSessionTools(server: McpServer, deps: SessionToolsDeps): void {
  const read = deps.read ?? (() => readSession(deps.env));
  const link = deps.link ?? ((opts?: LinkSessionOptions) => linkSession({ ...(deps.env ? { env: deps.env } : {}), ...opts }));
  const now = deps.now ?? Date.now;
  const hosted = deps.hosted ?? isHosted(deps.env ?? process.env);
  /** The board decoder, once a live tool has loaded the client bundle (#148). */
  const decoderView = (): { decoder?: (DecoderReport & { note?: string }) | { checked: false; note: string } } => {
    if (!deps.decoder) return {};
    const d = deps.decoder();
    // Not loaded yet in this process: say so rather than leave the field out.
    if (!d)
      return {
        decoder: {
          checked: false,
          note: "Not checked yet: no live board has been decoded in this process. The check runs when war.app's client first loads (any live tool).",
        },
      };
    return {
      decoder: {
        ...d,
        ...(d.fallback
          ? { note: "A cached copy of war.app's client is decoding boards: the current version could not be looked up." }
          : {}),
      },
    };
  };

  server.registerTool(
    'warapp_session_status',
    {
      title: 'war.app direct-transport session status',
      description: untrustedDescription(
        hosted
          ? 'Report which transport serves war.app calls on this hosted server (always the browser bridge: the ' +
              'direct, no-browser transport is local-only) and which transport the turn-notification push socket ' +
              'rides (websocket or xhr-polling) once it has run, and, once a live board has been read, which client ' +
              'bundle decodes boards (a cached stand-in or not) and which of its reader helpers were verified. Read-only.'
          : 'Report whether a signed-in war.app session is linked for the direct (no-browser) transport, when it was ' +
              'captured and how old it is, which transport is currently active (direct, or the browser bridge), and ' +
              'which transport the turn-notification push socket rides (websocket or xhr-polling) once it has run, ' +
              'and, once a live board has been read, which client bundle decodes boards (a cached stand-in or not) and ' +
              'which of its reader helpers were verified. ' +
              'Never shows the session cookie. Read-only; use warapp_link_session to link or relink.',
      ),
      _meta: lookupMeta(['war.app session', 'is war.app linked', 'direct transport status']),
      annotations: readAnnotations('war.app session status'),
      inputSchema: z.object({}),
    },
    async () => {
      if (hosted) {
        const pt = deps.pushTransport?.();
        return respond(undefined, ['compact'], () => ({
          hosted: true,
          linked: false,
          activeTransport: 'fetchproxy' as const,
          ...(pt ? { pushTransport: pt } : {}),
          ...decoderView(),
          hostedNote: NOTE_HOSTED,
        }));
      }
      const session = await read();
      const activeTransport = deps.transport.activeLeg();
      const pt = deps.pushTransport?.();
      const push = { ...(pt ? { pushTransport: pt } : {}), ...decoderView() };
      return respond(undefined, ['compact'], () => {
        if (!session) return { linked: false, activeTransport, ...push, hint: HINT_NOT_LINKED };
        const ageSeconds = Math.max(0, Math.round((now() - Date.parse(session.capturedAt)) / 1000));
        const base = { linked: true, host: session.host, capturedAt: session.capturedAt, ageSeconds, activeTransport, ...push };
        return deps.transport.sessionStale() ? { ...base, sessionExpired: true, hint: HINT_EXPIRED } : base;
      });
    },
  );

  // Never on a hosted child: it would store a full-account token on the host.
  if (hosted) return;

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
            // The new session may be another account: "me" must be read again.
            deps.identityChanged?.();
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
