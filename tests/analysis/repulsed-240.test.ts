// #240 item 2: repeated failure is evidence. Live, a 7-player FFA: two attacks of mine on the same
// territory (49, then 52) failed, its owner deploying there both times (12 → 15 → 17 after absorbing
// the kills); the plan then tried a third "assuming its owner does not reinforce it". My cached orders
// (`TurnBoard.orders`) show both attacks: `repulsedAttacks` reads them over the last three turns, and
// a territory repulsed on two of them is attacked only at the size that lands even if its owner
// deploys there first (#120), or not at all. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { MyOrders, TurnBoard } from '../../src/analysis/opponents.js';
import {
  planTurn,
  repulsedAttacks,
  type PlanGameContext,
  type PlanInput,
  type PlannerSettings,
  type RepulsedTarget,
} from '../../src/analysis/planner.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import type { GameMap } from '../../src/normalize.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const P3 = 40;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const RATES = { offensiveKillRate: 60, defensiveKillRate: 70 };
const FFA: PlanGameContext = { players: [ME, P2, P3, 50, 60, 70, 80].map((id) => ({ id })), turn: 18 };

const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, string, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Repulsed',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, name, value, territoryIds]) => ({ id, name, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

//   My B (2) borders player 30's C (3), a member of Fen (+2: 3, 4, 5; player 30 also holds 8 beyond
//   it). My 1 faces player 40's 14-stack on 6. Turns 16 and 17 I attacked C from B: 20 against 12
//   (kills 12; C read 15 after: its owner deployed 15), then 25 against 15 (kills 15; 17 after).
const map = makeMap(
  [1, 2, 3, 4, 5, 6, 7, 8, 9],
  [[1, 2], [2, 3], [3, 4], [4, 5], [1, 6], [6, 7], [4, 8], [9, 7]],
  [[301, 'Fen', 2, [3, 4, 5]]],
);
const g = buildGraph(map);
const at = (c: number, b = 30): BoardState =>
  board([
    mine(1, 8),
    mine(2, b),
    player(3, c, P2),
    neutral(4, 4),
    neutral(5, 4),
    player(6, 14, P3),
    player(7, 3, P3),
    player(8, 3, P2),
    player(9, 4, P3),
  ]);
const attackC = (armies: number): MyOrders => ({ deploys: [], moves: [{ from: 2, to: 3, armies }] });

/** Turns 15–17 with my orders, ending on turn 18's board (C at 17). */
const LIVE: TurnBoard[] = [
  { turn: 15, board: at(12) },
  { turn: 16, board: at(12), orders: attackC(20) },
  { turn: 17, board: at(15), orders: attackC(25) },
  { turn: 18, board: at(17) },
];

describe('#240: repulsedAttacks reads failed attacks of mine whose target its owner reinforced', () => {
  it('the live shape: two failed attacks on C, reinforced each time', () => {
    const r = repulsedAttacks(g, LIVE, ME, RATES);
    expect(r).toEqual<RepulsedTarget[]>([
      {
        territoryId: 3,
        playerId: P2,
        attacks: [
          { turn: 16, armies: 20, before: 12, after: 15, kills: 12 },
          { turn: 17, armies: 25, before: 15, after: 17, kills: 15 },
        ],
      },
    ]);
  });

  it('one failed attack only is no evidence', () => {
    const boards: TurnBoard[] = [{ turn: 16, board: at(12) }, { turn: 17, board: at(15), orders: attackC(25) }, { turn: 18, board: at(17) }];
    expect(repulsedAttacks(g, boards, ME, RATES)).toEqual([]);
  });

  it('an owner that did not reinforce it is no evidence: the kills explain the shrink', () => {
    // 20 kill 12 of 30 (18 left), then 25 kill 15 of 18 (3 left): no deploy there either time.
    const boards: TurnBoard[] = [
      { turn: 16, board: at(30), orders: attackC(20) },
      { turn: 17, board: at(18), orders: attackC(25) },
      { turn: 18, board: at(3) },
    ];
    expect(repulsedAttacks(g, boards, ME, RATES)).toEqual([]);
  });

  it('only the last three turns count, and only consecutive boards', () => {
    // The failed attacks on turns 13 and 14 are older than three turns before turn 18.
    const old: TurnBoard[] = [
      { turn: 13, board: at(12), orders: attackC(20) },
      { turn: 14, board: at(15), orders: attackC(25) },
      { turn: 15, board: at(17) },
      { turn: 18, board: at(17) },
    ];
    expect(repulsedAttacks(g, old, ME, RATES)).toEqual([]);
    // A gap (turn 17 missing): the attack on turn 16 is not read against turn 18's board.
    const gap: TurnBoard[] = [
      { turn: 15, board: at(12), orders: attackC(20) },
      { turn: 16, board: at(15), orders: attackC(25) },
      { turn: 18, board: at(17) },
    ];
    expect(repulsedAttacks(g, gap, ME, RATES).map((x) => x.attacks.map((a) => a.turn))).toEqual([]);
  });

  it('a territory taken since, or now another player’s, is not reported', () => {
    const lost: TurnBoard[] = [...LIVE.slice(0, 3), { turn: 18, board: board([...at(17).territories.filter((t) => t.territoryId !== 3), player(3, 17, P3)]) }];
    // Turn 17's attack hit a territory that changed hands: only turn 16's counts, one is no evidence.
    expect(repulsedAttacks(g, lost, ME, RATES)).toEqual([]);
  });
});

const input = (repulsed?: readonly RepulsedTarget[], b = at(17)): PlanInput => ({
  graph: g,
  board: b,
  me: ME,
  income: 10,
  settings: STD,
  game: FFA,
  turn: 18,
  ...(repulsed ? { repulsed } : {}),
  options: { goal: 'balanced', minWinChance: 1 },
});
const attacksOn = (p: ReturnType<typeof planTurn>, t: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === t);
function valid(p: ReturnType<typeof planTurn>, b: BoardState) {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  return validateTurn({
    map,
    board: b.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: 1,
        fogged: false,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income: 10,
    guard: true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  }).warnings;
}

describe('#240: a further attack on a repulsed territory is sized for its owner’s deploy, or not made', () => {
  const rep = repulsedAttacks(g, LIVE, ME, RATES);

  it('without the history the attack on C is sized for the 17 there now and assumes no reinforcement', () => {
    const p = planTurn(input());
    const a = attacksOn(p, 3);
    expect(a.map((m) => m.armies)).toEqual([30]);
    expect(a[0]!.armies).toBeLessThan(armiesToTake(17 + 5, RATES)!);
    expect(p.warnings.join('\n')).toMatch(/Attack on enemy T3 \(#3\) assumes its owner does not reinforce it first/);
  });

  it('the live shape: sized for 17 plus its owner’s deploy, and the rationale names the failed turns', () => {
    const p = planTurn(input(rep));
    const a = attacksOn(p, 3);
    expect(a.map((m) => m.armies)).toEqual([36]);
    expect(a[0]!.armies).toBeGreaterThanOrEqual(armiesToTake(17 + 5, RATES)!);
    expect(p.warnings.join('\n')).not.toMatch(/T3 \(#3\) assumes its owner does not reinforce/);
    expect(p.rationale.join('\n')).toMatch(
      /My attacks on T3 \(#3\) failed on turns 16 and 17, player 30 reinforcing it each time \(20 against 12, 15 after; 25 against 15, 17 after\): a further attack is sized for its owner's ~5 deploy there \(17 \+ 5 defenders, 36 armies\), or not made \(#240\)\./,
    );
    expect(valid(p, at(17))).toEqual([]);
  });

  it('one failed attack, or an owner that did not reinforce, leaves the plan as it was', () => {
    const plain = planTurn(input());
    const one: TurnBoard[] = [{ turn: 17, board: at(15), orders: attackC(25) }, { turn: 18, board: at(17) }];
    const none: TurnBoard[] = [
      { turn: 16, board: at(30), orders: attackC(20) },
      { turn: 17, board: at(18), orders: attackC(25) },
      { turn: 18, board: at(17) },
    ];
    for (const boards of [one, none]) {
      const r = repulsedAttacks(g, boards, ME, RATES);
      expect(r).toEqual([]);
      expect(planTurn(input(r))).toEqual(plain);
    }
  });

  it('when that size does not fit, no attack is made on it', () => {
    // B holds 25: 24 movable and 10 to deploy reach 34, short of the 36 that take 17 + 5; the plain
    // sizing sent 30 against the 17 there now.
    const small = at(17, 25);
    const before = planTurn(input(undefined, small));
    expect(attacksOn(before, 3).map((m) => m.armies)).toEqual([30]);
    const p = planTurn(input(rep, small));
    expect(attacksOn(p, 3)).toEqual([]);
    const r = p.rationale.join('\n');
    expect(r).toMatch(/My attacks on T3 \(#3\) failed on turns 16 and 17/);
    expect(r).toMatch(/T3 \(#3\) does not fit this turn: it needs 36, and at most 34 can reach it this turn/);
    expect(valid(p, small)).toEqual([]);
  });
});
