// #274 items 2 and 3: my commander walks out of a pocket, and its territory is held against the worst case.
import { describe, expect, it } from 'vitest';
import type { BoardSpecialUnit, TerritoryState } from '../../src/board.js';
import { armiesToTake, COMMANDER_STRENGTH } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { commanderSafety } from '../../src/analysis/commander-safety.js';
import { COMMANDER_CLEAR_MOVES, commanderPlace } from '../../src/analysis/plan/commander.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const B = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const GUARD_OFF: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };

function makeMap(ids: number[], edges: [number, number][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [],
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number, playerId = A): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });
const commander = (playerId: number): BoardSpecialUnit => ({ kind: 'commander', id: `${playerId}`.padStart(32, '0'), playerId });
const withCommander = (t: TerritoryState): TerritoryState => ({ ...t, specialUnits: [commander(ME)] });
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const commanderMoves = (p: TurnPlan) => p.moves.filter((m) => m.commander === true);

// The live shape before the pocket closed: my commander's territory T1 has opponents on four
// sides (two players, 0–1 armies each, guard off) and two territories of mine, T6 and T7. T7
// borders an enemy too; T6 leads inland, T6 → T8 → T9 → T10, away from every enemy.
//
//   T2 T3 T4 (A)  T5 (B)
//    \ |  /       /
//      T1 ───────
//     /  \
//   T6    T7 ─ T4
//    |
//   T8 ─ T9 ─ T10
//
// Each opponent has more land behind T2 and T5, in the fog (T11, T12): neither can be finished off.
const pocket = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    [[1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [1, 7], [7, 4], [6, 8], [8, 9], [9, 10], [2, 11], [5, 12]],
  ),
);
const fogged = (territoryId: number): TerritoryState => ({ territoryId, owner: { kind: 'unknown' }, armies: null });
const pocketBoard = (at: number) =>
  board(
    [
      at === 1 ? withCommander(mine(1, 341)) : mine(1, 341),
      enemy(2, 1),
      enemy(3, 0),
      enemy(4, 1),
      enemy(5, 1, B),
      at === 6 ? withCommander(mine(6, 10)) : mine(6, 10),
      mine(7, 10),
      at === 8 ? withCommander(mine(8, 5)) : mine(8, 5),
      mine(9, 5),
      mine(10, 5),
      fogged(11),
      fogged(12),
    ],
    true,
  );

describe('commanderPlace (#274)', () => {
  it('walks one step through my land toward the nearest territory clear of every enemy', () => {
    const hostile = [2, 3, 4, 5];
    const isMine = (t: number) => [1, 6, 7, 8, 9, 10].includes(t);
    expect(commanderPlace(pocket, 1, isMine, hostile)).toEqual({
      territory: 1,
      distance: 1,
      retreat: { from: 1, to: 6, distance: 1, toDistance: 2, target: 8, targetDistance: 3, steps: 2 },
    });
    // Next turn, from T6, it reaches T8, three moves clear; there it stays.
    expect(commanderPlace(pocket, 6, isMine, hostile).retreat).toMatchObject({ from: 6, to: 8, toDistance: 3 });
    expect(commanderPlace(pocket, 8, isMine, hostile)).toEqual({ territory: 8, distance: COMMANDER_CLEAR_MOVES });
  });

  it('never steps nearer an enemy, and stays when nothing farther is reachable', () => {
    // T6 lost: T7 borders an enemy, as T1 does: nowhere safer.
    const isMine = (t: number) => [1, 7].includes(t);
    expect(commanderPlace(pocket, 1, isMine, [2, 3, 4, 5, 6])).toEqual({ territory: 1, distance: 1 });
  });

  it('never steps onto a territory beside an enemy, even on the way to safety', () => {
    // T1 → T7 → T4 is no route: T7 borders the enemy on T4. Make T7 lead inland instead.
    const g = buildGraph(makeMap([1, 2, 7, 8, 9], [[1, 2], [1, 7], [7, 2], [7, 8], [8, 9]]));
    expect(commanderPlace(g, 1, (t) => [1, 7, 8, 9].includes(t), [2])).toEqual({ territory: 1, distance: 1 });
  });

  it('counts fogged territories as enemies, and stays with none on the map', () => {
    const isMine = (t: number) => [1, 6, 7, 8, 9, 10].includes(t);
    expect(commanderPlace(pocket, 8, isMine, [10]).retreat).toMatchObject({ from: 8, to: 6 });
    expect(commanderPlace(pocket, 1, isMine, [])).toEqual({ territory: 1, distance: null });
  });
});

describe('planner: my commander walks out of a pocket (#274)', () => {
  it('the live shape: on turn 2 the commander leaves the pocket with a commander move, said first', () => {
    const plan = planTurn({ graph: pocket, board: pocketBoard(1), me: ME, income: 779, settings: GUARD_OFF, turn: 2 });
    expect(commanderMoves(plan)).toEqual([expect.objectContaining({ from: 1, to: 6, kind: 'transfer', commander: true })]);
    expect(plan.moves[0]).toMatchObject({ from: 1, to: 6, commander: true });
    expect(plan.warnings[0]).toMatch(/^My commander moves from T1 \(#1\) to T6 \(#6\) this turn \(#274\): T1 \(#1\) is 1 move from the nearest enemy or fog/);
    expect(plan.warnings[0]).toContain('T1 (#1) is no longer must-hold');
    // Only one commander order; it carries no armies the plan needs elsewhere.
    expect(plan.moves.filter((m) => m.from === 1 && m.to === 6)).toHaveLength(1);
  });

  it('the next turn it walks on to T8, three moves clear, and there it stays', () => {
    const second = planTurn({ graph: pocket, board: pocketBoard(6), me: ME, income: 779, settings: GUARD_OFF, turn: 3 });
    expect(commanderMoves(second)).toEqual([expect.objectContaining({ from: 6, to: 8, commander: true })]);
    const third = planTurn({ graph: pocket, board: pocketBoard(8), me: ME, income: 779, settings: GUARD_OFF, turn: 4 });
    expect(commanderMoves(third)).toEqual([]);
    expect(third.rationale).toContain('My commander stays on T8 (#8): it is 3 moves from the nearest enemy or fog, clear at 3 (#274).');
    expect(third.warnings.some((w) => w.startsWith('My commander moves'))).toBe(false);
  });

  it('under No-Split the walk is its territory\'s one order and takes the whole stack', () => {
    const plan = planTurn({ graph: pocket, board: pocketBoard(1), me: ME, income: 779, settings: { ...GUARD_OFF, noSplit: true }, turn: 2 });
    const out = plan.moves.filter((m) => m.from === 1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ to: 6, commander: true });
    expect(out[0]!.armies).toBe(341 + deployedTo(plan, 1));
  });
});

describe('planner: the territory my commander walks from holds it until my first order runs (#274)', () => {
  // T1 (my commander, 10) beside A's T2 (20); T3, mine, leads away to T4.
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [1, 3], [3, 4]]));
  const b = board([withCommander(mine(1, 10)), enemy(2, 20), mine(3, 2), mine(4, 2)], true);

  it('deploys what survives the opponent\'s first attack there: its stack and its whole deploy, at least my income', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 30, settings: STD });
    expect(commanderMoves(plan)).toEqual([expect.objectContaining({ from: 1, to: 3 })]);
    // One attack: 19 movable + max(~5, my 30) = 49, against 10 armies, the deploys and my commander.
    let need = 0;
    while ((armiesToTake(10 + COMMANDER_STRENGTH + need) ?? Infinity) <= 49) need++;
    expect(deployedTo(plan, 1)).toBeGreaterThanOrEqual(need);
    expect(plan.rationale).toContain(
      `Deploy ${need} to T1 (#1): my commander walks from it this turn (#274), but until my first order runs the opponent's first attack may land there: with my commander it then holds against ~49 (player 20's strongest stack beside it and its whole deploy, never below my own income).`,
    );
  });

  it('known to move first, it still deploys the hold: the submit\'s commander check tries the opponent moving first too (#274 review)', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 30, settings: STD, options: { movesFirst: true } });
    const unknown = planTurn({ graph: g, board: b, me: ME, income: 30, settings: STD });
    expect(commanderMoves(plan)).toEqual([expect.objectContaining({ from: 1, to: 3 })]);
    expect(deployedTo(plan, 1)).toBe(deployedTo(unknown, 1));
    expect(deployedTo(plan, 1)).toBeGreaterThan(0);
    expect(plan.rationale.some((r) => r.includes('until my first order runs'))).toBe(true);
  });

  it('the review\'s shape: known to move first, the walk leaves no commander the submit\'s check finds killable', () => {
    // T1 (my commander, 10) beside A's T2 (40), the fog behind it; T3 and T4, mine, lead inland.
    const g2 = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [2, 5], [1, 3], [3, 4]]));
    const b2 = board([withCommander(mine(1, 10)), enemy(2, 40), mine(3, 2), mine(4, 2), fogged(5)], true);
    const first = planTurn({ graph: g2, board: b2, me: ME, income: 30, settings: STD, options: { movesFirst: true } });
    expect(commanderMoves(first)).toEqual([expect.objectContaining({ from: 1, to: 3 })]);
    const opponents = [{ id: A, deploy: 30 }];
    const check = (p: TurnPlan) =>
      commanderSafety({
        graph: g2,
        board: b2,
        me: ME,
        deploys: p.deploys,
        moves: p.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies, ...(m.commander ? { withCommander: true } : {}) })),
        opponents,
        settings: STD,
        killedBy: false,
      })!;
    expect(check(first).killers).toBe(0);
  });

  it('says so when the deploy cannot make it hold, and the walk is my first order', () => {
    const plan = planTurn({ graph: g, board: board([withCommander(mine(1, 10)), enemy(2, 200), mine(3, 2), mine(4, 2)], true), me: ME, income: 30, settings: STD });
    expect(plan.moves[0]).toMatchObject({ from: 1, to: 3, commander: true });
    expect(plan.warnings.some((w) => w.startsWith('My commander may be caught on T1 (#1) before it walks (#274)'))).toBe(true);
  });
});

describe('planner: Order Priority for the walk only when my commander may be caught (#274 review)', () => {
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [1, 3], [3, 4]]));
  const opts = { holdsOrderPriority: true } as const;

  it('advised when the transit hold falls short: the walk is my first order', () => {
    const plan = planTurn({ graph: g, board: board([withCommander(mine(1, 10)), enemy(2, 200), mine(3, 2), mine(4, 2)], true), me: ME, income: 30, settings: STD, options: opts });
    expect(plan.cardAdvice).toBe('order-priority');
    expect(plan.moves[0]).toMatchObject({ from: 1, to: 3, commander: true });
  });

  it('not advised when the transit hold already holds it against the opponent\'s first attack', () => {
    const plan = planTurn({ graph: g, board: board([withCommander(mine(1, 10)), enemy(2, 20), mine(3, 2), mine(4, 2)], true), me: ME, income: 30, settings: STD, options: opts });
    expect(commanderMoves(plan)).toEqual([expect.objectContaining({ from: 1, to: 3 })]);
    expect(plan.cardAdvice).toBeNull();
  });

  it('not advised when nothing can reach the territory it leaves before it moves', () => {
    // T5 (my commander) between T1 and T3, both mine: A's T2 is two moves away. It walks 5 → 3, carrying nothing.
    const g5 = buildGraph(makeMap([1, 2, 3, 4, 5], [[2, 1], [1, 5], [5, 3], [3, 4]]));
    const plan = planTurn({
      graph: g5,
      board: board([mine(1, 5), enemy(2, 5), mine(3, 2), mine(4, 2), withCommander(mine(5, 2))], true),
      me: ME,
      income: 10,
      settings: STD,
      options: opts,
    });
    expect(commanderMoves(plan)).toEqual([expect.objectContaining({ from: 5, to: 3 })]);
    expect(plan.cardAdvice).toBeNull();
  });

  it('advised when the territory it leaves borders the fog: no hold can be sized against what is hidden there', () => {
    const gf = buildGraph(makeMap([1, 3, 4, 5], [[1, 5], [1, 3], [3, 4]]));
    const plan = planTurn({ graph: gf, board: board([withCommander(mine(1, 10)), mine(3, 2), mine(4, 2), fogged(5)], true), me: ME, income: 10, settings: STD, options: opts });
    expect(commanderMoves(plan)).toEqual([expect.objectContaining({ from: 1, to: 3 })]);
    expect(plan.cardAdvice).toBe('order-priority');
  });
});

describe('planner: my commander\'s territory is held against the worst case (#274)', () => {
  // T1 (my commander, 20) borders A's T2 (10 armies); A's T3 (20) is two moves away through T2.
  // T4, my only other territory, borders A's T5: nowhere safer to walk.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [2, 3], [1, 4], [4, 5]]));
  const b = board([withCommander(mine(1, 20)), enemy(2, 10), enemy(3, 20), mine(4, 5), enemy(5, 2)], true);

  it('sizes the hold for the larger of the estimate and my income, plus every stack within two moves', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 50, settings: STD });
    expect(commanderMoves(plan)).toEqual([]);
    // Worst case: max(~5, my 50) + 9 (T2) + 19 (T3) + 1 (T5, through T4) movable = 79; the old threat was 9 + 5 = 14.
    let need = 0;
    while ((armiesToTake(20 + COMMANDER_STRENGTH + need) ?? Infinity) <= 79) need++;
    expect(need).toBeGreaterThan(0);
    expect(deployedTo(plan, 1)).toBeGreaterThanOrEqual(need);
    expect(plan.rationale.some((r) => r.startsWith("My commander's territory T1 (#1) is held against the worst case (#274), ~79"))).toBe(true);
    expect(plan.rationale).toContain(
      'My commander stays on T1 (#1), 1 move from the nearest enemy or fog: no territory of mine farther from every enemy is reachable through my land without coming nearer one, so it holds there (#274).',
    );
  });

  it('with no safer territory and a hold it cannot fund, it deploys everything there and says so first', () => {
    const plan = planTurn({ graph: g, board: board([withCommander(mine(1, 20)), enemy(2, 200), enemy(3, 20), mine(4, 5), enemy(5, 2)], true), me: ME, income: 20, settings: STD });
    expect(commanderMoves(plan)).toEqual([]);
    expect(deployedTo(plan, 1)).toBe(20);
    expect(plan.warnings[0]).toMatch(/^My commander's territory T1 \(#1\) cannot be made safe this turn: .*it cannot walk away\.$/);
    expect(plan.moves.filter((m) => m.from === 1)).toEqual([]);
  });

  it('under Multi-Attack a stack two moves away through my land sizes its territory too (#274 review)', () => {
    // T1 (my commander, 3) – T2 (mine, 3) – A's T3 (100) – the fog: A chains through T2 onto T1.
    const line = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [3, 4]]));
    const b4 = board([withCommander(mine(1, 3)), mine(2, 3), enemy(3, 100), fogged(4)], true);
    const plan = planTurn({ graph: line, board: b4, me: ME, income: 10, settings: { ...STD, multiAttack: true } });
    expect(commanderMoves(plan)).toEqual([]);
    expect(plan.rationale.some((r) => r.startsWith("My commander's territory T1 (#1) is held against the worst case (#274), ~109"))).toBe(true);
    expect(plan.warnings[0]).toMatch(/^My commander's territory T1 \(#1\) cannot be made safe this turn: .*it cannot walk away\.$/);
    // Without Multi-Attack the stack cannot reach it this turn: no border there.
    const plain = planTurn({ graph: line, board: b4, me: ME, income: 10, settings: STD });
    expect(plain.rationale.some((r) => r.startsWith("My commander's territory T1 (#1) is held against the worst case"))).toBe(false);
  });

  it('a commander three moves clear is no border: nothing is deployed for it and it stays', () => {
    const far = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [2, 3], [3, 4], [4, 5]]));
    const plan = planTurn({
      graph: far,
      board: board([withCommander(mine(1, 5)), mine(2, 5), mine(3, 5), enemy(4, 10), neutral(5, 2)], true),
      me: ME,
      income: 10,
      settings: STD,
    });
    expect(commanderMoves(plan)).toEqual([]);
    expect(plan.rationale).toContain('My commander stays on T1 (#1): it is 3 moves from the nearest enemy or fog, clear at 3 (#274).');
  });
});
