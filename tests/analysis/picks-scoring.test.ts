// Pick scoring (#166): double borders, who can reach a bonus, two orders for one capture, and a
// two-player fallback that answers the loss granting it. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { entryTouches } from '../../src/analysis/bonuses.js';
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
  initialNeutralsInDistribution: 2,
  oneArmyStandsGuard: true,
  luckModifier: 0,
};

function plan(input: Partial<PlanPicksInput> & Pick<PlanPicksInput, 'graph' | 'pickable'>): PickPlan {
  return planPicks({ settings: STD, players: 2, territoryLimit: 1, maxPicks: 2, ...input });
}
const pick = (p: PickPlan, id: number) => p.picks.find((x) => x.territoryId === id)!;
const scoreOf = (p: PickPlan, id: number) => pick(p, id).score;
const reasonsOf = (p: PickPlan, id: number) => pick(p, id).reasons.join(' | ');

describe('planPicks — a double border weighs more than a single one (#166)', () => {
  // Flat (+3) = {1,2}: entry points 50 (next to 1) and 51 (next to 2).
  // Pinch (+3) = {3,4}: entry points 60 (next to 3 AND 4) and 61 (next to 4).
  // Both have two entry points; the two bonuses are not connected, so nothing reaches either.
  const g = () =>
    mkGraph(
      [[1, 2], [1, 50], [2, 51], [3, 4], [3, 60], [4, 60], [4, 61]],
      [
        { id: 101, name: 'Flat', value: 3, territoryIds: [1, 2] },
        { id: 102, name: 'Pinch', value: 3, territoryIds: [3, 4] },
      ],
    );

  it('entryTouches counts, per entry point, the members it borders', () => {
    expect([...entryTouches(g(), 101)]).toEqual([[50, 1], [51, 1]]);
    expect([...entryTouches(g(), 102)]).toEqual([[60, 2], [61, 1]]);
    expect([...entryTouches(g(), 999)]).toEqual([]);
  });

  it('with the same entry points, the bonus without a double border scores more', () => {
    const p = plan({ graph: g(), pickable: [1, 3] });
    expect(scoreOf(p, 1)).toBeGreaterThan(scoreOf(p, 3));
    expect(p.picks[0]!.territoryId).toBe(1);
    // A first-turn +3 pays 3 turns; in a 1v1 each unit of exposure costs 0.1 at 60/70.
    // Flat: exposure 2, as before the change (9 / 1.2). Pinch: exposure 3 (9 / 1.3).
    expect(scoreOf(p, 1)).toBe(7.5);
    expect(scoreOf(p, 3)).toBe(6.92);
  });

  it('the reason line names the double border and how many members it touches', () => {
    const p = plan({ graph: g(), pickable: [1, 3] });
    expect(reasonsOf(p, 3)).toContain('2 entry points, 1 a double border (T60 touches 2 of its territories)');
    expect(reasonsOf(p, 1)).toContain('2 entry points');
    expect(reasonsOf(p, 1)).not.toMatch(/double border/);
  });

  it('several double borders are counted, and listed three at most', () => {
    // Wide (+4) = {1,2,3}; 50, 51, 52 and 53 each touch two or three of them.
    const wide = mkGraph(
      [[1, 2], [2, 3], [50, 1], [50, 2], [51, 2], [51, 3], [52, 1], [52, 2], [52, 3], [53, 1], [53, 3], [54, 3]],
      [{ id: 101, name: 'Wide', value: 4, territoryIds: [1, 2, 3] }],
    );
    const p = plan({ graph: wide, pickable: [1], maxPicks: 1 });
    expect(reasonsOf(p, 1)).toContain(
      '5 entry points, 4 double borders (T50 touches 2 of its territories, T51 touches 2, T52 touches 3 and 1 more)',
    );
  });
});
