// Issue #218 (last comment): after the leftover is placed, a neutral a source can now afford from
// what stands above its hold is taken. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

interface Scenario {
  edges: string;
  bonuses?: Array<[number, number, number[]]>;
  /** 'M5' mine 5, 'n2' neutral 2, 'E3' player 20 with 3, 'F3' player 30 with 3. */
  cells: Record<number, string>;
  settings?: PlannerSettings;
  turn?: number;
  options?: PlanInput['options'];
  income: number;
  players?: number[];
}

const cell = (id: number, s: string): TerritoryState => {
  const n = Number(s.slice(1));
  if (s[0] === 'n') return { territoryId: id, owner: { kind: 'neutral' }, armies: n };
  const playerId = s[0] === 'M' ? ME : s[0] === 'E' ? 20 : 30;
  return { territoryId: id, owner: { kind: 'player', playerId }, armies: n };
};

function input(sc: Scenario): PlanInput {
  const adj = new Map<number, Set<number>>();
  const ids = new Set(Object.keys(sc.cells).map(Number));
  for (const e of sc.edges.split(/\s+/).filter(Boolean)) {
    const [a, b] = e.split('-').map(Number) as [number, number];
    ids.add(a);
    ids.add(b);
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  }
  const map: GameMap = {
    id: 1,
    name: 'Leftover',
    territories: [...ids].sort((a, b) => a - b).map((id) => ({ id, name: `T${id}`, connectedTo: [...(adj.get(id) ?? [])].sort((a, b) => a - b) })),
    bonuses: (sc.bonuses ?? []).map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
  return {
    graph: buildGraph(map),
    board: board(Object.entries(sc.cells).map(([id, s]) => cell(Number(id), s)), true),
    me: ME,
    income: sc.income,
    settings: sc.settings ?? STD,
    options: { adapt: true, ...(sc.options ?? {}) },
    game: { players: (sc.players ?? [ME, 20, 30]).map((id) => ({ id })), turn: sc.turn ?? 12, fog: 'Foggy' },
  };
}
const why = (p: TurnPlan) => p.rationale.join('\n');

const attacks = (p: TurnPlan, from: number, to: number) => p.moves.filter((m) => m.kind === 'attack' && m.from === from && m.to === to);

describe('#218 (last comment) rule 5b: a neutral the leftover pays for', () => {
  // A 3-player FFA on turn 7. My T1 (2) and T5 (1) are bonus B101 (+3); T1 faces player 20's 5 on
  // T2 (a ~9 threat: 6 hold it). T3 is a 1-army neutral (B100, +1) beside T1 alone; T7 a 6-neutral
  // beside T5. The hold locks T1 (rule 4e: "T1 stays to hold its border"), then the leftover lands
  // on T1 as its comfortable margin: 10 against a hold of 6, and 2 take T3.
  const sc: Scenario = {
    edges: '1-2 1-3 1-5 2-6 5-7',
    cells: { 1: 'M2', 2: 'E5', 3: 'n1', 5: 'M1', 6: 'F3', 7: 'n6' },
    bonuses: [
      [100, 1, [3]],
      [101, 3, [1, 5]],
    ],
    income: 8,
    turn: 7,
  };

  it('takes the neutral from what stands above the hold, and says why', () => {
    const p = planTurn(input(sc));
    expect(why(p)).toMatch(/Deploy the leftover 4 to T1 \(#1\): the held border with the most at stake/);
    expect(attacks(p, 1, 3)).toEqual([expect.objectContaining({ armies: 2, winChance: 1 })]);
    expect(why(p)).toMatch(
      /Attack T3 \(#3\) from T1 \(#1\) with 2: a neutral \(\+1 income\) the leftover pays for \(#218\): of the 10 on T1 \(#1\) after the leftover, the 2 sent leave 8, above the 6 that hold it against the ~9 threat\./,
    );
    // A capture is planned: the stand-still warning is gone, and T1 still holds.
    expect(p.warnings.join('\n')).not.toMatch(/Standing still/);
    expect(p.warnings.join('\n')).toMatch(/leaving 8 armies \(13 to take, more than the 9 that can reach it: it holds\)/);
  });

  it('never below the hold: a leftover too small to spare the capture leaves it', () => {
    // Income 5: the hold takes 4, the leftover's 1 makes 7 against a hold of 6.
    const p = planTurn(input({ ...sc, income: 5 }));
    expect(attacks(p, 1, 3)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/Standing still: no capture is planned, and the cheapest expansion \(T3 \(#3\)/);
  });

  it("neutrals only: a player's 1-army territory there is left alone", () => {
    const p = planTurn(input({ ...sc, cells: { ...sc.cells, 3: 'F1' } }));
    expect(attacks(p, 1, 3)).toEqual([]);
  });

  it("pass 3's economy test still applies: a neutral that adds nothing and loses more than 2 is not taken", () => {
    // T3 is a 4-neutral in no bonus (7 take it, losing ~3): the leftover on T1 is 16 against a hold
    // of 6 beside a bigger stack (player 20's 9 on T2), and T3 stays.
    const p = planTurn(
      input({
        ...sc,
        cells: { ...sc.cells, 2: 'E9', 3: 'n4' },
        bonuses: [[101, 3, [1, 5]]],
        income: 24,
      }),
    );
    expect(attacks(p, 1, 3)).toEqual([]);
    expect(why(p)).not.toMatch(/the leftover pays for/);
  });

  it('#215: armies withdrawn into the source count only when I am known to move first', () => {
    // T8 (4) faces player 20's 30 on T9: conceded, it withdraws 3 into T1. Income 5: the hold takes
    // 4 and the leftover's 1 makes 7 on T1 before the withdrawal — 1 above its hold — and 10 after.
    const w: Scenario = { ...sc, edges: `${sc.edges} 1-8 8-9`, cells: { ...sc.cells, 8: 'M4', 9: 'E30' }, income: 5 };
    const late = planTurn(input(w));
    expect(late.moves).toContainEqual(expect.objectContaining({ from: 8, to: 1, kind: 'transfer', armies: 3 }));
    expect(attacks(late, 1, 3)).toEqual([]);
    const first = planTurn(input({ ...w, options: { movesFirst: true } }));
    expect(attacks(first, 1, 3)).toEqual([expect.objectContaining({ armies: 2 })]);
    expect(why(first)).toMatch(/of the 10 on T1 \(#1\) after the leftover, the 2 sent leave 8, above the 6 that hold it/);
  });

  it('a withdrawal I may not land in time is left out of the arithmetic, and the line says so', () => {
    const w: Scenario = { ...sc, edges: `${sc.edges} 1-8 8-9`, cells: { ...sc.cells, 8: 'M4', 9: 'E30' }, income: 6 };
    const p = planTurn(input(w));
    expect(attacks(p, 1, 3)).toEqual([expect.objectContaining({ armies: 2 })]);
    expect(why(p)).toMatch(
      /of the 8 on T1 \(#1\) after the leftover \(the 3 withdrawn into it left out: they may land too late\), the 2 sent leave 6, what holds it against the ~9 threat\./,
    );
  });

  it('#128: a source that holds against two opponents attacking together keeps that', () => {
    // Player 30's 5 on T8 also borders T1. With the goal given (no FFA-leader rule), T1 is held
    // against each alone (6 against ~9); together they could take up to 10. Income 10: the leftover
    // makes 12, 11 hold against both, and 1 is spare: T3 stays, and no "together" warning appears.
    const two: Scenario = { ...sc, edges: `${sc.edges} 1-8`, cells: { ...sc.cells, 8: 'F5' }, options: { goal: 'balanced' } };
    const tight = planTurn(input({ ...two, income: 10 }));
    expect(attacks(tight, 1, 3)).toEqual([]);
    expect(tight.warnings.join('\n')).not.toMatch(/T1 \(#1\) holds against each opponent alone/);
    // Income 12: 14 on T1, and 2 are spare.
    const room = planTurn(input({ ...two, income: 12 }));
    expect(attacks(room, 1, 3)).toEqual([expect.objectContaining({ armies: 2 })]);
    expect(why(room)).toMatch(
      /of the 14 on T1 \(#1\) after the leftover, the 2 sent leave 12, above the 11 that hold it against the ~9 threat and against players 20 and 30 attacking it together \(up to 10 armies\)\./,
    );
    expect(room.warnings.join('\n')).not.toMatch(/T1 \(#1\) holds against each opponent alone/);
  });

  it('No-Split: the whole stack would go, so nothing is taken', () => {
    const p = planTurn(input({ ...sc, settings: { ...STD, noSplit: true } }));
    expect(attacks(p, 1, 3)).toEqual([]);
  });
});
