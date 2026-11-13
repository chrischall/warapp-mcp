// Issue #109: a plan that concedes held bonuses still reported the full next income. The
// plan now reports two figures: `expected.nextIncome` (if everything it keeps and captures
// holds, as before) and `expected.nextIncomeIfConcededFall` (if the borders it concedes
// fall), with the bonuses at risk. Synthetic maps only: made-up ids and names.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { boardIncome } from '../../src/analysis/player.js';
import { bonusesAtRisk, planTurn, type PlanGoal, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const enemy = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: ENEMY },
  armies,
});

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic marches',
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
 * The #109 shape in miniature: income 19 = 5 base + four held bonuses.
 *   Alder (+3): 1 2 — 1 faces an enemy 60-stack on 20
 *   Birch (+4): 3 4 — 3 faces an enemy 60-stack on 21
 *   Cedar (+3): 5 6, Daisy (+4): 7 8 — interior
 * Neither threatened border can be held with 19, so both bonuses are conceded: 12 if they fall.
 */
const MARCHES = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8, 20, 21, 22],
    [
      [1, 2], [2, 5], [3, 4], [4, 6], [5, 6], [6, 7], [7, 8], [5, 8],
      [1, 20], [3, 21], [20, 22], [21, 22],
    ],
    [
      [301, 'Alder', 3, [1, 2]],
      [302, 'Birch', 4, [3, 4]],
      [303, 'Cedar', 3, [5, 6]],
      [304, 'Daisy', 4, [7, 8]],
    ],
  ),
);
const MARCHES_BOARD = board([
  mine(1, 2), mine(2, 2), mine(3, 2), mine(4, 2), mine(5, 2), mine(6, 2), mine(7, 2), mine(8, 2),
  enemy(20, 60), enemy(21, 60), fogged(22),
]);
const planMarches = (goal?: PlanGoal) =>
  planTurn({ graph: MARCHES, board: MARCHES_BOARD, me: ME, income: 19, settings: STD, options: goal ? { goal } : {} });

describe('next income a plan concedes (#109)', () => {
  it('the #109 shape: 19 if the conceded borders hold, 12 if they fall, both bonuses at risk', () => {
    for (const goal of ['balanced', 'defend'] as const) {
      const p = planMarches(goal);
      expect(p.conceded).toEqual([1, 3]);
      expect(p.expected.nextIncome).toBe(19);
      expect(p.expected.nextIncomeIfConcededFall).toBe(12);
      expect(p.expected.bonusesAtRisk).toEqual([
        { bonusId: 301, name: 'Alder', value: 3, conceded: [1] },
        { bonusId: 302, name: 'Birch', value: 4, conceded: [3] },
      ]);
      expect(p.warnings).toContain(
        'This plan concedes bonus Alder (#301) (+3), Birch (#302) (+4): next income 19 if they hold, 12 if the conceded borders fall.',
      );
    }
  });

  it('the frontier rationale names both figures when they differ', () => {
    const p = planMarches();
    const line = p.rationale.find((r) => r.startsWith('Frontier after this plan'));
    expect(line).toMatch(/next income 19, 12 if the conceded borders fall\)/);
  });

  it('nothing conceded: neither field, no warning, the frontier line unchanged', () => {
    const quiet = board([
      mine(1, 2), mine(2, 2), mine(3, 2), mine(4, 2), mine(5, 2), mine(6, 2), mine(7, 2), mine(8, 2),
      enemy(20, 1), enemy(21, 1), fogged(22),
    ]);
    const p = planTurn({ graph: MARCHES, board: quiet, me: ME, income: 19, settings: STD });
    expect(p.conceded).toEqual([]);
    expect('nextIncomeIfConcededFall' in p.expected).toBe(false);
    expect('bonusesAtRisk' in p.expected).toBe(false);
    expect(p.warnings.join('\n')).not.toMatch(/if the conceded borders fall/);
    expect(p.rationale.join('\n')).not.toMatch(/if the conceded borders fall/);
  });

  it('a conceded border of a bonus completed this turn counts', () => {
    // The planner's reconsider pass (rule 1c) keeps a conceded border of a bonus its capture
    // passes complete, so this only arises from a capture made after it; the rule is the pure
    // helper's: every positive bonus complete over the holdings after the plan counts, whether
    // held at the start or completed this turn.
    // Elm (+2): 1 2 — 1 held and conceded, 2 captured this turn; Fen (+5): 3 — held, not conceded.
    const g = buildGraph(
      makeMap([1, 2, 3], [[1, 2], [2, 3]], [[401, 'Elm', 2, [1, 2]], [402, 'Fen', 5, [3]]]),
    );
    expect(bonusesAtRisk(g, new Set([1, 2, 3]), new Set([1]))).toEqual([
      { bonusId: 401, name: 'Elm', value: 2, conceded: [1] },
    ]);
    // Not complete after the plan (2 not taken): nothing of Elm is at risk.
    expect(bonusesAtRisk(g, new Set([1, 3]), new Set([1]))).toEqual([]);
    expect(bonusesAtRisk(g, new Set([1, 2, 3]), new Set())).toEqual([]);
  });

  it('overlapping and negative bonuses go through the one income rule', () => {
    // Fir (+6): 1 2 3; Moor (−2): 3 alone, overlapping Fir. 1 faces the enemy and is conceded.
    // Held now: 5 + 6 − 2 = 9. If 1 falls: Fir breaks, Moor stays: 5 − 2 = 3.
    const map = makeMap(
      [1, 2, 3, 20, 22],
      [[1, 2], [2, 3], [1, 20], [20, 22]],
      [
        [501, 'Fir', 6, [1, 2, 3]],
        [502, 'Moor', -2, [3]],
      ],
    );
    const g = buildGraph(map);
    const p = planTurn({
      graph: g,
      board: board([mine(1, 2), mine(2, 2), mine(3, 2), enemy(20, 60), fogged(22)]),
      me: ME,
      income: 9,
      settings: STD,
    });
    expect(p.conceded).toEqual([1]);
    expect(p.expected.nextIncome).toBe(9);
    expect(p.expected.bonusesAtRisk).toEqual([{ bonusId: 501, name: 'Fir', value: 6, conceded: [1] }]);
    expect(p.expected.nextIncomeIfConcededFall).toBe(boardIncome(g, new Set([2, 3]), { base: 5, per: 0 }).total);
    expect(p.expected.nextIncomeIfConcededFall).toBe(3);
  });
});
