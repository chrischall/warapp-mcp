// S2 in the planner: every attack carries its exact win chance, `minWinChance` sizes captures
// below a guarantee, idle armies top an attack up to its next efficient size, and an attack
// between breakpoints is named. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { captureCost, planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

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
const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: 20 },
  armies,
});
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const why = (p: TurnPlan) => p.rationale.join('\n');

// T1 (mine) ─ T2 (neutral);  T1 ─ T3.
const g = buildGraph(makeMap([1, 2, 3], [[1, 2], [1, 3]]));

describe('winChance on every planned attack (S2)', () => {
  it('is 1 at 0% luck under straight rounding', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 4), neutral(2, 2), neutral(3, 2)]), me: ME, income: 5, settings: STD });
    expect(attacks(p).length).toBeGreaterThan(0);
    for (const m of attacks(p)) expect(m.winChance).toBe(1);
    for (const m of p.moves.filter((x) => x.kind === 'transfer')) expect(m.winChance).toBeUndefined();
  });

  it('the guaranteed-margin size wins for sure at luck > 0 (and the plan names the waste)', () => {
    // Luck 16%: 2 defenders cost ceil(3 / 0.84) = 4, but 3 already kill round(0.84·1.8) = 2 for sure.
    const p = planTurn({
      graph: g,
      board: board([mine(1, 1), neutral(2, 2)]),
      me: ME,
      income: 4,
      settings: { ...STD, luckModifier: 0.16 },
      options: { goal: 'expand' },
    });
    expect(attacks(p)).toEqual([expect.objectContaining({ to: 2, armies: 4, winChance: 1 })]);
    expect(why(p)).toMatch(/The attack on T2 \(#2\) from T1 \(#1\) sends 4, but 3 already kill 2 for sure: the other 1 add no kill/);
    expect(p.warnings.join('\n')).toMatch(/win chance 1 under straight rounding/);
  });

  it('under weighted-random rounding the chance is computed, not just warned about', () => {
    // 3 vs 2 at 0% luck: 1.8 kills round up to 2 with p 0.8. No idle armies to top up with.
    const p = planTurn({
      graph: g,
      board: board([mine(1, 1), neutral(2, 2)]),
      me: ME,
      income: 3,
      settings: { ...STD, roundingMode: 'WeightedRandom' },
      options: { goal: 'expand' },
    });
    expect(attacks(p)).toHaveLength(1);
    expect(attacks(p)[0]!.armies).toBe(3);
    expect(attacks(p)[0]!.winChance).toBeCloseTo(0.8, 12);
    expect(p.warnings.join('\n')).toMatch(/WeightedRandom: each attack's winChance is computed under it/);
  });
});

describe('minWinChance (S2)', () => {
  const luck50: PlannerSettings = { ...STD, luckModifier: 0.5 };

  it('captureCost: the fewest armies reaching the chance', () => {
    // Luck 50%, 2 defenders: 3 armies win 0.648, 4 win 0.9744 (see combat-luck.test.ts), the margin is 6.
    expect(captureCost(2, luck50)).toBe(6);
    expect(captureCost(2, luck50, 0.9)).toBe(4);
    expect(captureCost(2, luck50, 0.6)).toBe(3);
    // 0% luck, straight: chances are 0 or 1, so any minimum gives the guaranteed size.
    expect(captureCost(2, STD, 0.5)).toBe(captureCost(2, STD));
  });

  it('0.9 sizes smaller than the default', () => {
    const input = { graph: g, board: board([mine(1, 1), neutral(2, 2)]), me: ME, income: 4, settings: luck50, options: { goal: 'expand' as const } };
    // Default: 6 needed, 4 available — no attack.
    expect(attacks(planTurn(input))).toEqual([]);
    const p = planTurn({ ...input, options: { ...input.options, minWinChance: 0.9 } });
    expect(attacks(p)).toEqual([expect.objectContaining({ to: 2, armies: 4 })]);
    expect(attacks(p)[0]!.winChance).toBeCloseTo(0.9744, 12);
    expect(why(p)).toMatch(/sized for at least a 90% win chance/);
    expect(p.warnings.join('\n')).toMatch(/Luck is 50%: each capture is sized for at least a 90% win chance/);
  });

  it('default 1 leaves plans unchanged', () => {
    for (const settings of [STD, luck50, { ...STD, roundingMode: 'WeightedRandom' }]) {
      const input = { graph: g, board: board([mine(1, 6), neutral(2, 2), enemy(3, 3)]), me: ME, income: 5, settings };
      expect(planTurn({ ...input, options: { minWinChance: 1 } })).toEqual(planTurn(input));
    }
  });
});

describe('efficient sizes: top-ups only from idle armies (S2)', () => {
  // Weighted rounding: 3 vs 2 wins 80%; 4 (2.4 kills, floor 2) is the next efficient size and certain.
  const W: PlannerSettings = { ...STD, roundingMode: 'WeightedRandom' };

  it('tops up from armies that would sit idle', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 6), neutral(2, 2), neutral(3, 9)]), me: ME, income: 5, settings: W, options: { goal: 'expand' } });
    expect(attacks(p)).toEqual([expect.objectContaining({ to: 2, armies: 4, winChance: 1 })]);
    expect(why(p)).toMatch(/Top up the attack on T2 \(#2\) from T1 \(#1\) from 3 to 4 with 1 idle armies there.*80% to 100%/);
  });

  it('never from a border still facing an enemy', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 6), neutral(2, 2), enemy(3, 6)]), me: ME, income: 5, settings: W, options: { goal: 'expand' } });
    expect(attacks(p)).toEqual([expect.objectContaining({ to: 2, armies: 3 })]);
    expect(why(p)).not.toMatch(/Top up/);
  });

  it('never for a certain capture of a neutral (the extra kill gains nothing)', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 6), neutral(2, 2), neutral(3, 9)]), me: ME, income: 5, settings: STD, options: { goal: 'expand' } });
    expect(attacks(p)).toEqual([expect.objectContaining({ to: 2, armies: 3, winChance: 1 })]);
    expect(why(p)).not.toMatch(/Top up/);
  });
});

describe('top-ups and what they change (S2)', () => {
  // T1 (5) borders T5 (2), one of the enemy's complete +4 {T5, T6, T7}; T6 is next to T5.
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

  it('a retake warning is judged on the topped-up survivors', () => {
    // The break costs 3 and leaves 2 survivors (3 take them); topped up to 5 it leaves 4 (6 take them).
    // T6 (2): 1 movable + ~5 deploy = 6 still retakes 4 survivors, and the warning says 4.
    const p = planTurn({ graph: eMap, board: board([mine(1, 5), enemy(5, 2), enemy(6, 2), enemy(7, 2)]), me: ME, income: 5, settings: STD });
    expect(attacks(p).map((m) => [m.to, m.armies])).toEqual([[5, 5]]);
    expect(p.warnings.join('\n')).toMatch(/T5 \(#5\) can be retaken after it breaks B811 \(#811\): 4 survivors need 6 to take, against ~6 next turn/);
    // T6 (1): 0 movable + ~5 = 5 retakes 2 survivors but not 4: no warning once topped up.
    const q = planTurn({ graph: eMap, board: board([mine(1, 5), enemy(5, 2), enemy(6, 1), enemy(7, 2)]), me: ME, income: 5, settings: STD });
    expect(attacks(q).map((m) => [m.to, m.armies])).toEqual([[5, 5]]);
    expect(q.warnings.join('\n')).not.toMatch(/retaken/);
  });

  it('never tops up from a hold-locked source, even once its captures leave it facing no enemy', () => {
    // T1 is a held +5 whose only threat is T5, a member of the enemy's complete +4. It holds and
    // breaks T5 with 3; after the capture T1 borders no enemy, but what it keeps is its hold.
    const g2 = buildGraph(
      makeMap(
        [1, 5, 6, 7],
        [
          [1, 5],
          [5, 6],
          [6, 7],
        ],
        [
          [831, 5, [1]],
          [833, 4, [5, 6, 7]],
        ],
      ),
    );
    const p = planTurn({ graph: g2, board: board([mine(1, 4), enemy(5, 2), enemy(6, 2), enemy(7, 2)]), me: ME, income: 5, settings: STD });
    expect(why(p)).toMatch(/T5 \(#5\) is the only visible threat to T1 \(#1\)/);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[1, 5, 3]]);
    expect(why(p)).not.toMatch(/Top up/);
  });
});
