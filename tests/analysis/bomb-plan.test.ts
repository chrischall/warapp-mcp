// The Bomb plan beside the plain plan (owner request 2026-11-24, part B): a Bomb that saves a border the plain plan
// concedes, scored by the plain plan's own measure, the plain plan unchanged. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import { bombCandidates, bombedBoard, bombLeaves, planBomb } from '../../src/analysis/bomb-plan.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn } from '../../src/analysis/planner.js';
import type { PlanInput } from '../../src/analysis/plan/shared.js';
import type { TerritoryState } from '../../src/board.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const map = (edges: [number, number][], bonuses: [number, number, number[]][]): GameMap => ({
  id: 1,
  name: 'S',
  territories: Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    name: `T${i + 1}`,
    connectedTo: edges.filter(([a, b]) => a === i + 1 || b === i + 1).map(([a, b]) => (a === i + 1 ? b : a)),
  })),
  bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
  distributionModes: [],
});
const me = (id: number, a: number): TerritoryState => mine(id, a, ME);
const foe = (id: number, a: number): TerritoryState => mine(id, a, FOE);

// Bonus 100 (+6) is 1, 2, 3: mine. The foe's 16 on 4 press 3; my income cannot hold 3 against them.
const MAP = map([[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]], [[100, 6, [1, 2, 3]], [200, 3, [4, 5]]]);
const input: PlanInput = { graph: buildGraph(MAP), board: board([me(1, 2), me(2, 2), me(3, 4), foe(4, 16), foe(5, 2), neutral(6, 9)]), me: ME, income: 5 };

describe('the Bomb plan', () => {
  const plain = planTurn(input);

  it('leaves half the armies, rounded down (the client bundle\'s rule)', () => {
    expect([bombLeaves(30), bombLeaves(13), bombLeaves(1), bombLeaves(0)]).toEqual([15, 6, 0, 0]);
    expect(bombedBoard(input.board, 4).territories.find((t) => t.territoryId === 4)?.armies).toBe(8);
  });

  it('offers only an opponent\'s territory beside mine, a held bonus\'s member first', () => {
    // 4 is beside my 3 and a member of the foe's whole bonus 200; 5 is not beside me; 6 is neutral.
    expect(bombCandidates(input)).toEqual([{ target: 4, kind: 'break-bonus', armies: 16, left: 8 }]);
  });

  it('never targets a player at peace with me', () => {
    const peace: PlanInput = { ...input, relations: [{ player: FOE, coveredMine: [], coveredTheirs: [], state: 'active', trust: 'clear' }] };
    expect(bombCandidates(peace)).toEqual([]);
  });

  it('saves the bonus border the plain plan concedes, the plain plan unchanged', () => {
    expect(plain.conceded).toContain(3);
    const before = JSON.stringify(plain);
    const r = planBomb({ input, plain, cards: 1 });
    expect(JSON.stringify(planTurn(input))).toBe(before);
    expect(r.best?.bomb.target).toBe(4);
    expect(r.best!.plan.conceded).not.toContain(3);
    expect(r.best!.score.safeIncome).toBeGreaterThan(r.best!.plainScore.safeIncome);
  });

  it('plays nothing without a card to spare', () => {
    expect(planBomb({ input, plain, cards: 0 })).toEqual({ considered: 0 });
  });
});

describe('bombCandidates: ordering', () => {
  it('puts a held bonus\'s member first, then the larger stack', () => {
    // My 3 borders the foe's 4 (in its whole bonus 200) and its 6 (no bonus, a bigger stack).
    const m = map([[3, 4], [3, 6], [4, 5]], [[200, 3, [4, 5]]]);
    const input: PlanInput = { graph: buildGraph(m), board: board([me(3, 5), foe(4, 4), foe(5, 2), foe(6, 20)]), me: ME, income: 5 };
    expect(bombCandidates(input).map((c) => [c.target, c.kind])).toEqual([
      [4, 'break-bonus'],
      [6, 'cut-stack'],
    ]);
  });
});
