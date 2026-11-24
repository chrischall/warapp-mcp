// Airlifts in the turn resolver and the stress test (owner request 2026-11-24, parts 2 and 4): phase 43, after
// every deploy and before every move; the source loses the armies, the destination gains them, and what lands
// cannot move again that turn. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { stressPlan, type StressInput } from '../../src/analysis/stress.js';
import { simulateTurn, type SimInput } from '../../src/analysis/turn-sim.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

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

/** 1 ─ 2 ─ 3 ─ 4 ─ 5 in a line, and 1 ─ 5 too. Bonus 100 (+4) is 2 and 3. */
const MAP = makeMap(5, [[1, 2], [2, 3], [3, 4], [4, 5], [5, 1]], [[100, 4, [2, 3]]]);
const graph = buildGraph(MAP);

function sim(entries: TerritoryState[], over: Partial<SimInput>) {
  return simulateTurn({ graph, board: board(entries), deploys: [], orders: [], moveOrder: [ME, FOE], settings: STD, ...over });
}

describe('simulateTurn: Airlifts (phase 43)', () => {
  it('runs after every deploy: the source sends its deploy too, and the destination gains the armies', () => {
    const r = sim([me(1, 2), me(3, 1), foe(4, 1)], {
      deploys: [{ player: ME, territoryId: 1, armies: 5 }],
      airlifts: [{ player: ME, from: 1, to: 3, armies: 6 }],
    });
    expect(r.territories.get(1)).toMatchObject({ owner: ME, armies: 1 });
    expect(r.territories.get(3)).toMatchObject({ owner: ME, armies: 7 });
  });

  it('lands before every attack, whoever moves first', () => {
    // Without it the foe's 9 take 3's single army; with 8 airlifted in, 9 × 0.6 = 5 kills leave 4.
    const entries = [me(1, 9), me(3, 1), foe(4, 10)];
    const attack = { player: FOE, orders: [{ from: 4, to: 3, armies: 9 }] };
    for (const moveOrder of [[ME, FOE], [FOE, ME]]) {
      expect(sim(entries, { orders: [attack], moveOrder }).territories.get(3)?.owner).toBe(FOE);
      const held = sim(entries, { orders: [attack], moveOrder, airlifts: [{ player: ME, from: 1, to: 3, armies: 8 }] });
      expect(held.territories.get(3)).toMatchObject({ owner: ME, armies: 4 });
    }
  });

  it('armies airlifted in cannot move again that turn', () => {
    // 3 holds 2 of its own; 8 land. An attack of 9 from 3 sends only what has not moved (2; a landed army stands guard).
    const r = sim([me(1, 9), me(3, 2), foe(4, 1)], {
      airlifts: [{ player: ME, from: 1, to: 3, armies: 8 }],
      orders: [{ player: ME, orders: [{ from: 3, to: 4, armies: 9 }] }],
    });
    expect(r.log[0]).toMatchObject({ from: 3, to: 4, sent: 2 });
  });

  it('does nothing onto a territory not mine or a teammate\'s, nor from one not mine', () => {
    const entries = [me(1, 5), foe(4, 3)];
    const r = sim(entries, { airlifts: [{ player: ME, from: 1, to: 4, armies: 3 }, { player: ME, from: 4, to: 1, armies: 2 }] });
    expect(r.territories.get(1)?.armies).toBe(5);
    expect(r.territories.get(4)?.armies).toBe(3);
  });

  it('takes my commander along to my own territory, its move used', () => {
    const withCommander: TerritoryState = { ...me(1, 3), specialUnits: [{ kind: 'commander', playerId: ME, id: 'c' }] } as TerritoryState;
    const r = sim([withCommander, me(3, 1), foe(4, 1)], {
      airlifts: [{ player: ME, from: 1, to: 3, armies: 2, commander: true }],
      orders: [{ player: ME, orders: [{ from: 3, to: 4, armies: 1, withCommander: true }] }],
    });
    expect(r.territories.get(1)?.commander).toBeUndefined();
    expect(r.territories.get(3)?.commander).toBe(ME);
  });
});

function stress(entries: TerritoryState[], over: Partial<StressInput> = {}) {
  return stressPlan({ graph, board: board(entries), me: ME, deploys: [], moves: [], opponents: [{ id: FOE, deploy: 5 }], settings: STD, ...over });
}

describe('stressPlan: Airlifts applied at their phase (exact, not approximated)', () => {
  // My bonus (2, 3); the foe's 4 beside 3. 1 is a deep stack (beside 2 and 5 only).
  const entries = [me(1, 12), me(2, 2), me(3, 2), foe(4, 4), foe(5, 1)];

  it('a border that falls without the Airlift holds with it', () => {
    const without = stress(entries);
    expect(without.safe).toBe(false);
    expect(without.atRisk.bonuses.map((b) => b.id)).toEqual([100]);
    const lifted = stress(entries, { airlifts: [{ from: 1, to: 3, armies: 8 }] });
    expect(lifted.atRisk.territories.map((t) => t.id)).not.toContain(3);
    expect(lifted.atRisk.bonuses).toEqual([]);
  });

  it('parity: an Airlift reads as the same armies moved on the board before the turn (no move of mine)', () => {
    const lifted = stress(entries, { airlifts: [{ from: 1, to: 3, armies: 8 }] });
    const moved = stress([me(1, 4), me(2, 2), me(3, 10), foe(4, 4), foe(5, 1)]);
    const view = (r: ReturnType<typeof stress>) => ({ safe: r.safe, atRisk: r.atRisk, replies: r.replies, harmful: r.harmful, exposed: r.exposedNextTurn });
    expect(view(lifted)).toEqual(view(moved));
  });

  it('parity with a deploy: an Airlift after a deploy equals the deploy landing on the destination', () => {
    const lifted = stress(entries, { deploys: [{ territoryId: 1, armies: 5 }], airlifts: [{ from: 1, to: 3, armies: 5 }] });
    const deployed = stress(entries, { deploys: [{ territoryId: 3, armies: 5 }] });
    const view = (r: ReturnType<typeof stress>) => ({ safe: r.safe, atRisk: r.atRisk, replies: r.replies, harmful: r.harmful });
    expect(view(lifted)).toEqual(view(deployed));
  });
});
