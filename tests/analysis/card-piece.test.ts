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

describe('a capture worth a card piece next to an opponent (#127 with #164)', () => {
  // My 1 2 3 hold bonus 101 (+2) against the opponent's 4 (12, with 5 behind it); 6 7 8 are a costly
  // neutral bonus. With no capture planned under `defend`, the 12 on 6 is taken for its card pieces
  // (20). The warapp_plan_turn #127 test needs 60 on 1 since #164, because the opponent may hold the
  // same 20-army Reinforcement card; without the card clock, 40 is still enough, as it was before.
  const T = (id: number, connectedTo: number[]) => ({ id, name: `T${id}`, connectedTo });
  const g = buildGraph({
    id: 2,
    name: 'Pieces and a foe',
    territories: [T(1, [2, 3, 4, 6]), T(2, [1, 3, 4]), T(3, [1, 2, 4]), T(4, [1, 2, 3, 5]), T(5, [4]), T(6, [1, 7]), T(7, [6, 8]), T(8, [7])],
    bonuses: [
      { id: 101, name: 'B101', value: 2, territoryIds: [1, 2, 3], bonusIds: [] },
      { id: 102, name: 'B102', value: 1, territoryIds: [6, 7, 8], bonusIds: [] },
    ],
    distributionModes: [],
  });
  const FOE = 20;
  const foe = (territoryId: number, armies: number) => ({ territoryId, owner: { kind: 'player' as const, playerId: FOE }, armies });
  const b = board([mine(1, 40), mine(2, 8), mine(3, 8), foe(4, 12), foe(5, 5), neutral(6, 12), neutral(7, 12), neutral(8, 12)]);
  const at = (reinforcement?: { firstTurn: number; armies: number; turnsPerCard: number }) =>
    planTurn({ graph: g, board: b, me: ME, income: 7, settings: STD, options: { goal: 'defend', cardPieceValue: 20 }, game: { turn: 6, cards: true, ...(reinforcement ? { reinforcement } : {}) } });

  it('with no card clock, 40 on the border still takes the capture', () => {
    const p = at();
    expect(p.expected.captures).toEqual([6]);
    expect(p.rationale.join('\n')).toMatch(/Attack T6 \(#6\) from T1 \(#1\) with \d+: a capture earns this turn's card pieces/);
  });
  it("with the opponent's 20-army card on the clock, 40 must hold instead", () => {
    expect(at({ firstTurn: 2, armies: 20, turnsPerCard: 1 }).expected.captures).toEqual([]);
  });
});
