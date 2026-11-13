// Lessons from three more lost games — a free-for-all and two 1v1s (issues #17,
// #18, #19; see docs/PLAN-PLANNER-3.md "Why"). Each test replays one lesson in
// miniature on the same synthetic 12-territory map and asserts what the
// defensibility-aware planner now does. Every map, id and name here is made up.
//
//   Vale  (+5): 1 2 3 4     — a home bonus; 1 borders the first opponent at 9
//   Ridge (+7): 5 6 7 8     — a big bonus whose last member 8 faces the second opponent at 10
//   Isle  (+6): 12          — a lone neutral next to my 2 and 3
//   Wilds (+3): 9 11        — the first opponent's bonus
//
//   1─2, 2─3, 3─4, 1─9, 9─11, 4─5, 5─6, 6─7, 7─8, 8─10, 2─12, 3─12
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  MIN_ENEMY_DEPLOY,
  planTurn,
  type PlanOptions,
  type PlannerSettings,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FIRST = 20;
const SECOND = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

const EDGES: [number, number][] = [
  [1, 2], [2, 3], [3, 4], [1, 9], [9, 11],
  [4, 5], [5, 6], [6, 7], [7, 8], [8, 10],
  [2, 12], [3, 12],
];
const IDS = Array.from({ length: 12 }, (_, i) => i + 1);
const MAP: GameMap = {
  id: 1,
  name: 'Frontier',
  territories: IDS.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: EDGES.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [
    { id: 301, name: 'Vale', value: 5, territoryIds: [1, 2, 3, 4], bonusIds: [] },
    { id: 302, name: 'Ridge', value: 7, territoryIds: [5, 6, 7, 8], bonusIds: [] },
    { id: 303, name: 'Isle', value: 6, territoryIds: [12], bonusIds: [] },
    { id: 304, name: 'Wilds', value: 3, territoryIds: [9, 11], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(MAP);

const theirs = (territoryId: number, armies: number, playerId = FIRST): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
/** Fog every territory the board does not list. */
const view = (entries: TerritoryState[]): BoardState => {
  const listed = new Set(entries.map((t) => t.territoryId));
  return board([...entries, ...IDS.filter((id) => !listed.has(id)).map(fogged)]);
};

const plan = (b: BoardState, income: number, options: PlanOptions = {}, settings = STD): TurnPlan =>
  planTurn({ graph: g, board: b, me: ME, income, settings, options });
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const deploySum = (p: TurnPlan) => p.deploys.reduce((s, d) => s + d.armies, 0);

// ---- the boards, one per lesson ----

/** Lesson 1 (#17): the free-for-all's opening — every visible territory still holds 15. */
const openingBoard = view([
  mine(1, 15),
  mine(8, 15),
  neutral(2, 15),
  neutral(7, 15),
  theirs(9, 15, FIRST),
  theirs(10, 15, SECOND),
]);
/** Lesson 1, a turn later: the first opponent visibly holds its +3 Wilds, the second nothing. */
const laterBoard = view([
  mine(1, 15),
  mine(8, 15),
  neutral(2, 15),
  neutral(7, 15),
  theirs(9, 16, FIRST),
  theirs(11, 3, FIRST),
  theirs(10, 15, SECOND),
]);
/** Lesson 2 (#18): Vale is one cheap neutral (4) short; its member 1 borders the first opponent. */
const valeBoard = view([mine(1, 4), mine(2, 1), mine(3, 4), neutral(4, 2), theirs(9, 6), theirs(11, 1)]);
/** Lesson 3 (#19): Ridge (+7) is one neutral (8) short; 8 faces the second opponent's stack at 10. */
const ridgeBoard = (stack: number) =>
  view([mine(5, 1), mine(6, 1), mine(7, 4), neutral(8, 2), theirs(10, stack, SECOND)]);
/** Lesson 4 (#17): the Isle neutral (15) sits between two of my 15-stacks; income 5. */
const isleBoard = view([mine(2, 15), mine(3, 15), neutral(12, 15), neutral(1, 30), neutral(4, 30)]);

describe('lessons from the free-for-all and the two 1v1s', () => {
  it('1. on the opening board an opponent is assumed to deploy its base income, not 75% of a 15-stack', () => {
    // 14 movable + 5 = 19 cannot take a 15-stack (25 needed); the old 0.75 × 15 ≈ 11 said 25 could,
    // so every border looked doomed and the turn went on useless holds.
    expect(armiesToTake(15, STD)).toBe(25);
    const p = plan(openingBoard, 5);
    expect(p.enemyDeploy).toBe(MIN_ENEMY_DEPLOY);
    expect(p.conceded).toEqual([]);
    const w = p.warnings.join('\n');
    expect(w).not.toMatch(/could be taken/);
    expect(w).toMatch(/Enemy deploy estimate for player 20: ~5 \(opening board/);
    expect(w).toMatch(/Enemy deploy estimate for player 30: ~5 \(opening board/);
    expect(deploySum(p)).toBe(5);

    // A turn later each opponent is judged on its own visible income: base 5 + Wilds +3 = 8
    // for the first, the floor for the second.
    const q = plan(laterBoard, 5);
    const v = q.warnings.join('\n');
    expect(v).toMatch(/for player 20: ~8 \(base 5 \+ visible bonuses \+3 = 8/);
    expect(v).toMatch(/for player 30: ~5 \(base 5 \+ visible bonuses \+0 = 5/);
    expect(q.enemyDeploy).toBe(8);
  });

  it('2. a border in the bonus this turn completes is kept and garrisoned, not conceded and withdrawn', () => {
    // Judged on the start-of-turn holdings T1 protected +0 and was abandoned — defeating the
    // capture of T4 that completes Vale this turn. Since #122 it carries its share of Vale, the
    // bonus being built, so it is held from the start (rule 1c keeps one conceded before).
    const p = plan(valeBoard, 5);
    expect(p.expected.bonusesCompleted).toEqual([301]);
    expect(attacks(p)).toEqual([expect.objectContaining({ from: 3, to: 4, armies: 3 })]);
    expect(p.conceded).toEqual([]);
    expect(p.moves.some((m) => m.from === 1)).toBe(false);
    expect(deployedTo(p, 1)).toBeGreaterThanOrEqual(3);
    // The opponent visibly holds a bonus (#119: all of it is deployable, whatever its stack), so
    // T1 is garrisoned for the completed Vale against that whole threat.
    expect(p.rationale.join('\n')).toMatch(/Garrison T1 \(#1\) for bonus Vale \(#301\) \(\+5\), completed this turn: deploy \d+/);
  });

  it('3. a big bonus is not completed when its new member falls next turn: the income garrisons instead', () => {
    // T10 (30): threat 29 + 5 = 34; T8's 2 survivors would need 21 more to hold — far over the next
    // income of 5 + 7 = 12. Completing Ridge would be worth one turn of +7 at most.
    const p = plan(ridgeBoard(30), 5);
    expect(attacks(p)).toEqual([]);
    expect(p.expected.bonusesCompleted).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(
      /completing Ridge \(#302\) leaves T8 \(#8\) indefensible \(player 30 can take it for \d+; next income 12\): not completed/,
    );
    expect(p.rationale.join('\n')).toMatch(/Do not complete bonus Ridge \(#302\)/);
    expect(deploySum(p)).toBe(5);

    // Control: against a small stack the frontier holds, so Ridge is completed.
    const q = plan(ridgeBoard(3), 5);
    expect(q.expected.bonusesCompleted).toEqual([302]);
    expect(q.warnings.join('\n')).not.toMatch(/indefensible/);
  });

  it('4. a neutral no single stack can reach is taken by two attacks in a fixed order (0% luck)', () => {
    // One source: 14 + 5 = 19 < 25. T3's 14 kill 8 (and fail by design); T2 takes the last 7 with 11.
    expect(armiesToTake(7, STD)).toBe(11);
    const p = plan(isleBoard, 5);
    expect(attacks(p).map((m) => [m.from, m.to, m.armies])).toEqual([
      [3, 12, 14],
      [2, 12, 11],
    ]);
    expect(p.expected.captures).toEqual([12]);
    expect(p.expected.bonusesCompleted).toEqual([303]);
    expect(p.multiSourceCaptures).toEqual([12]);
    expect(p.warnings.join('\n')).toMatch(/T12 \(#12\) combines 2 attacks that must run in this order/);

    // With luck the exact arithmetic is gone: not attempted, and warned (the luck-margined
    // ceil(25 / 0.84) = 30 is still economic for +6, so only the luck stops it).
    const q = plan(isleBoard, 5, {}, { ...STD, luckModifier: 0.16 });
    expect(attacks(q)).toEqual([]);
    expect(q.multiSourceCaptures).toEqual([]);
    expect(q.warnings.join('\n')).toMatch(/Multi-source capture of T12 \(#12\) skipped/);
  });

  it('every lesson plan is a valid turn', () => {
    const cases: [BoardState, number][] = [
      [openingBoard, 5],
      [laterBoard, 5],
      [valeBoard, 5],
      [ridgeBoard(30), 5],
      [ridgeBoard(3), 5],
      [isleBoard, 5],
    ];
    for (const [b, income] of cases)
      for (const goal of ['balanced', 'expand', 'complete-bonus', 'defend'] as const) {
        const p = plan(b, income, { goal });
        expect(deploySum(p)).toBe(income);
        const state = new Map(b.territories.map((t) => [t.territoryId, t]));
        const out = new Map<number, number>();
        for (const m of p.moves) {
          const o = state.get(m.from)!.owner;
          expect(o.kind === 'player' && o.playerId === ME, `${goal}: moves from my own territory`).toBe(true);
          out.set(m.from, (out.get(m.from) ?? 0) + m.armies);
        }
        for (const [from, n] of out)
          expect(n, `${goal}: outgoing from ${from}`).toBeLessThanOrEqual(state.get(from)!.armies! + deployedTo(p, from) - 1);
      }
  });
});
