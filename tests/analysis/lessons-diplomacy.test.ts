// B2 (docs/PLAN-TEAMS.md section 8): the planner honours a truce — each rule as a miniature, like
// the other lessons files. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardSpecialUnit, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  planTurn,
  TRUCE_RELAX_VALUE,
  type PlanInput,
  type PlannerSettings,
  type PlanRelation,
  type TurnPlan,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const PARTNER = 20;
const OTHER = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const FFA = [{ id: ME }, { id: PARTNER }, { id: OTHER }];

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
const enemy = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const commander = (playerId: number): BoardSpecialUnit => ({ kind: 'commander', id: `${playerId}`.padStart(32, '0'), playerId });
const withCommander = (t: TerritoryState, playerId: number): TerritoryState => ({ ...t, specialUnits: [commander(playerId)] });
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const why = (p: TurnPlan) => p.rationale.join('\n');
const warned = (p: TurnPlan) => p.warnings.join('\n');
/** What the plan's orders leave on my `t`: its armies, deploys and transfers in, less every order out. */
const endsAt = (p: TurnPlan, input: PlanInput, t: number) =>
  p.moves.reduce(
    (n, m) => n - (m.from === t ? m.armies : 0) + (m.kind === 'transfer' && m.to === t ? m.armies : 0),
    (input.board.territories.find((x) => x.territoryId === t)?.armies ?? 0) + deployedTo(p, t),
  );
const truce = (over: Partial<PlanRelation> = {}): PlanRelation => ({
  player: PARTNER,
  coveredMine: [1],
  coveredTheirs: [2],
  state: 'active',
  trust: 'clear',
  ...over,
});

// T1 (24) faces the partner's 40 on T2; T3 (2) beside the 4-army neutral T4 completes B900 (+3).
// The other player sits far away on T9. Income 5: holding T1 against the partner's 39 movable
// plus its ~5 deploy takes 3, and the capture of T4 takes all 5.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 9],
    [
      [1, 2],
      [1, 3],
      [3, 4],
      [4, 5],
      [5, 9],
    ],
    [[900, 3, [3, 4]]],
  ),
);
const at = (t1: TerritoryState = mine(1, 24)) =>
  board([t1, enemy(2, 40, PARTNER), mine(3, 2), neutral(4, 4), neutral(5, 2), enemy(9, 3, OTHER)]);
const input = (relations?: PlanRelation[], over: Partial<PlanInput> = {}): PlanInput => ({
  graph: g,
  board: at(),
  me: ME,
  income: 5,
  settings: STD,
  game: { players: FFA, turn: 8 },
  options: { adapt: true, enemyDeploy: 5 },
  ...(relations ? { relations } : {}),
  ...over,
});

describe('B2 T2: a truce hold frees armies', () => {
  it('without a truce the hold on T1 takes the income and B900 waits', () => {
    const p = planTurn(input());
    expect(deployedTo(p, 1)).toBeGreaterThanOrEqual(3);
    expect(p.expected.bonusesCompleted).toEqual([]);
    expect(p.relations).toBeUndefined();
  });

  it('a truce frees the armies that complete a bonus elsewhere', () => {
    const p = planTurn(input([truce()]));
    expect(deployedTo(p, 1)).toBe(0);
    expect(p.expected.bonusesCompleted).toEqual([900]);
    expect(attacks(p).map((m) => m.to)).toEqual([4]);
    // T1 still holds against the partner's 39 movable armies attacking with no deploy.
    expect(endsAt(p, input([truce()]), 1)).toBe(24);
    expect(p.relations).toEqual([
      {
        player: PARTNER,
        state: 'active',
        honoured: true,
        enforced: false,
        trust: 'clear',
        flags: [],
        relaxed: [1],
        fullHold: [],
        armiesFreed: 3,
        lossIfBroken: expect.objectContaining({ from: 2, to: 1 }),
      },
    ]);
    expect(why(p)).toMatch(/T1 \(#1\) faces only player 20, so it is held against its visible stacks there attacking with no deploy \(T2\).*3 armies freed/);
  });

  it('a relaxed border conceded with or without the truce frees nothing', () => {
    // T1 (2) cannot be held against the partner's 39 movable armies, deploy or not: the plan without
    // the truce concedes it too, so the truce frees no army there.
    const b = { board: at(mine(1, 2)) };
    const plain = planTurn(input(undefined, b));
    const p = planTurn(input([truce()], b));
    expect(plain.conceded).toContain(1);
    expect(p.conceded).toContain(1);
    expect(p.relations![0]).toMatchObject({ relaxed: [1], armiesFreed: 0 });
    expect(why(p)).toMatch(/0 armies freed this turn/);
  });

  it('the partner massing (trust watch) restores the full hold', () => {
    const p = planTurn(input([truce({ trust: 'watch', watch: ['massing'] })]));
    expect(deployedTo(p, 1)).toBeGreaterThanOrEqual(3);
    expect(p.expected.bonusesCompleted).toEqual([]);
    expect(p.relations![0]).toMatchObject({ honoured: true, relaxed: [], fullHold: [{ territory: 1, why: 'watch' }], armiesFreed: 0 });
    expect(why(p)).toMatch(/T1 \(#1\) keeps its full hold against player 20's deploy: the trust is watch \(massing\) \(T3\)/);
  });

  it("my commander's border is never thinned", () => {
    const b = at(withCommander(mine(1, 24), ME));
    const plain = planTurn(input(undefined, { board: b }));
    const p = planTurn(input([truce()], { board: b }));
    expect(p.relations![0]).toMatchObject({ relaxed: [], fullHold: [{ territory: 1, why: 'commander' }] });
    expect(p.deploys).toEqual(plain.deploys);
    expect(p.expected.bonusesCompleted).toEqual(plain.expected.bonusesCompleted);
  });

  it('a valuable border is never thinned', () => {
    // T1 alone is B901 (+2), above TRUCE_RELAX_VALUE × my income of 5.
    expect(TRUCE_RELAX_VALUE).toBe(0.25);
    const g2 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 9],
        [
          [1, 2],
          [1, 3],
          [3, 4],
          [4, 5],
          [5, 9],
        ],
        [
          [900, 3, [3, 4]],
          [901, 2, [1]],
        ],
      ),
    );
    const plain = planTurn(input(undefined, { graph: g2 }));
    const p = planTurn(input([truce()], { graph: g2 }));
    expect(p.relations![0]).toMatchObject({ relaxed: [], fullHold: [{ territory: 1, why: 'value' }] });
    expect(deployedTo(p, 1)).toBe(deployedTo(plain, 1));
    expect(deployedTo(p, 1)).toBeGreaterThanOrEqual(3);
  });

  it('the endgame restores the full holds and advises giving notice', () => {
    const p = planTurn(input([truce({ trust: 'watch', watch: ['endgame'], agreement: 'a1' })]));
    expect(deployedTo(p, 1)).toBeGreaterThanOrEqual(3);
    expect(p.relations![0]!.fullHold).toEqual([{ territory: 1, why: 'watch' }]);
    expect(p.advice).toEqual([{ kind: 'give-notice', player: PARTNER, agreement: 'a1', why: expect.stringMatching(/endgame/) }]);
    expect(warned(p)).toMatch(/Truce with player 20 \(agreement a1\): give notice \(T7\)/);
  });

  it('outgrowing advises notice too; massing does not', () => {
    expect(planTurn(input([truce({ trust: 'watch', watch: ['outgrowing'] })])).advice).toEqual([
      { kind: 'give-notice', player: PARTNER, why: 'player 20 is outgrowing me' },
    ]);
    expect(planTurn(input([truce({ trust: 'watch', watch: ['massing'] })])).advice).toBeUndefined();
    // Notice I already gave: no advice to give it again.
    expect(planTurn(input([truce({ state: 'notice', noticeBy: 'me', endsTurn: 10, trust: 'watch', watch: ['endgame'] })])).advice).toBeUndefined();
  });
});

// My 20 on T1 beside the partner's weak T2 (1 army), all of its B902 (+5), and its T6 (1) beside
// T1 too, uncovered; the partner's T7 is out of my reach, so it cannot be finished off.
describe('B2 T1: no pass targets a covered territory', () => {
  const g3 = buildGraph(
    makeMap(
      [1, 2, 3, 4, 6, 7, 9],
      [
        [1, 2],
        [1, 3],
        [1, 6],
        [2, 7],
        [3, 4],
        [4, 9],
      ],
      [
        [902, 5, [2]],
        [903, 1, [3, 4]],
      ],
    ),
  );
  const weak = (t2: TerritoryState = enemy(2, 1, PARTNER)) =>
    board([mine(1, 20), t2, mine(3, 2), neutral(4, 2), enemy(6, 1, PARTNER), enemy(7, 2, PARTNER), enemy(9, 3, OTHER)]);
  const base = (relations: PlanRelation[] | undefined, options: PlanInput['options'] = {}, b = weak()): PlanInput => ({
    graph: g3,
    board: b,
    me: ME,
    income: 6,
    settings: STD,
    game: { players: FFA, turn: 8 },
    options: { enemyDeploy: 3, ...options },
    ...(relations ? { relations } : {}),
  });

  // Each pass that attacks T2 without a truce — the balanced break, complete-bonus, a commander
  // strike (rule 1s), the guard-off break (#165) — and the goals that do not.
  const variants: [string, PlanInput['options'], () => ReturnType<typeof weak>, boolean, boolean][] = [
    ['balanced', { goal: 'balanced' }, () => weak(), true, true],
    ['complete-bonus', { goal: 'complete-bonus' }, () => weak(), true, true],
    ['a commander on it', { adapt: true }, () => weak(withCommander(enemy(2, 1, PARTNER), PARTNER)), true, true],
    ['the guard off and it empty', { adapt: true }, () => weak(enemy(2, 0, PARTNER)), false, true],
    ['adapting', { adapt: true }, () => weak(), true, false],
    ['defend', { goal: 'defend' }, () => weak(), true, false],
    ['expand', { goal: 'expand' }, () => weak(), true, false],
  ];
  for (const [name, options, b, guard, plainAttacks] of variants)
    it(`no attack on it — ${name}`, () => {
      const settings = { ...STD, oneArmyStandsGuard: guard };
      const plain = planTurn({ ...base(undefined, options, b()), settings });
      expect(attacks(plain).map((m) => m.to).includes(2)).toBe(plainAttacks);
      const p = planTurn({ ...base([truce()], options, b()), settings });
      expect(attacks(p).map((m) => m.to)).not.toContain(2);
      expect(p.relations![0]!.honoured).toBe(true);
    });

  it('an uncovered territory of the partner stays a target', () => {
    // A truce covering only T6 leaves T2 an ordinary territory: its break is made.
    const p = planTurn(base([truce({ coveredTheirs: [6] })], { goal: 'balanced' }));
    expect(attacks(p).map((m) => m.to)).toContain(2);
    expect(attacks(p).map((m) => m.to)).not.toContain(6);
  });

  it('finishing the partner off would take a covered territory: it is not planned', () => {
    // The partner holds only T2 and T6, both next to me: without a truce it is finished off.
    const lone = board([mine(1, 20), enemy(2, 1, PARTNER), mine(3, 2), neutral(4, 2), enemy(6, 1, PARTNER), neutral(7, 2), enemy(9, 3, OTHER)]);
    expect(attacks(planTurn(base(undefined, { adapt: true }, lone))).map((m) => m.to)).toEqual(expect.arrayContaining([2, 6]));
    const p = planTurn(base([truce()], { adapt: true }, lone));
    expect(attacks(p).map((m) => m.to)).not.toContain(2);
  });

  it('notice binds until its turn, then the partner is an ordinary opponent', () => {
    const notice = truce({ state: 'notice', noticeBy: 'me', endsTurn: 9 });
    const before = planTurn(base([notice], { goal: 'balanced' }));
    expect(attacks(before).map((m) => m.to)).not.toContain(2);
    expect(before.relations![0]).toMatchObject({ state: 'notice', honoured: true, endsTurn: 9 });
    expect(why(before)).toMatch(/in notice given by me: binding until turn 9/);
    const after = planTurn({ ...base([notice], { goal: 'balanced' }), game: { players: FFA, turn: 9 } });
    expect(attacks(after).map((m) => m.to)).toContain(2);
    expect(after.relations![0]).toMatchObject({ state: 'over', honoured: false });
    expect(why(after)).toMatch(/its notice ran out on turn 9, so player 20 is an ordinary opponent this turn \(T7\)/);
  });

  it('a break by them makes the partner an ordinary opponent the same turn, and says how', () => {
    const broken = truce({
      state: 'broken',
      trust: 'watch',
      watch: ['broken'],
      breach: { term: 'took a covered territory of mine', turn: 7, evidence: 'T5 was mine on turn 6 and is player 20\'s on turn 7', territories: [3] },
    });
    const plain = planTurn(base(undefined, { goal: 'balanced' }));
    const p = planTurn(base([broken], { goal: 'balanced' }));
    expect(attacks(p).map((m) => m.to)).toContain(2);
    expect(p.moves).toEqual(plain.moves);
    expect(p.deploys).toEqual(plain.deploys);
    expect(p.relations![0]).toMatchObject({ state: 'broken', honoured: false });
    expect(warned(p)).toMatch(
      /Truce with player 20 is broken by them: took a covered territory of mine on turn 7 \(T3 \(#3\)\) — T5 was mine on turn 6 and is player 20's on turn 7\. Player 20 is planned as an ordinary opponent from this turn \(T8\)/,
    );
  });

  it('an enforced truce (T9): no threat from that player and no attack on any of its territories', () => {
    const p = planTurn(base([truce({ enforced: true, coveredTheirs: [] })], { adapt: true }));
    expect(attacks(p).map((m) => m.to)).not.toContain(2);
    expect(attacks(p).map((m) => m.to)).not.toContain(6);
    expect(p.relations![0]).toMatchObject({ enforced: true, honoured: true });
    expect(why(p)).toMatch(/a Diplomacy card is in effect, so player 20's attacks on me do nothing this turn/);
  });
});

describe('B2 T9: an enforced truce zeroes the threat', () => {
  it('the border facing only that player gets no hold', () => {
    const p = planTurn(input([truce({ enforced: true })]));
    expect(deployedTo(p, 1)).toBe(0);
    expect(p.warnings.join('\n')).not.toMatch(/T1 \(#1\) \(24 armies\) could be taken/);
  });
});

describe('B2 T5: the border cap', () => {
  it('moves the excess back one step and says so', () => {
    const i = input([truce({ borderCap: 10 })]);
    const p = planTurn(i);
    expect(endsAt(p, i, 1)).toBe(10);
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 1, to: 3, armies: 14, kind: 'transfer' }));
    expect(p.relations![0]!.capMoved).toEqual([{ from: 1, to: 3, armies: 14 }]);
    expect(why(p)).toMatch(/Truce with player 20 \(border cap 10\): T1 \(#1\) already stands above the cap with 24, so move 14 back to T3 \(#3\), toward another front \(T5\)/);
  });

  it('a deploy that would break the cap lands one step behind instead', () => {
    // The partner massing keeps T1's full hold (all 5 deployed there), but the cap is 25: the
    // deploys above it go to T3.
    const i = input([truce({ borderCap: 25, trust: 'watch', watch: ['massing'] })]);
    const p = planTurn(i);
    expect(endsAt(p, i, 1)).toBe(25);
    expect(why(p)).toMatch(/my orders would leave more than 25 on T1 \(#1\), so deploy \d+ on T3 \(#3\) instead/);
  });
});

describe('B2 T5: no order of mine fills a capped border past its cap (B2a review)', () => {
  // A line: the partner's T2 (10) and player 30's T4 (10) both border my T5 (12), the truce's capped
  // border; behind it my T6 (8, idle), T7 (1), T8 (3), then player 30's T9 (2). From T6 the nearest
  // front is T4, through T5. Rule 6 used to send T6's idle armies into T5, and the cap then moved them
  // straight back: opposite transfers, and a warning blaming armies my own orders had moved in.
  const g7 = buildGraph(
    makeMap(
      [2, 4, 5, 6, 7, 8, 9],
      [
        [2, 5],
        [4, 5],
        [5, 6],
        [6, 7],
        [7, 8],
        [8, 9],
      ],
      [],
    ),
  );
  const line = (relations?: PlanRelation[]): PlanInput => ({
    graph: g7,
    board: board([enemy(2, 10, PARTNER), enemy(4, 10, OTHER), mine(5, 12), mine(6, 8), mine(7, 1), mine(8, 3), enemy(9, 2, OTHER)]),
    me: ME,
    income: 5,
    settings: STD,
    game: { players: FFA, turn: 8 },
    options: { adapt: true, enemyDeploy: 3 },
    ...(relations ? { relations } : {}),
  });
  const capped = (borderCap: number) => truce({ coveredMine: [5], coveredTheirs: [2], borderCap });
  const both = (p: TurnPlan) =>
    p.moves.filter((m) => m.kind === 'transfer' && p.moves.some((x) => x.kind === 'transfer' && x.from === m.to && x.to === m.from));

  it('without the truce the idle stack walks into T5, toward player 30', () => {
    const p = planTurn(line());
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 6, to: 5, armies: 7, kind: 'transfer' }));
  });

  it('at the cap, the idle stack stays and the hold deploy lands one step behind: nothing moves both ways', () => {
    const i = line([capped(12)]);
    const p = planTurn(i);
    expect(both(p)).toEqual([]);
    expect(p.moves.some((m) => m.kind === 'transfer' && m.to === 5)).toBe(false);
    expect(endsAt(p, i, 5)).toBe(12);
    expect(warned(p)).not.toMatch(/border cap/);
  });

  it('with room under the cap, only what fits moves in, and the plan says why the rest stay', () => {
    const i = line([capped(17)]);
    const p = planTurn(i);
    expect(both(p)).toEqual([]);
    // T5 holds with 3 deployed (15), so 2 of T6's idle armies fit under the cap of 17.
    expect(deployedTo(p, 5)).toBe(3);
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 6, to: 5, armies: 2, kind: 'transfer' }));
    expect(endsAt(p, i, 5)).toBe(17);
    expect(why(p)).toMatch(/Transfer 2 from T6 \(#6\) to T5 \(#5\): moves idle interior armies toward the front \(the rest stay: a truce caps the armies on T5 \(#5\) at what this leaves there\)/);
    expect(warned(p)).not.toMatch(/border cap/);
  });
});

describe('B2 T5: a withdrawal never fills a capped border past its cap (B2a review)', () => {
  // My T3 (4) faces player 30's T4 (30) and is conceded; it withdraws to T1 (10), the truce's capped
  // border beside the partner's T2, or to T6 (2) on the other side when there is one.
  const g9 = (withT6: boolean) =>
    buildGraph(
      makeMap(
        withT6 ? [1, 2, 3, 4, 6, 7] : [1, 2, 3, 4],
        [
          [1, 2],
          [1, 3],
          [3, 4],
          ...(withT6 ? ([[3, 6], [6, 7]] as [number, number][]) : []),
        ],
        [],
      ),
    );
  const conceding = (withT6: boolean, t2: number, relations?: PlanRelation[]): PlanInput => ({
    graph: g9(withT6),
    board: board([mine(1, 10), enemy(2, t2, PARTNER), mine(3, 4), enemy(4, 30, OTHER), ...(withT6 ? [mine(6, 2), neutral(7, 2)] : [])]),
    me: ME,
    income: 5,
    settings: STD,
    game: { players: FFA, turn: 8 },
    options: { adapt: true, enemyDeploy: 3 },
    ...(relations ? { relations } : {}),
  });
  const capped = (borderCap: number, over: Partial<PlanRelation> = {}) => truce({ coveredMine: [1], borderCap, ...over });
  const withdrawals = (p: TurnPlan) => p.moves.filter((m) => m.reason === 'withdraws from a conceded border');

  it('without the truce T3 withdraws to T1; at its cap, to T6 instead', () => {
    expect(withdrawals(planTurn(conceding(true, 6))).map((m) => m.to)).toEqual([1]);
    const i = conceding(true, 6, [capped(10)]);
    const p = planTurn(i);
    expect(withdrawals(p)).toEqual([expect.objectContaining({ from: 3, to: 6, armies: 3 })]);
    expect(endsAt(p, i, 1)).toBe(10);
  });

  it('with no other neighbour the armies stay, and the warning says a truce caps the border', () => {
    const p = planTurn(conceding(false, 14, [capped(11, { trust: 'watch', watch: ['massing'] })]));
    expect(withdrawals(p)).toEqual([]);
    expect(warned(p)).toMatch(/T3 \(#3\) is conceded and has nowhere to withdraw to \(a truce caps the armies on the borders beside it\): its 3 movable armies stay\./);
  });

  it('a withdrawal a later deploy pushes past the cap is taken back, its lines with it', () => {
    // At rule 1b T1 has room for the 3; the leftover deploy lands there later, and T1 has no step
    // behind (T3 is conceded): the deploy stays, the withdrawal goes.
    const i = conceding(false, 14, [capped(13)]);
    const p = planTurn(i);
    expect(deployedTo(p, 1)).toBe(5);
    expect(withdrawals(p)).toEqual([]);
    expect(why(p)).toMatch(/Truce with player 20 \(border cap 13\): my orders would leave more than 13 on T1 \(#1\), so move 3 fewer from T3 \(#3\) into it \(T5\)\./);
    expect(why(p)).not.toMatch(/Withdraw 3 from T3/);
    expect(warned(p)).not.toMatch(/The withdrawal from T3/);
    expect(warned(p)).toMatch(/leave 2 above the agreed border cap of 13 on T1 \(#1\): this plan's own deploy of 5 there \(for its hold, or the leftover\) is what exceeds it/);
  });
});

describe('B2 T5: a hold deploy above the cap with no step behind is named in the warning (B2a review)', () => {
  // My only territory T1 (24) faces only the partner's T2 (40); T9 belongs to player 30, beyond T2.
  // The partner massing keeps T1's full hold (T3): all 5 deployed there, above the cap of 25, and
  // there is no territory of mine behind it to take them.
  const g8 = buildGraph(
    makeMap(
      [1, 2, 9],
      [
        [1, 2],
        [2, 9],
      ],
      [],
    ),
  );
  const alone = (t1: number): PlanInput => ({
    graph: g8,
    board: board([mine(1, t1), enemy(2, 40, PARTNER), enemy(9, 3, OTHER)]),
    me: ME,
    income: 5,
    settings: STD,
    game: { players: FFA, turn: 8 },
    options: { adapt: true, enemyDeploy: 5 },
    relations: [truce({ borderCap: 25, trust: 'watch', watch: ['massing'] })],
  });

  it("says the plan's own deploy, sized for the hold, is what exceeds the cap", () => {
    const p = planTurn(alone(24));
    expect(deployedTo(p, 1)).toBe(5);
    expect(warned(p)).toMatch(
      /Truce with player 20: my orders leave 4 above the agreed border cap of 25 on T1 \(#1\): this plan's own deploy of 5 there \(for its hold, or the leftover\) is what exceeds it, and no territory of mine one step behind can take it, so these orders break a term of the truce — keep it by deploying less there, or give notice \(notice-by-me\) and ask the owner before exceeding the cap; never break it silently\./,
    );
  });

  it('and the armies already standing there when they too are above it', () => {
    const p = planTurn(alone(26));
    expect(warned(p)).toMatch(/this plan's own deploy of 5 there \(for its hold, or the leftover\), on top of the 26 already standing there, is what exceeds it/);
  });
});

describe('B2 T4: the partner is no second front', () => {
  // Rule 0p.2's scenario: my T1 (6) beside a 2-army neutral T2 (B821 +3) and player 20's T5 (2),
  // all of its B822 (+8). Player 30, far away on T9, is the partner: with the truce, player 20 is
  // my only front, so breaking its bonus is no second front.
  const g4 = buildGraph(
    makeMap(
      [1, 2, 5, 6, 9],
      [
        [1, 2],
        [1, 5],
        [5, 6],
      ],
      [
        [821, 3, [2]],
        [822, 8, [5]],
      ],
    ),
  );
  const i = (relations?: PlanRelation[]): PlanInput => ({
    graph: g4,
    board: board([mine(1, 6), neutral(2, 2), enemy(5, 2, PARTNER), enemy(6, 2, PARTNER), enemy(9, 2, OTHER)]),
    me: ME,
    income: 11,
    settings: STD,
    game: { players: FFA, turn: 6 },
    options: { opponents: 2, enemyDeploy: 5, reserve: 6, adapt: true },
    ...(relations ? { relations } : {}),
  });

  it('without the truce: no second front, the neutral only', () => {
    const p = planTurn(i());
    expect(attacks(p).map((m) => m.to)).toEqual([2]);
    expect(why(p)).toMatch(/no second front/);
  });

  it('with a truce with the far player, the break is made', () => {
    const p = planTurn(i([{ player: OTHER, coveredMine: [], coveredTheirs: [9], state: 'active', trust: 'clear' }]));
    expect(attacks(p).map((m) => m.to).sort()).toEqual([2, 5]);
    expect(why(p)).not.toMatch(/no second front/);
  });

  it('a truce with a player who is out takes no front away (B2a review)', () => {
    // Player 40 is on the list but eliminated: the profile counts two opponents (20 and 30), and a
    // truce given directly with 40 must not bring that down to one.
    const out = { ...i([{ player: 40, coveredMine: [], coveredTheirs: [], state: 'active', trust: 'clear' }]) };
    out.game = { ...out.game, players: [...FFA, { id: 40, state: 'Eliminated' }] };
    const p = planTurn(out);
    expect(attacks(p).map((m) => m.to)).toEqual([2]);
    expect(why(p)).toMatch(/no second front/);
  });
});

describe('B2 T4: idle armies do not walk toward a covered territory (rule 6)', () => {
  // A line: the partner's T2 (10) — my T5 (12) — my T6 (8, idle) — my T7 (1) — my T8 (3) — player
  // 30's T9 (2). From T6 the partner's T2 is two steps away, player 30's T9 three. The truce covers
  // T2 and my T5.
  const g5 = buildGraph(
    makeMap(
      [2, 5, 6, 7, 8, 9],
      [
        [2, 5],
        [5, 6],
        [6, 7],
        [7, 8],
        [8, 9],
      ],
      [],
    ),
  );
  const line = (relations?: PlanRelation[]): PlanInput => ({
    graph: g5,
    board: board([enemy(2, 10, PARTNER), mine(5, 12), mine(6, 8), mine(7, 1), mine(8, 3), enemy(9, 2, OTHER)]),
    me: ME,
    income: 5,
    settings: STD,
    game: { players: FFA, turn: 8 },
    options: { adapt: true, enemyDeploy: 3 },
    ...(relations ? { relations } : {}),
  });
  const covering = truce({ coveredMine: [5], coveredTheirs: [2] });
  const transfersFrom = (p: TurnPlan, t: number) => p.moves.filter((m) => m.kind === 'transfer' && m.from === t);

  it('without the truce, the interior stack heads for the partner, its nearest foe', () => {
    const p = planTurn(line());
    expect(transfersFrom(p, 6).map((m) => m.to)).toEqual([5]);
  });

  it('with the truce, it heads for the other front instead', () => {
    const p = planTurn(line([covering]));
    expect(transfersFrom(p, 6).map((m) => m.to)).toEqual([7]);
    expect(p.moves.some((m) => m.to === 2)).toBe(false);
  });

  it('the territory beside the covered one keeps its truce-level hold', () => {
    const i = line([covering]);
    const p = planTurn(i);
    // T5 is no front with the truce (player 30's T9 is four steps away), so rule 6 may move armies
    // off it, but never below what holds it against the partner's 9 movable armies with no deploy.
    expect(p.relations![0]!.relaxed).toEqual([5]);
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 5, to: 6, armies: 6, kind: 'transfer' }));
    expect(endsAt(p, i, 5)).toBe(6);
    expect(why(p)).toMatch(/Transfer 6 from T5 \(#5\) to T6 \(#6\): moves idle interior armies toward the front \(6 stay: they hold it beside a truce's covered territory\)/);
  });

  it('a stack beside a covered territory stages toward a capture, keeping its truce-level hold (#125)', () => {
    // economy.test.ts's #125 staging scenario (30/75 kill rates): T5, a 4-neutral, is the last member
    // of B100 (+5); my 11 on T3 is two steps from it. Here T3 also borders the partner's T11 (6):
    // without the truce it faces an enemy and stays; with it, it stages but keeps what holds T3
    // against the partner's 5 movable armies with no deploy.
    const R = { offensiveKillRate: 30, defensiveKillRate: 75, oneArmyStandsGuard: true };
    const g6 = buildGraph(
      makeMap(
        [1, 2, 3, 5, 6, 7, 8, 9, 10, 11],
        [
          [1, 2],
          [2, 5],
          [2, 3],
          [3, 6],
          [3, 7],
          [1, 8],
          [8, 9],
          [9, 10],
          [3, 11],
        ],
        [[100, 5, [1, 2, 5]]],
      ),
    );
    const stage = (relations?: PlanRelation[]): PlanInput => ({
      graph: g6,
      board: board([
        mine(1, 1),
        mine(2, 1),
        mine(3, 11),
        neutral(5, 4),
        neutral(6, 4),
        neutral(7, 4),
        neutral(8, 4),
        neutral(9, 4),
        enemy(10, 5, OTHER),
        enemy(11, 6, PARTNER),
      ]),
      me: ME,
      income: 5,
      settings: R,
      game: { players: FFA, turn: 4 },
      options: { adapt: true, enemyDeploy: 3 },
      ...(relations ? { relations } : {}),
    });
    const plain = planTurn(stage());
    expect(plain.moves.filter((m) => m.from === 3)).toEqual([]);
    const i = stage([truce({ coveredMine: [3], coveredTheirs: [11] })]);
    const p = planTurn(i);
    // 3 on T3 need 10 to take at a 30% offensive kill rate: above the partner's 5 movable.
    expect(p.moves).toEqual([expect.objectContaining({ from: 3, to: 2, armies: 8, kind: 'transfer' })]);
    expect(endsAt(p, i, 3)).toBe(3);
    expect(why(p)).toMatch(/Move 8 from T3 \(#3\) to T2 \(#2\): stages toward T5 \(#5\).*; the rest stay: they hold it beside a truce's covered territory\./);
  });
});

// T6: the partner lands its whole estimated deploy on its covered border and attacks, against this
// plan's own orders, on the turn simulator (turn-sim.ts).
describe('B2 T6: what a break would cost', () => {
  it("the partner's 40 and its 5 deploy take T1, whose 24 the truce hold left alone", () => {
    const p = planTurn(input([truce({ agreement: 'a1' })]));
    expect(p.relations![0]!.lossIfBroken).toEqual({
      from: 2,
      to: 1,
      deploy: 5,
      attackers: 44,
      territories: [1],
      armies: 24,
      bonuses: [],
      bonusValue: 0,
      commanderLost: false,
      exact: true,
    });
    expect(why(p)).toMatch(
      /Truce with player 20 \(agreement a1\): if it broke this turn — its ~5 deploy on T2 \(#2\) and an attack on T1 \(#1\) with 44 — I would lose T1 \(#1\), 24 armies and \+0 income \(T6\)\./,
    );
  });

  it('a break that takes a held bonus counts its income, and the costliest covered border is the one reported', () => {
    // T3 (2) alone is B903 (+1) and also faces the partner's 30 on T6, both covered: T3 cannot be
    // held, and losing it costs income where losing T1 costs only armies.
    const g6 = buildGraph(
      makeMap(
        [1, 2, 3, 4, 5, 6, 9],
        [
          [1, 2],
          [1, 3],
          [3, 4],
          [3, 6],
          [4, 5],
          [5, 9],
        ],
        [
          [900, 3, [3, 4]],
          [903, 1, [3]],
        ],
      ),
    );
    const b = board([mine(1, 24), enemy(2, 40, PARTNER), mine(3, 2), neutral(4, 4), neutral(5, 2), enemy(6, 30, PARTNER), enemy(9, 3, OTHER)]);
    const p = planTurn(input([truce({ coveredMine: [1, 3], coveredTheirs: [2, 6] })], { graph: g6, board: b }));
    const loss = p.relations![0]!.lossIfBroken!;
    expect(loss).toMatchObject({ from: 6, to: 3, deploy: 5 });
    expect(loss.territories).toContain(3);
    expect(loss.bonuses.map((x) => x.id)).toContain(903);
    expect(loss.bonusValue).toBeGreaterThanOrEqual(1);
  });

  it('a relation that does not bind, or with no covered stack of the partner beside a covered territory of mine, costs nothing to report', () => {
    expect(planTurn(input([truce({ state: 'broken' })])).relations![0]!.lossIfBroken).toBeNull();
    expect(planTurn(input([truce({ coveredTheirs: [] })])).relations![0]!.lossIfBroken).toBeNull();
    expect(planTurn(input([truce({ enforced: true })])).relations![0]!.lossIfBroken).toBeNull();
  });

  it('the plan with no relations is unchanged by it', () => {
    expect(planTurn(input()).relations).toBeUndefined();
  });
});

describe('B2: truces only in a free-for-all; none given changes nothing', () => {
  it('an empty list plans exactly what no list does', () => {
    expect(planTurn(input([]))).toEqual(planTurn(input()));
  });

  it('holding no territory, the plan still reports each truce given', () => {
    const none = board([enemy(1, 5, OTHER), enemy(2, 40, PARTNER), neutral(3, 2), neutral(4, 4), neutral(5, 2), enemy(9, 3, OTHER)]);
    const p = planTurn(input([truce()], { board: none }));
    expect(p.deploys).toEqual([]);
    expect(p.moves).toEqual([]);
    expect(p.relations).toEqual([
      { player: PARTNER, state: 'active', honoured: true, enforced: false, trust: 'clear', flags: [], relaxed: [], fullHold: [], armiesFreed: 0, lossIfBroken: null },
    ]);
    expect(planTurn(input(undefined, { board: none })).relations).toBeUndefined();
  });

  it('in a two-player game a truce is ignored with a warning, the plan otherwise unchanged', () => {
    const two = { players: [{ id: ME }, { id: PARTNER }], turn: 8 };
    const b = board([mine(1, 24), enemy(2, 40, PARTNER), mine(3, 2), neutral(4, 4), neutral(5, 2), neutral(9, 3)]);
    const plain = planTurn(input(undefined, { game: two, board: b }));
    const p = planTurn(input([truce()], { game: two, board: b }));
    expect(p.moves).toEqual(plain.moves);
    expect(p.deploys).toEqual(plain.deploys);
    expect(p.relations![0]).toMatchObject({ state: 'ignored', honoured: false });
    expect(warned(p)).toMatch(/Truces ignored \(B2\): only two players are in this game/);
  });

  it('in a team game too', () => {
    const teams = { players: [{ id: ME, team: 0 }, { id: 11, team: 0 }, { id: PARTNER, team: 1 }, { id: OTHER, team: 1 }], turn: 8 };
    const p = planTurn(input([truce()], { game: teams }));
    expect(p.relations![0]!.state).toBe('ignored');
    expect(warned(p)).toMatch(/this is a team game/);
  });
});

describe('B2 T5: a capped border that also faces another opponent (B2a review)', () => {
  // My T1 (30) faces the partner's T2 (40) and player 30's T6 (20); T3 (2) sits behind T1, beside
  // the neutral T4. Without the truce T1 holds against player 30; the cap of 10 moves its armies
  // back and leaves T1 short against player 30's 19 movable plus ~5 deploy — the plan keeps the
  // term but says T1 no longer holds, and against whom.
  const g9 = buildGraph(
    makeMap(
      [1, 2, 3, 4, 6],
      [
        [1, 2],
        [1, 6],
        [1, 3],
        [3, 4],
      ],
      [],
    ),
  );
  const both = (relations?: PlanRelation[]): PlanInput => ({
    graph: g9,
    board: board([mine(1, 30), enemy(2, 40, PARTNER), mine(3, 2), neutral(4, 4), enemy(6, 20, OTHER)]),
    me: ME,
    income: 5,
    settings: STD,
    game: { players: FFA, turn: 8 },
    options: { adapt: true, enemyDeploy: 5 },
    ...(relations ? { relations } : {}),
  });

  it('without the truce T1 holds against player 30', () => {
    const p = planTurn(both());
    expect(warned(p)).not.toMatch(/T1 \(#1\).*does not hold/);
  });

  it('with the cap the plan keeps the term and warns that T1 no longer holds against player 30', () => {
    const i = both([truce({ borderCap: 10 })]);
    const p = planTurn(i);
    expect(endsAt(p, i, 1)).toBe(10);
    expect(why(p)).not.toMatch(/toward another front/);
    expect(warned(p)).toMatch(
      /Truce with player 20 \(border cap 10\): T1 \(#1\) also faces player 30, and the 10 the cap leaves there do not hold it — its hold needs \d+ against player 30's ~\d+\. Keep the term, or give notice \(notice-by-me\) and ask the owner before exceeding the cap; never break it silently\./,
    );
    expect(warned(p)).not.toMatch(/breaks a term/);
  });
});

describe('B2 T5: Local Deployment leaves no room one step behind (B2a review)', () => {
  // My T1 (24) is B901 (+5) on its own, facing the partner's T2 (40); T3 (2) sits behind it. The whole
  // income is B901's pool, so the deploy cannot land on T3: the warning names the pool's room.
  const g10 = buildGraph(
    makeMap(
      [1, 2, 3, 9],
      [
        [1, 2],
        [1, 3],
        [2, 9],
      ],
      [[901, 5, [1]]],
    ),
  );
  it('says the pool had no room on the step', () => {
    const p = planTurn({
      graph: g10,
      board: board([mine(1, 24), enemy(2, 40, PARTNER), mine(3, 2), enemy(9, 3, OTHER)]),
      me: ME,
      income: 5,
      settings: { ...STD, localDeployments: true },
      game: { players: FFA, turn: 8 },
      options: { adapt: true, enemyDeploy: 5 },
      relations: [truce({ borderCap: 0, trust: 'watch', watch: ['massing'] })],
    });
    expect(deployedTo(p, 3)).toBe(0);
    expect(warned(p)).toMatch(
      /my orders leave 1 above the agreed border cap of 0 on T1 \(#1\) \(Local Deployment: the pools had room for only 0 of the 5 deployed there on T3 \(#3\), and the armies there cannot move again this turn\)/,
    );
  });
});
