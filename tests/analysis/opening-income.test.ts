// #166: the opening threat model. `openingIncome` runs the pick advisor's own opening simulation
// from a set of starts (here: the opponent's, as the award of picks proves them) and reports the
// income it gives on each turn 1..PICK_HORIZON + 1. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph, type MapGraph } from '../../src/analysis/graph.js';
import { openingIncome, PICK_HORIZON, planPicks, type PickSettings } from '../../src/analysis/picks.js';
import type { GameMap } from '../../src/normalize.js';

type Edge = [number, number];

function mkGraph(edges: Edge[], bonuses: [number, number, number[]][], extraIds: number[] = []): MapGraph {
  const ids = [...new Set([...edges.flat(), ...bonuses.flatMap(([, , ts]) => ts), ...extraIds])].sort((a, b) => a - b);
  const map: GameMap = {
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

describe('openingIncome (#166): the income the opening simulation gives from a set of starts', () => {
  // T1 – T2 form a +3 bonus; T2 – T3 – T4 a +4 bonus behind it; T5 stands alone off T1.
  const g = mkGraph(
    [
      [1, 2],
      [2, 3],
      [3, 4],
      [1, 5],
    ],
    [
      [901, 3, [1, 2]],
      [902, 4, [3, 4]],
    ],
  );

  it('one income per turn 1..PICK_HORIZON + 1', () => {
    expect(openingIncome({ graph: g, starts: [5], settings: STD })).toHaveLength(PICK_HORIZON + 1);
  });

  it('a start that completes a bonus on turn 1 earns base + its value from turn 2', () => {
    const income = openingIncome({ graph: g, starts: [1], settings: STD });
    expect(income[0]).toBe(5);
    expect(income[1]).toBe(8);
    // It goes on to the next bonus; never below base + the first.
    for (const n of income.slice(1)) expect(n).toBeGreaterThanOrEqual(8);
  });

  it('starts that hold a bonus in full earn it on turn 1', () => {
    expect(openingIncome({ graph: g, starts: [1, 2], settings: STD })[0]).toBe(8);
  });

  it('a bonus with a member someone else holds (`taken`) never completes', () => {
    expect(openingIncome({ graph: g, starts: [1], settings: STD, taken: [2] })).toEqual([5, 5, 5, 5]);
  });

  it('neutral sizes from the board: a wasteland it cannot take keeps the income at base', () => {
    const income = openingIncome({ graph: g, starts: [1], settings: STD, neutralArmies: new Map([[2, 40]]) });
    expect(income).toEqual([5, 5, 5, 5]);
  });

  it('starts not on the map are ignored; none at all earn the base income', () => {
    expect(openingIncome({ graph: g, starts: [999], settings: STD })).toEqual([5, 5, 5, 5]);
  });

  it('pure and deterministic, and it changes no pick output', () => {
    const before = planPicks({ graph: g, pickable: [1, 3, 5], settings: STD, players: 2, territoryLimit: 1, maxPicks: 2 });
    const a = openingIncome({ graph: g, starts: [1], settings: STD, pickable: [1, 3, 5] });
    const b = openingIncome({ graph: g, starts: [1], settings: STD, pickable: [1, 3, 5] });
    expect(a).toEqual(b);
    expect(planPicks({ graph: g, pickable: [1, 3, 5], settings: STD, players: 2, territoryLimit: 1, maxPicks: 2 })).toEqual(before);
  });
});
