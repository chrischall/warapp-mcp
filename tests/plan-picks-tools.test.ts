import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };

/** The lobby fixture (TerritoryLimit 3, 9 players) with two wrapped ids, in a given state. */
function game(state: string, settings: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return {
    ...f,
    state,
    numberOfTurns: state === 'Playing' ? '2' : '-1',
    players,
    settings: { ...(f.settings as Record<string, unknown>), ...settings },
  };
}

function mapName(id: number): string {
  const map = lobbyFixture().map as { territories: Array<{ id: string; name: string }> };
  return map.territories.find((t) => Number(t.id) === id)!.name;
}

// Fixture map: bonus 118 (+2) = 159, 161, 157; bonus 116 (+2) = 133, 134, 135, 158.
const PICK_BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 2, owner: -2, armies: 3 },
  { id: 161, fogLevel: 2, owner: -2, armies: 3 },
  { id: 157, fogLevel: 2, owner: -2, armies: 3 },
  { id: 135, fogLevel: 2, owner: -2, armies: 3 },
  { id: 133, fogLevel: 2, owner: -2, armies: 3 },
  { id: 134, fogLevel: 2, owner: -2, armies: 3 },
  { id: 158, fogLevel: 2, owner: 0, armies: 2 },
];
const PICKABLE = [133, 134, 135, 157, 159, 161];

type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;
function routes(r: Routes) {
  return (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
    const f = r[req.method];
    if (!f) throw new Error(`unexpected method ${req.method}`);
    return f(req, n);
  };
}
const board = (territories: SyntheticTerritory[] | null) => () =>
  ({ body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) }) satisfies Partial<ReplyFrame>;

interface Named {
  id: number;
  name: string;
}
interface PlanPicksPayload {
  game: { id: number; name: string | null; state: string };
  players: number;
  territoryLimit: number;
  maxPicks: number;
  picks: Array<{ priority: number; territory: Named; group: 'primary' | 'fallback'; score: number; reasons: string[] }>;
  groups: Record<
    'primary' | 'fallback',
    {
      territories: Named[];
      score: number;
      maxHops: number | null;
      bonuses: Array<Named & { value: number; turn: number; threats: Named[] }>;
      twoOrderCaptures: Array<{ turn: number; territory: Named; orders: Array<{ from: Named; armies: number }> }>;
    }
  >;
  warnings: string[];
  rationale: string[];
  submitPicks: { game_id: number; territories: number[] };
  award: { outcomes: number; worst: { territories: Named[]; score: number; opponentStarts: Named[] }; reordered: boolean } | null;
  settings?: Record<string, unknown>;
  untrusted_content?: boolean;
}

describe('warapp_plan_picks', () => {
  it('ranks the pickable territories by name and id, in two groups, with a submit_picks argument', async () => {
    h = await liveHarness({ feed: [game('DistributingTerritories')], warapp: routes({ [Method.GetLatestGameInfo]: board(PICK_BOARD) }) });
    const p = payload<PlanPicksPayload>(await h.call('warapp_plan_picks', { game_id: GAME }));
    expect(p.untrusted_content).toBe(true);
    expect(p.game).toEqual({ id: GAME, name: 'Synthetic lobby game', state: 'DistributingTerritories' });
    expect(p.players).toBe(9);
    expect(p.territoryLimit).toBe(3);
    // war.app's client allows players × territories per player (#129); 6 pickables cannot give 9
    // players one each, so the list is the primary alone.
    expect(p.maxPicks).toBe(3);

    // Pickables listed once, in priority order, by name and id; never anything else.
    expect(p.picks.map((x) => x.priority)).toEqual([1, 2, 3]);
    expect(p.picks.every((x) => PICKABLE.includes(x.territory.id))).toBe(true);
    for (const x of p.picks) {
      expect(x.territory.name).toBe(mapName(x.territory.id));
      expect(x.reasons.length).toBeGreaterThan(0);
      expect(typeof x.score).toBe('number');
    }
    // The first TerritoryLimit picks are the primary group; the rest the fallback, disjoint.
    expect(p.picks.slice(0, 3).every((x) => x.group === 'primary')).toBe(true);
    expect(p.picks.slice(3).every((x) => x.group === 'fallback')).toBe(true);
    expect(p.groups.primary.territories).toEqual(p.picks.slice(0, 3).map((x) => x.territory));
    expect(p.groups.fallback.territories).toEqual(p.picks.slice(3).map((x) => x.territory));
    const primary = new Set(p.groups.primary.territories.map((t) => t.id));
    expect(p.groups.fallback.territories.some((t) => primary.has(t.id))).toBe(false);
    // Each group states how far apart its two farthest picks are, in hops.
    for (const grp of [p.groups.primary, p.groups.fallback]) expect(grp.maxHops === null || grp.maxHops >= 0).toBe(true);
    expect(typeof p.groups.primary.maxHops).toBe('number');
    // Each completed bonus names the other pickable territories that can reach it in time (#166).
    for (const b of [...p.groups.primary.bonuses, ...p.groups.fallback.bonuses]) {
      expect(b).toEqual({
        id: expect.any(Number),
        name: expect.any(String),
        value: expect.any(Number),
        turn: expect.any(Number),
        threats: expect.any(Array),
      });
      for (const t of b.threats) {
        expect(PICKABLE).toContain(t.id);
        expect(primary.has(t.id)).toBe(false);
        expect(t.name).toBe(mapName(t.id));
      }
    }
    expect(p.groups.primary.bonuses.some((b) => b.threats.length > 0)).toBe(true);
    for (const grp of [p.groups.primary, p.groups.fallback]) expect(Array.isArray(grp.twoOrderCaptures)).toBe(true);

    // Exactly what warapp_submit_picks takes: ids in pick order.
    expect(p.submitPicks).toEqual({ game_id: GAME, territories: p.picks.map((x) => x.territory.id) });
    expect(Array.isArray(p.warnings)).toBe(true);
    expect(p.rationale.length).toBeGreaterThan(0);
    expect(p).not.toHaveProperty('settings');

    // One board read through the bridge; nothing sent.
    expect(h.exchanges.map((e) => e.request.method)).toEqual([Method.GetLatestGameInfo]);
  });

  it('is deterministic, and the full view adds the settings the plan assumed', async () => {
    h = await liveHarness({ feed: [game('DistributingTerritories')], warapp: routes({ [Method.GetLatestGameInfo]: board(PICK_BOARD) }) });
    const a = payload<PlanPicksPayload>(await h.call('warapp_plan_picks', { game_id: GAME }));
    const b = payload<PlanPicksPayload>(await h.call('warapp_plan_picks', { game_id: GAME, view: 'full' }));
    expect(b.picks).toEqual(a.picks);
    expect(b.submitPicks).toEqual(a.submitPicks);
    expect(b.settings).toMatchObject({
      initialPlayerArmiesPerTerritory: 8,
      initialNeutralsInDistribution: 3,
      initialNonDistributionArmies: 2,
      minimumArmyBonus: 5,
      offensiveKillRate: 60,
      defensiveKillRate: 70,
    });
  });

  it('never lists more than the game allows when fewer picks are allowed than pickables', async () => {
    const g = game('DistributingTerritories', { TerritoryLimit: 1 });
    h = await liveHarness({
      feed: [{ ...g, players: (g.players as unknown[]).slice(0, 2) }],
      warapp: routes({ [Method.GetLatestGameInfo]: board(PICK_BOARD) }),
    });
    const p = payload<PlanPicksPayload>(await h.call('warapp_plan_picks', { game_id: GAME }));
    expect(p.maxPicks).toBe(2);
    expect(p.picks.map((x) => x.group)).toEqual(['primary', 'fallback']);
    expect(p.submitPicks.territories).toHaveLength(2);
  });

  it('lists as many picks as the client allows: players × territories per player (#129)', async () => {
    const g = game('DistributingTerritories');
    h = await liveHarness({
      feed: [{ ...g, players: (g.players as unknown[]).slice(0, 2) }],
      warapp: routes({ [Method.GetLatestGameInfo]: board(PICK_BOARD) }),
    });
    const p = payload<PlanPicksPayload>(await h.call('warapp_plan_picks', { game_id: GAME }));
    expect(p.maxPicks).toBe(6);
    expect(p.picks.map((x) => x.territory.id).sort((a, b) => a - b)).toEqual(PICKABLE);
    expect(p.groups.fallback.territories).toHaveLength(3);
    // The list judged by the award order: a 3-pick 1v1 list of 6 can yield 11 sets.
    expect(p.award).toMatchObject({ outcomes: 11, reordered: expect.any(Boolean) });
    for (const t of [...p.award!.worst.territories, ...p.award!.worst.opponentStarts]) expect(t.name).toBe(mapName(t.id));
    // In a two-player game the fallback picks answer the loss that grants them (#166), and say so.
    expect(p.picks.slice(0, 3).some((x) => x.reasons.some((r) => r.startsWith('Answers the loss of ')))).toBe(false);
    expect(p.picks.slice(3).some((x) => x.reasons.some((r) => r.startsWith('Answers the loss of ')))).toBe(true);
    expect(p.rationale.join(' ')).toMatch(/each fallback pick is chosen for the outcomes that grant it/);
  });

  it('lists the captures of a group’s opening that take two orders, by name (#166)', async () => {
    // 5 armies a pick and 6 income: the primary takes a 3-army neutral with 1 army and then 3.
    const g = game('DistributingTerritories', { InitialPlayerArmiesPerTerritory: '5', MinimumArmyBonus: '6' });
    h = await liveHarness({
      feed: [{ ...g, players: (g.players as unknown[]).slice(0, 2) }],
      warapp: routes({ [Method.GetLatestGameInfo]: board(PICK_BOARD) }),
    });
    const p = payload<PlanPicksPayload>(await h.call('warapp_plan_picks', { game_id: GAME }));
    const captures = p.groups.primary.twoOrderCaptures;
    expect(captures.length).toBeGreaterThan(0);
    for (const c of captures) {
      expect(c.turn).toBeGreaterThanOrEqual(1);
      expect(c.territory.name).toBe(mapName(c.territory.id));
      expect(c.orders).toHaveLength(2);
      for (const o of c.orders) {
        expect(o.from.name).toBe(mapName(o.from.id));
        expect(o.armies).toBeGreaterThan(0);
      }
    }
    expect(captures[0]!.orders.map((o) => o.armies)).toEqual([1, 3]);
    // No-Split forbids a second order from the same territory: none is planned.
    await h.harness.close();
    const noSplit = game('DistributingTerritories', { InitialPlayerArmiesPerTerritory: '5', MinimumArmyBonus: '6', NoSplit: true });
    h = await liveHarness({
      feed: [{ ...noSplit, players: (noSplit.players as unknown[]).slice(0, 2) }],
      warapp: routes({ [Method.GetLatestGameInfo]: board(PICK_BOARD) }),
    });
    const q = payload<PlanPicksPayload>(await h.call('warapp_plan_picks', { game_id: GAME }));
    expect(q.groups.primary.twoOrderCaptures).toEqual([]);
    expect(q.groups.fallback.twoOrderCaptures).toEqual([]);
    expect(q.picks.flatMap((x) => x.reasons).join(' ')).not.toMatch(/two orders/);
  });

  it('in a 1v1 keeps the primary compact by default, and spreads it only with spread: true (#73)', async () => {
    const duel = () => {
      const g = game('DistributingTerritories');
      return { ...g, players: (g.players as unknown[]).slice(0, 2) };
    };
    h = await liveHarness({ feed: [duel()], warapp: routes({ [Method.GetLatestGameInfo]: board(PICK_BOARD) }) });
    const compact = payload<PlanPicksPayload>(await h.call('warapp_plan_picks', { game_id: GAME }));
    expect(compact.players).toBe(2);
    expect(compact.rationale.join(' ')).toMatch(/In a 1v1 .*compact/);
    expect(compact.rationale.join(' ')).not.toMatch(/with spread on/);
    const spread = payload<PlanPicksPayload>(await h.call('warapp_plan_picks', { game_id: GAME, spread: true }));
    expect(spread.rationale.join(' ')).toMatch(/with spread on/);
  });

  it('describes the spread parameter', async () => {
    h = await liveHarness({ feed: [game('DistributingTerritories')] });
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_plan_picks')!;
    const prop = (tool.inputSchema.properties as Record<string, { type?: string; description?: string }>).spread!;
    expect(prop.type).toBe('boolean');
    expect(prop.description).toMatch(/counter-pick/);
    expect(prop.description).toMatch(/usually worse on large maps/);
    expect(tool.description).not.toMatch(/bounded spread/);
  });

  it('describes what the scores now take into account, and the two-player fallback (#166)', async () => {
    h = await liveHarness({ feed: [game('DistributingTerritories')] });
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_plan_picks')!;
    expect(tool.description).toMatch(/`threats`/);
    expect(tool.description).toMatch(/`twoOrderCaptures`/);
    expect(tool.description).toMatch(/double border/);
    expect(tool.description).toMatch(/two-player game.*answers? the loss/);
    expect(tool.description).not.toMatch(/another area/);
  });

  it('refuses outside the picking stage, without touching the bridge', async () => {
    h = await liveHarness({ feed: [game('Playing')], warapp: routes({}) });
    const res = await h.call('warapp_plan_picks', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not in the picking stage/i);
    expect(textOf(res)).toMatch(/Playing/);
    expect(h.exchanges).toEqual([]);
  });

  it('refuses when the live board has nothing pickable', async () => {
    const none = PICK_BOARD.map((t) => ({ ...t, owner: 0 }));
    h = await liveHarness({ feed: [game('DistributingTerritories')], warapp: routes({ [Method.GetLatestGameInfo]: board(none) }) });
    const res = await h.call('warapp_plan_picks', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no pickable territor/i);
  });

  it('is described and annotated as read-only', async () => {
    h = await liveHarness({ feed: [game('DistributingTerritories')] });
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_plan_picks')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.description).toMatch(/warapp_submit_picks/);
    expect(tool.description).toMatch(/read-only/i);
  });
});
