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
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, multiAttack: false };

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
// Orders given without `sent` carry it as `myOrdersOf` writes it: every move in `moves`, nothing more.
const at = (turn: number, entries: TerritoryState[], orders?: TripBoard['orders']): TripBoard => ({
  turn,
  board: board(entries),
  ...(orders ? { orders: { ...orders, sent: orders.sent ?? orders.moves.map(({ from, to }) => ({ from, to })) } } : {}),
});
/** A board whose orders were cached before `sent` existed: which orders went is unknown. */
const oldCache = (turn: number, entries: TerritoryState[], orders: NonNullable<TripBoard['orders']>): TripBoard => ({
  turn,
  board: board(entries),
  orders: { deploys: orders.deploys, moves: orders.moves },
});
const START = { territories: 2, armiesPerTerritory: 5 };
const run = (boards: TripBoard[], estimate = 5, settings: object = STD, start: { territories: number; armiesPerTerritory: number } | null = START) =>
  brokenEstimates({ graph: G, boards, me: ME, settings, ...(start ? { start } : {}), estimateAt: () => estimate });

describe('brokenEstimates (#275 b)', () => {
  it('trips on a stack out of the fog larger than the estimate times the turns it was unseen', () => {
    // Seen with 2 on turn 3, hidden on turn 4, 60 on turn 5: two turns of a 5 deploy allow 12, its whole
    // stock (starts of 10 and four turns of 5) 30, the larger.
    const boards = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)]),
    ];
    expect(run(boards)).toEqual([
      { player: FOE, turn: 5, kind: 'fog-stack', territory: 3, observed: 60, allowed: 30, implied: 13 },
    ]);
    // Its start unknown, 4 beside it hidden on every board since the sighting: a stack banked there may
    // have walked in, and nothing bounds it without the stock. Not read.
    expect(run(boards, 5, STD, null)).toEqual([]);
    // With 4 in view on every board, the sighting and the deploys since alone.
    const open = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), mine(4, 5)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), mine(4, 5)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 60), mine(4, 5)]),
    ];
    expect(run(open, 5, STD, null)).toEqual([
      { player: FOE, turn: 5, kind: 'fog-stack', territory: 3, observed: 60, allowed: 12, implied: 29 },
    ]);
    // 15 is within 1.5 × 12: nothing.
    open[2] = at(5, [mine(1, 5), mine(2, 5), foe(3, 15), mine(4, 5)]);
    expect(run(open, 5, STD, null)).toEqual([]);
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
    // before) could not have walked in. Allowed: 2 seen + 10 deployed without the start; with it, the
    // whole stock of 30 less the 1 still in view on 5.
    const far = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4), foe(5, 50)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4), foe(5, 50)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 52), fogged(4), foe(5, 1)]),
    ];
    expect(run5(far)).toEqual([{ player: FOE, turn: 5, kind: 'fog-stack', territory: 3, observed: 52, allowed: 29, implied: 11 }]);
    // Its start unknown, 4 hidden on every board since the sighting: not read.
    expect(brokenEstimates({ graph: G5, boards: far, me: ME, settings: STD, estimateAt: () => 5 })).toEqual([]);
    // With 4 in view (mine), the sighting and the deploys since alone.
    const farOpen = far.map((b) => ({ ...b, board: board(b.board.territories.map((t) => (t.territoryId === 4 ? mine(4, 5) : t))) }));
    expect(brokenEstimates({ graph: G5, boards: farOpen, me: ME, settings: STD, estimateAt: () => 5 })).toEqual([
      { player: FOE, turn: 5, kind: 'fog-stack', territory: 3, observed: 52, allowed: 12, implied: 25 },
    ]);
  });

  it('credits armies banked under the fog with its whole stock: a stack no board showed walking in is not income', () => {
    // Line 1-2-3-4, estimate 5, starts 2 × 5: 4 hidden on every board; 3 shows 2 on turn 8, hidden on
    // turn 9, 45 on turn 10. Its stock by then is 10 + 9 × 5 = 55: a stack banked on 4 explains it.
    const bank = (t10: number, extra: TerritoryState[] = []) => [
      at(8, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4)]),
      at(9, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]),
      at(10, [mine(1, 5), mine(2, 5), foe(3, t10), fogged(4), ...extra]),
    ];
    expect(run(bank(45))).toEqual([]);
    // 90 is beyond its whole stock: it trips, allowed the stock and implied over every turn since turn 1.
    expect(run(bank(90))).toEqual([{ player: FOE, turn: 10, kind: 'fog-stack', territory: 3, observed: 90, allowed: 55, implied: 9 }]);
    // Its start unknown: nothing bounds what 4, hidden on every board since the sighting, banked. Not read.
    expect(run(bank(45), 5, STD, null)).toEqual([]);
    expect(run(bank(90), 5, STD, null)).toEqual([]);
    // Armies of its in view elsewhere now are not in the stack: the stock less them.
    const G5 = buildGraph(line(5));
    const run5 = (boards: TripBoard[]) => brokenEstimates({ graph: G5, boards, me: ME, settings: STD, start: START, estimateAt: () => 5 });
    const five = (t10: number, on5: number) => [
      at(8, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4), fogged(5)]),
      at(9, [mine(1, 5), mine(2, 5), fogged(3), fogged(4), fogged(5)]),
      at(10, [mine(1, 5), mine(2, 5), foe(3, t10), fogged(4), foe(5, on5)]),
    ];
    expect(run5(five(45, 1))).toEqual([]);
    expect(run5(five(45, 30))).toEqual([{ player: FOE, turn: 10, kind: 'fog-stack', territory: 3, observed: 45, allowed: 25, implied: 8 }]);
  });

  it('reads nothing off a board from GameFeed history (unverified, loosely parsed)', () => {
    // The previous board came from history: a stack it shows less of is not read as out of the fog.
    const hist = (b: TripBoard): TripBoard => ({ ...b, source: 'history' });
    const boards = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4)]),
      hist(at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)])),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)]),
    ];
    expect(run(boards)).toEqual([]);
    // The last sighting from history is no sighting: with its start known, the stock bound alone.
    const seen = [
      hist(at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4)])),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)]),
    ];
    expect(run(seen)).toEqual([{ player: FOE, turn: 5, kind: 'fog-stack', territory: 3, observed: 60, allowed: 30, implied: 13 }]);
    // …and with it unknown, nothing is read.
    expect(run(seen, 5, STD, null)).toEqual([]);
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

  it('counts an opponent commander as 7: on the target of a held attack and on its stacks beside a capture', () => {
    const cmd = (t: TerritoryState): TerritoryState => ({ ...t, specialUnits: [{ kind: 'commander', id: 'c'.repeat(32), playerId: FOE }] });
    // 35 attackers kill 21: 22 to hold, where 5 and its commander (12) stood with a 5 deploy: 17 allowed, no trip.
    const held = [
      at(4, [mine(1, 1), mine(2, 40), cmd(foe(3, 5)), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }] }),
      at(5, [mine(1, 1), mine(2, 20), cmd(foe(3, 4)), foe(4, 1)]),
    ];
    expect(run(held)).toEqual([]);
    // My 10 on 2 need 16 attackers; its 6 beside it move 5, its commander 7 more, with a 5 deploy 17: no trip.
    const capture = [
      at(4, [mine(1, 1), mine(2, 10), cmd(foe(3, 6)), fogged(4)], { deploys: [], moves: [] }),
      at(5, [mine(1, 1), foe(2, 8), foe(3, 1), fogged(4)]),
    ];
    expect(run(capture)).toEqual([]);
    // Without the commander both trip.
    const plain = (b: TripBoard[]) => b.map((x) => ({ ...x, board: board(x.board.territories.map(({ specialUnits: _, ...t }) => t)) }));
    expect(run(plain(held))).toMatchObject([{ kind: 'held-attack', allowed: 10 }]);
    expect(run(plain(capture))).toMatchObject([{ kind: 'capture', observed: 16, allowed: 10 }]);
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
    // Listed first, the attack had its 35 (and the transfer the 4 left: 1 ends at 5).
    boards[0] = at(4, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }, { from: 2, to: 1, armies: 30 }] });
    boards[1] = at(5, [mine(1, 5), mine(2, 1), foe(3, 4), foe(4, 1)]);
    expect(run(boards)).toMatchObject([{ kind: 'held-attack', territory: 3, observed: 22 }]);
  });

  it('reads no held attack under Multi-Attack, or when the settings do not say: a chain brings armies from further', () => {
    const boards = [
      at(4, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }] }),
      at(5, [mine(1, 1), mine(2, 20), foe(3, 4), foe(4, 1)]),
    ];
    expect(run(boards)).toMatchObject([{ kind: 'held-attack' }]);
    expect(run(boards, 5, { ...STD, multiAttack: true })).toEqual([]);
    const { multiAttack: _, ...unsaid } = STD;
    expect(run(boards, 5, unsaid)).toEqual([]);
  });

  it('under Multi-Attack (or unsaid) credits a stack that left view from any distance: a chain covers many hops in one turn', () => {
    // The 50 on 5, two hops from 3, one turn before: out of reach for one step a turn, not for a chain.
    const G5 = buildGraph(line(5));
    const far = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4), foe(5, 50)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4), foe(5, 50)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 52), fogged(4), foe(5, 1)]),
    ];
    const run5 = (settings: object) => brokenEstimates({ graph: G5, boards: far, me: ME, settings, start: START, estimateAt: () => 5 });
    expect(run5(STD)).toMatchObject([{ kind: 'fog-stack', territory: 3 }]);
    expect(run5({ ...STD, multiAttack: true })).toEqual([]);
    const { multiAttack: _, ...unsaid } = STD;
    expect(run5(unsaid)).toEqual([]);
  });

  it('reads nothing when an opponent may hold an Airlift card: one lands armies anywhere it holds', () => {
    const fog = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)]),
    ];
    const capture = [
      at(4, [mine(1, 1), mine(2, 10), foe(3, 3), fogged(4)], { deploys: [], moves: [] }),
      at(5, [mine(1, 1), foe(2, 8), foe(3, 1), fogged(4)]),
    ];
    const held = [
      at(4, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }] }),
      at(5, [mine(1, 1), mine(2, 20), foe(3, 4), foe(4, 1)]),
    ];
    for (const boards of [fog, capture, held]) {
      expect(run(boards)).toHaveLength(1);
      expect(brokenEstimates({ graph: G, boards, me: ME, settings: STD, start: START, airlift: true, estimateAt: () => 5 })).toEqual([]);
    }
  });

  it('reads no capture or held attack when an opponent may hold a Bomb card: one halves my source or my territory first', () => {
    // My 60 on 2 attack its 13 on 3 with 59; it deploys 5 on 3 and bombs 2 (phase 30, before attacks), so
    // only 29 attack and fail. 2 ends at the guard plus survivors either way: the source check misses it.
    const held = [
      at(4, [mine(1, 1), mine(2, 60), foe(3, 13), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 59 }] }),
      at(5, [mine(1, 1), mine(2, 17), foe(3, 1), foe(4, 1)]),
    ];
    expect(run(held)).toMatchObject([{ kind: 'held-attack', territory: 3, observed: 36, allowed: 18 }]);
    // A bombed territory of mine needs about half the attackers counted.
    const capture = [
      at(4, [mine(1, 1), mine(2, 10), foe(3, 3), fogged(4)], { deploys: [], moves: [] }),
      at(5, [mine(1, 1), foe(2, 8), foe(3, 1), fogged(4)]),
    ];
    expect(run(capture)).toMatchObject([{ kind: 'capture' }]);
    const bomb = (boards: TripBoard[]) => brokenEstimates({ graph: G, boards, me: ME, settings: STD, start: START, bomb: true, estimateAt: () => 5 });
    expect(bomb(held)).toEqual([]);
    expect(bomb(capture)).toEqual([]);
    // A Bomb only kills: a stack out of the fog is still read.
    const fog = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)]),
    ];
    expect(bomb(fog)).toMatchObject([{ kind: 'fog-stack', territory: 3 }]);
  });

  it('allows the Reinforcement cards an opponent may bank and play at once on a capture or a held attack (#275 review)', () => {
    const capture = [
      at(4, [mine(1, 1), mine(2, 10), foe(3, 3), fogged(4)], { deploys: [], moves: [] }),
      at(5, [mine(1, 1), foe(2, 8), foe(3, 1), fogged(4)]),
    ];
    const held = [
      at(4, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }] }),
      at(5, [mine(1, 1), mine(2, 20), foe(3, 4), foe(4, 1)]),
    ];
    const banked = (boards: TripBoard[], b: number) => brokenEstimates({ graph: G, boards, me: ME, settings: STD, start: START, banked: b, estimateAt: () => 5 });
    // Two banked cards of 7 more: the capture's 16 against 7 + 14, the held attack's 22 against 10 + 14.
    expect(banked(capture, 14)).toEqual([]);
    expect(banked(held, 14)).toEqual([]);
    // A bank that cannot be counted reads neither.
    expect(banked(capture, Infinity)).toEqual([]);
    expect(banked(held, Infinity)).toEqual([]);
    // None banked: as before.
    expect(banked(capture, 0)).toMatchObject([{ kind: 'capture', allowed: 7 }]);
    // A stack out of the fog keeps its own bound (its stock counts every turn's estimate).
    const fog = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)]),
    ];
    expect(banked(fog, Infinity)).toMatchObject([{ kind: 'fog-stack', territory: 3 }]);
  });

  it("credits no opponent's armies to another: a held attack beside another player, a fog stack of a player with a teammate", () => {
    const Q = 30;
    const q = (id: number, armies: number): TerritoryState => mine(id, armies, Q);
    const teams = new Map([[ME, 1], [FOE, 2], [Q, 2]]);
    const withTeams = (boards: TripBoard[], t: ReadonlyMap<number, number> | undefined = teams) =>
      brokenEstimates({ graph: G, boards, me: ME, settings: STD, start: START, ...(t ? { teams: t } : {}), estimateAt: () => 5 });
    // Its teammate's 41 on 4 send 40 into 3: my 34 from 2 fail on what reads as 21 defenders.
    const held = [
      at(4, [mine(1, 1), mine(2, 40), foe(3, 5), q(4, 41)], { deploys: [], moves: [{ from: 2, to: 3, armies: 34 }] }),
      at(5, [mine(1, 1), mine(2, 6), foe(3, 30), q(4, 1)]),
    ];
    expect(withTeams(held)).toEqual([]);
    // A third player beside the target, teams or none, may have moved armies in or out: not read.
    expect(withTeams(held, undefined)).toEqual([]);
    // With its own stack there, the same failure trips.
    const own = [
      at(4, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 34 }] }),
      at(5, [mine(1, 1), mine(2, 6), foe(3, 30), foe(4, 1)]),
    ];
    expect(withTeams(own)).toMatchObject([{ kind: 'held-attack', territory: 3, observed: 21, allowed: 10 }]);
    // Its teammate's 60 seen on 4, then 60 of its on the fogged 3 beside it: the teammate's walked in.
    const fog = [at(3, [mine(1, 5), mine(2, 5), fogged(3), q(4, 60)]), at(4, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)])];
    expect(withTeams(fog)).toEqual([]);
    // With no teammate, the same stack trips (its start and three turns of 5 allow 25).
    expect(withTeams(fog, new Map([[ME, 1], [FOE, 2], [Q, 3]]))).toMatchObject([{ kind: 'fog-stack', observed: 60, allowed: 25 }]);
  });

  it('reads no player who is out with no AI on its seat, nor one with no estimate (#270)', () => {
    // Starts 2 × 5: 40 of player 20 on 3, hidden last turn.
    const boards = [at(2, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]), at(3, [mine(1, 5), mine(2, 5), foe(3, 40), fogged(4)])];
    expect(run(boards)).toMatchObject([{ kind: 'fog-stack', observed: 40, allowed: 20 }]);
    expect(brokenEstimates({ graph: G, boards, me: ME, settings: STD, start: START, staticSeats: new Set([FOE]), estimateAt: () => 5 })).toEqual([]);
    // No estimate for it (the planner neutralizes a static seat): never compared against 0.
    expect(brokenEstimates({ graph: G, boards, me: ME, settings: STD, start: START, estimateAt: () => undefined })).toEqual([]);
  });

  it("reads no capture of a territory my Transfer Only, Attack Only or percentage order left: `moves` leaves them out", () => {
    // 39 of my 40 on 2 go to 1 by Transfer Only; its 12 beside it take the 1 left. Read from `moves`
    // alone, 40 defenders would have needed 66.
    const before = [mine(1, 1), mine(2, 40), foe(3, 12), fogged(4)];
    const after = at(5, [mine(1, 40), foe(2, 10), foe(3, 1), fogged(4)]);
    expect(run([at(4, before, { deploys: [], moves: [], sent: [{ from: 2, to: 1, transferOnly: true }] }), after])).toEqual([]);
    // A percentage or Attack Only order out of it is no different.
    expect(run([at(4, before, { deploys: [], moves: [], sent: [{ from: 2, to: 1 }] }), after])).toEqual([]);
    // Orders cached before `sent` existed: what went out of 2 is unknown.
    expect(run([oldCache(4, before, { deploys: [], moves: [] }), after])).toEqual([]);
    // With nothing sent out of 2 (1 still at 1, as the board agrees), the same capture trips.
    expect(run([at(4, before, { deploys: [], moves: [] }), at(5, [mine(1, 1), foe(2, 10), foe(3, 1), fogged(4)])])).toMatchObject([
      { kind: 'capture', territory: 2 },
    ]);
  });

  it('reads no capture of a neutral my Attack Only or percentage order may have worn down first', () => {
    // Its 3 beside the neutral 10 move 2: with a 5 deploy 7, where 16 were needed.
    const before = [mine(1, 20), neutral(2, 10), foe(3, 3), fogged(4)];
    const after = at(5, [mine(1, 10), foe(2, 2), foe(3, 1), fogged(4)]);
    // With no order of mine, 1 still holds its 20 (the board agrees).
    const still = at(5, [mine(1, 20), foe(2, 2), foe(3, 1), fogged(4)]);
    expect(run([at(4, before, { deploys: [], moves: [] }), still])).toMatchObject([{ kind: 'capture', territory: 2, observed: 16, allowed: 7 }]);
    expect(run([at(4, before, { deploys: [], moves: [], sent: [{ from: 1, to: 2 }] }), after])).toEqual([]);
    expect(run([oldCache(4, before, { deploys: [], moves: [] }), after])).toEqual([]);
    // No order cached, but 10 left 1 (orders changed in the web client): the board disagrees, not read.
    expect(run([at(4, before, { deploys: [], moves: [] }), after])).toEqual([]);
  });

  it('reads no held attack from a source an order outside `moves` also left', () => {
    // A percentage order to 1 listed before the attack on 3 took most of 2: only about 9 attacked.
    const before = [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)];
    const after = at(5, [mine(1, 26), mine(2, 6), foe(3, 4), foe(4, 1)]);
    const moves = [{ from: 2, to: 3, armies: 35 }];
    expect(run([at(4, before, { deploys: [], moves, sent: [{ from: 2, to: 1 }, { from: 2, to: 3 }] }), after])).toEqual([]);
    // Orders cached before `sent` existed: unknown, not read.
    expect(run([oldCache(4, before, { deploys: [], moves }), after])).toEqual([]);
    // With the attack the only order out of 2 (1 still at 1, as the board agrees), it trips.
    expect(run([at(4, before, { deploys: [], moves }), at(5, [mine(1, 1), mine(2, 6), foe(3, 4), foe(4, 1)])])).toMatchObject([
      { kind: 'held-attack', territory: 3, observed: 22, allowed: 10 },
    ]);
  });

  it('credits a stack that shrank between two sightings, not only since its latest one (#275 review)', () => {
    // Line 1-6, me on 1, 2 and 6, estimate 5, start unknown. Turn 3: neutral 2 on 3, its 5 on 4 and 50
    // on 5. Turn 4: 3 and 4 hidden, its 1 on 5. Turn 5: 60 on 3. The 49 that left 5 between turns 3 and
    // 4 (two hops, two turns) walked in with the 4 from 4: 10 deployed + 53 walked allow 63.
    const G6 = buildGraph(line(6));
    const boards = [
      at(3, [mine(1, 5), mine(2, 5), neutral(3, 2), foe(4, 5), foe(5, 50), mine(6, 5)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4), foe(5, 1), mine(6, 5)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4), foe(5, 1), mine(6, 5)]),
    ];
    expect(brokenEstimates({ graph: G6, boards, me: ME, settings: STD, estimateAt: () => 5 })).toEqual([]);
    // 100 is beyond every army that could have walked in: it still trips.
    boards[2] = at(5, [mine(1, 5), mine(2, 5), foe(3, 100), fogged(4), foe(5, 1), mine(6, 5)]);
    expect(brokenEstimates({ graph: G6, boards, me: ME, settings: STD, estimateAt: () => 5 })).toEqual([
      { player: FOE, turn: 5, kind: 'fog-stack', territory: 3, observed: 100, allowed: 63, implied: 24 },
    ]);
  });

  it('reads no capture of a territory my Gift card gave it, nor one of mine when my card plays are unknown and Gift may be in play', () => {
    // My 40 on 3 were gifted: its 3 on 4 did not take them.
    const G5 = buildGraph(line(5));
    const before = [mine(1, 5), mine(2, 5), mine(3, 40), foe(4, 3), fogged(5)];
    const after = at(5, [mine(1, 5), mine(2, 5), foe(3, 40), foe(4, 3), fogged(5)]);
    const run5 = (b: TripBoard, gift?: boolean) =>
      brokenEstimates({ graph: G5, boards: [b, after], me: ME, settings: STD, ...(gift ? { gift } : {}), estimateAt: () => 5 });
    const gifted = at(4, before, { deploys: [], moves: [], sent: [], cards: [{ card: 'Gift', target: 3 }] });
    expect(run5(gifted)).toEqual([]);
    expect(run5(gifted, true)).toEqual([]);
    // Card plays not recorded (a cache from before them) in a game that may have Gift: unknown, not read.
    const noCards = at(4, before, { deploys: [], moves: [], sent: [] });
    expect(run5(noCards, true)).toEqual([]);
    // Without Gift in the game, or with my card plays recorded and none a Gift of 3, it trips.
    expect(run5(noCards)).toMatchObject([{ kind: 'capture', territory: 3, observed: 66, allowed: 7 }]);
    expect(run5(at(4, before, { deploys: [], moves: [], sent: [], cards: [] }), true)).toMatchObject([{ kind: 'capture', territory: 3 }]);
  });

  it('bounds no stack by its stock when a turn has no kept estimate: a figure lowered since would under-count it', () => {
    // As the first case: 4 hidden on every board since the sighting on turn 3. Every turn kept, its stock
    // (starts of 10 and four turns of 5) bounds it; a turn not kept (today's figure standing in for it) may
    // under-count what it earned and banked, so the stack is read as with no start: not read.
    const boards = [
      at(3, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)]),
    ];
    const kept = (from: number) => (_p: number, t: number) => t >= from;
    const runKept = (b: TripBoard[], from: number) =>
      brokenEstimates({ graph: G, boards: b, me: ME, settings: STD, start: START, estimateAt: () => 5, estimateKept: kept(from) });
    expect(runKept(boards, 1)).toMatchObject([{ kind: 'fog-stack', allowed: 30 }]);
    expect(runKept(boards, 2)).toEqual([]);
    // A stack no board showed is credited its start and every turn's estimate: not read either.
    const never = [at(2, [mine(1, 5), mine(2, 5), fogged(3), fogged(4)]), at(3, [mine(1, 5), mine(2, 5), foe(3, 60), fogged(4)])];
    expect(runKept(never, 1)).toHaveLength(1);
    expect(runKept(never, 2)).toEqual([]);
  });

  it('reads no held attack whose source lost nothing: the attack never ran (#275 review)', () => {
    // A Diplomacy card in force on turn 4 and worn off by 5, or orders withdrawn in the web client: the
    // board is unchanged, my 40 still on 2. A failed attack on a defender always costs attackers.
    const order = { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }] };
    const still = [at(4, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)], order), at(5, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)])];
    expect(run(still)).toEqual([]);
    // A loss of one army is a fight: it trips.
    still[1] = at(5, [mine(1, 1), mine(2, 39), foe(3, 4), foe(4, 1)]);
    expect(run(still)).toMatchObject([{ kind: 'held-attack', territory: 3, observed: 22 }]);
  });

  it('reads no held attack when a Diplomacy card may have been in force the turn it ran (#275 review)', () => {
    // The cards in effect now do not say what was in force on the turn my attack ran.
    const boards = [
      at(4, [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)], { deploys: [], moves: [{ from: 2, to: 3, armies: 35 }] }),
      at(5, [mine(1, 1), mine(2, 20), foe(3, 4), foe(4, 1)]),
    ];
    const dip = (diplomacy: boolean) =>
      brokenEstimates({ graph: G, boards, me: ME, settings: STD, start: START, ...(diplomacy ? { diplomacy } : {}), estimateAt: () => 5 });
    expect(dip(true)).toEqual([]);
    expect(dip(false)).toMatchObject([{ kind: 'held-attack', territory: 3 }]);
  });

  it('allows the Reinforcement cards an opponent may bank on a stack out of the fog when no stock bounds it (#275 review)', () => {
    // Start unknown, 4 in view throughout: 2 seen on 3, hidden, then 52. Two turns of 15 (5 income and a
    // card of 10) allow 32; four banked cards of 10 played after the sighting make 52 exactly.
    const boards = [
      at(9, [mine(1, 5), mine(2, 5), foe(3, 2), mine(4, 5)]),
      at(10, [mine(1, 5), mine(2, 5), fogged(3), mine(4, 5)]),
      at(11, [mine(1, 5), mine(2, 5), foe(3, 52), mine(4, 5)]),
    ];
    const bank = (b: number | undefined) =>
      brokenEstimates({ graph: G, boards, me: ME, settings: STD, ...(b !== undefined ? { banked: b } : {}), estimateAt: () => 15 });
    expect(bank(undefined)).toMatchObject([{ kind: 'fog-stack', observed: 52, allowed: 32 }]);
    expect(bank(40)).toEqual([]);
    // A bank that cannot be counted: not read.
    expect(bank(Infinity)).toEqual([]);
    // Beyond the bank too, it trips, the bank in what was allowed.
    boards[2] = at(11, [mine(1, 5), mine(2, 5), foe(3, 120), mine(4, 5)]);
    expect(bank(40)).toMatchObject([{ kind: 'fog-stack', observed: 120, allowed: 72 }]);
  });

  it("reads no stack out of the fog on a territory last seen another player's when Gift may be in play (#275 review)", () => {
    // A free-for-all: player 30's 40 on 3, hidden, then 40 of player 20's. Its 3s on 4 and 5 stay in view:
    // no capture of its explains them, but player 30 may have gifted it the territory with its stack.
    const Q = 30;
    const G5 = buildGraph(line(5));
    const boards = [
      at(3, [mine(1, 5), mine(2, 5), mine(3, 40, Q), foe(4, 3), foe(5, 3)]),
      at(4, [mine(1, 5), mine(2, 5), fogged(3), foe(4, 3), foe(5, 3)]),
      at(5, [mine(1, 5), mine(2, 5), foe(3, 40), foe(4, 3), foe(5, 3)]),
    ];
    const ffa = (gift: boolean) => brokenEstimates({ graph: G5, boards, me: ME, settings: STD, ...(gift ? { gift } : {}), estimateAt: () => 5 });
    expect(ffa(true)).toEqual([]);
    // Without Gift: two turns of 5, and the 2 movable on each of 4 and 5 that could have walked in.
    expect(ffa(false)).toMatchObject([{ kind: 'fog-stack', territory: 3, observed: 40, allowed: 14 }]);
  });

  it('with its start unknown, reads no stack that may have walked through a territory hidden on the turn it passed (#275 review)', () => {
    // Line 1-2-3-4-5, me on 1, estimate 5. Turn 1: its 1s on 2, 3 and 4; 5 hidden (a banked 50 there).
    // Turns 2 and 3: 2, 3 and 4 hidden, its 1 on 5. Turn 4: 51 on 2. The 50 walked 5 → 4 → 3 → 2 unseen:
    // 5 was hidden on turn 1, three hops from 2 with three turns to go. Every territory was in view at
    // some time, never on the turn the stack passed it.
    const G5 = buildGraph(line(5));
    const run5 = (boards: TripBoard[]) => brokenEstimates({ graph: G5, boards, me: ME, settings: STD, estimateAt: () => 5 });
    const t1 = at(1, [mine(1, 5), foe(2, 1), foe(3, 1), foe(4, 1), fogged(5)]);
    const hid = (turn: number) => at(turn, [mine(1, 5), fogged(2), fogged(3), fogged(4), foe(5, 1)]);
    const t4 = at(4, [mine(1, 5), foe(2, 51), foe(3, 1), foe(4, 1), foe(5, 1)]);
    expect(run5([t1, hid(2), hid(3), t4])).toEqual([]);
    // A turn missing from the cache hides as much: turn 2 never planned.
    expect(run5([t1, hid(3), t4])).toEqual([]);
    // With 5 in view on turn 1 (its 1) the 50 cannot have come from anywhere: 1 seen + 15 deployed.
    const open = at(1, [mine(1, 5), foe(2, 1), foe(3, 1), foe(4, 1), foe(5, 1)]);
    expect(run5([open, hid(2), hid(3), t4])).toEqual([
      { player: FOE, turn: 4, kind: 'fog-stack', territory: 2, observed: 51, allowed: 16, implied: 17 },
    ]);
  });

  it('with its start unknown, credits a stack that walked in while another took its place: a drop in view is net (#275 review)', () => {
    // Line 1-6, me on 1 and 6, estimate 5, every territory but 2 in view on every board. Turn 3: its 1 on
    // 2 and 3, 51 on 4 and 5. Turn 4 (2 hidden): 51 on 3 and 4, 1 on 5. Turn 5: 51 on 2 and 3, 1 on 4
    // and 5. The 50 from 4 walked 4 → 3 → 2 while the 50 from 5 filled in behind it: no territory within
    // reach dropped when it left. Every army within reach on the sighting counts: 1 + 50 + 10 = 61.
    const G6 = buildGraph(line(6));
    const boards = [
      at(3, [mine(1, 5), foe(2, 1), foe(3, 1), foe(4, 51), foe(5, 51), mine(6, 5)]),
      at(4, [mine(1, 5), fogged(2), foe(3, 51), foe(4, 51), foe(5, 1), mine(6, 5)]),
      at(5, [mine(1, 5), foe(2, 51), foe(3, 51), foe(4, 1), foe(5, 1), mine(6, 5)]),
    ];
    const run6 = (b: TripBoard[]) => brokenEstimates({ graph: G6, boards: b, me: ME, settings: STD, estimateAt: () => 5 });
    expect(run6(boards)).toEqual([]);
    // 100 is beyond every army that could have reached it.
    boards[2] = at(5, [mine(1, 5), foe(2, 100), foe(3, 51), foe(4, 1), foe(5, 1), mine(6, 5)]);
    expect(run6(boards)).toEqual([{ player: FOE, turn: 5, kind: 'fog-stack', territory: 2, observed: 100, allowed: 61, implied: 25 }]);
  });

  it('with Gift in play and a third player, reads no stack out of the fog on a territory not last seen its own (#275 review)', () => {
    // A third player may have taken the territory out of view and gifted it, its stack with it: neither the
    // stock nor any sighting counts that player's armies. Start 2 × 5, estimate 5.
    const G5 = buildGraph(line(5));
    const Q = 30;
    const run5 = (boards: TripBoard[], players?: number[]) =>
      brokenEstimates({ graph: G5, boards, me: ME, settings: STD, start: START, gift: true, ...(players ? { players } : {}), estimateAt: () => 5 });
    // Never seen: 80 on turn 5.
    const never = [at(4, [mine(1, 5), mine(2, 5), fogged(3), fogged(4), fogged(5)]), at(5, [mine(1, 5), mine(2, 5), foe(3, 80), fogged(4), fogged(5)])];
    expect(run5(never)).toEqual([]);
    expect(run5(never, [ME, FOE, Q])).toEqual([]);
    // Last seen neutral on turn 4, hidden on turn 5, 80 of its own on turn 6.
    const neutralSeen = [
      at(4, [mine(1, 5), mine(2, 5), neutral(3, 2), fogged(4), fogged(5)]),
      at(5, [mine(1, 5), mine(2, 5), fogged(3), fogged(4), fogged(5)]),
      at(6, [mine(1, 5), mine(2, 5), foe(3, 80), fogged(4), fogged(5)]),
    ];
    expect(run5(neutralSeen)).toEqual([]);
    expect(run5(neutralSeen, [ME, FOE, Q])).toEqual([]);
    // In a 1v1 no one else could have gifted it: both trip.
    expect(run5(never, [ME, FOE])).toMatchObject([{ kind: 'fog-stack', territory: 3, observed: 80, allowed: 30 }]);
    expect(run5(neutralSeen, [ME, FOE])).toMatchObject([{ kind: 'fog-stack', territory: 3, observed: 80, allowed: 35 }]);
    // Last seen its own, the stock still bounds it with a third player in the game.
    const ownSeen = neutralSeen.map((b, i) => (i === 0 ? at(4, [mine(1, 5), mine(2, 5), foe(3, 2), fogged(4), fogged(5)]) : b));
    expect(run5(ownSeen, [ME, FOE, Q])).toMatchObject([{ kind: 'fog-stack', territory: 3, observed: 80, allowed: 35 }]);
  });

  it('reads no capture of mine when a cached deploy never landed: the board disagrees with my orders (#275 review)', () => {
    // Line 1-5, me on 1 and 2, its 11 on 3. The cached orders deploy 20 on 2, but the orders were changed
    // in the web client: the 20 went to 1. Its 10 take my 5 on 2. Read from the cache, 25 defenders needed
    // 41 against 10 + 5: a false trip implying 31.
    const G5 = buildGraph(line(5));
    const before = [mine(1, 1), mine(2, 5), foe(3, 11), fogged(4), fogged(5)];
    const orders = { deploys: [{ territoryId: 2, armies: 20 }], moves: [] };
    const run5 = (after: TerritoryState[]) =>
      brokenEstimates({ graph: G5, boards: [at(4, before, orders), at(5, after)], me: ME, settings: STD, estimateAt: () => 5 });
    expect(run5([mine(1, 21), foe(2, 4), foe(3, 1), fogged(4), fogged(5)])).toEqual([]);
    // When the board agrees (1 stayed at 1, so the 20 went where the cache says) 25 defenders fell to 10: it trips.
    expect(run5([mine(1, 1), foe(2, 4), foe(3, 1), fogged(4), fogged(5)])).toEqual([
      { player: FOE, turn: 5, kind: 'capture', territory: 2, observed: 41, allowed: 15, implied: 31 },
    ]);
    // With no territory of mine the board can check the orders on, nothing agrees: not read.
    const lone = [neutral(1, 1), mine(2, 5), foe(3, 11), fogged(4), fogged(5)];
    expect(
      brokenEstimates({
        graph: G5,
        boards: [at(4, lone, orders), at(5, [neutral(1, 1), foe(2, 4), foe(3, 1), fogged(4), fogged(5)])],
        me: ME,
        settings: STD,
        estimateAt: () => 5,
      }),
    ).toEqual([]);
  });

  it('reads no held attack when a cached deploy never landed: the same check as a capture (#275 review)', () => {
    // The attack from 2 is real (2 lost armies), but the cache's deploy of 10 on 1 is not on the board.
    const orders = { deploys: [{ territoryId: 1, armies: 10 }], moves: [{ from: 2, to: 3, armies: 35 }] };
    const before = [mine(1, 1), mine(2, 40), foe(3, 5), foe(4, 1)];
    expect(run([at(4, before, orders), at(5, [mine(1, 1), mine(2, 20), foe(3, 4), foe(4, 1)])])).toEqual([]);
    // Landed where the cache says, it trips.
    expect(run([at(4, before, orders), at(5, [mine(1, 11), mine(2, 20), foe(3, 4), foe(4, 1)])])).toMatchObject([
      { kind: 'held-attack', territory: 3, observed: 22 },
    ]);
  });

  it('reads no capture with luck: a lucky roll takes a territory with fewer than the luck-free attackers (#275 review)', () => {
    const capture = [
      at(4, [mine(1, 1), mine(2, 10), foe(3, 3), fogged(4)], { deploys: [], moves: [] }),
      at(5, [mine(1, 1), foe(2, 8), foe(3, 1), fogged(4)]),
    ];
    expect(run(capture)).toMatchObject([{ kind: 'capture' }]);
    expect(run(capture, 5, { ...STD, luckModifier: 0.5 })).toEqual([]);
    expect(run(capture, 5, { ...STD, roundingMode: 'WeightedRandom' })).toEqual([]);
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
