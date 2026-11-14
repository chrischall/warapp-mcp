// #215: a border of mine that cannot hold at the expected threat and protects nothing (in no bonus,
// not my commander) was left holding its armies instead of breaking the adjacent enemy bonus. Under
// `balanced`, rule 1a's triage concedes such a border only on the economic test; a border taken last
// turn from a weak opponent is exempt from that test (conceding it hands it back for free), so it was
// locked as a pending hold for rule 4a's greedy step, which conceded it later as unaffordable but
// never unlocked it: its armies could not attack out, and the deploy went elsewhere. Every map, id and
// name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board as boardOf } from './helpers.js';

const ME = 10;
const FOE = 20;
const RATES: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false };

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
const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };

// My T1 (in no bonus) faces player 20's 35-stack on T2 and T3, a 2-army member of its +3 bonus B900
// (T3, T4, T5). Behind T1 is my T6, in my held bonus B910 (+5: T6, T7, T8); T8 faces player 20's T23.
// Bonus B920 (+6) is far: my T12 and three neutrals. B930 (+10) is held deep inside.
const map = makeMap(
  [1, 2, 3, 4, 5, 6, 7, 8, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23],
  [
    [1, 2],
    [1, 3],
    [1, 6],
    [3, 4],
    [4, 5],
    [2, 21],
    [21, 22],
    [22, 23],
    [6, 7],
    [7, 8],
    [8, 23],
    [7, 12],
    [12, 13],
    [13, 14],
    [14, 15],
    [7, 16],
    [16, 17],
    [17, 18],
    [18, 19],
  ],
  [
    [900, 3, [3, 4, 5]],
    [950, 20, [2, 21, 22]],
    [910, 5, [6, 7, 8]],
    [920, 6, [12, 13, 14, 15]],
    [930, 10, [16, 17, 18, 19]],
  ],
);
const g = buildGraph(map);
const field = (x = 7): BoardState =>
  boardOf([
    at(1, x, ME),
    at(2, 35, FOE),
    at(3, 2, FOE),
    at(4, 2, FOE),
    at(5, 2, FOE),
    at(6, 3, ME),
    at(7, 3, ME),
    at(8, 12, ME),
    at(12, 4, ME),
    at(13, 15, 'neutral'),
    at(14, 15, 'neutral'),
    at(15, 10, 'neutral'),
    at(16, 20, ME),
    at(17, 2, ME),
    at(18, 1, ME),
    at(19, 1, ME),
    at(21, 3, FOE),
    at(22, 3, FOE),
    at(23, 15, FOE),
  ]);
/** The board one turn earlier: T1 was player 20's (taken last turn). */
const before = (b: BoardState): BoardState =>
  boardOf(b.territories.map((t) => (t.territoryId === 1 ? { ...t, owner: { kind: 'player', playerId: FOE } } : t)));
const input = (o: { x?: number; recent?: boolean; income?: number; t2?: number } = {}): PlanInput => {
  const board =
    o.t2 === undefined ? field(o.x) : boardOf(field(o.x).territories.map((t) => (t.territoryId === 2 ? { ...t, armies: o.t2! } : t)));
  return {
    graph: g,
    board,
    me: ME,
    income: o.income ?? 30,
    settings: RATES,
    game: { players: [{ id: ME }, { id: FOE }], turn: 10 },
    options: { adapt: true },
    ...(o.recent === false ? {} : { previousBoard: before(board) }),
  };
};
const attacksFrom = (p: TurnPlan, id: number) => p.moves.filter((m) => m.kind === 'attack' && m.from === id);
const notAttacking = (p: TurnPlan) => p.rationale.find((l) => l.startsWith('Not attacking')) ?? '';

describe('#215: a hopeless border that protects nothing is conceded and attacks out', () => {
  it('breaks the adjacent enemy bonus from a border taken last turn that cannot be held', () => {
    const p = planTurn(input());
    // T1 cannot hold against 35 + ~28: conceded (not held for the greedy step).
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) cannot be held with the 30 armies left to deploy \(needs \d+, protects \+0\): conceded/);
    expect(p.deploys.find((d) => d.territoryId === 1)).toBeUndefined();
    // Its armies break B900 through T3 instead of staying pinned.
    const out = attacksFrom(p, 1);
    expect(out.map((m) => m.to)).toEqual([3]);
    expect(out[0]!.armies).toBeGreaterThanOrEqual(3);
    expect(out[0]!.reason).toMatch(/breaks enemy bonus B900/);
    // T3 is attacked, so no skip line names it.
    expect(notAttacking(p)).not.toMatch(/T3 \(#3\)/);
  });

  it('is the same plan for T1 as when T1 was not taken last turn', () => {
    const recent = planTurn(input());
    const old = planTurn(input({ recent: false }));
    expect(attacksFrom(recent, 1)).toEqual(attacksFrom(old, 1));
  });

  it('the skip line never says a conceded border keeps armies back to hold its border', () => {
    // T2 (the 35-stack) is next to T1 alone: the line gives what T1 can still send once its attack and
    // withdrawal leave, named as conceded, not "spare once it holds its border is 0".
    // (With 12 on T1 a hold of 28 fits the 30 deploy, and a border taken last turn is held.)
    for (const [x, recent] of [[7, true], [9, true], [7, false], [12, false]] as const) {
      const p = planTurn(input({ x, recent }));
      const t2 = notAttacking(p).split('; T')[0]!;
      expect(t2, `x=${x} recent=${recent}`).toMatch(/T2 \(#2\).*the most a neighbour of mine has left for it is \d+ \(T1 \(#1\), conceded: what it can still send once its other orders leave\)/);
      expect(t2, `x=${x} recent=${recent}`).not.toMatch(/once it holds its border/);
    }
  });

  it('a pending hold the greedy step concedes attacks out before it withdraws', () => {
    // T1=20, T2=10, income 15: T1's hold (5) fits the deploy, so triage keeps it pending; the
    // greedy step tries the breaks while T1 is still locked (both fail: T1 is their only source),
    // funds held B910 with all 15, then concedes T1. Unlocked, T1 breaks both bonuses out of its
    // own 20 armies instead of withdrawing them.
    for (const recent of [true, false]) {
      const p = planTurn(input({ x: 20, t2: 10, income: 15, recent }));
      expect(p.warnings.join('\n'), `recent=${recent}`).toMatch(/T1 \(#1\) cannot be held with the 0 armies left to deploy \(needs 5, protects \+0\): conceded/);
      const out = attacksFrom(p, 1);
      expect(out.map((m) => m.to).sort(), `recent=${recent}`).toEqual([2, 3]);
      expect(out.find((m) => m.to === 2)!.reason).toMatch(/breaks enemy bonus B950/);
      expect(out.find((m) => m.to === 3)!.reason).toMatch(/breaks enemy bonus B900/);
      expect(notAttacking(p)).not.toMatch(/T[23] \(#[23]\)/);
    }
  });
});

// Review of #215: a border conceded at triage that is a member of a bonus this turn's captures
// complete. Conceded early, it attacked out with its whole stack under No-Split (or all but its guard),
// and rule 1c then kept it for the completed bonus — empty, the leftover deploy that garrisoned it gone
// elsewhere, the rationale still saying it is kept. My T1 is in my bonus B930 (T1, T5, neutral T15);
// player 20's stack is on T2; T3 is a member of its +3 bonus B900 (T3, T4).
describe('#215 review: a conceded border in a bonus completed this turn is kept, not emptied', () => {
  const map2 = makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    [
      [1, 2],
      [1, 3],
      [3, 4],
      [1, 5],
      [5, 6],
      [6, 7],
      [7, 8],
      [2, 9],
      [9, 10],
      [8, 10],
      [5, 11],
      [11, 12],
      [12, 13],
      [6, 14],
      [14, 15],
    ],
    [
      [900, 3, [3, 4]],
      [950, 6, [2, 9]],
      [910, 4, [6, 7, 8]],
      [920, 5, [11, 12, 13]],
      [930, 4, [1, 5, 15]],
    ],
  );
  const g2 = buildGraph(map2);
  const input2 = (o: { x: number; big: number; t3: number; income: number; t15?: number; settings: Partial<PlannerSettings> }): PlanInput => {
    const board = boardOf([
      at(1, o.x, ME),
      at(2, o.big, FOE),
      at(3, o.t3, FOE),
      at(4, 2, FOE),
      at(5, 3, ME),
      at(6, 4, ME),
      at(7, 4, ME),
      at(8, 6, ME),
      at(9, 3, FOE),
      at(10, 8, FOE),
      at(11, 3, ME),
      at(12, 4, 'neutral'),
      at(13, 3, 'neutral'),
      at(14, 3, ME),
      at(15, o.t15 ?? 2, 'neutral'),
    ]);
    return {
      graph: g2,
      board,
      me: ME,
      income: o.income,
      settings: { ...RATES, ...o.settings },
      game: { players: [{ id: ME }, { id: FOE }], turn: 10 },
      options: { adapt: true },
      previousBoard: before(board),
    };
  };
  /** Armies left on T1 once its own orders leave (deploys, incoming transfers counted). */
  const leftOnT1 = (p: TurnPlan, x: number) =>
    x +
    p.deploys.filter((d) => d.territoryId === 1).reduce((n, d) => n + d.armies, 0) +
    p.moves.filter((m) => m.to === 1).reduce((n, m) => n + m.armies, 0) -
    p.moves.filter((m) => m.from === 1).reduce((n, m) => n + m.armies, 0);

  it('under No-Split, completes B930 with T1 garrisoned instead of sending its whole stack out', () => {
    const p = planTurn(input2({ x: 7, big: 20, t3: 1, income: 20, settings: { noSplit: true } }));
    expect(p.expected.bonusesCompleted).toContain(930);
    expect(p.rationale.join('\n')).toMatch(/Keep T1 \(#1\) \(not conceded\): this turn's captures complete bonus B930/);
    // Kept: no order empties it, and the leftover garrisons it.
    expect(attacksFrom(p, 1)).toEqual([]);
    expect(p.deploys.find((d) => d.territoryId === 1)?.armies ?? 0).toBeGreaterThan(0);
    expect(p.warnings.join('\n')).not.toMatch(/T1 \(#1\) is kept for the bonus this turn completes, but its 0 armies/);
  });

  it('with the guard on, completes B930 instead of draining T1 to break B900', () => {
    const p = planTurn(input2({ x: 7, big: 6, t3: 4, income: 5, settings: { oneArmyStandsGuard: true } }));
    expect(p.expected.bonusesCompleted).toContain(930);
    expect(p.warnings.join('\n')).not.toMatch(/completing B930 \(#930\) leaves T1 \(#1\) indefensible/);
  });

  it('a border kept for the completed bonus is never left empty (No-Split, guard, Local, balanced)', () => {
    // Under No-Split any attack out empties T1, so a kept T1 sends none; under every setting the
    // "kept ... but its 0 armies" contradiction never appears.
    let kept = 0;
    for (const settings of [{}, { noSplit: true }, { oneArmyStandsGuard: true }, { localDeployments: true }])
      for (const x of [3, 7, 14, 30])
        for (const big of [6, 20, 50])
          for (const [t3, income] of [[1, 20], [4, 5], [2, 35]] as const) {
            const p = planTurn(input2({ x, big, t3, income, settings }));
            const at = `${JSON.stringify(settings)} x=${x} big=${big} t3=${t3} income=${income}`;
            expect(p.warnings.join('\n'), at).not.toMatch(/T1 \(#1\) is kept for the bonus this turn completes, but its 0 armies/);
            if (!p.rationale.some((l) => l.startsWith('Keep T1 (#1) (not conceded)'))) continue;
            kept++;
            expect(leftOnT1(p, x), at).toBeGreaterThan(0);
            if ('noSplit' in settings) expect(attacksFrom(p, 1), at).toEqual([]);
          }
    expect(kept).toBeGreaterThan(20);
  });

  it('when B930 is out of reach this turn, the conceded T1 still attacks out (No-Split)', () => {
    // T15 at 30 neutrals: nothing completes B930, so T1 is conceded and breaks B900 with its stack.
    const p = planTurn(input2({ x: 7, big: 20, t3: 1, income: 20, t15: 30, settings: { noSplit: true } }));
    expect(p.expected.bonusesCompleted).not.toContain(930);
    expect(p.warnings.join('\n')).toMatch(/T1 \(#1\) cannot be held with the \d+ armies left to deploy/);
    expect(attacksFrom(p, 1).map((m) => m.to)).toEqual([3]);
    // The skip line for T2 says T1's whole stack already left, not "what it can still send".
    expect(notAttacking(p)).toMatch(
      /T2 \(#2\).*the most a neighbour of mine has left for it is 0 \(T1 \(#1\), conceded: No-Split sends its whole stack on its other order\)/,
    );
  });
});
