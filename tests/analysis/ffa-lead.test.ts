// #167, the live comment: in a free-for-all with a big army lead, idle stacks beside weak enemy
// territories are a lever, not a risk — the second-front rule (0p.2) is scaled by my army lead and
// off past SECOND_FRONT_LEAD×; and every enemy territory next to mine that the plan does not attack
// names its reason. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, SECOND_FRONT_LEAD, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { validateTurn } from '../../src/tools/turn.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 50, defensiveKillRate: 70, oneArmyStandsGuard: true };

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
const enemy = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
/** The plan passes warapp_submit_turn's validator: its warnings (none when legal; it throws on a refusal). */
function valid(p: TurnPlan, i: PlanInput) {
  const names = new Map(i.graph.map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  const b: BoardState = i.board;
  return validateTurn({
    map: i.graph.map,
    board: b.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: 1,
        fogged: false,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income: i.income,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  }).warnings;
}
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const why = (p: TurnPlan) => p.rationale.join('\n');

// Me on 1, 2, 3. T4 (a neutral 2) completes my +8. T5 (player 20, 17 armies) stands beside my T3
// and is a step into B802 (+3, with the neutral T9). Player 20's 43-stack T6, player 30's T7 and
// player 40's T8 are out of my reach: none of them can attack me.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
    [
      [1, 2],
      [2, 3],
      [1, 4],
      [3, 5],
      [5, 6],
      [5, 9],
      [6, 9],
      [6, 7],
      [7, 8],
    ],
    [
      [801, 8, [4]],
      [802, 3, [5, 9]],
    ],
  ),
);
const players = [{ id: ME }, { id: 20 }, { id: 30 }, { id: 40 }];
const input = (stacks: [number, number, number]): PlanInput => ({
  graph: g,
  board: board([
    mine(1, stacks[0]),
    mine(2, stacks[1]),
    mine(3, stacks[2]),
    neutral(4, 2),
    enemy(5, 17, 20),
    enemy(6, 43, 20),
    enemy(7, 53, 30),
    enemy(8, 18, 40),
    neutral(9, 2),
  ]),
  me: ME,
  income: 38,
  settings: STD,
  game: { players, turn: 10 },
  options: { adapt: true },
});

describe('#167: a big army lead in a free-for-all', () => {
  it('exports its constant', () => {
    expect(SECOND_FRONT_LEAD).toBe(3);
  });

  it('with more than 3× the next player\'s armies, an idle stack takes the weak enemy territory beside it, sized for its owner\'s deploy', () => {
    // 80 + 60 + 55 = 195 against player 20's 60 in view: 3.25×.
    const p = planTurn(input([80, 60, 55]));
    expect(p.profile.format).toBe('ffa');
    const hit = attacks(p).find((m) => m.to === 5);
    expect(hit).toBeDefined();
    expect(hit!.from).toBe(3);
    // 17 defenders plus player 20's ~5 deploy: 22, taken for sure by 43 at 50/70.
    expect(hit!.armies).toBeGreaterThanOrEqual(43);
    expect(why(p)).toMatch(/army lead/);
    expect(why(p)).toMatch(/T5 \(#5\)/);
    // The completion is still made.
    expect(attacks(p).map((m) => m.to)).toContain(4);
    expect(valid(p, input([80, 60, 55]))).toEqual([]);
  });

  it('below the lead the stack stands, and the rationale says why T5 is not attacked', () => {
    // 30 + 25 + 20 = 75 against 60: 1.25×.
    const p = planTurn(input([30, 25, 20]));
    expect(attacks(p).map((m) => m.to)).not.toContain(5);
    expect(why(p)).toMatch(/Not attacking .*T5 \(#5\) \(player 20, 17 armies\): /);
  });

  it('every enemy territory next to mine that is not attacked names its reason', () => {
    for (const stacks of [
      [30, 25, 20],
      [80, 60, 55],
      [80, 60, 10],
    ] as [number, number, number][]) {
      const p = planTurn(input(stacks));
      const hit = new Set(attacks(p).map((m) => m.to));
      if (!hit.has(5)) expect(why(p)).toMatch(/T5 \(#5\) \(player 20, 17 armies\): /);
    }
  });

  it('every attack on a player carries its exchange (#167): a lead strike sized for the deploy is a certain first strike', () => {
    const p = planTurn(input([80, 60, 55]));
    const x = p.exchanges?.find((e) => e.to === 5);
    expect(x).toMatchObject({ from: 3, label: 'certain first strike' });
    expect(x!.cases.map((c) => [c.case, c.defenders, c.captures])).toEqual([
      ['now', 17, true],
      ['estimated', 22, true],
      ['whole', 22, true],
    ]);
    // Neutral captures carry none.
    expect(p.exchanges?.some((e) => e.to === 4)).toBe(false);
    expect(why(p)).toMatch(/Exchange of attacks on players \(#167\): T5 \(#5\) from T3 \(#3\) with \d+: certain first strike/);
  });

  it('is deterministic', () => {
    expect(planTurn(input([80, 60, 55]))).toEqual(planTurn(input([80, 60, 55])));
  });
});
