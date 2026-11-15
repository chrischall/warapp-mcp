// Issue #253 (items 2 and 3): under an army cap, armies I do not spend cost income next turn.
// Live, a 7-player FFA at its cap parked 54 armies on one stack and refused two enemy
// territories beside it holding 0 and 1 armies ("it breaks no bonus and is no counter-attack …"),
// because rule 4e's army-cap fallback runs only when the plan captures nothing, and that plan
// completed a bonus elsewhere. Rule 4h: when my armies after this turn plus next income exceed
// the cap, a capture whose expected losses are below the income the cap would eat is taken from
// idle armies, every hold respected. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { armyCapIncome } from '../../src/analysis/player.js';
import { planTurn, type PlanGameContext, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P2 = 30;
const P3 = 40;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const SEVEN: PlanGameContext = { players: [ME, P2, P3, 50, 60, 70, 80].map((id) => ({ id })), turn: 21 };

const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

//   My 54-stack on 1 borders player 30's 2 (0 armies) and player 40's 3 (1 army); behind each
//   stands its owner's real stack (7: 20, 9: 10), next to no territory of mine.
//   My 4 (5 armies) borders the 2-neutral 5: Home (+3) is 4 and 5, so taking 5 completes it —
//   a capture the bonus passes plan anyway, so rule 4e's fallback never runs.
//   Two quiet players sit far off on 20 and 21.
//   Bait (+1) is 11 alone, a 12-neutral beside 4: too costly for anything but the cap.
function makeMap(): GameMap {
  const edges: [number, number][] = [
    [1, 2], [1, 3], [1, 4], [4, 5], [2, 7], [3, 9], [7, 20], [9, 21], [4, 11],
  ];
  const ids = [1, 2, 3, 4, 5, 7, 9, 11, 20, 21];
  return {
    id: 1,
    name: 'CapSpend',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [
      { id: 301, name: 'Home', value: 3, territoryIds: [4, 5], bonusIds: [] },
      { id: 302, name: 'Bait', value: 1, territoryIds: [11], bonusIds: [] },
    ],
    distributionModes: [],
  };
}
const MAP = makeMap();
const g = buildGraph(MAP);

const live = (stack = 54): BoardState =>
  board([
    mine(1, stack),
    player(2, 0, P2),
    player(3, 1, P3),
    mine(4, 5),
    neutral(5, 2),
    player(7, 20, P2),
    player(9, 10, P3),
    neutral(11, 12),
    player(20, 5, 50),
    player(21, 5, 60),
  ]);

const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const targetsOf = (p: TurnPlan) => attacks(p).map((m) => m.to).sort((a, b) => a - b);
const deployedOn = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);

/** Plan with the army cap's cut computed as warapp_plan_turn computes it. */
function capped(b: BoardState, uncapped: number, cap: number, settings: PlannerSettings = STD) {
  const armies = b.territories.filter((t) => t.owner.kind === 'player' && t.owner.playerId === ME).reduce((n, t) => n + (t.armies ?? 0), 0);
  const incomeCap = armyCapIncome(uncapped, cap, armies)!;
  return planTurn({ graph: g, board: b, me: ME, income: incomeCap.received, incomeCap, settings: { ...settings, armyCap: cap }, game: SEVEN });
}

describe('#253: the army cap prices idle armies (rule 4h)', () => {
  it('the live shape: a capture already planned, the cap binding, the 0- and 1-army enemy territories are taken from idle armies', () => {
    // 59 armies on the board, income 10, cap 5×: 50 − 59 < 0, so nothing is received this turn.
    // Next turn: 59 armies (less what the captures lose) and 13 income (Home completed): 5 × 13 = 65,
    // so 6 or 7 of the 13 would be lost to the cap.
    const p = capped(live(), 10, 5);
    expect(targetsOf(p)).toEqual([2, 3, 5]);
    for (const m of attacks(p).filter((x) => x.to === 2 || x.to === 3)) expect(m.from).toBe(1);
    // Paid from idle armies: nothing is deployed for them (there is no income to deploy anyway).
    expect(deployedOn(p, 1)).toBe(0);
    const text = p.rationale.join('\n');
    expect(text).toMatch(/army cap/);
    expect(text).toMatch(/Take T2 \(#2\)[^\n]*army cap[^\n]*5× income 13 = 65[^\n]*of next turn's income/);
    expect(text).toMatch(/Take T3 \(#3\)[^\n]*loses ~1/);
    // The "Not attacking" report no longer lists them.
    expect(text).not.toMatch(/T2 \(#2\) \(player 30, 0 armies\)/);
  });

  it('the Bait neutral loses more than the income at stake: not taken, and a warning says what idle armies still cost', () => {
    // A 12-neutral loses ~8 (70% of 12) against the ~5 still at stake once 2 and 3 are taken.
    const p = capped(live(), 10, 5);
    expect(targetsOf(p)).not.toContain(11);
    expect(p.rationale.join('\n')).toMatch(/T11 \(#11\) loses ~8, more than the ~5 of next income the army cap would take/);
    expect(p.warnings.join('\n')).toMatch(/Army cap: my ~57 armies after this turn reach the army cap next turn \(5× income 13 = 65\): ~5 of next turn's income 13 would be lost unless armies are spent \(the largest idle stack is \d+ on T1 \(#1\)\); the plan already spends idle armies on T2 \(#2\), T3 \(#3\)/);
  });

  it('no army cap: the plan is unchanged — the 0- and 1-army territories stay unattacked', () => {
    const p = planTurn({ graph: g, board: live(), me: ME, income: 10, settings: STD, game: SEVEN });
    expect(targetsOf(p)).toEqual([5]);
    expect(p.rationale.join('\n')).not.toMatch(/army cap/);
    expect(p.rationale.join('\n')).toMatch(/T2 \(#2\) \(player 30, 0 armies\)[^;]*breaks no bonus/);
  });

  it('a cap that does not bind this turn or next: rule 4h stays off', () => {
    // 59 armies, income 10, cap 20×: 200 − 59 leaves the whole income, and next turn too.
    const p = capped(live(), 10, 20);
    expect(targetsOf(p)).toEqual([5]);
    expect(p.rationale.join('\n')).not.toMatch(/army cap/);
  });

  it('binding only next turn (nothing cut now): rule 4h still spends the idle armies', () => {
    // Home already mine (5 holds 1), so no capture adds income. A 44-stack: 44 + 5 + 1 = 50 armies,
    // income 10, cap 6×: 60 − 50 = 10, paid in full. Next turn 60 armies and 10 income: 60 − 60 = 0,
    // the whole income lost unless armies are spent.
    const b = board(live(44).territories.map((t) => (t.territoryId === 5 ? mine(5, 1) : t)));
    expect(armyCapIncome(10, 6, 50)!.cut).toBe(false);
    expect(armyCapIncome(10, 6, 60)!.received).toBe(0);
    const p = capped(b, 10, 6);
    expect(targetsOf(p)).toEqual(expect.arrayContaining([2, 3]));
    expect(p.rationale.join('\n')).toMatch(/army cap/);
    // Without the cap the same board attacks neither.
    const free = planTurn({ graph: g, board: b, me: ME, income: 10, settings: STD, game: SEVEN });
    expect(targetsOf(free)).not.toContain(2);
    expect(targetsOf(free)).not.toContain(3);
  });

  it('every hold is respected: a stack that must hold its border does not attack for the cap', () => {
    // Player 30's 2 now holds 83 beside my 54 on 1: 82 movable and its ~5 deploy kill ~52, so 53 must
    // stay and 1 is spare — short of the 2 that take player 40's 1-army 3, reachable only from 1.
    const b = board(live().territories.map((t) => (t.territoryId === 2 ? player(2, 83, P2) : t)));
    const p = capped(b, 10, 5);
    expect(p.conceded ?? []).not.toContain(1);
    expect(attacks(p).filter((m) => m.from === 1)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/Army cap: [^\n]*unless armies are spent/);
    // The rule says why, and the offence report repeats it beside its own reason.
    expect(p.rationale.join('\n')).toMatch(/Army cap \(rule 4h, #253\), not taken: T3 \(#3\) does not fit this turn: it needs 2, and at most 1 can reach it/);
    expect(p.rationale.join('\n')).toMatch(/T3 \(#3\) \(player 40, 1 armies\):[^;]*; the army cap's spend of idle armies \(rule 4h\) tried it: it does not fit this turn/);
  });
});

// #272 item 3: the cap spend left forks on the table. Live (the same 7-player FFA), the plan spent
// idle armies on three near-empty territories of one weakened owner and left two more of its
// territories beside my stack untouched (4 and 14 armies), though that owner's one deploy could not
// save five attacks at once; the play session sent all five. Now, once a player's territory is taken
// for the cap, its owner's other territories beside mine are candidates too whatever they hold — a
// fork its one deploy cannot all save — each still only while its loss is below the income at stake.
describe('#272: under the cap, a fork on one owner beats a single attack', () => {
  //   As above, plus player 30's 6 (4 armies) beside my 54-stack on 1 (and its 7 behind).
  function forkMap(): GameMap {
    const base = makeMap();
    const edges: [number, number][] = [[1, 6], [6, 7]];
    return {
      ...base,
      territories: [
        ...base.territories.map((t) => ({
          ...t,
          connectedTo: [...t.connectedTo, ...edges.filter(([a, b]) => a === t.id || b === t.id).map(([a, b]) => (a === t.id ? b : a))],
        })),
        { id: 6, name: 'T6', connectedTo: [1, 7] },
      ],
    };
  }
  const fg = buildGraph(forkMap());
  const forkBoard = (twoOwner = P2): BoardState =>
    board([...live().territories.map((t) => (t.territoryId === 2 ? player(2, 0, twoOwner) : t)), player(6, 4, P2)]);
  const cappedFork = (b: BoardState) => {
    const armies = b.territories.filter((t) => t.owner.kind === 'player' && t.owner.playerId === ME).reduce((n, t) => n + (t.armies ?? 0), 0);
    const incomeCap = armyCapIncome(10, 5, armies)!;
    return planTurn({ graph: fg, board: b, me: ME, income: incomeCap.received, incomeCap, settings: { ...STD, armyCap: 5 }, game: SEVEN });
  };

  it('player 30 loses its empty 2 to the cap, so its 4-army 6 is attacked too: a fork', () => {
    const p = cappedFork(forkBoard());
    expect(targetsOf(p)).toEqual(expect.arrayContaining([2, 3, 6]));
    expect(attacks(p).find((m) => m.to === 6)?.from).toBe(1);
    expect(p.rationale.join('\n')).toMatch(
      /Take T6 \(#6\) for the army cap \(rule 4h, #253\)[^\n]*a fork \(#272\): player 30 is attacked on 2 territories this turn \(T2 \(#2\), T6 \(#6\)\), more than its one deploy can all save/,
    );
  });

  it('without a fork (2 is another player’s) the 4-army 6 is no candidate, as before', () => {
    const p = cappedFork(forkBoard(60));
    expect(targetsOf(p)).not.toContain(6);
    expect(p.rationale.join('\n')).not.toMatch(/a fork \(#272\)/);
  });
});
