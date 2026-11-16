// #272 item 1: a conceded border never took a free capture. Live (a 7-player FFA, guard off), the
// last members of a bonus stood empty beside a border the plan conceded: the plan took one of them
// in rule 4e's fallback and refused the other ("a conceded border never attacks out for a capture
// that only costs nothing"), withdrawing the rest. The play session held the border and took the
// member, completing the bonus. Now, before rule 1b withdraws, a conceded border attacks out with
// its own armies into an empty or near-empty territory whose capture completes or advances a bonus.
// Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGameContext, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const BIG = 20;
const WEAK = 30;
const OFF: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };
const GAME: PlanGameContext = { players: [ME, BIG, WEAK, 40, 50, 60, 70].map((id) => ({ id })), turn: 29 };

const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'ConcededOut',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

//   Isle (+4): my 1 and 2, my 3 (3 armies), and player 30's empty 4 and 5, which border only 3.
//   Player 20's 30-stack on 8 borders 3 (its deploy makes 3 hopeless: conceded); player 30's
//   67-stack on 9 borders my 1. Player 20 also holds 10 and 11 far off.
const map = makeMap(
  [1, 2, 3, 4, 5, 8, 9, 10, 11, 12, 13, 14, 15],
  [[1, 2], [1, 3], [2, 3], [3, 4], [3, 5], [3, 8], [1, 9], [8, 10], [10, 11], [9, 12], [12, 13], [13, 14], [14, 15]],
  [[900, 4, [1, 2, 3, 4, 5]], [901, 5, [8, 10, 11]]],
);
const g = buildGraph(map);
const field = (four = 0, five = 0, owner: number | 'neutral' = WEAK, three = 3): BoardState =>
  board([
    at(1, 2, ME),
    at(2, 3, ME),
    at(3, three, ME),
    at(4, four, owner),
    at(5, five, owner),
    at(8, 30, BIG),
    at(9, 67, WEAK),
    at(10, 5, BIG),
    at(11, 5, BIG),
    at(12, 9, WEAK),
    at(13, 9, WEAK),
    at(14, 9, WEAK),
    at(15, 9, WEAK),
  ]);
const plan = (b: BoardState): TurnPlan => planTurn({ graph: g, board: b, me: ME, income: 34, settings: OFF, game: GAME });
const attacksFrom = (p: TurnPlan, from: number) =>
  p.moves.filter((m) => m.kind === 'attack' && m.from === from).map((m) => m.to).sort((a, b) => a - b);

describe('#272 item 1: a conceded border attacks out for a free step into a bonus before it withdraws', () => {
  it('the live shape: both empty members are taken from the border, the bonus completes, and the border is kept', () => {
    const p = plan(field());
    expect(attacksFrom(p, 3)).toEqual([4, 5]);
    const text = p.rationale.join('\n');
    expect(text).toMatch(/Attack out of conceded T3 \(#3\) before withdrawing: T\d \(#\d\) holds 0, and 1 of the armies leaving the border anyway take it, advancing bonus B900 \(#900\) \(\+4\) \(#272\)/);
    expect(text).toMatch(/completing bonus B900 \(#900\) \(\+4\) \(#272\)/);
    expect(text).not.toMatch(/a conceded border never attacks out/);
    // Rule 1c keeps a border of a bonus this turn completes: nothing withdraws from it.
    expect(p.moves.filter((m) => m.kind === 'transfer' && m.from === 3)).toEqual([]);
  });

  it('armies left over stay on the border: the bonus its attack completes keeps it (rule 1c), nothing withdraws', () => {
    // 3 holds 12: two attack out, the rest would have withdrawn had rule 1c judged the border first.
    const p = plan(field(0, 0, WEAK, 12));
    expect(attacksFrom(p, 3)).toEqual([4, 5]);
    expect(p.conceded ?? []).not.toContain(3);
    expect(p.moves.filter((m) => m.kind === 'transfer' && m.from === 3)).toEqual([]);
    expect(p.rationale.join('\n')).toMatch(/Keep T3 \(#3\) \(not conceded\): this turn's captures complete bonus B900 \(#900\) \(\+4\)/);
  });

  it('a territory holding more than near-empty is not attacked out of the conceded border', () => {
    // 4 and 5 hold 6 each: no step is free. Rule 4e's fallback still attacks one out of the
    // border with deploys (as before #272); the new step takes neither.
    const p = plan(field(6, 6));
    expect(attacksFrom(p, 3)).toEqual([4]);
    expect(p.rationale.join('\n')).not.toMatch(/#272/);
  });
});

// #272 review: with no neighbour of mine to withdraw into, the conceded border's armies would have
// stayed: the line does not say they were leaving anyway.
describe('#272 review: a conceded border with nowhere to withdraw to', () => {
  it('says the attack thins a border that keeps the rest, not that the armies were leaving', () => {
    // Only 3 is mine (1 and 2 player 20's): it is conceded and has nowhere to withdraw to.
    const b = board([
      at(1, 2, BIG),
      at(2, 3, BIG),
      at(3, 12, ME),
      at(4, 0, WEAK),
      at(5, 0, WEAK),
      at(8, 30, BIG),
      at(9, 67, WEAK),
      at(10, 5, BIG),
      at(11, 5, BIG),
      at(12, 9, WEAK),
      at(13, 9, WEAK),
      at(14, 9, WEAK),
      at(15, 9, WEAK),
    ]);
    const p = plan(b);
    const lines = p.rationale.filter((l) => l.startsWith('Attack out of conceded T3'));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l).not.toMatch(/leaving the border anyway|before withdrawing/);
      expect(l).toMatch(/it has nowhere to withdraw to, so they leave a border that keeps the rest/);
    }
  });
});
