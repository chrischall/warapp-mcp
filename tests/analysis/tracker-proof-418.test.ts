// Issue #418, the owner's decisions of 2026-11-20: proof moves an estimate. Every board here is synthetic.
//  1. The under-read floor: a capture with every source army in view proves a minimum deploy — the
//     attackers it needed beyond what its stacks beside the target could send (`captureFloor`). Proof may
//     always raise an estimate: the turn's reading never falls below it, and a carry it reaches is
//     confirmed (the #418 rise cap never holds it).
//  2. The over-read tripwire: proof may lower an estimate only on a turn where every army the opponent
//     could have deployed is accounted for in view (`everyArmyInView`: its land and everything beside it in
//     view, nothing beside it that could hide a fight). It moves at most one step a turn (÷ RISE_CAP)
//     toward that turn's reading, and never below it.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { everyArmyInView, incomeBasis, RISE_CAP, trackOpponents, type MyOrders, type TurnBoard } from '../../src/analysis/opponents.js';
import { captureFloor, observeDeploy, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const OTHER = 30;
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
const enemy = (territoryId: number, armies: number, playerId = ENEMY): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });
const line = (n: number) => Array.from({ length: n - 1 }, (_, i) => [i + 1, i + 2] as [number, number]);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const history = (boards: BoardState[], first = 8): TurnBoard[] => boards.map((board, i) => ({ turn: first + i, board }));

describe('1. the under-read floor: a capture with every source in view proves a deploy (#418)', () => {
  // T1 fogged; its T2 (40) and T4 (1) in view; my T3 between them; the neutral T5 (4) beside T4 and T6.
  // It deploys 44 on T4, takes T5 with all of them (41 stand there), and walks T2's 39 into the fog. The
  // fogged T1 may be its +40 bonus, so it could earn 45.
  const g = buildGraph(makeMap(range(1, 7), line(7), [[101, 5, [6, 7]], [102, 40, [1]]]));
  const before = board([fogged(1), enemy(2, 40), mine(3, 30), enemy(4, 1), neutral(5, 4), neutral(6, 2), mine(7, 3)]);
  const after = board([fogged(1), enemy(2, 1), mine(3, 30), enemy(4, 1), enemy(5, 41), neutral(6, 2), mine(7, 3)]);

  it('the attackers that stand on the capture, plus the one the last defender surely killed, beyond what T4 could send', () => {
    const p = captureFloor(g, before, after, ENEMY, STD);
    expect(p).toEqual({ territories: [5], attackers: 42, supply: 0, floor: 42 });
  });

  it('the turn reads at least that, though the walk into the fog drags its net change down', () => {
    const o = observeDeploy(g, after, before, ENEMY, STD, { me: ME });
    expect(o.captureFloor).toBe(42);
    expect(o.proven).toEqual([5]);
    expect(o.deploy).toBe(42);
    expect(o.low).toBe(42);
  });

  it('no floor when a neighbour of the target hid its owner on the earlier board: a stack may have come from there', () => {
    const b = board([fogged(1), enemy(2, 40), mine(3, 30), enemy(4, 1), neutral(5, 4), fogged(6), mine(7, 3)]);
    const a = board([fogged(1), enemy(2, 1), mine(3, 30), enemy(4, 1), enemy(5, 41), fogged(6), mine(7, 3)]);
    expect(captureFloor(g, b, a, ENEMY, STD).floor).toBe(0);
  });

  it('no floor when another player borders the target (it may have worn the defenders down), nor under Multi-Attack', () => {
    const b = board([fogged(1), enemy(2, 40), mine(3, 30), enemy(4, 1), neutral(5, 4), enemy(6, 9, OTHER), mine(7, 3)]);
    const a = board([fogged(1), enemy(2, 1), mine(3, 30), enemy(4, 1), enemy(5, 41), enemy(6, 9, OTHER), mine(7, 3)]);
    expect(captureFloor(g, b, a, ENEMY, STD).floor).toBe(0);
    expect(captureFloor(g, before, after, ENEMY, { ...STD, multiAttack: true }).floor).toBe(0);
  });

  it('what its stacks beside the target could send (less the guard) is taken out', () => {
    const b = board([fogged(1), enemy(2, 40), mine(3, 30), enemy(4, 11), neutral(5, 4), neutral(6, 2), mine(7, 3)]);
    expect(captureFloor(g, b, after, ENEMY, STD)).toEqual({ territories: [5], attackers: 42, supply: 10, floor: 32 });
  });

  it('a capture beside my land reads only with my orders known, and none of them touching the target', () => {
    // My T6 beside the target: I may have attacked it first.
    const b = board([fogged(1), enemy(2, 40), mine(3, 30), enemy(4, 1), neutral(5, 4), mine(6, 2), mine(7, 3)]);
    const a = board([fogged(1), enemy(2, 1), mine(3, 30), enemy(4, 1), enemy(5, 41), mine(6, 2), mine(7, 3)]);
    expect(captureFloor(g, b, a, ENEMY, STD, 1, { me: ME }).floor).toBe(0);
    const quiet: MyOrders = { deploys: [], moves: [], sent: [], cards: [] };
    expect(captureFloor(g, b, a, ENEMY, STD, 1, { me: ME, orders: quiet }).floor).toBe(42);
    const hit: MyOrders = { deploys: [], moves: [{ from: 6, to: 5, armies: 1 }], sent: [{ from: 6, to: 5 }], cards: [] };
    expect(captureFloor(g, b, a, ENEMY, STD, 1, { me: ME, orders: hit }).floor).toBe(0);
  });

  it('the tracker reads the floor into the turn, and a carry it reaches is confirmed', () => {
    const quiet = board([fogged(1), enemy(2, 1), mine(3, 30), enemy(4, 1), enemy(5, 41), neutral(6, 2), mine(7, 3)]);
    const [t] = trackOpponents(g, history([before, after, quiet]), ME, STD);
    expect(t!.turns[0]!.captureFloor).toBe(42);
    expect(t!.turns[0]!.observed).toBe(42);
    expect(t!.income).toBe(42);
  });

  it('proof is never held below by the rise cap while I lead: the proven 42 stands, not 1.3 × the 5 before it', () => {
    // My +20 bonus on T3 and 400 armies there: I lead it three to one on armies in view, on income above its 5.
    // On the capture turn 45 also walk onto T2 beside the fog: read as deploy up to the bound, the rest a
    // move out of the fog, so the turn is not read in full and only the proof confirms anything.
    const gl = buildGraph(makeMap(range(1, 7), line(7), [[101, 5, [6, 7]], [102, 40, [1]], [103, 20, [3]]]));
    const at = (b: BoardState) => board(b.territories.map((t) => (t.territoryId === 3 ? mine(3, 400) : t)));
    const b0 = board([fogged(1), enemy(2, 35), mine(3, 30), enemy(4, 1), neutral(5, 4), neutral(6, 2), mine(7, 3)]);
    const b1 = board([fogged(1), enemy(2, 40), mine(3, 30), enemy(4, 1), neutral(5, 4), neutral(6, 2), mine(7, 3)]);
    const b2 = board([fogged(1), enemy(2, 85), mine(3, 30), enemy(4, 1), enemy(5, 41), neutral(6, 2), mine(7, 3)]);
    const [t] = trackOpponents(gl, history([at(b0), at(b1), at(b2)]), ME, STD);
    expect(t!.turns.map((x) => [x.observed, x.captureFloor ?? 0, x.fogArmies > 0, x.leadIncome])).toEqual([
      [5, 0, false, 25],
      [44, 42, true, 25],
    ]);
    expect(t!.income).toBe(42);
    expect(t!.incomeRise).toEqual({ read: 44, before: 5, proven: 42 });
    expect(incomeBasis(t!)).toContain('held at the +42 a capture with every source in view proved');
  });
});

describe('2. the over-read tripwire: one step a turn toward a turn read with every army in view (#418)', () => {
  // My +5 bonus {1, 2, 3}; its T4 (between my T3 and its T5) and T5; T6–T9 fogged early (+20 and +50 it
  // could hold). Later T6 and T7 show as neutrals; T8–T9 stay in deep fog, beside none of its land, so it
  // could still earn 55 and the could-earn cap does not cut the carry.
  const g = buildGraph(
    makeMap(range(1, 9), line(9), [
      [101, 5, [1, 2, 3]],
      [102, 20, [6, 7]],
      [103, 50, [8, 9]],
    ]),
  );
  const fog = range(6, 9).map(fogged);
  const lifted = [neutral(6, 2), neutral(7, 2), fogged(8), fogged(9)];
  // One turn read in full at +40 (T4 is beside no fog): a confirmed carry, which never decays (#119).
  const early = (t4: number) => board([mine(1, 1), mine(2, 1), mine(3, 28), enemy(4, t4), enemy(5, 1), ...fog]);
  // Then every territory shows its owner and armies, and it deploys +5 on T4 each turn.
  const late = (t4: number) => board([mine(1, 1), mine(2, 1), mine(3, 28), enemy(4, t4), enemy(5, 1), ...lifted]);
  const quiet: MyOrders = { deploys: [], moves: [], sent: [], cards: [] };
  const withOrders = (boards: BoardState[]): TurnBoard[] => history(boards).map((b) => ({ ...b, orders: quiet }));

  it('reads a turn as accounted only when its land and everything beside it are in view', () => {
    expect(everyArmyInView(g, late(50), late(55), ENEMY, ME, quiet, STD)).toBe(true);
    expect(everyArmyInView(g, early(45), late(50), ENEMY, ME, quiet, STD)).toBe(false);
    // Beside my land, my orders must be known (my attack may have cost it armies the board does not show).
    expect(everyArmyInView(g, late(50), late(55), ENEMY, ME, undefined, STD)).toBe(false);
    // A neutral beside it shrank: a failed attack of its may have cost it armies unseen.
    const shrunk = board([mine(1, 1), mine(2, 1), mine(3, 28), enemy(4, 55), enemy(5, 1), neutral(6, 1), neutral(7, 2), fogged(8), fogged(9)]);
    expect(everyArmyInView(g, late(50), shrunk, ENEMY, ME, quiet, STD)).toBe(false);
  });

  it('the carried +40 steps down one RISE_CAP step a turn toward the +5 read with every army in view', () => {
    const [t] = trackOpponents(g, withOrders([early(5), early(45), late(50), late(55), late(60), late(65)]), ME, STD);
    expect(t!.turns.map((x) => [x.observed, x.accounted ?? false])).toEqual([
      [40, false],
      [5, false],
      [5, true],
      [5, true],
      [5, true],
    ]);
    expect(RISE_CAP).toBe(1.3);
    // 40 → 31 → 24 → 19: one step each accounted turn.
    expect(t!.income).toBe(19);
    expect(t!.incomeMethod).toBe('tripped');
    expect(t!.incomeTrip).toEqual({ from: 24, proven: 5, turn: 12 });
    expect(incomeBasis(t!)).toContain('every army it could deploy was in view on turn 12, which read +5');
  });

  it('it keeps stepping until it reaches the reading, and stops there', () => {
    const boards = [early(5), early(45), ...range(0, 12).map((i) => late(50 + 5 * i))];
    const [t] = trackOpponents(g, withOrders(boards), ME, STD);
    expect(t!.income).toBe(5);
  });

  it('nothing accounted (my orders unknown beside it): the carry stays, as before', () => {
    const [t] = trackOpponents(g, history([early(5), early(45), late(50), late(55), late(60), late(65)]), ME, STD);
    expect(t!.turns.some((x) => x.accounted)).toBe(false);
    expect(t!.income).toBe(40);
  });
});
