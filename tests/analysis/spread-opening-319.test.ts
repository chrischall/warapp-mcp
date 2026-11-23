// #319: in the opening (turns 2–6), many territories and no bonus means the captures are spread: the plan
// warns, naming the nearest bonus to complete with rule 4f's armies and turns. #416 (owner 2026-11-22): it also
// binds the deploys to that bonus until its reachable steps are funded (spread-bind-416.test.ts).
// Synthetic map: every id and name is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, SPREAD_TERRITORIES, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

// Six bonuses of three in a row, 1-2-3, 4-5-6, …, 16-17-18, linked 3-4, 6-7, …: I hold the first member of
// each and one more of the first three (nine in all, or ten with 20), none complete. The opponent sits on 99.
const IDS = [...Array.from({ length: 18 }, (_, i) => i + 1), 20, 99];
const EDGES: [number, number][] = [];
for (let b = 0; b < 6; b++) {
  const a = 3 * b + 1;
  EDGES.push([a, a + 1], [a + 1, a + 2]);
  if (b < 5) EDGES.push([a + 2, a + 3]);
}
EDGES.push([1, 20], [18, 99]);
const MAP: GameMap = {
  id: 1,
  name: 'Spread',
  territories: IDS.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: EDGES.filter(([x, y]) => x === id || y === id).map(([x, y]) => (x === id ? y : x)),
  })),
  bonuses: Array.from({ length: 6 }, (_, b) => ({ id: 500 + b, name: `B${b}`, value: 3, territoryIds: [3 * b + 1, 3 * b + 2, 3 * b + 3], bonusIds: [] })),
  distributionModes: [],
};
const g = buildGraph(MAP);
const heldIds = [1, 2, 4, 5, 7, 8, 10, 13, 16];

function field(extra: number[] = []): BoardState {
  const held = new Set([...heldIds, ...extra]);
  const ts: TerritoryState[] = IDS.map((id) =>
    id === 99 ? { territoryId: 99, owner: { kind: 'player', playerId: P2 }, armies: 5 } : held.has(id) ? mine(id, 2) : neutral(id, 2),
  );
  return board(ts);
}
const plan = (b: BoardState, turn: number, income = 5): TurnPlan =>
  planTurn({ graph: g, board: b, me: ME, income, settings: { ...STD, baseIncome: 5 }, game: { players: [{ id: ME }, { id: P2 }], turn } });
const spreadWarning = (p: TurnPlan) => p.warnings.find((w) => w.includes('#319'));

describe('spread captures in the opening (#319)', () => {
  it('warns on turns 2–6 with many territories and no bonus, naming the nearest bonus with its armies and turns', () => {
    expect(SPREAD_TERRITORIES).toBe(10);
    const p = plan(field([20]), 4);
    const w = spreadWarning(p);
    expect(w).toBeDefined();
    expect(w).toMatch(/^10 territories, no bonus: the captures are spread \(income 5, base 5\)\. /);
    // B0, B1 and B2 each miss one member at 3 armies: one turn; the first of them in rule 4f's order.
    // #416: the held member beside it stands on 2 (1 movable over the guard, 2 when beside two of mine).
    expect(w).toMatch(/Nearest bonus to complete: B\d \(#50\d\), 3 armies to finish \(\d standing beside it\), 1 turn at income 5 \(rule 4f\)\./);
  });

  // #416 (owner 2026-11-22): #319 binds the deploys to the nearest bonus until its reachable steps are funded
  // (tests/analysis/spread-bind-416.test.ts). Here B0's one step is funded first, so the rest flows as without #319.
  it('funds the nearest bonus first, then changes no order once its steps are taken (#416)', () => {
    const p = plan(field([20]), 4);
    expect(p.moves.find((m) => m.kind === 'attack' && m.to === 3)?.reason).toBe('completes bonus B0 (#500) (+3)');
    expect(p.rationale.some((r) => r.includes('#319 binds'))).toBe(false);
    const { warnings: _w, ...rest } = p;
    const q = planTurn({
      graph: g,
      board: field([20]),
      me: ME,
      income: 5,
      settings: { ...STD, baseIncome: 5 },
      game: { players: [{ id: ME }, { id: P2 }], turn: 7 },
    });
    expect(spreadWarning(q)).toBeUndefined();
    expect(rest.deploys).toEqual(q.deploys);
    expect(rest.moves).toEqual(q.moves);
  });

  it('says nothing on turn 1 or after turn 6, below the territory count, or with income well above base', () => {
    expect(spreadWarning(plan(field([20]), 1))).toBeUndefined();
    expect(spreadWarning(plan(field([20]), 7))).toBeUndefined();
    expect(spreadWarning(plan(field(), 4))).toBeUndefined();
    expect(spreadWarning(plan(field([20]), 4, 12))).toBeUndefined();
  });

  it('says nothing once a bonus is held', () => {
    expect(spreadWarning(plan(field([20, 3]), 4))).toBeUndefined();
  });
});
