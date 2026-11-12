// G1 (issue #28): the planner sizes every combat computation at the game's own
// kill rates, never at a hard-coded 60/70. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { analyzePlayer } from '../../src/analysis/player.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { captureCost, planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const R20_80: PlannerSettings = { offensiveKillRate: 20, defensiveKillRate: 80, oneArmyStandsGuard: true };
const R30_75: PlannerSettings = { offensiveKillRate: 30, defensiveKillRate: 75, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
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

describe('kill rates — capture cost (G1)', () => {
  it('sizes neutrals and player territories at the given rates', () => {
    // armiesToTake(d) = max(ceil((100d − 50) / off), round(d · def / 100) + 1).
    // 20/80, 2 defenders: max(ceil(150 / 20) = 8, round(1.6) + 1 = 3) = 8 (60/70: 3).
    expect(armiesToTake(2, { offensiveKillRate: 20, defensiveKillRate: 80 })).toBe(8);
    expect(captureCost(2, R20_80)).toBe(8);
    expect(captureCost(2, STD)).toBe(3);
    // 30/75, 1 defender: max(ceil(50 / 30) = 2, round(0.75) + 1 = 2) = 2.
    expect(captureCost(1, R30_75)).toBe(2);
    // 30/75, 4 defenders: max(ceil(350 / 30) = 12, round(3) + 1 = 4) = 12 (60/70: 6).
    expect(captureCost(4, R30_75)).toBe(12);
    expect(captureCost(4, STD)).toBe(6);
  });
});

describe('planTurn — kill rates (G1)', () => {
  // T1 (mine) ─ T2 (neutral);  T1 ─ T3 (enemy).
  const g = buildGraph(
    makeMap(
      [1, 2, 3],
      [
        [1, 2],
        [1, 3],
      ],
    ),
  );

  it('at 60/70 a 2-army neutral costs 3 (today\'s plan)', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 10), neutral(2, 2)]), me: ME, income: 5, settings: STD, options: { goal: 'expand' } });
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 3 })]);
  });

  it('at 20/80 a 2-army neutral costs 8, and the plan sends 8', () => {
    // T1 has 9 movable: 8 go, 1 more stays (plus the guard).
    const p = planTurn({ graph: g, board: board([mine(1, 10), neutral(2, 2)]), me: ME, income: 5, settings: R20_80, options: { goal: 'expand' } });
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 8 })]);
    expect(p.expected.captures).toEqual([2]);
    expect(deploySum(p)).toBe(5);
    expect(p.rationale.join('\n')).toMatch(/Attack T2 \(#2\) from T1 \(#1\) with 8/);
  });

  it('at 20/80 the plan deploys the shortfall to afford the 8', () => {
    // 4 movable + 4 deployed = 8 is enough; the plan puts all 5 of its income on T1.
    const p = planTurn({ graph: g, board: board([mine(1, 5), neutral(2, 2)]), me: ME, income: 5, settings: R20_80, options: { goal: 'expand' } });
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 8 })]);
    expect(p.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
  });

  it('at 20/80 a 2-army neutral out of reach is not attacked (60/70 would)', () => {
    // 2 movable + 5 income = 7 < 8.
    const s = board([mine(1, 3), neutral(2, 2)]);
    expect(attacks(planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD, options: { goal: 'expand' } }))).toHaveLength(1);
    expect(attacks(planTurn({ graph: g, board: s, me: ME, income: 5, settings: R20_80, options: { goal: 'expand' } }))).toEqual([]);
  });

  it('the threat check against my border uses 20/80 too', () => {
    // Enemy T3: 10 armies (9 movable) + 5 deploy = 14. My T1 with 4:
    //  60/70: armiesToTake(4) = max(ceil(350 / 60) = 6, round(2.8) + 1 = 4) = 6 ≤ 14 → threatened;
    //  20/80: armiesToTake(4) = max(ceil(350 / 20) = 18, round(3.2) + 1 = 4) = 18 > 14 → safe.
    expect(armiesToTake(4, R20_80)).toBe(18);
    const s = board([mine(1, 4), enemy(3, 10)]);
    const std = planTurn({ graph: g, board: s, me: ME, income: 5, settings: STD, options: { enemyDeploy: 5 } });
    expect(std.warnings.join('\n')).toMatch(/T1 \(#1\) \(4 armies\) could be taken next turn: .*and 6 would do/);
    const low = planTurn({ graph: g, board: s, me: ME, income: 5, settings: R20_80, options: { enemyDeploy: 5 } });
    expect(low.warnings.join('\n')).not.toMatch(/could be taken next turn/);
    expect(low.conceded).toEqual([]);
  });

  it('a hold at 20/80 is sized at 20/80', () => {
    // Bonus B9 (+3) = {T1}; enemy T3 9 movable + 11 deploy = 20 threat. My T1 with 4:
    // armiesToTake(4) = 18 ≤ 20; one more army: armiesToTake(5) = ceil(450 / 20) = 23 > 20,
    // so the hold costs 1 (at 60/70 it would cost 9: armiesToTake(13) = 22 is the first above 20).
    const gb = buildGraph(makeMap([1, 2, 3], [[1, 2], [1, 3]], [[9, 3, [1]]]));
    expect(armiesToTake(5, R20_80)).toBe(23);
    const s = board([mine(1, 4), enemy(3, 10)]);
    const p = planTurn({ graph: gb, board: s, me: ME, income: 5, settings: R20_80, options: { goal: 'defend', enemyDeploy: 11 } });
    expect(p.rationale.join('\n')).toMatch(/Deploy 1 to T1 \(#1\) so it holds \(protects \+3\): 5 armies need 23 to take, above the ~20 threat/);
    const std = planTurn({ graph: gb, board: s, me: ME, income: 10, settings: STD, options: { goal: 'defend', enemyDeploy: 11 } });
    expect(std.rationale.join('\n')).toMatch(/Deploy 9 to T1 \(#1\) so it holds/);
  });

  it('at 30/75 a 1-army neutral is attacked with 2', () => {
    // 1 defender: max(ceil(50 / 30) = 2, round(0.75) + 1 = 2) = 2.
    const s = board([mine(1, 20), neutral(2, 1)]);
    const e = planTurn({ graph: g, board: s, me: ME, income: 5, settings: R30_75, options: { goal: 'expand' } });
    expect(attacks(e)).toEqual([expect.objectContaining({ from: 1, to: 2, armies: 2 })]);
  });

  it('at 30/75 a player territory completing my bonus is attacked with 12', () => {
    // Bonus B9 (+5) = {T1, T3}: complete-bonus attacks the enemy's 4 with 12.
    const gb = buildGraph(makeMap([1, 2, 3], [[1, 2], [1, 3]], [[9, 5, [1, 3]]]));
    const s = board([mine(1, 20), neutral(2, 1), enemy(3, 4)]);
    const p = planTurn({ graph: gb, board: s, me: ME, income: 5, settings: R30_75, options: { goal: 'complete-bonus' } });
    expect(attacks(p)).toContainEqual(expect.objectContaining({ from: 1, to: 3, armies: 12 }));
    const std = planTurn({ graph: gb, board: s, me: ME, income: 5, settings: STD, options: { goal: 'complete-bonus' } });
    expect(attacks(std)).toContainEqual(expect.objectContaining({ from: 1, to: 3, armies: 6 }));
  });

  it('under WeightedRandom rounding the plan keeps exact arithmetic and warns', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 10), neutral(2, 2)]),
      me: ME,
      income: 5,
      settings: { ...R20_80, roundingMode: 'WeightedRandom' },
      options: { goal: 'expand' },
    });
    expect(attacks(p)).toEqual([expect.objectContaining({ armies: 8 })]);
    expect(p.warnings.join('\n')).toMatch(/assume straight rounding; this game uses WeightedRandom/);
  });

  it('warns when the settings carry no kill rates (it then assumes 60/70)', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 10), neutral(2, 2)]), me: ME, income: 5, settings: {}, options: { goal: 'expand' } });
    expect(p.warnings.join('\n')).toMatch(/Kill rates missing from the game settings; assuming 60% offense, 70% defense/);
    expect(attacks(p)).toEqual([expect.objectContaining({ armies: 3 })]);
    const q = planTurn({ graph: g, board: board([mine(1, 10), neutral(2, 2)]), me: ME, income: 5, settings: R20_80, options: { goal: 'expand' } });
    expect(q.warnings.join('\n')).not.toMatch(/Kill rates missing/);
  });

  it('analyzePlayer reports armies needed at the game\'s rates, with the rounding assumption', () => {
    const gb = buildGraph(makeMap([1, 2, 3], [[1, 2], [1, 3]], [[9, 5, [1, 2]]]));
    const a = analyzePlayer(gb, board([mine(1, 5), neutral(2, 2)]), ME, {
      cards: [],
      raw: {},
      offensiveKillRate: 20,
      defensiveKillRate: 80,
      roundingMode: 'WeightedRandom',
    });
    expect(a.closestBonuses[0]!.missing[0]!.armiesToTake).toBe(8);
    expect(a.closestBonuses[0]!.armiesNeeded).toBe(8);
    expect(a.assumptions.join('\n')).toMatch(/WeightedRandom/);
  });
});

describe('planTurn — multi-source captures at non-default rates (G1, R4)', () => {
  //   T1 ─ T3 ─ T2
  const g = buildGraph(
    makeMap(
      [1, 2, 3],
      [
        [1, 3],
        [2, 3],
      ],
    ),
  );

  it('at 30/75: an 8-army neutral falls to T2 (14) then T1 (12)', () => {
    // Alone: armiesToTake(8) = max(ceil(750 / 30) = 25, round(6) + 1 = 7) = 25 > 14 + 5.
    // T2's 14 kill round(4.2) = 4, leaving 4 (14 − round(6) = 8 survive and stay home);
    // T1 takes 4 with armiesToTake(4) = 12 (no deploy needed); 12 − round(3) = 9 move in.
    expect(armiesToTake(8, R30_75)).toBe(25);
    expect(armiesToTake(4, R30_75)).toBe(12);
    const p = planTurn({ graph: g, board: board([mine(1, 15), mine(2, 15), neutral(3, 8)]), me: ME, income: 5, settings: R30_75 });
    expect(attacks(p)).toEqual([
      expect.objectContaining({ from: 2, to: 3, armies: 14 }),
      expect.objectContaining({ from: 1, to: 3, armies: 12 }),
    ]);
    expect(p.multiSourceCaptures).toEqual([3]);
    expect(deploySum(p)).toBe(5);
    // At 60/70 one source suffices: armiesToTake(8) = 13.
    const std = planTurn({ graph: g, board: board([mine(1, 15), mine(2, 15), neutral(3, 8)]), me: ME, income: 5, settings: STD });
    expect(attacks(std)).toEqual([expect.objectContaining({ to: 3, armies: 13 })]);
    expect(std.multiSourceCaptures).toEqual([]);
  });

  it('at 20/80: a 5-army neutral falls to T2 (14) then T1 (8)', () => {
    // Alone: armiesToTake(5) = max(ceil(450 / 20) = 23, round(4) + 1 = 5) = 23 > 19.
    // T2's 14 kill round(2.8) = 3, leaving 2; T1 takes 2 with armiesToTake(2) = 8.
    const p = planTurn({ graph: g, board: board([mine(1, 15), mine(2, 15), neutral(3, 5)]), me: ME, income: 5, settings: R20_80 });
    expect(attacks(p)).toEqual([
      expect.objectContaining({ from: 2, to: 3, armies: 14 }),
      expect.objectContaining({ from: 1, to: 3, armies: 8 }),
    ]);
    expect(p.expected.captures).toEqual([3]);
    expect(p.multiSourceCaptures).toEqual([3]);
  });
});
