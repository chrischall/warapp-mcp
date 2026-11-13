import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph, neighborsOf } from '../../src/analysis/graph.js';
import {
  BREAK_WEIGHT,
  captureCost,
  COMFORT_MARGIN,
  CONCEDE_FACTOR,
  DEFENSE_DISCOUNT,
  defaultEnemyDeploy,
  enemyDeployEstimates,
  incomeFor,
  MIN_ENEMY_DEPLOY,
  MIN_EXPANSION_SHARE,
  PAYBACK_TURNS,
  planTurn,
  type PlanInput,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral, tinyMap, ruleAttacks } from './helpers.js';

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
    // Balanced with no bonus held commits to the closest bonus (#101): P finishes this turn
    // (3 armies, 1 turn at income 3), Q in 2 (6 armies), so P is completed although Q earns more
    // per army.
    const b = planTurn({ graph: g, board: state, me: ME, income: 3, settings: STD });
    expect(attacks(b).map((m) => m.to)).toEqual([2]);
    expect(b.expected.bonusesCompleted).toEqual([201]);
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
    // Threat: 49 movable + 38 deploy = 87; 53 armies need 88, so holding needs 52. (R1: T9's owner
    // holds no visible bonus, so its own estimate is the 5 floor; the 38 — the old stack rule's
    // round(0.75 × 50) — is now passed explicitly, standing for an opponent with that income.)
    const p = planTurn({ graph: ag, board: aBoard(1), me: ME, income: 35, settings: STD, options: { goal: 'defend', enemyDeploy: 38 } });
    expect(p.warnings).toContain('T1 (#1) cannot be held economically (needs 52, protects +4): conceded');
    expect(p.conceded).toEqual([1]);
    expect(p.deploys.find((d) => d.territoryId === 1)).toBeUndefined();
    expect(deploySum(p)).toBe(35);
    // Nothing to withdraw from a 1-army border (its army stands guard).
    expect(p.moves.some((m) => m.from === 1)).toBe(false);
    expect(p.cardAdvice).toBeNull();
  });

  it('(a) withdraws a conceded border\'s movable armies behind it, first, with Order Priority advice', () => {
    // #118: T1 must not be in a bonus I hold in full (its garrison would stay), so T5 is out of
    // sight here: bonus 701 is not visibly held, and T1 protects +0.
    const p = planTurn({ graph: ag, board: board([mine(1, 15), mine(2, 1), mine(3, 4), neutral(4, 2), fogged(5), enemy(9, 50)]), me: ME, income: 35, settings: STD, options: { goal: 'defend', enemyDeploy: 38 } });
    expect(p.warnings).toContain('T1 (#1) cannot be held economically (needs 38, protects +0): conceded');
    expect(p.deploys.find((d) => d.territoryId === 1)).toBeUndefined();
    // Toward the frontier (T2, one step from T3), not into the fogged dead end T5.
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
    // (#118: with a ~38 deploy holding T1 needs 38, more than the 35 income, so it is conceded
    // under every goal; with less, what the capture leaves would now hold it.)
    const s = board([mine(1, 15), mine(2, 10), mine(3, 4), neutral(4, 2), mine(5, 1), enemy(9, 50)]);
    for (const goal of ['expand', 'defend', 'balanced'] as const) {
      const p = planTurn({ graph: ag, board: s, me: ME, income: 35, settings: STD, options: { goal, enemyDeploy: 38 } });
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

  it('holds a big stack for a modest top-up: the armies it saves count toward its worth', () => {
    // T1 has 60 armies and protects +4; ~132 threaten it (59 movable + 73 deploy), so
    // holding needs 20 more. 20 > 3 × 4, but the 60 armies at stake are worth
    // 60 / PAYBACK_TURNS = +6 of income: 20 ≤ 3 × (4 + 6), so it is held, not abandoned.
    for (const goal of ['defend', 'balanced'] as const) {
      const p = planTurn({
        graph: ag,
        board: aBoard(60),
        me: ME,
        income: 35,
        settings: STD,
        options: { goal, enemyDeploy: 73 },
      });
      expect(p.conceded, goal).toEqual([]);
      expect(p.deploys.find((d) => d.territoryId === 1)?.armies, goal).toBeGreaterThanOrEqual(20);
      expect(p.moves.filter((m) => m.from === 1 && m.kind === 'transfer'), goal).toEqual([]);
      expect(p.cardAdvice, goal).toBeNull();
    }
  });

  it('(a) under expand it still warns of the concession but neither withdraws nor advises a card', () => {
    const p = planTurn({ graph: ag, board: aBoard(15), me: ME, income: 35, settings: STD, options: { goal: 'expand', enemyDeploy: 38 } });
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
    // #118: its one movable army stays — T1 is all of bonus 703, which I hold, and moving it to
    // T3 makes no other border hold this turn.
    expect(p.moves.some((m) => m.from === 1)).toBe(false);
    expect(p.cardAdvice).toBeNull();
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
      expect(p.deploys.some((d) => d.territoryId === 1), goal).toBe(false);
      if (goal === 'balanced') {
        // #107: in contact, with no other capture, T2 takes T9 (3: 5 to take, deploying 1), which
        // removes its only threat; the leftover 5 then goes to T2 too.
        expect(attacks(p), goal).toEqual([expect.objectContaining({ from: 2, to: 9, kind: 'attack' })]);
        expect(p.deploys, goal).toEqual([{ territoryId: 2, armies: 6 }]);
        continue;
      }
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

    // With one army per territory held (and no base income it would fall back to),
    // losing T1 also costs that army of income.
    const lone = buildGraph(makeMap([1, 8], [[1, 8]], []));
    const q = planTurn({
      graph: lone,
      board: board([mine(1, 2), enemy(8, 6)]),
      me: ME,
      income: 5,
      settings: { ...STD, bonusArmyPer: 1, baseIncome: 0 },
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
    // T2 holds (3 deployed); T3 waits behind the expansion share, then only 1 of its 3 is
    // left: short by 2, a near miss (#59), so it gets that 1 and keeps its armies.
    expect(p.deploys).toEqual([
      { territoryId: 1, armies: 2 },
      { territoryId: 2, armies: 3 },
      { territoryId: 3, armies: 1 },
    ]);
    expect(p.conceded).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(
      /Bonus B803 \(#803\) \(\+1\) is held though short: its 1 threatened border needs 3, only 1 left to deploy, so all 1 go there \(short by 2, within the near-miss margin of 2\); T3 \(#3\) may fall\./,
    );
    expect(p.rationale.join('\n')).toMatch(/Deploy 3 to T2 \(#2\) so it holds/);
    expect(p.rationale.join('\n')).toMatch(/T3 \(#3\).*after this turn's bonus completions/);
    expect(p.moves.some((m) => m.from === 3)).toBe(false);
    expect(p.cardAdvice).toBeNull();
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

  it('(e) breaks an enemy bonus with the exact capture cost, topped up from idle armies', () => {
    // enemyDeploy is pinned at 5: this is about the mechanic, not the estimate (a holder of a +4 is estimated at 9).
    const p = planTurn({ graph: eMap, board: eBoard, me: ME, income: 5, settings: STD, options: { enemyDeploy: 5 } });
    expect(p.rationale.join('\n')).toMatch(/Attack T5 \(#5\) from T1 \(#1\) with 3: breaks enemy bonus B811 \(#811\) \(\+4/);
    // S2: T1's leftover armies would sit idle once T5 falls, so the attack grows from the
    // exact cost (3) to the next efficient size (5: 3 kills for sure instead of 2).
    expect(captureCost(2, STD)).toBe(3);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[1, 5, 5]]);
    expect(p.rationale.join('\n')).toMatch(/Top up the attack on T5 \(#5\) from T1 \(#1\) from 3 to 5/);
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
      expect(ruleAttacks(p)).toEqual([]);
      expect(p.offence).toEqual([]);
    }
  });

  it('aims a break at its cheapest member: a break only has to land (#72)', () => {
    // Bonus {T5, T6}: T5 (2) is cheap but next to a 20-army T7; T6 (10) costs 16 and its
    // 9 survivors need 15 to take against T5's 1 movable + 5 deploy. Before #72 the survivable
    // T6 was preferred; the opponent loses the +2 this turn either way, so T5 is taken: sized at 3,
    // then (#120) for its 2 defenders plus the ~5 deploy (11) from T1's armies beyond the 9 that
    // hold it against T6.
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
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[1, 5, 11]]);
    expect(p.warnings.join('\n')).toMatch(/T5 \(#5\) can be retaken after it breaks B812/);
  });

  it('weighs a break by the number of opponents', () => {
    // T1 can fund one 3-army capture: a neutral +3 (score 1) or breaking an enemy +4 (4/3,
    // or 2/3 with two opponents). T1 keeps what holds it against T5 when it takes the neutral
    // (#121): with an enemy deploy of 2 (threat 3) that is 1 army, so 4 of its 5 are spare, enough for one
    // capture, not both.
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
    const one = planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD, options: { enemyDeploy: 2 } });
    expect(attacks(one).map((m) => m.to)).toEqual([5]);
    const two = planTurn({ graph: g, board: s, me: ME, income: 0, settings: STD, options: { opponents: 2, enemyDeploy: 2 } });
    expect(attacks(two).map((m) => m.to)).toEqual([2]);
    // By default the opponents are the enemy players in sight.
    const seen = planTurn({ graph: g, board: board([...s.territories, enemy(9, 1, 30)]), me: ME, income: 0, settings: STD, options: { enemyDeploy: 2 } });
    expect(attacks(seen).map((m) => m.to)).toEqual([2]);
  });

  it('never attacks an enemy territory that breaks nothing', () => {
    // The enemy also holds 6, out of my reach, so it cannot be finished off this turn (#45).
    const g = buildGraph(makeMap([1, 5, 6], [[1, 5], [5, 6]], []));
    const p = planTurn({
      graph: g,
      board: board([mine(1, 9), enemy(5, 1), enemy(6, 1)]),
      me: ME,
      income: 5,
      settings: STD,
    });
    expect(ruleAttacks(p)).toEqual([]);
    expect(p.offence).toEqual([]);
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
      // T1 (4) faces 1 movable + 5 deploy = 6: the hold costs 1. The capture (3) comes on
      // top of it, so T1 keeps 4 + 1 armies whether or not T5 falls. (enemyDeploy pinned at 5:
      // the holder of the +4 is estimated at 9, which is a different sum for the same mechanic.)
      const p = planTurn({
        ...base,
        board: board([mine(1, 4), enemy(5, 2), enemy(6, 2), enemy(7, 2)]),
        income: 5,
        options: { enemyDeploy: 5 },
      });
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
        options: { reserve: 2, enemyDeploy: 5 },
      });
      expect(attacks(p)).toEqual([]);
      expect(p.rationale.join('\n')).toMatch(/Deploy 4 to T1 \(#1\) so it holds/);
    });

    it('breaks a bonus once: a second border next to it holds', () => {
      const p = planTurn({
        ...base,
        board: board([mine(1, 4), mine(2, 4), enemy(5, 2), enemy(6, 2), enemy(7, 2)]),
        income: 6,
        options: { enemyDeploy: 5 },
      });
      expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[1, 5]]);
      expect(p.rationale.join('\n')).toMatch(/so it holds/);
      expect(p.rationale.join('\n')).toMatch(/T2 \(#2\) so it holds/);
    });
  });
});

describe('enemy deploy estimate', () => {
  it('defaults to the largest per-opponent estimate next to me, at least MIN_ENEMY_DEPLOY', () => {
    const g = buildGraph(tinyMap());
    // No visible enemy, or only a fogged one: the floor.
    expect(defaultEnemyDeploy(g, board([mine(1, 2), neutral(3, 2)]), ME)).toBe(MIN_ENEMY_DEPLOY);
    expect(defaultEnemyDeploy(g, board([mine(1, 99), fogged(2)]), ME)).toBe(MIN_ENEMY_DEPLOY);
    // A 40-stack next to me but no visible bonus: base income only (a stack is no part of the estimate, #119).
    expect(defaultEnemyDeploy(g, board([mine(1, 2), enemy(2, 40), neutral(3, 3)]), ME)).toBe(5);
    // Player 20 holds bonus B (+2) in full: 5 + 2 = 7.
    expect(defaultEnemyDeploy(g, board([mine(3, 2), enemy(4, 40), enemy(5, 1), neutral(1, 3)]), ME)).toBe(7);
  });

  // Synthetic stand-in for the live case: my 12 armies on T1 ("Florida") next to
  // an enemy showing 13 on T2 ("Tennessee"). 12 armies need 20 to take; the old
  // fixed estimate (12 movable + 5) said it was safe, but the enemy deployed more.
  // T1 is a held +2 bonus, so holding it pays (L1 concedes borders that protect nothing).
  // R1: the enemy's estimate is now income-aware, so the fixture gives it the income
  // the live opponent really had — a visibly held +6 bonus (T2 + T4): 5 + 6 = 11, with no
  // stack cap since #119.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4],
      [
        [1, 2],
        [1, 3],
        [2, 4],
      ],
      [
        [501, 1, [3]],
        [502, 2, [1]],
        [503, 6, [2, 4]],
      ],
    ),
  );
  const florida = board([mine(1, 12), enemy(2, 13), neutral(3, 2), enemy(4, 3)]);

  it('regression: 13 visible next door threatens a 12-army border, and defend holds it', () => {
    expect(armiesToTake(12)).toBe(20);
    expect(armiesToTake(12)).toBeGreaterThan(12 + 5);
    const warnOnly = planTurn({ graph: g, board: florida, me: ME, income: 5, settings: STD });
    expect(warnOnly.warnings.join(' ')).toMatch(/T1 \(#1\) \(12 armies\) could be taken/);

    const p = planTurn({ graph: g, board: florida, me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    const d = p.deploys.find((x) => x.territoryId === 1)?.armies ?? 0;
    expect(d).toBeGreaterThan(0);
    // Holds against 12 movable + ~11 deploy.
    expect(armiesToTake(12 + d)).toBeGreaterThan(12 + 11);
    expect(p.rationale.join(' ')).toMatch(/so it holds/);
    expect(p.moves.filter((m) => m.from === 1)).toEqual([]);
  });

  it('the warnings state the estimate used, its basis, and that unseen income is unknown', () => {
    const p = planTurn({ graph: g, board: florida, me: ME, income: 5, settings: STD });
    const w = p.warnings.join('\n');
    // The +6 it visibly holds is all deployable: 11, whatever its 13-stack next to me.
    expect(w).toMatch(/Enemy deploy estimate for player 20: ~11 /);
    expect(w).toMatch(/base 5 \+ visible bonuses \+6 = 11/);
    expect(w).toMatch(/largest stack next to me \(13\) is what can move, not a limit on what it deploys/);
    expect(w).toMatch(/income .*unknown/i);
    expect(p.enemyDeploy).toBe(11);
  });

  it('a caller estimate replaces the default and is named as such', () => {
    const p = planTurn({ graph: g, board: florida, me: ME, income: 5, settings: STD, options: { enemyDeploy: 3 } });
    expect(p.enemyDeploy).toBe(3);
    expect(p.warnings.join(' ')).not.toMatch(/could be taken/);
    expect(p.warnings.join('\n')).toMatch(/~3 .*your estimate/);
    expect(p.warnings.join('\n')).not.toMatch(/for player 20/);
  });

  it('says nothing about the estimate when no visible enemy borders me', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 12), neutral(3, 2)]), me: ME, income: 5, settings: STD });
    expect(p.warnings.join(' ')).not.toMatch(/enemy deploy estimate/i);
    expect(p.enemyDeploy).toBe(5);
  });
});

describe('enemy deploy estimate — per opponent, income-aware (R1)', () => {
  // T1 is mine; T2 an enemy border; T4 sits behind T2; T3 a cheap neutral.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4],
      [
        [1, 2],
        [1, 3],
        [2, 4],
      ],
      [
        [501, 1, [3]],
        [502, 5, [2, 4]],
      ],
    ),
  );

  it('(a) an opponent with no complete bonus and a 15-stack is estimated at the floor, not 11', () => {
    const s = board([mine(1, 15), enemy(2, 15), neutral(3, 2), neutral(4, 2)]);
    const [e] = enemyDeployEstimates(g, s, ME);
    expect(e).toMatchObject({ playerId: ENEMY, estimate: MIN_ENEMY_DEPLOY, base: 5, bonusIncome: 0, largestStack: 15 });
    // 14 movable + 5 = 19 cannot take 15 (needs 25); the old ~11 said 25 could.
    expect(armiesToTake(15)).toBe(25);
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD });
    expect(p.enemyDeploy).toBe(MIN_ENEMY_DEPLOY);
    expect(p.warnings.join('\n')).not.toMatch(/could be taken/);
    expect(p.warnings.join('\n')).toMatch(/Enemy deploy estimate for player 20: ~5 \(base 5 \+ visible bonuses \+0 = 5/);
  });

  it('the floor is the game\'s base income when that exceeds MIN_ENEMY_DEPLOY (opening board too)', () => {
    const rich = { baseIncome: 8 };
    // Mid-game, no visible bonus, a big adjacent stack: base 8, not the 5 minimum.
    const [mid] = enemyDeployEstimates(g, board([mine(1, 15), enemy(2, 15), neutral(3, 2), neutral(4, 2)]), ME, rich);
    expect(mid).toMatchObject({ estimate: 8, base: 8, largestStack: 15 });
    // A small adjacent stack changes nothing: the base income is all deployable.
    const [small] = enemyDeployEstimates(g, board([mine(1, 15), enemy(2, 2), neutral(3, 2), neutral(4, 2)]), ME, rich);
    expect(small).toMatchObject({ estimate: 8, largestStack: 2 });
    // Opening board (every territory holds the same count): base income, not 5.
    const [open] = enemyDeployEstimates(g, board([mine(1, 4), enemy(2, 4), neutral(3, 4), neutral(4, 4)]), ME, rich);
    expect(open).toMatchObject({ estimate: 8, opening: true });
  });

  it('(b) an opponent visibly holding a +5 bonus is estimated at base + 5', () => {
    const s = board([mine(1, 15), enemy(2, 15), neutral(3, 2), enemy(4, 3)]);
    const [e] = enemyDeployEstimates(g, s, ME);
    expect(e).toMatchObject({ playerId: ENEMY, estimate: 10, base: 5, bonusIncome: 5, largestStack: 15, opening: false });
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD });
    expect(p.enemyDeploy).toBe(10);
    expect(p.warnings.join('\n')).toMatch(/for player 20: ~10 \(base 5 \+ visible bonuses \+5 = 10/);
  });

  it('a small stack next to me does not lower the estimate: visible income is all deployable', () => {
    // Same +5 bonus but only a 7-stack next to me: still 10 (the old 75%-of-stack cap said 5).
    const s = board([mine(1, 15), enemy(2, 7), neutral(3, 2), enemy(4, 3)]);
    expect(enemyDeployEstimates(g, s, ME)[0]).toMatchObject({ estimate: 10, bonusIncome: 5, largestStack: 7 });
    // A bonus held only partly (T4 fogged) does not count.
    const fog = board([mine(1, 15), enemy(2, 15), neutral(3, 2), fogged(4)]);
    expect(enemyDeployEstimates(g, fog, ME)[0]).toMatchObject({ estimate: 5, bonusIncome: 0 });
  });

  it('uses the game base income when given', () => {
    const s = board([mine(1, 15), enemy(2, 20), neutral(3, 2), enemy(4, 3)]);
    expect(enemyDeployEstimates(g, s, ME, { ...STD, baseIncome: 3 })[0]).toMatchObject({
      estimate: 8,
      base: 3,
      bonusIncome: 5,
    });
    // Never below the floor.
    const none = board([mine(1, 15), enemy(2, 20), neutral(3, 2), neutral(4, 3)]);
    expect(enemyDeployEstimates(g, none, ME, { ...STD, baseIncome: 3 })[0]!.estimate).toBe(MIN_ENEMY_DEPLOY);
  });

  it('(c) on the all-equal opening board every opponent is estimated at the floor', () => {
    // Every visible territory (mine, neutrals, both opponents) still holds the starting 15;
    // player 20 even holds bonus 502 in full. No one has deployed yet.
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5],
        [
          [1, 2],
          [1, 3],
          [2, 4],
          [1, 5],
        ],
        [
          [501, 1, [3]],
          [502, 5, [2, 4]],
        ],
      ),
    );
    const s = board([mine(1, 15), enemy(2, 15), neutral(3, 15), enemy(4, 15), enemy(5, 15, 30)]);
    const es = enemyDeployEstimates(g2, s, ME);
    expect(es.map((e) => [e.playerId, e.estimate, e.opening])).toEqual([
      [20, MIN_ENEMY_DEPLOY, true],
      [30, MIN_ENEMY_DEPLOY, true],
    ]);
    const p = planTurn({ graph: g2, board: s, me: ME, income: 5, settings: STD });
    expect(p.enemyDeploy).toBe(MIN_ENEMY_DEPLOY);
    const w = p.warnings.join('\n');
    expect(w).toMatch(/for player 20: ~5 \(opening board: every visible territory holds 15/);
    expect(w).toMatch(/for player 30: ~5 \(opening board/);
    expect(w).not.toMatch(/could be taken/);
  });

  it('each border is judged against its own opponent', () => {
    // T1 faces player 20 (13-stack, +6 bonus: ~11); T6 faces player 30 (13-stack, no bonus: ~5).
    const g3 = buildGraph(
      makeMap(
        [1, 2, 4, 5, 6],
        [
          [1, 2],
          [2, 4],
          [5, 6],
        ],
        [
          [601, 6, [2, 4]],
          [602, 2, [1]],
          [603, 2, [6]],
        ],
      ),
    );
    const s = board([mine(1, 12), enemy(2, 13), enemy(4, 3), enemy(5, 13, 30), mine(6, 12)]);
    expect(enemyDeployEstimates(g3, s, ME).map((e) => [e.playerId, e.estimate])).toEqual([
      [20, 11],
      [30, 5],
    ]);
    const p = planTurn({ graph: g3, board: s, me: ME, income: 5, settings: STD });
    const w = p.warnings.join('\n');
    expect(w).toMatch(/T1 \(#1\) \(12 armies\) could be taken next turn: player 20 has 12 movable armies next to it plus ~11 deploy/);
    expect(w).not.toMatch(/T6 \(#6\) \(12 armies\) could be taken/);
    expect(p.enemyDeploy).toBe(11);
  });

  it('(d) the estimate is the visible income, whatever the size of the adjacent stack', () => {
    // +9 visible bonus: 5 + 9 = 14, with a 20-stack next to me or a 12-stack.
    const g4 = buildGraph(
      makeMap(
        [1, 2, 3, 4],
        [
          [1, 2],
          [1, 3],
          [2, 4],
        ],
        [
          [501, 1, [3]],
          [502, 9, [2, 4]],
        ],
      ),
    );
    const big = board([mine(1, 15), enemy(2, 20), neutral(3, 2), enemy(4, 3)]);
    expect(enemyDeployEstimates(g4, big, ME)[0]).toMatchObject({ estimate: 14, largestStack: 20 });
    const small = board([mine(1, 15), enemy(2, 12), neutral(3, 2), enemy(4, 3)]);
    expect(enemyDeployEstimates(g4, small, ME)[0]).toMatchObject({ estimate: 14, largestStack: 12 });
  });
});

describe('planTurn — border value after this turn\'s captures (R2)', () => {
  // I hold T1, T2, T3 of the +5 bonus {1, 2, 3, 4}; T4 is a cheap 2-army neutral
  // next to T3 (3 to take, which T3's 4 armies fund with no deploy). T1 borders
  // a visible 6-army enemy T9: threat 5 movable + 5 deploy (floor) = 10, and T1's
  // 4 armies need only 6 to take, so holding needs 3 (7 armies need 11).
  // Judged from the start-of-turn holdings T1 protected +0 (the bonus is incomplete
  // and T2/T3 keep me in it), so it was conceded and withdrawn — defeating the
  // capture that completes the bonus this turn. Since #122 a member of a bonus being
  // built carries its share (+5 × 3/4 = +3.8), so T1 is held from the start; rule 1c
  // still keeps a border conceded before the captures (the enemy 12-stack below).
  //   T9(enemy) ─ T1 ─ T2 ─ T3 ─ T4(neutral)
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 9],
      [
        [1, 9],
        [1, 2],
        [2, 3],
        [3, 4],
      ],
      [[801, 5, [1, 2, 3, 4]]],
    ),
  );
  const at = (t3: number, t4: number) =>
    board([mine(1, 4), mine(2, 1), mine(3, t3), neutral(4, t4), enemy(9, 6)]);

  for (const goal of ['balanced', 'defend'] as const)
    it(`(${goal}) completes the bonus AND keeps the bordering member it protects`, () => {
      expect(armiesToTake(4, STD)).toBe(6);
      expect(armiesToTake(7, STD)).toBe(11);
      const p = planTurn({ graph: g, board: at(4, 2), me: ME, income: 5, settings: STD, options: { goal } });
      expect(p.expected.bonusesCompleted).toEqual([801]);
      expect(attacks(p)).toEqual([expect.objectContaining({ from: 3, to: 4, armies: 3 })]);
      // T1 is kept: not conceded, never withdrawn from, and garrisoned so it holds.
      expect(p.conceded).toEqual([]);
      expect(p.moves.some((m) => m.from === 1)).toBe(false);
      expect(p.cardAdvice).toBeNull();
      expect(deployedTo(p, 1)).toBeGreaterThanOrEqual(3);
      expect(deploySum(p)).toBe(5);
      expect(p.warnings.join('\n')).not.toMatch(/T1 \(#1\).*conceded/);
      // #122: held from triage (its share of the bonus being built), not conceded and kept by 1c.
      expect(p.rationale.join('\n')).toMatch(/Deploy 3 to T1 \(#1\) so it holds \(protects \+3\.8\)/);
      // The garrison makes it safe: no warning that the completed bonus can fall.
      expect(p.warnings.join('\n')).not.toMatch(/is kept for the bonus/);
    });

  it('control: a bonus this turn cannot complete leaves the border at +0, conceded as before', () => {
    // T4 is a 30-army neutral: far beyond this turn's income (and a wasteland).
    const p = planTurn({ graph: g, board: at(4, 30), me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.conceded).toEqual([1]);
    expect(p.warnings).toContain('T1 (#1) cannot be held economically (needs 3, protects +0): conceded');
    expect(p.expected.bonusesCompleted).toEqual([]);
  });

  it('keeps the border but warns when the leftover cannot make it hold', () => {
    // A 12-stack on T9: threat 11 movable + 5 deploy = 16, so T1's hold needs 6, more than the
    // 5 income: conceded at triage. T3's 4 armies complete the bonus with no deploy; rule 1c then
    // keeps T1 and the leftover 5 make 9 armies, which need only 15 to take against the ~16.
    const p = planTurn({
      graph: g,
      board: board([mine(1, 4), mine(2, 1), mine(3, 4), neutral(4, 2), enemy(9, 12)]),
      me: ME,
      income: 5,
      settings: STD,
      options: { goal: 'defend' },
    });
    expect(p.expected.bonusesCompleted).toEqual([801]);
    expect(p.conceded).toEqual([]);
    expect(p.moves.some((m) => m.from === 1)).toBe(false);
    expect(deployedTo(p, 1)).toBe(5);
    expect(p.rationale.join('\n')).toMatch(
      /Keep T1 \(#1\) \(not conceded\): this turn's captures complete bonus B801 \(#801\) \(\+5\), so it protects \+5/,
    );
    expect(p.warnings).toContain(
      'T1 (#1) is kept for the bonus this turn completes, but its 9 armies need only 15 to take against the ~16 threat: the bonus can fall next turn.',
    );
  });

  it('#122: with T3 at 1 army, defend holds T1 first and completes the bonus next turn', () => {
    // T1's hold (3) and the capture's deploys (3) do not both fit the 5 income. Completing it
    // with T1 left on 6 armies (10 to take against the ~10 threat) lost the bonus anyway.
    const p = planTurn({ graph: g, board: at(1, 2), me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.conceded).toEqual([]);
    expect(armiesToTake(4 + deployedTo(p, 1), STD)).toBeGreaterThan(10);
    expect(p.expected.bonusesCompleted).toEqual([]);
  });

  it('keeps a conceded border only for a bonus completed this turn, not for any capture', () => {
    // T4 sits outside the bonus here: capturing it completes nothing, so T1 stays conceded.
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 9],
        [
          [1, 9],
          [1, 2],
          [2, 3],
          [3, 4],
          [2, 5],
        ],
        // T5 is fogged (absent from the board), so B801 cannot complete this turn.
        [[801, 5, [1, 2, 3, 5]], [802, 1, [4]]],
      ),
    );
    const p = planTurn({ graph: g2, board: at(4, 2), me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.expected.captures).toEqual([4]);
    expect(p.conceded).toEqual([1]);
    expect(p.warnings).toContain('T1 (#1) cannot be held economically (needs 3, protects +0): conceded');
  });

  it('never counts a completion that needs an enemy territory or a fogged one', () => {
    const withEnemy = board([mine(1, 4), mine(2, 1), mine(3, 4), enemy(4, 2), enemy(9, 6)]);
    const p = planTurn({ graph: g, board: withEnemy, me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(p.conceded).toEqual([1]);
    const withFog = board([mine(1, 4), mine(2, 1), mine(3, 4), fogged(4), enemy(9, 6)]);
    const q = planTurn({ graph: g, board: withFog, me: ME, income: 5, settings: STD, options: { goal: 'defend' } });
    expect(q.conceded).toEqual([1]);
  });
});

describe('planTurn — defensibility-aware bonus completion (R3)', () => {
  // B901 (+5) = {1, 2, 3}; B902 (+2) = {1, 2} is already mine, so T2 protects +2.
  // T3 is a 2-army neutral (3 to take; T1's 4 armies fund it with no deploy, and 2
  // survive). The enemy T9 borders both T2 and T3.
  //   T1 ─ T2 ─ T9(enemy)
  //    \   |   /
  //      T3(neutral)
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 9],
      [
        [1, 2],
        [1, 3],
        [2, 3],
        [2, 9],
        [3, 9],
      ],
      [
        [901, 5, [1, 2, 3]],
        [902, 2, [1, 2]],
      ],
    ),
  );
  const at = (e: number) => board([mine(1, 4), mine(2, 10), neutral(3, 2), enemy(9, e)]);
  const NOT_COMPLETED =
    'completing B901 (#901) leaves T3 (#3) indefensible (player 20 can take it for 3; next income 10): not completed';

  it('exports the defence discount', () => {
    expect(DEFENSE_DISCOUNT).toBeGreaterThan(0);
  });

  for (const goal of ['balanced', 'defend'] as const)
    it(`(${goal}) does not complete a bonus whose new member falls next turn; it garrisons instead`, () => {
      // T9 (16): threat 15 movable + 5 deploy = 20. Taking T3 leaves 2 armies there,
      // which need 13 to hold (13 armies need 21 > 20): 11 more than it has, above
      // the next income of 5 + 5 = 10 (and a fresh capture cannot be deployed to this turn).
      expect(armiesToTake(2, STD)).toBe(3);
      expect(armiesToTake(12, STD)).toBe(20);
      expect(armiesToTake(13, STD)).toBe(21);
      const p = planTurn({ graph: g, board: at(16), me: ME, income: 5, settings: STD, options: { goal } });
      expect(attacks(p)).toEqual([]);
      expect(p.expected.bonusesCompleted).toEqual([]);
      expect(p.warnings).toContain(NOT_COMPLETED);
      // Warned once, however many passes looked at the capture.
      expect(p.warnings.filter((w) => w === NOT_COMPLETED)).toHaveLength(1);
      expect(p.rationale.join('\n')).toMatch(/Do not complete bonus B901 \(#901\)/);
      // The income garrisons the threatened T2 (holding needs 3) instead.
      expect(deployedTo(p, 2)).toBe(5);
      expect(deploySum(p)).toBe(5);
      expect(p.conceded).toEqual([]);
    });

  it('control: a defensible frontier still completes', () => {
    // T9 (4): threat 3 + 5 = 8; T3's 2 survivors need 6 to hold, 4 more: within the next income.
    for (const goal of ['balanced', 'defend'] as const) {
      const p = planTurn({ graph: g, board: at(4), me: ME, income: 5, settings: STD, options: { goal } });
      expect(p.expected.bonusesCompleted, goal).toEqual([901]);
      expect(attacks(p), goal).toEqual([expect.objectContaining({ from: 2, to: 3, armies: 3 })]);
      expect(p.warnings.join('\n'), goal).not.toMatch(/indefensible/);
    }
  });

  it('under expand the bonus is still completed, with a warning', () => {
    const p = planTurn({ graph: g, board: at(16), me: ME, income: 5, settings: STD, options: { goal: 'expand' } });
    expect(p.expected.bonusesCompleted).toEqual([901]);
    expect(p.warnings).toContain(
      'completing B901 (#901) leaves T3 (#3) indefensible (player 20 can take it for 3; next income 10): completed anyway (goal expand ignores defence)',
    );
  });

  it('discounts a completion by its defence cost, so a defensible smaller bonus wins', () => {
    // A = B911 (+5) = {1, 3}; B = B912 (+3) = {5, 6}. Each needs 3 deployed (sources at 1 army).
    // T3 borders the enemy T9 (7): threat 6 + 5 = 11, so T3's 2 survivors need 8 to hold —
    // 6 more, within the next income of 3 + 5 = 8 (defensible). Undiscounted A (5 / 3)
    // beats B (3 / 3); discounted, A is 5 / (3 + 6) and B wins the only 3 armies.
    const g2 = buildGraph(
      makeMap(
        [1, 3, 5, 6, 9],
        [
          [1, 3],
          [3, 9],
          [5, 6],
          [1, 5],
        ],
        [
          [911, 5, [1, 3]],
          [912, 3, [5, 6]],
        ],
      ),
    );
    const s = board([mine(1, 1), neutral(3, 2), mine(5, 1), neutral(6, 2), enemy(9, 7)]);
    expect(armiesToTake(7, STD)).toBe(11);
    expect(armiesToTake(8, STD)).toBe(13);
    const p = planTurn({ graph: g2, board: s, me: ME, income: 3, settings: STD });
    expect(p.expected.bonusesCompleted).toEqual([912]);
    expect(p.rationale.join('\n')).toMatch(/B911 \(#911\).*needs ~6 more armies next turn to hold its frontier/);
    // Under expand defence is ignored: the bigger bonus per army wins.
    const q = planTurn({ graph: g2, board: s, me: ME, income: 3, settings: STD, options: { goal: 'expand' } });
    expect(q.expected.bonusesCompleted).toEqual([911]);
  });

  it('a held border that would break its only threat just holds when that capture completes an indefensible bonus', () => {
    // My B950 (+3) = {1, 8}; the enemy's B951 (+2) = {8} is breakable. T8 (3) is T1's only
    // threat (2 movable + 7 = 9 — it holds the +2 — against T1's 3): holding T1 needs 3. Capturing
    // T8 would break B951 and complete B950, but T8 then faces T9 (30): indefensible.
    //   T1 ─ T8(enemy, B951) ─ T9(enemy 30)
    const g3 = buildGraph(
      makeMap(
        [1, 8, 9],
        [
          [1, 8],
          [8, 9],
        ],
        [
          [950, 3, [1, 8]],
          [951, 2, [8]],
        ],
      ),
    );
    const s = board([mine(1, 3), enemy(8, 3), enemy(9, 30)]);
    const p = planTurn({ graph: g3, board: s, me: ME, income: 10, settings: STD });
    expect(attacks(p)).toEqual([]);
    expect(p.expected.bonusesCompleted).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/completing B950 \(#950\) leaves T8 \(#8\) indefensible .*: not completed/);
    expect(p.rationale.join('\n')).toMatch(/Deploy 3 to T1 \(#1\) so it holds/);
    expect(p.conceded).toEqual([]);
    expect(deploySum(p)).toBe(10);
  });

  it('drops a "not completed" warning when a later pass does complete the bonus', () => {
    // B901 (+2) = {1, 3}; B902 (+6) = {5, 6}. Focused B901 is judged first, with the
    // next income at 2 + 2: T3 faces T9 and is refused. Completing B902 then raises
    // the next income to 2 + 2 + 6, so a later pass takes T3 after all. The plan
    // must not warn that B901 is "not completed" while it completes it.
    //   T1 ─ T3(neutral) ─ T9(enemy)      T5 ─ T6(neutral)
    const g4 = buildGraph(
      makeMap(
        [1, 3, 5, 6, 9],
        [
          [1, 3],
          [3, 9],
          [5, 6],
        ],
        [
          [901, 2, [1, 3]],
          [902, 6, [5, 6]],
        ],
      ),
    );
    for (const e of [6, 7, 8, 9]) {
      const s = board([mine(1, 10), neutral(3, 2), mine(5, 4), neutral(6, 2), enemy(9, e)]);
      const p = planTurn({
        graph: g4,
        board: s,
        me: ME,
        income: 2,
        settings: STD,
        options: { goal: 'balanced', focusBonusIds: [901] },
      });
      expect(p.expected.bonusesCompleted, `T9 ${e}`).toEqual([901, 902]);
      expect(p.warnings.join('\n'), `T9 ${e}`).not.toMatch(/B901 \(#901\).*not completed/);
      expect(p.rationale.join('\n'), `T9 ${e}`).not.toMatch(/Do not complete bonus B901/);
    }
  });
});

describe('planTurn — multi-source attacks (R4)', () => {
  // My stacks on T1, T2 (and T4) all border the neutral T3; nothing else is in reach.
  //   T1 ─ T3 ─ T2      T4 ─ T3
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4],
      [
        [1, 3],
        [2, 3],
        [4, 3],
      ],
      [],
    ),
  );

  it('takes a 15-army neutral with two 15-stacks that each fall short alone (issue #17 b)', () => {
    // One source: 14 movable + 5 income = 19 < 25. Two, at 0% luck: T2's 14 kill
    // round(8.4) = 8 (the attack fails; 14 − round(10.5) = 3 survive and stay home),
    // leaving 7, which T1 takes with 11 (round(6.6) = 7 kills; 11 − 5 = 6 move in).
    expect(armiesToTake(15, STD)).toBe(25);
    expect(armiesToTake(7, STD)).toBe(11);
    const s = board([mine(1, 15), mine(2, 15), neutral(3, 15)]);
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD });
    expect(attacks(p)).toEqual([
      expect.objectContaining({ from: 2, to: 3, armies: 14 }),
      expect.objectContaining({ from: 1, to: 3, armies: 11 }),
    ]);
    expect(p.expected.captures).toEqual([3]);
    expect(p.multiSourceCaptures).toEqual([3]);
    expect(deploySum(p)).toBe(5);
    expect(p.rationale.join('\n')).toMatch(/T3 \(#3\).*2 attacks/);
    // The attacks must run in this order.
    expect(p.warnings.join('\n')).toMatch(/T3 \(#3\).*in this order/);
  });

  for (const settings of [
    { ...STD, luckModifier: 0.16 },
    { ...STD, roundingMode: 'WeightedRandom' },
  ])
    it(`is not attempted, and warned, under ${settings.luckModifier ? 'luck' : 'weighted rounding'}`, () => {
      const s = board([mine(1, 15), mine(2, 15), neutral(3, 15)]);
      const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings });
      expect(attacks(p)).toEqual([]);
      expect(p.expected.captures).toEqual([]);
      const w = p.warnings.filter((x) => /multi-source/i.test(x));
      expect(w).toHaveLength(1);
      expect(w[0]).toMatch(/T3 \(#3\)/);
      expect(w[0]).toMatch(settings.luckModifier ? /luck/ : /rounding/);
      expect(deploySum(p)).toBe(5);
    });

  it('a combined capture rolled back with its bonus completion is not reported in multiSourceCaptures', () => {
    // Bonus 901 (+20) = {T3, T5}: completing it takes T3 (15) first by a combined
    // attack (T2 14, then T1 11), then needs T5 (20 → 33 armies) from T1's 3 left
    // + 5 income: the completion fails and is rolled back. Bonus 902 (+3) = {T6}
    // then takes T6 (8 → 13) from T1 (under expand, pass 1 completes before any
    // advance), so nothing re-takes T3 — it must not stay listed as a combined
    // capture with no attack on it.
    //   T1 ─ T3 ─ T2,  T1 ─ T5 ─ T2,  T1 ─ T6
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3, 5, 6],
        [
          [1, 3],
          [2, 3],
          [1, 5],
          [2, 5],
          [1, 6],
        ],
        [
          [901, 20, [3, 5]],
          [902, 3, [6]],
        ],
      ),
    );
    expect(armiesToTake(20, STD)).toBe(33);
    expect(armiesToTake(8, STD)).toBe(13);
    const s = board([mine(1, 15), mine(2, 15), neutral(3, 15), neutral(5, 20), neutral(6, 8)]);
    const p = planTurn({ graph: g2, board: s, me: ME, income: 5, settings: STD, options: { goal: 'expand' } });
    expect(attacks(p).filter((m) => m.to === 3)).toEqual([]);
    expect(p.expected.captures).not.toContain(3);
    expect(p.multiSourceCaptures).toEqual([]);
  });

  it('combines three sources when two are not enough', () => {
    // 25 defenders: T2 and T4 each kill 8 (two sources leave 17, needing 28 > 19);
    // three leave 9, which T1 takes with 15 (14 movable + 1 deployed).
    expect(armiesToTake(17, STD)).toBe(28);
    expect(armiesToTake(9, STD)).toBe(15);
    const s = board([mine(1, 15), mine(2, 15), neutral(3, 25), mine(4, 15)]);
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD });
    expect(attacks(p)).toEqual([
      expect.objectContaining({ from: 2, to: 3, armies: 14 }),
      expect.objectContaining({ from: 4, to: 3, armies: 14 }),
      expect.objectContaining({ from: 1, to: 3, armies: 15 }),
    ]);
    expect(p.expected.captures).toEqual([3]);
    expect(deploySum(p)).toBe(5);
    expect(deployedTo(p, 1)).toBeGreaterThanOrEqual(1);
  });

  it('plans nothing when even every source together cannot afford it', () => {
    // 40 defenders: two sources leave 32, needing 53 > 19.
    const s = board([mine(1, 15), mine(2, 15), neutral(3, 40)]);
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD });
    expect(attacks(p)).toEqual([]);
    expect(p.expected.captures).toEqual([]);
    expect(deploySum(p)).toBe(5);
  });

  it('is not used when one source suffices', () => {
    // T1's 24 movable + 1 deploy take 15 alone.
    const s = board([mine(1, 25), mine(2, 15), neutral(3, 15)]);
    const p = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD });
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 3, armies: 25 })]);
    expect(p.multiSourceCaptures).toEqual([]);
  });

  it('is not used for an uneconomic target', () => {
    // T3 is the only member of a +1 bonus: 25 armies for +1 is a wasteland (> 5 × 1).
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3],
        [
          [1, 3],
          [2, 3],
        ],
        [[901, 1, [3]]],
      ),
    );
    const s = board([mine(1, 15), mine(2, 15), neutral(3, 15)]);
    const p = planTurn({ graph: g2, board: s, me: ME, income: 5, settings: STD });
    // Holding 2 of the 3 territories is the late phase: #107's fallback may take it, combined.
    expect(p.profile.phase).toBe('late');
    expect(ruleAttacks(p)).toEqual([]);
  });

  it('completes a bonus with a combined capture', () => {
    // T3 alone is bonus B901 (+5): 25 ≤ 5 × 5, economic.
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3],
        [
          [1, 3],
          [2, 3],
        ],
        [[901, 5, [3]]],
      ),
    );
    const s = board([mine(1, 15), mine(2, 15), neutral(3, 15)]);
    for (const goal of ['balanced', 'expand', 'complete-bonus', 'defend'] as const) {
      const p = planTurn({ graph: g2, board: s, me: ME, income: 5, settings: STD, options: { goal } });
      expect(p.expected.bonusesCompleted, goal).toEqual([901]);
      expect(attacks(p).map((m) => [m.from, m.armies]), goal).toEqual([
        [2, 14],
        [1, 11],
      ]);
    }
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

  it('(g) a projected hold one army short is a near miss (#59): all 5 go there, nothing is conceded', () => {
    const p = planTurn({ ...base, income: 5, previousBoard: then, options: { goal: 'defend', enemyDeploy: 10 } });
    expect(p.conceded).toEqual([]);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(p.warnings.join('\n')).toMatch(/its 1 threatened border needs 6, only 5 left to deploy, so all 5 go there/);
    expect(p.warnings.join('\n')).not.toMatch(/cannot be held/);
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
      // Attacks per target, in order: one, or (R4) a combined capture.
      const attacksOn = new Map<number, number[]>();
      for (const m of p.moves) {
        expect(neighborsOf(g, m.from), ctx).toContain(m.to);
        expect(isMine(m.from), ctx).toBe(true); // nothing moves out of a fresh capture
        expect(m.armies, ctx).toBeGreaterThan(0);
        out.set(m.from, (out.get(m.from) ?? 0) + m.armies);
        if (m.kind === 'attack') {
          const t = byId.get(m.to)!;
          expect(t.armies, ctx).not.toBeNull();
          expect(isMine(m.to), ctx).toBe(false);
          attacksOn.set(m.to, [...(attacksOn.get(m.to) ?? []), m.armies]);
          captured.add(m.to);
        } else {
          expect(isMine(m.to) || captured.has(m.to), ctx).toBe(true);
        }
      }
      for (const [to, sent] of attacksOn) {
        const defenders = byId.get(to)!.armies!;
        if (sent.length === 1) {
          expect(sent[0], ctx).toBeGreaterThanOrEqual(captureCost(defenders, settings)!);
          continue;
        }
        // A combined capture: only at 0% luck; every attack but the last fails yet
        // kills, and the last takes what is left.
        expect(settings.luckModifier, ctx).toBe(0);
        let left = defenders;
        for (const a of sent.slice(0, -1)) {
          const kills = Math.round((a * settings.offensiveKillRate!) / 100);
          expect(kills, ctx).toBeGreaterThan(0);
          expect(kills, ctx).toBeLessThan(left);
          left -= kills;
        }
        expect(sent.at(-1)!, ctx).toBeGreaterThanOrEqual(armiesToTake(left, settings)!);
      }
      for (const [from, n] of out) {
        const dep = p.deploys.find((d) => d.territoryId === from)?.armies ?? 0;
        expect(n, ctx).toBeLessThanOrEqual(byId.get(from)!.armies! + dep - guard);
      }
      expect(p.expected.captures, ctx).toEqual([...captured].sort((a, b) => a - b));
      // multiSourceCaptures lists exactly the targets hit by a combined capture
      // (a rolled-back completion must not leave one behind).
      expect(p.multiSourceCaptures, ctx).toEqual(
        [...attacksOn].filter(([, sent]) => sent.length > 1).map(([t]) => t).sort((a, b) => a - b),
      );
    }
  });
});
