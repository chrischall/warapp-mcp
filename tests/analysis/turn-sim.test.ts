// The turn resolver: one turn of war.app carried out from both sides' orders. Every rule
// tested here is the wiki's (docs/STRATEGY.md "Turn resolution" lists the pages); the two the
// wiki does not state are named as assumptions in the result. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { simulateTurn, type SimEvent, type SimInput, type SimOrder, type SimSettings } from '../../src/analysis/turn-sim.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const A = 10;
const B = 20;
const C = 30;
const STD: SimSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

/** Territories 1..n in a line, plus any extra edges. */
function line(n: number, extra: [number, number][] = []): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const edges: [number, number][] = [...ids.slice(1).map((id): [number, number] => [id - 1, id]), ...extra];
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [],
    distributionModes: [],
  };
}

const own = (id: number, armies: number, player: number): TerritoryState => mine(id, armies, player);

function run(
  n: number,
  entries: TerritoryState[],
  orders: Record<number, SimOrder[]>,
  over: Partial<SimInput> = {},
  extra: [number, number][] = [],
) {
  return simulateTurn({
    graph: buildGraph(line(n, extra)),
    board: board(entries),
    deploys: [],
    orders: Object.entries(orders).map(([player, list]) => ({ player: Number(player), orders: list })),
    moveOrder: [A, B],
    settings: STD,
    ...over,
  });
}

const at = (r: ReturnType<typeof simulateTurn>, id: number) => r.territories.get(id)!;
const brief = (e: SimEvent) => `${e.player}:${e.from}>${e.to} ${e.result}`;

describe('simulateTurn: one battle', () => {
  it('kills 60% of the attackers\' number and loses 70% of the defenders\', rounded to nearest, at once', () => {
    // 10 attack 4: 6 kills take all 4; the 4 defenders kill 3 (2.8), so 7 move in.
    const r = run(2, [own(1, 11, A), own(2, 4, B)], { [A]: [{ from: 1, to: 2, armies: 10 }] });
    expect(at(r, 2)).toMatchObject({ owner: A, armies: 7 });
    expect(at(r, 1)).toMatchObject({ owner: A, armies: 1 });
    expect(r.log[0]).toMatchObject({ kind: 'attack', result: 'captured', sent: 10, defendersKilled: 4, attackersKilled: 3, survivors: 7 });
    expect(r.exact).toBe(true);
  });

  it('leaves the survivors of a failed attack where they started', () => {
    // 10 attack 10: 6 defenders die, 7 attackers die, 3 stay on the source beside the guard.
    const r = run(2, [own(1, 11, A), own(2, 10, B)], { [A]: [{ from: 1, to: 2, armies: 10 }] });
    expect(at(r, 2)).toMatchObject({ owner: B, armies: 4 });
    expect(at(r, 1)).toMatchObject({ owner: A, armies: 4 });
    expect(r.log[0]).toMatchObject({ result: 'failed', defendersKilled: 6, attackersKilled: 7, survivors: 3 });
  });

  it('fails when both sides are wiped out, and one defender stands again', () => {
    // 1 attacks 1: each kills the other (0.6 and 0.7 both round to 1).
    const r = run(2, [own(1, 2, A), own(2, 1, B)], { [A]: [{ from: 1, to: 2, armies: 1 }] });
    expect(at(r, 2)).toMatchObject({ owner: B, armies: 1 });
    expect(at(r, 1)).toMatchObject({ owner: A, armies: 1 });
    expect(r.log[0]).toMatchObject({ result: 'failed', survivors: 0 });
  });

  it('takes a 2 with 3 and a 1 with 2 (the smallest sure captures at 60/70)', () => {
    const two = run(2, [own(1, 4, A), neutral(2, 2)], { [A]: [{ from: 1, to: 2, armies: 3 }] });
    expect(at(two, 2)).toMatchObject({ owner: A, armies: 2 });
    const one = run(2, [own(1, 3, A), neutral(2, 1)], { [A]: [{ from: 1, to: 2, armies: 2 }] });
    expect(at(one, 2)).toMatchObject({ owner: A, armies: 1 });
    // …and 2 against 2 kills only one.
    const short = run(2, [own(1, 3, A), neutral(2, 2)], { [A]: [{ from: 1, to: 2, armies: 2 }] });
    expect(at(short, 2)).toMatchObject({ owner: 'neutral', armies: 1 });
  });

  it("uses the game's own kill rates", () => {
    const r = run(2, [own(1, 21, A), own(2, 4, B)], { [A]: [{ from: 1, to: 2, armies: 20 }] }, {
      settings: { offensiveKillRate: 20, defensiveKillRate: 80, oneArmyStandsGuard: true },
    });
    // 20 at 20% kill 4; the 4 defenders at 80% kill 3 (3.2).
    expect(at(r, 2)).toMatchObject({ owner: A, armies: 17 });
  });

  it('is not exact with luck or weighted rounding, and says so', () => {
    const luck = run(2, [own(1, 11, A), own(2, 4, B)], { [A]: [{ from: 1, to: 2, armies: 10 }] }, {
      settings: { ...STD, luckModifier: 16 },
    });
    expect(luck.exact).toBe(false);
    const weighted = run(2, [own(1, 11, A), own(2, 4, B)], { [A]: [{ from: 1, to: 2, armies: 10 }] }, {
      settings: { ...STD, roundingMode: 'WeightedRandom' },
    });
    expect(weighted.exact).toBe(false);
  });
});

describe('simulateTurn: what an order may send', () => {
  it('keeps one army on guard, unless the game turns that off', () => {
    const guarded = run(2, [own(1, 5, A), own(2, 1, A)], { [A]: [{ from: 1, to: 2, armies: 5 }] });
    expect(at(guarded, 1).armies).toBe(1);
    expect(at(guarded, 2).armies).toBe(5);
    const free = run(2, [own(1, 5, A), own(2, 1, A)], { [A]: [{ from: 1, to: 2, armies: 5 }] }, {
      settings: { ...STD, oneArmyStandsGuard: false },
    });
    expect(at(free, 1).armies).toBe(0);
    expect(at(free, 2).armies).toBe(6);
  });

  it('deploys before any order runs, and deployed armies may move the same turn', () => {
    const r = run(2, [own(1, 1, A), neutral(2, 2)], { [A]: [{ from: 1, to: 2, armies: 3 }] }, {
      deploys: [{ player: A, territoryId: 1, armies: 3 }],
    });
    expect(at(r, 2)).toMatchObject({ owner: A, armies: 2 });
    expect(at(r, 1).armies).toBe(1);
  });

  it('sends what is left when fewer armies remain than were ordered (an assumption, named)', () => {
    // B strikes first and kills some of the stack A meant to send.
    const r = run(
      3,
      [own(1, 1, A), own(2, 10, A), own(3, 10, B)],
      { [A]: [{ from: 2, to: 1, armies: 9 }], [B]: [{ from: 3, to: 2, armies: 9 }] },
      { moveOrder: [B, A] },
    );
    // 9 attack 10: 5 defenders die (5.4), 7 attackers die; A then transfers the 4 it can still move.
    expect(at(r, 2).armies).toBe(1);
    expect(at(r, 1).armies).toBe(5);
    expect(r.log[1]).toMatchObject({ player: A, ordered: 9, sent: 4, result: 'transferred' });
    expect(r.assumptions.some((s) => /fewer/.test(s))).toBe(true);
  });

  it('skips an order whose source was captured first', () => {
    const r = run(
      3,
      [own(1, 1, A), own(2, 3, A), own(3, 20, B)],
      { [A]: [{ from: 2, to: 1, armies: 2 }], [B]: [{ from: 3, to: 2, armies: 19 }] },
      { moveOrder: [B, A] },
    );
    expect(at(r, 2).owner).toBe(B);
    expect(r.log.find((e) => e.player === A)).toMatchObject({ result: 'skipped', reason: 'source-lost', sent: 0 });
    expect(at(r, 1).armies).toBe(1);
    expect(r.assumptions.some((x) => /captured first/.test(x))).toBe(true);
  });

  it('lets each army move once: arrivals stay, the armies already there may still leave', () => {
    // 5 arrive on territory 2; the order out of 2 may send the 4 that started there, and no more:
    // one of the arrivals is the army that stands guard.
    const r = run(3, [own(1, 6, A), own(2, 4, A), own(3, 1, A)], {
      [A]: [
        { from: 1, to: 2, armies: 5 },
        { from: 2, to: 3, armies: 8 },
      ],
    });
    expect(at(r, 2).armies).toBe(5);
    expect(at(r, 3).armies).toBe(5);
    expect(r.log[1]).toMatchObject({ ordered: 8, sent: 4 });
  });

  it('the survivors of a failed attack have used their move, except under Multi-Attack', () => {
    // 10 attack 10 and 3 come back; a second order from there can send only what never left.
    const orders = {
      [A]: [
        { from: 1, to: 2, armies: 10 },
        { from: 1, to: 3, armies: 5 },
      ],
    };
    const entries = [own(1, 12, A), own(2, 10, B), neutral(3, 1)];
    const normal = run(3, entries, orders, {}, [[1, 3]]);
    // 12 − 10 sent + 3 back = 5 there, 3 of them spent: the other 2 may go (a survivor stands guard).
    expect(normal.log[1]).toMatchObject({ sent: 2 });
    const multi = run(3, entries, orders, { settings: { ...STD, multiAttack: true } }, [[1, 3]]);
    expect(multi.log[1]).toMatchObject({ sent: 4, result: 'captured' });
  });

  it('under Multi-Attack armies that transferred are done for the turn', () => {
    const r = run(3, [own(1, 6, A), own(2, 1, A), neutral(3, 1)], {
      [A]: [
        { from: 1, to: 2, armies: 5 },
        { from: 2, to: 3, armies: 5 },
      ],
    }, { settings: { ...STD, multiAttack: true } });
    // Only the army that started on 2 may go on; the five that arrived stay (one of them as the guard).
    expect(r.log[1]).toMatchObject({ ordered: 5, sent: 1 });
    expect(at(r, 2).armies).toBe(5);
  });

  it('does not let the survivors of a capture attack again, except under Multi-Attack', () => {
    const orders = {
      [A]: [
        { from: 1, to: 2, armies: 10 },
        { from: 2, to: 3, armies: 5 },
      ],
    };
    const normal = run(3, [own(1, 11, A), neutral(2, 2), neutral(3, 2)], orders);
    expect(at(normal, 2)).toMatchObject({ owner: A, armies: 9 });
    expect(at(normal, 3).owner).toBe('neutral');
    expect(normal.log[1]).toMatchObject({ result: 'skipped', reason: 'no-armies' });
    const multi = run(3, [own(1, 11, A), neutral(2, 2), neutral(3, 2)], orders, { settings: { ...STD, multiAttack: true } });
    expect(at(multi, 3)).toMatchObject({ owner: A, armies: 4 });
    expect(at(multi, 2).armies).toBe(4);
  });

  it('refuses a move between territories that do not touch', () => {
    const r = run(3, [own(1, 5, A), neutral(2, 2), neutral(3, 2)], { [A]: [{ from: 1, to: 3, armies: 4 }] });
    expect(r.log[0]).toMatchObject({ result: 'skipped', reason: 'not-adjacent' });
    expect(at(r, 1).armies).toBe(5);
  });
});

describe('simulateTurn: attack or transfer is decided when the order runs', () => {
  it('turns an attack on a territory I took earlier this turn into a transfer', () => {
    // Territory 2 touches 1 and 3: both stacks are ordered onto it.
    const r = run(3, [own(1, 4, A), neutral(2, 2), own(3, 6, A)], {
      [A]: [
        { from: 1, to: 2, armies: 3 },
        { from: 3, to: 2, armies: 5 },
      ],
    });
    expect(at(r, 2)).toMatchObject({ owner: A, armies: 7 });
    expect(r.log[1]).toMatchObject({ kind: 'transfer', result: 'transferred' });
  });

  it('turns a transfer into an attack when the enemy took the territory first', () => {
    const r = run(
      3,
      [own(1, 8, A), own(2, 1, A), own(3, 5, B)],
      { [A]: [{ from: 1, to: 2, armies: 7 }], [B]: [{ from: 3, to: 2, armies: 4 }] },
      { moveOrder: [B, A] },
    );
    // B takes 2 with 4 (2 kills against the 1 there, losing 1): 3 hold it. A's 7 then attack them.
    expect(r.log.map(brief)).toEqual([`${B}:3>2 captured`, `${A}:1>2 captured`]);
    expect(at(r, 2)).toMatchObject({ owner: A, armies: 5 });
  });

  it('does nothing for an attack-only order on my own territory or a transfer-only order on an enemy', () => {
    const r = run(3, [own(1, 5, A), own(2, 2, A), own(3, 2, B)], {
      [A]: [
        { from: 1, to: 2, armies: 4, mode: 'attack-only' },
        { from: 2, to: 3, armies: 1, mode: 'transfer-only' },
      ],
    });
    expect(r.log.map((e) => [e.result, e.reason])).toEqual([
      ['skipped', 'attack-only'],
      ['skipped', 'transfer-only'],
    ]);
    expect(at(r, 1).armies).toBe(5);
  });

  it('a percentage order sends that share of what can still move, worked out when it runs (#165)', () => {
    // 11 armies, guard 1: 10 can move. 50% → 5; then 33% of the 5 left → 1.65, rounded to 2.
    const r = run(3, [own(1, 11, A), own(2, 1, A), neutral(3, 0)], {
      [A]: [
        { from: 1, to: 2, armies: 50, byPercent: true },
        { from: 1, to: 2, armies: 33, byPercent: true },
      ],
    });
    expect(r.log.map((e) => e.sent)).toEqual([5, 2]);
    expect(at(r, 1).armies).toBe(4);
    // 100% is everything movable; a half rounds down (the client's rounding, from the bundle).
    const all = run(2, [own(1, 6, A), own(2, 1, A)], { [A]: [{ from: 1, to: 2, armies: 100, byPercent: true }] });
    expect(all.log[0]!.sent).toBe(5);
    const half = run(2, [own(1, 6, A), own(2, 1, A)], { [A]: [{ from: 1, to: 2, armies: 50, byPercent: true }] });
    expect(half.log[0]!.sent).toBe(2);
  });

  it("attack teammates: an order flagged so attacks a teammate's territory instead of transferring (#165)", () => {
    const r = run(2, [own(1, 10, A), own(2, 1, C)], { [A]: [{ from: 1, to: 2, armies: 9, attackTeammates: true }] }, {
      moveOrder: [A, B, C],
      teams: new Map([
        [A, 1],
        [C, 1],
        [B, 2],
      ]),
    });
    expect(r.log[0]).toMatchObject({ kind: 'attack', result: 'captured' });
    expect(at(r, 2).owner).toBe(A);
  });

  it("treats a teammate's territory as my own", () => {
    const r = run(2, [own(1, 5, A), own(2, 1, C)], { [A]: [{ from: 1, to: 2, armies: 4 }] }, {
      moveOrder: [A, B, C],
      teams: new Map([
        [A, 1],
        [C, 1],
        [B, 2],
      ]),
    });
    expect(at(r, 2)).toMatchObject({ owner: C, armies: 5 });
    expect(r.log[0]).toMatchObject({ kind: 'transfer' });
  });
});

describe('simulateTurn: the order of orders', () => {
  it('zigzags between two players: A1, B1, B2, A2, A3, B3', () => {
    // Six separate one-army transfers on a ring of own territories; only the order matters.
    const entries = [own(1, 3, A), own(2, 1, A), own(3, 3, A), own(4, 1, A), own(5, 3, A), own(6, 1, A), own(7, 3, B), own(8, 1, B), own(9, 3, B), own(10, 1, B), own(11, 3, B), own(12, 1, B)];
    const r = run(12, entries, {
      [A]: [
        { from: 1, to: 2, armies: 1 },
        { from: 3, to: 4, armies: 1 },
        { from: 5, to: 6, armies: 1 },
      ],
      [B]: [
        { from: 7, to: 8, armies: 1 },
        { from: 9, to: 10, armies: 1 },
        { from: 11, to: 12, armies: 1 },
      ],
    });
    expect(r.log.map((e) => `${e.player === A ? 'A' : 'B'}${e.index + 1}`)).toEqual(['A1', 'B1', 'B2', 'A2', 'A3', 'B3']);
  });

  it('zigzags among three players: 1 2 3, 3 2 1, 1 2 3', () => {
    const entries = [own(1, 4, A), own(2, 1, A), own(3, 4, B), own(4, 1, B), own(5, 4, C), own(6, 1, C)];
    const three = (from: number): SimOrder[] => [1, 2, 3].map(() => ({ from, to: from + 1, armies: 1 }));
    const r = run(6, entries, { [A]: three(1), [B]: three(3), [C]: three(5) }, { moveOrder: [A, B, C] });
    expect(r.log.map((e) => e.player)).toEqual([A, B, C, C, B, A, A, B, C]);
  });

  it('gives no turn in the zigzag to an order that moves no armies', () => {
    // A's first order can send nothing, so its second runs in A's first slot, ahead of B's attack.
    const r = run(
      4,
      [own(1, 1, A), own(2, 4, A), own(3, 1, A), own(4, 6, B)],
      {
        [A]: [
          { from: 1, to: 2, armies: 1 },
          { from: 2, to: 3, armies: 3 },
        ],
        [B]: [{ from: 4, to: 3, armies: 5 }],
      },
    );
    expect(r.log.filter((e) => e.sent > 0).map(brief)).toEqual([`${A}:2>3 transferred`, `${B}:4>3 failed`]);
    expect(at(r, 3)).toMatchObject({ owner: A, armies: 1 });
  });

  it('the same orders end differently when the other player moves first', () => {
    const entries = [own(1, 1, A), own(2, 4, A), own(3, 1, A), own(4, 6, B)];
    const orders = { [A]: [{ from: 2, to: 3, armies: 3 }], [B]: [{ from: 4, to: 3, armies: 5 }] };
    expect(at(run(4, entries, orders, { moveOrder: [A, B] }), 3).owner).toBe(A);
    expect(at(run(4, entries, orders, { moveOrder: [B, A] }), 3).owner).toBe(B);
  });

  it('Order Priority makes its player the first mover for the turn: one order ahead, then the usual zigzag', () => {
    const entries = [own(1, 1, A), own(2, 4, A), own(3, 1, A), own(4, 6, B)];
    const orders = { [A]: [{ from: 2, to: 3, armies: 3 }], [B]: [{ from: 4, to: 3, armies: 5 }] };
    const r = run(4, entries, orders, { moveOrder: [B, A], orderPriority: [A] });
    expect(r.log.map((e) => e.player)).toEqual([A, B]);
    expect(at(r, 3).owner).toBe(A);
    // Three orders each: with the card the second mover runs as if drawn first, and gains nothing more.
    const six = [own(1, 3, A), own(2, 1, A), own(3, 3, A), own(4, 1, A), own(5, 3, A), own(6, 1, A), own(7, 3, B), own(8, 1, B), own(9, 3, B), own(10, 1, B), own(11, 3, B), own(12, 1, B)];
    const three = (first: number): SimOrder[] => [0, 2, 4].map((k) => ({ from: first + k, to: first + k + 1, armies: 1 }));
    const seq = (over: Partial<SimInput>) =>
      run(12, six, { [A]: three(1), [B]: three(7) }, over).log.map((e) => `${e.player === A ? 'A' : 'B'}${e.index + 1}`);
    expect(seq({ moveOrder: [B, A], orderPriority: [A] })).toEqual(['A1', 'B1', 'B2', 'A2', 'A3', 'B3']);
    // Already first: the card changes nothing.
    expect(seq({ moveOrder: [A, B], orderPriority: [A] })).toEqual(['A1', 'B1', 'B2', 'A2', 'A3', 'B3']);
    // Both play one: they cancel, and the turn's own order stands.
    expect(seq({ moveOrder: [B, A], orderPriority: [A, B] })).toEqual(['B1', 'A1', 'A2', 'B2', 'B3', 'A3']);
  });
});

describe('simulateTurn: commanders', () => {
  const withCommander = (t: TerritoryState, playerId: number): TerritoryState => ({
    ...t,
    specialUnits: [{ kind: 'commander', id: 'c', playerId }],
  });

  it('a commander defends as 7 armies and dies only to 7 damage left over in one battle', () => {
    // 3 armies and a commander fight as 10: they kill 7. 15 attackers kill 9: the 3 armies and 6 damage — not enough.
    const short = run(2, [own(1, 16, A), withCommander(own(2, 3, B), B)], { [A]: [{ from: 1, to: 2, armies: 15 }] });
    expect(at(short, 2)).toMatchObject({ owner: B, armies: 0, commander: B });
    expect(short.log[0]).toMatchObject({ result: 'failed', attackersKilled: 7, survivors: 8 });
    expect(short.eliminated).toEqual([]);
  });

  it('killing a commander eliminates its owner: everything it holds turns neutral', () => {
    const r = run(3, [own(1, 17, A), withCommander(own(2, 3, B), B), own(3, 9, B)], { [A]: [{ from: 1, to: 2, armies: 16 }] });
    expect(r.log[0]).toMatchObject({ result: 'captured', survivors: 9 });
    expect(at(r, 2)).toMatchObject({ owner: A, armies: 9 });
    expect(at(r, 2).commander).toBeUndefined();
    expect(r.eliminated).toEqual([B]);
    expect(at(r, 3)).toMatchObject({ owner: 'neutral', armies: 9 });
  });

  it('a commander stays behind unless the order takes it along, and is not the army that stands guard', () => {
    const stay = run(2, [withCommander(own(1, 5, A), A), neutral(2, 2)], { [A]: [{ from: 1, to: 2, armies: 5 }] });
    expect(at(stay, 1)).toMatchObject({ commander: A, armies: 1 });
    expect(stay.log[0]).toMatchObject({ ordered: 5, sent: 4 });
    expect(at(stay, 2)).toMatchObject({ owner: A, armies: 3 });
    // Taken along it fights as 7 more: 1 army and the commander take a 4 (8 × 0.6 = 4.8 → 5 kills).
    const go = run(2, [withCommander(own(1, 2, A), A), neutral(2, 4)], { [A]: [{ from: 1, to: 2, armies: 1, withCommander: true }] });
    expect(go.log[0]).toMatchObject({ result: 'captured' });
    expect(at(go, 2)).toMatchObject({ owner: A, armies: 0, commander: A });
    expect(at(go, 1).commander).toBeUndefined();
  });
});

describe('simulateTurn: commanders, the rarer cases', () => {
  const withCommander = (t: TerritoryState, playerId: number): TerritoryState => ({
    ...t,
    specialUnits: [{ kind: 'commander', id: 'c', playerId }],
  });

  it('an attacking commander dies to 7 damage beyond its escort, and its owner is out', () => {
    // 1 army and the commander attack 12: the defenders deal 8 (8.4), the army absorbs 1, the commander takes 7.
    const r = run(3, [withCommander(own(1, 2, A), A), own(2, 12, B), own(3, 4, A)], {
      [A]: [{ from: 1, to: 2, armies: 1, withCommander: true }],
    });
    expect(r.log[0]).toMatchObject({ result: 'failed' });
    expect(r.eliminated).toEqual([A]);
    expect(at(r, 3)).toMatchObject({ owner: 'neutral', armies: 4 });
    expect(at(r, 1).commander).toBeUndefined();
  });

  it('the orders of a player whose commander dies stop there', () => {
    // A kills B's commander with its first order; B's own orders, later in the turn, never run.
    const r = run(4, [own(1, 17, A), withCommander(own(2, 3, B), B), own(3, 9, B), own(4, 1, A)], {
      [A]: [{ from: 1, to: 2, armies: 16 }],
      [B]: [{ from: 3, to: 4, armies: 8 }],
    });
    expect(r.eliminated).toEqual([B]);
    expect(r.log.filter((e) => e.player === B)).toEqual([]);
    expect(at(r, 4)).toMatchObject({ owner: A, armies: 1 });
  });

  it('a commander is never carried onto a teammate\'s territory: the armies go, it stays', () => {
    const r = run(2, [withCommander(own(1, 5, A), A), withCommander(own(2, 1, C), C)], { [A]: [{ from: 1, to: 2, armies: 3, withCommander: true }] }, {
      moveOrder: [A, C],
      teams: new Map([
        [A, 1],
        [C, 1],
      ]),
    });
    expect(at(r, 1)).toMatchObject({ commander: A, armies: 2 });
    expect(at(r, 2)).toMatchObject({ owner: C, commander: C, armies: 4 });
  });
});

describe('simulateTurn: what cannot be seen', () => {
  it('sends the armies off into a fogged territory and reports the outcome as unknown', () => {
    const r = run(2, [own(1, 6, A), fogged(2)], { [A]: [{ from: 1, to: 2, armies: 5 }] });
    expect(r.log[0]).toMatchObject({ result: 'unknown', sent: 5 });
    expect(at(r, 1).armies).toBe(1);
    expect(at(r, 2).owner).toBe('unknown');
  });

  it('a territory whose owner shows but whose armies do not is unknown too: never a stack of none', () => {
    const ownerOnly: TerritoryState = { territoryId: 2, owner: { kind: 'player', playerId: B }, armies: null, fogLevel: 'OwnerOnly' };
    const r = run(2, [own(1, 6, A), ownerOnly], { [A]: [{ from: 1, to: 2, armies: 1 }], [B]: [{ from: 2, to: 1, armies: 50 }] });
    expect(at(r, 2)).toMatchObject({ owner: 'unknown', armies: 0 });
    expect(r.log.find((e) => e.player === A)).toMatchObject({ result: 'unknown' });
    // Its owner's order from it cannot be resolved either.
    expect(r.log.find((e) => e.player === B)).toMatchObject({ result: 'skipped', reason: 'source-lost' });
  });

  it('ignores an order with no usable army count, and battles nothing at a zero kill rate', () => {
    const r = run(2, [own(1, 6, A), own(2, 2, B)], { [A]: [{ from: 1, to: 2, armies: Number.NaN }] });
    expect(r.log[0]).toMatchObject({ result: 'skipped', reason: 'no-armies', sent: 0 });
    expect(at(r, 1).armies).toBe(6);
  });

  it('names the unstated rule when both sides are wiped out with the guard off', () => {
    const r = run(2, [own(1, 1, A), own(2, 1, B)], { [A]: [{ from: 1, to: 2, armies: 1 }] }, { settings: { ...STD, oneArmyStandsGuard: false } });
    expect(at(r, 2)).toMatchObject({ owner: B, armies: 1 });
    expect(r.assumptions.some((x) => /wiped out/.test(x))).toBe(true);
  });

  it('never changes the board it was given', () => {
    const b = board([own(1, 11, A), own(2, 4, B)]);
    const before = JSON.stringify(b);
    simulateTurn({
      graph: buildGraph(line(2)),
      board: b,
      deploys: [{ player: A, territoryId: 1, armies: 2 }],
      orders: [{ player: A, orders: [{ from: 1, to: 2, armies: 10 }] }],
      moveOrder: [A, B],
      settings: STD,
    });
    expect(JSON.stringify(b)).toBe(before);
  });
});
