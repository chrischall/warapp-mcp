// The Airlift plan beside the plain plan (owner request 2026-11-24, part 3): an Airlift that saves a bonus the
// plain plan concedes, scored by the plain plan's own measure, the plain plan unchanged. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import {
  airliftCandidates,
  airliftedBoard,
  airliftOrdersValid,
  compareScores,
  planAirlift,
  scoreOf,
} from '../../src/analysis/airlift-plan.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn } from '../../src/analysis/planner.js';
import type { PlanInput, TurnPlan } from '../../src/analysis/plan/shared.js';
import type { TerritoryState } from '../../src/board.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;

function makeMap(n: number, edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
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
const foe = (id: number, armies: number): TerritoryState => mine(id, armies, FOE);
const me = (id: number, armies: number): TerritoryState => mine(id, armies, ME);

// Bonus 100 (+6) is 1, 2, 3. The foe's 40 on 4 press 3. My 60 on 6 stand deep (beside only 1 and 7, both mine);
// 8 is a wasteland. 6 cannot walk to 3 this turn (two steps), and my income cannot hold 3.
const MAP = makeMap(8, [[1, 2], [2, 3], [3, 4], [4, 5], [1, 6], [6, 7], [7, 8]], [[100, 6, [1, 2, 3]]]);
const input: PlanInput = {
  graph: buildGraph(MAP),
  board: board([me(1, 1), me(2, 1), me(3, 2), foe(4, 40), foe(5, 2), me(6, 60), me(7, 1), neutral(8, 50)]),
  me: ME,
  income: 5,
};

describe('the Airlift plan', () => {
  const plain = planTurn(input);

  it('the plain plan concedes the bonus border it cannot hold', () => {
    expect(plain.conceded).toContain(3);
  });

  it('offers an Airlift from the deep stack onto the conceded bonus border, keeping one army behind', () => {
    const c = airliftCandidates(input, plain);
    expect(c[0]).toEqual({ from: 6, to: 3, armies: 59, kind: 'reinforce' });
  });

  it('saves the bonus: a better plan by the plain plan\'s own measure, the plain plan unchanged', () => {
    const before = JSON.stringify(plain);
    const r = planAirlift({ input, plain, cards: 1 });
    expect(JSON.stringify(planTurn(input))).toBe(before);
    expect(r.best).toBeDefined();
    const best = r.best!;
    expect(best.airlifts).toEqual([{ from: 6, to: 3, armies: 59, kind: 'reinforce' }]);
    expect(best.plan.conceded).not.toContain(3);
    expect(best.score.safeIncome).toBeGreaterThan(best.plainScore.safeIncome);
    expect(compareScores(best.score, scoreOf(plain))).toBeLessThan(0);
    // Its orders are ones the submit accepts: nothing moves out of 3 beyond what stood there and was deployed.
    expect(airliftOrdersValid(input.board, best.plan, best.airlifts)).toBe(true);
  });

  it('plays nothing without a card to spare (all held in reserve)', () => {
    expect(planAirlift({ input, plain, cards: 0 })).toEqual({ considered: 0, invalid: 0 });
  });

  it('returns nothing when no Airlift beats the plain plan', () => {
    // Nothing conceded, nothing to save: no candidate, no plan.
    const calm: PlanInput = { ...input, board: board([me(1, 1), me(2, 1), me(3, 2), neutral(4, 2), neutral(5, 2), me(6, 60), me(7, 1), neutral(8, 50)]) };
    const r = planAirlift({ input: calm, plain: planTurn(calm), cards: 2 });
    expect(r.best).toBeUndefined();
  });

  it('moves the armies on the board the planner plans on', () => {
    const b = airliftedBoard(input.board, [{ from: 6, to: 3, armies: 59, kind: 'reinforce' }]);
    expect(b.territories.find((t) => t.territoryId === 6)?.armies).toBe(1);
    expect(b.territories.find((t) => t.territoryId === 3)?.armies).toBe(61);
    expect(input.board.territories.find((t) => t.territoryId === 6)?.armies).toBe(60);
  });

  it('refuses a plan that moves landed armies on', () => {
    const plan = { deploys: [{ territoryId: 3, armies: 2 }], moves: [{ from: 3, to: 4, armies: 10, kind: 'attack', reason: '' }] } as unknown as TurnPlan;
    const lift = [{ from: 6, to: 3, armies: 59, kind: 'reinforce' as const }];
    // 3 holds 2 + 2 deployed: 3 may leave, not 10.
    expect(airliftOrdersValid(input.board, plan, lift)).toBe(false);
    expect(airliftOrdersValid(input.board, { ...plan, moves: [{ ...plan.moves[0]!, armies: 3 }] }, lift)).toBe(true);
  });

  it('evacuates a conceded border\'s spare armies when it cannot be held', () => {
    // 3 holds 12 now (still too few against 45): its 11 spare go elsewhere.
    // A second front: the foe's 5 also borders my 7, so a kept border stands to receive them.
    const two = makeMap(8, [[1, 2], [2, 3], [3, 4], [4, 5], [1, 6], [6, 7], [7, 8], [5, 7]], [[100, 6, [1, 2, 3]]]);
    const lost: PlanInput = { ...input, graph: buildGraph(two), board: board([me(1, 1), me(2, 1), me(3, 12), foe(4, 40), foe(5, 2), me(6, 1), me(7, 10), neutral(8, 50)]) };
    const p = planTurn(lost);
    expect(p.conceded).toContain(3);
    expect(airliftCandidates(lost, p).some((c) => c.kind === 'evacuate' && c.from === 3 && c.armies === 11)).toBe(true);
  });
});
