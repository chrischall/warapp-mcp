// Pick advisor audit (#129). Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph, type MapGraph } from '../../src/analysis/graph.js';
import { clientPickLimits, impliedOpponentStarts, pickOutcomes, planPicks, type PickPlan, type PickSettings, type PlanPicksInput } from '../../src/analysis/picks.js';
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

describe('planPicks — wastelands (#129)', () => {
  it('neither the pick itself nor a neutral of the ordinary size is a wasteland', () => {
    // Pair (+1) = {1,2}, both pickable at the default 4-army distribution size.
    const g = mkGraph([[1, 2], [2, 3]], [{ id: 100, name: 'Pair', value: 1, territoryIds: [1, 2] }]);
    const p = plan({ graph: g, pickable: [1, 2], territoryLimit: 1, maxPicks: 2 });
    expect(reasonsOf(p, 1)).not.toMatch(/wasteland/);
    expect(reasonsOf(p, 2)).not.toMatch(/wasteland/);
  });

  it('a member larger than the ordinary neutral is one', () => {
    const g = mkGraph([[1, 2], [2, 3]], [{ id: 100, name: 'Pair', value: 1, territoryIds: [1, 2] }]);
    const p = plan({ graph: g, pickable: [1], territoryLimit: 1, maxPicks: 1, neutralArmies: new Map([[2, 10]]) });
    expect(reasonsOf(p, 1)).toMatch(/Pair \(\+1\) holds a wasteland: T2 \(10 armies\)/);
  });
});

describe('planPicks — Local Deployment income stays in its bonus (#129)', () => {
  // Solo (+5) = {1} alone; Fan (+3) = {10,11,12}, 11 and 12 hanging off pick 10 (3 armies each).
  // With no base income, Solo's +5 is the only income: pooled, it tops up pick 10's 4 movable
  // armies to take both on turn 1; deployed only inside Solo it never reaches Fan.
  const g = () =>
    mkGraph([[1, 2], [2, 3], [10, 11], [10, 12], [12, 13]], [
      { id: 100, name: 'Solo', value: 5, territoryIds: [1] },
      { id: 101, name: 'Fan', value: 3, territoryIds: [10, 11, 12] },
    ]);
  const input = { pickable: [1, 10], territoryLimit: 2, maxPicks: 2 };
  it('pooled, Solo pays for Fan on turn 1', () => {
    const p = plan({ graph: g(), ...input, settings: { ...STD, minimumArmyBonus: 0 } });
    expect(p.groups.primary.bonuses.find((b) => b.name === 'Fan')?.turn).toBe(1);
  });
  it('with local deployments it cannot, and the warning no longer says the model pools it', () => {
    const p = plan({ graph: g(), ...input, settings: { ...STD, minimumArmyBonus: 0, localDeployments: true } });
    expect(p.groups.primary.bonuses.find((b) => b.name === 'Fan')).toBeUndefined();
    expect(p.warnings.join(' ')).not.toMatch(/pools it/);
    expect(p.warnings.join(' ')).toMatch(/[Ll]ocal deployments/);
  });
});

describe('clientPickLimits — the client’s own pick-list bounds (#129)', () => {
  it('max is players × territories per player; min is territories per player, at most 10', () => {
    // Per player: the territory limit, or fewer when the pickables cannot give everyone that many.
    expect(clientPickLimits({ territoryLimit: 3, players: 2, pickable: 40 })).toEqual({ perPlayer: 3, min: 3, max: 6 });
    expect(clientPickLimits({ territoryLimit: 3, players: 6, pickable: 40 })).toEqual({ perPlayer: 3, min: 3, max: 18 });
    expect(clientPickLimits({ territoryLimit: 5, players: 4, pickable: 12 })).toEqual({ perPlayer: 3, min: 3, max: 12 });
    // A limit of 0 is no limit; the minimum is capped at 10.
    expect(clientPickLimits({ territoryLimit: 0, players: 2, pickable: 40 })).toEqual({ perPlayer: 20, min: 10, max: 40 });
    // Without the pickable count, the limit alone.
    expect(clientPickLimits({ territoryLimit: 4, players: 3 })).toEqual({ perPlayer: 4, min: 4, max: 12 });
    expect(clientPickLimits({ territoryLimit: undefined, players: 3 })).toBeNull();
  });
});

describe('planPicks — a list longer than twice the limit runs in tiers (#129)', () => {
  it('each fallback tier is scored with the picks before it taken', () => {
    // PairA (+4) = {1,2}, PairB (+3) = {5,6}, PairC (+2) = {8,9}; limit 1, three players, a list of 3.
    const g = mkGraph(
      [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9]],
      [
        { id: 100, name: 'PairA', value: 4, territoryIds: [1, 2] },
        { id: 101, name: 'PairB', value: 3, territoryIds: [5, 6] },
        { id: 102, name: 'PairC', value: 2, territoryIds: [8, 9] },
      ],
    );
    const p = plan({ graph: g, pickable: [1, 2, 5, 8], players: 3, territoryLimit: 1, maxPicks: 3 });
    expect(p.groups.primary.territoryIds).toEqual([1]);
    // Tier 1: with 1 taken, 2 is worth nothing; PairB is next. Tier 2: with 1 and 5 taken, PairC.
    expect(p.groups.fallback.territoryIds).toEqual([5, 8]);
    expect(p.groups.fallback.bonuses.map((b) => b.name)).toEqual(['PairB']);
    expect(p.rationale.join(' ')).toMatch(/2 tiers of up to 1/);
  });
});

describe('pickOutcomes — the award order (#129)', () => {
  // Rounds in move order, reversing each round; each player gets their best-ranked free pick.
  const key = (o: number[]) => o.join(',');
  it('a 3-pick 1v1 list of 6 has exactly 11 outcomes, and never loses both of the top two', () => {
    const out = pickOutcomes({ listLength: 6, perPlayer: 3, players: 2 });
    expect(out).not.toBeNull();
    expect(out!.length).toBe(11);
    expect(new Set(out!.map(key)).size).toBe(11);
    for (const o of out!) {
      expect(o).toHaveLength(3);
      expect(o.includes(0) || o.includes(1)).toBe(true);
    }
    expect(out!.map(key)).toContain('0,1,2');
  });

  it('impliedOpponentStarts: a pick ranked above the last one granted, not granted, is another player’s start', () => {
    expect(impliedOpponentStarts([10, 11, 12, 13, 14], [10, 12, 14])).toEqual([11, 13]);
    expect(impliedOpponentStarts([10, 11, 12], [10, 11, 12])).toEqual([]);
    expect(impliedOpponentStarts([10, 11, 12], [])).toEqual([]);
  });
});

describe('planPicks — a list is judged by the sets the award order can give (#129)', () => {
  it('reports the worst outcome of a 1v1 list and the opponent starts it implies', () => {
    const g = mkGraph(
      [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8]],
      [
        { id: 100, name: 'West', value: 3, territoryIds: [1, 2] },
        { id: 101, name: 'East', value: 3, territoryIds: [7, 8] },
      ],
    );
    const p = plan({ graph: g, pickable: [1, 2, 4, 5, 7, 8], territoryLimit: 2, maxPicks: 4 });
    expect(p.award).toBeDefined();
    const list = p.picks.map((x) => x.territoryId);
    expect(p.award!.outcomes).toBe(pickOutcomes({ listLength: 4, perPlayer: 2, players: 2 })!.length);
    const worst = p.award!.worst;
    expect(worst.territoryIds.every((t) => list.includes(t))).toBe(true);
    expect(worst.score).toBeLessThanOrEqual(p.groups.primary.score);
    expect(worst.opponentStarts).toEqual(impliedOpponentStarts(list, worst.territoryIds));
    expect(p.rationale.join(' ')).toMatch(/award order/);
    expect(p.award!.reordered).toBe(false);
  });

  it('orders the primary to raise the worst outcome when score order would lose the better start', () => {
    // 4 is a single-territory bonus twice over (+4 and +3) hanging off 1; Pair (+6) = {2,6}.
    // Pick 1 scores more alone (it captures 4), but losing 4 to the opponent costs more than
    // losing 1, so 4 goes first.
    const g = mkGraph(
      [[1, 2], [2, 3], [1, 4], [2, 5], [2, 6], [6, 7], [2, 8], [3, 9]],
      [
        { id: 100, name: 'SoloA', value: 4, territoryIds: [4] },
        { id: 101, name: 'Pair', value: 6, territoryIds: [6, 2] },
        { id: 102, name: 'SoloB', value: 3, territoryIds: [4] },
      ],
    );
    const p = plan({ graph: g, pickable: [1, 4, 5, 6, 9], territoryLimit: 2, maxPicks: 4 });
    expect(pick(p, 1).score).toBeGreaterThan(pick(p, 4).score);
    expect(p.groups.primary.territoryIds).toEqual([4, 1]);
    expect(p.award!.reordered).toBe(true);
    expect(p.rationale.join(' ')).toMatch(/ordered to raise that worst outcome/);
  });
});
