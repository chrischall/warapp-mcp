// #422: R3's payback exemption. A completion whose frontier cannot be held next turn is still worth
// making when what it can lose — the armies its captures lose this turn plus those left standing on the
// members that would fall — is at most the bonus's value: the bonus pays that value once next turn even
// if it falls straight after. Every map, id and name here is made up.
//
//   Ridge (+7): 5 6 7 8 — my 5 6 7, its last member 8 (a neutral) faces the opponent's stack on 10
//
//   5─6, 6─7, 7─8, 8─10
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const EDGES: [number, number][] = [
  [5, 6],
  [6, 7],
  [7, 8],
  [8, 10],
];
const IDS = [5, 6, 7, 8, 10];
const MAP: GameMap = {
  id: 1,
  name: 'Ridge',
  territories: IDS.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: EDGES.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [{ id: 302, name: 'Ridge', value: 7, territoryIds: [5, 6, 7, 8], bonusIds: [] }],
  distributionModes: [],
};
const g = buildGraph(MAP);
const theirs = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });
/** Ridge one neutral (8, `defenders`) short; 8 faces the opponent's 30-stack, far more than the next income can hold. */
const ridge = (defenders: number, onSeven: number): BoardState =>
  board([mine(5, 1), mine(6, 1), mine(7, onSeven), neutral(8, defenders), theirs(10, 30)]);
const plan = (b: BoardState, income: number): TurnPlan => planTurn({ graph: g, board: b, me: ME, income, settings: STD, options: { goal: 'balanced' } });

describe('#422: a completion that pays for itself in one turn is made even when it would fall next turn', () => {
  it('completes Ridge (+7) when taking T8 loses 1 and leaves 2 there: 3 at risk, under one turn of +7', () => {
    const p = plan(ridge(2, 4), 5);
    expect(p.expected.bonusesCompleted).toEqual([302]);
    expect(p.moves).toContainEqual(expect.objectContaining({ kind: 'attack', to: 8 }));
    expect(p.warnings.join('\n')).not.toMatch(/indefensible/);
    expect(p.rationale.join('\n')).toMatch(
      /Complete bonus Ridge \(#302\) though its frontier cannot be held next turn \(it needs \d+ more armies, next income 12\): it can lose at most 3 armies \(1 killed taking it, 2 left on T8 \(#8\)\), no more than the \+7 it pays next turn \(#422\)\./,
    );
  });

  it('still refuses it when what it can lose is more than the bonus is worth', () => {
    // T8 at 6: taking it needs 10 and loses 4, leaving 6 there — 10 at risk against +7.
    const p = plan(ridge(6, 12), 5);
    expect(p.expected.bonusesCompleted).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/completing Ridge \(#302\) leaves T8 \(#8\) indefensible .*: not completed/);
    expect(p.rationale.join('\n')).not.toMatch(/#422/);
  });
});
