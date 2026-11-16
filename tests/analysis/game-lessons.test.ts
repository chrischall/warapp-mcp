// What a finished game teaches (#312 E2), pure parts: the history read as profile turns (part C), the
// income curve and the turn it went flat, the start region and the winner's pace for the map's
// record, how the game was lost, and the tracker's estimates scored against the truth by coverage.
// Synthetic maps and boards only.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import {
  addCalibration,
  aggregateCalibration,
  calibrationSamples,
  coverageBucket,
  flatTurn,
  incomeCurve,
  lessonLoss,
  mapFacts,
  observeHistory,
  startRegion,
} from '../../src/analysis/game-lessons.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { MyOrders } from '../../src/analysis/opponents.js';
import type { PlayerTurn } from '../../src/analysis/finished-game.js';
import type { GameMap } from '../../src/normalize.js';

const ME = 1001;
const FOE = 1002;

// A line 1-2-3-4-5-6, bonus 100 = {1,2} worth 3, bonus 200 = {5,6} worth 4.
const MAP: GameMap = {
  id: 77,
  name: 'line',
  territories: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `t${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 6) })),
  bonuses: [
    { id: 100, name: 'west', value: 3, territoryIds: [1, 2], bonusIds: [] },
    { id: 200, name: 'east', value: 4, territoryIds: [5, 6], bonusIds: [] },
  ],
  distributionModes: [],
};
const G = buildGraph(MAP);

const t = (territoryId: number, owner: number | 'neutral' | 'fog', armies: number | null): TerritoryState => ({
  territoryId,
  owner: owner === 'neutral' ? { kind: 'neutral' } : owner === 'fog' ? { kind: 'unknown' } : { kind: 'player', playerId: owner },
  armies,
  ...(owner === 'fog' ? { fogLevel: 'Fogged' } : {}),
});
const board = (...ts: TerritoryState[]): BoardState => ({ source: 'gamefeed', verified: false, territories: ts });

const curveTurns = (mine: number[], foe: number[] = []) =>
  mine.map((income, afterTurn) => ({
    afterTurn,
    players: new Map<number, PlayerTurn>([
      [ME, { income, territories: 1, armies: 1, bonuses: [] }],
      ...(foe[afterTurn] !== undefined ? ([[FOE, { income: foe[afterTurn]!, territories: 1, armies: 1, bonuses: [] }]] as [number, PlayerTurn][]) : []),
    ]),
  }));

describe('observeHistory (part C)', () => {
  it('reads each pair of consecutive history boards as the turn played between them, with my orders of that turn', () => {
    // Board 0: me on 3 (5), FOE on 4 (5). Turn 1: I attack 4 with 4 and fail (exact 0% luck);
    // FOE had deployed there. Board 1: FOE took 3.
    const boards = [
      { turn: 0, board: board(t(3, ME, 5), t(4, FOE, 5)) },
      { turn: 1, board: board(t(3, ME, 2), t(4, FOE, 8)) },
      { turn: 2, board: board(t(3, FOE, 6), t(4, FOE, 1)) },
      // I am out: nothing after.
      { turn: 3, board: board(t(3, FOE, 7), t(4, FOE, 1)) },
    ];
    const orders = new Map<number, MyOrders>([[1, { deploys: [], moves: [{ from: 3, to: 4, armies: 3 }], cards: [] }]]);
    const seen = observeHistory({ graph: G, me: ME, boards, orders, settings: { luckModifier: 0, roundingMode: 'StraightRound' }, cards: [], opponents: [FOE] });
    const turns = seen.get(FOE)!;
    expect(turns.map((x) => x.turn)).toEqual([1, 2]);
    expect(turns[0]!.primitives).toMatchObject({ contact: true, iAttacked: true });
    expect(turns[1]!.primitives).toMatchObject({ contact: true, attackedMe: true, tookFromMe: [3] });
  });

  it('skips a gap between boards', () => {
    const boards = [
      { turn: 0, board: board(t(3, ME, 5), t(4, FOE, 5)) },
      { turn: 2, board: board(t(3, ME, 5), t(4, FOE, 5)) },
    ];
    expect(observeHistory({ graph: G, me: ME, boards, orders: new Map(), settings: {}, opponents: [FOE] }).size).toBe(0);
  });
});

describe('incomeCurve and flatTurn', () => {
  it('reads my income by completed turns', () => {
    expect(incomeCurve(curveTurns([5, 6, 8]), ME)).toEqual([
      { afterTurn: 0, income: 5 },
      { afterTurn: 1, income: 6 },
      { afterTurn: 2, income: 8 },
    ]);
  });

  it('the first board from which the income stayed level for three more turns', () => {
    // 5 8 12 20 20 21 20 30: flat from board 3 (20 → 20, 21, 20 within 10%).
    expect(flatTurn(incomeCurve(curveTurns([5, 8, 12, 20, 20, 21, 20, 30]), ME))).toBe(3);
  });

  it('a small income moves by one army and is still flat; growth or a gap is not; board 0 never counts', () => {
    expect(flatTurn(incomeCurve(curveTurns([5, 5, 6, 5, 5]), ME))).toBe(1);
    // Level from board 0 only: board 0 never counts.
    expect(flatTurn(incomeCurve(curveTurns([5, 5, 5, 5, 8, 11, 14, 17]), ME))).toBeNull();
    expect(flatTurn(incomeCurve(curveTurns([5, 7, 9, 11, 13, 15]), ME))).toBeNull();
    // Out (0) is not flat.
    expect(flatTurn(incomeCurve(curveTurns([5, 7, 0, 0, 0, 0]), ME))).toBeNull();
    const gap = incomeCurve(curveTurns([5, 7, 7, 7, 7]), ME).filter((c) => c.afterTurn !== 3);
    expect(flatTurn(gap)).toBeNull();
  });
});

describe('the map record facts', () => {
  it('a start region is its territories and every bonus they touch', () => {
    expect(startRegion(G, [5, 2])).toEqual({ territories: [2, 5], bonuses: [100, 200] });
    expect(startRegion(G, [3])).toEqual({ territories: [3], bonuses: [] });
  });

  it('my start, curve and pace, and each winner\'s start and income after turns 4 and 8', () => {
    const turns = curveTurns([5, 5, 6, 7, 8, 8, 8, 8, 8, 0], [5, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    const f = mapFacts(G, ME, [FOE], new Map([[ME, [1]], [FOE, [6]]]), turns);
    expect(f.me).toEqual({ territories: [1], bonuses: [100], income: [5, 5, 6, 7, 8, 8, 8, 8, 8, 0], income4: 8, income8: 8 });
    expect(f.winners).toEqual([{ territories: [6], bonuses: [200], income4: 12, income8: 20 }]);
  });

  it('a short game has no pace past its last board', () => {
    const f = mapFacts(G, ME, [ME], new Map([[ME, [1]]]), curveTurns([5, 6, 9]));
    expect(f.me.income4).toBeNull();
    expect(f.winners[0]).toMatchObject({ income4: null, income8: null });
  });
});

describe('lessonLoss', () => {
  const base = { me: ME, orders: new Map<number, MyOrders>(), graph: G, settings: undefined, numberOfTurns: 3, outTurn: 3 };
  it('eliminated: my last territories fell on the turn after the last board I held land on', () => {
    const boards = [
      { turn: 0, board: board(t(1, ME, 5), t(2, FOE, 5)) },
      { turn: 1, board: board(t(1, ME, 2), t(2, FOE, 9)) },
      { turn: 2, board: board(t(1, FOE, 7), t(2, FOE, 1)) },
    ];
    expect(lessonLoss({ ...base, result: 'eliminated', boards })).toEqual({ cause: 'last-territories', turn: 2 });
  });
  it('surrendered, booted, or lost still holding land; none for a game I did not lose', () => {
    expect(lessonLoss({ ...base, result: 'surrendered', boards: [] })).toEqual({ cause: 'surrendered', turn: 3 });
    expect(lessonLoss({ ...base, result: 'booted', boards: [] })).toEqual({ cause: 'booted', turn: 3 });
    expect(lessonLoss({ ...base, result: 'lost', boards: [] })).toEqual({ cause: 'still-holding', turn: 3 });
    expect(lessonLoss({ ...base, result: 'won', boards: [] })).toBeNull();
  });
});

describe('calibration', () => {
  it('scores the tracked income on each cached turn against the history board it was played on', () => {
    // FOE holds 5 and 6 (bonus 200: income 5 + 4 = 9) from board 0. My cached view shows only 4 and
    // the fog beyond; its stack on 4 grows by 3 a turn (all it lets me see).
    const truth = (n: number) => board(t(1, ME, 5), t(2, ME, 5), t(3, ME, 5), t(4, FOE, 2 + 3 * n), t(5, FOE, 5), t(6, FOE, 5));
    const view = (n: number) => board(t(1, ME, 5), t(2, ME, 5), t(3, ME, 5), t(4, FOE, 2 + 3 * n), t(5, 'fog', null), t(6, 'fog', null));
    const history = [0, 1, 2, 3].map((n) => ({ turn: n, board: truth(n) }));
    // Cached board of turn T is played on history board T − 1.
    const cached = [1, 2, 3, 4].map((turn) => ({ turn, board: view(turn - 1) }));
    const samples = calibrationSamples({
      graph: G,
      me: ME,
      cached,
      history,
      plannerSettings: {},
      incomeSettings: { minimumArmyBonus: 5, bonusArmyPer: 0 } as never,
      game: { players: [{ id: ME }, { id: FOE }] },
      opponents: [FOE],
    });
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) {
      expect(s.opponent).toBe(FOE);
      expect(s.truth).toBe(9);
      expect(s.estimate).toBeGreaterThan(0);
    }
    // The first turn has no earlier board to compare: no estimate.
    expect(samples[0]!.turn).toBe(2);
  });

  it('aggregates by coverage bucket only, and takes a game back out exactly', () => {
    const a = aggregateCalibration([
      { turn: 2, opponent: FOE, estimate: 4, truth: 10, coverage: 0.2 },
      { turn: 3, opponent: FOE, estimate: 20, truth: 10, coverage: 0.9 },
      { turn: 4, opponent: FOE, estimate: 10, truth: 10, coverage: null },
    ]);
    expect(Object.keys(a).sort()).toEqual(['75-up', 'none', 'under-25']);
    expect(a['under-25']).toMatchObject({ n: 1, sum: 0.4, under: 1, over: 0 });
    expect(a['75-up']).toMatchObject({ n: 1, sum: 2, over: 1 });
    expect(a.none).toMatchObject({ n: 1, sum: 1, logSum: 0 });
    expect(JSON.stringify(a)).not.toContain(String(FOE));
    expect(addCalibration(addCalibration(a, a), a, -1)).toEqual(a);
    expect(addCalibration(a, a, -1)).toEqual({});
  });

  it('coverage buckets', () => {
    expect([null, 0, 0.3, 0.5, 0.75, 1].map(coverageBucket)).toEqual(['none', 'under-25', '25-50', '50-75', '75-up', '75-up']);
  });
});
