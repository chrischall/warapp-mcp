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
function bigGame(limit = 3): { feed: Record<string, unknown>; board: SyntheticTerritory[] } {
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
    settings: {
      ...(f.settings as Record<string, unknown>),
      TerritoryLimit: limit,
      // The single-pick ranking runs only in a game that overrides bonus values; a limit-3 game is planned as before with one.
      ...(limit === 1 ? { OverriddenBonuses: [{ bonusID: graph.map.bonuses[0]!.id, value: 0 }] } : {}),
    },
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

interface StartRanking {
  shown: { from: number; to: number; of: number };
  page: number;
  pages: number;
  starts: Array<{
    rank: number;
    territory: { id: number; name: string };
    score: number;
    firstIncomeTurn: number | null;
    safety: { approaches: number; entries: number; nearestStart: number | null };
    reasons: string[];
  }>;
}

describe('warapp_plan_picks with a territory limit of 1 on a huge map (mega-game spec part 2)', () => {
  it('ranks single starts: 25 shown with reasons and safety, the submit list the ranking within the client max', async () => {
    const { feed, board } = bigGame(1);
    h = await liveHarness({ feed: [feed], warapp: (req) => reply(board)(req) });
    const t0 = Date.now();
    const result = await h.call('warapp_plan_picks', { game_id: GAME });
    expect(result.isError).toBeFalsy();
    expect(Date.now() - t0).toBeLessThan(10_000);
    const p = payload<Plan & { startRanking: StartRanking }>(result);
    const r = p.startRanking;
    expect(r.shown).toEqual({ from: 1, to: 25, of: board.length });
    expect(r.starts).toHaveLength(25);
    expect(r.starts.map((x) => x.rank)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(r.starts[0]!.territory.name).toEqual(expect.any(String));
    expect(r.starts[0]!.reasons.join('\n')).toMatch(/safety/);
    // players × 1 = 25 picks, in rank order.
    expect(p.submitPicks.territories).toHaveLength(25);
    expect(p.submitPicks.territories).toEqual(r.starts.map((x) => x.territory.id));
    const two = payload<Plan & { startRanking: StartRanking }>(await h.call('warapp_plan_picks', { game_id: GAME, page: 2 }));
    expect(two.startRanking.shown.from).toBe(26);
    expect(two.startRanking.starts[0]!.rank).toBe(26);
    expect(two.submitPicks.territories).toEqual(p.submitPicks.territories);
  }, 90_000);

  it('a territory limit of 3, or no overrides, on the same map keeps the group plan (no start ranking)', async () => {
    const plain = bigGame(1);
    delete ((plain.feed.settings as Record<string, unknown>).OverriddenBonuses);
    h = await liveHarness({ feed: [plain.feed], warapp: (req) => reply(plain.board)(req) });
    expect(payload<Record<string, unknown>>(await h.call('warapp_plan_picks', { game_id: GAME }))).not.toHaveProperty('startRanking');
    await h.harness.close();
    const { feed, board } = bigGame(3);
    h = await liveHarness({ feed: [feed], warapp: (req) => reply(board)(req) });
    const p = payload<Record<string, unknown>>(await h.call('warapp_plan_picks', { game_id: GAME }));
    expect(p).not.toHaveProperty('startRanking');
  }, 90_000);
});
