// Coverage of a pick set, and the coverage-first alternative list (#166). Every map, id and name
// here is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph, distance, type MapGraph } from '../../src/analysis/graph.js';
import { COMPACT_DISTANCE, coverage, planPicks, type PickSettings, type PlanPicksInput } from '../../src/analysis/picks.js';
import type { GameMap } from '../../src/normalize.js';

type Edge = [number, number];
type BonusSpec = { id: number; name: string; value: number; territoryIds: number[]; bonusIds?: number[] };

function mkGraph(edges: Edge[], bonuses: BonusSpec[]): MapGraph {
  const ids = [...new Set([...edges.flat(), ...bonuses.flatMap((b) => b.territoryIds)])].sort((a, b) => a - b);
  const map: GameMap = {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map((b) => ({ bonusIds: [], ...b })),
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
};

const path = (ids: number[]): Edge[] => ids.slice(1).map((t, i) => [ids[i]!, t]);

// Two regions joined by a long neutral road. West: W1 {1,2}, W2 {3,4}, W3 {5,6} on the line
// 1-2-3-4-5-6; East: E1 {11,12}, E2 {13,14} on the line 11-12-13-14. The road 6-20-21-22-23-11.
const TWO_REGIONS = mkGraph(
  [...path([1, 2, 3, 4, 5, 6]), ...path([6, 20, 21, 22, 23, 11]), ...path([11, 12, 13, 14])],
  [
    { id: 101, name: 'W1', value: 3, territoryIds: [1, 2] },
    { id: 102, name: 'W2', value: 3, territoryIds: [3, 4] },
    { id: 103, name: 'W3', value: 3, territoryIds: [5, 6] },
    { id: 111, name: 'E1', value: 3, territoryIds: [11, 12] },
    { id: 112, name: 'E2', value: 3, territoryIds: [13, 14] },
  ],
);
const TWO_PICKABLE = [1, 3, 5, 11, 13];
const names = (r: { uncovered: { name: string }[] }) => r.uncovered.map((b) => b.name);

describe('coverage', () => {
  const base = { graph: TWO_REGIONS, pickable: TWO_PICKABLE, settings: STD };

  it('is the share of reasonable bonuses a pick can stand next to within 2 moves', () => {
    const west = coverage(base, [1, 3, 5]);
    expect(west.reasonable).toBe(5);
    expect(west.covered).toBe(3);
    expect(west.share).toBe(0.6);
    expect(names(west)).toEqual(['E1', 'E2']);

    // 3 reaches W1 (2 is next to it), W2 and W3 (4 is next to 5); 11 reaches E1 and E2.
    const spread = coverage(base, [3, 11]);
    expect(spread.covered).toBe(5);
    expect(spread.share).toBe(1);
    expect(spread.uncovered).toEqual([]);

    // From 1: W1 itself, W2 (3 is 2 hops), W3's neighbour 4 is 3 hops away.
    expect(names(coverage(base, [1]))).toEqual(['W3', 'E1', 'E2']);
    expect(coverage(base, []).covered).toBe(0);
  });

  it('a wasteland breaks the cover: the walk never passes through one', () => {
    // 2 holds 10 armies (an ordinary neutral outside the distribution holds 2): W1 now has a
    // wasteland so it is not reasonable, and from 3 the way west through 2 is closed.
    const g = mkGraph(
      [...path([1, 2, 3, 4, 5, 6, 7])],
      [
        { id: 101, name: 'W1', value: 3, territoryIds: [1, 2] },
        { id: 102, name: 'W2', value: 3, territoryIds: [3, 4] },
        { id: 103, name: 'W3', value: 3, territoryIds: [5, 6] },
        { id: 104, name: 'Far', value: 3, territoryIds: [7] },
      ],
    );
    const neutralArmies = new Map([[2, 10]]);
    const r = coverage({ graph: g, pickable: [1, 3, 5, 7], settings: STD, neutralArmies }, [1]);
    // W1 is out (a wasteland member); from 1 nothing is reachable past 2.
    expect(r.reasonable).toBe(3);
    expect(r.covered).toBe(0);
    expect(names(r)).toEqual(['W2', 'W3', 'Far']);
    // Without the wasteland, 1 reaches W1 and W2 (3 is 2 hops).
    expect(coverage({ graph: g, pickable: [1, 3, 5, 7], settings: STD }, [1]).covered).toBe(2);
  });

  it('counts only reasonable bonuses: positive, not a superbonus, a pickable, no wasteland, value per cost at least the median', () => {
    const g = mkGraph(
      [...path([1, 2, 3, 4, 5, 6, 7, 8, 9])],
      [
        { id: 101, name: 'Good', value: 4, territoryIds: [1, 2] },
        { id: 102, name: 'Fine', value: 3, territoryIds: [3, 4] },
        { id: 103, name: 'Poor', value: 1, territoryIds: [5, 6] },
        { id: 104, name: 'NoPick', value: 9, territoryIds: [7, 8] },
        { id: 105, name: 'Minus', value: -2, territoryIds: [9] },
        { id: 106, name: 'Super', value: 5, territoryIds: [], bonusIds: [101, 102] },
      ],
    );
    // Value per capture cost (every member at captureCost(2) = 3): Good 4/6, Fine 3/6, Poor 1/6;
    // the median of the three is Fine's, so Poor is not reasonable. NoPick has no pickable.
    const r = coverage({ graph: g, pickable: [1, 3, 5, 9], settings: STD }, []);
    expect(r.reasonable).toBe(2);
    expect(names(r)).toEqual(['Good', 'Fine']);
  });

  it('is 1 with nothing reasonable to cover', () => {
    const g = mkGraph([[1, 2]], [{ id: 101, name: 'NoPick', value: 2, territoryIds: [2] }]);
    expect(coverage({ graph: g, pickable: [1], settings: STD }, [])).toEqual({
      share: 1,
      covered: 0,
      reasonable: 0,
      uncovered: [],
    });
  });
});

function plan(input: Partial<PlanPicksInput> & Pick<PlanPicksInput, 'graph' | 'pickable'>) {
  return planPicks({ settings: STD, players: 2, territoryLimit: 3, maxPicks: 6, ...input });
}

describe('planPicks — the coverage-first alternative (#166)', () => {
  it('offers a pair plus the picks that most raise coverage, beside the unchanged compact primary', () => {
    const p = plan({ graph: TWO_REGIONS, pickable: TWO_PICKABLE });
    // The compact primary is the West triple, covering only the West.
    expect([...p.groups.primary.territoryIds].sort((a, b) => a - b)).toEqual([1, 3, 5]);
    expect(p.coverage.covered).toBe(3);
    expect(names(p.coverage)).toEqual(['E1', 'E2']);

    const alt = p.alternative!;
    expect(alt).toBeDefined();
    const ids = alt.group.territoryIds;
    expect(ids).toHaveLength(3);
    // The first two are a pair within COMPACT_DISTANCE hops.
    expect(distance(TWO_REGIONS, ids[0]!, ids[1]!)).toBeLessThanOrEqual(COMPACT_DISTANCE);
    // It covers every reasonable bonus: one pick in each region.
    expect(alt.coverage.covered).toBe(5);
    expect(alt.coverage.uncovered).toEqual([]);
    expect(ids.some((t) => t >= 11)).toBe(true);
    expect(ids.some((t) => t < 11)).toBe(true);
    // Scored by the same opening simulation as any group.
    expect(alt.group.score).toBeGreaterThan(0);
    // Its own list: its picks first, then a disjoint fallback, as long as the primary's list.
    expect(alt.submitPicks.slice(0, 3)).toEqual(ids);
    expect(alt.submitPicks.slice(3)).toEqual(alt.fallback);
    expect(new Set(alt.submitPicks).size).toBe(alt.submitPicks.length);
    expect(alt.submitPicks).toHaveLength(p.picks.length);
    expect(alt.submitPicks.every((t) => TWO_PICKABLE.includes(t))).toBe(true);
    // The rationale says which to prefer when.
    const why = p.rationale.join(' ');
    expect(why).toMatch(/coverage-first alternative/);
    expect(why).toMatch(/compact primary by default/i);
  });

  it('is deterministic', () => {
    expect(plan({ graph: TWO_REGIONS, pickable: TWO_PICKABLE })).toEqual(plan({ graph: TWO_REGIONS, pickable: TWO_PICKABLE }));
  });

  it('is omitted when the primary already covers as much', () => {
    // One region: the compact primary reaches every bonus.
    const g = mkGraph(path([1, 2, 3, 4, 5, 6]), [
      { id: 101, name: 'W1', value: 3, territoryIds: [1, 2] },
      { id: 102, name: 'W2', value: 3, territoryIds: [3, 4] },
      { id: 103, name: 'W3', value: 3, territoryIds: [5, 6] },
    ]);
    const p = plan({ graph: g, pickable: [1, 3, 5], territoryLimit: 2, maxPicks: 3 });
    expect(p.coverage.share).toBe(1);
    expect(p.alternative).toBeUndefined();
  });

  it('is only for a two-player game without spread', () => {
    expect(plan({ graph: TWO_REGIONS, pickable: TWO_PICKABLE, players: 3, maxPicks: 3 }).alternative).toBeUndefined();
    expect(plan({ graph: TWO_REGIONS, pickable: TWO_PICKABLE, spread: true }).alternative).toBeUndefined();
  });

  it('leaves the primary, its fallback and the list exactly as they are', () => {
    const p = plan({ graph: TWO_REGIONS, pickable: TWO_PICKABLE });
    // The primary's list never borrows from the alternative.
    expect(p.picks.map((x) => x.territoryId)).toEqual([...p.groups.primary.territoryIds, ...p.groups.fallback.territoryIds]);
    const spreadPlan = plan({ graph: TWO_REGIONS, pickable: TWO_PICKABLE, players: 3, maxPicks: 3 });
    expect(spreadPlan.coverage).toBeDefined();
  });
});
