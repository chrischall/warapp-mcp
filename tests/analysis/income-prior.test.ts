// #119: an opponent's income is read low under fog. Two fixes here (the third, the stack cap,
// is in visible-income.test.ts):
//  - the fog prior: in a symmetric-start 1v1, an opponent that borders the fog earns at least
//    my own income (it started where I did), capped at what it could earn on this board;
//  - no decay: a tracked income never drops unless a bonus it visibly held is visibly broken
//    (or the most it could earn falls below it), and my own orders — a failed attack, a hold
//    that fell — are measurements of what it deployed.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { symmetricStart, trackOpponents, type TurnBoard } from '../../src/analysis/opponents.js';
import { enemyDeployEstimates, planTurn, type PlanInput, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const OTHER = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const history = (...boards: [number, BoardState][]): TurnBoard[] => boards.map(([turn, b]) => ({ turn, board: b }));

describe('the fog prior (#119): a symmetric-start 1v1 opponent bordering the fog earns at least my income', () => {
  // My T1 (+5 bonus with T2), T2; the opponent's T3 is one 556-stack beside the fogged T4–T7,
  // which hold a +40 bonus it could have. My income: base 5 + my bonuses 45 = 50.
  const ids = [1, 2, 3, 4, 5, 6, 7, 8];
  const edges: [number, number][] = [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 7],
    [1, 8],
  ];
  const g = buildGraph(makeMap(ids, edges, [[901, 45, [1, 2, 8]], [902, 40, [4, 5, 6, 7]]]));
  const s = board([mine(1, 30), mine(2, 40), mine(8, 5), enemy(3, 556), fogged(4), fogged(5), fogged(6), fogged(7)]);
  const players = [{ id: ME }, { id: ENEMY }];
  const input = (over: Partial<PlanInput> = {}): PlanInput => ({
    graph: g,
    board: s,
    me: ME,
    income: 50,
    settings: STD,
    turn: 12,
    game: { players, turn: 12, symmetricStart: true },
    ...over,
  });

  it('first seen on turn 12 as one 556-stack: estimated at least 50 (my income), not 5', () => {
    const rich = buildGraph(makeMap(ids, edges, [[901, 45, [1, 2, 8]], [902, 80, [4, 5, 6, 7]]]));
    const [e] = enemyDeployEstimates(rich, s, ME, STD, undefined, undefined, { myIncome: 50 });
    expect(e).toMatchObject({ playerId: ENEMY, base: 5, bonusIncome: 0, prior: 50, couldEarn: 85, estimate: 50, source: 'prior' });
    expect(planTurn(input({ graph: rich })).enemyDeploy).toBeGreaterThanOrEqual(50);
    // Without the prior: 5.
    expect(enemyDeployEstimates(rich, s, ME, STD)[0]!.estimate).toBe(5);
  });

  it('capped at what it could earn on this board: base 5 + the fogged +40', () => {
    const [e] = enemyDeployEstimates(g, s, ME, STD, undefined, undefined, { myIncome: 50 });
    expect(e).toMatchObject({ prior: 45, couldEarn: 45, estimate: 45, source: 'prior' });
    const p = planTurn(input());
    expect(p.enemyDeploy).toBe(45);
    expect(p.warnings.join('\n')).toMatch(
      /Enemy deploy estimate for player 20: ~45 \(a prior, not an observation: in a 1v1 that started even, an opponent bordering the fog is assumed to earn at least my own income 50, capped at the most it could earn on this board, 45;/,
    );
  });

  it('card armies are not income: the prior is what I earn', () => {
    const rich = buildGraph(makeMap(ids, edges, [[901, 45, [1, 2, 8]], [902, 80, [4, 5, 6, 7]]]));
    const p = planTurn(input({ graph: rich, income: 60, cardArmies: 10 }));
    expect(p.enemyDeploy).toBe(50);
  });

  it('never lowers an estimate: a bigger visible income stands', () => {
    const p = planTurn(input({ income: 3 }));
    expect(p.enemyDeploy).toBe(5);
    expect(p.warnings.join('\n')).not.toMatch(/a prior/);
  });

  it('not without a symmetric start, nor in an FFA, even one down to two players', () => {
    expect(planTurn(input({ game: { players, turn: 12 } })).enemyDeploy).toBe(5);
    expect(planTurn(input({ game: { players, turn: 12, symmetricStart: false } })).enemyDeploy).toBe(5);
    const ffa = planTurn(input({ game: { players: [...players, { id: OTHER }], turn: 12, symmetricStart: true } }));
    expect(ffa.enemyDeploy).toBe(5);
    // An FFA down to two is no even start: either survivor may have absorbed the eliminated player.
    const left = planTurn(
      input({ game: { players: [...players, { id: OTHER, state: 'Eliminated' }], turn: 12, symmetricStart: true } }),
    );
    expect(left.enemyDeploy).toBe(5);
    expect(left.warnings.join('\n')).not.toMatch(/a prior/);
  });

  it('not once every territory it holds is in view, with no fog beside it', () => {
    const open = board([mine(1, 30), mine(2, 40), mine(8, 5), enemy(3, 556), neutral(4, 2), neutral(5, 2), neutral(6, 2), neutral(7, 2)]);
    const p = planTurn(input({ board: open }));
    expect(p.enemyDeploy).toBe(5);
  });
});

describe('the opening prior (#166): the opponent simulated from the starts the award proved', () => {
  // The same board: my income 50; the opponent could earn 5 + the fogged +80 = 85.
  const ids = [1, 2, 3, 4, 5, 6, 7, 8];
  const edges: [number, number][] = [
    [1, 2],
    [2, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 7],
    [1, 8],
  ];
  const g = buildGraph(makeMap(ids, edges, [[901, 45, [1, 2, 8]], [902, 80, [4, 5, 6, 7]]]));
  const s = board([mine(1, 30), mine(2, 40), mine(8, 5), enemy(3, 556), fogged(4), fogged(5), fogged(6), fogged(7)]);
  const players = [{ id: ME }, { id: ENEMY }];
  const input = (opening: ReadonlyMap<number, number> | undefined, income = 50): PlanInput => ({
    graph: g,
    board: s,
    me: ME,
    income,
    settings: STD,
    turn: 3,
    game: { players, turn: 3, symmetricStart: true, ...(opening ? { opening } : {}) },
  });

  it('its simulated income stands in for my income as the prior', () => {
    const [e] = enemyDeployEstimates(g, s, ME, STD, undefined, undefined, { myIncome: 50, opening: new Map([[ENEMY, 60]]) });
    expect(e).toMatchObject({ prior: 60, estimate: 60, source: 'prior' });
    const p = planTurn(input(new Map([[ENEMY, 60]])));
    expect(p.enemyDeploy).toBe(60);
    expect(p.warnings.join('\n')).toMatch(
      /Enemy deploy estimate for player 20: ~60 \(a prior, not an observation: its opening simulated from the starts the award of picks proved earns 60 this turn, capped at the most it could earn on this board, 85;/,
    );
  });

  it('a lower simulated income never lowers the my-income prior (the simulation is a simple player)', () => {
    expect(planTurn(input(new Map([[ENEMY, 12]]))).enemyDeploy).toBe(50);
    const [e] = enemyDeployEstimates(g, s, ME, STD, undefined, undefined, { myIncome: 50, opening: new Map([[ENEMY, 12]]) });
    expect(e!.prior).toBe(50);
  });

  it('never lowers an estimate: below what it visibly earns, the visible figure stands', () => {
    const [e] = enemyDeployEstimates(g, s, ME, STD, undefined, undefined, { myIncome: 3, opening: new Map([[ENEMY, 2]]) });
    expect(e).toMatchObject({ estimate: 5, source: 'visible' });
  });

  it('capped at what it could earn on this board', () => {
    const [e] = enemyDeployEstimates(g, s, ME, STD, undefined, undefined, { myIncome: 50, opening: new Map([[ENEMY, 200]]) });
    expect(e).toMatchObject({ prior: 85, estimate: 85 });
  });

  it('another player, or no figure, keeps the my-income prior; no symmetric start, no prior at all', () => {
    expect(planTurn(input(new Map([[OTHER, 60]]))).enemyDeploy).toBe(50);
    expect(planTurn(input(undefined)).enemyDeploy).toBe(50);
    const off = planTurn({ ...input(new Map([[ENEMY, 60]])), game: { players, turn: 3, opening: new Map([[ENEMY, 60]]) } });
    expect(off.enemyDeploy).toBe(5);
  });

  it('still only beside the fog', () => {
    const open = board([mine(1, 30), mine(2, 40), mine(8, 5), enemy(3, 556), neutral(4, 2), neutral(5, 2), neutral(6, 2), neutral(7, 2)]);
    expect(planTurn({ ...input(new Map([[ENEMY, 60]])), board: open }).enemyDeploy).toBe(5);
  });
});

// The tracker over a long fogged history. The enemy shows T3–T5 next to my T1/T2; the fogged T8
// is a +30 bonus it could hold.
const ids = [1, 2, 3, 4, 5, 6, 7, 8];
const edges: [number, number][] = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [7, 8],
];
const gBig = buildGraph(makeMap(ids, edges, [[901, 3, [1, 2]], [907, 30, [8]]]));
const FOG = [fogged(6), fogged(7), fogged(8)];
const at = (t3: number, rest: TerritoryState[] = FOG): BoardState =>
  board([mine(1, 5), mine(2, 5), enemy(3, t3), enemy(4, 2), enemy(5, 2), ...rest]);
/** A history whose observed deploys (each turn T3's growth) are `deploys`, from turn 3. */
const grown = (deploys: number[], rest?: (i: number) => TerritoryState[]): TurnBoard[] => {
  let t3 = 10;
  const out: [number, BoardState][] = [[3, at(t3, rest?.(0))]];
  deploys.forEach((d, i) => {
    t3 += d;
    out.push([4 + i, at(t3, rest?.(i + 1))]);
  });
  return history(...out);
};

describe('a tracked income does not decay (#119)', () => {
  it('observed 22, 3, 31, 5, 2, 12: at least 31, not the 12 of the last three turns', () => {
    const [t] = trackOpponents(gBig, grown([22, 3, 31, 5, 2, 12]), ME, STD);
    expect(t!.turns.map((x) => x.observed)).toEqual([22, 3, 31, 5, 2, 12]);
    expect(t!.income).toBe(31);
    expect(t!.incomeMethod).toBe('carried');
    // Carried from the last window that still gave it (31, 5, 2).
    expect(t!.incomeTurns).toEqual([5, 6, 7]);
    expect(t!.observedRange).toEqual({ min: 2, max: 31 });
    expect(t!.notes.join(' ')).toMatch(/Income ~31 \(carried from turns 5–7, observed 2–31: no bonus it visibly held has been visibly broken since\)/);
    expect(t!.notes.join(' ')).toMatch(/its last 3 observed turns alone give ~12/);
  });

  it('drops by the value of a bonus it visibly held once that bonus is visibly broken', () => {
    // Its +6 bonus {T4, T5} is in view; on turn 9 my T6 has taken T5.
    const g = buildGraph(makeMap(ids, edges, [[901, 3, [1, 2]], [907, 30, [8]], [908, 6, [4, 5]]]));
    let t3 = 10;
    const hist: [number, BoardState][] = [];
    const deploys = [30, 0, 0, 0, 0];
    hist.push([3, at(t3)]);
    deploys.forEach((d, i) => {
      t3 += d;
      const turn = 4 + i;
      const broken = turn >= 8;
      hist.push([
        turn,
        board([
          mine(1, 5),
          mine(2, 5),
          enemy(3, t3),
          enemy(4, 2),
          broken ? mine(5, 3) : enemy(5, 2),
          broken ? mine(6, 3) : fogged(6),
          fogged(7),
          fogged(8),
        ]),
      ]);
    });
    const [t] = trackOpponents(g, history(...hist), ME, STD);
    expect(t!.turns.map((x) => x.observed).slice(0, 4)).toEqual([30, 0, 0, 0]);
    // 30 carried until turn 7 → 8 shows the break: 30 − 6 = 24.
    expect(t!.income).toBe(24);
    expect(t!.incomeMethod).toBe('carried');
  });

  it('never above what it could earn now', () => {
    // A +30 seen once; then my T6 and T7 take the fog next to the +30 bonus T8 away from it: T8
    // is mine on the last board, so it can earn only its base.
    const hist = grown([30, 0, 0, 0], (i) => (i >= 4 ? [mine(6, 2), mine(7, 2), mine(8, 2)] : FOG));
    const [t] = trackOpponents(gBig, hist, ME, STD);
    expect(t!.income).toBe(5);
  });
});

describe('my own orders are measurements (#119)', () => {
  // My T2 (12) attacks its T3 (10) with 10 and fails: T3 lost round(10 × 0.6) = 6 to my attack,
  // so its 10 → 9 means it deployed 5 there, not −1.
  it('a failed attack of mine: the defenders it killed count back', () => {
    const before = board([mine(1, 5), mine(2, 12), enemy(3, 10), enemy(4, 2), enemy(5, 2), ...FOG]);
    const after = board([mine(1, 5), mine(2, 2), enemy(3, 9), enemy(4, 2), enemy(5, 2), ...FOG]);
    const blind = trackOpponents(gBig, [{ turn: 3, board: before }, { turn: 4, board: after }], ME, STD);
    expect(blind[0]!.turns[0]!.observed).toBe(0);
    const seen = trackOpponents(
      gBig,
      [
        { turn: 3, board: before, orders: { deploys: [], moves: [{ from: 2, to: 3, armies: 10 }] } },
        { turn: 4, board: after },
      ],
      ME,
      STD,
    );
    expect(seen[0]!.turns[0]).toMatchObject({ observed: 5, measured: 6 });
    expect(seen[0]!.notes.join(' ')).toMatch(/My own orders on turn 3 \(\+6\) count as measurements/);
  });

  it('a hold of mine that fell: its defenders were what I deployed there too', () => {
    // My T2 had 5 and I deployed 10 there. Its T3 (20) got 5 and sent 23 into T2: 15 defenders
    // killed round(15 × 0.7) = 11, so 12 stand there and 2 on T3. Read off the boards alone, the
    // capture is priced at the guard I may have left (#123), round(0.7) = 1, and T3 shrank 18
    // for 12 arriving: −5, floored at 0.
    const before = board([mine(1, 5), mine(2, 5), enemy(3, 20), enemy(4, 2), enemy(5, 2), ...FOG]);
    const after = board([mine(1, 5), enemy(2, 12), enemy(3, 2), enemy(4, 2), enemy(5, 2), ...FOG]);
    const blind = trackOpponents(gBig, [{ turn: 3, board: before }, { turn: 4, board: after }], ME, STD);
    expect(blind[0]!.turns[0]!.raw).toBe(0);
    const seen = trackOpponents(
      gBig,
      [
        { turn: 3, board: before, orders: { deploys: [{ territoryId: 2, armies: 10 }], moves: [] } },
        { turn: 4, board: after },
      ],
      ME,
      STD,
    );
    // My orders say 15 defenders: 11 − 1 = 10 more, and the deploy reads 5.
    expect(seen[0]!.turns[0]).toMatchObject({ raw: 5, observed: 5, measured: 10 });
  });
});

describe('symmetricStart (#119): the start the fog prior needs', () => {
  const map = { distributionModes: [{ id: 7, name: 'Scenario', type: 'scenario' }, { id: 8, name: 'Even', type: 'normal' }] };
  it('picks, random and full distribution start even; a map scenario does not; unknown is not', () => {
    expect(symmetricStart({ distributionMode: 0 }, map)).toBe(true);
    expect(symmetricStart({ distributionMode: -1 }, map)).toBe(true);
    expect(symmetricStart({ distributionMode: 8 }, map)).toBe(true);
    expect(symmetricStart({ distributionMode: 7 }, map)).toBe(false);
    expect(symmetricStart({}, map)).toBe(false);
    expect(symmetricStart(undefined, map)).toBe(false);
  });
});
