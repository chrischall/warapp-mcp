// #274: is my commander takeable after my orders? The stress test's replies that strike its
// territory, the armies it needs to survive every one of them, and the smallest single enemy
// deploy that kills it. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { commanderSafety, myCommanderTerritory } from '../../src/analysis/commander-safety.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { stressPlan } from '../../src/analysis/stress.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
/** The lost game's rules: guard off, 60/70. */
const GUARD_OFF = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };

function makeMap(n: number, edges: [number, number][]): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [],
    distributionModes: [],
  };
}

const foe = (id: number, armies: number): TerritoryState => mine(id, armies, FOE);
const withCommander = (t: TerritoryState, owner = ME): TerritoryState => ({ ...t, specialUnits: [{ kind: 'commander', id: 'c', playerId: owner }] });

/**
 * The live shape (#274): my commander on territory 1 with 341 armies, the opponent on all six
 * neighbours (2–7) at 0–1 each, my other territory 8 behind 2. Territory 9 beyond 8 is fogged.
 */
const STAR = makeMap(9, [
  [1, 2],
  [1, 3],
  [1, 4],
  [1, 5],
  [1, 6],
  [1, 7],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 6],
  [6, 7],
  [2, 8],
  [8, 9],
]);
const starBoard = () =>
  board([withCommander(mine(1, 341)), foe(2, 1), foe(3, 0), foe(4, 1), foe(5, 0), foe(6, 1), foe(7, 0), mine(8, 2), fogged(9)]);

describe('myCommanderTerritory', () => {
  it('finds my commander, never an opponent\'s', () => {
    expect(myCommanderTerritory(starBoard(), ME)).toBe(1);
    expect(myCommanderTerritory(board([withCommander(foe(2, 3), FOE), mine(1, 4)]), ME)).toBeUndefined();
  });
});

describe('commanderSafety', () => {
  const graph = buildGraph(STAR);

  it('returns nothing when I have no commander on the board', () => {
    const r = commanderSafety({ graph, board: board([mine(1, 5), foe(2, 3)]), me: ME, deploys: [], moves: [], opponents: [{ id: FOE, deploy: 5 }], settings: STD });
    expect(r).toBeUndefined();
  });

  it('the live shape: safe against the 444 estimate, takeable at my own income, and how many armies hold', () => {
    const base = { graph, board: starBoard(), me: ME, deploys: [], moves: [], settings: GUARD_OFF } as const;
    // At the estimate, no single deploy breaks 341 + the commander.
    const atEstimate = commanderSafety({ ...base, opponents: [{ id: FOE, deploy: 444 }] })!;
    expect(atEstimate.territory).toBe(1);
    expect(atEstimate.armies).toBe(341);
    expect(atEstimate.killers).toBe(0);
    expect(atEstimate.needs).toBe(341);
    expect(atEstimate.distance).toBe(1);
    // Killing 341 + 7 takes 580 attackers: the smallest single deploy that does it lies between.
    expect(atEstimate.killedBy).not.toBeNull();
    const d = atEstimate.killedBy!.deploy;
    expect(d).toBeGreaterThan(444);
    expect(d).toBeLessThanOrEqual(580);
    expect(atEstimate.killedBy!.opponent).toBe(FOE);
    // It is the boundary: one fewer and every reply fails, at it some reply kills the commander.
    const at = (deploy: number) => stressPlan({ ...base, opponents: [{ id: FOE, deploy }], lookAhead: false }).atRisk.commander;
    expect(at(d - 1)).toBe(0);
    expect(at(d)).toBeGreaterThan(0);

    // At my own income (779) it falls; `needs` is the least that holds against every reply tried.
    const atIncome = commanderSafety({ ...base, opponents: [{ id: FOE, deploy: 779 }] })!;
    expect(atIncome.killers).toBeGreaterThan(0);
    expect(atIncome.worst).toMatchObject({ opponent: FOE, commanderLost: true });
    expect(atIncome.needs).toBeGreaterThan(341);
    const deployed = (n: number) =>
      stressPlan({ ...base, deploys: [{ territoryId: 1, armies: n }], opponents: [{ id: FOE, deploy: 779 }], lookAhead: false }).atRisk.commander;
    expect(deployed(atIncome.needs! - 341)).toBe(0);
    expect(deployed(atIncome.needs! - 341 - 1)).toBeGreaterThan(0);
  });

  it('counts the armies my orders leave there, and follows a commander my orders move', () => {
    // A 4-line: 1 (mine, commander, 10) ─ 2 (mine, 3) ─ 3 (foe, 2) ─ 4 (foe, 1).
    const line = buildGraph(makeMap(4, [[1, 2], [2, 3], [3, 4]]));
    const b = board([withCommander(mine(1, 10)), mine(2, 3), foe(3, 2), foe(4, 1)]);
    const stay = commanderSafety({ graph: line, board: b, me: ME, deploys: [], moves: [{ from: 1, to: 2, armies: 6 }], opponents: [{ id: FOE, deploy: 5 }], settings: STD })!;
    expect(stay.territory).toBe(1);
    expect(stay.armies).toBe(4);
    expect(stay.distance).toBe(2);
    // Two moves from the nearest enemy: no single deploy reaches it this turn.
    expect(stay.killedBy).toBeNull();
    expect(stay.killers).toBe(0);
    // Taken along to 2, it stands beside the enemy with 9 + 3.
    const moved = commanderSafety({
      graph: line,
      board: b,
      me: ME,
      deploys: [],
      moves: [{ from: 1, to: 2, armies: 9, withCommander: true }],
      opponents: [{ id: FOE, deploy: 5 }],
      settings: STD,
    })!;
    expect(moved.territory).toBe(2);
    expect(moved.armies).toBe(12);
    expect(moved.distance).toBe(1);
  });

  it('counts the fog as a possible enemy for the distance', () => {
    const line = buildGraph(makeMap(3, [[1, 2], [2, 3]]));
    const r = commanderSafety({
      graph: line,
      board: board([withCommander(mine(1, 10)), neutral(2, 2), fogged(3)]),
      me: ME,
      deploys: [],
      moves: [],
      opponents: [{ id: FOE, deploy: 5 }],
      settings: STD,
    })!;
    expect(r.distance).toBe(2);
    expect(r.killedBy).toBeNull();
  });
});

describe('stressPlan targets (#274)', () => {
  it('tries only the replies that strike the territories named', () => {
    const graph = buildGraph(STAR);
    const all = stressPlan({ graph, board: starBoard(), me: ME, deploys: [], moves: [], opponents: [{ id: FOE, deploy: 5 }], settings: GUARD_OFF, lookAhead: false });
    const one = stressPlan({ graph, board: starBoard(), me: ME, deploys: [], moves: [], opponents: [{ id: FOE, deploy: 5 }], settings: GUARD_OFF, lookAhead: false, targets: [1] });
    expect(one.considered).toBeLessThan(all.considered);
    expect(one.considered).toBeGreaterThan(0);
    // The stack on 2 striking 8 is no longer tried.
    expect(all.replies.some((r) => r.to === 8)).toBe(true);
    expect(one.replies.some((r) => r.to === 8)).toBe(false);
  });
});
