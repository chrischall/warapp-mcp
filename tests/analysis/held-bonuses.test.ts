// Defending held bonuses before speculative expansion (#51). Two live cases in
// miniature, on synthetic maps (every id and name here is made up):
//  (a) income 14, a held +5 bonus whose one exposed border (1 army) faces an enemy
//      9-stack: the old plan spent everything on advances that completed nothing and
//      conceded the border ("needs 8, protects +5").
//  (b) income 9, a held +4 bonus with three threatened borders: the old plan funded
//      two (4 + 4) and conceded the third, which breaks the bonus anyway.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  PAYBACK_TURNS,
  planTurn,
  type PlanOptions,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Holds',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);

// ---- (a) one exposed border of a held +5 ----
//   Reef (+5): 1 2 3 — mine; 1 faces the enemy 9-stack on 10 (fog behind it at 11)
//   4, 5: mine, in no bonus; West (+4): 30 31 32, East (+4): 40 41 42 — 1-army neutrals,
//   32 and 42 out of reach, so no capture this turn completes either.
const MAP_A = makeMap(
  [1, 2, 3, 4, 5, 10, 11, 30, 31, 32, 40, 41, 42],
  [
    [1, 2], [2, 3], [1, 3], [1, 10], [10, 11],
    [3, 4], [3, 5],
    [4, 30], [4, 31], [30, 31], [31, 32],
    [5, 40], [5, 41], [40, 41], [41, 42],
  ],
  [
    [501, 'Reef', 5, [1, 2, 3]],
    [502, 'West', 4, [30, 31, 32]],
    [503, 'East', 4, [40, 41, 42]],
  ],
);
const gA = buildGraph(MAP_A);
const BOARD_A = board([
  mine(1, 1), mine(2, 1), mine(3, 1), mine(4, 1), mine(5, 1),
  enemy(10, 9), fogged(11),
  neutral(30, 1), neutral(31, 1), neutral(32, 1),
  neutral(40, 1), neutral(41, 1), neutral(42, 1),
]);
const planA = (income: number, options: PlanOptions = {}) =>
  planTurn({ graph: gA, board: BOARD_A, me: ME, income, settings: STD, options });

// ---- (b) three threatened borders of a held +4 ----
//   Keep (+4): 1 2 3 4 — mine; 1, 2, 3 (2 armies each) face enemy 4-stacks on 11, 12, 13
//   (fog behind them at 14); 4 is interior and borders the neutrals 20, 21 (Plain, +3).
const keepMap = (plainReach: boolean) =>
  makeMap(
    [1, 2, 3, 4, 11, 12, 13, 14, 20, 21],
    [
      [1, 2], [2, 3], [1, 4], [2, 4], [3, 4],
      [1, 11], [2, 12], [3, 13], [11, 14], [12, 14], [13, 14],
      [4, 20], [20, 21], ...(plainReach ? [[4, 21] as [number, number]] : []),
    ],
    [
      [601, 'Keep', 4, [1, 2, 3, 4]],
      [602, 'Plain', 3, [20, 21]],
    ],
  );
const BOARD_B: BoardState = board([
  mine(1, 2), mine(2, 2), mine(3, 2), mine(4, 1),
  enemy(11, 4), enemy(12, 4), enemy(13, 4), fogged(14),
  neutral(20, 1), neutral(21, 1),
]);
const planB = (income: number, options: PlanOptions = {}, plainReach = true) =>
  planTurn({ graph: buildGraph(keepMap(plainReach)), board: BOARD_B, me: ME, income, settings: STD, options });

describe('held bonuses are defended before speculative expansion (#51)', () => {
  it('the arithmetic by hand: 8 movable + ~5 deploy = 13; 9 armies need 15 to take, 8 need only 13', () => {
    expect(armiesToTake(9, STD)).toBe(15);
    expect(armiesToTake(8, STD)).toBe(13);
    // (b): 3 movable + ~5 = 8 against each border; 6 armies need 10, 5 need only 8.
    expect(armiesToTake(6, STD)).toBe(10);
    expect(armiesToTake(5, STD)).toBe(8);
  });

  it('(a) gives the +5 bonus its whole hold (8, exact) first; the leftover 6 funds expansion', () => {
    const p = planA(14);
    expect(p.conceded).toEqual([]);
    expect(p.deploys).toEqual([
      { territoryId: 1, armies: 8 },
      { territoryId: 4, armies: 4 },
      { territoryId: 5, armies: 2 },
    ]);
    expect(attacks(p).map((m) => m.to)).toEqual([30, 31, 40]);
    expect(p.warnings.join('\n')).not.toMatch(/conceded|conceding/);
    expect(p.rationale.join('\n')).toMatch(/Hold bonus Reef \(#501\) \(\+5\) whole: its 1 threatened border needs 8/);
  });

  it('(a) under defend: the same hold, and nothing is conceded', () => {
    const p = planA(14, { goal: 'defend' });
    expect(p.conceded).toEqual([]);
    expect(deployedTo(p, 1)).toBe(8);
    expect(deploySum(p)).toBe(14);
  });

  it('(a) under expand: the plan is unchanged (it ignores defence) but it warns', () => {
    const p = planA(14, { goal: 'expand' });
    // Every capture first (2 each from the 1-army sources), the leftover to the short border.
    expect(attacks(p).map((m) => m.to)).toEqual([30, 31, 40, 41]);
    expect(p.deploys).toEqual([
      { territoryId: 1, armies: 6 },
      { territoryId: 4, armies: 4 },
      { territoryId: 5, armies: 4 },
    ]);
    expect(p.warnings.join('\n')).toMatch(
      /goal expand does not defend held bonus Reef \(#501\) \(\+5\) first: holding its 1 threatened border needs 8/,
    );
  });

  it('(b) holds all three borders of the +4 bonus when the income affords them (4 + 4 + 4)', () => {
    // Plain is out of reach to complete (21 is not next to me): capturing 20 only advances it.
    const p = planB(14, {}, false);
    expect(p.conceded).toEqual([]);
    expect(deployedTo(p, 1)).toBe(4);
    expect(deployedTo(p, 2)).toBe(4);
    expect(deployedTo(p, 3)).toBe(4);
    expect(deploySum(p)).toBe(14);
    expect(attacks(p).map((m) => m.to)).toEqual([20]);
  });

  it('(b) under balanced, never concedes the +4 bonus to complete the smaller +3 when the income covers the hold', () => {
    // Completing Plain (+3 for 4) outscores the unit per army (0.75 against 4.6 / 12), but
    // completing it first leaves too little to hold Keep (+4): a net loss of 1 a turn.
    for (const income of [12, 13, 14, 15]) {
      const p = planB(income);
      expect(p.conceded, `income ${income}`).toEqual([]);
      // Each border gets at least its hold (a leftover may top one up).
      for (const t of [1, 2, 3]) expect(deployedTo(p, t), `income ${income}`).toBeGreaterThanOrEqual(4);
      expect(deploySum(p), `income ${income}`).toBe(income);
      expect(p.expected.bonusesCompleted, `income ${income}`).toEqual([]);
      expect(p.warnings.join('\n'), `income ${income}`).not.toMatch(/conceding/);
      expect(p.rationale.join('\n'), `income ${income}`).toMatch(
        /Complete bonus Plain \(#602\) \(\+3\) only after holding Keep \(#601\) \(\+4\)/,
      );
    }
    // With the hold and the completion both affordable, both happen.
    const both = planB(16);
    expect(both.conceded).toEqual([]);
    for (const t of [1, 2, 3]) expect(deployedTo(both, t)).toBe(4);
    expect(both.expected.bonusesCompleted).toEqual([602]);
  });

  it('(b) still completes a bonus worth more than the unit it starves', () => {
    // Plain at +5 earns more than Keep's +4: completing it is worth conceding Keep.
    const map = keepMap(true);
    map.bonuses = map.bonuses.map((b) => (b.id === 602 ? { ...b, value: 5 } : b));
    const p = planTurn({ graph: buildGraph(map), board: BOARD_B, me: ME, income: 12, settings: STD });
    expect(p.expected.bonusesCompleted).toEqual([602]);
    expect(p.conceded).toEqual([1, 2, 3]);
    expect(p.warnings.join('\n')).toMatch(/conceding bonus Keep \(#601\) \(\+4\)/);
  });

  it('(b) concedes the +4 bonus as a unit when its three borders are unaffordable: none is held, the income goes elsewhere', () => {
    const p = planB(9);
    expect(p.conceded).toEqual([1, 2, 3]);
    for (const t of [1, 2, 3]) expect(deployedTo(p, t)).toBe(0);
    expect(deploySum(p)).toBe(9);
    // Completing Plain (+3 for 4) outscores the unit, and the 5 left cannot hold all three.
    expect(p.expected.bonusesCompleted).toEqual([602]);
    expect(p.warnings.join('\n')).toMatch(
      /conceding bonus Keep \(#601\) \(\+4\): holding all 3 threatened borders \(T1 \(#1\), T2 \(#2\), T3 \(#3\)\) needs 12, more than the 5 armies left to deploy/,
    );
  });

  it('(b) under defend: all three or none, never two', () => {
    expect(planB(9, { goal: 'defend' }).conceded).toEqual([1, 2, 3]);
    const held = planB(12, { goal: 'defend' });
    expect(held.conceded).toEqual([]);
    for (const t of [1, 2, 3]) expect(deployedTo(held, t)).toBe(4);
  });

  it('concedes a unit that does not pay for itself (hold cost > PAYBACK_TURNS × value), even when each border alone would be held', () => {
    // Tiny (+1): 1 2 3 4, each 2 armies (5 is mine, in no bonus, next to a neutral) against an enemy 2-stack (1 movable + ~5 = 6):
    // each needs 3 (5 armies need 8 to take), and 3 ≤ 3 × (1 + 0.2) per border, but the
    // four together need 12 > 10 × 1.
    const map = makeMap(
      [1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 20],
      [
        [1, 2], [2, 3], [3, 4], [1, 5], [5, 20],
        [1, 11], [2, 12], [3, 13], [4, 14],
        [11, 15], [12, 15], [13, 15], [14, 15],
      ],
      [[701, 'Tiny', 1, [1, 2, 3, 4]]],
    );
    const b = board([
      mine(1, 2), mine(2, 2), mine(3, 2), mine(4, 2), mine(5, 3), neutral(20, 1),
      enemy(11, 2), enemy(12, 2), enemy(13, 2), enemy(14, 2), fogged(15),
    ]);
    const p = planTurn({ graph: buildGraph(map), board: b, me: ME, income: 20, settings: STD });
    expect(p.conceded).toEqual([1, 2, 3, 4]);
    for (const t of [1, 2, 3, 4]) expect(deployedTo(p, t)).toBe(0);
    expect(deployedTo(p, 5)).toBe(20);
    expect(p.warnings.join('\n')).toMatch(
      /conceding bonus Tiny \(#701\) \(\+1\): holding all 4 threatened borders .* needs 12, more than it pays back in 10 turns \(10 × \+1 = 10\)/,
    );
  });

  it('holds the same four borders once the bonus is worth enough to pay them back', () => {
    // Tiny at +4: 12 ≤ PAYBACK_TURNS × 4, and 12 ≤ CONCEDE_FACTOR × (4 + 8 / PAYBACK_TURNS).
    const map = makeMap(
      [1, 2, 3, 4, 5, 11, 12, 13, 14, 15, 20],
      [
        [1, 2], [2, 3], [3, 4], [1, 5], [5, 20],
        [1, 11], [2, 12], [3, 13], [4, 14],
        [11, 15], [12, 15], [13, 15], [14, 15],
      ],
      [[701, 'Tiny', 4, [1, 2, 3, 4]]],
    );
    const b = board([
      mine(1, 2), mine(2, 2), mine(3, 2), mine(4, 2), mine(5, 3), neutral(20, 1),
      enemy(11, 2), enemy(12, 2), enemy(13, 2), enemy(14, 2), fogged(15),
    ]);
    const p = planTurn({ graph: buildGraph(map), board: b, me: ME, income: 20, settings: STD });
    expect(12).toBeLessThanOrEqual(PAYBACK_TURNS * 4);
    expect(p.conceded).toEqual([]);
    for (const t of [1, 2, 3, 4]) expect(deployedTo(p, t)).toBe(3);
    expect(p.rationale.join('\n')).toMatch(/Hold bonus Tiny \(#701\) \(\+4\) whole: its 4 threatened borders need 12 in all/);
  });

  it('concedes a held bonus whose borders fail rule 1a\'s CONCEDE_FACTOR × worth test, even when it pays back', () => {
    // Reef (+5) of case (a), its border facing ~38 more: 31 ≤ PAYBACK_TURNS × 5, but
    // 31 > CONCEDE_FACTOR × (5 + 1 / PAYBACK_TURNS). The income covers it; it is not poured in.
    const p = planA(40, { enemyDeploy: 38 });
    expect(p.conceded).toEqual([1]);
    expect(deployedTo(p, 1)).toBe(0);
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) cannot be held economically \(needs \d+, protects \+5\): conceded/);
  });

  it('a border shared by two held bonuses is paid for once', () => {
    // North (+3): 1 2, South (+3): 2 3 — 2 is in both; 1 and 3 interior-ish, 2 faces the 9-stack.
    const map = makeMap(
      [1, 2, 3, 10, 11, 20],
      [[1, 2], [2, 3], [2, 10], [10, 11], [3, 20]],
      [
        [801, 'North', 3, [1, 2]],
        [802, 'South', 3, [2, 3]],
      ],
    );
    const b = board([mine(1, 1), mine(2, 1), mine(3, 1), enemy(10, 9), fogged(11), neutral(20, 1)]);
    const p = planTurn({ graph: buildGraph(map), board: b, me: ME, income: 10, settings: STD });
    expect(p.conceded).toEqual([]);
    expect(deployedTo(p, 2)).toBe(8);
    expect(deploySum(p)).toBe(10);
    // The second unit deploys nothing more for it, and says so.
    const why = p.rationale.join('\n');
    expect(why).toMatch(/Hold bonus North \(#801\) \(\+3\) whole: its 1 threatened border needs 8 in all/);
    expect(why).toMatch(/Hold bonus South \(#802\) \(\+3\) whole: its 1 threatened border is already held/);
  });

  describe('with Local Deployment', () => {
    // Case (a) plus Isle (+4) on 4 and 5: its pool may only be deployed on 4 and 5.
    const map = makeMap(MAP_A.territories.map((t) => t.id), [], []);
    map.territories = MAP_A.territories;
    map.bonuses = [...MAP_A.bonuses, { id: 504, name: 'Isle', value: 4, territoryIds: [4, 5], bonusIds: [] }];
    const g = buildGraph(map);
    const local = (income: number) =>
      planTurn({ graph: g, board: BOARD_A, me: ME, income, settings: { ...STD, localDeployments: true } });

    it('holds the unit when its border\'s room covers the hold (Reef pool 5 + anywhere)', () => {
      // Income 14: Reef 5 and Isle 4 pooled, 5 anywhere: T1 may take 10.
      const p = local(14);
      expect(p.conceded).toEqual([]);
      expect(deployedTo(p, 1)).toBe(8);
      expect(deploySum(p)).toBe(14);
    });

    it('concedes it when the room on the border is short, though the income is not', () => {
      // Income 9: Reef 5, Isle 4, 0 anywhere: T1 may take 5 < 8; Isle's 4 cannot help.
      // Short by 3, past the near-miss margin of 2 (#59), and 6 armies still fall to 13.
      const p = local(9);
      expect(p.conceded).toEqual([1]);
      expect(deployedTo(p, 1)).toBe(0);
      expect(deploySum(p)).toBe(9);
      expect(p.warnings).toContain('T1 (#1) cannot be held with the 5 armies left to deploy (needs 8, protects +5): conceded');
    });

    it('a room one or two short of the hold is a near miss (#59): all of it goes to the border', () => {
      // Income 10: Reef 5, Isle 4, 1 anywhere: T1 may take 6, 2 short of 8.
      const p = local(10);
      expect(p.conceded).toEqual([]);
      expect(deployedTo(p, 1)).toBe(6);
      expect(deploySum(p)).toBe(10);
      expect(p.warnings.join('\n')).toMatch(/Bonus Reef \(#501\) \(\+5\) is held though short: its 1 threatened border needs 8, only 6 left to deploy/);
    });

    it('rolls back a partly deployed unit: none of its borders keeps a deploy', () => {
      // Case (b) plus Moat (+5) on 30 31 (mine, quiet): income 12 pools Keep 4 and Moat 5,
      // with 3 anywhere. T1 takes 4 (Keep's pool), then T2 has room for only 3 < 4.
      const kmap = keepMap(false);
      kmap.territories = [
        ...kmap.territories.map((t) => (t.id === 4 ? { ...t, connectedTo: [...t.connectedTo, 30] } : t)),
        { id: 30, name: 'T30', connectedTo: [4, 31] },
        { id: 31, name: 'T31', connectedTo: [30] },
      ];
      kmap.bonuses = [...kmap.bonuses, { id: 603, name: 'Moat', value: 5, territoryIds: [30, 31], bonusIds: [] }];
      const kboard = board([...BOARD_B.territories, mine(30, 1), mine(31, 1)]);
      const run = (localDeployments: boolean) =>
        planTurn({ graph: buildGraph(kmap), board: kboard, me: ME, income: 12, settings: { ...STD, localDeployments } });
      // Without pools the 12 covers it.
      const plain = run(false);
      expect(plain.conceded).toEqual([]);
      for (const t of [1, 2, 3]) expect(deployedTo(plain, t)).toBe(4);
      const p = run(true);
      expect(p.conceded).toEqual([1, 2, 3]);
      for (const t of [1, 2, 3]) expect(deployedTo(p, t)).toBe(0);
      expect(deploySum(p)).toBe(12);
    });
  });

  describe('a unit member attacking its only threat on top of its hold', () => {
    // Twin (+5): 1 2 — mine. T1 (4) faces only T5 (2), a member of the enemy's complete
    // Den (+4): 5 6 7; T2 (1) faces T9 (2), in no bonus. Each threat is 1 movable + ~5 = 6:
    // T1 holds with 1 more (5 need 8), T2 with 4 more (5 need 8). Capturing T5 costs 3.
    const tmap = makeMap(
      [1, 2, 5, 6, 7, 9],
      [[1, 2], [1, 5], [5, 6], [6, 7], [2, 9]],
      [
        [901, 'Twin', 5, [1, 2]],
        [902, 'Den', 4, [5, 6, 7]],
      ],
    );
    const tg = buildGraph(tmap);
    const tboard = board([mine(1, 4), mine(2, 1), enemy(5, 2), enemy(6, 2), enemy(7, 2), enemy(9, 2)]);
    const twin = (income: number) => planTurn({ graph: tg, board: tboard, me: ME, income, settings: STD });

    it('breaks Den from T1 when the income covers both holds and the capture (1 + 3 + 4)', () => {
      const p = twin(8);
      expect(p.conceded).toEqual([]);
      expect(attacks(p).map((m) => [m.from, m.to])).toEqual([[1, 5]]);
      expect(deployedTo(p, 2)).toBe(4);
      expect(deploySum(p)).toBe(8);
    });

    it('just holds when the capture would eat the hold T2 still needs (7 < 8)', () => {
      const p = twin(7);
      expect(p.conceded).toEqual([]);
      expect(attacks(p).some((m) => m.from === 1)).toBe(false);
      expect(deployedTo(p, 1)).toBeGreaterThanOrEqual(1);
      expect(deployedTo(p, 2)).toBe(4);
      expect(deploySum(p)).toBe(7);
    });
  });
});
