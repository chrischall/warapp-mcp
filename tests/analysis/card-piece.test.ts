// #127: when cards are in play and the plan has no capture, the cheapest capture that loses no more
// armies than a turn's card pieces are worth is taken (any capture earns the turn's pieces). Synthetic map.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanOptions, type PlannerSettings } from '../../src/analysis/planner.js';
import type { BoardState } from '../../src/board.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

/** 1 ─ 2 ─ 3, 2 ─ 4. No bonus: no capture adds income. */
const MAP: GameMap = {
  id: 1,
  name: 'Pieces',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2] },
    { id: 2, name: 'T2', connectedTo: [1, 3, 4] },
    { id: 3, name: 'T3', connectedTo: [2] },
    { id: 4, name: 'T4', connectedTo: [2] },
  ],
  bonuses: [],
  distributionModes: [],
};
const G = buildGraph(MAP);
const plan = (b: BoardState, options: PlanOptions = {}) =>
  planTurn({ graph: G, board: b, me: ME, income: 5, settings: STD, options, game: { turn: 6, cards: true } });

describe('a capture worth a card piece (#127)', () => {
  // 3 holds 4 neutrals (a capture loses ~3), 4 holds 6 (loses ~4): both over the plain-expansion limit of 2.
  const b = board([mine(1, 3), mine(2, 10), neutral(3, 4), neutral(4, 6)]);

  it('takes nothing without a piece value', () => {
    expect(plan(b).expected.captures).toEqual([]);
  });

  it('takes the cheapest capture whose losses the pieces cover', () => {
    const p = plan(b, { cardPieceValue: 3 });
    expect(p.expected.captures).toEqual([3]);
    const m = p.moves.find((x) => x.to === 3)!;
    expect(m.reason).toMatch(/card pieces/);
    expect(p.rationale.join('\n')).toMatch(/Attack T3 \(#3\) from T2 \(#2\) with \d+.*card pieces/);
  });

  it('takes none when every capture loses more than the pieces are worth', () => {
    expect(plan(b, { cardPieceValue: 2.5 }).expected.captures).toEqual([]);
  });

  it('adds nothing when the plan already captures', () => {
    const cheap = board([mine(1, 3), mine(2, 10), neutral(3, 1), neutral(4, 4)]);
    const without = plan(cheap);
    expect(without.expected.captures.length).toBeGreaterThan(0);
    expect(plan(cheap, { cardPieceValue: 5 }).expected.captures).toEqual(without.expected.captures);
  });
});
