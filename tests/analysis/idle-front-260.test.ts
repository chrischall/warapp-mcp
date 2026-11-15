// #260 (part 2, the #257 follow-up): with no conceded border an idle stack can make hold, rule 6
// measured the enemy front only through borders the plan keeps, so an idle interior stack whose
// every way to the only enemy in view crossed a conceded border walked to an empty neutral edge
// instead. Live (a free-for-all, made up here): guard on, income 9; 11 idle on an interior
// territory; two of my 1-army borders beside an opponent's 1-army territory, both conceded; the plan
// attacked it with 2 from one of them, which then missed holding by one army; and rule 6 sent 10 to
// a territory beside neutrals. The stress test preferred the stack on the attack source. Now, at
// equal distance, the stack steps toward the enemy front, into the border the plan attacks from
// first. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const FOE = 20;
// Base income 19 makes the opponent's estimate ~19; my income is given (9).
const RULES: PlannerSettings = {
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  oneArmyStandsGuard: true,
  luckModifier: 0,
  roundingMode: 'StraightRound',
  baseIncome: 19,
};

function makeMap(ids: number[], edges: [number, number][], bonuses: GameMap['bonuses'] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses,
    distributionModes: [],
  };
}
const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };

const U = 1;
const S = 4;
const D = 10;
/**
 * My interior U = 1 (11 armies) borders my `v` and `gT` (1 each, both beside the opponent's 1-army
 * D = 10, behind which stands its 30 on 11) and my S = 4 (12, my biggest stack, so the leftover goes
 * there), whose other neighbours are neutrals 20 and 21 (6 each, not worth taking). U's 10 movable
 * armies are one short of making a conceded border hold (11 more against the ~19).
 */
function plan(
  v: number,
  gT: number,
  extra: { ids?: number[]; edges?: [number, number][]; armies?: TerritoryState[]; bonuses?: GameMap['bonuses'] } = {},
): TurnPlan {
  const g = buildGraph(
    makeMap(
      [U, v, gT, S, D, 11, 20, 21, ...(extra.ids ?? [])],
      extra.edges ?? [[U, v], [U, gT], [U, S], [v, D], [gT, D], [S, 20], [S, 21], [D, 11]],
      extra.bonuses,
    ),
  );
  return planTurn({
    graph: g,
    board: board(
      extra.armies ?? [at(U, 11, ME), at(v, 1, ME), at(gT, 1, ME), at(S, 12, ME), at(D, 1, FOE), at(11, 30, FOE), at(20, 6, 'neutral'), at(21, 6, 'neutral')],
    ),
    me: ME,
    income: 9,
    settings: RULES,
  });
}
const into = (p: TurnPlan, to: number) => p.moves.filter((m) => m.kind === 'transfer' && m.to === to).reduce((n, m) => n + m.armies, 0);
const why = (p: TurnPlan) => p.rationale.join('\n');

describe('#260: an idle stack steps toward the enemy front through a conceded border, not to a neutral edge', () => {
  it('moves the idle stack into the conceded border the plan attacks from', () => {
    const p = plan(2, 3);
    expect(p.moves.find((m) => m.kind === 'attack' && m.to === D)?.from).toBe(2);
    // No revival: 10 more on T2 need 19 to take, not above the ~19.
    expect(p.rationale.join('\n')).not.toMatch(/after all \(not conceded\)/);
    expect(p.conceded).toEqual(expect.arrayContaining([2, 3]));
    expect(into(p, 2)).toBe(10);
    expect(into(p, S)).toBe(0);
    expect(why(p)).toMatch(
      /Transfer 10 from T1 \(#1\) to T2 \(#2\): moves idle interior armies toward the front \(the enemy front, T10 \(#10\), is reached only through a border the plan concedes, and no farther than the nearest territory not mine; T2 \(#2\) is the border the plan attacks T10 \(#10\) from; they are lost with it if it falls\)\./,
    );
  });

  it('prefers the border the plan attacks from over a lower id', () => {
    // T3 has 2 armies, so the plan attacks D from it (one army fewer to deploy) and not from T2.
    const p = plan(2, 3, {
      armies: [at(U, 11, ME), at(2, 1, ME), at(3, 2, ME), at(S, 12, ME), at(D, 1, FOE), at(11, 30, FOE), at(20, 6, 'neutral'), at(21, 6, 'neutral')],
    });
    expect(p.moves.find((m) => m.kind === 'attack' && m.to === D)?.from).toBe(3);
    expect(p.conceded).toEqual(expect.arrayContaining([2, 3]));
    expect(into(p, 3)).toBe(10);
    expect(into(p, 2)).toBe(0);
    expect(into(p, S)).toBe(0);
  });

  it('still steps toward a neutral edge strictly closer than the enemy front', () => {
    // U reaches the enemy only through W = 5 (1 army) and then the conceded borders: 3 steps,
    // against 2 to the neutrals beside S.
    const W = 5;
    const p = plan(2, 3, {
      ids: [W],
      edges: [[U, W], [W, 2], [W, 3], [U, S], [2, D], [3, D], [S, 20], [S, 21], [D, 11]],
      armies: [at(U, 11, ME), at(W, 1, ME), at(2, 1, ME), at(3, 1, ME), at(S, 12, ME), at(D, 1, FOE), at(11, 30, FOE), at(20, 6, 'neutral'), at(21, 6, 'neutral')],
    });
    expect(into(p, S)).toBe(10);
    expect(into(p, W)).toBe(0);
  });

  it('never steps into a conceded border a withdrawal leaves, even one the plan attacks from', () => {
    // T2 (6 armies) is conceded, attacks the opponent's 1-army D to break its visible bonus B900
    // (D + E = 12), and withdraws the rest to T1. T1's idle stack must not walk back into it.
    const E = 12;
    const p = plan(2, 3, {
      ids: [E],
      edges: [[U, 2], [U, S], [2, D], [2, 3], [3, 11], [S, 20], [S, 21], [D, 11], [D, E]],
      armies: [at(U, 11, ME), at(2, 6, ME), at(3, 1, ME), at(S, 12, ME), at(D, 1, FOE), at(11, 30, FOE), at(E, 1, FOE), at(20, 6, 'neutral'), at(21, 6, 'neutral')],
      bonuses: [{ id: 900, name: 'B900', value: 5, territoryIds: [D, E], bonusIds: [] }],
    });
    expect(p.conceded).toContain(2);
    expect(p.moves.some((m) => m.kind === 'attack' && m.from === 2 && m.to === D)).toBe(true);
    expect(p.moves.some((m) => m.kind === 'transfer' && m.from === 2)).toBe(true);
    expect(into(p, 2)).toBe(0);
  });

  it('holds a conceded border two idle stacks make hold together, not reporting it conceded', () => {
    // Review of #260: T1 and T5 (7 each) are interior, both beside T2 and T3 (1 each, beside the
    // opponent's 1-army T10). Neither alone revives a border (#257 tries one stack at a time), but
    // both step into T2, the border the plan attacks T10 from, and together they make it hold. The
    // plan must then hold T2, not keep reporting it conceded.
    const T5 = 5;
    const p = plan(2, 3, {
      ids: [T5],
      edges: [[U, 2], [U, 3], [T5, 2], [T5, 3], [U, S], [2, D], [3, D], [S, 20], [S, 21], [D, 11]],
      armies: [at(U, 7, ME), at(T5, 7, ME), at(2, 1, ME), at(3, 1, ME), at(S, 12, ME), at(D, 1, FOE), at(11, 30, FOE), at(20, 6, 'neutral'), at(21, 6, 'neutral')],
    });
    expect(p.moves.find((m) => m.kind === 'attack' && m.to === D)?.from).toBe(2);
    expect(into(p, 2)).toBe(12);
    expect(p.conceded).not.toContain(2);
    expect(p.conceded).toContain(3);
    expect(p.warnings.join('\n')).not.toMatch(/T2 \(#2\) cannot be held/);
    expect(why(p)).toMatch(/Hold T2 \(#2\) after all \(not conceded\): the 12 idle armies transferred into it from T1 \(#1\), T5 \(#5\)/);
  });

  it('never reports a border conceded that the steps into it make hold, at 8 or 9 a stack either', () => {
    const T5 = 5;
    for (const n of [8, 9]) {
      const p = plan(2, 3, {
        ids: [T5],
        edges: [[U, 2], [U, 3], [T5, 2], [T5, 3], [U, S], [2, D], [3, D], [S, 20], [S, 21], [D, 11]],
        armies: [at(U, n, ME), at(T5, n, ME), at(2, 1, ME), at(3, 1, ME), at(S, 12, ME), at(D, 1, FOE), at(11, 30, FOE), at(20, 6, 'neutral'), at(21, 6, 'neutral')],
      });
      expect(into(p, 2)).toBe(2 * (n - 1));
      expect(p.conceded).not.toContain(2);
      expect(why(p)).toMatch(/Hold T2 \(#2\) after all \(not conceded\)/);
      // The step lines no longer call T2 a border the plan concedes.
      expect(why(p)).not.toMatch(/to T2 \(#2\): moves idle interior armies toward the front \(the enemy front/);
    }
  });

  it('never steps a stack beside an enemy at the start of the turn, though a certain strike makes it interior', () => {
    // T1 (40) strikes the opponent's commander on T6 for sure; once T6 falls T1 is interior and the
    // enemy front (T10, whose bonus B900 the conceded T2 breaks) lies only through T2. T1 still
    // faces T6 now, so it is no idle interior stack: its armies do not walk into the conceded T2
    // (8 would make it hold while it was still reported conceded).
    const C = 6;
    const E = 12;
    const ids = [U, 2, 3, S, D, 11, 20, 21, C, E];
    const edges: [number, number][] = [[U, 2], [U, S], [U, C], [2, D], [2, 3], [3, 11], [S, 20], [S, 21], [D, 11], [D, E]];
    const p = planTurn({
      graph: buildGraph(makeMap(ids, edges, [{ id: 900, name: 'B900', value: 5, territoryIds: [D, E], bonusIds: [] }])),
      board: board([
        at(U, 40, ME),
        at(2, 3, ME),
        at(3, 1, ME),
        at(S, 12, ME),
        at(D, 1, FOE),
        at(11, 30, FOE),
        at(20, 6, 'neutral'),
        at(21, 6, 'neutral'),
        { ...at(C, 1, FOE), specialUnits: [{ kind: 'commander', id: 'c', playerId: FOE }] },
        at(E, 1, FOE),
      ]),
      me: ME,
      income: 9,
      settings: { ...RULES, baseIncome: 5 },
    });
    expect(p.conceded).toContain(2);
    expect(p.moves.some((m) => m.kind === 'attack' && m.from === 2 && m.to === D)).toBe(true);
    expect(into(p, 2)).toBe(0);
    // As before #260: rule 6 measures T1 by the nearest territory not mine (the neutrals past S),
    // and the strike keeps the 11 that hold T1 until T6 falls.
    expect(into(p, S)).toBe(8);
    expect(p.moves.find((m) => m.kind === 'attack' && m.from === U && m.to === C)?.armies).toBe(30);
    expect(why(p)).not.toMatch(/is reached only through a border the plan concedes/);
  });
});
