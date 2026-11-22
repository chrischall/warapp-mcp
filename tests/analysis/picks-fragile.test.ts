// A primary pick that only pays beside the pick above it (#429). Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph, type MapGraph } from '../../src/analysis/graph.js';
import { FRAGILE_WORST, planPicks, type PickPlan, type PickSettings, type PlanPicksInput } from '../../src/analysis/picks.js';
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

// A tree. Pair (+5) = {7, 9}: picking both holds it at once, so the greedy search pairs them. But 9 alone,
// with 7 gone to the opponent, holds half a bonus the opponent sits in; 3 alone takes Duo (+5) = {3, 4}
// by capturing 4, whoever holds 7.
const graph = () =>
  mkGraph(
    [[1, 2], [2, 3], [3, 4], [2, 5], [5, 6], [3, 7], [3, 8], [7, 9], [1, 10]],
    [
      { id: 100, name: 'Trio', value: 5, territoryIds: [1, 2, 10] },
      { id: 101, name: 'Duo', value: 5, territoryIds: [3, 4] },
      { id: 102, name: 'East', value: 5, territoryIds: [5, 6] },
      { id: 103, name: 'Pair', value: 5, territoryIds: [7, 9] },
      { id: 104, name: 'Spur', value: 1, territoryIds: [8] },
    ],
  );
const pickable = [1, 2, 3, 4, 5, 6, 7, 8, 9];
function plan(input: Partial<PlanPicksInput> = {}): PickPlan {
  return planPicks({ graph: graph(), pickable, settings: STD, players: 2, territoryLimit: 2, maxPicks: 4, ...input });
}

describe('planPicks — a primary pick that only pays beside the pick above it (#429)', () => {
  it('exports the share of the primary’s score under which a worst outcome makes the list fragile', () => {
    expect(FRAGILE_WORST).toBe(0.6);
  });

  it('in a 1v1 lists second the pick that pays when the first is lost, not the one that only completes a bonus with it', () => {
    const p = plan();
    expect(p.groups.primary.territoryIds).toEqual([7, 3]);
    expect(p.picks.map((x) => x.territoryId)).not.toContain(9);
    const w = p.warnings.find((x) => x.includes('(#429)'));
    expect(w).toMatch(/^Primary pick 2 is T3, not T9: in the 1 award outcomes/);
    expect(w).toMatch(/worst outcome rises from 8\.63 to 10\.98, its mean outcome from 14\.43 to 15\.33/);
    expect(p.award!.worst.score).toBe(10.98);
  });

  it('the award report describes the list as it is submitted', () => {
    const p = plan();
    const list = p.picks.map((x) => x.territoryId);
    for (const t of p.award!.worst.territoryIds) expect(list).toContain(t);
    for (const t of p.award!.worst.opponentStarts) expect(list).toContain(t);
  });

  it('with three players, or with spread: true, the pair stays (the rule is two-player, answering-fallback only)', () => {
    for (const p of [plan({ players: 3, maxPicks: 6 }), plan({ spread: true })]) {
      expect(p.warnings.join(' ')).not.toMatch(/#429/);
    }
  });

  it('is deterministic, whatever order the pickables come in', () => {
    const a = plan();
    const b = plan({ pickable: [...pickable].reverse() });
    expect(b.picks.map((x) => x.territoryId)).toEqual(a.picks.map((x) => x.territoryId));
    expect(b.warnings).toEqual(a.warnings);
  });
});
