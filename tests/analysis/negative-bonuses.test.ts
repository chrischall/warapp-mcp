// Issue #70: on maps with overlapping bonuses (each sea tile a single-territory −4 bonus and
// a member of a +22 four-tile group) every capture is scored by its net effect on income.
// Synthetic maps only: made-up ids and names.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGoal, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic sea',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

/**
 * Land 1 (mine) borders four sea tiles 11–14 (a chain 11–12–13–14 as well). Each sea tile
 * is a single-territory −4 bonus (601–604, "(hidden)" names as such maps use); together they
 * are the +22 bonus 600, so the whole cluster nets +22 − 16 = +6. Land 2 is a +3 bonus (700)
 * next to 1.
 */
const SEA = buildGraph(
  makeMap(
    [1, 2, 11, 12, 13, 14],
    [
      [1, 2],
      [1, 11],
      [1, 12],
      [1, 13],
      [1, 14],
      [11, 12],
      [12, 13],
      [13, 14],
    ],
    [
      [600, '(hidden) Positive Sea Bonus', 22, [11, 12, 13, 14]],
      [601, '(hidden) Negative Sea Tile', -4, [11]],
      [602, '(hidden) Negative Sea Tile', -4, [12]],
      [603, '(hidden) Negative Sea Tile', -4, [13]],
      [604, '(hidden) Negative Sea Tile', -4, [14]],
      [700, 'Land', 3, [2]],
    ],
  ),
);

describe('negative bonuses (#70): captures are scored by their net effect on income', () => {
  it('(a) only one sea tile affordable: no sea capture, income unchanged', () => {
    // Sea tiles hold 4 (6 to take each); 2 armies movable on 1 + 5 income = 7: one tile.
    // Staging it (rule c): the other three cost 18, ceil(18 / 5) = 4 turns to finish, and
    // 4 turns × the cluster's −16 interim penalty = 64 > 10 × the +6 net: refused.
    // Land 2 is held by a big stack so it is out of reach too.
    for (const goal of ['balanced', 'expand', 'complete-bonus'] as PlanGoal[]) {
      const p = planTurn({
        graph: SEA,
        board: board([mine(1, 3), neutral(2, 40), neutral(11, 4), neutral(12, 4), neutral(13, 4), neutral(14, 4)]),
        me: ME,
        income: 5,
        settings: STD,
        options: { goal },
      });
      expect(attacks(p), goal).toEqual([]);
      expect(p.expected.nextIncome, goal).toBe(5);
      expect(p.expected.bonusesCompleted, goal).toEqual([]);
    }
  });

  it('(b) all four affordable this turn: the whole cluster is taken, nextIncome +6', () => {
    // Sea tiles hold 2 (3 to take each): 12 for the cluster, exactly the income.
    const p = planTurn({
      graph: SEA,
      board: board([mine(1, 1), neutral(2, 40), neutral(11, 2), neutral(12, 2), neutral(13, 2), neutral(14, 2)]),
      me: ME,
      income: 12,
      settings: STD,
    });
    expect(attacks(p).map((m) => m.to).sort()).toEqual([11, 12, 13, 14]);
    expect(p.expected.bonusesCompleted).toEqual([600, 601, 602, 603, 604]);
    expect(p.expected.nextIncome).toBe(18);
    // The reason states the net value, never "advances".
    expect(attacks(p).every((m) => /completes bonus .*\+22, net \+6/.test(m.reason))).toBe(true);
  });

  it('(c) two of four held (paying −8): completing the last two beats a +3 elsewhere', () => {
    // 11 and 12 are mine (income 6 already pays their −8). 13 and 14 cost 3 each (6):
    // +22 − 8 = +14 for 6 armies, against +3 for 2 on land 2; 6 income covers only one.
    const p = planTurn({
      graph: SEA,
      board: board([mine(1, 1), mine(11, 1), mine(12, 1), neutral(2, 1), neutral(13, 2), neutral(14, 2)]),
      me: ME,
      income: 6,
      settings: STD,
    });
    expect(attacks(p).map((m) => m.to).sort()).toEqual([13, 14]);
    expect(p.expected.nextIncome).toBe(20);
  });

  it('stages one tile only when the cluster is repaid within PAYBACK_TURNS (rule c), and says so', () => {
    // Sea tiles hold 2 (3 each). 5 income: one tile now; the other three cost 9,
    // ceil(9 / 5) = 2 turns to finish, 2 × 16 = 32 ≤ 10 × 6 = 60: staged.
    const p = planTurn({
      graph: SEA,
      board: board([mine(1, 1), neutral(2, 40), neutral(11, 2), neutral(12, 2), neutral(13, 2), neutral(14, 2)]),
      me: ME,
      income: 5,
      settings: STD,
    });
    expect(attacks(p).map((m) => m.to)).toEqual([11]);
    expect(attacks(p)[0]!.reason).toMatch(/^stages bonus/);
    expect(attacks(p)[0]!.reason).not.toMatch(/advances/);
    expect(p.expected.nextIncome).toBe(1);
    expect(p.rationale.join('\n')).toMatch(/2 turns.*32.*60/);
    expect(p.warnings.join('\n')).toMatch(/lowers next income from 5 to 1: .*T11 \(#11\).*stages bonus/);
  });

  it('(d) a plain negative tile next to my land is never taken unless focused, under any goal', () => {
    // 2 is a lone −4 bonus; it is also in a +22 group whose other members are fogged, so
    // the group cannot be staged (its cost is unknown) and pass 3 must not take 2 either.
    const ng = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5],
        [
          [1, 2],
          [2, 3],
          [3, 4],
          [4, 5],
        ],
        [
          [801, 'Swamp', -4, [2]],
          [802, 'Far group', 22, [2, 3, 4, 5]],
        ],
      ),
    );
    const s = board([mine(1, 30), neutral(2, 1), fogged(3), fogged(4), fogged(5)]);
    for (const goal of ['balanced', 'expand', 'complete-bonus', 'defend'] as PlanGoal[]) {
      const p = planTurn({ graph: ng, board: s, me: ME, income: 5, settings: STD, options: { goal } });
      expect(attacks(p), goal).toEqual([]);
      expect(p.expected.nextIncome, goal).toBe(5);
    }
    const focused = planTurn({ graph: ng, board: s, me: ME, income: 5, settings: STD, options: { focusBonusIds: [801] } });
    expect(attacks(focused).map((m) => m.to)).toEqual([2]);
  });

  it('(e) the guard drops a capture that would lower nextIncome (a break into a −4 tile)', () => {
    // The enemy holds +5 bonus 900 (21, 22) in full; 21 borders my big stack on 1, and 21 is
    // also a lone −4 bonus. Breaking it would complete my −4: the guard drops the capture.
    const eg = buildGraph(
      makeMap(
        [1, 21, 22],
        [
          [1, 21],
          [21, 22],
        ],
        [
          [900, 'Enemy pair', 5, [21, 22]],
          [901, 'Swamp', -4, [21]],
        ],
      ),
    );
    const s = board([mine(1, 30), enemy(21, 1), enemy(22, 1)]);
    const p = planTurn({ graph: eg, board: s, me: ME, income: 5, settings: STD });
    expect(attacks(p)).toEqual([]);
    expect(p.expected.nextIncome).toBe(5);
    expect(p.rationale.join('\n')).toMatch(/Drop the attack on T21 \(#21\): it completes Swamp \(#901\) -4.*next income 1 → 5/);
    // Deploys still sum to the income.
    expect(p.deploys.reduce((n, d) => n + d.armies, 0)).toBe(5);
    // Focused, it stays, with a loud warning naming the numbers.
    const f = planTurn({ graph: eg, board: s, me: ME, income: 5, settings: STD, options: { focusBonusIds: [901] } });
    expect(attacks(f).map((m) => m.to)).toEqual([21]);
    expect(f.expected.nextIncome).toBe(1);
    expect(f.warnings.join('\n')).toMatch(/lowers next income from 5 to 1/);
  });

  it('the planner counts every bonus, "(hidden)" names and negative values included', () => {
    // The sea cluster above is all "(hidden)" bonuses: they are scored like any other.
    const p = planTurn({
      graph: SEA,
      board: board([mine(1, 1), neutral(2, 40), neutral(11, 2), neutral(12, 2), neutral(13, 2), neutral(14, 2)]),
      me: ME,
      income: 12,
      settings: STD,
    });
    expect(p.expected.bonusesCompleted).toContain(601);
  });
});
