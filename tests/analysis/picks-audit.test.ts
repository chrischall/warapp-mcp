// Pick advisor audit (#129). Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph, type MapGraph } from '../../src/analysis/graph.js';
import { planPicks, type PickPlan, type PickSettings, type PlanPicksInput } from '../../src/analysis/picks.js';
import type { GameMap } from '../../src/normalize.js';

type Edge = [number, number];
type BonusSpec = { id: number; name: string; value: number; territoryIds: number[] };

function mkGraph(edges: Edge[], bonuses: BonusSpec[], extraIds: number[] = []): MapGraph {
  const ids = [...new Set([...edges.flat(), ...bonuses.flatMap((b) => b.territoryIds), ...extraIds])].sort((a, b) => a - b);
  const map: GameMap = {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map((b) => ({ ...b, bonusIds: [] })),
    distributionModes: [],
  };
  return buildGraph(map);
}

const STD: PickSettings = {
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  initialPlayerArmiesPerTerritory: 5,
  minimumArmyBonus: 5,
  initialNonDistributionArmies: 2,
  initialNeutralsInDistribution: 4,
  oneArmyStandsGuard: true,
  luckModifier: 0,
};

function plan(input: Partial<PlanPicksInput> & Pick<PlanPicksInput, 'graph' | 'pickable'>): PickPlan {
  return planPicks({ settings: STD, players: 2, territoryLimit: 1, maxPicks: 2, ...input });
}
const pick = (p: PickPlan, id: number) => p.picks.find((x) => x.territoryId === id)!;
const reasonsOf = (p: PickPlan, id: number) => pick(p, id).reasons.join(' | ');
const sorted = (ids: number[]) => [...ids].sort((a, b) => a - b);

describe('planPicks — the primary is the best-scoring group, not the best seed grown (#129)', () => {
  // Cluster A: the line 1-2-3; only 1 is a bonus (+4, alone). Cluster B: 11-21-12-22-13, with 11,
  // 12 and 13 each a +3 single-territory bonus. A corridor 3-4-5-6-7-8-11 joins them.
  const twoClusters = () =>
    mkGraph(
      [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 11], [11, 21], [21, 12], [12, 22], [22, 13]],
      [
        { id: 100, name: 'Solo', value: 4, territoryIds: [1] },
        { id: 201, name: 'TrioA', value: 3, territoryIds: [11] },
        { id: 202, name: 'TrioB', value: 3, territoryIds: [12] },
        { id: 203, name: 'TrioC', value: 3, territoryIds: [13] },
      ],
    );
  for (const players of [2, 4]) {
    it(`takes the three +3 singles over the +4 single grown into dead ground (${players} players)`, () => {
      const p = plan({ graph: twoClusters(), pickable: [1, 2, 3, 11, 12, 13], players, territoryLimit: 3, maxPicks: 6 });
      expect(sorted(p.groups.primary.territoryIds)).toEqual([11, 12, 13]);
      expect(p.groups.primary.score).toBeGreaterThan(p.groups.fallback.score);
      expect(p.warnings.join(' ')).not.toMatch(/fallback group scores more/);
    });
  }
});

describe('planPicks — the fallback is simulated with the primary taken by someone else (#129)', () => {
  it('a fallback next to the primary does not claim the bonus the primary shares', () => {
    // Line 1-2-3-4; Pair (+4) = {1,2}; limit 1. Primary [1]; the fallback 2 is only granted when
    // someone else holds 1, so Pair is not its first-turn bonus.
    const g = mkGraph([[1, 2], [2, 3], [3, 4]], [{ id: 100, name: 'Pair', value: 4, territoryIds: [1, 2] }]);
    const p = plan({ graph: g, pickable: [1, 2], territoryLimit: 1, maxPicks: 2 });
    expect(p.groups.primary.territoryIds).toEqual([1]);
    expect(p.groups.fallback.territoryIds).toEqual([2]);
    expect(p.groups.fallback.bonuses).toEqual([]);
    expect(reasonsOf(p, 2)).not.toMatch(/first-turn/);
    expect(pick(p, 2).score).toBeLessThan(pick(p, 1).score);
  });

  it('in a 1v1 the fallback moves to another area instead of sharing the primary’s bonus', () => {
    // Home (+5) = {1,2,3} with 1 and 2 pickable; Away (+3) = {11,12}, far off, with 11 pickable.
    const g = mkGraph(
      [[1, 2], [2, 3], [3, 30], [30, 31], [31, 32], [32, 11], [11, 12]],
      [
        { id: 100, name: 'Home', value: 5, territoryIds: [1, 2, 3] },
        { id: 101, name: 'Away', value: 3, territoryIds: [11, 12] },
      ],
    );
    const p = plan({ graph: g, pickable: [1, 2, 11], territoryLimit: 1, maxPicks: 2 });
    expect(p.groups.fallback.territoryIds).toEqual([11]);
  });
});

describe('planPicks — negative bonuses (#129)', () => {
  it('a pick that holds a negative bonus is charged for it and says so', () => {
    // Plus (+3) = {1,2}; Minus (−5) = {1} alone. Picking 1 nets −2 a turn; 2 is the better pick
    // (and does not capture 1 for Plus, since that also completes Minus).
    const g = mkGraph([[1, 2], [2, 3]], [
      { id: 100, name: 'Plus', value: 3, territoryIds: [1, 2] },
      { id: 101, name: 'Minus', value: -5, territoryIds: [1] },
    ]);
    const p = plan({ graph: g, pickable: [1, 2], territoryLimit: 1, maxPicks: 2 });
    expect(p.picks[0]!.territoryId).toBe(2);
    expect(pick(p, 1).score).toBeLessThan(0);
    expect(reasonsOf(p, 1)).toMatch(/Minus \(−5\)/);
    expect(reasonsOf(p, 2)).not.toMatch(/Plus[^|]*(first-turn|complete on)/);
  });

  it('a bonus worth more than the negative one it completes is still taken, net of the penalty', () => {
    // Big (+8) = {1,2}; Thorn (−2) = {2}. Taking 2 completes both: net +6 a turn.
    const g = mkGraph([[1, 2], [2, 3]], [
      { id: 100, name: 'Big', value: 8, territoryIds: [1, 2] },
      { id: 101, name: 'Thorn', value: -2, territoryIds: [2] },
    ]);
    const withThorn = plan({ graph: g, pickable: [1], territoryLimit: 1, maxPicks: 1 });
    expect(withThorn.groups.primary.bonuses.map((b) => b.name)).toContain('Big');
    expect(reasonsOf(withThorn, 1)).toMatch(/Thorn \(−2\)/);
    const g2 = mkGraph([[1, 2], [2, 3]], [{ id: 100, name: 'Big', value: 8, territoryIds: [1, 2] }]);
    const without = plan({ graph: g2, pickable: [1], territoryLimit: 1, maxPicks: 1 });
    expect(pick(withThorn, 1).score).toBeLessThan(pick(without, 1).score);
  });
});

describe('planPicks — the opening simulation does not park armies (#129)', () => {
  it('a bonus behind one neutral completes on turn 2, as by hand', () => {
    // Pick 1 borders only 2; 2 is the hub of 3, 4 and 5. Hub (+5) = {1,…,5}, neutrals of 2.
    // By hand: turn 1 everything (4 movable + 5 deployed) takes 2 and stands there; turn 2 those 8
    // movable + 5 deployed take 3, 4 and 5 (3 armies each).
    const g = mkGraph([[1, 2], [2, 3], [2, 4], [2, 5], [5, 9]], [{ id: 100, name: 'Hub', value: 5, territoryIds: [1, 2, 3, 4, 5] }]);
    const p = plan({ graph: g, pickable: [1], territoryLimit: 1, maxPicks: 1 });
    expect(p.groups.primary.bonuses).toEqual([{ bonusId: 100, name: 'Hub', value: 5, turn: 2 }]);
  });

  it('the deploys go where the attack is, not to the lowest id', () => {
    // The same position relabelled: the dead-end pick's id does not change the plan.
    const at = (dead: number) =>
      plan({
        graph: mkGraph(
          [[dead, 2], [50, 51], [51, 52], [51, 53], [51, 54], [2, 60]],
          [{ id: 100, name: 'Star', value: 6, territoryIds: [50, 51, 52, 53, 54] }],
        ),
        pickable: [dead, 50],
        territoryLimit: 2,
        maxPicks: 2,
      }).groups.primary.bonuses;
    expect(at(1)).toEqual(at(99));
    expect(at(1)[0]?.turn).toBe(2);
  });
});
