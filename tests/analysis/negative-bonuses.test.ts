// Issue #70: on maps with overlapping bonuses (each sea tile a single-territory −4 bonus and
// a member of a +22 four-tile group) every capture is scored by its net effect on income.
// Synthetic maps only: made-up ids and names.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGoal, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral, tinyMap } from './helpers.js';

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
    // Staging it (rule c) drops income to 1: the other three cost 18, ceil(18 / 1) = 18
    // turns to finish > PAYBACK_TURNS: refused.
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
    // Sea tiles hold 4 (6 each). 10 income: one tile now, and it drops income to 6. The other
    // three cost 18 at that income: ceil(18 / 6) = 3 turns, 3 × 16 = 48 ≤ 10 × 6 = 60: staged.
    const p = planTurn({
      graph: SEA,
      board: board([mine(1, 1), neutral(2, 40), neutral(11, 4), neutral(12, 4), neutral(13, 4), neutral(14, 4)]),
      me: ME,
      income: 10,
      settings: STD,
    });
    expect(attacks(p).map((m) => m.to)).toEqual([11]);
    expect(attacks(p)[0]!.reason).toMatch(/^stages bonus/);
    expect(attacks(p)[0]!.reason).not.toMatch(/advances/);
    expect(p.expected.nextIncome).toBe(6);
    expect(p.rationale.join('\n')).toMatch(/~3 turns at income 6 \(after this step\); 3 turns × 16 = 48.*60/);
    expect(p.warnings.join('\n')).toMatch(/lowers next income from 10 to 6: .*T11 \(#11\).*stages bonus/);
  });

  it('staging counts turns-to-finish at the income left after the step, not before it', () => {
    // Sea tiles hold 2 (3 each). 5 income affords one, but it drops income to 1: the other
    // three (9) take ceil(9 / 1) = 9 turns, 9 × 16 = 144 > 60: refused. (At this turn's
    // income it would look like 2 turns, 32 ≤ 60, and stall the next turn at income 1.)
    const p = planTurn({
      graph: SEA,
      board: board([mine(1, 1), neutral(2, 40), neutral(11, 2), neutral(12, 2), neutral(13, 2), neutral(14, 2)]),
      me: ME,
      income: 5,
      settings: STD,
    });
    expect(attacks(p)).toEqual([]);
    expect(p.expected.nextIncome).toBe(5);
    expect(p.rationale.join('\n')).toMatch(/~9 turns away \(9 armies at income 1 after this step\); 9 × 16 = 144/);
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

  it('(e) the guard takes back a combined (multi-source) capture whole: softener and finisher', () => {
    // 1 (12) and 3 (10) both border enemy 21 (10), a lone −4 bonus and part of the enemy's
    // +5 pair. Neither alone can take it, so the break is a combined capture (3 softens,
    // 1 finishes); it would complete my −4, so the guard drops both attacks.
    const cg = buildGraph(
      makeMap(
        [1, 3, 21, 22],
        [
          [1, 3],
          [1, 21],
          [3, 21],
          [21, 22],
        ],
        [
          [900, 'Enemy pair', 5, [21, 22]],
          [901, 'Swamp', -4, [21]],
        ],
      ),
    );
    const s = board([mine(1, 12), mine(3, 10), enemy(21, 10), enemy(22, 1)]);
    const f = planTurn({ graph: cg, board: s, me: ME, income: 3, settings: STD, options: { focusBonusIds: [901] } });
    expect(f.multiSourceCaptures.length).toBe(1);
    expect(attacks(f).map((m) => m.from).sort()).toEqual([1, 3]);
    const p = planTurn({ graph: cg, board: s, me: ME, income: 3, settings: STD });
    expect(p.moves).toEqual([]);
    expect(p.multiSourceCaptures).toEqual([]);
    expect(p.expected.captures).toEqual([]);
    expect(p.expected.nextIncome).toBe(3);
    expect(p.rationale.join('\n')).toMatch(/Drop the attack on T21 \(#21\): it completes Swamp \(#901\) -4.*next income -1 → 3/);
    expect(p.rationale.join('\n')).not.toMatch(/Attack T21|wears T21/);
    expect(p.warnings.join('\n')).not.toMatch(/The capture of T21 \(#21\) combines/);
    // Both stacks are whole again (the softener's armies back, its survivors' return undone),
    // so the leftover goes to the weaker border, T3 (10 against T1's 12).
    expect(p.deploys).toEqual([{ territoryId: 3, armies: 3 }]);
    // Equal stacks (10 and 10, income 5): if the softener's armies stayed spent, T3 would look
    // weaker and take the leftover; whole again, the tie goes to the lower id, T1.
    const even = board([mine(1, 10), mine(3, 10), enemy(21, 10), enemy(22, 1)]);
    const fe = planTurn({ graph: cg, board: even, me: ME, income: 5, settings: STD, options: { focusBonusIds: [901] } });
    expect(fe.multiSourceCaptures.length).toBe(1);
    const e = planTurn({ graph: cg, board: even, me: ME, income: 5, settings: STD });
    expect(e.moves).toEqual([]);
    expect(e.expected.nextIncome).toBe(5);
    expect(e.deploys).toEqual([{ territoryId: 1, armies: 5 }]);
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

// Net scoring in the complete-vs-hold decision (rule 1h.3): a completion is weighed by its net
// worth, never its gross value. Keep (+10): 1 2 3 4, mine; 1, 2, 3 (2 armies each) face enemy
// 4-stacks on 11, 12, 13 (fog behind at 14). 4 borders the 1-army neutrals 20, 21: Sea (+22)
// whose two tiles are each a lone −8 bonus, so completing it nets +22 − 16 = +6.
const KEEP_SEA = buildGraph(
  makeMap(
    [1, 2, 3, 4, 11, 12, 13, 14, 20, 21],
    [
      [1, 2],
      [2, 3],
      [1, 4],
      [2, 4],
      [3, 4],
      [1, 11],
      [2, 12],
      [3, 13],
      [11, 14],
      [12, 14],
      [13, 14],
      [4, 20],
      [4, 21],
      [20, 21],
    ],
    [
      [601, 'Keep', 10, [1, 2, 3, 4]],
      [602, 'Sea', 22, [20, 21]],
      [603, 'Reef', -8, [20]],
      [604, 'Reef', -8, [21]],
    ],
  ),
);
const KEEP_SEA_BOARD = board([
  mine(1, 2),
  mine(2, 2),
  mine(3, 2),
  mine(4, 1),
  enemy(11, 4),
  enemy(12, 4),
  enemy(13, 4),
  fogged(14),
  neutral(20, 1),
  neutral(21, 1),
]);

describe('negative bonuses (#70): completions compete with holds at their net worth', () => {
  it('a net +6 cluster (+22 gross) does not starve the hold of a +10 bonus', () => {
    // Holding Keep's three borders needs 4 each (12, the whole income). Completing Sea
    // (4 armies) first would leave 8: Keep is conceded for +6 net. Gross +22 > 10 would
    // complete it; net +6 < 10 holds Keep instead.
    const p = planTurn({ graph: KEEP_SEA, board: KEEP_SEA_BOARD, me: ME, income: 12, settings: STD });
    expect(p.conceded).toEqual([]);
    expect(p.expected.bonusesCompleted).toEqual([]);
    expect(p.expected.nextIncome).toBe(12);
    expect(p.rationale.join('\n')).toMatch(
      /Complete bonus Sea \(#602\) \(\+22, net \+6\) only after holding Keep \(#601\) \(\+10\)/,
    );
  });
});

describe('negative bonuses (#70): default maps plan as before', () => {
  it('(f) an unrelated lone negative bonus nobody can reach changes nothing', () => {
    // tinyMap has no negative bonus; adding an isolated territory 8 in a lone −4 bonus must
    // leave every plan exactly as it was (deploys, moves, reasons, rationale, warnings).
    const base = tinyMap();
    const withNeg: GameMap = {
      ...base,
      territories: [...base.territories, { id: 8, name: 'T8', connectedTo: [] }],
      bonuses: [...base.bonuses, { id: 105, name: 'Bog', value: -4, territoryIds: [8], bonusIds: [] }],
    };
    const tiles = [mine(1, 4), mine(2, 1), neutral(3, 2), neutral(4, 2), neutral(5, 2), neutral(6, 1), neutral(7, 1)];
    for (const goal of ['balanced', 'expand', 'complete-bonus', 'defend'] as PlanGoal[]) {
      const a = planTurn({ graph: buildGraph(base), board: board(tiles), me: ME, income: 6, settings: STD, options: { goal } });
      const b = planTurn({
        graph: buildGraph(withNeg),
        board: board([...tiles, neutral(8, 2)]),
        me: ME,
        income: 6,
        settings: STD,
        options: { goal },
      });
      expect(attacks(a).length, goal).toBeGreaterThan(0);
      expect(b, goal).toEqual(a);
    }
  });
});
