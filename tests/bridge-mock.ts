// A stand-in FetchproxyServer for the createServer seam, plus a fake war.app
// that answers web-client frames. Everything here is synthetic: frames are
// built by this project's own encoder, the account is test@example.com.
import type { FetchproxyServer, FetchproxyServerOpts, HttpResponse } from '@fetchproxy/server';
import {
  decodeRequest,
  encodeReply,
  fromHex,
  toHex,
  type DecodedRequest,
  type ReplyFrame,
} from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { createWarappBridge, type WarappBridge } from '../src/transport-bridge.js';

export const TEST_EMAIL = 'test@example.com';

export interface BridgeRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export type BridgeHandler = (req: BridgeRequest) => HttpResponse | Promise<HttpResponse>;

export interface MockBridgeServer {
  server: FetchproxyServer;
  requests: BridgeRequest[];
  ctorOpts: FetchproxyServerOpts[];
  listenCalls: number;
  closeCalls: number;
  createServer: (opts: FetchproxyServerOpts) => FetchproxyServer;
}

/** A FetchproxyServer double: `role` is null until the first request, as in the real bridge. */
export function mockBridgeServer(handler: BridgeHandler): MockBridgeServer {
  let role: 'host' | null = null;
  const state: MockBridgeServer = {
    server: undefined as unknown as FetchproxyServer,
    requests: [],
    ctorOpts: [],
    listenCalls: 0,
    closeCalls: 0,
    createServer: (opts) => {
      state.ctorOpts.push(opts);
      return state.server;
    },
  };
  const health = () => ({
    role,
    port: state.ctorOpts[0]?.port ?? 37149,
    host: '127.0.0.1',
    serverVersion: state.ctorOpts[0]?.version ?? '0.0.0',
    fetchTimeoutMs: 30_000,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureReason: null,
    consecutiveFailures: 0,
    lastExtensionMessageAt: null,
    session: {
      state: 'ready',
      pairCode: null,
      extensionConnected: true,
      unavailableCapabilities: [],
      features: [],
      platform: 'chrome',
    },
  });
  const server = {
    get role() {
      return role;
    },
    async listen() {
      state.listenCalls++;
    },
    async close() {
      state.closeCalls++;
    },
    bridgeHealth: health,
    async request(method: string, path: string, opts: { headers?: Record<string, string>; body?: string } = {}) {
      const req: BridgeRequest = { method, path, headers: opts.headers ?? {}, body: opts.body };
      state.requests.push(req);
      role = 'host';
      return handler(req);
    },
    async runProbe(fetchFn: (p: string) => Promise<unknown>, probePath: string) {
      const start = Date.now();
      let error: { kind: string; message: string } | undefined;
      try {
        await fetchFn(probePath);
      } catch (e) {
        error = { kind: 'unknown', message: e instanceof Error ? e.message : String(e) };
      }
      const h = health();
      return {
        ok: error === undefined,
        elapsed_ms: Date.now() - start,
        bridge: {
          role: h.role,
          port: h.port,
          server_version: h.serverVersion,
          fetch_timeout_ms: h.fetchTimeoutMs,
          last_success_at: null,
          last_failure_at: null,
          last_failure_reason: null,
          consecutive_failures: 0,
          session_state: 'ready',
          pending_pair_code: null,
          extension_connected: true,
          last_extension_message_at: null,
          unavailable_capabilities: [],
          platform: 'chrome',
        },
        ...(error ? { error } : {}),
      };
    },
  };
  state.server = server as unknown as FetchproxyServer;
  return state;
}

/** Methods whose frame carries no auth block. */
const NO_AUTH = new Set<number>([Method.GetMapDetails]);

export interface WarappExchange {
  path: string;
  headers: Record<string, string>;
  request: DecodedRequest;
}

/**
 * A fake war.app `/Services` endpoint. `reply` gets each decoded request and
 * returns the reply frame fields (method and msgNum default to the request's),
 * or a raw `HttpResponse` to answer with something that is not a frame.
 */
export function fakeWarapp(
  reply: (req: DecodedRequest, n: number) => Partial<ReplyFrame> | HttpResponse,
): { handler: BridgeHandler; exchanges: WarappExchange[] } {
  const exchanges: WarappExchange[] = [];
  const handler: BridgeHandler = (req) => {
    const decoded = decodeRequest(fromHex(req.body ?? ''), { hasAuth: !NO_AUTH.has(readMethod(req.body ?? '')) });
    exchanges.push({ path: req.path, headers: req.headers, request: decoded });
    const out = reply(decoded, exchanges.length);
    if ('status' in out && 'body' in out && typeof out.body === 'string') return out as HttpResponse;
    const frame = out as Partial<ReplyFrame>;
    const bytes = encodeReply({ method: decoded.method, msgNum: decoded.msgNum, ...frame });
    return { status: 200, body: toHex(bytes), url: `https://war.app${req.path}` };
  };
  return { handler, exchanges };
}

/** The method id at byte 10 of a hex-encoded frame. */
function readMethod(hex: string): number {
  const b = fromHex(hex.slice(0, 28));
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(10, true);
}

/** A warapp bridge over the mock server. */
export function mockWarappBridge(handler: BridgeHandler): { bridge: WarappBridge; mock: MockBridgeServer } {
  const mock = mockBridgeServer(handler);
  return { bridge: createWarappBridge({ env: {}, createServer: mock.createServer }), mock };
}
