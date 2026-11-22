// warapp_plan_picks on a very large manual-pick FFA (the live case: 3,066 territories, 173 bonuses, 25 players): a
// bounded answer inside the time budget, a structured tool error instead of a silent host failure, and the same
// compact answer on a small game. Every id and name here is made up; nothing reaches war.app.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { picksBudgetMs, DEFAULT_PICKS_BUDGET_MS } from '../src/tools/picks.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';
import { bigUs } from './analysis/support/large-map.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };

/** The lobby fixture turned into a 25-player picking game on the synthetic big map. */
function bigGame(): { feed: Record<string, unknown>; board: SyntheticTerritory[] } {
  const { graph, pickable } = bigUs();
  const f = lobbyFixture();
  const base = (f.players as Array<Record<string, string>>)[0]!;
  const players = Array.from({ length: 25 }, (_, i) => ({ ...base, id: i === 0 ? ANN.feed : String(1_000_000_000 + i * 7919), name: `P${i}` }));
  const territories = graph.map.territories.map((t) => ({ id: String(t.id), name: t.name, connectedTo: t.connectedTo }));
  const bonuses = graph.map.bonuses.map((b) => ({ id: String(b.id), name: b.name, value: String(b.value), territoryIDs: b.territoryIds }));
  const feed = {
    ...f,
    state: 'DistributingTerritories',
    numberOfTurns: '-1',
    players,
    settings: { ...(f.settings as Record<string, unknown>), TerritoryLimit: 3 },
    map: { id: '24591', name: 'Synthetic Big', territories, bonuses, distributionModes: [] },
  };
  return { feed, board: pickable.map((id) => ({ id, fogLevel: 2, owner: -2, armies: 8 })) };
}

const reply =
  (board: SyntheticTerritory[]) =>
  (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method !== Method.GetLatestGameInfo) throw new Error(`unexpected method ${req.method}`);
    return { body: (w) => writeLatestGameInfo(w, board, [ANN.inGame]) };
  };

interface Plan {
  picks: Array<{ territory: { id: number }; reasons: string[]; reasonsOmitted?: number }>;
  submitPicks: { game_id: number; territories: number[] };
  partial?: boolean;
  candidates?: { ranked: number; pickable: number };
  warnings: string[];
  rationale: string[];
}

describe('warapp_plan_picks on a very large game', () => {
  it('answers inside the budget with a bounded compact view, and a submit list that is the whole answer', async () => {
    const { feed, board } = bigGame();
    h = await liveHarness({ feed: [feed], warapp: (req) => reply(board)(req) });
    const t0 = Date.now();
    const result = await h.call('warapp_plan_picks', { game_id: GAME });
    expect(result.isError).toBeFalsy();
    expect(Date.now() - t0).toBeLessThan(25_000);
    const text = textOf(result);
    expect(text.length).toBeLessThan(120_000);
    const p = payload<Plan>(result);
    expect(p.partial).toBeUndefined();
    expect(p.candidates!.pickable).toBe(board.length);
    // The submit list is never cut: players × territories per player.
    expect(p.submitPicks.territories).toHaveLength(75);
    expect(new Set(p.submitPicks.territories).size).toBe(75);
    expect(p.picks).toHaveLength(75);
    // Beyond the first picks the compact view counts reasons instead of listing them.
    expect(p.picks[74]!.reasons).toEqual([]);
    expect(p.picks[74]!.reasonsOmitted).toBeGreaterThan(0);
  }, 90_000);

  it('a tiny budget returns a valid partial list, not an error', async () => {
    const { feed, board } = bigGame();
    h = await liveHarness({ feed: [feed], warapp: (req) => reply(board)(req), env: { WARAPP_PICKS_BUDGET_MS: '1' } });
    const result = await h.call('warapp_plan_picks', { game_id: GAME });
    expect(result.isError).toBeFalsy();
    const p = payload<Plan>(result);
    expect(p.partial).toBe(true);
    expect(p.warnings.join('\n')).toMatch(/time budget ran out/);
    expect(p.submitPicks.territories).toHaveLength(75);
    expect(new Set(p.submitPicks.territories).size).toBe(75);
  }, 90_000);
});

describe('the picks time budget', () => {
  it('defaults to 20 s, reads WARAPP_PICKS_BUDGET_MS, and 0 or less means none', () => {
    expect(DEFAULT_PICKS_BUDGET_MS).toBe(20_000);
    expect(picksBudgetMs({})).toBe(20_000);
    expect(picksBudgetMs({ WARAPP_PICKS_BUDGET_MS: '5000' })).toBe(5000);
    expect(picksBudgetMs({ WARAPP_PICKS_BUDGET_MS: '0' })).toBeUndefined();
    expect(picksBudgetMs({ WARAPP_PICKS_BUDGET_MS: 'soon' })).toBe(20_000);
  });
});
