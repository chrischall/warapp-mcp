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

  it('killedBy: false skips the deploy search and changes nothing else', () => {
    const base = { graph, board: starBoard(), me: ME, deploys: [], moves: [], settings: GUARD_OFF, opponents: [{ id: FOE, deploy: 779 }] } as const;
    const full = commanderSafety(base)!;
    const quick = commanderSafety({ ...base, killedBy: false })!;
    expect(full.killedBy).not.toBeNull();
    expect(quick.killedBy).toBeNull();
    expect({ ...quick, killedBy: full.killedBy }).toEqual(full);
  });

  it('in a free-for-all I lead, two opponents striking it together are tried (#180)', () => {
    // 1 (mine, commander, 6) between two opponents' stacks: 2 (12) and 3 (12), each deploying 7.
    const tri = buildGraph(makeMap(3, [[1, 2], [1, 3]]));
    const CID = 30;
    const b = board([withCommander(mine(1, 6)), foe(2, 12), mine(3, 12, CID)]);
    const opponents = [
      { id: FOE, deploy: 7 },
      { id: CID, deploy: 7 },
    ];
    const input = { graph: tri, board: b, me: ME, deploys: [], moves: [], opponents, settings: STD, killedBy: false } as const;
    // Alone, 18 attackers kill 11 of 6 + 7: it survives either; together they take it.
    expect(commanderSafety(input)!.killers).toBe(0);
    const led = commanderSafety({ ...input, leader: true })!;
    expect(led.killers).toBeGreaterThan(0);
    expect(led.worst).toMatchObject({ kind: 'joint', commanderLost: true });
  });

  it('killedBy names the partner when the smallest killing deploy is two opponents striking together', () => {
    const tri = buildGraph(makeMap(3, [[1, 2], [1, 3]]));
    const CID = 30;
    const b = board([withCommander(mine(1, 6)), foe(2, 12), mine(3, 12, CID)]);
    const opponents = [
      { id: FOE, deploy: 7 },
      { id: CID, deploy: 7 },
    ];
    const led = commanderSafety({ graph: tri, board: b, me: ME, deploys: [], moves: [], opponents, settings: STD, leader: true })!;
    expect(led.killedBy).not.toBeNull();
    // Each opponent deploys the same amount; the two together kill it below what either needs alone.
    const alone = commanderSafety({ graph: tri, board: b, me: ME, deploys: [], moves: [], opponents, settings: STD })!;
    expect(led.killedBy!.deploy).toBeLessThan(alone.killedBy!.deploy);
    expect(led.killedBy!.partner).toBeDefined();
    expect(new Set([led.killedBy!.opponent, led.killedBy!.partner])).toEqual(new Set([FOE, CID]));
    expect(alone.killedBy!.partner).toBeUndefined();
  });
});

describe('commanderSafety airlifts (#274 review)', () => {
  // A 3-line: 1 (mine, commander, 6) ─ 2 (foe, 16), and 3 (mine, 3) beside 2 as well.
  const tri = buildGraph(makeMap(3, [[1, 2], [2, 3]]));
  const b = () => board([withCommander(mine(1, 6)), foe(2, 16), mine(3, 3)]);
  const base = { graph: tri, me: ME, moves: [], opponents: [{ id: FOE, deploy: 7 }], settings: STD, killedBy: false } as const;

  it('an Airlift out of the commander\'s territory runs after the deploys and leaves fewer there', () => {
    const held = commanderSafety({ ...base, board: b(), deploys: [{ territoryId: 1, armies: 7 }] })!;
    expect(held.killers).toBe(0);
    const out = commanderSafety({ ...base, board: b(), deploys: [{ territoryId: 1, armies: 7 }], airlifts: [{ from: 1, to: 3, armies: 12 }] })!;
    expect(out.territory).toBe(1);
    expect(out.armies).toBe(1);
    expect(out.killers).toBeGreaterThan(0);
    expect(out.needs).toBeGreaterThan(1);
  });

  it('an Airlift onto the commander\'s territory counts', () => {
    const low = commanderSafety({ ...base, board: b(), deploys: [] })!;
    expect(low.killers).toBeGreaterThan(0);
    const fed = commanderSafety({ ...base, board: b(), deploys: [{ territoryId: 3, armies: 7 }], airlifts: [{ from: 3, to: 1, armies: 9 }] })!;
    expect(fed.armies).toBe(15);
    expect(fed.killers).toBe(0);
  });

  it('follows the commander when the Airlift takes it', () => {
    // Behind 9 on 1 it is safe; airlifted alone to 3 (3 armies) it stands beside the 16.
    const bb = board([withCommander(mine(1, 20)), foe(2, 16), mine(3, 3)]);
    const flown = commanderSafety({ ...base, board: bb, deploys: [], airlifts: [{ from: 1, to: 3, armies: 0, commander: true }] })!;
    expect(flown.from).toBe(1);
    expect(flown.territory).toBe(3);
    expect(flown.armies).toBe(3);
    expect(flown.killers).toBeGreaterThan(0);
  });
});

describe('stressPlan targets (#274)', () => {
  it('tries only the replies that strike the territories named', () => {
    const graph = buildGraph(STAR);
    const all = stressPlan({ graph, board: starBoard(), me: ME, deploys: [], moves: [], opponents: [{ id: FOE, deploy: 5 }], settings: GUARD_OFF, lookAhead: false });
    const one = stressPlan({ graph, board: starBoard(), me: ME, deploys: [], moves: [], opponents: [{ id: FOE, deploy: 5 }], settings: GUARD_OFF, lookAhead: false, targets: [1] });
    // (More may be considered than without targets: the converging replies below are tried only with them.)
    expect(one.considered).toBeGreaterThan(0);
    // The stack on 2 striking 8 is no longer tried.
    expect(all.replies.some((r) => r.to === 8)).toBe(true);
    expect(one.replies.some((r) => r.to === 8)).toBe(false);
  });

  it('tries every stack beside a target converging on it, the deploy on each in turn (#274 review 2)', () => {
    // My commander on 1 (10 + its 7) beside the foe's 2 (30) and 5 (30); the foe's largest stack, 7 (500),
    // faces my 6. The all-attack puts the deploy on 7; converging with the deploy on 2 or 5 kills it.
    const g = buildGraph(makeMap(8, [[1, 2], [1, 5], [1, 3], [3, 4], [6, 7], [6, 8]]));
    const b = board([withCommander(mine(1, 29)), foe(2, 30), mine(3, 1), mine(4, 1), foe(5, 30), mine(6, 1), foe(7, 500), mine(8, 1)]);
    const input = { graph: g, board: b, me: ME, deploys: [], moves: [], opponents: [{ id: FOE, deploy: 30 }], settings: STD, lookAhead: false } as const;
    const plain = stressPlan(input);
    expect(plain.replies.some((r) => r.kind === 'all-attack' && r.deployTo !== 7)).toBe(false);
    const one = stressPlan({ ...input, targets: [1] });
    expect(one.replies.some((r) => r.kind === 'all-attack' && (r.deployTo === 2 || r.deployTo === 5) && r.lost.includes(1))).toBe(true);
    expect(commanderSafety({ ...input, killedBy: false })!.killers).toBeGreaterThan(0);
  });
});
