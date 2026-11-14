// #201: fund holds by the standing (#167's "fund holds in passes"). Ahead, every held bonus is held
// for the worst case before any capture; behind, a border facing a player that faces two or more of
// my territories is sized for the expected case (its one deploy lands on one of them) and the plan
// says what that gambles. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const enemy = (territoryId: number, armies: number, playerId = 20): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });
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

describe('#201: behind, holds are sized for the expected case', () => {
  // My T1 and T3 (each its own +2 bonus) both face player 20's 6 on T2; player 20 holds +10 B805
  // (T2, T4, T5) and out-earns me. T6, a neutral 2, completes my +3 B806 with T1.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6],
      [
        [1, 2],
        [2, 3],
        [2, 4],
        [4, 5],
        [1, 6],
      ],
      [
        [801, 2, [1]],
        [803, 2, [3]],
        [805, 10, [2, 4, 5]],
        [806, 3, [6]],
      ],
    ),
  );
  const input = (options: PlanInput['options']): PlanInput => ({
    graph: g,
    board: board([mine(1, 3), enemy(2, 6), mine(3, 3), enemy(4, 2), enemy(5, 2), neutral(6, 2)]),
    me: ME,
    income: 5,
    settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
    game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 9 },
    options,
  });

  it('each border is held against the stack beside it, and the gamble is named', () => {
    const p = planTurn(input({ adapt: true }));
    expect(p.profile.standing).toBe('behind');
    expect(p.conceded).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(
      /Behind \(#201\): the borders facing player 20 are sized for the expected case — its one ~15 deploy lands on one of the 2 territories of mine it faces, so each is held against the stacks next to it, not all of the deploy on each, and the armies go to more borders and to the captures\. Gambled: T1 \(#1\) \(it holds against ~5, not the ~20 of the whole deploy\), T3 \(#3\) \(it holds against ~5, not the ~20 of the whole deploy\)/,
    );
    // The cover odds name the same gamble.
    expect(p.rationale.join('\n')).toMatch(/Cover odds against player 20 \(#167\)/);
  });

  it('an explicit goal sizes each border for the whole deploy, as before', () => {
    const p = planTurn(input({ goal: 'defend' }));
    expect(p.warnings.join('\n')).not.toMatch(/Behind \(#201\)/);
  });
});
