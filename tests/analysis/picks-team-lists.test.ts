// Team-aware picks, the coordination step (C2, docs/PLAN-TEAMS.md): with a teammate's pick list readable,
// planPicks reports the overlap with mine, penalises a pick in a bonus the teammate is also picking into
// (a bonus pays one holder), offers a mirrored alternative (the same top picks in both lists) beside the
// split one, keeping a pair that only works in one hand on positions the award gives to one player, and
// shortens my list only when the lists are disjoint. An unreadable list plans exactly as before. Every map,
// id and name here is made up.
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
  initialNeutralsInDistribution: 2,
  oneArmyStandsGuard: true,
};

/** A 2v2: four players, one teammate, one start each unless given. */
function plan(input: Partial<PlanPicksInput> & Pick<PlanPicksInput, 'graph' | 'pickable'>): PickPlan {
  return planPicks({ settings: STD, players: 4, territoryLimit: 1, maxPicks: 4, team: { teammates: 1 }, ...input });
}
const ids = (p: PickPlan) => p.picks.map((x) => x.territoryId);
const scoreOf = (p: PickPlan, id: number) => p.picks.find((x) => x.territoryId === id)?.score;

// Three bonuses side by side: Alpha (+4) = {1,2}, Beta (+3) = {3,4}, Gamma (+2) = {5,6}, and isolated
// pickables 20..23 (other places a player may start). Every bonus member is pickable.
const three = () =>
  mkGraph(
    [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]],
    [
      { id: 101, name: 'Alpha', value: 4, territoryIds: [1, 2] },
      { id: 102, name: 'Beta', value: 3, territoryIds: [3, 4] },
      { id: 103, name: 'Gamma', value: 2, territoryIds: [5, 6] },
    ],
    [20, 21, 22, 23],
  );
const PICKABLE = [1, 2, 3, 4, 5, 6, 20, 21, 22, 23];

describe('planPicks with a teammate list unreadable — exactly today’s team picks', () => {
  it('no list, an empty list and no lists at all plan the same', () => {
    const base = plan({ graph: three(), pickable: PICKABLE });
    expect(plan({ graph: three(), pickable: PICKABLE, team: { teammates: 1, lists: [] } })).toEqual(base);
    expect(plan({ graph: three(), pickable: PICKABLE, team: { teammates: 1, lists: [[]] } })).toEqual(base);
    expect(base).not.toHaveProperty('team');
  });
});

describe('planPicks with a teammate list (C2, coordination)', () => {
  it('a bonus pays one holder: a pick in a bonus the teammate picks into loses its credit, and is reported', () => {
    const solo = plan({ graph: three(), pickable: PICKABLE });
    // Alone, Alpha (+4) is the best start.
    expect([1, 2]).toContain(ids(solo)[0]);
    const p = plan({ graph: three(), pickable: PICKABLE, team: { teammates: 1, lists: [[1]] } });
    // My teammate starts in Alpha: the split list leaves their top pick to them and leads elsewhere.
    expect(ids(p)).not.toContain(1);
    expect([1, 2]).not.toContain(ids(p)[0]);
    // T2 (Alpha's other member) is worth less than alone: Alpha is the teammate's.
    expect(scoreOf(solo, 2)).toBeGreaterThan(0);
    expect(scoreOf(p, 2)).toBe(0);
    expect(p.team!.sharedBonuses).toEqual([{ bonusId: 101, mine: [2], theirs: [1] }]);
    expect(p.rationale.join(' ')).toMatch(/a bonus pays one holder/i);
  });

  it('reports the overlap of my list with the teammate’s by position', () => {
    // The teammate's top is T1; T3 and T5 come lower on their list, and my list may take them.
    const p = plan({ graph: three(), pickable: PICKABLE, team: { teammates: 1, lists: [[1, 3, 5]] } });
    const mine = ids(p);
    const expected = [3, 5]
      .filter((t) => mine.includes(t))
      .map((t) => ({ territoryId: t, mine: mine.indexOf(t) + 1, teammate: 0, theirs: [1, 3, 5].indexOf(t) + 1 }))
      .sort((a, b) => a.mine - b.mine);
    expect(p.team!.overlap).toEqual(expected);
    expect(p.team!.overlap.length).toBeGreaterThan(0);
  });

  it('shortens my list only when it is disjoint from every teammate list', () => {
    // T1 and three isolated pickables on the teammate's list, as long as the client allows (4): mine is
    // disjoint, so it needs my start plus the opponents' (1 × (4 − 1) = 3), not starts × all players (4).
    const disjoint = plan({ graph: three(), pickable: PICKABLE, team: { teammates: 1, lists: [[1, 20, 21, 22]] } });
    expect(ids(disjoint)).toHaveLength(3);
    expect(disjoint.team!.shortened).toEqual({ from: 4, to: 3 });
    // A teammate listing everything my list could take: the lists overlap and mine stays as long as the client allows.
    const overlapping = plan({ graph: three(), pickable: PICKABLE, team: { teammates: 1, lists: [[1, 2, 3, 4, 5, 6]] } });
    expect(ids(overlapping)).toHaveLength(4);
    expect(overlapping.team!.shortened).toBeUndefined();
  });

  it('does not shorten my list while a teammate list is shorter than the client allows', () => {
    // Only T1 on the teammate's list: an opponent taking T1 leaves my teammate to be granted from what is
    // left, one of my picks included, so my list keeps starts × all players and the rationale says why.
    const p = plan({ graph: three(), pickable: PICKABLE, team: { teammates: 1, lists: [[1]] } });
    expect(ids(p)).toHaveLength(4);
    expect(p.team!.shortened).toBeUndefined();
    expect(p.rationale.join(' ')).toMatch(/not shortened: your teammate's list has 1 pick, fewer than the 4 the client allows/);
  });

  it('the teammate’s known start is no threat and is no longer an unknown start', () => {
    // Duo (+3) = {1,2}: 11 reaches it by turn 1 through 10. With the teammate on 11, nobody else can be.
    const g = mkGraph([[1, 2], [1, 10], [10, 11], [11, 12]], [{ id: 201, name: 'Duo', value: 3, territoryIds: [1, 2] }], [20, 21, 22]);
    const pickable = [1, 11, 20, 21, 22];
    const p = plan({ graph: g, pickable, team: { teammates: 1, lists: [[11]] } });
    expect(p.picks[0]!.reasons.join(' | ')).not.toMatch(/T11 can reach it/);
  });
});

describe('the mirrored alternative (C2): the same top picks in both lists', () => {
  // Alpha (+3) = {1,2} and Gamma (+3) = {5,6}, each a pair whose members hold 30 neutrals when not
  // picked: one alone never completes the bonus, both together hold it from the start — a pair that
  // only works in one hand. Isolated pickables 20..23.
  const pairs = () =>
    mkGraph(
      [[1, 2], [5, 6]],
      [
        { id: 101, name: 'Alpha', value: 3, territoryIds: [1, 2] },
        { id: 103, name: 'Gamma', value: 3, territoryIds: [5, 6] },
      ],
      [20, 21, 22, 23],
    );
  const pickable = [1, 2, 5, 6, 20, 21, 22, 23];
  const neutralArmies = new Map([
    [1, 30],
    [2, 30],
    [5, 30],
    [6, 30],
  ]);
  const input = { graph: pairs(), pickable, neutralArmies, territoryLimit: 2, maxPicks: 8 };

  it('lays each pair on the positions a reversing award gives one player, and names the split under a repeating one', () => {
    const p = plan({ ...input, team: { teammates: 1, lists: [[5, 6, 20]] } });
    expect(p.groups.primary.territoryIds.slice().sort()).toEqual([1, 2]);
    const m = p.team!.mirrored!;
    // Reversing, two of us with the same list: one takes positions 1 and 4, the other 2 and 3.
    const [a, b] = p.groups.primary.territoryIds;
    expect(m.top).toEqual([a, 5, 6, b]);
    expect(m.hands).toEqual([
      [a, b],
      [5, 6],
    ]);
    // Repeating: positions 1 and 3, 2 and 4 — both pairs split, and both bonuses are lost.
    expect(m.splits).toEqual([{ order: 'repeating', bonuses: [{ bonusId: 101, picks: [1, 2] }, { bonusId: 103, picks: [5, 6] }] }]);
    // The mirrored list starts with the shared top, then my own fallback.
    expect(m.submitPicks.slice(0, 4)).toEqual(m.top);
    expect(new Set(m.submitPicks).size).toBe(m.submitPicks.length);
    expect(p.rationale.join(' ')).toMatch(/mirrored/i);
  });

  it('never lists more picks than the client allows (players × limit), shortened or not', () => {
    // The two pairs and ten isolated pickables 20..29, so my list can fill all 4 players × 2 = 8 places,
    // and 40..45 on the map but not pickable (a teammate list may carry them).
    const extra = [24, 25, 26, 27, 28, 29];
    const unpickable = [40, 41, 42, 43, 44, 45];
    const wide = {
      ...input,
      graph: mkGraph(
        [[1, 2], [5, 6]],
        [
          { id: 101, name: 'Alpha', value: 3, territoryIds: [1, 2] },
          { id: 103, name: 'Gamma', value: 3, territoryIds: [5, 6] },
        ],
        [20, 21, 22, 23, ...extra, ...unpickable],
      ),
      pickable: [...pickable, ...extra],
    };
    const check = (p: PickPlan) => {
      const m = p.team!.mirrored!;
      expect(m.submitPicks.length).toBeLessThanOrEqual(8);
      expect(m.submitPicks.slice(0, 4)).toEqual(m.top);
      expect(new Set(m.submitPicks).size).toBe(m.submitPicks.length);
      // After the shared top, my own fallback in my list's order.
      const mine = ids(p).filter((t) => !m.top.includes(t));
      expect(m.submitPicks.slice(4)).toEqual(mine.slice(0, m.submitPicks.length - 4));
      return m;
    };
    // A teammate list short of the limit: mine is not shortened and holds all 8 places; the mirror holds 8 too.
    const short = plan({ ...wide, team: { teammates: 1, lists: [[5, 6, 20]] } });
    expect(short.team!.shortened).toBeUndefined();
    expect(ids(short)).toHaveLength(8);
    expect(check(short).submitPicks).toHaveLength(8);
    // A disjoint teammate list as long as the client allows: mine is shortened, the mirror still fits.
    const cut = plan({ ...wide, team: { teammates: 1, lists: [[5, 6, ...unpickable]] } });
    expect(cut.team!.shortened).toEqual({ from: 8, to: 6 });
    check(cut);
  });

  it('is not offered when a teammate’s top is not full', () => {
    const p = plan({ ...input, team: { teammates: 1, lists: [[5]] } });
    expect(p.team!.mirrored).toBeNull();
  });
});

describe('planPicks with more than one teammate (C2, coordination)', () => {
  it('leaves each teammate’s top to them, ignores ids off the map, and offers no mirror while a list is missing', () => {
    // A 3v3: six players, two teammates. Only one teammate's list was read (the other unknown: empty).
    const p = plan({ graph: three(), pickable: PICKABLE, players: 6, maxPicks: 6, team: { teammates: 2, lists: [[999, 1], []] } });
    expect(p.team!.tops).toEqual([[1], []]);
    expect(ids(p)).not.toContain(1);
    expect(p.team!.mirrored).toBeNull();
    expect(p.rationale.join(' ')).toMatch(/Your teammates' lists are read: their top pick \(T1\) is left to them/);
  });

  it('with both lists read, mirrors three start groups on a reversing award', () => {
    const p = plan({ graph: three(), pickable: PICKABLE, players: 6, maxPicks: 6, team: { teammates: 2, lists: [[1], [3]] } });
    const m = p.team!.mirrored!;
    const mine = p.groups.primary.territoryIds;
    // Three of us, one start each: positions 1, 2 and 3.
    expect(m.top).toEqual([...mine, 1, 3]);
    expect(m.hands).toEqual([mine, [1], [3]]);
    expect(m.splits).toEqual([]);
  });
});
