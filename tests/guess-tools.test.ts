// warapp_plan_turn's border guess: present (with orders warapp_submit_turn takes) when one opponent
// touches two of my borders and no fixed split of the deploys there holds both, absent otherwise.
// Synthetic board on the anonymized lobby fixture's map; no war.app traffic.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { normalizeMap } from '../src/normalize.js';
import { validateTurn } from '../src/tools/turn.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };

function game(turn = 3, settings: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const ids = [ANN, BOB];
  const players = (f.players as Array<Record<string, string>>)
    .slice(0, 2)
    .map((p, i) => ({ ...p, id: ids[i]!.feed, name: ['Ann', 'Bob'][i]!, state: 'Playing' }));
  return { ...f, state: 'Playing', numberOfTurns: String(turn - 1), players, settings: { ...(f.settings as object), ...settings } };
}

async function live(territories: SyntheticTerritory[], feed: Record<string, unknown>): Promise<Harness> {
  return liveHarness({
    feed: [feed],
    warapp: (req: DecodedRequest): Partial<ReplyFrame> => {
      if (req.method !== Method.GetLatestGameInfo) throw new Error(`unexpected method ${req.method}`);
      return { body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) };
    },
  });
}

// Fixture map: 159 Hornwood and 161 Sheepshead Hills both border 158 Bolton Moors.
const board = (bob: number): SyntheticTerritory[] => [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: bob },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

interface Named {
  id: number;
  name: string;
}
interface Order {
  kind: string;
  territory?: number;
  armies?: number;
  from?: number;
  to?: number;
}
interface Plan {
  income: number;
  orders: Order[];
  deploys: Array<{ territory: Named; armies: number }>;
  guess?: {
    opponent: { id: number; name: string | null };
    borders: Array<Named & { holdProbability: number; holdAloneProbability: number; worth?: number; mix?: unknown }>;
    fixedLoss: number;
    mixedLoss: number;
    planLoss: number;
    deploys: Array<{ territory: Named; armies: number }>;
    summary: string;
    mix?: unknown;
  };
  guessOrders?: Order[];
  guessSkipped?: { reason: string; message: string };
}

const plan = async (hh: Harness, view?: 'full') =>
  payload<Plan>(await hh.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', ...(view ? { view } : {}) }));
const deployTotal = (os: Order[]) => os.filter((o) => o.kind === 'deploy').reduce((a, o) => a + o.armies!, 0);
const liveBoard = (ts: SyntheticTerritory[]) =>
  ts.map((t) => ({ territoryId: t.id, fogLevel: t.fogLevel, fogged: t.fogged ?? false, owner: t.owner, armies: t.armies }));

describe('warapp_plan_turn — the border guess', () => {
  it('a stack of 12 beside both of my 5s: the guess, with orders warapp_submit_turn takes; the plan orders unchanged', async () => {
    h = await live(board(12), game());
    const p = await plan(h);
    // The plan's own split: all 5 on Hornwood.
    expect(p.orders).toEqual([{ kind: 'deploy', territory: 159, armies: 5 }]);
    const g = p.guess!;
    expect(g.opponent).toEqual({ id: Number(BOB.feed), name: 'Bob' });
    expect(g.borders.map((b) => b.id)).toEqual([159, 161]);
    for (const b of g.borders) expect(b.holdAloneProbability).toBeCloseTo(0.5, 6);
    expect(g).toMatchObject({ fixedLoss: 2, planLoss: 2, mixedLoss: 1.5 });
    expect(g.summary).toMatch(/at random, weighted by worth/);
    // Compact: no mix, no skip reason.
    expect(g).not.toHaveProperty('mix');
    expect(p).not.toHaveProperty('guessSkipped');
    // The guess's orders: the same income, deployed on my own territories, and valid for submit.
    const go = p.guessOrders!;
    expect(deployTotal(go)).toBe(p.income);
    expect(go.filter((o) => o.kind === 'deploy').map((o) => ({ territory: o.territory, armies: o.armies }))).toEqual(
      g.deploys.map((d) => ({ territory: d.territory.id, armies: d.armies })),
    );
    const map = normalizeMap(lobbyFixture().map);
    const T = (id: number) => ({ id, name: map.territories.find((t) => t.id === id)!.name });
    expect(
      validateTurn({
        map,
        board: liveBoard(board(12)),
        myInGameId: ANN.inGame,
        income: p.income,
        guard: true,
        deploys: go.filter((o) => o.kind === 'deploy').map((o) => ({ territory: T(o.territory!), armies: o.armies! })),
        moves: go.filter((o) => o.kind === 'move').map((o) => ({ from: T(o.from!), to: T(o.to!), armies: o.armies! })),
      }),
    ).toEqual({ warnings: [] });
    // Re-planning the same turn draws the same split; the full view carries the mix.
    await h.harness.close();
    h = await live(board(12), game());
    const again = await plan(h, 'full');
    expect(again.guessOrders).toEqual(go);
    expect(again.guess!.mix).toEqual(expect.any(Array));
    expect(again).not.toHaveProperty('guessSkipped');
  });

  it('no guess when a fixed split holds: guess and guessOrders absent, the reason in full only', async () => {
    h = await live(board(6), game());
    const compact = await plan(h);
    expect(compact).not.toHaveProperty('guess');
    expect(compact).not.toHaveProperty('guessOrders');
    expect(compact).not.toHaveProperty('guessSkipped');
    await h.harness.close();
    h = await live(board(6), game());
    const full = await plan(h, 'full');
    expect(full).not.toHaveProperty('guess');
    expect(full).not.toHaveProperty('guessOrders');
    expect(full.guessSkipped).toMatchObject({ reason: 'fixed-split-holds' });
  });

  it('no guess with luck on: the reason in full only', async () => {
    h = await live(board(12), game(3, { LuckModifier: 0.16 }));
    const full = await plan(h, 'full');
    expect(full).not.toHaveProperty('guess');
    expect(full).not.toHaveProperty('guessOrders');
    expect(full.guessSkipped).toMatchObject({ reason: 'luck' });
  });
});
