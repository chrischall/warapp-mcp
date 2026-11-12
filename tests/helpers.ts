import { readFileSync } from 'node:fs';
import { createTestHarness, parseToolResult, type TestHarness } from '@chrischall/mcp-utils/test';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { MapCache } from '../src/client.js';
import { registerAllTools } from '../src/tools/index.js';

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
  calls: Call[];
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
}

/** A harness serving every tool, with credentials and a fresh map cache, answering with `bodies`. */
export async function harnessFor(...bodies: unknown[]): Promise<Harness> {
  const { calls, fetchImpl } = stubFetch(...(bodies.length ? bodies : [lobbyFixture()]));
  const harness = await createTestHarness((s) =>
    registerAllTools(s, { env: CREDS, fetchImpl, sleep: async () => {}, mapCache: new MapCache() }),
  );
  return {
    harness,
    calls,
    call: (name, args = {}) => harness.client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
  };
}

/** The JSON payload of a tool result. */
export function payload<T = Record<string, unknown>>(result: unknown): T {
  return parseToolResult<T>(result as CallToolResult);
}

/** The text of a (usually failing) tool result. */
export function textOf(result: unknown): string {
  return ((result as CallToolResult).content as Array<{ text: string }>)[0]!.text;
}
