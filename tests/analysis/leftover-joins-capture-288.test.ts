// #288: a leftover never idles on a source that has nothing left to attack once this turn's captures
// land: it goes with the capture whose target the next step starts from. Every map, id and name here
// is made up.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { syntheticInput } from './golden/corpus.js';
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

describe('#288 (second half): the extra goes with a capture only as far as its next step needs', () => {
  // T1 (5) borders T2 and T3, neutrals of 2 it takes this turn, and nothing else. T2 leads on to T4,
  // T3 to T5. Each capture lands 2, 1 of them movable. Income 10: a leftover of 8.
  const chain = (t4: number, t5: number) =>
    planTurn({
      graph: buildGraph(
        makeMap(
          [1, 2, 3, 4, 5],
          [
            [1, 2],
            [1, 3],
            [2, 4],
            [3, 5],
          ],
          [[901, 3, [2, 3, 4, 5]]],
        ),
      ),
      board: board([mine(1, 5), neutral(2, 2), neutral(3, 2), neutral(4, t4), neutral(5, t5)]),
      me: ME,
      income: 10,
      settings: STD,
    });

  it('sizes each attack to what the next step from its target needs', () => {
    // T4, a neutral of 4, takes 6: 5 more than lands movable. T5, a neutral of 2, takes 3: 2 more.
    // The 8 cover both, and the 1 left goes to the attack with the least extra: 3 + 5 and 3 + 2 + 1
    // (#402 split them 7 and 7, and T2's 5 movable fell short of T4 next turn).
    const p = chain(4, 2);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([
      [1, 2, 8],
      [1, 3, 6],
    ]);
    expect(why(p)).toMatch(/Deploy the leftover 8 to T1 \(#1\) and send it with the attack on T2 \(#2\) \(3 → 8\) and the attack on T3 \(#3\) \(3 → 6\) \(#288\)/);
    expect(why(p)).toMatch(/T4 \(#4\) beside T2 \(#2\) takes 6, 5 more than the 1 that would land movable; T5 \(#5\) beside T3 \(#3\) takes 3, 2 more/);
  });

  it('funds only a need the leftover covers whole, and evens out the rest as #402 did', () => {
    // T4 needs 2; T5, a neutral of 6, takes 10: 9 more, beyond the 6 left, so it is not funded. The
    // rest evens the extras out: 7 and 7, as #402 sent.
    const p = chain(2, 6);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([
      [1, 2, 7],
      [1, 3, 7],
    ]);
    expect(why(p)).toMatch(/T4 \(#4\) beside T2 \(#2\) takes 3, 2 more than the 1 that would land movable/);
    expect(why(p)).not.toMatch(/T5 \(#5\) beside T3/);
  });

  it('offers the rest to another capture this turn, which rule 5b takes', () => {
    // A synthetic corpus board (#133): the expansion stack's attack out of T2009 needs nothing more
    // for its next step, and T2020, which stayed to hold its border, takes the 5-neutral T2021 with
    // the rest (#402 sent all of it with the attack out of T2009).
    const p = planTurn(syntheticInput(21484));
    expect(why(p)).toMatch(/Deploy 18 of the leftover to T2020 \(#2020\) for another capture this turn \(#288\)/);
    expect(attacks(p).some((m) => m.from === 2020 && m.to === 2021)).toBe(true);
    expect(p.expected.captures).toContain(2021);
    expect(why(p)).not.toMatch(/Deploy the leftover \d+ to T2009/);
  });

  it('sends the rest with the attacks after all when rule 5b takes nothing where it was offered', () => {
    // Another corpus board: the rest is offered to T2002 for T2004, which rule 5b refuses, so it rides
    // the attack out of T2016 as in #402 and the offer leaves no trace.
    const p = planTurn(syntheticInput(1520));
    expect(why(p)).not.toMatch(/for another capture this turn/);
    expect(why(p)).toMatch(/Deploy the leftover 3 to T2016 \(#2016\) and send it with the attack on T2014 \(#2014\) \(2 → 5\) \(#288\)/);
    expect(p.deploys.some((d) => d.territoryId === 2002 && d.armies > 0)).toBe(false);
    expect(p.expected.captures).not.toContain(2004);
  });
});
