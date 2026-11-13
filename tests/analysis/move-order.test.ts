import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

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
const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const legs = (p: TurnPlan) => p.moves.map((m) => `${m.from}>${m.to}`);

// T4 ─ T1 ─ T2(enemy, bonus 901 with T5) ─ T5(enemy)
//  │     └─ T3(neutral) ─ T6 ─ T7   (bonus 902: T3, T6, T7)
//  └─ T8(neutral) ─ T5
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8],
    [
      [1, 2],
      [1, 3],
      [4, 1],
      [2, 5],
      [3, 6],
      [6, 7],
      [4, 8],
      [8, 5],
    ],
    [
      [901, 3, [2, 5]],
      [902, 4, [3, 6, 7]],
    ],
  ),
);

describe('move order within a turn (#127)', () => {
  it('sends a transfer into a border first, a sure attack next, filler after', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 30), enemy(2, 10), neutral(3, 2), mine(4, 12), enemy(5, 3), neutral(6, 2), neutral(7, 2), neutral(8, 30)]),
      me: ME,
      income: 5,
      settings: STD,
    });
    // Decision order was 1>3, 1>2, 4>1: the transfer into T1 (it faces T2) goes first, the attack
    // sized for player 20's whole deploy next, the uncontested neutral capture after them.
    expect(legs(p)).toEqual(['4>1', '1>2', '1>3']);
    expect(p.rationale.join('\n')).toMatch(/Move order \(#127\)/);
  });

  it('attacks a stack that can fight back last, after the filler', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 16), enemy(2, 10), neutral(3, 2), mine(4, 4), enemy(5, 3), neutral(6, 2), neutral(7, 2), neutral(8, 2)]),
      me: ME,
      income: 5,
      settings: STD,
    });
    // The exact-sized attack on T2 and the 3-army capture of T8 (player 20 can reach it, and its
    // 2 survivors would not hold) go last; the uncontested T3 first.
    expect(legs(p)).toEqual(['1>3', '1>2', '4>8']);
    const line = p.rationale.find((l) => l.startsWith('Move order (#127)'))!;
    expect(line).toMatch(/T2 \(#2\)/);
    expect(line).toMatch(/survivors/);
  });

  it('takes a contested neutral early when its survivors hold against what can reach it', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 16), enemy(2, 10), neutral(3, 2), mine(4, 4), enemy(5, 3), neutral(6, 2), neutral(7, 2), neutral(8, 2)]),
      me: ME,
      income: 5,
      settings: STD,
      options: { enemyDeploy: 0 },
    });
    // With no deploy, T5's 2 movable armies cannot take the 2 survivors on T8 (4 needed).
    expect(legs(p).indexOf('4>8')).toBe(0);
  });
});
