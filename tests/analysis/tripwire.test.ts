// #275 (b): the broken-estimate tripwire. One observation that an opponent's deploy estimate cannot
// explain by 1.5× or more marks that estimate untrusted for the next turns. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  activeTripwires,
  brokenEstimates,
  TRIP_RATIO,
  UNTRUSTED_TURNS,
  type TripBoard,
  type Tripwire,
} from '../../src/analysis/tripwire.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function line(n: number): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: ids.filter((x) => Math.abs(x - id) === 1),
    })),
    bonuses: [],
    distributionModes: [],
  };
}
const foe = (id: number, armies: number): TerritoryState => mine(id, armies, FOE);
const G = buildGraph(line(4));
const at = (turn: number, entries: TerritoryState[], orders?: TripBoard['orders']): TripBoard => ({
  turn,
  board: board(entries),
  ...(orders ? { orders } : {}),
});
const run = (boards: TripBoard[], estimate = 5, settings: object = STD) =>
  brokenEstimates({ graph: G, boards, me: ME, settings, estimateAt: () => estimate });

describe('brokenEstimates (#275 b)', () => {
  it('trips on a stack out of the fog larger than the estimate times the turns it was unseen', () => {
    // Seen with 2 on turn 3, hidden on turn 4, 60 on turn 5: two turns of a 5 deploy allow 12.
    const boards = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)]),
    ];
    expect(run(boards)).toEqual([
      { player: FOE, turn: 5, kind: 'fog-stack', territory: 3, observed: 60, allowed: 12, implied: 29 },
    ]);
    // 15 is within 1.5 × 12: nothing.
    boards[2] = at(5, [mine(1, 5), mine(2, 5), foe(3, 15), fogged(4)]);
    expect(run(boards)).toEqual([]);
  });

  it('trips on a capture that needed more attackers than the stacks beside it plus the estimate', () => {
    // My 10 on 2 need 16 attackers; the stack of 3 sends 2, with a 5 deploy 7.
    const boards = [
      at(4, [mine(1, 1), mine(2, 10), foe(3, 3), fogged(4)], { deploys: [], moves: [] }),
      at(5, [mine(1, 1), foe(2, 8), foe(3, 1), fogged(4)]),
    ];
    expect(run(boards)).toEqual([{ player: FOE, turn: 5, kind: 'capture', territory: 2, observed: 16, allowed: 7, implied: 14 }]);
    // A deploy estimate of 10 allows 12: 16 is below 1.5 × 12.
    expect(run(boards, 10)).toEqual([]);
  });

  it('reads no capture of mine without my orders, nor beside a territory the fog hid', () => {
    const before = [mine(1, 1), mine(2, 10), foe(3, 3), fogged(4)];
    const after = [mine(1, 1), foe(2, 8), foe(3, 1), fogged(4)];
    // My orders unknown: I may have moved armies out of 2 first.
    expect(run([at(4, before), at(5, after)])).toEqual([]);
    // 1 hidden on the previous board: a stack of its could have attacked too.
    const hid = [fogged(1), mine(2, 10), foe(3, 3), fogged(4)];
    expect(run([at(4, hid, { deploys: [], moves: [] }), at(5, after)])).toEqual([]);
  });

  it('trips on an attack of mine held by more defenders than the territory, its neighbours and the estimate allow', () => {
    // 35 attackers kill 21: 22 defenders at least held 3, where 5 stood with a 5 deploy and no stack beside it.
    const boards = [
      at(4, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }] }),
      at(5, [mine(1, 1), mine(2, 20), foe(3, 4), foe(4, 1)]),
    ];
    expect(run(boards)).toEqual([{ player: FOE, turn: 5, kind: 'held-attack', territory: 3, observed: 22, allowed: 10, implied: 17 }]);
    // With luck, a failed attack proves nothing.
    expect(run(boards, 5, { ...STD, luckModifier: 0.16 })).toEqual([]);
  });

  it('needs the previous board: no reading across a gap', () => {
    const boards = [at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4)]), at(5, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)])];
    expect(run(boards)).toEqual([]);
  });
});

describe('activeTripwires (#275 b)', () => {
  const obs = { player: FOE, turn: 5, kind: 'capture' as const, territory: 2, observed: 16, allowed: 7, implied: 14 };

  it(`marks an opponent untrusted for ${UNTRUSTED_TURNS} turns from the observation`, () => {
    const [w] = activeTripwires([], [obs], 5);
    expect(w).toEqual({ player: FOE, since: 5, until: 5 + UNTRUSTED_TURNS - 1, kind: 'capture', territory: 2, observed: 16, allowed: 7, implied: 14 });
    expect(activeTripwires([w!], [], 5 + UNTRUSTED_TURNS - 1)).toEqual([w]);
    expect(activeTripwires([w!], [], 5 + UNTRUSTED_TURNS)).toEqual([]);
  });

  it('keeps the largest figure while untrusted, and a new observation restarts the count', () => {
    const old: Tripwire = { player: FOE, since: 4, until: 6, kind: 'fog-stack', territory: 3, observed: 90, allowed: 20, implied: 40 };
    expect(activeTripwires([old], [obs], 5)).toEqual([{ ...old, since: 5, until: 5 + UNTRUSTED_TURNS - 1 }]);
    expect(TRIP_RATIO).toBe(1.5);
  });
});
