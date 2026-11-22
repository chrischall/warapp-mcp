// A primary pick that only pays beside the pick above it (#429). Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph, type MapGraph } from '../../src/analysis/graph.js';
import { PRIMARY_FLOOR, FRAGILE_WORST, planPicks, type PickPlan, type PickSettings, type PlanPicksInput } from '../../src/analysis/picks.js';
import type { GameMap } from '../../src/normalize.js';

type Edge = [number, number];
type BonusSpec = { id: number; name: string; value: number; territoryIds: number[] };

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

// Accepted: Low (+4) = {4, 5} and Far (+5) = {6, 10}. 5 and 4 hold Low at once, so the greedy search pairs them;
// with 5 gone to the opponent, 4 alone sits in the bonus it lost, while 10 takes Far by capturing 6 whoever holds 5.
// The swap keeps the primary's joint score at 16.38 of 19.83 (above PRIMARY_FLOOR).
const kept = () =>
  mkGraph(
    [[1, 2], [1, 3], [2, 4], [4, 5], [5, 6], [2, 7], [7, 8], [1, 9], [6, 10], [5, 2]],
    [
      { id: 100, name: 'Pair', value: 3, territoryIds: [1, 2] },
      { id: 101, name: 'Spur', value: 1, territoryIds: [3] },
      { id: 102, name: 'Low', value: 4, territoryIds: [4, 5] },
      { id: 103, name: 'Far', value: 5, territoryIds: [6, 10] },
      { id: 104, name: 'West', value: 4, territoryIds: [7, 8] },
      { id: 105, name: 'Solo', value: 3, territoryIds: [9] },
    ],
  );
const keptPickable = [1, 2, 3, 4, 5, 7, 9, 10];

// Refused: the swap would raise the worst outcome (7.06 to 9.94) and the mean (13.48 to 13.98), but the primary's
// joint score would fall from 18.19 to 9.94, nearly half (the owner's floor, 2026-11-22: at least 0.8 of it).
const halved = () =>
  mkGraph(
    [[1, 2], [2, 3], [3, 4], [3, 5], [5, 6], [4, 7], [7, 8], [8, 9], [9, 10], [6, 11], [3, 12], [9, 13], [10, 14], [9, 7], [3, 13], [9, 6]],
    [
      { id: 100, name: 'Edge', value: 3, territoryIds: [1, 2] },
      { id: 101, name: 'Core', value: 5, territoryIds: [3, 4, 5] },
      { id: 102, name: 'East', value: 3, territoryIds: [6, 11] },
      { id: 103, name: 'Ring', value: 5, territoryIds: [7, 8, 9] },
      { id: 104, name: 'Tail', value: 1, territoryIds: [10, 14] },
      { id: 105, name: 'Peak', value: 5, territoryIds: [12] },
      { id: 106, name: 'Knot', value: 1, territoryIds: [13] },
    ],
  );
const halvedPickable = [4, 5, 6, 7, 8, 10, 11, 13, 14];

function plan(input: Partial<PlanPicksInput> = {}): PickPlan {
  return planPicks({ graph: kept(), pickable: keptPickable, settings: STD, players: 2, territoryLimit: 2, maxPicks: 4, ...input });
}

describe('planPicks — a primary pick that only pays beside the pick above it (#429)', () => {
  it('exports the fragility threshold and the floor on the primary’s joint score', () => {
    expect(FRAGILE_WORST).toBe(0.6);
    expect(PRIMARY_FLOOR).toBe(0.8);
  });

  it('in a 1v1 lists second the pick that pays when the first is lost, not the one that only completes a bonus with it', () => {
    const p = plan();
    expect(p.groups.primary.territoryIds).toEqual([5, 10]);
    const w = p.warnings.find((x) => x.includes('(#429)'));
    expect(w).toMatch(/^Primary pick 2 is T10, not T4: in the 1 award outcomes/);
    expect(w).toMatch(/worst outcome rises from 9\.82 to 16\.38, its mean outcome from 16\.21 to 17\.9/);
    expect(w).toMatch(/joint score is 16\.38, against 19\.83 before/);
    expect(p.award!.worst.score).toBe(16.38);
  });

  it('refuses a swap that leaves the primary under PRIMARY_FLOOR of its joint score, though worst and mean rise', () => {
    const p = plan({ graph: halved(), pickable: halvedPickable });
    expect(p.groups.primary.territoryIds).toEqual([7, 13]);
    expect(p.warnings.join(' ')).not.toMatch(/#429/);
    expect(p.award!.worst.score).toBe(7.06);
  });

  it('the award report describes the list as it is submitted', () => {
    const p = plan();
    const list = p.picks.map((x) => x.territoryId);
    for (const t of p.award!.worst.territoryIds) expect(list).toContain(t);
    for (const t of p.award!.worst.opponentStarts) expect(list).toContain(t);
  });

  it('with three players, or with spread: true, nothing is replaced (the rule is two-player, answering-fallback only)', () => {
    for (const p of [plan({ players: 3, maxPicks: 6 }), plan({ spread: true })]) {
      expect(p.warnings.join(' ')).not.toMatch(/#429/);
    }
  });

  it('is deterministic, whatever order the pickables come in', () => {
    const a = plan();
    const b = plan({ pickable: [...keptPickable].reverse() });
    expect(b.picks.map((x) => x.territoryId)).toEqual(a.picks.map((x) => x.territoryId));
    expect(b.warnings).toEqual(a.warnings);
  });
});
