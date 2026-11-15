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
const START = { territories: 2, armiesPerTerritory: 5 };
const run = (boards: TripBoard[], estimate = 5, settings: object = STD, start: { territories: number; armiesPerTerritory: number } | null = START) =>
  brokenEstimates({ graph: G, boards, me: ME, settings, ...(start ? { start } : {}), estimateAt: () => estimate });

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

  it('credits its starting armies to a stack no board ever showed: an opening reveal does not trip', () => {
    // A 1v1 with 2 starts of 5 and income 5: first seen on turn 3 with 15 (a start of 5 and two deploys),
    // or 20 (both starts walked together and two deploys). Allowed: 10 starting + 10 deployed.
    for (const armies of [15, 20]) {
      const boards = [at(2, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]), at(3, [mine(1, 5), mine(2, 5), foe(3, armies), fogged(4)])];
      expect(run(boards)).toEqual([]);
    }
    // 60 is far beyond that: 20 allowed; 50 beyond its start over two turns is 25 a turn.
    const boards = [at(2, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]), at(3, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)])];
    expect(run(boards)).toEqual([{ player: FOE, turn: 3, kind: 'fog-stack', territory: 3, observed: 60, allowed: 20, implied: 25 }]);
    // Its start unknown (the settings do not give it): a stack never seen is not read.
    expect(run(boards, 5, STD, null)).toEqual([]);
  });

  it('credits a stack of its in view that walked under the fog: a walk-in is not income (#123 lesson 5)', () => {
    // Line 1-2-3-4-5, estimate 5: 2 on 3 and 50 on 4 on turn 3; 3 hidden on turn 4; 52 on 3 and 1 on 4 on
    // turn 5. Its armies in view did not grow: the 49 that left 4 (one step away, two turns) walked in.
    const G5 = buildGraph(line(5));
    const run5 = (boards: TripBoard[]) => brokenEstimates({ graph: G5, boards, me: ME, settings: STD, start: START, estimateAt: () => 5 });
    const t3 = at(3, [mine(1, 5), mine(2, 5), foe(3, 2), foe(4, 50), fogged(5)]);
    const t5 = at(5, [mine(1, 5), mine(2, 5), foe(3, 52), foe(4, 1), fogged(5)]);
    // 4 hidden on turn 4 too: its last sighting is turn 3, two steps of time for one hop.
    expect(run5([t3, at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4), fogged(5)]), t5])).toEqual([]);
    // 4 in view on turn 4 with 55: the 54 that left it since are credited.
    expect(run5([t3, at(4, [mine(1, 5), mine(2, 5), fogged(3), foe(4, 55), fogged(5)]), t5])).toEqual([]);
    // A stack that left view only counts within reach: 50 on 5, two hops from 3, on turn 4 (one turn
    // before) could not have walked in. Allowed: 2 seen + 10 deployed.
    const far = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4), foe(5, 50)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4), foe(5, 50)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 52), fogged(4), foe(5, 1)]),
    ];
    expect(run5(far)).toEqual([{ player: FOE, turn: 5, kind: 'fog-stack', territory: 3, observed: 52, allowed: 12, implied: 25 }]);
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

  it('reads no held attack from a source another stack could have hit first', () => {
    // Foe's 50 on 1 beside my source 2: an attack of it on its earlier slot shrinks my attack, which
    // sends what is left; the failure says nothing about the defence of 3.
    const boards = [
      at(4, [foe(1, 50), mine(2, 40), foe(3, 8), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 39 }] }),
      at(5, [foe(1, 1), mine(2, 5), foe(3, 3), foe(4, 1)]),
    ];
    expect(run(boards)).toEqual([]);
    // Nor when my source ended with fewer than my orders left it (something hit it), whoever did.
    const quiet = [
      at(4, [mine(1, 1), mine(2, 45), foe(3, 5), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }] }),
      at(5, [mine(1, 1), mine(2, 5), foe(3, 4), foe(4, 1)]),
    ];
    expect(run(quiet)).toEqual([]);
    // With the 10 my orders left there (and survivors back), the same failure trips.
    quiet[1] = at(5, [mine(1, 1), mine(2, 20), foe(3, 4), foe(4, 1)]);
    expect(run(quiet)).toMatchObject([{ kind: 'held-attack', territory: 3, observed: 22 }]);
  });

  it('reads no held attack from a Transfer Only order, nor from a player a Diplomacy card may have kept at peace', () => {
    const before = [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)];
    const after = at(5, [mine(1, 1), mine(2, 20), foe(3, 4), foe(4, 1)]);
    // A Transfer Only order into its territory does nothing: no attack failed.
    const transfer = at(4, before, { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }], sent: [{ from: 2, to: 3, transferOnly: true }] });
    expect(run([transfer, after])).toEqual([]);
    // A Diplomacy card in force between us: my attacks did not run.
    const plain = at(4, before, { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }] });
    expect(brokenEstimates({ graph: G, boards: [plain, after], me: ME, settings: STD, start: START, peace: new Set([FOE]), estimateAt: () => 5 })).toEqual([]);
  });

  it('counts only what a source had left for the attack after its earlier orders', () => {
    // 40 on 2: 30 go to 1 first, so the attack on 3 sends 9 of its 35 (5 kills, 6 to hold): no trip.
    const boards = [
      at(4, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 1, armies: 30 }, { from: 2, to: 3, armies: 35 }] }),
      at(5, [mine(1, 31), mine(2, 1), foe(3, 4), foe(4, 1)]),
    ];
    expect(run(boards)).toEqual([]);
    // Listed first, the attack had its 35.
    boards[0] = at(4, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }, { from: 2, to: 1, armies: 30 }] });
    expect(run(boards)).toMatchObject([{ kind: 'held-attack', territory: 3, observed: 22 }]);
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
