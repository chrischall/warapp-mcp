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

  it('at luck > 0 the default sizes for 95%: 3 armies already take 2 for sure at 16% (#126)', () => {
    // The old margin, ceil(3 / 0.84) = 4, sent an army that adds no kill.
    const p = planTurn({
      graph: g,
      board: board([mine(1, 1), neutral(2, 2)]),
      me: ME,
      income: 4,
      settings: { ...STD, luckModifier: 0.16 },
      options: { goal: 'expand' },
    });
    expect(attacks(p)).toEqual([expect.objectContaining({ to: 2, armies: 3, winChance: 1 })]);
    expect(p.warnings.join('\n')).toMatch(/Luck is 16%: each capture is sized for at least a 95% win chance \(min_win_chance, 95% by default with luck on\)/);
  });

  it('under weighted-random rounding the size is certain under it, not the straight size (#126)', () => {
    // 3 vs 2 at 0% luck: 1.8 kills round up to 2 only 80% of the time; 4 (2.4, floor 2) is certain.
    const p = planTurn({
      graph: g,
      board: board([mine(1, 1), neutral(2, 2)]),
      me: ME,
      income: 4,
      settings: { ...STD, roundingMode: 'WeightedRandom' },
      options: { goal: 'expand' },
    });
    expect(attacks(p)).toEqual([expect.objectContaining({ to: 2, armies: 4, winChance: 1 })]);
    expect(p.warnings.join('\n')).toMatch(/This game uses WeightedRandom rounding: capture and hold sizes are computed under it/);
  });
});

describe('minWinChance (S2)', () => {
  const luck50: PlannerSettings = { ...STD, luckModifier: 0.5 };

  it('captureCost: the fewest armies reaching the chance', () => {
    // Luck 50%, 2 defenders: 3 armies win 0.648, 4 win 0.9744 (see combat-luck.test.ts), 5 are certain.
    expect(captureCost(2, luck50)).toBe(5);
    expect(captureCost(2, luck50, 0.9)).toBe(4);
    expect(captureCost(2, luck50, 0.6)).toBe(3);
    // 0% luck, straight: chances are 0 or 1, so any minimum gives the guaranteed size.
    expect(captureCost(2, STD, 0.5)).toBe(captureCost(2, STD));
  });

  it('0.9 sizes smaller than certainty', () => {
    const input = { graph: g, board: board([mine(1, 1), neutral(2, 2)]), me: ME, income: 4, settings: luck50, options: { goal: 'expand' as const } };
    // Certain: 5 needed, 4 available — no attack.
    expect(attacks(planTurn({ ...input, options: { ...input.options, minWinChance: 1 } }))).toEqual([]);
    const p = planTurn({ ...input, options: { ...input.options, minWinChance: 0.9 } });
    expect(attacks(p)).toEqual([expect.objectContaining({ to: 2, armies: 4 })]);
    expect(attacks(p)[0]!.winChance).toBeCloseTo(0.9744, 12);
    expect(why(p)).toMatch(/sized for at least a 90% win chance/);
    expect(p.warnings.join('\n')).toMatch(/Luck is 50%: each capture is sized for at least a 90% win chance/);
  });

  it('defaults to 1 without luck and to 0.95 with it (#126)', () => {
    for (const [settings, chance] of [
      [STD, 1],
      [{ ...STD, roundingMode: 'WeightedRandom' }, 1],
      [luck50, 0.95],
    ] as const) {
      const input = { graph: g, board: board([mine(1, 6), neutral(2, 2), enemy(3, 3)]), me: ME, income: 5, settings };
      const [given, dflt] = [planTurn({ ...input, options: { minWinChance: chance } }), planTurn(input)];
      expect([given.deploys, given.moves]).toEqual([dflt.deploys, dflt.moves]);
    }
  });
});

describe('efficient sizes: top-ups only from idle armies (S2)', () => {
  // Weighted rounding: 3 vs 2 wins 80%; 4 (2.4 kills, floor 2) is the next efficient size and certain.
  // Sized for 80% (min_win_chance 0.8) so the capture starts at 3: certain by default (#126).
  const W: PlannerSettings = { ...STD, roundingMode: 'WeightedRandom' };
  const at80 = { goal: 'expand' as const, minWinChance: 0.8 };

  it('tops up from armies that would sit idle', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 6), neutral(2, 2), neutral(3, 9)]), me: ME, income: 5, settings: W, options: at80 });
    expect(attacks(p)).toEqual([expect.objectContaining({ to: 2, armies: 4, winChance: 1 })]);
    expect(why(p)).toMatch(/Top up the attack on T2 \(#2\) from T1 \(#1\) from 3 to 4 with 1 idle armies there.*80% to 100%/);
  });

  it('never from a border still facing an enemy', () => {
    const p = planTurn({ graph: g, board: board([mine(1, 6), neutral(2, 2), enemy(3, 6)]), me: ME, income: 5, settings: W, options: at80 });
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
    // T6 (2): 1 movable + 5 deploy = 6 still retakes 4 survivors, and the warning says 4.
    // (enemyDeploy pinned at 5: the holder of the +4 is estimated at 9; the top-up is the subject.)
    const pin = { enemyDeploy: 5 };
    const p = planTurn({ graph: eMap, board: board([mine(1, 5), enemy(5, 2), enemy(6, 2), enemy(7, 2)]), me: ME, income: 5, settings: STD, options: pin });
    expect(attacks(p).map((m) => [m.to, m.armies])).toEqual([[5, 5]]);
    expect(p.warnings.join('\n')).toMatch(/T5 \(#5\) can be retaken after it breaks B811 \(#811\): 4 survivors need 6 to take, against ~6 next turn/);
    // T6 (1): 0 movable + ~5 = 5 retakes 2 survivors but not 4: no warning once topped up.
    const q = planTurn({ graph: eMap, board: board([mine(1, 5), enemy(5, 2), enemy(6, 1), enemy(7, 2)]), me: ME, income: 5, settings: STD, options: pin });
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
    const p = planTurn({
      graph: g2,
      board: board([mine(1, 4), enemy(5, 2), enemy(6, 2), enemy(7, 2)]),
      me: ME,
      income: 5,
      settings: STD,
      // Pinned at 5 (the holder of the +4 is estimated at 9): the hold lock is the subject.
      options: { enemyDeploy: 5 },
    });
    expect(why(p)).toMatch(/T5 \(#5\) is the only visible threat to T1 \(#1\)/);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([[1, 5, 3]]);
    expect(why(p)).not.toMatch(/Top up/);
  });
});
