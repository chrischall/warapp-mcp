// `warapp_sign_in` — the war.app sign-in mcp-host's hosted authFlow calls as its
// `capture` (#333 part B, docs/examples/warapp-auth-flow.json).
//
// Registered ONLY on a hosted child (src/hosted.ts). Locally the way to the
// direct transport stays warapp_link_session, which takes the cookie off the
// signed-in tab and never returns it.
//
// THE ONE DOCUMENTED EXCEPTION to "the AuthToken is never in a tool result":
// this tool's result is `{ authToken }`, because mcp-host's `capture` reads the
// credential out of the capture tool's result (`path: authToken`) and seals it
// as the per-user secret WARAPP_AUTH_TOKEN. The caller already holds the
// account's email and password, so the result grants it nothing it did not
// have. Nothing else about the account is returned, and a refusal's text never
// holds the email, the password or a cookie value (src/direct/sign-in.ts).
// Hiding it from the connector's tool menu (mcp-host `enabledTools`) is the
// owner's choice, not a default: a flow's step and capture calls are never
// checked against that allowlist, so the sign-in would still run, but the gate
// is fail-closed — once set, the connection's resources (warapp://strategy) and
// prompts are gone, and every tool a later release adds stays hidden until the
// list is edited by hand (docs/PLAN-DIRECT.md, registration change step 3).
//
// Not confirm-gated: the flow calls it with exactly the arguments its document
// declares, and a gate would need another argument there. It is not read-only
// (it signs in, creating a war.app session), it reaches no player, and it is
// not idempotent (each call is a sign-in attempt war.app may count).
import { toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { signIn, type SignInCredentials, type SignInResult } from '../direct/sign-in.js';
import { mintMeta } from './hints.js';

export interface SignInToolDeps {
  /** Test seam: the sign-in itself. Defaults to {@link signIn}. */
  signIn?: (creds: SignInCredentials, opts: { signal?: AbortSignal }) => Promise<SignInResult>;
}

export function registerSignInTool(server: McpServer, deps: SignInToolDeps = {}): void {
  const run = deps.signIn ?? signIn;
  server.registerTool(
    'warapp_sign_in',
    {
      title: 'Sign in to war.app (host sign-in flow)',
      description:
        "For the host's sign-in flow only, not for chat use: signs in to war.app once with the account's email " +
        'and password and returns the session cookie war.app sets, as `authToken`, which the host keeps as this ' +
        "connection's own secret so later calls reach war.app without a browser. The password is used for this one " +
        'sign-in and never stored. A refusal (wrong email or password, a captcha or bot check, a network failure) ' +
        'is an error that says which, and is never retried, because war.app may count failed sign-ins.',
      _meta: mintMeta('other', ['sign in to war.app']),
      annotations: toolAnnotations({
        title: 'Sign in to war.app',
        readOnly: false,
        destructive: false,
        idempotent: false,
        openWorld: true,
      }),
      inputSchema: z.object({
        email: z.string().min(1).max(320).describe("The war.app account's email."),
        password: z.string().min(1).max(1024).describe("The war.app account's password, used once and never stored."),
      }),
    },
    async ({ email, password }, ctx) => {
      const { authToken } = await run({ email, password }, { signal: ctx.mcpReq.signal });
      // The capture reads this top-level key; nothing else about the account is returned.
      return { content: [{ type: 'text' as const, text: JSON.stringify({ authToken }) }] };
    },
  );
}
