// #367: rule 6 sent the same big idle stacks back and forth on two consecutive turns. Live (a large
// free-for-all, made up here): a 649 stack stood beside a border the plan conceded to a 794 enemy stack.
// Rule 6 measured "toward the front" only through borders the plan keeps, so the conceded border hid the
// enemy right behind it and the stack walked away, toward a farther front reached around it. Next turn
// the border had fallen, the enemy stood beside the territory the stack had left, and rule 6 walked it
// straight back. Now a step toward an enemy front must also bring the stack strictly nearer it measured
// through the conceded borders (one step from the board alone, no memory of last turn): a stack behind a
// conceded border waits there, where the front will be, instead of leaving and coming back. Every map,
// id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const FOE = 20;
const RULES: PlannerSettings = {
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  oneArmyStandsGuard: true,
  luckModifier: 0,
  roundingMode: 'StraightRound',
  baseIncome: 5,
};

function makeMap(ids: number[], edges: [number, number][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [],
    distributionModes: [],
  };
}
const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };

/**
 * My idle 30 on A = 1 border my 1-army C = 2, beside the opponent's 100 on E = 3: C cannot be held on
 * an income of 5, and the 30 cannot make it hold, so the plan concedes it. The other way from A runs
 * through my B = 4, X = 5 and Y = 6 to the opponent's 1-army F = 7: four steps from A around C, two
 * through it.
 */
const A = 1;
const C = 2;
const E = 3;
const B = 4;
const X = 5;
const Y = 6;
const F = 7;
const graph = buildGraph(
  makeMap(
    [A, C, E, B, X, Y, F, 8],
    [
      [A, C],
      [C, E],
      [A, B],
      [B, X],
      [X, Y],
      [Y, F],
      [F, 8],
    ],
  ),
);
const plan = (territories: TerritoryState[], income = 5): TurnPlan =>
  planTurn({ graph, board: board(territories), me: ME, income, settings: RULES });
const transfers = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'transfer');
const why = (p: TurnPlan) => p.rationale.join('\n');

describe('#367: an idle stack never walks away from the front behind a conceded border', () => {
  const turn1 = [
    at(A, 30, ME),
    at(C, 1, ME),
    at(E, 100, FOE),
    at(B, 1, ME),
    at(X, 1, ME),
    at(Y, 5, ME),
    at(F, 1, FOE),
    at(8, 40, FOE),
  ];

  it('keeps the stack behind the conceded border, where the front will be', () => {
    const p = plan(turn1);
    expect(p.conceded).toContain(C);
    // Before #367: "Transfer 29 from T1 to T4: moves idle interior armies toward the front".
    expect(transfers(p).filter((m) => m.from === A)).toEqual([]);
    expect(why(p)).toMatch(
      /Keep the 29 idle armies on T1 \(#1\): the enemy front nearest them, T3 \(#3\), lies past T2 \(#2\), a border the plan concedes \(#367\)/,
    );
  });

  it('does not send the stack back on the next turn once the conceded border has fallen', () => {
    // The two-turn flip: had turn 1 moved the stack to B, turn 2 (C fallen, the enemy beside A) walks it
    // back to A. The stack stays on A on turn 1, and on turn 2 it faces the enemy and stays.
    const first = plan(turn1);
    const moved = transfers(first).find((m) => m.from === A);
    const turn2 = [
      at(A, moved ? 1 : 30, ME),
      at(C, 3, FOE),
      at(E, 90, FOE),
      at(B, moved ? 30 : 1, ME),
      at(X, 1, ME),
      at(Y, 5, ME),
      at(F, 1, FOE),
      at(8, 40, FOE),
    ];
    const second = plan(turn2, 30);
    const back = moved ? transfers(second).filter((m) => m.from === moved.to && m.to === moved.from) : [];
    expect(back).toEqual([]);
    expect(moved).toBeUndefined();
    expect(transfers(second).filter((m) => m.from === A)).toEqual([]);
  });

  it('still walks a stack toward the front when the step brings it strictly nearer', () => {
    // No conceded border in the way: C is mine and safe (a 60-army neutral beside it, not worth taking),
    // so the stack on A walks toward F as before.
    const p = plan([at(A, 30, ME), at(C, 1, ME), at(E, 60, 'neutral'), at(B, 1, ME), at(X, 1, ME), at(Y, 5, ME), at(F, 1, FOE), at(8, 40, FOE)]);
    expect(p.conceded).not.toContain(C);
    expect(transfers(p).find((m) => m.from === A)?.to).toBe(B);
  });
});
