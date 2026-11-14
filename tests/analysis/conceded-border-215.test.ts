// #215: a border of mine that cannot hold at the expected threat and protects nothing (in no bonus,
// not my commander) was left holding its armies instead of breaking the adjacent enemy bonus. Under
// `balanced`, rule 1a's triage concedes such a border only on the economic test; a border taken last
// turn from a weak opponent is exempt from that test (conceding it hands it back for free), so it was
// locked as a pending hold for rule 4a's greedy step, which conceded it later as unaffordable but
// never unlocked it: its armies could not attack out, and the deploy went elsewhere. Every map, id and
// name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board as boardOf } from './helpers.js';

const ME = 10;
const FOE = 20;
const RATES: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };

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
const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };

// My T1 (in no bonus) faces player 20's 35-stack on T2 and T3, a 2-army member of its +3 bonus B900
// (T3, T4, T5). Behind T1 is my T6, in my held bonus B910 (+5: T6, T7, T8); T8 faces player 20's T23.
// Bonus B920 (+6) is far: my T12 and three neutrals. B930 (+10) is held deep inside.
const map = makeMap(
  [1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23],
  [
    [1, 2],
    [1, 3],
    [1, 6],
    [3, 4],
    [4, 5],
    [2, 21],
    [21, 22],
    [22, 23],
    [6, 7],
    [7, 8],
    [8, 23],
    [7, 12],
    [12, 13],
    [13, 14],
    [14, 15],
    [7, 16],
    [16, 17],
    [17, 18],
    [18, 19],
  ],
  [
    [900, 3, [3, 4, 5]],
    [950, 20, [2, 21, 22]],
    [910, 5, [6, 7, 8]],
    [920, 6, [12, 13, 14, 15]],
    [930, 10, [16, 17, 18, 19]],
  ],
);
const g = buildGraph(map);
const field = (x = 7): BoardState =>
  boardOf([
    at(1, x, ME),
    at(2, 35, FOE),
    at(3, 2, FOE),
    at(4, 2, FOE),
    at(5, 2, FOE),
    at(6, 3, ME),
    at(7, 3, ME),
    at(8, 12, ME),
    at(12, 4, ME),
    at(13, 15, 'neutral'),
    at(14, 15, 'neutral'),
    at(15, 10, 'neutral'),
    at(16, 20, ME),
    at(17, 2, ME),
    at(18, 1, ME),
    at(19, 1, ME),
    at(21, 3, FOE),
    at(22, 3, FOE),
    at(23, 15, FOE),
  ]);
/** The board one turn earlier: T1 was player 20's (taken last turn). */
const before = (b: BoardState): BoardState =>
  boardOf(b.territories.map((t) => (t.territoryId === 1 ? { ...t, owner: { kind: 'player', playerId: FOE } } : t)));
const input = (o: { x?: number; recent?: boolean; income?: number } = {}): PlanInput => {
  const board = field(o.x);
  return {
    graph: g,
    board,
    me: ME,
    income: o.income ?? 30,
    settings: RATES,
    game: { players: [{ id: ME }, { id: FOE }], turn: 10 },
    options: { adapt: true },
    ...(o.recent === false ? {} : { previousBoard: before(board) }),
  };
};
const attacksFrom = (p: TurnPlan, id: number) => p.moves.filter((m) => m.kind === 'attack' && m.from === id);
const notAttacking = (p: TurnPlan) => p.rationale.find((l) => l.startsWith('Not attacking')) ?? '';

describe('#215: a hopeless border that protects nothing is conceded and attacks out', () => {
  it('breaks the adjacent enemy bonus from a border taken last turn that cannot be held', () => {
    const p = planTurn(input());
    // T1 cannot hold against 35 + ~28: conceded (not held for the greedy step).
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) cannot be held with the 30 armies left to deploy \(needs \d+, protects \+0\): conceded/);
    expect(p.deploys.find((d) => d.territoryId === 1)).toBeUndefined();
    // Its armies break B900 through T3 instead of staying pinned.
    const out = attacksFrom(p, 1);
    expect(out.map((m) => m.to)).toEqual([3]);
    expect(out[0]!.armies).toBeGreaterThanOrEqual(3);
    expect(out[0]!.reason).toMatch(/breaks enemy bonus B900/);
    // T3 is attacked, so no skip line names it.
    expect(notAttacking(p)).not.toMatch(/T3 \(#3\)/);
  });

  it('is the same plan for T1 as when T1 was not taken last turn', () => {
    const recent = planTurn(input());
    const old = planTurn(input({ recent: false }));
    expect(attacksFrom(recent, 1)).toEqual(attacksFrom(old, 1));
  });

  it('the skip line never says a conceded border keeps armies back to hold its border', () => {
    // T2 (the 35-stack) is next to T1 alone: the line gives what T1 has left once its attack and
    // withdrawal leave, named as conceded, not "spare once it holds its border is 0".
    // (With 12 on T1 a hold of 28 fits the 30 deploy, and a border taken last turn is held.)
    for (const [x, recent] of [[7, true], [9, true], [7, false], [12, false]] as const) {
      const p = planTurn(input({ x, recent }));
      const t2 = notAttacking(p).split('; T')[0]!;
      expect(t2, `x=${x} recent=${recent}`).toMatch(/T2 \(#2\).*the most a neighbour of mine has left for it is \d+ \(T1 \(#1\), conceded: what stays there once its other orders leave\)/);
      expect(t2, `x=${x} recent=${recent}`).not.toMatch(/once it holds its border/);
    }
  });
});
