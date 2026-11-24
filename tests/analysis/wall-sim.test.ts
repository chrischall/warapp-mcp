// Emergency Blockade (phase 37) and Blockade (phase 60) in the turn resolver, the stress test and the wall plan
// (owner request 2026-11-24, part B). The rule is the client bundle's: the territory turns neutral at its armies × the
// card's multiplier, rounded with a half down; a Blockade only while its player still holds it. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { planWall, wallCandidates, walledBoard } from '../../src/analysis/blockade-plan.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn } from '../../src/analysis/planner.js';
import type { PlanInput } from '../../src/analysis/plan/shared.js';
import { stressPlan } from '../../src/analysis/stress.js';
import { roundHalfDown, simulateTurn, type SimInput } from '../../src/analysis/turn-sim.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const map = (n: number, edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap => ({
  id: 1,
  name: 'S',
  territories: Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `T${i + 1}`,
    connectedTo: edges.filter(([a, b]) => a === i + 1 || b === i + 1).map(([a, b]) => (a === i + 1 ? b : a)),
  })),
  bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
  distributionModes: [],
});
const me = (id: number, a: number): TerritoryState => mine(id, a, ME);
const foe = (id: number, a: number): TerritoryState => mine(id, a, FOE);
// 1 ─ 2 ─ 3 ─ 4 in a line; bonus 100 (+6) is 1 and 2.
const LINE = map(4, [[1, 2], [2, 3], [3, 4]], [[100, 6, [1, 2]]]);
const graph = buildGraph(LINE);
const sim = (entries: TerritoryState[], over: Partial<SimInput>) =>
  simulateTurn({ graph, board: board(entries), deploys: [], orders: [], moveOrder: [ME, FOE], settings: STD, ...over });

describe('simulateTurn: walls', () => {
  it('rounds a half down', () => {
    expect([roundHalfDown(4.5), roundHalfDown(4.51), roundHalfDown(4.4), roundHalfDown(9)]).toEqual([4, 5, 4, 9]);
  });

  it('an Emergency Blockade walls a territory before the moves, its deploy multiplied too', () => {
    const attack = { player: FOE, orders: [{ from: 4, to: 3, armies: 9 }] };
    const r = sim([me(2, 1), me(3, 3), foe(4, 10)], {
      deploys: [{ player: ME, territoryId: 3, armies: 2 }],
      abandons: [{ player: ME, target: 3, multiplier: 3 }],
      orders: [attack],
    });
    // (3 + 2) × 3 = 15 neutral: the foe's 9 kill 5 and fail.
    expect(r.territories.get(3)).toMatchObject({ owner: 'neutral', armies: 10 });
  });

  it('a Blockade walls only after the moves, and only a territory still mine', () => {
    const kept = sim([me(2, 1), me(3, 5), foe(4, 2)], { blockades: [{ player: ME, target: 3, multiplier: 2.5 }] });
    expect(kept.territories.get(3)).toMatchObject({ owner: 'neutral', armies: 12 }); // 12.5 → 12
    const taken = sim([me(2, 1), me(3, 1), foe(4, 10)], {
      blockades: [{ player: ME, target: 3, multiplier: 3 }],
      orders: [{ player: FOE, orders: [{ from: 4, to: 3, armies: 9 }] }],
    });
    expect(taken.territories.get(3)?.owner).toBe(FOE);
  });
});

describe('stressPlan: a wall is given up on purpose', () => {
  it('never lists the walled territory as lost, and shields the bonus behind it', () => {
    const entries = [me(1, 1), me(2, 2), me(3, 4), foe(4, 12)];
    const run = (abandons?: { target: number; multiplier: number }[]) =>
      stressPlan({ graph, board: board(entries), me: ME, deploys: [], moves: [], opponents: [{ id: FOE, deploy: 3 }], settings: STD, ...(abandons ? { abandons } : {}) });
    const open = run();
    expect(open.atRisk.territories.map((t) => t.id)).toContain(3);
    const walled = run([{ target: 3, multiplier: 5 }]);
    expect(walled.atRisk.territories.map((t) => t.id)).not.toContain(3);
    expect(walled.atRisk.bonuses).toEqual([]);
  });
});

describe('the Emergency Blockade plan', () => {
  // My conceded 3 (4 armies) faces the foe's 14 on 4; 3 and 4 form the foe's bonus 200 (+5) but for 3: its fall
  // completes it. Walled (× 5 = 20), the foe's 13 movable + 3 deploy cannot break it this turn.
  const WALL_MAP = map(4, [[1, 2], [2, 3], [3, 4]], [[100, 6, [1, 2]], [200, 5, [3, 4]]]);
  const input: PlanInput = { graph: buildGraph(WALL_MAP), board: board([me(1, 2), me(2, 2), me(3, 4), foe(4, 14)]), me: ME, income: 3 };
  const plain = planTurn(input);

  it('offers a conceded border of mine as a wall, never my commander\'s', () => {
    if (!plain.conceded.includes(3)) throw new Error(`3 is not conceded: ${plain.conceded}`);
    expect(wallCandidates(input, plain, 5)).toContainEqual({ target: 3, armies: 4, wall: 20, denied: 5, deniedFrom: FOE });
    const cmd = { ...input, board: board([me(1, 2), me(2, 2), { ...me(3, 4), specialUnits: [{ kind: 'commander', playerId: ME, id: 'c' }] } as TerritoryState, foe(4, 14)]) };
    expect(wallCandidates(cmd, plain, 5).some((c) => c.target === 3)).toBe(false);
  });

  it('walls the conceded border whose fall would complete the foe\'s bonus (DRAFT: the denial term), the plain plan unchanged', () => {
    const before = JSON.stringify(plain);
    const r = planWall({ input, plain, cards: 1, multiplier: 5 });
    expect(JSON.stringify(planTurn(input))).toBe(before);
    expect(r.best?.wall.target).toBe(3);
    expect(r.best!.score.twoTurn).toBeGreaterThan(r.best!.plainScore.twoTurn);
    expect(walledBoard(input.board, 3, 20).territories.find((t) => t.territoryId === 3)).toMatchObject({ owner: { kind: 'neutral' }, armies: 20 });
  });

  it('plays nothing without a card or a multiplier', () => {
    expect(planWall({ input, plain, cards: 0, multiplier: 5 })).toEqual({ considered: 0 });
    expect(planWall({ input, plain, cards: 1, multiplier: 0 })).toEqual({ considered: 0 });
  });
});
