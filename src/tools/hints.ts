/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`). Inert data: a host that does not read them sees an extra
 * `_meta` key and nothing else. The shape is fixed by the host's contract, so
 * it is restated here rather than imported.
 *
 * Every warapp tool is in the `work` group: reads are lookups, picks are a
 * change, chat is a send. None is canonical: nothing here answers what's new,
 * due or on.
 */
import type { McpServer } from '@modelcontextprotocol/server';

export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'work';
  intent: MintIntent;
  /** Words a person says — lowercase, at most 8, each at most 40 chars. */
  aliases?: string[];
}

/** `_meta` for a war.app tool, with optional spoken aliases. */
export function mintMeta(intent: MintIntent, aliases?: string[]): { mint: MintHint } {
  return { mint: aliases ? { domain: 'work', intent, aliases } : { domain: 'work', intent } };
}

/** `_meta` for a war.app lookup, with optional spoken aliases. */
export function lookupMeta(aliases?: string[]): { mint: MintHint } {
  return mintMeta('lookup', aliases);
}

/**
 * Run `register` with `extra` (a `title`, `_meta`) merged into the config of
 * every tool it registers — for mcp-utils' `registerWrite`, which builds the
 * `registerTool` config itself and takes neither. The SAME server object is
 * patched (not a proxy), so registerWrite's per-server registry still keys on
 * the real server; the original is restored afterwards, even on a throw.
 */
export function withToolConfig(server: McpServer, extra: Record<string, unknown>, register: () => void): void {
  const target = server as unknown as { registerTool: (...args: unknown[]) => unknown };
  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'registerTool');
  const original = target.registerTool;
  target.registerTool = (name: unknown, config: unknown, ...rest: unknown[]) =>
    original.call(server, name, { ...(config as Record<string, unknown>), ...extra }, ...rest);
  try {
    register();
  } finally {
    if (hadOwn) target.registerTool = original;
    else delete (target as { registerTool?: unknown }).registerTool;
  }
}
