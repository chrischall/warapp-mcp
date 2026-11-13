// Issue #71: every capture pays for the frontier it adds. A capture that closes a gap ranks
// above one that opens new fronts; borders facing only neutrals barely matter; the plan reports
// its frontier budget and stops expansion that outgrows the income. Synthetic maps only:
// made-up ids and names.
//
//   1 ─ 3 ═ 5, 6      3 opens a border facing the enemy stacks 5 and 6
//   │ ╲               4 sits between my 1 and 2: taking it closes T2's border
//   2 ─ 4
//   1 ─ 7 ─ 8         7 and 8: a quiet neutral corridor
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  captureCost,
  NEUTRAL_BORDER_COST,
  planTurn,
  type PlanGoal,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral, tinyMap } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic frontier',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

const EDGES: [number, number][] = [
  [1, 2],
  [1, 3],
  [1, 4],
  [2, 4],
  [3, 5],
  [3, 6],
  [5, 6],
  [1, 7],
  [7, 8],
];
const G = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7, 8], EDGES));

describe('frontier cost (#71): every capture pays for the frontier it adds', () => {
  it('a capture that closes a gap beats an equal-cost one that opens a front onto two enemy stacks', () => {
    // 3 and 4 each hold 2: 3 armies to take, 2 survive. Income 3 pays for one of them
    // (my stacks are 1 army each: nothing movable). By id alone T3 would go first.
    // T4: becomes interior and closes T2's border (T2 then touches only my 1 and 4): −0.25.
    // T3: a new border next to 5 and 6 (4 each, 3 movable each) at the ~5 deploy: threat
    // 3 + 3 + 5 = 11; holding 11 needs 8 (armiesToTake(7) = 11, armiesToTake(8) = 13), 2
    // survive: need 6, so it costs 3 + 0.25 + 6 = 9.25 in its score against T4's 2.75.
    expect(captureCost(2, STD)).toBe(3);
    expect(armiesToTake(7)).toBe(11);
    expect(armiesToTake(8)).toBe(13);
    const b = board([mine(1, 1), mine(2, 1), neutral(3, 2), neutral(4, 2), enemy(5, 4), enemy(6, 4), neutral(7, 40), neutral(8, 40)]);
    for (const goal of ['balanced', 'defend'] as PlanGoal[]) {
      const p = planTurn({ graph: G, board: b, me: ME, income: 3, settings: STD, options: { goal, enemyDeploy: 5 } });
      expect(attacks(p).map((m) => m.to), goal).toEqual([4]);
      // After it: T1 still faces 3 and 7, T4 and T2 are interior; no enemy border.
      expect(p.frontier, goal).toEqual({ borders: 1, enemyBorders: 0, holdCost: 0, income: 3 });
    }
  });

  it('borders facing only neutrals barely matter: a cheaper capture still beats a dearer gap-closer', () => {
    // T4 holds 3 now (5 to take) and still closes a gap (−0.25): 4.75. T7 holds 2 (3 to take)
    // and opens a border onto T8 (+0.25): 3.25. No enemy anywhere near: T7 first, by cost,
    // and the 2 left cannot take T4.
    expect(captureCost(3, STD)).toBe(5);
    const b = board([mine(1, 1), mine(2, 1), neutral(3, 40), neutral(4, 3), neutral(7, 2), neutral(8, 40)]);
    for (const goal of ['balanced', 'expand', 'defend'] as PlanGoal[]) {
      const p = planTurn({ graph: G, board: b, me: ME, income: 5, settings: STD, options: { goal } });
      expect(attacks(p).map((m) => m.to), goal).toEqual([7]);
    }
    // Two neutral borders swing a score by at most 2 × NEUTRAL_BORDER_COST: under one army.
    expect(2 * NEUTRAL_BORDER_COST).toBeLessThan(1);
  });

  it('an equal-cost gap-closer still wins on neutral borders alone (expand ignores enemy hold costs)', () => {
    // Under expand the enemy hold need is not charged (R3: goal expand ignores defence), but
    // T3 still opens a border (+0.25) and T4 closes one (−0.25): T4 first.
    const b = board([mine(1, 1), mine(2, 1), neutral(3, 2), neutral(4, 2), enemy(5, 4), enemy(6, 4), neutral(7, 40), neutral(8, 40)]);
    const p = planTurn({ graph: G, board: b, me: ME, income: 3, settings: STD, options: { goal: 'expand', enemyDeploy: 5 } });
    expect(attacks(p).map((m) => m.to)).toEqual([4]);
  });

  it('frontier budget: expansion that adds an enemy border without completing a bonus is stopped, with a warning', () => {
    // T1 has 30 (29 movable); 3 and 7 hold 2 (3 each). Taking T3 opens a border onto 5 and 6
    // (20 each: 19 + 19 movable + ~5 deploy = 43; holding 43 needs 27 (armiesToTake(26) = 43,
    // armiesToTake(27) = 45), 2 survive: 25 next turn), far over the next income of 5 and over
    // the 0 at the start: stopped. T7 opens only a neutral border: taken.
    expect(armiesToTake(26)).toBe(43);
    expect(armiesToTake(27)).toBe(45);
    const b = board([mine(1, 30), mine(2, 1), neutral(3, 2), mine(4, 1), enemy(5, 20), enemy(6, 20), neutral(7, 2), neutral(8, 40)]);
    const p = planTurn({ graph: G, board: b, me: ME, income: 5, settings: STD, options: { enemyDeploy: 5 } });
    expect(attacks(p).map((m) => m.to)).toEqual([7]);
    expect(p.warnings).toContain(
      'Frontier grows faster than income. Expansion that adds enemy borders without completing a bonus is stopped: T3 (#3) (the frontier would need 25, next income 5) not taken.',
    );
    expect(p.rationale.join('\n')).toMatch(
      /Do not take T3 \(#3\): it adds a border facing an enemy without completing a bonus, and the frontier would then need 25 next turn to hold \(1 enemy-facing borders\), more than the next income of 5 and more than the 0 it needed at the start of the turn\./,
    );
    // T1 still faces T3, T7 faces T8: two borders, none facing the enemy.
    expect(p.frontier).toEqual({ borders: 2, enemyBorders: 0, holdCost: 0, income: 5 });

    // Under expand (defence ignored, as in R3) it is taken, and the warning reports the budget.
    const q = planTurn({ graph: G, board: b, me: ME, income: 5, settings: STD, options: { goal: 'expand', enemyDeploy: 5 } });
    expect(attacks(q).map((m) => m.to).sort()).toEqual([3, 7]);
    expect(q.frontier).toEqual({ borders: 2, enemyBorders: 1, holdCost: 25, income: 5 });
    expect(q.warnings).toContain(
      'Frontier grows faster than income: holding its 1 enemy-facing borders next turn needs 25 at the expected deploy, more than the next income of 5 (0 at the start of the turn).',
    );
    expect(q.rationale).toContain(
      "Frontier after this plan: 2 borders, 1 facing an enemy, needing 25 next turn to hold at the expected deploy (next income 5); every capture's score paid for the borders it adds.",
    );
  });

  it('advancing a bonus is stopped the same way (it completes nothing), and said once', () => {
    const FG = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7, 8], EDGES, [[900, 'Front', 1, [3, 8]]]));
    // Bonus Front (+1): T3 (3 to take) and T8 (2: 3 to take, not next to me): 6 to finish,
    // economic. Advancing it takes T3 alone, which opens the 25-army front: stopped.
    const b = board([mine(1, 30), mine(2, 1), neutral(3, 2), mine(4, 1), enemy(5, 20), enemy(6, 20), neutral(7, 40), neutral(8, 2)]);
    const p = planTurn({ graph: FG, board: b, me: ME, income: 5, settings: STD, options: { enemyDeploy: 5 } });
    expect(attacks(p)).toEqual([]);
    expect(p.rationale.filter((r) => r.startsWith('Do not take T3 (#3)'))).toHaveLength(1);
    expect(p.warnings.filter((w) => w.startsWith('Frontier grows faster than income'))).toEqual([
      'Frontier grows faster than income. Expansion that adds enemy borders without completing a bonus is stopped: T3 (#3) (the frontier would need 25, next income 5) not taken.',
    ]);
  });

  it('a capture stopped early but taken by a later pass is not reported as stopped', () => {
    // Bonus Front (+6: T3 and T8) and bonus Big (+2: T7 alone). Advancing Front first tries T3,
    // which opens a border onto 5 and 6 (4 each) needing 6 next turn against the next income of
    // 5: stopped. Completing Big then lifts the next income to 7, so pass 3 takes T3 after all.
    // The orders take T3, so neither the "Do not take" line nor the warning may say otherwise.
    const FG = buildGraph(
      makeMap([1, 2, 3, 4, 5, 6, 7, 8], EDGES, [
        [900, 'Front', 6, [3, 8]],
        [901, 'Big', 2, [7]],
      ]),
    );
    const b = board([mine(1, 30), mine(2, 1), neutral(3, 2), mine(4, 1), enemy(5, 4), enemy(6, 4), neutral(7, 4), neutral(8, 2)]);
    const p = planTurn({ graph: FG, board: b, me: ME, income: 5, settings: STD, options: { enemyDeploy: 5 } });
    expect(attacks(p).map((m) => m.to).sort()).toEqual([3, 7]);
    expect(p.frontier).toEqual({ borders: 2, enemyBorders: 1, holdCost: 6, income: 7 });
    expect(p.rationale.join('\n')).not.toMatch(/Do not take T3/);
    expect(p.warnings.join('\n')).not.toMatch(/Frontier grows faster than income|not taken/);
  });

  it('a focused bonus is never stopped by the frontier budget', () => {
    const FG = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7, 8], EDGES, [[900, 'Front', 1, [3, 8]]]));
    const b = board([mine(1, 30), mine(2, 1), neutral(3, 2), mine(4, 1), enemy(5, 20), enemy(6, 20), neutral(7, 40), neutral(8, 40)]);
    const p = planTurn({ graph: FG, board: b, me: ME, income: 5, settings: STD, options: { enemyDeploy: 5, focusBonusIds: [900] } });
    expect(attacks(p).map((m) => m.to)).toContain(3);
    expect(p.warnings.join('\n')).toMatch(/Frontier grows faster than income: holding its 1 enemy-facing borders/);
  });

  it('boards with no enemy contact report a quiet frontier and no frontier warning or rationale', () => {
    const tg = buildGraph(tinyMap());
    const p = planTurn({
      graph: tg,
      board: board([mine(1, 5), mine(2, 5), neutral(3, 2), neutral(4, 2), neutral(5, 2), neutral(6, 2), neutral(7, 2)]),
      me: ME,
      income: 5,
      settings: STD,
    });
    // 3 completes A (+3): 1 and 2 become interior; 3 borders 4 (taken next, advancing B); 4 borders 5.
    expect(p.frontier.enemyBorders).toBe(0);
    expect(p.frontier.holdCost).toBe(0);
    expect(p.warnings.join('\n')).not.toMatch(/Frontier/);
    expect(p.rationale.join('\n')).not.toMatch(/Frontier/);
  });
});
