// #126: sizing under luck and weighted-random rounding. Captures are sized with the exact combat
// model — certain where the plan claims certainty, 95% by default with luck on — holds so the
// assumed attack wins at most 5%, and min_win_chance applies to a bonus's captures together.
// Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { winChance } from '../../src/analysis/combat.js';
import {
  captureCost,
  combatSettings,
  defaultMinWinChance,
  planTurn,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const WR: PlannerSettings = { ...STD, roundingMode: 'WeightedRandom' };

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
const enemy = (territoryId: number, armies: number, playerId = 20): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const chanceIn = (settings: PlannerSettings) => (a: number, d: number) => winChance(a, d, combatSettings(settings));

describe('captureCost: certain means certain (#126)', () => {
  it('16% luck, straight rounding: 3v2, 5v3 and 7v4 are already certain', () => {
    const s = { ...STD, luckModifier: 0.16 };
    expect([2, 3, 4].map((d) => captureCost(d, s))).toEqual([3, 5, 7]);
  });

  it('weighted-random rounding at 0% luck: one army more than the straight size makes it certain', () => {
    expect([2, 4, 10, 11].map((d) => captureCost(d, WR))).toEqual([4, 7, 17, 19]);
    // The straight sizes are only chances there.
    const p = chanceIn(WR);
    expect(p(3, 2)).toBeCloseTo(0.8, 12);
    expect(p(6, 4)).toBeCloseTo(0.6, 12);
  });

  it('is the fewest armies whose win chance is exactly 1, at any luck and rounding', () => {
    for (const luck of [0, 0.05, 0.16, 0.5, 0.75, 1])
      for (const roundingMode of ['StraightRound', 'WeightedRandom'])
        for (let d = 1; d <= 12; d++) {
          const s: PlannerSettings = { ...STD, luckModifier: luck, roundingMode };
          const c = captureCost(d, s)!;
          expect(chanceIn(s)(c, d), `${luck} ${roundingMode} ${d}`).toBe(1);
          expect(chanceIn(s)(c - 1, d), `${luck} ${roundingMode} ${d}`).toBeLessThan(1);
        }
  });

  it('defaults to 95% with luck on, certainty without', () => {
    expect(defaultMinWinChance(STD)).toBe(1);
    expect(defaultMinWinChance(WR)).toBe(1);
    expect(defaultMinWinChance({ ...STD, luckModifier: 0.16 })).toBe(0.95);
    expect(defaultMinWinChance({ ...STD, luckModifier: 75 })).toBe(0.95);
  });
});

describe('planned captures under luck (#126)', () => {
  // T1 (mine) borders T2, T3, T4 (neutral 2 each); all four make one +4 bonus.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4],
      [
        [1, 2],
        [1, 3],
        [1, 4],
      ],
      [[901, 4, [1, 2, 3, 4]]],
    ),
  );

  it('75% luck, weighted rounding: the opening attacks instead of standing still', () => {
    const s: PlannerSettings = { ...STD, luckModifier: 0.75, roundingMode: 'WeightedRandom' };
    const p = planTurn({
      graph: g,
      board: board([mine(1, 5), neutral(2, 2), neutral(3, 2), neutral(4, 2)]),
      me: ME,
      income: 5,
      settings: s,
    });
    expect(attacks(p).length).toBeGreaterThan(0);
    for (const m of attacks(p)) expect(m.winChance).toBeGreaterThanOrEqual(0.95);
    expect(p.warnings.join('\n')).toMatch(/Luck is 75%: each capture is sized for at least a 95% win chance/);
  });

  it('min_win_chance applies to a completion as a whole, not to each capture', () => {
    // 50% luck: 3 armies take 2 defenders 64.8% of the time, 4 armies 97.44%. Three captures at
    // 64.8% each would complete the bonus 27% of the time; at 0.6^(1/3) ≈ 84.3% each, 92.5%.
    const s: PlannerSettings = { ...STD, luckModifier: 0.5 };
    const p = planTurn({
      graph: g,
      board: board([mine(1, 8), neutral(2, 2), neutral(3, 2), neutral(4, 2)]),
      me: ME,
      income: 5,
      settings: s,
      options: { minWinChance: 0.6, goal: 'expand' },
    });
    expect(p.expected.bonusesCompleted).toEqual([901]);
    const joint = attacks(p).reduce((x, m) => x * m.winChance!, 1);
    expect(attacks(p).map((m) => m.armies)).toEqual([4, 4, 4]);
    expect(joint).toBeGreaterThanOrEqual(0.6);
    expect(p.rationale.join('\n')).toMatch(/B901 \(#901\) \(\+4\) completes with a \d+(\.\d)?% chance/);
  });
});

describe('finishing a player off is certain where the plan says so (#126)', () => {
  it('weighted rounding: "even if it reinforces" is a win chance of 1 against the reinforced stack', () => {
    const g = buildGraph(makeMap([1, 2, 5, 6], [[1, 2], [5, 6]]));
    const p = planTurn({
      graph: g,
      board: board([mine(1, 40), enemy(2, 6), enemy(5, 5, 21), enemy(6, 5, 21)]),
      me: ME,
      income: 5,
      settings: WR,
      options: { enemyDeploy: 5 },
      game: { players: [{ id: ME }, { id: 20 }, { id: 21 }], turn: 12, fog: 'NoFog' },
    });
    const hit = attacks(p).find((m) => m.to === 2)!;
    expect(hit).toBeDefined();
    expect(chanceIn(WR)(hit.armies, 6 + 5)).toBe(1);
  });
});

describe('holds carry a margin under luck (#126)', () => {
  // T1 (1) – T2 (4) are my +3; T3 (enemy 5) – T4 (enemy 1).
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4],
      [
        [1, 2],
        [2, 3],
        [3, 4],
      ],
      [[911, 3, [1, 2]]],
    ),
  );
  for (const [name, s] of [
    ['weighted rounding', WR],
    ['16% luck', { ...STD, luckModifier: 0.16 }],
    ['16% luck, weighted rounding', { ...WR, luckModifier: 0.16 }],
  ] as const) {
    it(`${name}: the threat it is held against wins at most 5%`, () => {
      const p = planTurn({
        graph: g,
        board: board([mine(1, 1), mine(2, 4), enemy(3, 5), enemy(4, 1)]),
        me: ME,
        income: 8,
        settings: s,
        options: { goal: 'defend', reserve: 0, enemyDeploy: 5 },
        game: { players: [{ id: ME }, { id: 20 }], turn: 9 },
      });
      const line = p.rationale.find((r) => r.includes('so it holds'));
      expect(line).toBeDefined();
      const m = line!.match(/: (\d+) armies need (\d+) to take, above the ~(\d+) threat/)!;
      expect(m).not.toBeNull();
      const [have, threat] = [Number(m[1]), Number(m[3])];
      expect(chanceIn(s)(threat, have)).toBeLessThanOrEqual(0.05);
      expect(chanceIn(s)(Number(m[2]), have)).toBeGreaterThan(0.05);
      expect(p.rationale.join('\n')).toMatch(/Holds are sized so the attack assumed wins at most 5%/);
    });
  }
  it('at 0% luck under straight rounding nothing changes: the hold is exact', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 1), mine(2, 4), enemy(3, 5), enemy(4, 1)]),
      me: ME,
      income: 8,
      settings: STD,
      options: { goal: 'defend', reserve: 0, enemyDeploy: 5 },
      game: { players: [{ id: ME }, { id: 20 }], turn: 9 },
    });
    expect(p.rationale.join('\n')).not.toMatch(/Holds are sized so/);
  });
});
