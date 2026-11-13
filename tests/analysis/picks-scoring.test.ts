// Pick scoring (#166): double borders, who can reach a bonus, two orders for one capture, and a
// two-player fallback that answers the loss granting it. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { entryTouches } from '../../src/analysis/bonuses.js';
import { buildGraph, type MapGraph } from '../../src/analysis/graph.js';
import {
  impliedOpponentStarts,
  OPPONENT_WEIGHT,
  planPicks,
  THREAT_LOSS,
  type PickPlan,
  type PickSettings,
  type PlanPicksInput,
} from '../../src/analysis/picks.js';
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

describe('planPicks — a completed bonus is credited by who can reach it (#166)', () => {
  // Duo (+3) = {1,2}: pick 1 takes 2 on turn 1. Its one entry point is 10; 11 lies behind 10, 12
  // behind 11. Isles 20..23 are pickable but connected to nothing: other places an opponent may start.
  // A lone stack (5 armies, 1 guarding, +5 a turn) on 11 takes 10 on turn 1 and stands next to Duo;
  // from 12 it needs two turns.
  const g = () =>
    mkGraph([[1, 2], [1, 10], [10, 11], [11, 12]], [{ id: 201, name: 'Duo', value: 3, territoryIds: [1, 2] }], [20, 21, 22, 23]);
  const isles = [20, 21, 22, 23];
  // A first-turn +3 with one entry point in a 1v1: 3 × 3 / 1.1.
  const FULL = 8.18;

  it('exports the share of the credit a certain threat costs', () => {
    expect(THREAT_LOSS).toBe(0.5);
  });

  it('a bonus no other pickable territory can reach in time keeps its whole credit', () => {
    const p = plan({ graph: g(), pickable: [1, 12, ...isles], maxPicks: 1 });
    expect(scoreOf(p, 1)).toBe(FULL);
    expect(reasonsOf(p, 1)).toContain('no other pickable territory can reach it by turn 2');
    expect(p.groups.primary.bonuses).toEqual([{ bonusId: 201, name: 'Duo', value: 3, turn: 1, threats: [] }]);
  });

  it('one that a pickable territory reaches by its completion turn loses THREAT_LOSS × the chance an opponent starts there', () => {
    // Five pickables are not mine, one of them (11) reaches Duo, the opponent has one start: 1 in 5.
    const p = plan({ graph: g(), pickable: [1, 11, ...isles], maxPicks: 1 });
    expect(scoreOf(p, 1)).toBe(7.36); // 9 / 1.1 × (1 − 0.5 × 1/5)
    expect(reasonsOf(p, 1)).toContain('T11 can reach it by turn 2 (score −10%), safe only if you also hold T11');
    expect(p.groups.primary.bonuses[0]!.threats).toEqual([11]);
  });

  it('the chance grows with the opponent starts still unknown', () => {
    // Three players, one start each: two unknown starts among five, 1 − C(4,2)/C(5,2) = 0.4.
    // (With three players an entry point weighs 0.05, and no pick here is more central than another.)
    const p = plan({ graph: g(), pickable: [1, 11, ...isles], players: 3, maxPicks: 1 });
    expect(scoreOf(p, 1)).toBe(6.86); // 9 / 1.05 × (1 − 0.5 × 0.4)
    expect(reasonsOf(p, 1)).toContain('T11 can reach it by turn 2 (score −20%)');
  });

  it('listing the threatening neighbour and being granted it restores the credit', () => {
    const p = plan({ graph: g(), pickable: [1, 11, ...isles], territoryLimit: 2, maxPicks: 2 });
    expect([...p.groups.primary.territoryIds].sort((a, b) => a - b)).toEqual([1, 11]);
    expect(p.groups.primary.score).toBe(FULL);
    expect(p.groups.primary.bonuses).toEqual([{ bonusId: 201, name: 'Duo', value: 3, turn: 1, threats: [] }]);
    // Alone, pick 1 is still scored and told what it depends on: two opponent starts unknown
    // among the five pickables not mine, 1 − C(4,2)/C(5,2) = 0.4.
    expect(scoreOf(p, 1)).toBe(6.55); // 9 / 1.1 × (1 − 0.5 × 0.4)
    expect(reasonsOf(p, 1)).toContain('T11 can reach it by turn 2 (score −20%), safe only if you also hold T11');
  });

  it('a known opponent start that reaches it costs the full THREAT_LOSS', () => {
    // Big (+5) = {11,13} makes 11 the primary; the fallback 1 is granted only when someone else
    // holds 11, and 11 reaches Duo by turn 1.
    const two = mkGraph(
      [[1, 2], [1, 10], [10, 11], [11, 13]],
      [
        { id: 201, name: 'Duo', value: 3, territoryIds: [1, 2] },
        { id: 202, name: 'Big', value: 5, territoryIds: [11, 13] },
      ],
    );
    const p = plan({ graph: two, pickable: [1, 11] });
    expect(p.picks.map((x) => x.territoryId)).toEqual([11, 1]);
    expect(scoreOf(p, 1)).toBe(4.09); // 9 / 1.1 × 0.5
    expect(reasonsOf(p, 1)).toContain('T11 (another player\'s when this pick is granted) can reach it by turn 2 (score −50%)');
    expect(reasonsOf(p, 1)).not.toMatch(/safe only if/);
    expect(p.groups.fallback.bonuses[0]!.threats).toEqual([11]);
  });

  it('a single-territory bonus is threatened only by the pickables next to it', () => {
    const solo = () => mkGraph([[1, 2], [2, 3]], [{ id: 301, name: 'Solo', value: 2, territoryIds: [1] }], isles);
    const near = plan({ graph: solo(), pickable: [1, 2, ...isles], maxPicks: 1 });
    expect(reasonsOf(near, 1)).toContain('T2 can reach it by turn 1 (score −10%), safe only if you also hold T2');
    const far = plan({ graph: solo(), pickable: [1, 3, ...isles], maxPicks: 1 });
    expect(reasonsOf(far, 1)).toContain('no other pickable territory can reach it by turn 1');
    expect(scoreOf(far, 1)).toBeGreaterThan(scoreOf(near, 1));
  });

  it('a wasteland in the way keeps a neighbour from reaching it in time', () => {
    // 10 holds 10 armies (16 to take): the stack on 11 sends 9 on turn 1, 14 on turn 2, 19 on turn 3.
    const p = plan({ graph: g(), pickable: [1, 11, ...isles], maxPicks: 1, neutralArmies: new Map([[10, 10]]) });
    expect(scoreOf(p, 1)).toBe(FULL);
    expect(reasonsOf(p, 1)).toContain('no other pickable territory can reach it by turn 2');
  });

  it('names three threats at most, and promises safety only for one or two', () => {
    // 11..15 all hang off the entry point 10.
    const fan = mkGraph(
      [[1, 2], [1, 10], [10, 11], [10, 12], [10, 13], [10, 14], [10, 15]],
      [{ id: 201, name: 'Duo', value: 3, territoryIds: [1, 2] }],
    );
    const five = plan({ graph: fan, pickable: [1, 11, 12, 13, 14, 15], maxPicks: 1 });
    expect(reasonsOf(five, 1)).toContain('T11, T12, T13 and 2 more can reach it by turn 2 (score −50%)');
    expect(reasonsOf(five, 1)).not.toMatch(/safe only if/);
    expect(five.groups.primary.bonuses[0]!.threats).toEqual([11, 12, 13, 14, 15]);
    const two = plan({ graph: fan, pickable: [1, 11, 12], maxPicks: 1 });
    expect(reasonsOf(two, 1)).toContain('T11 and T12 can reach it by turn 2 (score −50%), safe only if you also hold T11 and T12');
  });

  it('a bonus still incomplete at the horizon is not discounted', () => {
    // Long (+10) is far from done after three turns: only its progress counts, as before.
    const long = mkGraph(
      [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [1, 10], [10, 11]],
      [{ id: 401, name: 'Long', value: 10, territoryIds: [1, 2, 3, 4, 5, 6, 7, 8] }],
    );
    const alone = plan({ graph: long, pickable: [1], maxPicks: 1 });
    const watched = plan({ graph: long, pickable: [1, 11], maxPicks: 1 });
    expect(scoreOf(watched, 1)).toBe(scoreOf(alone, 1));
    expect(reasonsOf(watched, 1)).not.toMatch(/can reach it/);
  });
});

describe('planPicks — two orders for one capture (#166)', () => {
  // No income, so only the armies on the picks count: 5 on a pick, 4 of them movable.
  const BARE: PickSettings = { ...STD, minimumArmyBonus: 0 };

  describe('one source: 1 army, then 3, takes a 3-army neutral that costs 5 in one order', () => {
    // Duo (+3) = {1,2}; 2 holds 3 armies. At 60/70 one army kills one of the three (and dies);
    // three then take the two left.
    const g = () => mkGraph([[1, 2]], [{ id: 501, name: 'Duo', value: 3, territoryIds: [1, 2] }]);
    const run = (settings: PickSettings) =>
      plan({ graph: g(), pickable: [1], maxPicks: 1, neutralArmies: new Map([[2, 3]]), settings });

    it('completes the bonus on turn 1 with 4 armies, and says how', () => {
      const p = run(BARE);
      expect(p.groups.primary.bonuses).toEqual([{ bonusId: 501, name: 'Duo', value: 3, turn: 1, threats: [] }]);
      expect(p.groups.primary.twoOrderCaptures).toEqual([
        { turn: 1, territoryId: 2, orders: [{ from: 1, armies: 1 }, { from: 1, armies: 3 }] },
      ]);
      expect(reasonsOf(p, 1)).toMatch(/Duo \(\+3\): first-turn bonus/);
      expect(pick(p, 1).reasons).toContain('Duo (+3) needs two orders on T2: 1 army first, then 3');
    });

    it('one order is still one order when it can be paid for', () => {
      const p = run({ ...BARE, minimumArmyBonus: 1 });
      expect(p.groups.primary.bonuses[0]!.turn).toBe(1);
      expect(p.groups.primary.twoOrderCaptures).toEqual([]);
      expect(reasonsOf(p, 1)).not.toMatch(/two orders/);
    });

    for (const [label, extra] of [
      ['luck above 0', { luckModifier: 0.1 }],
      ['another rounding mode', { roundingMode: 'WeightedRandom' }],
      ['No-Split', { noSplit: true }],
    ] as Array<[string, PickSettings]>) {
      it(`with ${label} the capture waits, as before`, () => {
        const p = run({ ...BARE, ...extra });
        expect(p.groups.primary.bonuses).toEqual([]);
        expect(p.groups.primary.twoOrderCaptures).toEqual([]);
        expect(reasonsOf(p, 1)).toMatch(/Duo \(\+3\): 1 of 2 territories by turn 3/);
        expect(reasonsOf(p, 1)).not.toMatch(/two orders/);
      });
    }
  });

  it('two sources: 3 then 3 take a 4-army neutral that needs 6 in one order', () => {
    // Picks 1 and 2 (4 armies each, 3 movable) both border 10, the one-territory Target (+5).
    // The first 3 kill two of the four; the second 3 take the two left.
    const g = mkGraph([[1, 10], [2, 10]], [{ id: 502, name: 'Target', value: 5, territoryIds: [10] }]);
    const input = { graph: g, pickable: [1, 2], territoryLimit: 2, maxPicks: 2, neutralArmies: new Map([[10, 4]]) };
    const p = plan({ ...input, settings: { ...BARE, initialPlayerArmiesPerTerritory: 4 } });
    expect(p.groups.primary.bonuses).toEqual([{ bonusId: 502, name: 'Target', value: 5, turn: 1, threats: [] }]);
    expect(p.groups.primary.twoOrderCaptures).toEqual([
      { turn: 1, territoryId: 10, orders: [{ from: 1, armies: 3 }, { from: 2, armies: 3 }] },
    ]);
    // A pick's reasons are its opening alone: neither takes Target by itself.
    expect(reasonsOf(p, 1)).not.toMatch(/two orders/);
    const split = plan({ ...input, settings: { ...BARE, initialPlayerArmiesPerTerritory: 4, noSplit: true } });
    expect(split.groups.primary.bonuses).toEqual([]);
  });

  it('prefers the fewest armies, then one source over two, then the lower ids', () => {
    // Picks 1 and 2 (4 movable each) border 10 with 3 armies: 1 + 3 from one pick, or 1 from one
    // and 3 from the other, both commit 4. One source wins, and the lower id.
    const g = mkGraph([[1, 10], [2, 10]], [{ id: 502, name: 'Target', value: 5, territoryIds: [10] }]);
    const p = plan({
      graph: g,
      pickable: [1, 2],
      territoryLimit: 2,
      maxPicks: 2,
      neutralArmies: new Map([[10, 3]]),
      settings: BARE,
    });
    expect(p.groups.primary.twoOrderCaptures).toEqual([
      { turn: 1, territoryId: 10, orders: [{ from: 1, armies: 1 }, { from: 1, armies: 3 }] },
    ]);
  });

  it('the first attack’s armies are spent for the turn; its survivors stay on their source', () => {
    // At 60/30: picks 1 and 2 (3 movable each) border 10, the one-territory Target (+9) with 4
    // armies (6 in one order). 3 from pick 1 kill two and lose one; 3 from pick 2 take the rest.
    // Pick 1 also borders 20, the one-territory Side (+1) with 1 army (1 to take). The two
    // survivors cannot take it on turn 1 (they have attacked), and do on turn 2.
    const g = mkGraph([[1, 10], [2, 10], [1, 20]], [
      { id: 502, name: 'Target', value: 9, territoryIds: [10] },
      { id: 503, name: 'Side', value: 1, territoryIds: [20] },
    ]);
    const p = plan({
      graph: g,
      pickable: [1, 2],
      territoryLimit: 2,
      maxPicks: 2,
      neutralArmies: new Map([[10, 4], [20, 1]]),
      settings: { ...BARE, initialPlayerArmiesPerTerritory: 4, defensiveKillRate: 30 },
    });
    expect(p.groups.primary.twoOrderCaptures).toEqual([
      { turn: 1, territoryId: 10, orders: [{ from: 1, armies: 3 }, { from: 2, armies: 3 }] },
    ]);
    expect(p.groups.primary.bonuses.map((b) => [b.name, b.turn])).toEqual([['Target', 1], ['Side', 2]]);
  });
});

describe('planPicks — in a two-player game each fallback pick answers the loss that grants it (#166)', () => {
  // West (+12) = {1} and East (+12) = {2}, two hops apart through 9: the primary. 3 hangs off 1,
  // a +2 single of its own (NearW; 5 is a dead end with a corridor behind it). 21 and 22, at the
  // end of that corridor, are +2 singles next to each other: a second plan elsewhere. `mirror`
  // adds 4 off 2 (NearE), making West and East alike.
  const duelMap = (farValue = 2, mirror = false) =>
    mkGraph(
      [
        [1, 9], [9, 2], [1, 3], [3, 5],
        [5, 40], [40, 41], [41, 42], [42, 21], [42, 22], [21, 22],
        ...(mirror ? ([[2, 4], [4, 6]] as Edge[]) : []),
      ],
      [
        { id: 601, name: 'West', value: 12, territoryIds: [1] },
        { id: 602, name: 'East', value: 12, territoryIds: [2] },
        { id: 603, name: 'NearW', value: 2, territoryIds: [3] },
        ...(mirror ? [{ id: 604, name: 'NearE', value: 2, territoryIds: [4] }] : []),
        { id: 605, name: 'FarA', value: farValue, territoryIds: [21] },
        { id: 606, name: 'FarB', value: farValue, territoryIds: [22] },
      ],
    );
  const pickable = [1, 2, 3, 21, 22];
  const ids = (p: PickPlan) => p.picks.map((x) => x.territoryId);
  const fallbackOf = (p: PickPlan) => p.picks.filter((x) => x.group === 'fallback').map((x) => x.territoryId);
  const allReasons = (p: PickPlan) => p.picks.flatMap((x) => x.reasons).join(' | ');
  const duel = { pickable, territoryLimit: 2, maxPicks: 4 };

  it('exports the weight of the opponent’s opening', () => {
    expect(OPPONENT_WEIGHT).toBe(0.5);
  });

  it('lists third the pick that stands next to a lost pick’s bonus, not a second plan elsewhere', () => {
    const p = plan({ graph: duelMap(), ...duel });
    // East has nothing pickable near it, so 2 scores more than 1 and comes first. The third pick
    // is granted when 1 or 2 went to the opponent. With 1 lost, 3 stands next to West and holds
    // NearW, which the opponent would take from 1; with 1 kept, it takes away West's one threat.
    // The fourth is granted when 1 and 3 are both lost: nothing answers that, so it is the best
    // start elsewhere.
    expect(ids(p)).toEqual([2, 1, 3, 21]);
    expect(p.groups.fallback.territoryIds).toEqual([3, 21]);
    expect(p.award!.reordered).toBe(false);
    // (Alone, pick 1 also takes NearW: the bonus worth most to it is named, the rest counted.)
    expect(pick(p, 3).reasons).toContain('Answers the loss of T1: reaches West by turn 1 (and 1 more of its bonuses)');
    expect(reasonsOf(p, 21)).not.toMatch(/Answers the loss/);
  });

  it('a fallback pick’s score and reasons are still its opening with the primary taken', () => {
    const p = plan({ graph: duelMap(), ...duel });
    // NearW (+2, two entry points) held at once pays 4 turns; pick 1, next to it, is the opponent's.
    expect(scoreOf(p, 3)).toBe(3.33); // 8 / 1.2 × 0.5
    expect(pick(p, 3).reasons[0]).toMatch(/^Anchors NearW \(\+2\): held at once/);
    expect(reasonsOf(p, 3)).toContain("T1 (another player's when this pick is granted) can reach it by turn 1 (score −50%)");
    // The fallback group is its first tier, scored with the primary taken: NearW halved, FarA
    // at once (8 / 1.2) and FarB on turn 1 (6 / 1.2).
    expect(p.groups.fallback.score).toBe(15);
    expect(p.groups.fallback.bonuses.map((b) => b.name)).toEqual(['NearW', 'FarA', 'FarB']);
  });

  it('the pick’s own bonus still counts: a better start elsewhere is listed before the answer', () => {
    const p = plan({ graph: duelMap(4), ...duel });
    expect(p.groups.primary.territoryIds).toEqual([2, 1]);
    expect(fallbackOf(p)[0]).toBe(21);
  });

  it('says so in the rationale, and no longer speaks of another area', () => {
    const r = plan({ graph: duelMap(), ...duel }).rationale.join(' ');
    expect(r).toMatch(/In a 1v1 .*each fallback pick is chosen for the outcomes that grant it/);
    expect(r).not.toMatch(/another area/);
  });

  it('the award report describes the list as it is submitted', () => {
    const p = plan({ graph: duelMap(), ...duel });
    expect(p.award!.outcomes).toBe(4);
    expect(p.award!.worst.territoryIds.every((t) => ids(p).includes(t))).toBe(true);
    expect(p.award!.worst.opponentStarts).toEqual(impliedOpponentStarts(ids(p), p.award!.worst.territoryIds));
  });

  it('when the award order reorders the primary, the fallback is chosen again for the new order', () => {
    // With West and East alike, score order lists 1, 2 and then 3 and 4 (each next to one of
    // them). Listing 2 first is better at worst: the third pick, 3, then always comes with 1 or
    // answers its loss. For that order the fourth pick is granted when 1 and 3 are lost, where 4
    // (next to my own 2) answers nothing: the list ends on the start elsewhere instead.
    const p = plan({ graph: duelMap(2, true), pickable: [1, 2, 3, 4, 21, 22], territoryLimit: 2, maxPicks: 4 });
    expect(p.award!.reordered).toBe(true);
    expect(ids(p)).toEqual([2, 1, 3, 21]);
    expect(p.award!.worst.opponentStarts).toEqual(impliedOpponentStarts(ids(p), p.award!.worst.territoryIds));
    expect(p.rationale.join(' ')).toMatch(/ordered to raise that worst outcome/);
  });

  it('is deterministic, whatever order the pickables come in', () => {
    const a = plan({ graph: duelMap(), ...duel });
    expect(plan({ graph: duelMap(), ...duel })).toEqual(a);
    expect(plan({ graph: duelMap(), ...duel, pickable: [22, 21, 3, 2, 1] })).toEqual(a);
  });

  it('with three players the fallback is a compact group, as before', () => {
    const p = plan({ graph: duelMap(), ...duel, players: 3 });
    expect([...p.groups.primary.territoryIds].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...fallbackOf(p)].sort((a, b) => a - b)).toEqual([21, 22]);
    expect(allReasons(p)).not.toMatch(/Answers the loss/);
    expect(p.rationale.join(' ')).not.toMatch(/each fallback pick is chosen/);
  });

  it('with spread: true the fallback is a compact group, as before', () => {
    const p = plan({ graph: duelMap(), ...duel, spread: true });
    expect([...p.groups.primary.territoryIds].sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...fallbackOf(p)].sort((a, b) => a - b)).toEqual([21, 22]);
    expect(allReasons(p)).not.toMatch(/Answers the loss/);
    expect(p.rationale.join(' ')).not.toMatch(/each fallback pick is chosen/);
  });

  it('a primary of one pick keeps the old rule', () => {
    const p = plan({ graph: duelMap(), pickable, territoryLimit: 1, maxPicks: 2 });
    expect(p.picks).toHaveLength(2);
    expect(allReasons(p)).not.toMatch(/Answers the loss/);
    expect(p.rationale.join(' ')).toMatch(/in another area when one scores as much/);
  });

  it('a list too short for a whole second tier keeps the old rule', () => {
    const p = plan({ graph: duelMap(), pickable, territoryLimit: 2, maxPicks: 3 });
    expect(p.picks).toHaveLength(3);
    expect(allReasons(p)).not.toMatch(/Answers the loss/);
    expect(p.rationale.join(' ')).toMatch(/in another area when one scores as much/);
  });
});
