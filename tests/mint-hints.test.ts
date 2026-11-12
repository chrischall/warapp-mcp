import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { harnessFor, type Harness } from './helpers.js';

/**
 * Context-group hints (`_meta.mint`, mcp-host's mintHintSchema), read off the
 * served tools/list — what a host sees. Every warapp tool is in the `work`
 * group: reads are lookups, submitting picks or a turn a change, chat a send.
 * One tool is canonical: `warapp_my_games` answers what's new (which games need
 * me), and like every canonical read it accepts `view: 'brief'`.
 */
const DOMAINS = ['school', 'home', 'work', 'family', 'health', 'money', 'travel', 'food'];
const INTENTS = ['whats-new', 'whats-due', 'whats-on', 'lookup', 'turn-on-off', 'send', 'change', 'other'];
const KEYS = ['domain', 'intent', 'canonical', 'subject', 'when', 'aliases'];

const EXPECTED_INTENT: Record<string, string> = {
  warapp_my_games: 'whats-new',
  warapp_get_game: 'lookup',
  warapp_get_map: 'lookup',
  warapp_analyze_board: 'lookup',
  warapp_plan_route: 'lookup',
  warapp_get_live_board: 'lookup',
  warapp_get_my_picks: 'lookup',
  warapp_plan_turn: 'lookup',
  warapp_get_chat: 'lookup',
  warapp_scout_player: 'lookup',
  warapp_list_open_games: 'lookup',
  warapp_submit_picks: 'change',
  warapp_submit_turn: 'change',
  warapp_join_game: 'change',
  warapp_surrender: 'change',
  warapp_send_chat: 'send',
  warapp_wait_for_turn: 'whats-new',
  warapp_recent_events: 'lookup',
  warapp_session_status: 'lookup',
  warapp_link_session: 'change',
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

  it('every hint is shaped per the host contract', () => {
    for (const t of tools) {
      const mint = mintOf(t);
      if (!mint) continue;
      expect(Object.keys(mint).filter((k) => !KEYS.includes(k)), t.name).toEqual([]);
      expect(DOMAINS, t.name).toContain(mint.domain);
      expect(INTENTS, t.name).toContain(mint.intent);
      if ('canonical' in mint) expect(mint.canonical, t.name).toBe(true);
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

  it('marks warapp_my_games as THE canonical whats-new tool', () => {
    const canonical = tools.filter((t) => mintOf(t)?.canonical === true);
    expect(canonical.map((t) => [t.name, mintOf(t)!.intent])).toEqual([['warapp_my_games', 'whats-new']]);
    expect(mintOf(canonical[0]!)).toMatchObject({ domain: 'work', intent: 'whats-new', canonical: true });
  });

  it('every canonical read accepts view: "brief"', () => {
    for (const t of tools.filter((x) => mintOf(x)?.canonical === true)) {
      const props = (t as unknown as { inputSchema: { properties?: Record<string, { enum?: string[] }> } }).inputSchema
        .properties;
      expect(props?.view?.enum, t.name).toContain('brief');
    }
  });
});
