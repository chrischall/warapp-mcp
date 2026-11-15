// PLAN-TEAMS C3: the planner with a teammate, on synthetic 2v2 boards (every id and name is made up).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const MATE = 11;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const PLAYERS = [
  { id: ME, team: 0 },
  { id: MATE, team: 0 },
  { id: 20, team: 1 },
  { id: 21, team: 1 },
];

function lineMap(n: number): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: ids.filter((x) => Math.abs(x - id) === 1) })),
    bonuses: [],
    distributionModes: [],
  };
}
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

describe("C3.1: a teammate's territory is no front for idle armies", () => {
  // 1 (enemy 20) ─ 2 (my teammate) ─ 3 4 5 6 (mine, 20 idle on 4) ─ 7 (a 60-army neutral).
  // No enemy is reachable through my territories, so idle armies head for the nearest territory
  // not mine: the teammate's 2 is two steps from 4, the neutral 7 three. A teammate's territory is
  // no front, so they head right, for the neutral.
  const g = buildGraph(lineMap(7));
  const b = board([player(1, 5, 20), player(2, 5, MATE), mine(3, 2), mine(4, 20), mine(5, 2), mine(6, 2), neutral(7, 60)]);
  const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, game: { players: PLAYERS, turn: 8 }, options: { adapt: true } });
  it('moves the idle stack toward the neutral, not toward the teammate', () => {
    const from4 = plan.moves.filter((m) => m.from === 4 && m.kind === 'transfer');
    expect(from4.map((m) => m.to)).toEqual([5]);
    expect(plan.moves.some((m) => m.to === 3 && m.kind === 'transfer')).toBe(false);
  });
  it('a no-team game still heads for the nearest territory not mine', () => {
    const solo = planTurn({
      graph: g,
      board: board([neutral(1, 5), neutral(2, 5), mine(3, 2), mine(4, 20), mine(5, 2), mine(6, 2), neutral(7, 60)]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }], turn: 8 },
      options: { adapt: true },
    });
    expect(solo.moves.filter((m) => m.from === 4 && m.kind === 'transfer').map((m) => m.to)).toEqual([3]);
  });
});

describe("C3.2: the plan's standing sums my team", () => {
  // Me on 1–2, my teammate on 3–4 (a +6 bonus), neutral 5, player 20 on 6–7, player 21 on 8: all in view.
  const g = buildGraph({
    ...lineMap(8),
    bonuses: [{ id: 101, name: 'B101', value: 6, territoryIds: [3, 4], bonusIds: [] }],
  });
  const b = board([mine(1, 5), mine(2, 5), player(3, 5, MATE), player(4, 5, MATE), neutral(5, 2), player(6, 5, 20), player(7, 5, 20), player(8, 5, 21)]);
  it("counts my teammate's income on my side, and the enemy team's together", () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: { ...STD, baseIncome: 5 }, game: { players: PLAYERS, turn: 8 }, options: { adapt: true } });
    // My team 5 + 11 = 16 against team 1's 5 + 5 = 10: ahead (alone, 5 against 5 read even).
    expect(plan.profile?.standing).toBe('ahead');
    expect(plan.profile?.notes.join('\n')).toMatch(/my team's income 16 \(mine 5, player 11 ~11\) against the strongest enemy team, team 1 \(~10: player 20 ~5, player 21 ~5/);
  });
});

describe('C3.3: one owner per bonus', () => {
  // 1 2 (bonus 101, +3, neutrals) ─ 3 (mine, 12) ─ 4 (neutral) 5 (my teammate): bonus 102, +5 ─ 6 7 (neutrals) ─ 8 (player 20).
  // Bonus 102 pays whoever holds 4 and 5; my teammate holds 5, so it is not mine to complete.
  const g = buildGraph({
    ...lineMap(8),
    bonuses: [
      { id: 101, name: 'B101', value: 3, territoryIds: [1, 2], bonusIds: [] },
      { id: 102, name: 'B102', value: 5, territoryIds: [4, 5], bonusIds: [] },
    ],
  });
  const settings = { ...STD, baseIncome: 5 };
  const b = board([neutral(1, 2), neutral(2, 2), mine(3, 12), neutral(4, 2), player(5, 5, MATE), neutral(6, 2), neutral(7, 2), player(8, 5, 20)]);
  const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings, game: { players: PLAYERS, turn: 3 }, options: { adapt: true } });
  it("never works toward a bonus with my teammate's territory in it", () => {
    const text = plan.rationale.join('\n');
    expect(text).toMatch(/Skip bonus B102 \(#102\): my teammate holds T5 \(#5\)/);
    expect(text).not.toMatch(/B102 \(#102\) 11/);
    expect(plan.moves.some((m) => /advances bonus B102/.test(m.reason))).toBe(false);
    expect(plan.moves.some((m) => m.to === 2 && /advances bonus B101/.test(m.reason))).toBe(true);
  });
  it('ignores a focus on such a bonus, with a warning', () => {
    const focused = planTurn({
      graph: g,
      board: b,
      me: ME,
      income: 5,
      settings,
      game: { players: PLAYERS, turn: 3 },
      options: { adapt: true, focusBonusIds: [102] },
    });
    expect(focused.warnings.join('\n')).toMatch(/Focus on bonus B102 \(#102\) ignored: my teammate holds T5 \(#5\)/);
    expect(focused.moves.some((m) => /B102/.test(m.reason))).toBe(false);
  });
  it('reports no shared bonus when I hold none of it', () => {
    expect(plan.team).toBeUndefined();
  });
  it('reports each shared bonus and who is nearer to holding it', () => {
    // 102 grows to 3–5: I hold 3, my teammate 5 (tied, 4 neutral); 103 is 6–8 with my teammate on 6
    // and 7 and me on 8 (my teammate nearer); 104 (7 alone) is my teammate's only.
    const g2 = buildGraph({
      ...lineMap(9),
      bonuses: [
        { id: 102, name: 'B102', value: 5, territoryIds: [3, 4, 5], bonusIds: [] },
        { id: 103, name: 'B103', value: 4, territoryIds: [6, 7, 8], bonusIds: [] },
        { id: 104, name: 'B104', value: 2, territoryIds: [7], bonusIds: [] },
      ],
    });
    const b2 = board([neutral(1, 2), neutral(2, 2), mine(3, 12), neutral(4, 2), player(5, 5, MATE), player(6, 3, MATE), player(7, 3, MATE), mine(8, 4), player(9, 5, 20)]);
    const p2 = planTurn({ graph: g2, board: b2, me: ME, income: 5, settings, game: { players: PLAYERS, turn: 3 }, options: { adapt: true } });
    expect(p2.team?.sharedBonuses).toEqual([
      { bonusId: 102, value: 5, mine: [3], teammates: [{ player: MATE, territories: [5] }], others: [4], nearer: null },
      { bonusId: 103, value: 4, mine: [8], teammates: [{ player: MATE, territories: [6, 7] }], others: [], nearer: MATE },
    ]);
    // 103 has nothing left that I could attack, so it is skipped without a line.
    expect(p2.rationale.join('\n')).not.toMatch(/B103/);
  });
  it('a no-team game still works toward the bonus and reports no team', () => {
    const solo = planTurn({
      graph: g,
      board: board([neutral(1, 2), neutral(2, 2), mine(3, 12), neutral(4, 2), neutral(5, 2), neutral(6, 2), neutral(7, 2), player(8, 5, 20)]),
      me: ME,
      income: 5,
      settings,
      game: { players: [{ id: ME }, { id: 20 }], turn: 3 },
      options: { adapt: true },
    });
    expect(solo.moves.some((m) => /advances bonus B102|completes bonus B102/.test(m.reason))).toBe(true);
    expect(solo.team).toBeUndefined();
  });
});
