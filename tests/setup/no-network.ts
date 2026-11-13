// A vitest setup file (vitest.config.ts `setupFiles`): the test process may
// connect to loopback only. Tests and agents never call war.app (CLAUDE.md);
// a test that forgets its seam (an injected fetch, the bridge mock, a fake
// WebSocket, a loopback server) fails here with NETWORK_GUARD_MESSAGE instead
// of sending a request to a live host.
//
// What it covers, in this process:
// - every TCP/TLS socket: `net.Socket.prototype.connect` refuses a
//   non-loopback host before any packet is sent. That is the layer under
//   Node's global fetch and WebSocket (Node's bundled undici), the npm undici
//   that mcp-utils netguard `fetchPublic` uses with its OWN dispatcher (so a
//   global-dispatcher mock would not reach it), node:http/https and raw
//   sockets. A Unix-domain socket (a `path`) is local and allowed.
// - the global fetch: refused up front with the same message (otherwise it
//   would surface only as the cause of "fetch failed").
// - DNS: `dns.lookup` and `dns.promises.lookup` (what every socket and fetch
//   uses to resolve a name) refuse a non-loopback name, so connecting by name
//   sends no resolver query either.
//
// NOT covered: the c-ares resolver API (`dns.resolve*`, `dns.Resolver`) and UDP
// sockets (`node:dgram`). Neither the server nor the suite uses them.
//
// Also not covered: a spawned child process (child_process spawn/exec, e.g. a
// packaging test running node or npm) has its own runtime and is out of this
// guard's reach; such a test must not point the child at a live host itself.
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';

export const NETWORK_GUARD_MESSAGE = 'Test network guard: refused a connection to a non-loopback host.';

const LOOPBACK_NAMES = new Set(['localhost', 'localhost.', 'ip6-localhost', 'ip6-loopback']);

/** Whether a host (a name or an address, bracketed or not) is the loopback interface. */
export function isLoopbackHost(host: string | undefined | null): boolean {
  if (host === undefined || host === null || host === '') return true; // Node's default host is localhost.
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_NAMES.has(h) || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  const v4 = h.replace(/^::ffff:/, '');
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

function refusal(target: string): Error {
  const err = new Error(`${NETWORK_GUARD_MESSAGE} (${target}) Give the code under test a seam or a fake.`);
  (err as NodeJS.ErrnoException).code = 'ETESTNETWORKGUARD';
  return err;
}

const GUARD = Symbol.for('warapp-mcp.test-network-guard');
const g = globalThis as typeof globalThis & { [GUARD]?: true };

if (!g[GUARD]) {
  g[GUARD] = true;

  // Sockets. `connect` takes (options[, cb]), (port[, host][, cb]), (path[, cb]),
  // or Node's internal pre-normalized [options, cb] array.
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(this: net.Socket, ...args: unknown[]) {
    let host: unknown;
    let path: unknown;
    let port: unknown;
    const first = args[0];
    const opts = (Array.isArray(first) ? first[0] : first) as Record<string, unknown> | number | string | undefined;
    if (opts !== null && typeof opts === 'object') {
      host = opts.host;
      path = opts.path;
      port = opts.port;
    } else if (typeof opts === 'number' || (typeof opts === 'string' && /^\d+$/.test(opts))) {
      port = opts;
      host = typeof args[1] === 'string' ? args[1] : undefined;
    } else if (typeof opts === 'string') {
      path = opts;
    }
    if ((path === undefined || path === null) && !isLoopbackHost(host as string | undefined)) {
      const err = refusal(`${String(host)}:${String(port)}`);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as typeof net.Socket.prototype.connect;

  // DNS.
  const realLookup = dns.lookup;
  (dns as { lookup: unknown }).lookup = function guardedLookup(hostname: string, ...rest: unknown[]) {
    if (!isLoopbackHost(hostname)) {
      const cb = rest.find((r) => typeof r === 'function') as ((err: Error) => void) | undefined;
      const err = refusal(`DNS ${hostname}`);
      if (cb) process.nextTick(() => cb(err));
      return {};
    }
    return (realLookup as (...a: unknown[]) => unknown).call(dns, hostname, ...rest);
  };
  const realPromiseLookup = dns.promises.lookup;
  (dns.promises as { lookup: unknown }).lookup = async (hostname: string, ...rest: unknown[]) => {
    if (!isLoopbackHost(hostname)) throw refusal(`DNS ${hostname}`);
    return (realPromiseLookup as (...a: unknown[]) => Promise<unknown>).call(dns.promises, hostname, ...rest);
  };
  // Make `import { lookup } from 'node:dns/promises'` (netguard's systemResolver) see the guard too.
  syncBuiltinESMExports();

  // The global fetch: refused up front so the message is the error itself.
  const realFetch = globalThis.fetch;
  if (typeof realFetch === 'function') {
    globalThis.fetch = async function guardedFetch(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
      const href = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
      let url: URL | undefined;
      try {
        url = new URL(href);
      } catch {
        url = undefined;
      }
      if (url !== undefined && !isLoopbackHost(url.hostname)) throw refusal(url.origin);
      return realFetch(input, init);
    } as typeof fetch;
  }
}
