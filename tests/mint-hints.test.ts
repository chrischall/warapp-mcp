import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessFor, type Harness } from './helpers.js';

/**
 * Context-group hints (`_meta.mint`, mcp-host's mintHintSchema), read off the
 * served tools/list — what a host sees. Every warapp tool is in the `work`
 * group: reads are lookups, submitting picks or a turn a change, chat a send; none is
 * canonical (nothing here answers what's new / due / on).
 */
const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

const EXPECTED_INTENT: Record<string, string> = {
  warapp_get_game: 'lookup',
  warapp_get_map: 'lookup',
  warapp_analyze_board: 'lookup',
  warapp_plan_route: 'lookup',
  warapp_get_live_board: 'lookup',
  warapp_get_my_picks: 'lookup',
  warapp_plan_turn: 'lookup',
  warapp_get_chat: 'lookup',
  warapp_submit_picks: 'change',
  warapp_submit_turn: 'change',
  warapp_send_chat: 'send',
};

interface Tool {
  name: string;
  _meta?: Record<string, unknown>;
}
type Mint = Record<string, unknown>;

let h: Harness;
let tools: Tool[];
const mintOf = (t: Tool) => t._meta?.mint as Mint | undefined;

beforeAll(async () => {
  h = await harnessFor();
  tools = (await h.harness.client.listTools()).tools as unknown as Tool[];
});
afterAll(async () => {
  await h?.harness.close();
});

describe('_meta.mint on tools/list', () => {
  it('hints every served tool except the healthcheck, and names each one here', () => {
    expect(tools.filter((t) => mintOf(t)).map((t) => t.name).sort()).toEqual(Object.keys(EXPECTED_INTENT).sort());
    expect(tools.filter((t) => !mintOf(t)).map((t) => t.name)).toEqual(['warapp_healthcheck']);
  });

  it.each(Object.entries(EXPECTED_INTENT))('%s is in the work group with intent %s', (name, intent) => {
    const mint = mintOf(tools.find((t) => t.name === name)!);
    expect(mint?.domain).toBe('work');
    expect(mint?.intent).toBe(intent);
  });

  it('every hint is shaped per the host contract, none canonical', () => {
    for (const t of tools) {
      const mint = mintOf(t);
      if (!mint) continue;
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      expect(mint, t.name).not.toHaveProperty('canonical');
      if ('aliases' in mint) {
        const aliases = mint.aliases as string[];
        expect(aliases.length, t.name).toBeGreaterThan(0);
        expect(aliases.length, t.name).toBeLessThanOrEqual(8);
        for (const a of aliases) {
          expect(a.length, t.name).toBeLessThanOrEqual(40);
          expect(a, t.name).toBe(a.toLowerCase());
        }
      }
    }
  });
});
