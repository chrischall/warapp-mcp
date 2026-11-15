// #271: three pieces of deploy evidence the opponent tracker and the single-turn reading ignored or
// misread.
//  (1) A failed attack on a territory of mine that held is a measurement: my losses there need at
//      least losses ÷ the offensive kill rate attackers, and they came from the attacker's stacks
//      beside it at the start of the turn plus what it deployed there. Less those stacks, that is a
//      lower bound on its deploy that turn, with no fog involved (a played lost 7-player FFA: a hold
//      of 122 left at 4 by a player whose three stacks beside it held 276 read "observed +0").
//  (2) A capture of a neutral in view needs at least armiesToTake(defenders) attackers; those its
//      stacks in view cannot have sent came out of sight. Within the #123 bound they read as deploy,
//      and a repeated pattern (captures like it on three turns out of six) is income, not a move.
//  (3) Its own stacks in view beside a territory it took, hidden the turn after, may have moved into
//      it: arrivals, not deploy (a merge of 35 and 33 into a capture read +45, five times its income).
// Synthetic maps and made-up ids.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { fewestAttackersToKill, fewestAttackersToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { trackOpponents, type MyOrders } from '../../src/analysis/opponents.js';
import { observeDeploy, planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const B = 30;
const enemy = (territoryId: number, armies: number, playerId = A): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
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

const NO_ORDERS: MyOrders = { deploys: [], moves: [] };

describe('the fewest attackers that can do it', () => {
  it('luck-free and straight-rounded: the exact inverse of the kill count', () => {
    // round(392 × 0.3) = 118 (117.6), round(391 × 0.3) = 117 (117.3).
    expect(fewestAttackersToKill(118, { offensiveKillRate: 30 })).toBe(392);
    expect(fewestAttackersToKill(0, { offensiveKillRate: 30 })).toBe(0);
    // armiesToTake's answer when luck is off: 58 at 20% for a 12 (round(57 × 0.2) = 11).
    expect(fewestAttackersToTake(12, { offensiveKillRate: 20, defensiveKillRate: 80 })).toBe(58);
  });

  it('luck lets fewer do it: every attacker may kill', () => {
    // At 16% luck an army kills up to 0.3 + 0.16 × 0.7 = 0.412 of a defender.
    expect(fewestAttackersToKill(118, { offensiveKillRate: 30 }, 0.16)).toBe(286);
    expect(fewestAttackersToKill(118, { offensiveKillRate: 30 }, 16)).toBe(286);
    // Weighted-random rounding may round any fraction up.
    expect(fewestAttackersToKill(3, { offensiveKillRate: 50 }, 0, 'WeightedRandom')).toBe(5);
  });
});

describe('(1) a failed attack on a hold of mine bounds the attacker\'s deploy', () => {
  // My T1 (122) borders player A's T2 (100), T3 (70) and T4 (106), and my T5. A's stacks border the
  // fog (T6, in a +150 bonus it could hold). A attacks T1 in waves and fails: T1 keeps 4, A's three
  // stacks end at 50, 95 and 79 (224 of 276). At 30% 118 kills need 392 attackers: 116 more than its
  // stacks beside T1 held.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 7, 8],
      [
        [1, 2],
        [1, 3],
        [1, 4],
        [1, 5],
        [2, 6],
        [3, 6],
        [4, 6],
        [5, 7],
        [5, 8],
      ],
      [[901, 150, [6]]],
    ),
  );
  const S: PlannerSettings = { offensiveKillRate: 30, defensiveKillRate: 75, oneArmyStandsGuard: false, baseIncome: 5 };
  const before = board([mine(1, 122), enemy(2, 100), enemy(3, 70), enemy(4, 106), mine(5, 10), fogged(6), mine(7, 3), neutral(8, 2)]);
  const after = board([mine(1, 4), enemy(2, 50), enemy(3, 95), enemy(4, 79), mine(5, 10), fogged(6), mine(7, 3), neutral(8, 2)]);
  const ctx = { me: ME, guard: 0, expected: 10, most: 155 };

  it('with my orders: deploy ≥ the attackers my losses needed less its stacks beside the hold', () => {
    const o = observeDeploy(g, after, before, A, S, { ...ctx, myOrders: NO_ORDERS });
    expect(o.repelled).toEqual([1]);
    expect(o.repelledFloor).toBe(392 - 276);
    expect(o.deploy).toBe(116);
    expect(o.low).toBe(116);
    expect(o.high).toBeGreaterThanOrEqual(116);
  });

  it('my deploys and moves set what stood there', () => {
    // I deployed 10 on T1 and moved 20 out to T5: 112 defended, 108 died.
    const orders: MyOrders = { deploys: [{ territoryId: 1, armies: 10 }], moves: [{ from: 1, to: 5, armies: 20 }] };
    const moved = board([mine(1, 4), enemy(2, 50), enemy(3, 95), enemy(4, 79), mine(5, 30), fogged(6), mine(7, 3), neutral(8, 2)]);
    const o = observeDeploy(g, moved, before, A, S, { ...ctx, myOrders: orders });
    expect(o.repelledFloor).toBe(Math.ceil((100 * 108 - 50) / 30) - 276);
  });

  it('the guard stays: each stack beside it sends one army less', () => {
    const o = observeDeploy(g, after, before, A, { ...S, oneArmyStandsGuard: true }, { ...ctx, guard: 1, myOrders: NO_ORDERS });
    expect(o.repelledFloor).toBe(392 - 273);
  });

  it('luck lowers the bound', () => {
    const o = observeDeploy(g, after, before, A, { ...S, luckModifier: 0.16 }, { ...ctx, myOrders: NO_ORDERS });
    expect(o.repelledFloor).toBe(286 - 276);
  });

  it('not without my orders, nor when another player borders it, a neighbour was hidden, or under Multi-Attack', () => {
    expect(observeDeploy(g, after, before, A, S, ctx)).toMatchObject({ repelled: [], repelledFloor: 0, deploy: 0 });
    const two = (b: BoardState) => board(b.territories.map((t) => (t.territoryId === 4 ? enemy(4, t.armies!, B) : t)));
    expect(observeDeploy(g, two(after), two(before), A, S, { ...ctx, myOrders: NO_ORDERS }).repelledFloor).toBe(0);
    const hid = board(before.territories.map((t) => (t.territoryId === 3 ? fogged(3) : t)));
    expect(observeDeploy(g, after, hid, A, S, { ...ctx, myOrders: NO_ORDERS }).repelledFloor).toBe(0);
    expect(observeDeploy(g, after, before, A, { ...S, multiAttack: true }, { ...ctx, myOrders: NO_ORDERS }).repelledFloor).toBe(0);
  });

  it('a hold I attacked out of and failed is not read: my survivors came back to it', () => {
    const orders: MyOrders = { deploys: [], moves: [{ from: 1, to: 2, armies: 30 }] };
    expect(observeDeploy(g, after, before, A, S, { ...ctx, myOrders: orders }).repelledFloor).toBe(0);
  });

  it('the plan reads it from last turn\'s orders and says so', () => {
    const p = planTurn({ graph: g, board: after, previousBoard: before, previousOrders: NO_ORDERS, me: ME, income: 5, settings: S, turn: 30 });
    expect(p.rationale.join('\n')).toMatch(/Player 20 attacked T1 \(#1\) and failed: .*at least \+116, fog or not/);
    expect(p.enemyDeploy).toBeGreaterThanOrEqual(116);
  });

  it('the tracker counts it: the turn reads at least the bound, not +40', () => {
    const [t] = trackOpponents(
      g,
      [
        { turn: 29, board: before, orders: NO_ORDERS },
        { turn: 30, board: after },
      ],
      ME,
      S,
    );
    expect(t!.turns[0]!.raw).toBe(116);
    expect(t!.turns[0]!.repelledFloor).toBe(116);
    expect(t!.income).toBe(116);
    expect(t!.notes.join('\n')).toMatch(/attack on territory 1 that held .*392 attackers.*276.*at least 116/);
  });
});

describe('(2) a capture of a neutral in view needs attackers its stacks in view cannot have sent', () => {
  // My T10 borders three 12-army wastelands (T11, T21, T31), each beside the fog (T12, in a +40
  // bonus). Player A shows T13 (5) beside the fog and me. At 20% each wasteland needs 58 attackers;
  // A stands on each with 48 after the capture, from no stack in view.
  const g = buildGraph(
    makeMap(
      [10, 11, 12, 13, 21, 31],
      [
        [10, 11],
        [10, 21],
        [10, 31],
        [10, 13],
        [11, 12],
        [21, 12],
        [31, 12],
        [13, 12],
      ],
      [[902, 40, [12]]],
    ),
  );
  const S: PlannerSettings = { offensiveKillRate: 20, defensiveKillRate: 80, oneArmyStandsGuard: false, baseIncome: 5 };
  const at = (taken: number[]) =>
    board([
      mine(10, 5),
      ...[11, 21, 31].map((id) => (taken.includes(id) ? enemy(id, 48) : neutral(id, 12))),
      fogged(12),
      enemy(13, 5),
    ]);

  it('the attackers it needed beyond what its stacks in view sent are counted, read as deploy within the bound', () => {
    const o = observeDeploy(g, at([11]), at([]), A, S, { me: ME, guard: 0, expected: 20, most: 45 });
    expect(o.unseenAttackers).toEqual([11]);
    expect(o.unseenAttackerArmies).toBe(58);
    // The capture cost 10; the bound (twice 20) lets 30 of the 48 standing there read as deploy.
    expect(o.deploy).toBe(40);
    expect(o.fogArmies).toBe(18);
    expect(o.fromFog).toEqual([11]);
  });

  it('within a small bound most of it is still a move', () => {
    const o = observeDeploy(g, at([11]), at([]), A, S, { me: ME, guard: 0, expected: 5, most: 45 });
    expect(o.deploy).toBe(10);
    expect(o.fogArmies).toBe(48);
  });

  it('a stack in view that shrank into it explains it', () => {
    const before = board([...at([]).territories.filter((t) => t.territoryId !== 13), enemy(13, 60)]);
    const g2 = buildGraph(
      makeMap(
        [10, 11, 12, 13, 21, 31],
        [
          [10, 11],
          [10, 21],
          [10, 31],
          [10, 13],
          [11, 12],
          [11, 13],
          [21, 12],
          [31, 12],
          [13, 12],
        ],
        [[902, 40, [12]]],
      ),
    );
    const after = board([...at([11]).territories.filter((t) => t.territoryId !== 13), enemy(13, 2)]);
    const o = observeDeploy(g2, after, before, A, S, { me: ME, guard: 0, expected: 20, most: 45 });
    expect(o.unseenAttackers).toEqual([]);
  });

  const history = (turns: [number, number[]][]) => turns.map(([turn, taken]) => ({ turn, board: at(taken) }));

  it('three such captures in six turns are income, not moves', () => {
    const [t] = trackOpponents(
      g,
      history([
        [1, []],
        [2, [11]],
        [3, [11]],
        [4, [11, 21]],
        [5, [11, 21]],
        [6, [11, 21]],
        [7, [11, 21, 31]],
      ]),
      ME,
      S,
    );
    // 3 × 58 attackers over turns 1–6: ceil(174 / 6) = 29. Each turn's reading is still bounded
    // (#123: up to twice what it was expected to deploy), so the newest reads 40 within its bound.
    expect(t!.turns.at(-1)!.fogCaptures).toEqual({ turns: [1, 3, 6], armies: 174, income: 29 });
    expect(t!.turns.map((x) => x.observed)).toEqual([10, 0, 20, 0, 0, 40]);
    expect(t!.income).toBe(40);
    expect(t!.notes.join('\n')).toMatch(/3 captures of neutrals in view on turns 1, 3, 6 needed 174 attackers/);
  });

  it('two are not a pattern', () => {
    const [t] = trackOpponents(
      g,
      history([
        [1, []],
        [2, [11]],
        [3, [11]],
        [4, [11, 21]],
      ]),
      ME,
      S,
    );
    expect(t!.income).toBeLessThan(29);
    expect(t!.incomeMethod).not.toBe('fog-captures');
  });

  it('the pattern is kept once its turns age out: an income does not decay', () => {
    const [t] = trackOpponents(
      g,
      history([
        [1, []],
        [2, [11]],
        [3, [11]],
        [4, [11, 21]],
        [5, [11, 21]],
        [6, [11, 21]],
        [7, [11, 21, 31]],
        [8, [11, 21, 31]],
        [9, [11, 21, 31]],
        [10, [11, 21, 31]],
        [11, [11, 21, 31]],
        [12, [11, 21, 31]],
      ]),
      ME,
      S,
    );
    // Quiet turns read in full end the bound-cut 40 (#123), never the pattern: it is evidence.
    expect(t!.income).toBe(29);
    expect(t!.incomeMethod).toBe('carried');
    expect(t!.notes.join('\n')).toMatch(/3 captures of neutrals in view on turns 1, 3, 6 needed 174 attackers/);
  });
});

describe('(3) its stacks in view that moved into a territory it took are arrivals, not deploy', () => {
  // My T95 (4) borders my T4 and T94 and player A's T96 (33) and T98 (35). A takes T95 with 70: T96
  // is left at 0 in view, T98 is hidden after (I no longer see beside it).
  const g = buildGraph(
    makeMap(
      [4, 94, 95, 96, 98, 100],
      [
        [95, 4],
        [95, 94],
        [95, 96],
        [95, 98],
        [96, 100],
        [98, 100],
      ],
      [[903, 200, [100]]],
    ),
  );
  const S: PlannerSettings = { offensiveKillRate: 30, defensiveKillRate: 75, oneArmyStandsGuard: false, baseIncome: 5 };
  const before = board([mine(4, 20), mine(94, 12), mine(95, 4), enemy(96, 33), enemy(98, 35), fogged(100)]);
  const after = board([mine(4, 29), mine(94, 4), enemy(95, 70), enemy(96, 0), fogged(98), fogged(100)]);

  it('the hidden source counts as arrived, so the surplus left to read as deploy is 2, not 37', () => {
    const o = observeDeploy(g, after, before, A, S, { me: ME, guard: 0, expected: 29, most: 205 });
    expect(o.arrivals).toBe(35);
    expect(o.deploy).toBe(2);
    expect(o.reinforced).toEqual([95]);
    // Two-sided: had T98 stayed put, the 35 were deployed (and my 4 stood on T95: 3 more killed).
    expect(o.low).toBe(0);
    expect(o.high).toBe(2 + 35 + 3);
  });

  it('with no source left in view, the hidden one still explains what it held', () => {
    const b2 = board([mine(4, 20), mine(94, 12), mine(95, 4), enemy(96, 33), enemy(98, 35), fogged(100)]);
    const a2 = board([mine(4, 29), mine(94, 4), enemy(95, 40), fogged(96), fogged(98), fogged(100)]);
    const o = observeDeploy(g, a2, b2, A, S, { me: ME, guard: 0, expected: 29, most: 205 });
    expect(o.arrivals).toBe(40);
    expect(o.deploy).toBe(0);
    expect(o.fromFog).toEqual([]);
  });

  it('the tracker does not read the merge as income', () => {
    const [t] = trackOpponents(
      g,
      [
        { turn: 27, board: before },
        { turn: 28, board: after },
      ],
      ME,
      S,
    );
    expect(t!.turns[0]!.arrivals).toBe(35);
    // Stock and flow: −33 on T96, +70 on T95, less the 35 that arrived from T98.
    expect(t!.income).toBeLessThanOrEqual(5);
  });
});
