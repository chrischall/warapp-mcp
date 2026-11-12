// Pick advisor (K1, docs/PLAN-PICKS.md). Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph, distance, type MapGraph } from '../../src/analysis/graph.js';
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
};

function plan(input: Partial<PlanPicksInput> & Pick<PlanPicksInput, 'graph' | 'pickable'>): PickPlan {
  return planPicks({ settings: STD, players: 2, territoryLimit: 1, maxPicks: 2, ...input });
}
const scoreOf = (p: PickPlan, id: number) => p.picks.find((x) => x.territoryId === id)!.score;
const reasonsOf = (p: PickPlan, id: number) => p.picks.find((x) => x.territoryId === id)!.reasons.join(' | ');

/** Every territory in `ids` has another in `ids` within 2 hops (trivially true for one). */
function compact(g: MapGraph, ids: number[]): boolean {
  if (ids.length < 2) return true;
  return ids.every((a) => ids.some((b) => b !== a && (distance(g, a, b) ?? 99) <= 2));
}

describe('planPicks — scoring', () => {
  it('(a) a single-territory bonus and a first-turn bonus outrank a big slow bonus', () => {
    // Hub 20 joins: Solo (+2) = {1}; Duo (+3) = {2,3}; Long (+10) = the path 4-5-…-11.
    const g = mkGraph(
      [[1, 20], [2, 20], [2, 3], [4, 20], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11]],
      [
        { id: 101, name: 'Solo', value: 2, territoryIds: [1] },
        { id: 102, name: 'Duo', value: 3, territoryIds: [2, 3] },
        { id: 103, name: 'Long', value: 10, territoryIds: [4, 5, 6, 7, 8, 9, 10, 11] },
      ],
    );
    const p = plan({ graph: g, pickable: [1, 2, 4], territoryLimit: 3, maxPicks: 3 });
    expect(scoreOf(p, 1)).toBeGreaterThan(scoreOf(p, 4));
    expect(scoreOf(p, 2)).toBeGreaterThan(scoreOf(p, 4));
    expect(reasonsOf(p, 1)).toMatch(/Solo \(\+2\).*single-territory/);
    expect(reasonsOf(p, 2)).toMatch(/Duo \(\+3\).*first-turn bonus/);
    expect(reasonsOf(p, 4)).toMatch(/Long \(\+10\).*not complete within 3 turns/);
  });

  it('(b) with 0-army neutrals a territory next to many small bonuses scores high', () => {
    // 1 touches four one-territory +1 bonuses (2..5); 10 sits in Trio (+3) = {10,11,12}.
    const g = mkGraph(
      [[1, 2], [1, 3], [1, 4], [1, 5], [1, 30], [10, 30], [10, 11], [11, 12]],
      [
        { id: 102, name: 'P2', value: 1, territoryIds: [2] },
        { id: 103, name: 'P3', value: 1, territoryIds: [3] },
        { id: 104, name: 'P4', value: 1, territoryIds: [4] },
        { id: 105, name: 'P5', value: 1, territoryIds: [5] },
        { id: 110, name: 'Trio', value: 3, territoryIds: [10, 11, 12] },
      ],
    );
    const zero = plan({ graph: g, pickable: [1, 10], settings: { ...STD, initialNonDistributionArmies: 0 } });
    expect(zero.picks[0]!.territoryId).toBe(1);
    expect(scoreOf(zero, 1)).toBeGreaterThan(scoreOf(zero, 10));
    for (const name of ['P2', 'P3', 'P4', 'P5']) expect(reasonsOf(zero, 1)).toContain(name);
    const two = plan({ graph: g, pickable: [1, 10] });
    expect(scoreOf(zero, 1)).toBeGreaterThan(scoreOf(two, 1));
  });

  it('(c) a wasteland inside a bonus drops it', () => {
    // Mire (+4) = {1,2,3} with a 20-army wasteland on 3; Dell (+4) = {5,6,7} plain.
    const g = mkGraph(
      [[1, 2], [2, 3], [1, 40], [5, 40], [5, 6], [6, 7]],
      [
        { id: 201, name: 'Mire', value: 4, territoryIds: [1, 2, 3] },
        { id: 202, name: 'Dell', value: 4, territoryIds: [5, 6, 7] },
      ],
    );
    const p = plan({ graph: g, pickable: [1, 5], neutralArmies: new Map([[3, 20]]) });
    expect(p.picks[0]!.territoryId).toBe(5);
    expect(scoreOf(p, 5)).toBeGreaterThan(scoreOf(p, 1));
    expect(reasonsOf(p, 1)).toMatch(/wasteland.*T3 \(20 armies\)/);
    // Without the wasteland the two are mirror images: a tie, broken on the lower id.
    const plain = plan({ graph: g, pickable: [1, 5] });
    expect(scoreOf(plain, 1)).toBe(scoreOf(plain, 5));
  });

  it('(d) at 30/75 a defensible bonus (few entry points) beats a contested one', () => {
    // Keep (+3) = {1,2}: one entry point (50). Open (+3) = {3,4}: entry points 50, 51, 52, 53, 54.
    const g = mkGraph(
      [[1, 2], [1, 50], [3, 4], [3, 50], [4, 51], [4, 52], [4, 53], [4, 54]],
      [
        { id: 301, name: 'Keep', value: 3, territoryIds: [1, 2] },
        { id: 302, name: 'Open', value: 3, territoryIds: [3, 4] },
      ],
    );
    const hard = plan({ graph: g, pickable: [1, 3], settings: { ...STD, offensiveKillRate: 30, defensiveKillRate: 75 } });
    expect(hard.picks[0]!.territoryId).toBe(1);
    expect(scoreOf(hard, 1)).toBeGreaterThan(scoreOf(hard, 3));
    expect(reasonsOf(hard, 3)).toMatch(/5 entry points/);
    // Costly attacks make defensibility matter more than at the standard 60/70.
    const std = plan({ graph: g, pickable: [1, 3] });
    expect(scoreOf(hard, 1) / scoreOf(hard, 3)).toBeGreaterThan(scoreOf(std, 1) / scoreOf(std, 3));
  });

  it('(e) with 10 players a peripheral cluster beats a central one; with 2 it is not penalised', () => {
    // Core (+3) = {1,2} hangs off hub 10, ringed by pickable spokes 11..16.
    // Rim (+3) = {3,4} sits at the end of the chain 10-22-21-20-3. Both have one entry point.
    const g = mkGraph(
      [
        [1, 2], [1, 10],
        [10, 11], [10, 12], [10, 13], [10, 14], [10, 15], [10, 16],
        [10, 22], [22, 21], [21, 20], [20, 3], [3, 4],
      ],
      [
        { id: 401, name: 'Core', value: 3, territoryIds: [1, 2] },
        { id: 402, name: 'Rim', value: 3, territoryIds: [3, 4] },
      ],
    );
    const pickable = [1, 3, 11, 12, 13, 14, 15, 16];
    const ffa = plan({ graph: g, pickable, players: 10 });
    expect(scoreOf(ffa, 3)).toBeGreaterThan(scoreOf(ffa, 1));
    expect(ffa.picks[0]!.territoryId).toBe(3);
    expect(reasonsOf(ffa, 1)).toMatch(/contested/);
    const duel = plan({ graph: g, pickable, players: 2 });
    expect(scoreOf(duel, 1)).toBe(scoreOf(duel, 3));
    expect(reasonsOf(duel, 1)).not.toMatch(/contested/);
  });
});

describe('planPicks — groups', () => {
  // A chain 1-2-…-10 in five +2 pairs; the odd territories are pickable.
  const chain = () =>
    mkGraph(
      Array.from({ length: 9 }, (_, i) => [i + 1, i + 2] as Edge),
      [1, 3, 5, 7, 9].map((a) => ({ id: 500 + a, name: `Pair${a}`, value: 2, territoryIds: [a, a + 1] })),
    );

  it('(f) primary has exactly TerritoryLimit picks, fallback is disjoint and compact, total ≤ maxPicks', () => {
    const g = chain();
    const pickable = [1, 3, 5, 7, 9];
    const p = plan({ graph: g, pickable, players: 4, territoryLimit: 2, maxPicks: 4 });
    const primary = p.picks.filter((x) => x.group === 'primary').map((x) => x.territoryId);
    const fallback = p.picks.filter((x) => x.group === 'fallback').map((x) => x.territoryId);
    expect(primary).toHaveLength(2);
    expect(fallback.length).toBeGreaterThan(0);
    expect(p.picks.length).toBeLessThanOrEqual(4);
    expect(fallback.filter((t) => primary.includes(t))).toEqual([]);
    expect(p.picks.every((x) => pickable.includes(x.territoryId))).toBe(true);
    expect(compact(g, primary)).toBe(true);
    expect(compact(g, fallback)).toBe(true);
    expect(p.groups.primary.territoryIds).toEqual(primary);
    expect(p.groups.fallback.territoryIds).toEqual(fallback);
    // Primary first, then fallback; each group ordered by score.
    expect(p.picks.map((x) => x.group)).toEqual([...primary.map(() => 'primary'), ...fallback.map(() => 'fallback')]);
    for (const grp of [primary, fallback]) {
      const scores = grp.map((t) => scoreOf(p, t));
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    }
  });

  it('never lists a non-pickable territory and never exceeds maxPicks', () => {
    const g = chain();
    const p = plan({ graph: g, pickable: [1, 3, 999, 3], players: 4, territoryLimit: 3, maxPicks: 2 });
    expect(p.picks.map((x) => x.territoryId).sort()).toEqual([1, 3]);
    expect(p.picks.length).toBeLessThanOrEqual(2);
    expect(p.warnings.join(' ')).toMatch(/999/);
  });

  it('warns when there are fewer pickable territories than the limit', () => {
    const p = plan({ graph: chain(), pickable: [5], players: 4, territoryLimit: 2, maxPicks: 4 });
    expect(p.picks.map((x) => x.territoryId)).toEqual([5]);
    expect(p.warnings.join(' ')).toMatch(/only 1 pickable/i);
  });

  it('states every assumed setting as a warning', () => {
    const p = planPicks({ graph: chain(), pickable: [1, 3], settings: {}, players: 2, territoryLimit: 1, maxPicks: 2 });
    const w = p.warnings.join(' | ');
    expect(w).toMatch(/starting armies.*5/i);
    expect(w).toMatch(/base income.*5/i);
    expect(w).toMatch(/kill rates.*60.*70/i);
    expect(w).toMatch(/neutral/i);
    expect(p.rationale.length).toBeGreaterThan(0);
  });
});

describe('planPicks — determinism', () => {
  it('(g) the same input gives the same output, and ties go to the lower id', () => {
    // Two mirror-image +3 pairs around hub 50: {3,4} and {7,8}.
    const g = mkGraph(
      [[3, 4], [3, 50], [7, 8], [7, 50]],
      [
        { id: 601, name: 'West', value: 3, territoryIds: [3, 4] },
        { id: 602, name: 'East', value: 3, territoryIds: [7, 8] },
      ],
    );
    const a = plan({ graph: g, pickable: [7, 3] });
    const b = plan({ graph: g, pickable: [7, 3] });
    expect(b).toEqual(a);
    expect(scoreOf(a, 3)).toBe(scoreOf(a, 7));
    expect(a.picks.map((x) => x.territoryId)).toEqual([3, 7]);
  });
});
