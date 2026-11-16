// mcp-host's egress proxy, for the requests that bring their own dispatcher.
//
// On mcp-host a child reaches the internet ONLY through the egress proxy that
// `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` point Node's built-in fetch at: a
// direct socket is silently dropped and reads as a timeout. Global fetch
// honours the variable; a custom undici dispatcher does not. The war.app
// sign-in (src/direct/sign-in.ts) and the direct leg (src/direct/transport.ts)
// each send through their own dispatcher — mcp-utils netguard's public-only
// one — so hosted, neither could reach war.app at all ("Could not reach
// war.app to sign in"). GameFeed (`createApiClient`) and the bundle download
// use global fetch and need nothing here.
//
// With a proxy configured, those two send through an undici `ProxyAgent` for
// it instead (a CONNECT tunnel; TLS to war.app still checks war.app's
// certificate). The host check stays in our code — the exact origin
// https://war.app — and the proxy enforces the child's allowlist and its own
// address table, so netguard's public-only pin is not needed there. Without a
// proxy (local) nothing changes: the public-only dispatcher, as before.
//
// A proxy that is set but unusable is a configuration error, refused clearly:
// never a fallback to a direct connection. NO_PROXY is not read: war.app is
// never meant to bypass the proxy. The proxy URL is never echoed (it may carry
// a password).
import { McpToolError, readEnvVar, type EnvSource } from '@chrischall/mcp-utils';
import { type Dispatcher, ProxyAgent } from 'undici';

/** The variables naming the proxy, in the order read (curl's and undici's spellings). */
export const EGRESS_PROXY_ENV = ['HTTPS_PROXY', 'https_proxy'] as const;

/** The start of the refusal for a proxy that is set but unusable. */
export const EGRESS_PROXY_INVALID = 'HTTPS_PROXY is set but is not a usable http(s) proxy URL';

/** Builds the agent for a proxy URL (a test seam; the default is undici's `ProxyAgent`). */
export type ProxyAgentFactory = (url: URL) => Dispatcher;

export const defaultProxyAgent: ProxyAgentFactory = (url) => new ProxyAgent(url.href);

const rawProxy = (env: EnvSource): string | undefined => {
  for (const key of EGRESS_PROXY_ENV) {
    const v = readEnvVar(key, { env });
    if (v !== undefined) return v;
  }
  return undefined;
};

/** Whether a proxy is configured at all (usable or not): then nothing may connect directly. */
export function egressProxyConfigured(env: EnvSource = process.env): boolean {
  return rawProxy(env) !== undefined;
}

/**
 * The egress proxy's URL when `HTTPS_PROXY` (or `https_proxy`) is set, else
 * `undefined`. Throws a clear error, before anything is sent, when the variable
 * is set but not an http(s) URL with a host (never echoing it).
 */
export function egressProxyUrl(env: EnvSource = process.env): URL | undefined {
  const raw = rawProxy(env);
  if (raw === undefined) return undefined;
  let url: URL | undefined;
  try {
    url = new URL(raw);
  } catch {
    url = undefined;
  }
  if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new McpToolError(`${EGRESS_PROXY_INVALID}, so nothing was sent to war.app.`, {
      kind: 'unknown',
      hint: 'Set HTTPS_PROXY to a proxy URL such as http://127.0.0.1:8080, or unset it to connect directly.',
    });
  }
  return url;
}

/**
 * The dispatcher to send war.app traffic through: a proxy agent for
 * {@link egressProxyUrl}, else `undefined` (the caller keeps its public-only
 * dispatcher). Throws as {@link egressProxyUrl} does. The caller closes the agent.
 */
export function egressDispatcher(
  env: EnvSource = process.env,
  make: ProxyAgentFactory = defaultProxyAgent,
): Dispatcher | undefined {
  const url = egressProxyUrl(env);
  return url ? make(url) : undefined;
}
