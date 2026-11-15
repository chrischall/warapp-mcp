// #265: a member of a bonus this turn's captures complete that faces an enemy and is short of its
// hold. The leftover (rule 5) brings it to its hold before any comfort margin on a border that
// already holds, and a combined capture (#17) it is a source of is rebalanced, at the same kills,
// to leave armies on it. Every map, id and name here is made up.
//
//   Vale  (+5): 1 2 3   — 3 is the enemy's 19-stack; taking it completes Vale
//   Ridge (+7): 5 6     — a held bonus; 5 faces the enemy's 7
//
//   1─3, 2─3, 1─2, 1─4, 2─5, 5─6, 5─7, 4─8, 7─8   (4, 7, 8: the enemy's 1-army territories)
//
// After the capture of 3, my 1 faces only the enemy's empty 4, which can deploy 5 there.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const EDGES: [number, number][] = [[1, 3], [2, 3], [1, 2], [1, 4], [2, 5], [5, 6], [5, 7], [4, 8], [7, 8]];
const IDS = [1, 2, 3, 4, 5, 6, 7, 8];
const MAP: GameMap = {
  id: 1,
  name: 'Marches',
  territories: IDS.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: EDGES.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [
    { id: 301, name: 'Vale', value: 5, territoryIds: [1, 2, 3], bonusIds: [] },
    { id: 302, name: 'Ridge', value: 7, territoryIds: [5, 6], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(MAP);
const theirs = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: FOE },
  armies,
});
const marches = (one: number, two: number): BoardState => {
  const entries = [mine(1, one), mine(2, two), theirs(3, 19), theirs(4, 1), mine(5, 4), mine(6, 1), theirs(7, 1), theirs(8, 1)];
  const listed = new Set(entries.map((t) => t.territoryId));
  return board([...entries, ...IDS.filter((id) => !listed.has(id)).map(fogged)]);
};
const plan = (one: number, two: number, income: number): TurnPlan =>
  planTurn({ graph: g, board: marches(one, two), me: ME, income, settings: STD, options: { goal: 'complete-bonus' } });
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack').map((m) => [m.from, m.to, m.armies]);
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
/** What stays on my `id` once the plan's deploys land and its orders leave (survivors aside). */
const staysOn = (p: TurnPlan, one: number, two: number, id: number) =>
  marches(one, two).territories.find((t) => t.territoryId === id)!.armies! +
  deployedTo(p, id) -
  p.moves.filter((m) => m.from === id).reduce((n, m) => n + m.armies, 0);

describe('#265: a weak member of a bonus completed this turn', () => {
  it('gets the leftover to its hold before a comfort margin on a border that already holds', () => {
    // 14 + 15 against the 19-stack: T1's 13 wear it down, T2 takes the last 11 with 18 (4 deployed
    // there, all T2 can spare). T1 is left on its guard beside T4, whose owner can deploy 5: it
    // needs 4 to hold, and the leftover is 3. Before #265 the 3 went to T2's comfort margin.
    // T1 is a source of the combined capture the rebalance leaves as built: with No-Split off its
    // order's size is fixed, so the leftover's deploy there stays.
    const p = plan(14, 15, 7);
    expect(attacks(p)).toEqual([
      [1, 3, 13],
      [2, 3, 18],
    ]);
    expect(p.expected.bonusesCompleted).toEqual([301]);
    expect(deployedTo(p, 1)).toBe(3);
    expect(staysOn(p, 14, 15, 1)).toBe(4);
    expect(armiesToTake(4, { offensiveKillRate: 60, defensiveKillRate: 70 })).toBeGreaterThan(5);
    expect(p.rationale.join('\n')).toMatch(
      /Deploy 3 of the leftover to T1 \(#1\): it is a member of bonus Vale \(#301\), completed this turn, and faces the ~5 threat/,
    );
  });

  it('a combined capture is rebalanced at the same kills to leave armies on the member', () => {
    // T2 can spare more than its 18: T1 wears the stack down with 10 (6 killed, as 11 would) and
    // T2 takes the last 13 with 21. Same kills, the capture still lands, and T1 keeps 4 — its hold.
    const p = plan(14, 22, 3);
    expect(attacks(p)).toEqual([
      [1, 3, 10],
      [2, 3, 21],
    ]);
    expect(p.multiSourceCaptures).toEqual([3]);
    expect(p.expected.bonusesCompleted).toEqual([301]);
    expect(staysOn(p, 14, 22, 1)).toBe(4);
    const r = p.rationale.join('\n');
    expect(r).toMatch(
      /Rebalance the combined capture of T3 \(#3\): T1 \(#1\) sends 10, not 13, and T2 \(#2\) 21, not 18 — the same 19 killed — so T1 \(#1\), a member of bonus Vale \(#301\) completed this turn, keeps 4 against the ~5 threat/,
    );
    expect(r).toMatch(/Attack T3 \(#3\) with 2 attacks .*from T1 \(#1\) with 10 \(kills 6 of 19.*then from T2 \(#2\) with 21/);
    expect(r).not.toMatch(/from T1 \(#1\) with 13/);
  });

  it('leaves the plan alone when the member holds', () => {
    // T1 keeps what holds it at the start of the turn (#121): nothing to rebalance or reprioritise.
    const p = plan(16, 16, 5);
    expect(attacks(p)).toEqual([
      [2, 3, 15],
      [1, 3, 16],
    ]);
    expect(p.rationale.join('\n')).not.toMatch(/Rebalance the combined capture|completed this turn, and faces/);
  });
});

// #265 review: the rebalance spends only what each source did not keep back when the capture was
// built, moves no more than the weak member needs, and never runs where its arithmetic does not.
//
//   Vale  (+5): 1 3       — taking the enemy's 19-stack on 3 completes it
//   Ridge (+7): 2 5 6     — held; 2 faces 3 now, and the enemy's 10 on T10 two steps away via neutral 9
//
//   the edges above, plus 2─9, 9─10
describe('#265 review: the rebalance of a combined capture', () => {
  const EDGES2: [number, number][] = [...EDGES, [2, 9], [9, 10]];
  const IDS2 = [...IDS, 9, 10];
  const MAP2: GameMap = {
    id: 2,
    name: 'Fells',
    territories: IDS2.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: EDGES2.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [
      { id: 301, name: 'Vale', value: 5, territoryIds: [1, 3], bonusIds: [] },
      { id: 302, name: 'Ridge', value: 7, territoryIds: [2, 5, 6], bonusIds: [] },
    ],
    distributionModes: [],
  };
  const g2 = buildGraph(MAP2);
  const fells = (one: number, two: number): BoardState =>
    board([
      mine(1, one), mine(2, two), theirs(3, 19), theirs(4, 1), mine(5, 4), mine(6, 1), theirs(7, 1), theirs(8, 1),
      neutral(9, 2), theirs(10, 10),
    ]);
  const plan2 = (one: number, two: number, income: number): TurnPlan =>
    planTurn({ graph: g2, board: fells(one, two), me: ME, income, settings: STD, options: { goal: 'complete-bonus' } });
  const staysOn2 = (p: TurnPlan, one: number, two: number, id: number) =>
    fells(one, two).territories.find((t) => t.territoryId === id)!.armies! +
    deployedTo(p, id) -
    p.moves.filter((m) => m.from === id).reduce((n, m) => n + m.armies, 0);

  it("never spends the other source's two-step hold (#172)", () => {
    // T2 keeps 11 for the reach from T10 via T9 once T3 falls. Before the review the rebalance sent
    // 28 from T2 (3 from T1), leaving T2 short of that hold ("bring 5 more next turn").
    const p = plan2(14, 28, 5);
    expect(attacks(p)).toEqual([
      [1, 3, 13],
      [2, 3, 18],
    ]);
    const r = p.rationale.join('\n');
    expect(r).not.toMatch(/Rebalance the combined capture/);
    expect(r).toMatch(/the two-step reach needs 11\)/);
    expect(r).not.toMatch(/bring \d+ more next turn/);
    expect(staysOn2(p, 14, 28, 2)).toBeGreaterThanOrEqual(11);
  });

  it('moves only what the weak member needs to hold', () => {
    // With room to spare on T2 it sends 21 (not 30), and T1 keeps 4 — its hold — not 13.
    const p = plan2(14, 32, 5);
    expect(attacks(p)).toEqual([
      [1, 3, 10],
      [2, 3, 21],
    ]);
    expect(staysOn2(p, 14, 32, 1)).toBe(4);
    const r = p.rationale.join('\n');
    expect(r).toMatch(/Rebalance the combined capture of T3 \(#3\): T1 \(#1\) sends 10, not 13, and T2 \(#2\) 21, not 18/);
    expect(r).not.toMatch(/bring \d+ more next turn/);
    expect(staysOn2(p, 14, 32, 2)).toBeGreaterThanOrEqual(11);
  });

  it('leaves a weak finisher as built when its softener has nothing more to send', () => {
    // T1 (17) is the finisher and left on its guard; T2 already sends all but its guard.
    const p = plan(17, 16, 3);
    expect(attacks(p)).toEqual([
      [2, 3, 15],
      [1, 3, 16],
    ]);
    expect(p.rationale.join('\n')).not.toMatch(/Rebalance the combined capture/);
    expect(staysOn(p, 17, 16, 1)).toBe(4);
  });

  it('does not run under No-Split, where every order sends its whole stack', () => {
    const p = planTurn({
      graph: g, board: marches(14, 18), me: ME, income: 5, settings: { ...STD, noSplit: true }, options: { goal: 'complete-bonus' },
    });
    expect(attacks(p)).toEqual([
      [1, 3, 13],
      [2, 3, 18],
    ]);
    expect(p.rationale.join('\n')).not.toMatch(/Rebalance the combined capture/);
  });

  it('under No-Split reads no keep, so no two-step hold that never shaped an order is stated', () => {
    // A No-Split combined capture sends whole stacks: what a source would keep back (#121, #172,
    // #179) never sizes it, and the rebalance does not run. Reading the keeps anyway marked T2's
    // two-step hold (T10 via T9) as binding, and the plan stated a hold that kept nothing back.
    // Here T1 does not face T4, and T3 is a neutral, so neither source must hold.
    const EDGES3: [number, number][] = [[1, 3], [2, 3], [1, 2], [5, 4], [2, 5], [5, 6], [5, 7], [4, 8], [7, 8], [2, 9], [9, 10]];
    const MAP3: GameMap = {
      ...MAP2,
      id: 3,
      territories: IDS2.map((id) => ({
        id,
        name: `T${id}`,
        connectedTo: EDGES3.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
      })),
    };
    const p = planTurn({
      graph: buildGraph(MAP3),
      board: board([
        mine(1, 3), mine(2, 11), neutral(3, 10), theirs(4, 1), mine(5, 4), mine(6, 1), theirs(7, 1), theirs(8, 1),
        neutral(9, 1), theirs(10, 1),
      ]),
      me: ME,
      income: 5,
      settings: { ...STD, noSplit: true },
      options: { goal: 'complete-bonus' },
    });
    expect(attacks(p)).toEqual([
      [1, 3, 2],
      [2, 3, 15],
    ]);
    expect(p.multiSourceCaptures).toEqual([3]);
    expect(p.rationale.join('\n')).not.toMatch(/two steps away/);
  });

  it('does not run with luck, where no combined capture is built', () => {
    const p = planTurn({
      graph: g, board: marches(14, 22), me: ME, income: 3, settings: { ...STD, luckModifier: 0.16 }, options: { goal: 'complete-bonus' },
    });
    expect(p.multiSourceCaptures ?? []).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/Multi-source capture of T3 \(#3\) skipped: .*luck is 16%/);
    expect(p.rationale.join('\n')).not.toMatch(/Rebalance the combined capture/);
  });
});
