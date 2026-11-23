// #505: on turns 1–4 (or while #319 fires), orders that drop a capture the default plan makes toward the
// nearest bonus are told when that bonus now finishes — rule 4f's turns-to-finish on the board after each
// set of orders. Advice only. Synthetic maps and boards only.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { BONUS_DELAY_LAST_TURN, bonusDelay, bonusDelayWarning } from '../../src/analysis/bonus-delay.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planCloseness, planTurn, type PlanInput } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';

const ME = 1001;
const FOE = 1002;

// A line 1-2-3-4-5-6-7-8: bonus West = {1,2,3} worth 3, bonus East = {6,7,8} worth 3.
const MAP: GameMap = {
  id: 77,
  name: 'line',
  territories: [1, 2, 3, 4, 5, 6, 7, 8].map((id) => ({ id, name: `t${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 8) })),
  bonuses: [
    { id: 100, name: 'West', value: 3, territoryIds: [1, 2, 3], bonusIds: [] },
    { id: 200, name: 'East', value: 3, territoryIds: [6, 7, 8], bonusIds: [] },
  ],
  distributionModes: [],
};
const G = buildGraph(MAP);
const t = (territoryId: number, owner: number | 'neutral', armies: number): TerritoryState => ({
  territoryId,
  owner: owner === 'neutral' ? { kind: 'neutral' } : { kind: 'player', playerId: owner },
  armies,
});
const BOARD: BoardState = {
  source: 'gamefeed',
  verified: false,
  territories: [t(1, ME, 5), t(2, 'neutral', 2), t(3, 'neutral', 2), t(4, 'neutral', 2), t(5, 'neutral', 2), t(6, 'neutral', 2), t(7, 'neutral', 2), t(8, FOE, 5)],
};
const input = (turn: number): PlanInput => ({
  graph: G,
  board: BOARD,
  me: ME,
  income: 5,
  settings: { baseIncome: 5, luckModifier: 0, roundingMode: 'StraightRound', offensiveKillRate: 60, defensiveKillRate: 70 },
  turn,
  game: { players: [{ id: ME, state: 'Playing' }, { id: FOE, state: 'Playing' }], turn, fog: 'NoFog' },
});

describe('planCloseness (#505)', () => {
  it("keeps rule 4f's nearest bonus and each bonus's turns to finish beside the plan, without changing the plan", () => {
    const plan = planTurn(input(1));
    const c = planCloseness(plan)!;
    expect(c.nearest).toBe(100);
    expect(c.spread).toBe(false);
    expect(c.turns.get(100)).toBeGreaterThanOrEqual(1);
    expect(c.remaining.get(100)).toEqual([2, 3]);
    expect(JSON.stringify(plan)).not.toContain('closeness');
  });
});

describe('bonusDelay (#505)', () => {
  it('says when orders that drop the plan\'s capture toward the nearest bonus finish it later', () => {
    const i = input(1);
    const plan = planTurn(i);
    // The default plan attacks into West this turn.
    expect(plan.moves.some((m) => m.to === 2)).toBe(true);
    const d = bonusDelay({ input: i, plan, given: { deploys: [{ territoryId: 1, armies: 5 }], moves: [] } })!;
    expect(d).toMatchObject({ bonusId: 100, bonus: 'West', dropped: [2] });
    expect(d.givenTurn).toBeGreaterThan(d.plannedTurn);
    const w = bonusDelayWarning(d)!;
    expect(w).toContain(`These orders finish bonus West on turn ${d.givenTurn} instead of turn ${d.plannedTurn}`);
    expect(w).toContain('territory 2');
    expect(w).not.toMatch(/refus|blocked/i);
  });

  it('says nothing when the orders keep the plan\'s captures, after turn 4 without #319, or with no delay', () => {
    const i = input(1);
    const plan = planTurn(i);
    const same = { deploys: plan.deploys.map((x) => ({ territoryId: x.territoryId, armies: x.armies })), moves: plan.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies })) };
    expect(bonusDelay({ input: i, plan, given: same })).toBeUndefined();
    const late = input(BONUS_DELAY_LAST_TURN + 1);
    expect(bonusDelay({ input: late, plan: planTurn(late), given: { deploys: [{ territoryId: 1, armies: 5 }], moves: [] } })).toBeUndefined();
    expect(bonusDelayWarning(undefined)).toBeUndefined();
    expect(BONUS_DELAY_LAST_TURN).toBe(4);
  });
});
