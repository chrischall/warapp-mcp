// Issue #218: the leftover's staging source, the front line against the outlook, and (comment) a
// leftover with no front to go to. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { forecastBorder, mainFront } from '../../src/analysis/exchange.js';
import { gameOutlook } from '../../src/analysis/outlook.js';
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
const deployedTo = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);
const why = (p: TurnPlan) => p.rationale.join('\n');

describe('#218 (1) a margin goes to the staging source at equal defensive value', () => {
  // B100 (+3): T1, T2, T3. T3 is a 30-neutral inside my land (only T1 and T2 border it). T1 and T2
  // both face player 20's stack on T4. Neither is short of its hold; both are short of a
  // comfortable margin.
  const sc: Scenario = {
    edges: '1-2 1-3 2-3 1-4 2-4 4-5 5-6',
    bonuses: [[100, 6, [1, 2, 3]]],
    cells: { 1: 'M15', 2: 'M16', 3: 'n20', 4: 'E19', 5: 'E3', 6: 'F5' },
    income: 10,
    options: { enemyDeploy: 5 },
  };
  it('the rest goes to the source of the step it saves toward, not to an equal border', () => {
    const p = planTurn(input(sc));
    // Each short border gets its comfortable margin first, as before.
    expect(why(p)).toMatch(/Deploy 3 of the leftover to T1 \(#1\): it brings it to a comfortable margin/);
    expect(why(p)).toMatch(/Deploy 2 of the leftover to T2 \(#2\): it brings it to a comfortable margin/);
    // The rest: T2 faces what T1 faces and protects as much, and it is beside T3.
    expect(why(p)).toMatch(
      /Deploy the leftover 5 to T2 \(#2\): save toward T3 \(#3\) \(33 to take\), the next step of bonus B100 \(#100\), which this turn cannot afford; it defends as well as T1 \(#1\) would \(the same ~23 threat from player 20, protects \+4\), once every short border has its comfortable margin\./,
    );
    expect(deployedTo(p, 1)).toBe(3);
    expect(deployedTo(p, 2)).toBe(7);
  });

  it('under the #167 front-outlook pin too (holds before the expansion share)', () => {
    const p = planTurn(
      input({
        ...sc,
        cells: { ...sc.cells, 1: 'M44', 2: 'M46', 3: 'n60', 4: 'E60' },
        bonuses: [[100, 20, [1, 2, 3]]],
        income: 24,
        options: { enemyDeploy: 14 },
      }),
    );
    expect(why(p)).toMatch(/Front outlook \(#167\): .*I am ground down on turn \d+ — the border pins/);
    expect(why(p)).toMatch(/Deploy the leftover \d+ to T2 \(#2\): save toward T3 \(#3\)/);
  });

  it('a source facing another stack is no equal: the rest goes to the border with the most at stake', () => {
    // T2 faces player 30's 19 on T7 instead of player 20's on T4: the same size, another player.
    const p = planTurn(input({ ...sc, edges: '1-2 1-3 2-3 1-4 2-7 4-5 5-6 6-7', cells: { ...sc.cells, 7: 'F19' } }));
    expect(why(p)).not.toMatch(/Deploy the leftover \d+ to T2 \(#2\): save toward/);
    expect(why(p)).toMatch(/Deploy the leftover \d+ to T1 \(#1\): the rest, once every short border has its comfortable margin/);
  });
});

describe('#218 (comment) with no front to go to, the leftover stays central', () => {
  // A 3-player FFA on turn 3 with no enemy in view. My land is a line T1..T7; the cheap expansion
  // is T8 off the far end (T7); T9 is a neutral off the other end.
  const sc: Scenario = {
    edges: '1-2 2-3 3-4 4-5 5-6 6-7 7-8 8-10 1-9',
    cells: { 1: 'M2', 2: 'M2', 3: 'M2', 4: 'M2', 5: 'M2', 6: 'M2', 7: 'M5', 8: 'n2', 9: 'n4', 10: 'n2' },
    income: 30,
    turn: 3,
  };
  it('goes to the territory with the fewest hops to my farthest border, not the expansion stack', () => {
    const p = planTurn(input(sc));
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 7, to: 8, kind: 'attack' }));
    expect(deployedTo(p, 4)).toBe(30);
    expect(deployedTo(p, 7)).toBe(0);
    expect(why(p)).toMatch(
      /Deploy the leftover 30 to T4 \(#4\): no enemy is in view, so there is no front to go to: it stays central to what I hold \(at most 3 hops from each of my borders, where the stack working on the top expansion, T7 \(#7\), is 6 from its farthest\)/,
    );
    // Rule 6 does not walk the leftover back out; the 1 idle army already there may still go.
    expect(p.moves.filter((m) => m.from === 4).reduce((n, m) => n + m.armies, 0)).toBeLessThanOrEqual(1);
  });

  it('the armies already on the centre are not frozen by the leftover kept there', () => {
    // T4 starts with 20: its 19 idle armies still head for the nearest territory not mine.
    const p = planTurn(input({ ...sc, cells: { ...sc.cells, 4: 'M20' } }));
    expect(deployedTo(p, 4)).toBe(30);
    expect(p.moves.filter((m) => m.from === 4 && m.kind === 'transfer').reduce((n, m) => n + m.armies, 0)).toBe(19);
    expect(why(p)).toMatch(/Transfer 19 from T4 \(#4\) to T\d \(#\d\): moves idle interior armies toward the front \(the 30 of the leftover kept central stay\)\./);
  });

  it('with an enemy in view, the leftover still rides the expansion stack', () => {
    const p = planTurn(input({ ...sc, edges: `${sc.edges} 10-11`, cells: { ...sc.cells, 11: 'E3' } }));
    expect(why(p)).not.toMatch(/no front to go to/);
    expect(deployedTo(p, 4)).toBe(0);
  });

  it('an expansion stack about as central as the centre keeps the leftover', () => {
    // The expansion leaves T4 for T8; my borders are T1 (beside T9) and T4. The centre, T2, is at
    // most 2 hops from each; T4 is 3 from T1: within CENTRE_SLACK.
    const p = planTurn(
      input({
        ...sc,
        edges: '1-2 2-3 3-4 4-5 5-6 6-7 4-8 8-10 1-9',
        cells: { 1: 'M2', 2: 'M2', 3: 'M2', 4: 'M5', 5: 'M2', 6: 'M2', 7: 'M2', 8: 'n2', 9: 'n4', 10: 'n2' },
      }),
    );
    expect(why(p)).not.toMatch(/no front to go to/);
    expect(why(p)).toMatch(/Deploy the leftover \d+ to T4 \(#4\): the stack working on the top expansion/);
  });
});

describe('#218 (2) the front line and the outlook are one computation', () => {
  // A line T1..T7 in a 3-player FFA: my 32 on T1 faces player 30's 25 on T2; my 12 on T4 faces
  // player 20's 30 on T5. T3 is a neutral (B100, +6) between them.
  const sc: Scenario = {
    edges: '1-2 2-3 3-4 4-5 5-6 6-7',
    cells: { 1: 'M32', 2: 'F25', 3: 'n2', 4: 'M12', 5: 'E30', 6: 'n2', 7: 'F9' },
    bonuses: [[100, 6, [3]]],
    income: 10,
    options: { enemyDeploy: 6 },
  };

  it('mainFront: the biggest enemy stack next to me, against my biggest beside it', () => {
    const i = input(sc);
    const f = mainFront(
      i.graph,
      (x) => [1, 4].includes(x),
      [
        { id: 2, armies: 5, player: 20 },
        { id: 5, armies: 30, player: 20 },
      ],
      (x) => (x === 1 ? 40 : 12),
    );
    expect(f).toEqual({ from: 4, at: 5, mine: 12, theirs: 30, player: 20 });
  });

  it('forecastBorder says when not even the whole income keeps the border', () => {
    expect(forecastBorder({ mine: 4, theirs: 40, myIncome: 5, theirIncome: 5 })).toMatchObject({ pinned: 5, pinnedHolds: false });
    expect(forecastBorder({ mine: 20, theirs: 20, myIncome: 5, theirIncome: 5 })).toMatchObject({ pinnedHolds: true });
  });

  it("the outlook's front is the planner's pair, and on the turn played the plan's incomes: the same outcome", () => {
    const i = input(sc);
    const p = planTurn(i);
    expect(p.front).toMatchObject({ from: 4, at: 5, mine: 12, theirs: 30, player: 20 });
    const boards = [{ turn: 12, board: i.board }];
    // Alone, the outlook picks the same pair (it used to pick my biggest stack, T1 against T2's 5).
    const own = gameOutlook({ graph: i.graph, me: ME, boards, game: { players: [{ id: ME }, { id: 20 }, { id: 30 }] }, settings: STD });
    expect(own.turns.at(-1)!.front).toMatchObject({ from: 4, at: 5, mine: 12, theirs: 30 });
    expect(own.basis).toMatch(/\(mine 5, player 20's 5: its visible income, a lower bound under fog\): my 12 on #4 against its 30 on #5, I am ground down on turn 1\./);
    // Fed the plan's front, it forecasts with the plan's incomes and reads what the plan reads.
    const fed = gameOutlook({
      graph: i.graph,
      me: ME,
      boards,
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }] },
      settings: STD,
      front: { turn: 12, from: p.front!.from, at: p.front!.at, myIncome: p.front!.myIncome, theirIncome: p.front!.theirIncome },
    });
    expect(fed.turns.at(-1)!.front).toMatchObject({
      myIncome: p.front!.myIncome,
      theirIncome: p.front!.theirIncome,
      incomeSource: 'plan',
      outcome: p.front!.outcome,
      turn: p.front!.turn,
    });
    expect(fed.basis).toMatch(
      new RegExp(`The main front \\(the biggest enemy stack next to me against my biggest beside it\\), each side deploying its whole income there every turn \\(mine ${p.front!.myIncome}, player 20's ${p.front!.theirIncome}: the plan's estimate\\): my 12 on #4 against its 30 on #5, I am ground down on turn \\d+\\.`),
    );
  });
});
