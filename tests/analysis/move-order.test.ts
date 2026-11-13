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
    expect(p.moveSlots).toEqual(['early', 'sure', 'filler']);
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
    // #163: the slots ride along with the moves, so the card advice can place an Order Delay.
    expect(p.moveSlots).toEqual(['filler', 'last', 'last']);
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

  it("says where each move put last lands among the opponent's orders (zigzag arithmetic)", () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 16), enemy(2, 10), neutral(3, 2), mine(4, 4), enemy(5, 3), neutral(6, 2), neutral(7, 2), neutral(8, 2)]),
      me: ME,
      income: 5,
      settings: STD,
    });
    expect(legs(p)).toEqual(['1>3', '1>2', '4>8']);
    // Player 20 can order from T2 and T5. My 2nd order runs after 2 of its orders moving first,
    // 1 moving second; not knowing, only my 3rd is sure to run after both.
    const line = p.rationale.find((l) => l.startsWith('Move position (#127)'))!;
    expect(line).toMatch(/T2 \(#2\) is my order 2: after 2 of player 20's orders if I move first, 1 if it does/);
    expect(line).toMatch(/2 territories in view with armies to move/);
    expect(line).toMatch(/after them all from order 3 \(1 more order above it\)/);
    expect(line).toMatch(/T8 \(#8\) is my order 3: .*after them all/);
  });

  it('uses the known move order for the arithmetic', () => {
    const p = planTurn({
      graph: g,
      board: board([mine(1, 16), enemy(2, 10), neutral(3, 2), mine(4, 4), enemy(5, 3), neutral(6, 2), neutral(7, 2), neutral(8, 2)]),
      me: ME,
      income: 5,
      settings: STD,
      options: { movesFirst: true },
    });
    const line = p.rationale.find((l) => l.startsWith('Move position (#127)'))!;
    // Moving first, my 2nd order already runs after the opponent's 1st and 2nd.
    expect(line).toMatch(/T2 \(#2\) is my order 2: after 2 of player 20's orders \(I move first\); .*after them all\./);
  });

  it('deploys next to the opponent first, in the back after (deploys interleave too)', () => {
    // T2(neutral) ─ T1 ─ T3 ─ T4(enemy)   bonus 901 (T1, T2, T3)
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3, 4],
        [
          [1, 2],
          [3, 4],
          [1, 3],
        ],
        [[901, 3, [1, 2, 3]]],
      ),
    );
    const p = planTurn({
      graph: g2,
      board: board([mine(1, 1), neutral(2, 2), mine(3, 2), enemy(4, 4)]),
      me: ME,
      income: 8,
      settings: STD,
    });
    // The hold on T3 (next to player 20) lands before the capture's deploy on T1, whatever the ids.
    expect(p.deploys.map((d) => d.territoryId)).toEqual([3, 1]);
  });
});
