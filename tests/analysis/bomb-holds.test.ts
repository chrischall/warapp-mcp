// #163: when an opponent may hold a Bomb (the card clock says one can be in a hand by now), every
// hold is sized as if a bomb halved the stack first, and the leftover goes to two stacks. Synthetic map.
import { describe, expect, it } from 'vitest';
import { bombExposure } from '../../src/analysis/card-threats.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanOptions, type PlannerSettings } from '../../src/analysis/planner.js';
import type { BoardState } from '../../src/board.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

/** 1 ─ 2 ─ 3 ─ 4, and 2 ─ 5 ─ 6; 7 joins 4 and 6. Bonus A (+5) is 1, 2, 3, 5. */
const MAP: GameMap = {
  id: 1,
  name: 'Bomb',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2] },
    { id: 2, name: 'T2', connectedTo: [1, 3, 5] },
    { id: 3, name: 'T3', connectedTo: [2, 4] },
    { id: 4, name: 'T4', connectedTo: [3, 7] },
    { id: 5, name: 'T5', connectedTo: [2, 6] },
    { id: 6, name: 'T6', connectedTo: [5, 7] },
    { id: 7, name: 'T7', connectedTo: [4, 6] },
  ],
  bonuses: [{ id: 100, name: 'A', value: 5, territoryIds: [1, 2, 3, 5], bonusIds: [] }],
  distributionModes: [],
};
const G = buildGraph(MAP);
const plan = (b: BoardState, income: number, options: PlanOptions = {}) =>
  planTurn({ graph: G, board: b, me: ME, income, settings: STD, options: { enemyDeploy: 3, ...options }, game: { turn: 12 } });
const deployedOn = (p: ReturnType<typeof plan>, t: number) => p.deploys.filter((d) => d.territoryId === t).reduce((n, d) => n + d.armies, 0);

describe('Bomb-aware hold sizing (#163)', () => {
  // T3 faces 4 (4 armies: 3 movable) plus a deploy of 3: a threat of 6. 5 hold it (6 take 4, 8 take 5).
  const b = board([mine(1, 1), mine(2, 1), mine(3, 2), mine(4, 4, FOE), mine(5, 3), mine(6, 1, FOE)]);

  it('sizes a hold as if a bomb halved the stack: twice the armies', () => {
    const plain = plan(b, 12);
    expect(2 + deployedOn(plain, 3)).toBeGreaterThanOrEqual(5);
    expect(2 + deployedOn(plain, 3)).toBeLessThan(10);
    const bombed = plan(b, 12, { opponentsMayHoldBomb: true });
    const at3 = 2 + deployedOn(bombed, 3);
    expect(at3).toBeGreaterThanOrEqual(10);
    // Halved (the smaller half), it still holds against the threat of 6.
    expect(armiesToTake(Math.floor(at3 / 2), { offensiveKillRate: 60, defensiveKillRate: 70 })).toBeGreaterThan(6);
    expect(bombed.rationale.join('\n')).toMatch(/may hold a Bomb/);
  });

  it('leaves no held border that a bomb would make fall', () => {
    const p = plan(b, 12, { opponentsMayHoldBomb: true });
    const exposed = bombExposure({ graph: G, board: b, me: ME, deploys: p.deploys, moves: p.moves, enemyDeploy: p.enemyDeploy, settings: STD })
      .filter((e) => !p.conceded.includes(e.territory));
    expect(exposed).toEqual([]);
  });

  it('names the bombed take in the threat warning', () => {
    const p = plan(b, 0, { opponentsMayHoldBomb: true });
    expect(p.warnings.join('\n')).toMatch(/T3 \(#3\) \(2 armies\) could be taken next turn: .* once a Bomb halves it/);
  });

  it('a commander is unharmed by the bomb: only the armies are doubled', () => {
    const withCmd = board([
      mine(1, 1),
      mine(2, 1),
      { ...mine(3, 0), specialUnits: [{ kind: 'commander', id: 'c', playerId: ME }] },
      mine(4, 6, FOE),
      mine(5, 3),
      mine(6, 1, FOE),
    ]);
    // Threat 5 + 3 = 8: 6 hold (8 take 5, 10 take 6), the commander being 7 of them already.
    const p = plan(withCmd, 0, { opponentsMayHoldBomb: true });
    expect(p.warnings.join('\n')).not.toMatch(/T3 \(#3\) \(0 armies and my commander\) could be taken/);
  });

  it('splits the leftover over two stacks facing the opponent', () => {
    // Both borders hold comfortably even bombed; nothing is worth attacking under `defend`.
    const quiet = board([mine(1, 1), mine(2, 1), mine(3, 70), mine(4, 40, FOE), mine(5, 70), mine(6, 40, FOE), fogged(7)]);
    const one = plan(quiet, 10, { enemyDeploy: 5, goal: 'defend' });
    expect(one.rationale.join('\n')).not.toMatch(/two stacks/);
    const two = plan(quiet, 10, { enemyDeploy: 5, goal: 'defend', opponentsMayHoldBomb: true });
    expect(two.deploys).toEqual([
      { territoryId: 3, armies: 5 },
      { territoryId: 5, armies: 5 },
    ]);
    expect(two.rationale.join('\n')).toMatch(/Deploy 5 of the leftover to T5 \(#5\): an opponent may hold a Bomb.*two stacks rather than one/);
  });

  it('changes nothing without the option', () => {
    const p = plan(b, 12);
    expect(p.rationale.join('\n')).not.toMatch(/Bomb/);
  });
});
