import { readFileSync } from 'node:fs';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { MapCache } from '../src/client.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { registerAllTools } from '../src/tools/index.js';
import { fakeWarapp, mockWarappBridge, type MockBridgeServer, type WarappExchange } from './bridge-mock.js';
import { LIVE_BUNDLE } from './protocol/live-bundle.js';
import { withSocket, type FakeSocketIo } from './push/fake-socket.js';
import { MY_GAMES_BUNDLE } from './protocol/my-games-bundle.js';

export const EMAIL = 'player@example.com';
export const TOKEN = 'deadbeefcafef00d';
export const CREDS = { WARAPP_EMAIL: EMAIL, WARAPP_API_TOKEN: TOKEN };

/** The anonymized lobby fixture (map 39905, GetSettings=true), parsed fresh each call. */
export function lobbyFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL('./fixtures/gamefeed-lobby-map39905.json', import.meta.url), 'utf8'),
  ) as Record<string, unknown>;
}

export type Call = { url: string; init: RequestInit };

/** A fetch stub answering every call with `body` (or the next of `bodies`, the last repeating). */
export function stubFetch(...bodies: unknown[]) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const body = bodies[Math.min(calls.length - 1, bodies.length - 1)];
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(text, { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

export interface Harness {
  harness: TestHarness;
  /** GameFeed calls. */
  calls: Call[];
  /** Web-client frames the fake war.app answered (through the mock bridge). */
  exchanges: WarappExchange[];
  bridge: MockBridgeServer;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
}

/** A fake war.app reply to one web-client request. */
export type WarappReply = (req: DecodedRequest, n: number) => Partial<ReplyFrame>;

/** The default fake war.app: every call answers "no result". */
const NO_RESULT: WarappReply = () => ({ body: (w) => w.bool(false) });

/**
 * A harness serving every tool, with credentials, a fresh map cache, GameFeed
 * answering with `feed` (the last repeating), a mock bridge whose fake war.app
 * answers with `warapp`, and the synthetic client bundle. Nothing reaches the
 * network.
 */
export async function liveHarness(
  opts: { feed?: unknown[]; warapp?: WarappReply; pages?: Record<string, string>; socket?: FakeSocketIo } = {},
): Promise<Harness> {
  const feed = opts.feed?.length ? opts.feed : [lobbyFixture()];
  const { calls, fetchImpl } = stubFetch(...feed);
  const fake = fakeWarapp(opts.warapp ?? NO_RESULT, opts.pages);
  const { bridge, mock } = mockWarappBridge(opts.socket ? withSocket(opts.socket, fake.handler) : fake.handler);
  const bundle = new WarappBundle(`${LIVE_BUNDLE}\n${MY_GAMES_BUNDLE}`, 'test');
  const harness = await createTestHarness((s) =>
    registerAllTools(s, {
      env: CREDS,
      fetchImpl,
      sleep: async () => {},
      mapCache: new MapCache(),
      bridge,
      bundle: async () => bundle,
    }),
  );
  return {
    harness,
    calls,
    exchanges: fake.exchanges,
    bridge: mock,
    call: (name, args = {}) => harness.client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
  };
}

/** {@link liveHarness} with GameFeed answering `bodies`. */
export function harnessFor(...bodies: unknown[]): Promise<Harness> {
  return liveHarness({ feed: bodies });
}

/** The JSON payload of a tool result. */
export function payload<T = Record<string, unknown>>(result: unknown): T {
  return parseToolResult<T>(result as CallToolResult);
}

/** The text of a (usually failing) tool result. */
export function textOf(result: unknown): string {
  return ((result as CallToolResult).content as Array<{ text: string }>)[0]!.text;
}
