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

  it('the armies shown count only the moves whose kills were counted (a source mine on both boards)', () => {
    // #240 review: on turn 16 a second attack on C came from 4, which I held then and lost by turn 17
    // (it may have fallen before my attack ran): failedAttackKills counts neither its kills nor, now,
    // its armies.
    const with4 = (c: number, four: TerritoryState): BoardState =>
      board([...at(c).territories.filter((t) => t.territoryId !== 4), four]);
    const boards: TurnBoard[] = [
      { turn: 16, board: with4(12, mine(4, 9)), orders: { deploys: [], moves: [{ from: 2, to: 3, armies: 20 }, { from: 4, to: 3, armies: 8 }] } },
      { turn: 17, board: with4(15, player(4, 3, P2)), orders: attackC(25) },
      { turn: 18, board: with4(17, player(4, 3, P2)) },
    ];
    expect(repulsedAttacks(g, boards, ME, RATES)[0]!.attacks[0]).toEqual({ turn: 16, armies: 20, before: 12, after: 15, kills: 12 });
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

// #240 review, second round: a sure size the turn cannot fund when the capture is planned may still be
// paid from the leftover, as the plan without the evidence pays its #120 sizing. B holds 28 (27
// movable) and income 10 with a reserve of 6 held out of captures: at capture time 31 reach C, short of
// the sure 36; by the end of the turn the leftover reaches B. The capture is taken at its plain size,
// pending, and kept once it reaches 36; with B at 30 and the reserve at 5 the leftover goes to the
// border with the most at stake and the attack stays at 30: it is dropped, never sent below 36.
describe('#240 review: a repulsed capture pending its sure size, kept or dropped at the end of the turn', () => {
  const rep = repulsedAttacks(g, LIVE, ME, RATES);
  const withReserve = (b: number, one: number, reserve: number, repulsed?: readonly RepulsedTarget[]): PlanInput => ({
    ...input(repulsed, board([...at(17, b).territories.filter((t) => t.territoryId !== 1), mine(1, one)])),
    options: { goal: 'balanced', minWinChance: 1, reserve },
  });

  it('kept: the leftover brings it to the sure size, as the plan without the evidence sends it', () => {
    const plain = planTurn(withReserve(28, 8, 6));
    expect(attacksOn(plain, 3).map((m) => m.armies)).toEqual([36]);
    const p = planTurn(withReserve(28, 8, 6, rep));
    expect(attacksOn(p, 3).map((m) => m.armies)).toEqual([36]);
    expect(p.warnings.join('\n')).not.toMatch(/T3 \(#3\) assumes its owner does not reinforce/);
    expect(p.rationale.join('\n')).not.toMatch(/Drop the attack on T3/);
    expect(valid(p, withReserve(28, 8, 6).board)).toEqual([]);
  });

  it('dropped: still short of the sure size once the margin has run, so no attack is made', () => {
    const plain = planTurn(withReserve(30, 8, 5));
    expect(attacksOn(plain, 3).map((m) => m.armies)).toEqual([30]);
    const p = planTurn(withReserve(30, 8, 5, rep));
    expect(attacksOn(p, 3)).toEqual([]);
    expect(p.warnings.join('\n')).not.toMatch(/Attack on enemy T3 \(#3\)/);
    expect(p.rationale.join('\n')).toMatch(
      /Drop the attack on T3 \(#3\): it could send only 30 by the end of the turn, short of the 36 that take it even if player 30 deploys its ~5 there first, and my attacks on it failed before, its owner reinforcing it \(#240\); its armies stay where they are\./,
    );
    expect(p.rationale.join('\n')).not.toMatch(/^Attack T3 \(#3\) /m);
    expect(valid(p, withReserve(30, 8, 5).board)).toEqual([]);
  });
});

// #240 review: evidence that the owner reinforces must never shrink the attack below the plan without
// it. My T1 (20) borders player 20's T3 (4), which completes B9 (+5) with T1; income 5. Without the
// history the attack goes out at 6, #120 lifts it to the sure 15 (4 + 5 defenders) and the #226 margin
// adds the 4 idle armies: 19. With it, the sure 15 is paid at capture time: rule 5 must not then read
// T1 as short of a comfortable margin it had in the plain plan, and keep the leftover from the margin.
describe('#240 review: a repulsed target never gets fewer armies than with no evidence', () => {
  const small = makeMap([1, 2, 3], [[1, 2], [1, 3]], [[9, 'B9', 5, [1, 3]]]);
  const sg = buildGraph(small);
  const P = 20;
  const b = board([mine(1, 20), neutral(2, 1), player(3, 4, P)]);
  const rep: RepulsedTarget[] = [
    {
      territoryId: 3,
      playerId: P,
      attacks: [
        { turn: 4, armies: 6, before: 4, after: 4, kills: 4 },
        { turn: 5, armies: 6, before: 4, after: 4, kills: 4 },
      ],
    },
  ];
  const inp = (goal: 'complete-bonus' | 'balanced', repulsed?: RepulsedTarget[]): PlanInput => ({
    graph: sg,
    board: b,
    me: ME,
    income: 5,
    settings: STD,
    ...(repulsed ? { repulsed } : {}),
    options: { goal },
  });

  for (const goal of ['complete-bonus', 'balanced'] as const) {
    it(`${goal}: the margin still joins the attack (at least the plain plan's armies)`, () => {
      const plain = planTurn(inp(goal));
      const p = planTurn(inp(goal, rep));
      const sent = (x: ReturnType<typeof planTurn>) => attacksOn(x, 3).reduce((s, m) => s + m.armies, 0);
      expect(sent(plain)).toBeGreaterThan(armiesToTake(4 + 5, RATES)!);
      expect(sent(p)).toBeGreaterThanOrEqual(sent(plain));
      expect(p.warnings.join('\n')).not.toMatch(/T3 \(#3\) assumes its owner does not reinforce/);
    });
  }
});

// #240 review: the guard-off pass (#165) sends one army at an empty enemy territory that breaks a
// bonus "unless it deploys there first". On a territory whose owner has reinforced it against my
// attacks twice, that is the attack the evidence says fails: the pass skips it and says why.
describe('#240 review: the guard-off one-army attack skips a repulsed territory', () => {
  const m = makeMap([1, 2, 3], [[1, 2], [2, 3]], [[7, 'Moor', 3, [2, 3]]]);
  const mg = buildGraph(m);
  const P = 20;
  const b = board([mine(1, 6), player(2, 0, P), player(3, 3, P)]);
  const OFF: PlannerSettings = { ...STD, oneArmyStandsGuard: false };
  const rep: RepulsedTarget[] = [
    {
      territoryId: 2,
      playerId: P,
      attacks: [
        { turn: 4, armies: 1, before: 0, after: 0, kills: 1 },
        { turn: 5, armies: 1, before: 0, after: 0, kills: 1 },
      ],
    },
  ];
  const inp = (repulsed?: RepulsedTarget[]): PlanInput => ({
    graph: mg,
    board: b,
    me: ME,
    income: 5,
    settings: OFF,
    ...(repulsed ? { repulsed } : {}),
    options: { goal: 'balanced' },
  });

  it('without the evidence an army breaks Moor; with it, no one-army attack, and the rationale says why', () => {
    const plain = planTurn(inp());
    // One army, topped up from the idle armies beside it (#120), still sized for the board as it stands.
    expect(attacksOn(plain, 2).map((x) => x.reason.startsWith('One Army Must Stand Guard is off'))).toEqual([true]);
    const p = planTurn(inp(rep));
    expect(attacksOn(p, 2).some((x) => x.reason.startsWith('One Army Must Stand Guard is off'))).toBe(false);
    const line = p.rationale.find((l) => l.startsWith('My attacks on T2 (#2) failed'))!;
    const sure = Number(/defenders, (\d+) armies\), or not made/.exec(line)![1]);
    for (const a of attacksOn(p, 2)) expect(a.armies).toBeGreaterThanOrEqual(sure);
    expect(p.rationale.join('\n')).toMatch(/One Army Must Stand Guard is off and T2 \(#2\) stands at 0, but my attacks on it failed before, its owner reinforcing it: no one-army attack there \(#240\)\./);
  });
});
