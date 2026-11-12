import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph, neighborsOf } from '../../src/analysis/graph.js';
import {
  BREAK_WEIGHT,
  captureCost,
  COMFORT_MARGIN,
  CONCEDE_FACTOR,
  defaultEnemyDeploy,
  incomeFor,
  MIN_EXPANSION_SHARE,
  PAYBACK_TURNS,
  planTurn,
  type PlanInput,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral, tinyMap } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

/** Build a map from an edge list and bonuses (`[id, value, territories]`). */
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

const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;

describe('captureCost', () => {
  it('is armiesToTake with no luck', () => {
    expect(captureCost(2, STD)).toBe(3);
    expect(captureCost(10, {})).toBe(armiesToTake(10));
  });

  it('adds a luck margin: ceil(cost / (1 - luck))', () => {
    expect(captureCost(2, { ...STD, luckModifier: 0.16 })).toBe(4);
    // A percentage is accepted too.
    expect(captureCost(2, { ...STD, luckModifier: 16 })).toBe(4);
    expect(captureCost(0, { ...STD, luckModifier: 0.5 })).toBe(2);
  });

  it('is null when attackers cannot kill', () => {
    expect(captureCost(2, { offensiveKillRate: 0 })).toBeNull();
  });
});

describe('incomeFor', () => {
  it('uses the existing income code', () => {
    const g = buildGraph(tinyMap());
    const s = board([mine(1, 2), mine(2, 2), mine(3, 2)]);
    expect(incomeFor(g, s, ME)).toBe(5 + 3);
    expect(incomeFor(g, s, ME, { cards: [], raw: {}, minimumArmyBonus: 2 })).toBe(2 + 3);
  });
});

describe('planTurn — opening', () => {
  // Three starts (1, 10, 20) with 4 armies each; every other territory is a
  // 2-army neutral. X (value 3) is the best bonus by value per capture cost.
  // Y and Z each have a territory (13, 23) out of reach, so neither can be
  // completed this turn.
  //   X (3): 1 2 3 4     Y (1): 10 11 12 13     Z (1): 20 21 22 23
  const map = makeMap(
    [1, 2, 3, 4, 10, 11, 12, 13, 20, 21, 22, 23],
    [
      [1, 2],
      [1, 3],
      [1, 4],
      [2, 3],
      [10, 11],
      [10, 12],
      [20, 21],
      [20, 22],
      [21, 4],
      [22, 12],
      [12, 13],
      [22, 23],
    ],
    [
      [101, 3, [1, 2, 3, 4]],
      [102, 1, [10, 11, 12, 13]],
      [103, 1, [20, 21, 22, 23]],
    ],
  );
  const g = buildGraph(map);
  const state = board([
    mine(1, 4),
    mine(10, 4),
    mine(20, 4),
    ...[2, 3, 4, 11, 12, 13, 21, 22, 23].map((id) => neutral(id, 2)),
  ]);
  const input: PlanInput = { graph: g, board: state, me: ME, income: 5, settings: STD };

  it('deploys 5 to the start in the best bonus and makes the 3-army captures that fit', () => {
    const p = planTurn(input);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([
      [1, 2, 3],
      [1, 3, 3],
      [10, 11, 3],
      [20, 21, 3],
    ]);
    expect(p.expected.captures).toEqual([2, 3, 11, 21]);
    expect(p.expected.bonusesCompleted).toEqual([]);
    expect(p.expected.nextIncome).toBe(5);
    expect(p.rationale.length).toBeGreaterThan(0);
    for (const m of p.moves) expect(m.reason).toBeTruthy();
  });

  it('never leaves a capture under-armed', () => {
    for (const m of attacks(planTurn(input))) expect(m.armies).toBeGreaterThanOrEqual(armiesToTake(2)!);
  });

  it('is deterministic', () => {
    expect(planTurn(input)).toEqual(planTurn(input));
    const shuffled = board([...state.territories].reverse());
    expect(planTurn({ ...input, board: shuffled })).toEqual(planTurn(input));
  });

  it('holds back a reserve from captures but still deploys it', () => {
    const p = planTurn({ ...input, options: { reserve: 3 } });
    expect(deploySum(p)).toBe(5);
    expect(attacks(p).map((m) => m.to)).toEqual([2, 11, 21]);
    expect(p.rationale.join(' ')).toMatch(/reserve/i);
  });

  it('warns that luck adds margins', () => {
    const p = planTurn({ ...input, settings: { ...STD, luckModifier: 0.16 } });
    expect(p.warnings.join(' ')).toMatch(/luck/i);
    for (const m of attacks(p)) expect(m.armies).toBe(4);
  });

  it('warns about non-straight rounding and an unverified board', () => {
    const p = planTurn({ ...input, settings: { ...STD, roundingMode: 'WeightedRandom' } });
    const text = p.warnings.join(' ');
    expect(text).toMatch(/WeightedRandom/);
    expect(text).toMatch(/unverified/i);
    const v = planTurn({ ...input, board: board(state.territories, true) });
    expect(v.warnings).toEqual([]);
  });
});

describe('planTurn — bonus focus', () => {
  // P (1): 1 2 — one capture from done. Q (10): 4 5 — better value per cost,
  // but 5 is not reachable this turn.
  const g = buildGraph(
    makeMap(
      [1, 2, 4, 5],
      [
        [1, 2],
        [1, 4],
        [4, 5],
      ],
      [
        [201, 1, [1, 2]],
        [202, 10, [4, 5]],
      ],
    ),
  );
  const state = board([mine(1, 1), neutral(2, 2), neutral(4, 2), neutral(5, 2)]);

  it('under expand, completes a bonus one capture from done before other expansion', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 3, settings: STD, options: { goal: 'expand' } });
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 3 }]);
    expect(attacks(p).map((m) => m.to)).toEqual([2]);
    expect(p.expected.bonusesCompleted).toEqual([201]);
    expect(p.expected.nextIncome).toBe(4);
    // Balanced scores by income per army: +10 for 6 beats +1 for 3, so it advances Q instead.
    const b = planTurn({ graph: g, board: state, me: ME, income: 3, settings: STD });
    expect(attacks(b).map((m) => m.to)).toEqual([4]);
  });

  it('expands toward the better bonus when nothing can be completed', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 1), neutral(2, 5), neutral(4, 2), neutral(5, 2)]), me: ME, income: 3, settings: STD });
    expect(attacks(p).map((m) => m.to)).toEqual([4]);
  });

  it('puts focused bonuses first', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 1), neutral(2, 5), neutral(4, 2), neutral(5, 2)]),
      me: ME,
      income: 8,
      settings: STD,
      options: { focusBonusIds: [201] },
    });
    expect(attacks(p)[0]!.to).toBe(2);
  });

  it('breaks value-per-cost ties by fewest external borders', () => {
    // Two value-1 bonuses at equal cost; R has 2 borders, S has 1.
    const tg = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6],
        [
          [1, 2],
          [1, 4],
          [2, 3],
          [4, 5],
          [3, 6],
        ],
        [
          [301, 1, [2, 3]],
          [302, 1, [4, 5]],
        ],
      ),
    );
    const s = board([mine(1, 4), neutral(2, 2), neutral(3, 2), neutral(4, 2), neutral(5, 2), neutral(6, 2)]);
    const p = planTurn({ graph: tg, board: s, me: ME, income: 0, settings: STD });
    expect(attacks(p).map((m) => m.to)).toEqual([4]);
  });
});

describe('planTurn — targets', () => {
  // W (2): 2 3 with a 10-army wasteland on 2. V (1): 4.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4],
      [
        [1, 2],
        [1, 3],
        [1, 4],
      ],
      [
        [401, 2, [2, 3]],
        [402, 1, [4]],
      ],
    ),
  );
  const state = board([mine(1, 5), neutral(2, 10), neutral(3, 2), neutral(4, 2)]);

  it('avoids a bonus made uneconomic by a wasteland', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 20, settings: STD });
    expect(attacks(p).map((m) => m.to)).toEqual([4]);
    expect(p.rationale.join(' ')).toMatch(/uneconomic/i);
    expect(PAYBACK_TURNS).toBeGreaterThan(0);
  });

  it('plans into it when focusBonusIds asks', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 20, settings: STD, options: { focusBonusIds: [401] } });
    expect(attacks(p).map((m) => [m.to, m.armies])).toEqual([
      [3, 3],
      [2, 16],
      [4, 3],
    ]);
    expect(p.expected.bonusesCompleted).toEqual([401, 402]);
  });

  it('warns about a fogged target instead of attacking it', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 5), fogged(2), neutral(3, 2), neutral(4, 2)]), me: ME, income: 0, settings: STD });
    expect(p.moves.some((m) => m.to === 2)).toBe(false);
    expect(p.warnings.join(' ')).toMatch(/T2 \(#2\).*fog/i);
  });

  it('treats territories missing from the board as fogged', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 5), neutral(3, 2), neutral(4, 2)]), me: ME, income: 0, settings: STD });
    expect(p.moves.some((m) => m.to === 2)).toBe(false);
    expect(p.warnings.join(' ')).toMatch(/T2/);
  });

  it('attacks visible enemies only under complete-bonus', () => {
    const s = board([mine(1, 9), neutral(2, 10), neutral(3, 2), enemy(4, 2)]);
    const expand = planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD, options: { goal: 'expand' } });
    expect(expand.moves.some((m) => m.to === 4)).toBe(false);
    const complete = planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD, options: { goal: 'complete-bonus' } });
    expect(attacks(complete).map((m) => m.to)).toEqual([4]);
    expect(complete.warnings.join(' ')).toMatch(/enemy/i);
  });

  it('never targets territories still up for distribution', () => {
    const s = board([mine(1, 9), neutral(2, 10), neutral(3, 2), { territoryId: 4, owner: { kind: 'available' }, armies: 2 }]);
    expect(planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD }).moves.some((m) => m.to === 4)).toBe(false);
  });

  it('skips targets that cannot be killed', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 5, settings: { ...STD, offensiveKillRate: 0 } });
    expect(attacks(p)).toEqual([]);
    expect(deploySum(p)).toBe(5);
  });

  it('focus decides between bonuses neither of which completes this turn', () => {
    // X (+1): 2, 3   Y (+5): 4, 5 — 3 and 5 are out of reach, and 4 armies fund one capture.
    const fg = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5],
        [
          [1, 2],
          [2, 3],
          [1, 4],
          [4, 5],
        ],
        [
          [601, 1, [2, 3]],
          [602, 5, [4, 5]],
        ],
      ),
    );
    const s = board([mine(1, 4), neutral(2, 2), neutral(3, 2), neutral(4, 2), neutral(5, 2)]);
    const plain = planTurn({ graph: fg, board: s, me: ME, income: 0, settings: STD });
    expect(attacks(plain).map((m) => m.to)).toEqual([4]);
    const focused = planTurn({ graph: fg, board: s, me: ME, income: 0, settings: STD, options: { focusBonusIds: [601] } });
    expect(attacks(focused).map((m) => m.to)).toEqual([2]);
  });

  it('never transfers into a territory that is only being captured this turn', () => {
    // 1 (3 armies) and 2 (4) both border neutral 3; 3 borders fogged 4. 2 takes 3, and
    // 1's only route forward is through 3 — which I do not own yet, so no transfer.
    const tg = buildGraph(
      makeMap(
        [1, 2, 3, 4],
        [
          [1, 3],
          [2, 3],
          [3, 4],
        ],
        [],
      ),
    );
    const p = planTurn({ graph: tg, board: board([mine(1, 3), mine(2, 4), neutral(3, 2), fogged(4)]), me: ME, income: 0, settings: STD });
    expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[2, 3]]);
    expect(p.moves.filter((m) => m.kind === 'transfer')).toEqual([]);
  });

  it('never completes a negative-value bonus unless focused', () => {
    // 2 is the lone member of a -1 bonus: taking it would lower income.
    const ng = buildGraph(makeMap([1, 2], [[1, 2]], [[501, -1, [2]]]));
    const s = board([mine(1, 4), neutral(2, 2)]);
    const p = planTurn({ graph: ng, board: s, me: ME, income: 5, settings: STD });
    expect(p.moves.some((m) => m.to === 2)).toBe(false);
    expect(p.expected.nextIncome).toBeGreaterThanOrEqual(5);
    const focused = planTurn({ graph: ng, board: s, me: ME, income: 5, settings: STD, options: { focusBonusIds: [501] } });
    expect(attacks(focused).map((m) => m.to)).toEqual([2]);
  });

  it('expands into territories outside any bonus', () => {
    const lg = buildGraph(makeMap([1, 2], [[1, 2]], []));
    const p = planTurn({ graph: lg, board: board([mine(1, 4), neutral(2, 2)]), me: ME, income: 0, settings: STD });
    expect(attacks(p).map((m) => m.to)).toEqual([2]);
  });

  it('warns when I own nothing', () => {
    const p = planTurn({ graph: g, board: board([neutral(2, 2)]), me: ME, income: 5, settings: STD });
    expect(p.deploys).toEqual([]);
    expect(p.warnings.join(' ')).toMatch(/no territor/i);
  });
});

describe('planTurn — defence', () => {
  // 1 is my 2-army border next to a 6-army enemy on 2; 3 is a 2-army neutral.
  // 1 is a held +2 bonus on its own, so it protects income and is worth holding.
  const g = buildGraph(
    makeMap(
      [1, 2, 3],
      [
        [1, 2],
        [1, 3],
      ],
      [
        [501, 1, [3]],
        [502, 2, [1]],
      ],
    ),
  );
  const state = board([mine(1, 2), enemy(2, 6), neutral(3, 2)]);

  it('warns that the border could fall next turn', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 5, settings: STD, options: { goal: 'expand' } });
    expect(p.warnings.join(' ')).toMatch(/T1 \(#1\).*could be taken/);
    // Expansion goes ahead; leftover lands on the exposed border.
    expect(attacks(p).map((m) => m.to)).toEqual([3]);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
  });

  it('under defend, deploys so the border holds before expanding', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(p.moves).toEqual([]);
    // 7 armies need 11 to take; the enemy has 5 movable + ~5 deploy = 10.
    expect(armiesToTake(7)).toBeGreaterThan(5 + 5);
    expect(p.rationale.join(' ')).toMatch(/hold/i);
  });

  it('warns when the border cannot be held with this income', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 2), enemy(2, 30), neutral(3, 2)]), me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.warnings.join(' ')).toMatch(/cannot be held/);
    expect(deploySum(p)).toBe(5);
  });

  it('respects a custom enemy deploy estimate', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 5, settings: STD, options: { goal: 'defend', enemyDeploy: 0 } });
    // Threat 5: 2 armies need 3, so deploy 2 (4 armies need 6 > 5).
    expect(p.deploys[0]).toEqual({ territoryId: 1, armies: 5 });
    expect(p.rationale.join(' ')).toMatch(/Deploy 2 to T1/);
  });

  it('sends leftover to the territory with the most fogged neighbours when no enemy is visible', () => {
    const fg = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5],
        [
          [1, 2],
          [2, 3],
          [2, 4],
          [1, 5],
        ],
        [],
      ),
    );
    const p = planTurn({ graph: fg, board: board([mine(1, 1), mine(2, 1), fogged(3), fogged(4), fogged(5)]), me: ME, income: 4, settings: STD });
    expect(p.deploys).toEqual([{ territoryId: 2, armies: 4 }]);
  });
});

describe('planTurn — value-aware defence', () => {
  it('exports its constants', () => {
    expect(CONCEDE_FACTOR).toBe(3);
    expect(COMFORT_MARGIN).toBeGreaterThan(1);
  });

  // (a) T1 is my border next to 50 visible enemy armies on T9; T1, T2, T3, T5 form
  // a held +4 bonus. T2 sits between T1 and the frontier T3 (next to a 2-army
  // neutral T4); T5 is a dead end behind T1.
  //   T9(enemy) ─ T1 ─ T2 ─ T3 ─ T4(neutral)
  //                └─ T5
  const ag = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 9],
      [
        [1, 9],
        [1, 2],
        [1, 5],
        [2, 3],
        [3, 4],
      ],
      [[701, 4, [1, 2, 3, 5]]],
    ),
  );
  const aBoard = (border: number) =>
    board([mine(1, border), mine(2, 1), mine(3, 4), neutral(4, 2), mine(5, 1), enemy(9, 50)]);

  it('(a) concedes a hopeless 1-army border protecting +4 and deploys nothing there', () => {
    // Threat: 49 movable + round(0.75 × 50) = 38 deploy = 87; 53 armies need 88, so holding needs 52.
    const p = planTurn({ graph: ag, board: aBoard(1), me: ME, income: 35, settings: STD, options: { goal: 'defend' } });
    expect(p.warnings).toContain('T1 (#1) cannot be held economically (needs 52, protects +4): conceded');
    expect(p.conceded).toEqual([1]);
    expect(p.deploys.find((d) => d.territoryId === 1)).toBeUndefined();
    expect(deploySum(p)).toBe(35);
    // Nothing to withdraw from a 1-army border (its army stands guard).
    expect(p.moves.some((m) => m.from === 1)).toBe(false);
    expect(p.cardAdvice).toBeNull();
  });

  it('(a) withdraws a conceded border\'s movable armies behind it, first, with Order Priority advice', () => {
    const p = planTurn({ graph: ag, board: aBoard(15), me: ME, income: 35, settings: STD, options: { goal: 'defend' } });
    expect(p.warnings).toContain('T1 (#1) cannot be held economically (needs 38, protects +4): conceded');
    expect(p.deploys.find((d) => d.territoryId === 1)).toBeUndefined();
    // Toward the frontier (T2, one step from T3), not into the dead end T5.
    expect(p.moves[0]).toEqual(expect.objectContaining({ from: 1, to: 2, armies: 14, kind: 'transfer' }));
    expect(p.moves.filter((m) => m.from === 1)).toHaveLength(1);
    expect(p.cardAdvice).toBe('order-priority');
    expect(p.warnings.join('\n')).toMatch(/withdrawal .*T1 \(#1\).* only executes if T1 \(#1\) is still mine/i);
    expect(p.rationale.join('\n')).toMatch(/Withdraw 14 from T1 \(#1\) to T2 \(#2\)/);
    // Leftover goes to the expansion, never to the conceded border.
    expect(p.deploys.find((d) => d.territoryId === 3)!.armies).toBe(35);
    // …and stays there: the stack working on the expansion is not transferred back.
    expect(p.moves.filter((m) => m.from === 3)).toEqual([
      expect.objectContaining({ from: 3, to: 4, kind: 'attack' }),
    ]);
    expect(p.moves.some((m) => m.kind === 'transfer' && m.from !== 1)).toBe(false);
  });

  it('(a) never sends idle interior armies into a conceded border', () => {
    // T2 (10 armies) is interior next to the conceded T1: its idle armies never go
    // back into the border the plan gives up (which defend is withdrawing 14 from).
    const s = board([mine(1, 15), mine(2, 10), mine(3, 4), neutral(4, 2), mine(5, 1), enemy(9, 50)]);
    for (const goal of ['expand', 'defend', 'balanced'] as const) {
      const p = planTurn({ graph: ag, board: s, me: ME, income: 35, settings: STD, options: { goal } });
      expect(p.conceded, goal).toEqual([1]);
      expect(p.moves.filter((m) => m.to === 1), goal).toEqual([]);
      // Once T4 falls, the only front left lies past T1, so T2's armies stay put.
      expect(p.moves.filter((m) => m.from === 2), goal).toEqual([]);
    }
  });

  it('counts armies withdrawn into a border when judging whether it is short of a comfortable margin', () => {
    // T1 (20, protects 0) is conceded and withdraws 19 into T2 (5, a held +3, next to a
    // 3-army enemy). With those 19 T2 is comfortable, so the leftover goes to T3,
    // the border with a fogged neighbour, instead of piling onto T2.
    const g = buildGraph(
      makeMap(
        [1, 2, 3, 4, 8, 9],
        [
          [1, 8],
          [2, 9],
          [1, 2],
          [2, 3],
          [3, 4],
        ],
        [[704, 3, [2]]],
      ),
    );
    const s = board([mine(1, 20), mine(2, 5), mine(3, 1), fogged(4), enemy(8, 40), enemy(9, 3)]);
    const p = planTurn({ graph: g, board: s, me: ME, income: 6, settings: STD, options: { goal: 'defend', enemyDeploy: 5 } });
    expect(p.conceded).toEqual([1]);
    expect(p.moves[0]).toEqual(expect.objectContaining({ from: 1, to: 2, armies: 19, kind: 'transfer' }));
    expect(p.deploys).toEqual([{ territoryId: 3, armies: 6 }]);
  });

  it('(a) under expand it still warns of the concession but neither withdraws nor advises a card', () => {
    const p = planTurn({ graph: ag, board: aBoard(15), me: ME, income: 35, settings: STD, options: { goal: 'expand' } });
    expect(p.warnings).toContain('T1 (#1) cannot be held economically (needs 38, protects +4): conceded');
    expect(p.conceded).toEqual([1]);
    expect(p.moves.some((m) => m.from === 1 && m.kind === 'transfer')).toBe(false);
    expect(p.cardAdvice).toBeNull();
    expect(p.deploys.find((d) => d.territoryId === 1)).toBeUndefined();
  });

  // (b) T1 and T2 are both 2-army borders, each next to a 6-army enemy (threat 10,
  // hold cost 5). T3 is interior behind both.
  const bMap = (bonuses: [number, number, number[]][]) =>
    buildGraph(
      makeMap(
        [1, 2, 3, 8, 9],
        [
          [1, 8],
          [2, 9],
          [1, 3],
          [2, 3],
        ],
        bonuses,
      ),
    );
  const bBoard = board([mine(1, 2), mine(2, 2), mine(3, 1), enemy(8, 6), enemy(9, 6)]);

  it('(b) defends the higher-id border protecting +5 before the lower-id one protecting 0', () => {
    const g = bMap([[702, 5, [2, 3]]]);
    const p = planTurn({ graph: g, board: bBoard, me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.deploys).toEqual([{ territoryId: 2, armies: 5 }]);
    expect(p.conceded).toEqual([1]);
    expect(p.warnings).toContain('T1 (#1) cannot be held economically (needs 5, protects +0): conceded');
  });

  it('(b) triages by protected value per army, conceding what the budget cannot cover', () => {
    // T1 protects +2, T2 protects +5; both cost 5 and the budget covers one.
    const g = bMap([
      [702, 5, [2, 3]],
      [703, 2, [1]],
    ]);
    const p = planTurn({ graph: g, board: bBoard, me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.deploys).toEqual([{ territoryId: 2, armies: 5 }]);
    expect(p.conceded).toEqual([1]);
    expect(p.warnings).toContain('T1 (#1) cannot be held with the 0 armies left to deploy (needs 5, protects +2): conceded');
    // Its one movable army withdraws to T3 (one step from the held T2).
    expect(p.moves[0]).toEqual(expect.objectContaining({ from: 1, to: 3, armies: 1, kind: 'transfer' }));
    expect(p.cardAdvice).toBe('order-priority');
  });

  it('(b) breaks equal value-per-army ties by lower hold cost, then id', () => {
    // Both protect +5 at the same cost: the lower id goes first.
    const g = bMap([
      [702, 5, [2]],
      [703, 5, [1]],
    ]);
    const p = planTurn({ graph: g, board: bBoard, me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(p.conceded).toEqual([2]);
  });

  it('(c) leftover never lands on a conceded border, even the one with the most enemies next to it', () => {
    // T1 (1 army, so nothing to withdraw) faces 40 enemies: hopeless. T2 (5 armies, a
    // held +3) faces 3: not threatened (8 to take > 3 − 1 + 5), but short of a
    // comfortable margin. (With 2 on T1, its withdrawn army would make T2 comfortable.)
    const g = buildGraph(
      makeMap(
        [1, 2, 8, 9],
        [
          [1, 8],
          [2, 9],
          [1, 2],
        ],
        [[704, 3, [2]]],
      ),
    );
    const s = board([mine(1, 1), mine(2, 5), enemy(8, 40), enemy(9, 3)]);
    for (const goal of ['expand', 'defend', 'complete-bonus', 'balanced'] as const) {
      const p = planTurn({ graph: g, board: s, me: ME, income: 6, settings: STD, options: { goal, enemyDeploy: 5 } });
      expect(p.conceded, goal).toEqual([1]);
      expect(p.deploys, goal).toEqual([{ territoryId: 2, armies: 6 }]);
      expect(p.rationale.join('\n'), goal).toMatch(/leftover 6 to T2 \(#2\).*protects \+3/);
    }
  });

  it('counts a bonus I would lose access to, and per-territory income', () => {
    // T1 is my only foothold in the +3 bonus {1, 4} (T4 neutral); T8 is a 6-army enemy.
    const g = buildGraph(
      makeMap(
        [1, 4, 8],
        [
          [1, 4],
          [1, 8],
        ],
        [[705, 3, [1, 4]]],
      ),
    );
    const s = board([mine(1, 2), neutral(4, 2), enemy(8, 6)]);
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.conceded).toEqual([]);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(p.rationale.join('\n')).toMatch(/Deploy 5 to T1 \(#1\).*protects \+3/);

    // With one army per territory held, losing T1 also costs that army of income.
    const lone = buildGraph(makeMap([1, 8], [[1, 8]], []));
    const q = planTurn({
      graph: lone,
      board: board([mine(1, 2), enemy(8, 6)]),
      me: ME,
      income: 5,
      settings: { ...STD, bonusArmyPer: 1 },
      options: { goal: 'defend' },
    });
    expect(q.warnings).toContain('T1 (#1) cannot be held economically (needs 5, protects +1): conceded');
  });

  it('a superbonus and its member bonus both count, each once', () => {
    const g = buildGraph({
      ...makeMap([1, 2, 8], [[1, 8], [1, 2]], [[706, 2, [1, 2]]]),
      bonuses: [
        { id: 706, name: 'B706', value: 2, territoryIds: [1, 2], bonusIds: [] },
        { id: 707, name: 'B707', value: 1, territoryIds: [1], bonusIds: [706] },
      ],
    });
    const p = planTurn({ graph: g, board: board([mine(1, 2), mine(2, 1), enemy(8, 40)]), me: ME, income: 5, settings: STD });
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) cannot be held .*protects \+3\): conceded/);
  });

  it('still deploys the whole income when every territory I hold is conceded', () => {
    const g = buildGraph(makeMap([1, 8], [[1, 8]], []));
    const p = planTurn({ graph: g, board: board([mine(1, 2), enemy(8, 40)]), me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.conceded).toEqual([1]);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(p.warnings.join('\n')).toMatch(/every territory .*conceded/i);
  });

  it('warns when a conceded border has nowhere to withdraw to', () => {
    const g = buildGraph(makeMap([1, 4, 8], [[1, 8], [1, 4]], []));
    const p = planTurn({ graph: g, board: board([mine(1, 9), neutral(4, 30), enemy(8, 40)]), me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.conceded).toEqual([1]);
    expect(p.moves.filter((m) => m.kind === 'transfer')).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\).*nowhere to withdraw/i);
    expect(p.cardAdvice).toBeNull();
  });
});

describe('planTurn — balanced', () => {
  it('exports its constants', () => {
    expect(BREAK_WEIGHT).toBe(1);
    expect(MIN_EXPANSION_SHARE).toBe(0.3);
  });

  // (d) T1 (11 armies) borders a +3 bonus of neutrals 4, 2, 2 (T4, T5, T6: 6 + 3 + 3 = 12,
  // so 2 to deploy). T2 and T3 are 2-army borders, each a held +1, each next to a 2-army
  // enemy: with a fixed enemy deploy of 5 the threat is 6 and each needs 3 to hold.
  // Income 6 covers both holds or one hold plus the +3, not all three.
  const dMap = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 8, 9],
      [
        [1, 2],
        [1, 3],
        [1, 4],
        [1, 5],
        [1, 6],
        [2, 8],
        [3, 9],
      ],
      [
        [801, 3, [4, 5, 6]],
        [802, 1, [2]],
        [803, 1, [3]],
      ],
    ),
  );
  const dBoard = board([mine(1, 11), mine(2, 2), mine(3, 2), neutral(4, 4), neutral(5, 2), neutral(6, 2), enemy(8, 2), enemy(9, 2)]);
  const dInput = (goal?: 'balanced' | 'defend' | 'expand'): PlanInput => ({
    graph: dMap,
    board: dBoard,
    me: ME,
    income: 6,
    settings: STD,
    options: { enemyDeploy: 5, ...(goal ? { goal } : {}) },
  });

  it('(d) completes the cheap +3 next door and defends only what the rest of the income pays for', () => {
    const p = planTurn(dInput('balanced'));
    expect(p.expected.bonusesCompleted).toEqual([801]);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([
      [1, 5, 3],
      [1, 6, 3],
      [1, 4, 6],
    ]);
    // T2 holds (3 deployed); T3 waits behind the expansion share, then cannot be afforded.
    expect(p.deploys).toEqual([
      { territoryId: 1, armies: 3 },
      { territoryId: 2, armies: 3 },
    ]);
    expect(p.conceded).toEqual([3]);
    expect(p.warnings).toContain('T3 (#3) cannot be held with the 1 armies left to deploy (needs 3, protects +1): conceded');
    expect(p.rationale.join('\n')).toMatch(/Deploy 3 to T2 \(#2\) so it holds/);
    expect(p.rationale.join('\n')).toMatch(/T3 \(#3\).*expansion/i);
    // The conceded border withdraws its one movable army first, with Order Priority advice.
    expect(p.moves[0]).toEqual(expect.objectContaining({ from: 3, to: 1, armies: 1, kind: 'transfer' }));
    expect(p.cardAdvice).toBe('order-priority');
  });

  it('(d) funds a deferred hold once expansion has had its share', () => {
    // Income 8: the 30% share (3) stops T3's hold until the +3 is done (2), then 3 are left for it.
    const p = planTurn({ ...dInput('balanced'), income: 8 });
    expect(p.expected.bonusesCompleted).toEqual([801]);
    expect(p.deploys).toEqual([
      { territoryId: 1, armies: 2 },
      { territoryId: 2, armies: 3 },
      { territoryId: 3, armies: 3 },
    ]);
    expect(p.conceded).toEqual([]);
    expect(p.cardAdvice).toBeNull();
  });

  it('is the default goal', () => {
    expect(planTurn(dInput())).toEqual(planTurn(dInput('balanced')));
  });

  it('(f) defend keeps all-defence: both holds first, so the +3 is not completed', () => {
    const p = planTurn(dInput('defend'));
    expect(p.deploys).toEqual([
      { territoryId: 2, armies: 3 },
      { territoryId: 3, armies: 3 },
    ]);
    expect(p.conceded).toEqual([]);
    expect(p.expected.bonusesCompleted).toEqual([]);
  });

  // (e) T1 (5 armies) borders T5 (2 armies), one of an enemy's three territories
  // making up its complete, fully visible +4 bonus.
  const eMap = buildGraph(
    makeMap(
      [1, 5, 6, 7],
      [
        [1, 5],
        [5, 6],
        [6, 7],
      ],
      [[811, 4, [5, 6, 7]]],
    ),
  );
  const eBoard = board([mine(1, 5), enemy(5, 2), enemy(6, 2), enemy(7, 2)]);

  it('(e) breaks an enemy bonus with the exact capture cost', () => {
    const p = planTurn({ graph: eMap, board: eBoard, me: ME, income: 5, settings: STD });
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[1, 5, captureCost(2, STD)]]);
    expect(p.rationale.join('\n')).toMatch(/Attack T5 \(#5\) from T1 \(#1\) with 3: breaks enemy bonus B811 \(#811\) \(\+4/);
    // 2 survivors need 3 to take; T6 has 1 movable + ~5 deploy next to it.
    expect(p.warnings.join('\n')).toMatch(/T5 \(#5\).*retaken/);
    expect(deploySum(p)).toBe(5);
  });

  it('(f) expand and defend never attack the enemy bonus', () => {
    for (const goal of ['expand', 'defend'] as const) {
      const p = planTurn({ graph: eMap, board: eBoard, me: ME, income: 5, settings: STD, options: { goal } });
      expect(attacks(p), goal).toEqual([]);
    }
  });

  it('never breaks a bonus that is partly fogged or split between owners', () => {
    for (const s of [
      board([mine(1, 5), enemy(5, 2), enemy(6, 2), fogged(7)]),
      board([mine(1, 5), enemy(5, 2), enemy(6, 2), enemy(7, 2, 30)]),
    ]) {
      const p = planTurn({ graph: eMap, board: s, me: ME, income: 5, settings: STD });
      expect(attacks(p)).toEqual([]);
    }
  });

  it('prefers a break target whose capture survives the counter-attack', () => {
    // Bonus {T5, T6}: T5 (2) is cheap but next to a 20-army T7; T6 (10) costs 16 and its
    // 9 survivors need 15 to take against T5's 1 movable + 5 deploy.
    const g = buildGraph(
      makeMap(
        [1, 5, 6, 7],
        [
          [1, 5],
          [1, 6],
          [5, 6],
          [5, 7],
        ],
        [[812, 2, [5, 6]]],
      ),
    );
    const s = board([mine(1, 20), enemy(5, 2), enemy(6, 10), enemy(7, 20)]);
    const p = planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD, options: { enemyDeploy: 5 } });
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[1, 6, 16]]);
    expect(p.warnings.join('\n')).not.toMatch(/retaken/);
  });

  it('weighs a break by the number of opponents', () => {
    // T1 can fund one 3-army capture: a neutral +3 (score 1) or breaking an enemy +4 (4/3,
    // or 2/3 with two opponents).
    const g = buildGraph(
      makeMap(
        [1, 2, 5, 9],
        [
          [1, 2],
          [1, 5],
        ],
        [
          [821, 3, [2]],
          [822, 4, [5]],
        ],
      ),
    );
    const s = board([mine(1, 6), neutral(2, 2), enemy(5, 2)]);
    const one = planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD });
    expect(attacks(one).map((m) => m.to)).toEqual([5]);
    const two = planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD, options: { opponents: 2 } });
    expect(attacks(two).map((m) => m.to)).toEqual([2]);
    // By default the opponents are the enemy players in sight.
    const seen = planTurn({ graph: g, board: board([...s.territories, enemy(9, 1, 30)]), me: ME, income: 0, settings: STD });
    expect(attacks(seen).map((m) => m.to)).toEqual([2]);
  });

  it('never attacks an enemy territory that breaks nothing', () => {
    const g = buildGraph(makeMap([1, 5], [[1, 5]], []));
    const p = planTurn({ graph: g, board: board([mine(1, 9), enemy(5, 1)]), me: ME, income: 5, settings: STD });
    expect(attacks(p)).toEqual([]);
  });

  it('holds a border that protects more than the expansion is worth, before expanding', () => {
    // As (d), but T2 and T3 are each a held +5: the expansion share does not apply.
    const g = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6, 8, 9],
        [
          [1, 2],
          [1, 3],
          [1, 4],
          [1, 5],
          [1, 6],
          [2, 8],
          [3, 9],
        ],
        [
          [801, 3, [4, 5, 6]],
          [802, 5, [2]],
          [803, 5, [3]],
        ],
      ),
    );
    const p = planTurn({ ...dInput('balanced'), graph: g });
    expect(p.deploys).toEqual([
      { territoryId: 2, armies: 3 },
      { territoryId: 3, armies: 3 },
    ]);
    expect(p.conceded).toEqual([]);
    expect(p.expected.bonusesCompleted).toEqual([]);
  });

  describe('a threatened border whose only threat is a breakable member', () => {
    // T1 and T2 are each a held +5, threatened only by T5 / T6 (2 armies each), members of
    // an enemy's complete +4 {T5, T6, T7}. T9 is an enemy territory in no bonus.
    const g = buildGraph(
      makeMap(
        [1, 2, 5, 6, 7, 9],
        [
          [1, 5],
          [2, 6],
          [5, 6],
          [6, 7],
          [1, 9],
        ],
        [
          [831, 5, [1]],
          [832, 5, [2]],
          [833, 4, [5, 6, 7]],
        ],
      ),
    );
    const base = { graph: g, me: ME, settings: STD } as const;

    it('attacks it from the border and still holds: what stays behind holds if the capture fails', () => {
      // T1 (4) faces 1 movable + ~5 deploy = 6: the hold costs 1. The capture (3) comes on
      // top of it, so T1 keeps 4 + 1 armies whether or not T5 falls.
      const p = planTurn({ ...base, board: board([mine(1, 4), enemy(5, 2), enemy(6, 2), enemy(7, 2)]), income: 5 });
      expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[1, 5, 3]]);
      // 1 for the hold and 3 for the capture; the leftover 1 goes to the attacking stack.
      expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
      expect(armiesToTake(4 + 1)).toBeGreaterThan(6);
      const why = p.rationale.join('\n');
      expect(why).toMatch(/T5 \(#5\) is the only visible threat to T1 \(#1\): capturing it removes that threat/);
      expect(why).toContain('Deploy 1 to T1 (#1) so it still holds (protects +5) after attacking T5 (#5): 5 armies stay');
      expect(p.conceded).toEqual([]);
      expect(deploySum(p)).toBe(5);
    });

    it('holds instead when the threat is too costly to capture on top of the hold (it would be reinforced)', () => {
      // T1 (4, a held +5) next to T5 (12) in the enemy's complete +4; enemy deploy 9, income 17.
      // The threat is 11 + 9 = 20: the hold costs 9. Capturing T5 at its current 12 would cost 20
      // and leave T1 with 2, and under the threat model T5 is reinforced to 21 first, so the
      // attack fails and T1 falls. Holding is what keeps the +5.
      const p = planTurn({
        ...base,
        board: board([mine(1, 4), enemy(5, 12), enemy(6, 2), enemy(7, 2)]),
        income: 17,
        options: { enemyDeploy: 9 },
      });
      expect(attacks(p)).toEqual([]);
      expect(p.rationale.join('\n')).toMatch(/Deploy 9 to T1 \(#1\) so it holds \(protects \+5\)/);
      expect(p.rationale.join('\n')).not.toMatch(/only visible threat/);
      expect(armiesToTake(4 + deployedTo(p, 1))).toBeGreaterThan(20);
      expect(p.conceded).toEqual([]);
      expect(deploySum(p)).toBe(17);
    });

    it('never leaves the border short: every break from a held border keeps the hold', () => {
      for (const [have, n, income, enemyDeploy] of [
        [4, 2, 5, 5],
        [4, 6, 30, 5],
        [1, 2, 9, 3],
        [6, 9, 25, 2],
        [4, 12, 40, 9],
      ] as const) {
        const p = planTurn({
          ...base,
          board: board([mine(1, have), enemy(5, n), enemy(6, 2), enemy(7, 2)]),
          income,
          options: { enemyDeploy },
        });
        const out = p.moves.filter((m) => m.from === 1).reduce((s, m) => s + m.armies, 0);
        const threat = n - 1 + enemyDeploy;
        if ((armiesToTake(have) ?? Infinity) <= threat)
          expect(armiesToTake(have + deployedTo(p, 1) - out), `${have} vs ${n}`).toBeGreaterThan(threat);
      }
    });

    it('holds instead when another enemy also threatens the border', () => {
      const p = planTurn({
        ...base,
        board: board([mine(1, 4), enemy(5, 2), enemy(6, 2), enemy(7, 2), enemy(9, 2)]),
        income: 5,
        options: { enemyDeploy: 5 },
      });
      expect(attacks(p)).toEqual([]);
      expect(p.rationale.join('\n')).toMatch(/so it holds/);
    });

    it('holds instead when the reserve leaves nothing for the capture', () => {
      const p = planTurn({
        ...base,
        board: board([mine(1, 1), enemy(5, 2), enemy(6, 2), enemy(7, 2)]),
        income: 4,
        options: { reserve: 2 },
      });
      expect(attacks(p)).toEqual([]);
      expect(p.rationale.join('\n')).toMatch(/Deploy 4 to T1 \(#1\) so it holds/);
    });

    it('breaks a bonus once: a second border next to it holds', () => {
      const p = planTurn({
        ...base,
        board: board([mine(1, 4), mine(2, 4), enemy(5, 2), enemy(6, 2), enemy(7, 2)]),
        income: 6,
      });
      expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[1, 5]]);
      expect(p.rationale.join('\n')).toMatch(/so it holds/);
      expect(p.rationale.join('\n')).toMatch(/T2 \(#2\) so it holds/);
    });
  });
});

describe('enemy deploy estimate', () => {
  it('defaults to max(5, round(0.75 × the largest visible enemy stack))', () => {
    expect(defaultEnemyDeploy(board([mine(1, 2), neutral(3, 2)]), ME)).toBe(5);
    expect(defaultEnemyDeploy(board([mine(1, 2), enemy(2, 6)]), ME)).toBe(5);
    expect(defaultEnemyDeploy(board([mine(1, 40), enemy(2, 13), enemy(3, 4, 30)]), ME)).toBe(10);
    expect(defaultEnemyDeploy(board([enemy(2, 20), enemy(3, 9, 30)]), ME)).toBe(15);
    // Fogged territories and my own stacks never count.
    expect(defaultEnemyDeploy(board([mine(1, 99), fogged(2)]), ME)).toBe(5);
  });

  // Synthetic stand-in for the live case: my 12 armies on T1 ("Florida") next to
  // an enemy showing 13 on T2 ("Tennessee"). 12 armies need 20 to take; the old
  // fixed estimate (12 movable + 5) said it was safe, but the enemy deployed more.
  // T1 is a held +2 bonus, so holding it pays (L1 concedes borders that protect nothing).
  const g = buildGraph(
    makeMap(
      [1, 2, 3],
      [
        [1, 2],
        [1, 3],
      ],
      [
        [501, 1, [3]],
        [502, 2, [1]],
      ],
    ),
  );
  const florida = board([mine(1, 12), enemy(2, 13), neutral(3, 2)]);

  it('regression: 13 visible next door threatens a 12-army border, and defend holds it', () => {
    expect(armiesToTake(12)).toBe(20);
    expect(armiesToTake(12)).toBeGreaterThan(12 + 5);
    const warnOnly = planTurn({ graph: g, board: florida, me: ME, income: 5, settings: STD });
    expect(warnOnly.warnings.join(' ')).toMatch(/T1 \(#1\) \(12 armies\) could be taken/);

    const p = planTurn({ graph: g, board: florida, me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    const d = p.deploys.find((x) => x.territoryId === 1)?.armies ?? 0;
    expect(d).toBeGreaterThan(0);
    // Holds against 12 movable + ~10 deploy.
    expect(armiesToTake(12 + d)).toBeGreaterThan(12 + 10);
    expect(p.rationale.join(' ')).toMatch(/so it holds/);
    expect(p.moves.filter((m) => m.from === 1)).toEqual([]);
  });

  it('the warnings state the estimate used and that unseen income is unknown', () => {
    const p = planTurn({ graph: g, board: florida, me: ME, income: 5, settings: STD });
    const w = p.warnings.join('\n');
    expect(w).toMatch(/~10/);
    expect(w).toMatch(/largest visible enemy stack \(13\)/);
    expect(w).toMatch(/income .*unknown/i);
    expect(p.enemyDeploy).toBe(10);
  });

  it('a caller estimate replaces the default and is named as such', () => {
    const p = planTurn({ graph: g, board: florida, me: ME, income: 5, settings: STD, options: { enemyDeploy: 3 } });
    expect(p.enemyDeploy).toBe(3);
    expect(p.warnings.join(' ')).not.toMatch(/could be taken/);
    expect(p.warnings.join('\n')).toMatch(/~3 .*your estimate/);
  });

  it('says nothing about the estimate when no visible enemy borders me', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 12), neutral(3, 2)]), me: ME, income: 5, settings: STD });
    expect(p.warnings.join(' ')).not.toMatch(/enemy deploy estimate/i);
    expect(p.enemyDeploy).toBe(5);
  });
});

describe('planTurn — threat trend', () => {
  // (g) A growing enemy stack: T2 went 51 → 76 last turn, next to my 55 on T1
  // (a held +5 bonus). With a caller estimate of ~10 deploy, 75 movable + 10 = 85
  // stays under the 91 it takes to break 55, so the border looks safe. The trend
  // (+25/turn) projects 75 + 25 = 100, which breaks it: holding needs 61 armies
  // (61 need 101 to take), and the turn after 75 + 25 + 25 = 125 needs 76.
  const g = buildGraph(
    makeMap(
      [1, 2, 3],
      [
        [1, 2],
        [1, 3],
      ],
      [
        [701, 5, [1]],
        [702, 1, [3]],
      ],
    ),
  );
  const now = board([mine(1, 55), enemy(2, 76), neutral(3, 30)]);
  const then = board([mine(1, 55), enemy(2, 51), neutral(3, 30)]);
  const base = { graph: g, board: now, me: ME, settings: STD } as const;

  it('(g) without the previous board the border looks safe', () => {
    expect(armiesToTake(55)).toBe(91);
    const p = planTurn({ ...base, income: 10, options: { goal: 'defend', enemyDeploy: 10 } });
    expect(p.warnings.join('\n')).not.toMatch(/could be taken|is building/);
    expect(p.rationale.join('\n')).not.toMatch(/so it holds/);
  });

  it('(g) with the previous board the projected threat breaks it, and defend deploys enough to hold', () => {
    const p = planTurn({ ...base, income: 10, previousBoard: then, options: { goal: 'defend', enemyDeploy: 10 } });
    const w = p.warnings.join('\n');
    expect(w).toContain(
      'T2 (#2) is building: +25/turn (51 → 76); at this rate T1 (#1) needs 61 to hold next turn and 76 the turn after',
    );
    expect(w).toMatch(/T1 \(#1\) \(55 armies\) could be taken next turn: player 20 has 75 movable armies next to it plus ~25/);
    const d = p.deploys.find((x) => x.territoryId === 1)?.armies ?? 0;
    expect(d).toBeGreaterThanOrEqual(6);
    expect(armiesToTake(55 + d)).toBeGreaterThan(100);
    expect(p.rationale.join('\n')).toMatch(/Deploy 6 to T1 \(#1\) so it holds/);
    expect(p.rationale.join('\n')).toMatch(/T1 \(#1\).*trend.*\+25\/turn/);
    expect(p.conceded).toEqual([]);
  });

  it('(g) concedes per L1 when the projected hold is unaffordable', () => {
    const p = planTurn({ ...base, income: 5, previousBoard: then, options: { goal: 'defend', enemyDeploy: 10 } });
    expect(p.conceded).toEqual([1]);
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) cannot be held with the 5 armies left to deploy \(needs 6, protects \+5\)/);
  });

  it('(g) balanced uses the projected threat too', () => {
    const p = planTurn({ ...base, income: 10, previousBoard: then, options: { enemyDeploy: 10 } });
    expect(p.rationale.join('\n')).toMatch(/Deploy 6 to T1 \(#1\) so it holds/);
  });

  it('growth below the deploy estimate warns but leaves the threat at the estimate', () => {
    const p = planTurn({ ...base, income: 10, previousBoard: then, options: { goal: 'defend', enemyDeploy: 30 } });
    const w = p.warnings.join('\n');
    expect(w).toMatch(/T2 \(#2\) is building: \+25\/turn/);
    expect(w).toMatch(/plus ~30 deploy/);
    expect(p.rationale.join('\n')).not.toMatch(/trend/);
  });

  it('ignores a territory that was fogged, changed owner or shrank', () => {
    const fog = board([mine(1, 55), fogged(2), neutral(3, 30)]);
    const other = board([mine(1, 55), enemy(2, 51, 30), neutral(3, 30)]);
    const bigger = board([mine(1, 55), enemy(2, 90), neutral(3, 30)]);
    for (const previousBoard of [fog, other, bigger, board([mine(1, 55)])]) {
      const p = planTurn({ ...base, income: 10, previousBoard, options: { goal: 'defend', enemyDeploy: 10 } });
      expect(p.warnings.join('\n')).not.toMatch(/is building|could be taken/);
    }
  });

  it('only watches enemy territories next to mine', () => {
    // T3 grows far from me (behind T2): no warning.
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3],
        [
          [1, 2],
          [2, 3],
        ],
        [[701, 5, [1]]],
      ),
    );
    const p = planTurn({
      graph: g2,
      board: board([mine(1, 55), enemy(2, 3), enemy(3, 80)]),
      previousBoard: board([mine(1, 55), enemy(2, 3), enemy(3, 10)]),
      me: ME,
      income: 5,
      settings: STD,
      options: { enemyDeploy: 10 },
    });
    expect(p.warnings.join('\n')).not.toMatch(/is building/);
  });
});

describe('planTurn — transfers', () => {
  // 1 is interior (only next to my 2); 2 borders neutral 3 (wasteland).
  const g = buildGraph(
    makeMap(
      [1, 2, 3],
      [
        [1, 2],
        [2, 3],
      ],
      [[601, 1, [3]]],
    ),
  );
  const state = board([mine(1, 6), mine(2, 1), neutral(3, 30)]);

  it('moves idle interior armies to the front', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 0, settings: STD });
    expect(p.moves).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 5, kind: 'transfer' })]);
  });

  it('does not transfer when transfer-only orders are off', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 0, settings: { ...STD, allowTransferOnly: false } });
    expect(p.moves).toEqual([]);
  });

  it('keeps no guard when one-army-stands-guard is off', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 0, settings: { ...STD, oneArmyStandsGuard: false } });
    expect(p.moves[0]!.armies).toBe(6);
  });

  it('notes that multi-attack chains are not planned', () => {
    const p = planTurn({ graph: g, board: state, me: ME, income: 0, settings: { ...STD, multiAttack: true } });
    expect(p.rationale.join(' ')).toMatch(/multi-attack/i);
  });
});

// ---- property test: accounting over random small boards ----

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('planTurn — accounting property', () => {
  it('deploys exactly the income, never over-commits, and arms every attack', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
      const n = int(3, 10);
      const ids = Array.from({ length: n }, (_, i) => i + 1);
      const edges: [number, number][] = [];
      for (let i = 2; i <= n; i++) edges.push([i, int(1, i - 1)]);
      for (let k = 0; k < n; k++) {
        const a = int(1, n);
        const b = int(1, n);
        if (a !== b) edges.push([a, b]);
      }
      const bonuses: [number, number, number[]][] = [];
      for (let b = 0; b < int(0, 3); b++) {
        const members = ids.filter(() => r() < 0.4);
        if (members.length) bonuses.push([100 + b, int(-1, 5), members]);
      }
      const g = buildGraph(makeMap(ids, edges, bonuses));
      const entries: TerritoryState[] = ids.map((id) => {
        const k = id === 1 ? 0 : int(0, 4);
        if (k === 0) return mine(id, int(0, 8));
        if (k === 1) return enemy(id, int(1, 12));
        if (k === 2) return fogged(id);
        return neutral(id, int(0, 12));
      });
      const settings: PlannerSettings = {
        offensiveKillRate: int(40, 100),
        defensiveKillRate: int(0, 100),
        luckModifier: r() < 0.3 ? 0.16 : 0,
        oneArmyStandsGuard: r() < 0.8,
        multiAttack: r() < 0.3,
        allowTransferOnly: r() < 0.8,
      };
      const goals = ['expand', 'complete-bonus', 'defend', 'balanced'] as const;
      const input: PlanInput = {
        graph: g,
        board: board(entries),
        me: ME,
        income: int(0, 12),
        settings,
        options: { goal: goals[int(0, 3)], reserve: int(0, 3) },
      };
      const p = planTurn(input);
      const ctx = `seed ${seed}`;
      expect(planTurn(input), ctx).toEqual(p);

      const byId = new Map(entries.map((e) => [e.territoryId, e]));
      const isMine = (id: number) => byId.get(id)?.owner.kind === 'player' && (byId.get(id)!.owner as { playerId: number }).playerId === ME;
      expect(deploySum(p), ctx).toBe(input.income);
      for (const d of p.deploys) expect(isMine(d.territoryId), ctx).toBe(true);

      const guard = settings.oneArmyStandsGuard ? 1 : 0;
      const out = new Map<number, number>();
      const captured = new Set<number>();
      for (const m of p.moves) {
        expect(neighborsOf(g, m.from), ctx).toContain(m.to);
        expect(isMine(m.from), ctx).toBe(true); // nothing moves out of a fresh capture
        expect(m.armies, ctx).toBeGreaterThan(0);
        out.set(m.from, (out.get(m.from) ?? 0) + m.armies);
        if (m.kind === 'attack') {
          const t = byId.get(m.to)!;
          expect(t.armies, ctx).not.toBeNull();
          expect(isMine(m.to), ctx).toBe(false);
          expect(m.armies, ctx).toBeGreaterThanOrEqual(captureCost(t.armies!, settings)!);
          expect(captured.has(m.to), ctx).toBe(false);
          captured.add(m.to);
        } else {
          expect(isMine(m.to) || captured.has(m.to), ctx).toBe(true);
        }
      }
      for (const [from, n] of out) {
        const dep = p.deploys.find((d) => d.territoryId === from)?.armies ?? 0;
        expect(n, ctx).toBeLessThanOrEqual(byId.get(from)!.armies! + dep - guard);
      }
      expect(p.expected.captures, ctx).toEqual([...captured].sort((a, b) => a - b));
    }
  });
});
