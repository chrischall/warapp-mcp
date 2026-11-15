// Team-aware picks, the correctness step (C2, docs/PLAN-TEAMS.md): opponents are the players not on my
// team in the threat model, and the award order a team game uses is not settled, so both orders that
// fit are enumerated. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import { readAward } from '../../src/analysis/award.js';
import { buildGraph, type MapGraph } from '../../src/analysis/graph.js';
import { pickOutcomes, planPicks, type PickPlan, type PickSettings, type PlanPicksInput } from '../../src/analysis/picks.js';
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
const key = (o: number[]) => o.join(',');

describe('planPicks in a team game — a teammate is no threat (C2)', () => {
  // Duo (+3) = {1,2}: pick 1 takes 2 on turn 1; 11 reaches it by turn 1 through 10. Isles 20..23
  // are pickable but connected to nothing: other places a player may start (as in picks-scoring).
  const g = () =>
    mkGraph([[1, 2], [1, 10], [10, 11], [11, 12]], [{ id: 201, name: 'Duo', value: 3, territoryIds: [1, 2] }], [20, 21, 22, 23]);
  const pickable = [1, 11, 20, 21, 22, 23];

  it('without a team, four players are three opponents: three unknown starts among five', () => {
    // 1 − C(4,3)/C(5,3) = 0.6; with four players an entry point weighs 0.05.
    const p = plan({ graph: g(), pickable, players: 4, maxPicks: 1 });
    expect(scoreOf(p, 1)).toBe(6); // 9 / 1.05 × (1 − 0.5 × 0.6)
    expect(reasonsOf(p, 1)).toContain('T11 can reach it by turn 2 (score −30%)');
  });

  it('in a 2v2 my teammate starts nowhere that threatens me: two opponent starts unknown among five', () => {
    // 1 − C(4,2)/C(5,2) = 0.4: the threat of a three-player game, whatever the teammate picks.
    const p = plan({ graph: g(), pickable, players: 4, maxPicks: 1, team: { teammates: 1 } });
    expect(scoreOf(p, 1)).toBe(6.86); // 9 / 1.05 × (1 − 0.5 × 0.4)
    expect(reasonsOf(p, 1)).toContain('T11 can reach it by turn 2 (score −20%)');
    expect(p.rationale.join(' ')).toMatch(/team game: 2 opponents/);
  });

  it('a known start of another player (a lost pick) is still taken as an opponent’s: the worst case', () => {
    // Big (+5) = {11,13} makes 11 the primary; the fallback 1 is granted only when someone else holds
    // 11, which reaches Duo. In a team game that someone may be my teammate, but the worst is an opponent.
    const two = mkGraph(
      [[1, 2], [1, 10], [10, 11], [11, 13]],
      [
        { id: 201, name: 'Duo', value: 3, territoryIds: [1, 2] },
        { id: 202, name: 'Big', value: 5, territoryIds: [11, 13] },
      ],
    );
    const p = plan({ graph: two, pickable: [1, 11], players: 4, team: { teammates: 1 } });
    expect(p.picks.map((x) => x.territoryId)).toEqual([11, 1]);
    expect(reasonsOf(p, 1)).toContain("T11 (another player's when this pick is granted) can reach it by turn 2 (score −50%)");
  });

  it('a known start that is no threat may be my teammate’s: the opponent starts still unknown stay', () => {
    // Big (+5) = {30,31} makes 30 the primary; the fallback 1 is granted only when someone else holds
    // 30, far from Duo. In a 2v2 with one start each that someone may be my teammate, so both opponent
    // starts stay unknown among the four pickables left (11 among them): 1 − C(3,2)/C(4,2) = 0.5.
    const map = mkGraph(
      [[1, 2], [1, 10], [10, 11], [11, 12], [30, 31]],
      [
        { id: 201, name: 'Duo', value: 3, territoryIds: [1, 2] },
        { id: 203, name: 'Big', value: 5, territoryIds: [30, 31] },
      ],
      [20, 21, 22],
    );
    const p = plan({ graph: map, pickable: [1, 11, 20, 21, 22, 30], players: 4, team: { teammates: 1 } });
    expect(p.picks.map((x) => x.territoryId)).toEqual([30, 1]);
    expect(reasonsOf(p, 1)).toContain('T11 can reach it by turn 2 (score −25%)');
  });

  it('two players stay a duel, team or not: the 1v1 rules hold', () => {
    const duel = plan({ graph: g(), pickable, maxPicks: 1 });
    const teamed = plan({ graph: g(), pickable, maxPicks: 1, team: { teammates: 0 } });
    expect(teamed.picks).toEqual(duel.picks);
    expect(scoreOf(teamed, 1)).toBe(7.36);
  });
});

describe('pickOutcomes — the award order of a team game is not settled (C2)', () => {
  it('defaults to the reversing order, unchanged', () => {
    expect(pickOutcomes({ listLength: 6, perPlayer: 3, players: 2, orders: ['reversing'] })).toEqual(
      pickOutcomes({ listLength: 6, perPlayer: 3, players: 2 }),
    );
  });

  it('a repeating order (the same each round) can grant sets the reversing one cannot', () => {
    // A 2v2, two starts each, a list of six. Reversing, the last of round 1 picks again at once;
    // repeating, three players come between each of my picks, so the fourth awarded can lose the
    // top three and then two more: positions 3 and 5 (0-based), or the list runs out after 2 or 3.
    const reversing = pickOutcomes({ listLength: 6, perPlayer: 2, players: 4 })!;
    const repeating = pickOutcomes({ listLength: 6, perPlayer: 2, players: 4, orders: ['repeating'] })!;
    const both = pickOutcomes({ listLength: 6, perPlayer: 2, players: 4, orders: ['reversing', 'repeating'] })!;
    const only = repeating.map(key).filter((k) => !reversing.map(key).includes(k));
    expect(only).toEqual(['2', '3', '3,5']);
    // Both orders: the union of the two, sorted as before.
    expect(new Set(both.map(key))).toEqual(new Set([...reversing, ...repeating].map(key)));
    expect(both.length).toBe(new Set([...reversing, ...repeating].map(key)).size);
  });

  it('planPicks in a team game judges the list by both orders and says so', () => {
    const g = mkGraph(
      [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8]],
      [
        { id: 100, name: 'West', value: 3, territoryIds: [1, 2] },
        { id: 101, name: 'East', value: 3, territoryIds: [7, 8] },
      ],
    );
    const input = { graph: g, pickable: [1, 2, 4, 5, 7, 8], players: 4, territoryLimit: 1, maxPicks: 4 };
    const ffa = plan(input);
    const team = plan({ ...input, team: { teammates: 1 } });
    expect(ffa.award!.orders).toBeUndefined();
    expect(team.award!.orders).toEqual(['reversing', 'repeating']);
    expect(team.award!.outcomes).toBe(
      pickOutcomes({ listLength: 4, perPlayer: 1, players: 4, orders: ['reversing', 'repeating'] })!.length,
    );
    expect(team.rationale.join(' ')).toMatch(/award order of a team game is not settled/);
    expect(ffa.rationale.join(' ')).not.toMatch(/team game/);
  });
});

describe('readAward — a team game (C2)', () => {
  const list = (n: number) => Array.from({ length: n }, (_, i) => 101 + i);
  const at = (...numbers: number[]) => numbers.map((k) => 100 + k);

  it('a lost pick the first board shows as a teammate’s is the teammate’s start, not an opponent’s', () => {
    // Four players, two starts each: granted list numbers 1 and 4, so 2 and 3 were taken first.
    const r = readAward({ list: list(8), mine: at(1, 4), players: 4, teammateHeld: at(3) })!;
    expect(r.opponentStarts).toEqual(at(2));
    expect(r.teammateStarts).toEqual(at(3));
    expect(r.allStartsKnown).toBe(false);
  });

  it('without the team the reading is unchanged and carries no teammate field', () => {
    const r = readAward({ list: list(8), mine: at(1, 4), players: 4 })!;
    expect(r.opponentStarts).toEqual(at(2, 3));
    expect(r).not.toHaveProperty('teammateStarts');
  });
});
