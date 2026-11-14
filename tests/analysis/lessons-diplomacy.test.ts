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
      },
    ]);
    expect(why(p)).toMatch(/T1 \(#1\) faces only player 20, so it is held against its visible stacks there attacking with no deploy \(T2\).*3 armies freed/);
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
});

describe('B2: truces only in a free-for-all; none given changes nothing', () => {
  it('an empty list plans exactly what no list does', () => {
    expect(planTurn(input([]))).toEqual(planTurn(input()));
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
