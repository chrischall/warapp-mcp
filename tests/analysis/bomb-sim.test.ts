// Bombs in the turn resolver and the stress test (owner request 2026-11-24, part B): phase 30, after every deploy and
// before the Airlifts and moves; the target keeps half its armies rounded down (the client bundle's
// GameOrderPlayCardBombResult: round(armies / 2), a half rounded down). Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { stressPlan } from '../../src/analysis/stress.js';
import { simulateTurn, type SimInput } from '../../src/analysis/turn-sim.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const line = (n: number): GameMap => ({
  id: 1,
  name: 'Line',
  territories: Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `T${i + 1}`, connectedTo: [i, i + 2].filter((x) => x >= 1 && x <= n) })),
  bonuses: [{ id: 100, name: 'B', value: 4, territoryIds: [1, 2], bonusIds: [] }],
  distributionModes: [],
});
const graph = buildGraph(line(4));
const me = (id: number, a: number): TerritoryState => mine(id, a, ME);
const foe = (id: number, a: number): TerritoryState => mine(id, a, FOE);
const sim = (entries: TerritoryState[], over: Partial<SimInput>) =>
  simulateTurn({ graph, board: board(entries), deploys: [], orders: [], moveOrder: [ME, FOE], settings: STD, ...over });

describe('simulateTurn: Bombs (phase 30)', () => {
  it('halves the target after every deploy, rounded down', () => {
    const r = sim([me(2, 5), foe(3, 9)], { deploys: [{ player: FOE, territoryId: 3, armies: 4 }], bombs: [{ player: ME, target: 3 }] });
    expect(r.territories.get(3)?.armies).toBe(6); // (9 + 4) / 2 = 6.5 → 6
  });

  it('runs before every attack, whoever moves first', () => {
    // 10 attack the foe's 12: they fail unbombed; bombed to 6, 10 × 0.6 = 6 kills take it.
    for (const moveOrder of [[ME, FOE], [FOE, ME]]) {
      const orders = [{ player: ME, orders: [{ from: 2, to: 3, armies: 10 }] }];
      expect(sim([me(2, 11), foe(3, 12)], { orders, moveOrder }).territories.get(3)?.owner).toBe(FOE);
      expect(sim([me(2, 11), foe(3, 12)], { orders, moveOrder, bombs: [{ player: ME, target: 3 }] }).territories.get(3)?.owner).toBe(ME);
    }
  });

  it('does nothing to the bomber\'s own territory', () => {
    expect(sim([me(2, 9)], { bombs: [{ player: ME, target: 2 }] }).territories.get(2)?.armies).toBe(9);
  });
});

describe('stressPlan: Bombs carried out at their phase', () => {
  it('a border that falls to the stack beside it holds once that stack is bombed', () => {
    const entries = [me(1, 2), me(2, 8), foe(3, 14), foe(4, 1)];
    const run = (bombs?: number[]) =>
      stressPlan({ graph, board: board(entries), me: ME, deploys: [], moves: [], opponents: [{ id: FOE, deploy: 2 }], settings: STD, ...(bombs ? { bombs } : {}) });
    expect(run().atRisk.territories.map((t) => t.id)).toContain(2);
    expect(run([3]).atRisk.territories.map((t) => t.id)).not.toContain(2);
  });
});
