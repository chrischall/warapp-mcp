// Pick advisor (K1, docs/PLAN-PICKS.md). Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph, distance, type MapGraph } from '../../src/analysis/graph.js';
import { planPicks, SPREAD_DISTANCE, type PickPlan, type PickSettings, type PlanPicksInput } from '../../src/analysis/picks.js';
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
/** One cluster whose picks link up in steps of at most 2 hops. */
function compact(g: MapGraph, ids: number[]): boolean {
  if (ids.length < 2) return true;
  const seen = new Set([ids[0]!]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const a of ids)
      if (!seen.has(a) && [...seen].some((b) => (distance(g, a, b) ?? 99) <= 2)) {
        seen.add(a);
        grew = true;
      }
  }
  return seen.size === ids.length;
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
    // The 7 members besides the pick, 2 neutrals each: captureCost(2) at 60/70 = 3 → 21
    // (the pick itself is held, so it is not counted).
    expect(reasonsOf(p, 4)).toMatch(/~21 armies to take all of it from this pick/);
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

describe('planPicks — income with Extra Armies for Territories (#38)', () => {
  // Picks 1, 2, 3 each border 10, the one-territory Target (+5) on 4 neutrals:
  // captureCost(4) at 60/70 = 6. One starting army each, all guarding → pool 0.
  const g = mkGraph([[1, 10], [2, 10], [3, 10]], [{ id: 701, name: 'Target', value: 5, territoryIds: [10] }]);
  const run = (extra: PickSettings) =>
    plan({
      graph: g,
      pickable: [1, 2, 3],
      territoryLimit: 3,
      maxPicks: 3,
      neutralArmies: new Map([[10, 4]]),
      settings: { ...STD, initialPlayerArmiesPerTerritory: 1, ...extra },
    });
  const targetTurn = (p: PickPlan) => p.groups.primary.bonuses.find((b) => b.bonusId === 701)?.turn;

  it('base 4, one army per territory, 3 picks: income is max(4, 3) = 4, not 7 — Target waits for turn 2', () => {
    expect(targetTurn(run({ minimumArmyBonus: 4, bonusArmyPer: 1 }))).toBe(2);
  });

  it('the territory armies replace the base once larger: base 2, per 1, 3 picks → 3 (not 5), still turn 2', () => {
    expect(targetTurn(run({ minimumArmyBonus: 2, bonusArmyPer: 1 }))).toBe(2);
  });

  it('a base that already pays for the capture takes Target on turn 1', () => {
    expect(targetTurn(run({ minimumArmyBonus: 6, bonusArmyPer: 1 }))).toBe(1);
  });
});

const primaryOf = (p: PickPlan) => p.picks.filter((x) => x.group === 'primary').map((x) => x.territoryId);
/** Largest hop distance between two picks of the group, on the route tool's graph. */
function farthest(g: MapGraph, ids: number[]): number {
  let m = 0;
  for (const a of ids) for (const b of ids) if (a < b) m = Math.max(m, distance(g, a, b) ?? Infinity);
  return m;
}

describe('planPicks — compactness (#47)', () => {
  // Three strong picks (each next to its own +5 first-turn pair) sit 6 hops apart on a
  // chain; a weaker cluster (+1 pairs) hangs together off it, each within 2 hops of another.
  const spreadMap = () =>
    mkGraph(
      [
        // Strong: 1-2, 11-12, 21-22 (+5 each); chain 1-3-4-5-6-7-11-13-14-15-16-17-21.
        [1, 2], [11, 12], [21, 22],
        [1, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 11],
        [11, 13], [13, 14], [14, 15], [15, 16], [16, 17], [17, 21],
        // Weak cluster off 5: 31-32, 33-34, 35-36 (+1 each); 31-33 and 33-35 adjacent.
        [5, 40], [40, 41], [41, 42], [42, 43], [43, 31], [31, 32], [31, 33], [33, 34], [33, 35], [35, 36],
      ],
      [
        { id: 701, name: 'StrongA', value: 5, territoryIds: [1, 2] },
        { id: 702, name: 'StrongB', value: 5, territoryIds: [11, 12] },
        { id: 703, name: 'StrongC', value: 5, territoryIds: [21, 22] },
        { id: 711, name: 'WeakA', value: 1, territoryIds: [31, 32] },
        { id: 712, name: 'WeakB', value: 1, territoryIds: [33, 34] },
        { id: 713, name: 'WeakC', value: 1, territoryIds: [35, 36] },
      ],
    );
  const pickable = [1, 11, 21, 31, 33, 35];

  it('with ≥ 3 players and the top scores far apart, a compact primary group is chosen', () => {
    const g = spreadMap();
    const p = plan({ graph: g, pickable, players: 4, territoryLimit: 3, maxPicks: 6 });
    // The strong picks really do score best, and lie far apart.
    expect(scoreOf(p, 1)).toBeGreaterThan(scoreOf(p, 33));
    expect(farthest(g, [1, 11, 21])).toBeGreaterThan(4);
    const primary = primaryOf(p);
    expect(primary).toHaveLength(3);
    expect(compact(g, primary)).toBe(true);
    expect(primary.sort((a, b) => a - b)).toEqual([31, 33, 35]);
    expect(p.warnings.join(' ')).not.toMatch(/compact primary group/i);
    expect(p.rationale.join(' ')).toMatch(/compact/);
  });

  it('with ≥ 3 players and no compact group, it warns and relaxes one hop at a time', () => {
    // Pickables every 3 hops on a chain: no two within 2 hops.
    const g = mkGraph(
      Array.from({ length: 12 }, (_, i) => [i + 1, i + 2] as Edge),
      [1, 4, 7, 10].map((a) => ({ id: 800 + a, name: `Pair${a}`, value: 2, territoryIds: [a, a + 1] })),
    );
    const p = plan({ graph: g, pickable: [1, 4, 7, 10], players: 4, territoryLimit: 2, maxPicks: 4 });
    const primary = primaryOf(p);
    expect(primary).toHaveLength(2);
    expect(farthest(g, primary)).toBe(3);
    expect(p.warnings.join(' ')).toMatch(/no compact primary group.*within 3 hops/i);
    expect(p.rationale.join(' ')).not.toMatch(/compact primary group \(each within 2/);
    expect(p.rationale.join(' ')).toMatch(/3 hops/);
    expect(p.rationale.join(' ')).not.toMatch(/each group must be compact/);
    expect(p.rationale.join(' ')).toMatch(/relaxed/);
  });

  it('in a 1v1 a spread group is never called compact, even when each pick has a mate within 2 hops', () => {
    // Two tight pairs, {1,2} and {10,11}, joined only by 2-3-4-10: each pick has a group-mate
    // within 2 hops, but the pairs are 3 hops apart, so the group is not one compact cluster.
    const g = mkGraph(
      [[1, 2], [2, 3], [3, 4], [4, 10], [10, 11], [1, 51], [2, 52], [10, 53], [11, 54]],
      [
        { id: 811, name: 'P1', value: 3, territoryIds: [1, 51] },
        { id: 812, name: 'P2', value: 3, territoryIds: [2, 52] },
        { id: 813, name: 'P10', value: 3, territoryIds: [10, 53] },
        { id: 814, name: 'P11', value: 3, territoryIds: [11, 54] },
      ],
    );
    const p = plan({ graph: g, pickable: [1, 2, 10, 11], players: 2, territoryLimit: 4, maxPicks: 4 });
    const primary = primaryOf(p);
    expect([...primary].sort((a, b) => a - b)).toEqual([1, 2, 10, 11]);
    expect(compact(g, primary)).toBe(false);
    expect(p.groups.primary.maxHops).toBe(5);
    const line = p.rationale.find((r) => r.includes('primary group'))!;
    expect(line).toContain(
      'the primary group, spread: its picks link up only in steps of up to 3 hops, the farthest two 5 hops apart (T1 and T11)',
    );
    expect(line).not.toMatch(/compact/);
    // Spreading is bounded: every pick within SPREAD_DISTANCE of another group pick.
    for (const a of primary)
      expect(Math.min(...primary.filter((b) => b !== a).map((b) => distance(g, a, b)!))).toBeLessThanOrEqual(SPREAD_DISTANCE);
  });

  it('in a 1v1 the hop bound does not send a far better group to the fallback', () => {
    // Within 4 hops only the weak cluster forms a group of 3; the three +5 first-turn picks lie
    // 6 hops apart and score several times more, so the primary spreads to them, with a warning.
    const g = spreadMap();
    const p = plan({ graph: g, pickable, players: 2, territoryLimit: 3, maxPicks: 6 });
    expect([...primaryOf(p)].sort((a, b) => a - b)).toEqual([1, 11, 21]);
    expect(p.picks.filter((x) => x.group === 'fallback').map((x) => x.territoryId).sort((a, b) => a - b)).toEqual([
      31, 33, 35,
    ]);
    expect(p.groups.primary.score).toBeGreaterThan(p.groups.fallback.score);
    expect(p.warnings.join(' ')).toMatch(/1v1.*primary group spreads to within 6 hops/);
    expect(p.groups.primary.maxHops).toBe(12);
    expect(p.rationale.join(' ')).toContain('farthest two 12 hops apart');
  });

  it('with ≥ 3 players a fallback that outscores the compact primary is flagged', () => {
    const p = plan({ graph: spreadMap(), pickable, players: 4, territoryLimit: 3, maxPicks: 6 });
    expect(p.groups.fallback.score).toBeGreaterThan(p.groups.primary.score);
    expect(p.warnings.join(' ')).toMatch(/fallback group scores more than the primary/i);
  });
});

describe('planPicks — opening simulation (#47)', () => {
  // Ice (+3) = {1,2,3,4}: pick 1 borders 2, 3, 4 (neutrals 2, 2, 2 → 3 armies each, 9 in all).
  // Duo (+3) = {5,6}: pick 5 borders 6 (3 armies). Far (+2) = {9,10}: pick 9, far from both.
  const map = () =>
    mkGraph(
      [[1, 2], [1, 3], [1, 4], [4, 20], [20, 21], [21, 22], [22, 5], [5, 6], [22, 23], [23, 24], [24, 25], [25, 9], [9, 10]],
      [
        { id: 901, name: 'Ice', value: 3, territoryIds: [1, 2, 3, 4] },
        { id: 902, name: 'Duo', value: 3, territoryIds: [5, 6] },
        { id: 903, name: 'Far', value: 2, territoryIds: [9, 10] },
      ],
    );
  const four = { ...STD, minimumArmyBonus: 4 };

  it('a bonus needing 9 armies is not claimed on turn 1 when only 8 can reach it', () => {
    // Pick 1 has 4 movable + 4 income = 8 < 9 at Ice; the other picks' armies cannot reach it.
    const g = map();
    const p = plan({ graph: g, pickable: [1, 5, 9], players: 2, territoryLimit: 3, maxPicks: 3, settings: four });
    const ice = p.groups.primary.bonuses.find((b) => b.name === 'Ice');
    expect(ice?.turn).not.toBe(1);
    expect(reasonsOf(p, 1)).not.toMatch(/Ice[^|]*first-turn/);
  });

  it('a genuine first-turn bonus still reports turn 1', () => {
    const g = map();
    const p = plan({ graph: g, pickable: [1, 5, 9], players: 2, territoryLimit: 3, maxPicks: 3, settings: four });
    expect(p.groups.primary.bonuses.find((b) => b.name === 'Duo')?.turn).toBe(1);
    expect(reasonsOf(p, 5)).toMatch(/Duo \(\+3\).*first-turn bonus/);
    // With 5 base income pick 1 alone affords Ice's 9 on turn 1.
    const five = plan({ graph: g, pickable: [1], players: 2, territoryLimit: 1, maxPicks: 1 });
    expect(five.groups.primary.bonuses.find((b) => b.name === 'Ice')?.turn).toBe(1);
  });

  it('per-territory income is max(base, territories / BonusArmyPer), not their sum (#38)', () => {
    // Ice needs 3 + 5 + 2 = 10: pick 1's 4 movable + max(5, 1) = 9 falls short (the sum would give 10).
    const g = map();
    const neutralArmies = new Map([[2, 2], [3, 3], [4, 1]]);
    const p = plan({
      graph: g,
      pickable: [1],
      territoryLimit: 1,
      maxPicks: 1,
      neutralArmies,
      settings: { ...STD, bonusArmyPer: 1 },
    });
    expect(p.groups.primary.bonuses.find((b) => b.name === 'Ice')?.turn).not.toBe(1);
  });
});

describe('planPicks — opening simulation, idle armies (#47)', () => {
  it('when the best bonus cannot be paid for, armies elsewhere still take a cheaper one', () => {
    // Big (+20) = {1,2}: 2 holds 20 neutrals (34 armies; the best ratio), far beyond pick 1's 4 movable + 5 income.
    // Small (+1) = {5,6}: pick 5's own 4 movable armies take 6 (2 neutrals) on turn 1,
    // while the income is saved on pick 1 for Big.
    const g = mkGraph([[1, 2], [5, 6]], [
      { id: 971, name: 'Big', value: 20, territoryIds: [1, 2] },
      { id: 972, name: 'Small', value: 1, territoryIds: [5, 6] },
    ]);
    const p = plan({
      graph: g,
      pickable: [1, 5],
      territoryLimit: 2,
      maxPicks: 2,
      neutralArmies: new Map([[2, 20], [6, 2]]),
    });
    expect(p.groups.primary.bonuses.find((b) => b.name === 'Small')?.turn).toBe(1);
  });
});

describe('planPicks — reasons lead with the point (#47)', () => {
  it("reasons[0] names the bonus the pick anchors and when it completes; negatives come after", () => {
    // Pick 1 anchors Duo (+3, first-turn) and touches Mire (+4) with a 20-army wasteland.
    const g = mkGraph(
      [[1, 2], [1, 3], [3, 4]],
      [
        { id: 951, name: 'Duo', value: 3, territoryIds: [1, 2] },
        { id: 952, name: 'Mire', value: 4, territoryIds: [3, 4] },
      ],
    );
    const p = plan({ graph: g, pickable: [1], territoryLimit: 1, maxPicks: 1, neutralArmies: new Map([[4, 20]]) });
    const r = p.picks[0]!.reasons;
    expect(r[0]).toMatch(/^Anchors Duo \(\+3\): first-turn bonus \(complete on turn 1\), \+3 income from turn 2/);
    expect(r.slice(1).join(' | ')).toMatch(/wasteland/);
  });

  it('an incomplete anchor leads with the share it reaches, the shortfall after', () => {
    const g = mkGraph(
      [[4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11]],
      [{ id: 961, name: 'Long', value: 10, territoryIds: [4, 5, 6, 7, 8, 9, 10, 11] }],
    );
    const p = plan({ graph: g, pickable: [4], territoryLimit: 1, maxPicks: 1 });
    const r = p.picks[0]!.reasons;
    expect(r[0]).toMatch(/^Advances Long \(\+10\): \d of 8 territories by turn 3, ~\d+ armies to take all of it from this pick/);
    expect(r.slice(1).join(' | ')).toMatch(/not complete within 3 turns/);
  });
});
