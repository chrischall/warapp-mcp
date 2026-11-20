// #288: a leftover never idles on a source that has nothing left to attack once this turn's captures
// land: it goes with the capture whose target the next step starts from. Every map, id and name here
// is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
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
}
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const why = (p: TurnPlan) => p.rationale.join('\n');

describe('#288: the leftover goes with the capture the next step starts from', () => {
  // T1 (4) borders only T2, a 2-army neutral; T2 is the only way into T3 and T4 (2 each), the rest
  // of bonus B901 (+3). Once T2 falls, T1 has nothing left to attack: a leftover there idles.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4],
      [
        [1, 2],
        [2, 3],
        [2, 4],
      ],
      [[901, 3, [2, 3, 4]]],
    ),
  );
  const plan = planTurn({ graph: g, board: board([mine(1, 4), neutral(2, 2), neutral(3, 2), neutral(4, 2)]), me: ME, income: 5, settings: STD });

  it('sends the whole stack at T2 rather than leaving the leftover on T1', () => {
    expect(attacks(plan).map((m) => [m.from, m.to, m.armies])).toEqual([[1, 2, 8]]);
    expect(plan.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
    expect(attacks(plan)[0]!.winChance).toBe(1);
    expect(why(plan)).not.toMatch(/the stack working on the top expansion/);
    expect(why(plan)).toMatch(/Deploy the leftover 5 to T1 \(#1\) and send it with the attack on T2 \(#2\) \(3 → 8\) \(#288\)/);
  });

  it('keeps the leftover on a source that still has something to attack', () => {
    // T1 also borders T5, a neutral of 6 this turn does not take: the leftover stays to work on it.
    const g5 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5],
        [
          [1, 2],
          [2, 3],
          [2, 4],
          [1, 5],
        ],
        [[901, 3, [2, 3, 4]]],
      ),
    );
    const p = planTurn({
      graph: g5,
      board: board([mine(1, 4), neutral(2, 2), neutral(3, 2), neutral(4, 2), neutral(5, 6)]),
      me: ME,
      income: 5,
      settings: STD,
    });
    expect(why(p)).not.toMatch(/\(#288\)/);
  });
});
