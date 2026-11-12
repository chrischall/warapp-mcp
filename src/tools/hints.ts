/**
 * Context-group hints, published on each tool as `_meta.mint` (mcp-host's
 * `mintHintSchema`). Inert data: a host that does not read them sees an extra
 * `_meta` key and nothing else. The shape is fixed by the host's contract, so
 * it is restated here rather than imported.
 *
 * Every warapp read is a `work`-group lookup. None is canonical: nothing here
 * answers what's new, due or on.
 */
export type MintIntent =
  | 'whats-new' | 'whats-due' | 'whats-on' | 'lookup' | 'turn-on-off' | 'send' | 'change' | 'other';

export interface MintHint {
  domain: 'work';
  intent: MintIntent;
  /** Words a person says — lowercase, at most 8, each at most 40 chars. */
  aliases?: string[];
}

/** `_meta` for a war.app lookup, with optional spoken aliases. */
export function lookupMeta(aliases?: string[]): { mint: MintHint } {
  return { mint: aliases ? { domain: 'work', intent: 'lookup', aliases } : { domain: 'work', intent: 'lookup' } };
}
