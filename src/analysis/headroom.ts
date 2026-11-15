// The headroom table (#275 a): for every border of mine, the smallest single deploy by a neighbouring
// opponent that takes it after my orders, and what falls with it. Pure and deterministic; ties resolve
// on ascending ids.
//
// The play session worked this out by hand every turn, and it was the most useful number it had: a
// hold sized for an estimate is only as good as the estimate, and the estimate is a floor (#275,
// pattern 1). Headroom says how wrong the estimate may be before a border goes.
//
// A border is a territory I hold after my orders, unanswered (captures included), beside a territory
// of an opponent whose armies are in view. For each such stack the opponent deploys d on it and attacks
// the border with everything the stack can move (its commander too), on the turn simulator
// (turn-sim.ts) with my deploys and orders, under both move orders unless the first mover is known, and
// at every place in the zigzag it can reach: it may hold the attack back behind filler orders (assumed
// to have them), so it lands before my first order, between two, or after my last — a border my later
// orders drain is met drained. Places where the same number of my orders touching the border or the
// stack has run are alike, and only one of each is tried.
// The border's headroom is the smallest d that leaves the opponent holding it at the end of the turn,
// over every stack beside it and both orders; 0 when a stack already takes it with no deploy. One
// opponent and one attack: two stacks together, several opponents, chains, cards and Local Deployment's
// bound on where the deploy lands are not tried (warapp_check_plan's stress test tries several).
//
// What falls with it: the bonuses I hold after my orders that it is in, and `behind` — my territories
// beside it that face no enemy, one step behind it — with `behindIncome`, the bonuses they complete
// that the border's own fall does not already break.

import type { BoardState } from '../board.js';
import { bonusTerritories } from './bonuses.js';
import { armiesToTake, COMMANDER_STRENGTH } from './combat.js';
import type { MapGraph } from './graph.js';
import { neighborsOf } from './graph.js';
import { simTerritories, simulateTurn, type SimOrder, type SimResult, type SimSettings, type SimTerritory } from './turn-sim.js';

export interface HeadroomInput {
  graph: MapGraph;
  board: BoardState;
  me: number;
  deploys: readonly { territoryId: number; armies: number }[];
  /** My attacks and transfers, in the order they will be submitted. */
  moves: readonly SimOrder[];
  settings?: SimSettings;
  teams?: ReadonlyMap<number, number>;
  /** Who moves first this turn, when known; otherwise both orders are tried. */
  firstMover?: 'me' | 'opponent';
  /** I play an Order Priority card this turn. */
  orderPriority?: boolean;
}

export interface HeadroomRow {
  territory: number;
  /** Armies on it after my orders, unanswered. */
  armies: number;
  /** The opponent and its stack that need the smallest deploy. */
  opponent: number;
  from: number;
  /** The smallest single deploy on `from` that takes it; `null` when none up to {@link HEADROOM_CAP} does. */
  deploy: number | null;
  /** Only when the first mover is unknown and the smallest deploy needs one order: who moves first then. */
  firstMover?: 'me' | 'opponent';
  /** My bonuses (held after my orders) it breaks, ascending by id. */
  bonuses: { id: number; value: number }[];
  /** My territories beside it that face no enemy (one step behind it), ascending. */
  behind: number[];
  /** The positive bonuses those complete that its own fall does not already break. */
  behindIncome: number;
}

/** The largest deploy searched; a border no deploy up to it takes has `deploy: null`. */
export const HEADROOM_CAP = 100_000;

const byNum = (a: number, b: number) => a - b;

export function headroomTable(input: HeadroomInput): HeadroomRow[] {
  const { graph, board, me } = input;
  const teams = input.teams;
  const start = simTerritories(board);
  const sameTeam = (a: number, b: number) => teams !== undefined && teams.get(a) !== undefined && teams.get(a) === teams.get(b);
  const enemy = (owner: SimTerritory['owner'] | undefined): owner is number => typeof owner === 'number' && owner !== me && !sameTeam(owner, me);
  const myDeploys = input.deploys.map((d) => ({ player: me, territoryId: d.territoryId, armies: d.armies }));
  const myOrders = input.moves.map((m) => ({ ...m }));
  const rates = { offensiveKillRate: input.settings?.offensiveKillRate, defensiveKillRate: input.settings?.defensiveKillRate };
  const guard = input.settings?.oneArmyStandsGuard === false ? 0 : 1;

  // The opponent may hold its attack back behind filler orders (any transfer of its own), so it can land
  // after any number of my orders: before my first, between two, or after my last. The fillers run between
  // two territories of its own outside the map (ids past the map's), which touch nothing on the board.
  const maxId = Math.max(0, ...graph.territoryById.keys(), ...start.keys());
  const FILL_A = maxId + 1;
  const FILL_B = maxId + 2;
  const fillGraph: MapGraph = {
    ...graph,
    neighbors: new Map([...graph.neighbors, [FILL_A, [FILL_B]], [FILL_B, [FILL_A]]]),
  };
  const fillStart = (player: number) =>
    new Map([...start, [FILL_A, { owner: player, armies: myOrders.length + 2 + guard }], [FILL_B, { owner: player, armies: guard }]]);

  const run = (
    attack: { player: number; from: number; to: number; deploy: number; fillers: number } | undefined,
    first: 'me' | 'opponent',
  ): SimResult =>
    simulateTurn({
      graph: attack?.fillers ? fillGraph : graph,
      board,
      ...(attack?.fillers ? { start: fillStart(attack.player) } : {}),
      deploys: [...myDeploys, ...(attack && attack.deploy > 0 ? [{ player: attack.player, territoryId: attack.from, armies: attack.deploy }] : [])],
      orders: [
        { player: me, orders: myOrders },
        ...(attack
          ? [
              {
                player: attack.player,
                orders: [
                  ...Array.from({ length: attack.fillers }, () => ({ from: FILL_A, to: FILL_B, armies: 1 })),
                  {
                    from: attack.from,
                    to: attack.to,
                    armies: (start.get(attack.from)?.armies ?? 0) + attack.deploy,
                    ...(start.get(attack.from)?.commander === attack.player ? { withCommander: true } : {}),
                  },
                ],
              },
            ]
          : []),
      ],
      moveOrder: attack ? (first === 'me' ? [me, attack.player] : [attack.player, me]) : [me],
      ...(input.settings ? { settings: input.settings } : {}),
      ...(teams ? { teams } : {}),
      ...(input.orderPriority ? { orderPriority: [me] } : {}),
    });

  /**
   * The filler counts worth trying for an attack from `s` on `b`: the attack, as the opponent's order
   * `k` (0-based), runs after `mineBefore(k)` of my orders (zigzag, every order taking its slot). Two
   * counts are alike when the same number of my orders touching `b` or `s` (from or to) ran before the
   * attack: the attack meets the same armies and the same later orders. One count per kind, fewest first.
   */
  const fillerCounts = (b: number, s: number, first: 'me' | 'opponent'): number[] => {
    const n = myOrders.length;
    const meFirst = input.orderPriority === true || first === 'me';
    const mineBefore = (k: number): number => {
      let mine = 0;
      let theirs = 0;
      for (let round = 0; ; round++) {
        const row = (round % 2 === 0) === meFirst ? ['me', 'them'] : ['them', 'me'];
        for (const who of row) {
          if (who === 'me') mine = Math.min(n, mine + 1);
          else if (theirs++ === k) return mine;
        }
      }
    };
    const touches = myOrders.map((o) => o.from === b || o.to === b || o.from === s || o.to === s);
    const seen = new Set<number>();
    const out: number[] = [];
    for (let k = 0; k <= n; k++) {
      const m = mineBefore(k);
      const kind = touches.slice(0, m).filter(Boolean).length;
      if (seen.has(kind)) continue;
      seen.add(kind);
      out.push(k);
    }
    return out;
  };

  const baseline = run(undefined, 'me');
  const mineAfter = new Set([...baseline.territories].filter(([, t]) => t.owner === me).map(([id]) => id));
  const bonusIds = [...graph.bonusById.keys()].sort(byNum);
  const held = bonusIds.filter((id) => {
    const ts = bonusTerritories(graph, id);
    return ts.length > 0 && ts.every((t) => mineAfter.has(t));
  });
  const value = (id: number) => graph.bonusById.get(id)?.value ?? 0;
  /** A territory of mine beside an enemy stack (its owner shown, armies in view). */
  const facesEnemy = (id: number) => neighborsOf(graph, id).some((n) => enemy(start.get(n)?.owner));

  const rows: HeadroomRow[] = [];
  for (const b of [...mineAfter].sort(byNum)) {
    const stacks = neighborsOf(graph, b)
      .filter((n) => enemy(start.get(n)?.owner))
      .sort(byNum);
    if (!stacks.length) continue;
    const there = baseline.territories.get(b)!;
    let best: { opponent: number; from: number; deploy: number | null; firstMover?: 'me' | 'opponent' } | undefined;
    const orders: ('me' | 'opponent')[] = input.firstMover ? [input.firstMover] : ['me', 'opponent'];
    for (const s of stacks) {
      const player = start.get(s)!.owner as number;
      const takes = (d: number, first: 'me' | 'opponent', fills: readonly number[]) =>
        fills.some((fillers) => run({ player, from: s, to: b, deploy: d, fillers }, first).territories.get(b)?.owner === player);
      const found = orders.map((first) => {
        // A guess from the board after my orders: what takes it, less what the stack sends.
        const defenders = there.armies + (there.commander === me ? COMMANDER_STRENGTH : 0);
        const sends = Math.max(0, (start.get(s)?.armies ?? 0) - guard) + (start.get(s)?.commander === player ? COMMANDER_STRENGTH : 0);
        const guess = Math.max(0, (armiesToTake(defenders, rates) ?? HEADROOM_CAP) - sends);
        const fills = fillerCounts(b, s, first);
        return { first, deploy: smallest((d) => takes(d, first, fills), Math.min(guess, HEADROOM_CAP)) };
      });
      const min = found.reduce<number | null>((m, f) => (f.deploy === null ? m : m === null ? f.deploy : Math.min(m, f.deploy)), null);
      const firstMover =
        orders.length > 1 && min !== null && found.filter((f) => f.deploy === min).length === 1 ? found.find((f) => f.deploy === min)!.first : undefined;
      if (!best || (min !== null && (best.deploy === null || min < best.deploy)))
        best = { opponent: player, from: s, deploy: min, ...(firstMover ? { firstMover } : {}) };
    }
    const bonuses = held.filter((id) => bonusTerritories(graph, id).includes(b));
    const behind = neighborsOf(graph, b)
      .filter((n) => mineAfter.has(n) && !facesEnemy(n))
      .sort(byNum);
    const behindIncome = held
      .filter((id) => !bonuses.includes(id) && bonusTerritories(graph, id).some((t) => behind.includes(t)))
      .reduce((n, id) => n + Math.max(0, value(id)), 0);
    rows.push({
      territory: b,
      armies: there.armies,
      opponent: best!.opponent,
      from: best!.from,
      deploy: best!.deploy,
      ...(best!.firstMover ? { firstMover: best!.firstMover } : {}),
      bonuses: bonuses.map((id) => ({ id, value: value(id) })),
      behind,
      behindIncome,
    });
  }
  return rows.sort((a, b) => (a.deploy ?? Infinity) - (b.deploy ?? Infinity) || a.territory - b.territory);
}

/**
 * The smallest d in [0, HEADROOM_CAP] with `ok(d)`, `ok` taken to be monotone (more armies never take
 * less), starting from `guess`; `null` when even the cap fails.
 */
export function smallest(ok: (d: number) => boolean, guess: number): number | null {
  let lo: number;
  let hi: number;
  if (ok(guess)) {
    if (guess === 0) return 0;
    // Below the guess: gallop down, then bisect.
    hi = guess;
    let step = 1;
    lo = guess - step;
    while (lo > 0 && ok(lo)) {
      hi = lo;
      step *= 2;
      lo = Math.max(0, hi - step);
    }
    if (lo === 0 && ok(0)) return 0;
  } else {
    if (guess >= HEADROOM_CAP) return null;
    lo = guess;
    let step = Math.max(1, guess);
    hi = Math.min(HEADROOM_CAP, guess + step);
    while (!ok(hi)) {
      if (hi >= HEADROOM_CAP) return null;
      lo = hi;
      step *= 2;
      hi = Math.min(HEADROOM_CAP, hi + step);
    }
  }
  // ok(hi), !ok(lo)
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
