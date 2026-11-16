// #281, the owner's extension (2026-11-16): with One Army Must Stand Guard off, a live opponent's own
// territory beside mine standing at 0 (no special unit) that breaks none of its bonuses (#165's
// one-army break) and was not mine last turn (#276's retake) is cheap expansion. Pass 3 takes it,
// sized for its owner's deploy there (#120) when a source can pay that, else at its bare cost with
// #120's warning; rule 4d does not undo it when the border it adds faces only what my borders beside
// it already face (the front moves one step), but still judges a border to a new stack. Synthetic
// map, made-up ids.
//
//   6 ─ 1 ─ 2 ─ 3        1 mine; 2 A's, empty; 3 A's stack, which 1 already faces (1 ─ 3)
//    \     |             6 a quiet neutral wall (40) behind me; 9 the third player, far off
//     9    4             4 (only in the new-stack shape) a stack 1 does not face
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type PlanRelation, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import type { BoardSpecialUnit } from '../../src/board.js';
import { armiesToTake, COMMANDER_STRENGTH } from '../../src/analysis/combat.js';
import { commanderSafety } from '../../src/analysis/commander-safety.js';
import { CHEAP_EXPANSION } from '../../src/analysis/plan/vacated.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const OTHER = 40;
const OFF: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: false, baseIncome: 5 };
const ON: PlannerSettings = { ...OFF, oneArmyStandsGuard: true };

const held = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

function makeMap(ids: number[], edges: [number, number][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic empty enemy',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [],
    distributionModes: [],
  };
}

const players = [
  { id: ME, state: 'Playing' },
  { id: A, state: 'Playing' },
  { id: OTHER, state: 'Playing' },
];
const edges: [number, number][] = [
  [6, 1],
  [1, 2],
  [2, 3],
  [1, 3],
  [1, 7],
  [3, 5],
  [6, 9],
];
const G = buildGraph(makeMap([1, 2, 3, 5, 6, 7, 9], edges));
/** The new-stack shape: T2 also borders A's T4, which no territory of mine faces. */
const G4 = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7, 9], [...edges, [2, 4]]));

const at = (t1 = 30, extra: TerritoryState[] = []) =>
  board([mine(1, t1), held(2, 0, A), held(3, 20, A), held(5, 30, A), neutral(6, 40), neutral(7, 1), held(9, 5, OTHER), ...extra]);
function input(b: BoardState, over: Partial<PlanInput> = {}): PlanInput {
  return { graph: G, board: b, me: ME, income: 5, settings: OFF, turn: 14, game: { players, turn: 14 }, options: { adapt: true }, ...over };
}
const attacksOn = (p: TurnPlan, t: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === t);
const said = (p: TurnPlan) => p.rationale.join('\n');

const warned = (p: TurnPlan) => p.warnings.join('\n');
const SHAPE_LINE =
  /Take T2 \(#2\) though it adds a border facing an enemy: One Army Must Stand Guard is off and player 20 left it empty, and the border it adds faces only T3 \(#3\), which my borders beside it already face — the front moves one step, no new exposure \(#281\)\./;

describe("empty enemy territory with the guard off (#281, the owner's extension)", () => {
  it('the shape: an empty enemy territory beside my border, facing the same stack, is taken', () => {
    const p = planTurn(input(at()));
    const [a, ...more] = attacksOn(p, 2);
    expect(more).toEqual([]);
    expect(a).toMatchObject({ from: 1, kind: 'attack' });
    expect(a!.reason).toBe(
      "player 20's territory stands empty with One Army Must Stand Guard off: cheap expansion (#281), sized to land even if player 20 deploys its ~5 there first (#120)",
    );
    // Sized for its owner's ~5 deploy there (#120): 8 take 5 defenders; the #226 margin may add more.
    expect(said(p)).toMatch(/Attack T2 \(#2\) from T1 \(#1\) with 8: player 20's territory stands empty/);
    expect(a!.armies).toBeGreaterThanOrEqual(8);
    expect(said(p)).toMatch(SHAPE_LINE);
    expect(said(p)).not.toMatch(/Do not take T2/);
    expect(warned(p)).not.toMatch(/Attack on enemy T2 \(#2\) assumes/);
    expect(p.expected.captures).toContain(2);
  });

  it('a border to a new stack is still judged by the frontier rule', () => {
    const p = planTurn(input(at(30, [held(4, 12, A)]), { graph: G4 }));
    expect(attacksOn(p, 2)).toEqual([]);
    expect(said(p)).toMatch(/Do not take T2 \(#2\): it adds a border facing an enemy without completing a bonus/);
    expect(said(p)).not.toMatch(/Take T2/);
  });

  it('guard on: unchanged', () => {
    const p = planTurn(input(at(), { settings: ON }));
    expect(attacksOn(p, 2)).toEqual([]);
    expect(said(p)).not.toMatch(/#281/);
  });

  it('when no source can pay the sure size, it goes at its bare cost with #120 warning', () => {
    // T1 holds against T3's 20 + 5 with 16; with 17 and no income it spares one army: the bare 1.
    const p = planTurn(input(at(17), { income: 0 }));
    expect(p.conceded).toEqual([]);
    expect(attacksOn(p, 2)).toEqual([expect.objectContaining({ from: 1, armies: 1 })]);
    expect(said(p)).toMatch(/Attack T2 \(#2\) from T1 \(#1\) with 1: player 20's territory stands empty with One Army Must Stand Guard off: cheap expansion \(#281\)\./);
    expect(warned(p)).toMatch(/Attack on enemy T2 \(#2\) assumes its owner does not reinforce it first/);
  });

  it('never at the expense of a hold', () => {
    // With 16 and no income, every army on T1 is its hold against T3: nothing is spared for T2.
    const p = planTurn(input(at(16), { income: 0 }));
    expect(p.conceded).toEqual([]);
    expect(p.moves).toEqual([]);
  });

  it("never a truce's covered territory", () => {
    const truce: PlanRelation = { player: A, coveredMine: [1], coveredTheirs: [2], state: 'active', trust: 'clear' };
    const p = planTurn(input(at(), { relations: [truce] }));
    expect(attacksOn(p, 2)).toEqual([]);
    expect(said(p)).not.toMatch(/cheap expansion \(#281\)/);
  });

  it('never one my attacks failed on (#240)', () => {
    const repulsed = [
      {
        territoryId: 2,
        playerId: A,
        attacks: [
          { turn: 12, armies: 1, before: 0, after: 4, kills: 0 },
          { turn: 13, armies: 1, before: 0, after: 4, kills: 0 },
        ],
      },
    ];
    const p = planTurn(input(at(), { repulsed }));
    expect(said(p)).toMatch(/My attacks on T2 \(#2\) failed/);
    expect(attacksOn(p, 2)).toEqual([]);
    expect(said(p)).not.toMatch(/cheap expansion \(#281\)/);
  });

  it('never one lowering income', () => {
    // T1 and T2 make a −3 bonus: taking T2 completes it.
    const map = makeMap([1, 2, 3, 5, 6, 7, 9], edges);
    map.bonuses = [{ id: 500, name: 'B500', value: -3, territoryIds: [1, 2], bonusIds: [] }];
    const p = planTurn(input(at(), { graph: buildGraph(map) }));
    expect(attacksOn(p, 2)).toEqual([]);
    expect(said(p)).not.toMatch(/cheap expansion \(#281\)/);
  });

  it('one that was mine last turn is a #276 retake, not this rule', () => {
    const previousBoard = board([mine(1, 30), mine(2, 3), held(3, 20, A), held(5, 30, A), neutral(6, 40), neutral(7, 1), held(9, 5, OTHER)]);
    const p = planTurn(input(at(), { previousBoard }));
    expect(attacksOn(p, 2).map((m) => m.reason)).toEqual([expect.stringMatching(/a retake/)]);
    expect(said(p)).not.toMatch(/cheap expansion \(#281\)/);
  });
});

describe('#281 review: the reason the sweep exempts', () => {
  it('is one exported constant, the end of every empty enemy capture reason', () => {
    expect(CHEAP_EXPANSION).toBe('cheap expansion (#281)');
    const [a] = attacksOn(planTurn(input(at())), 2);
    expect(a!.reason).toContain(`: ${CHEAP_EXPANSION}`);
  });
});

// #281 review: a #276 second line still short when pass 3 runs keeps what it is owed.
//
//   T6 (A 50) ─ T5 (A's stack, 20) ─ T4 (mine, the front) ─ T1 (+5 member, 0) ─ T3 (+5 member, 6)
//                    └─ T7 (A, empty) ─┘          └──────── T2 (+5 member, 0) ─┘
//
// T1 and T2 are interior members of my held +5 bonus two moves from T5's 20 (my income or more):
// each keeps a garrison of one. T7 faces only T5, which T4 already faces: the same front.
describe("#281 review: an empty enemy capture never takes a #276 second line's armies", () => {
  const lineMap = (): GameMap => {
    const map = makeMap([1, 2, 3, 4, 5, 6, 7], [[5, 4], [4, 1], [4, 2], [1, 3], [2, 3], [5, 6], [4, 7], [7, 5]]);
    map.bonuses = [{ id: 101, name: 'B101', value: 5, territoryIds: [1, 2, 3], bonusIds: [] }];
    return map;
  };
  const b = board([mine(1, 0), mine(2, 0), mine(3, 6), mine(4, 20), held(5, 20, A), held(6, 50, A), held(7, 0, A)]);
  const dep = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
  const net = (p: TurnPlan, id: number) =>
    dep(p, id) + p.moves.filter((m) => m.to === id && m.kind === 'transfer').reduce((n, m) => n + m.armies, 0) - p.moves.filter((m) => m.from === id).reduce((n, m) => n + m.armies, 0);

  it('the second line is paid first; the capture takes what is left (here its bare cost, with the #120 warning)', () => {
    const p = planTurn({
      graph: buildGraph(lineMap()),
      board: b,
      me: ME,
      income: 5,
      settings: OFF,
      game: { players: [{ id: ME }, { id: A }], turn: 9 },
      options: { goal: 'balanced', enemyDeploy: 5 },
    });
    expect(said(p)).toMatch(/Second line \(#276\)/);
    // Both short members end the turn with their garrison of one.
    expect(net(p, 1)).toBeGreaterThanOrEqual(1);
    expect(net(p, 2)).toBeGreaterThanOrEqual(1);
    expect(dep(p, 2)).toBe(1);
    // Sized for A's deploy it would need 8 from T4, more than T4 spares without the second line's deploy.
    expect(attacksOn(p, 7)).toEqual([expect.objectContaining({ from: 4, armies: 1 })]);
    expect(attacksOn(p, 7)[0]!.reason).toContain(CHEAP_EXPANSION);
  });
});

// #281 × #282: my commander's holds. T1 holds my commander beside A's empty T2 and A's stack on T3;
// T8 and T9, mine, lead inland (the walk goes T1 → T8).
describe("#281 × #282: an empty enemy capture never spends my commander's hold", () => {
  const commander: BoardSpecialUnit = { kind: 'commander', id: `${ME}`.padStart(32, '0'), playerId: ME };
  const g = buildGraph(makeMap([1, 2, 3, 5, 8, 9], [[1, 2], [2, 3], [1, 3], [3, 5], [1, 8], [8, 9]]));
  const cb = (t1: number, t3: number) =>
    board([{ ...mine(1, t1), specialUnits: [commander] }, held(2, 0, A), held(3, t3, A), held(5, 30, A), mine(8, 2), mine(9, 2)], true);
  const run = (t1: number, t3: number, income: number, commanderWalks: boolean) =>
    planTurn({
      graph: g,
      board: cb(t1, t3),
      me: ME,
      income,
      settings: OFF,
      turn: 14,
      game: { players: [{ id: ME, state: 'Playing' }, { id: A, state: 'Playing' }], turn: 14 },
      options: { adapt: true, commanderWalks },
    });

  it("keeps the worst-case hold on my commander's territory (rule 1w): only the armies above it go", () => {
    const p = run(30, 20, 10, false);
    expect(said(p)).toContain("My commander's territory T1 (#1) is held against the worst case (#274), ~60");
    const [a] = attacksOn(p, 2);
    expect(a).toMatchObject({ from: 1 });
    expect(a!.reason).toContain(CHEAP_EXPANSION);
    const left =
      30 +
      (p.deploys.find((d) => d.territoryId === 1)?.armies ?? 0) +
      p.moves.filter((m) => m.to === 1 && m.kind === 'transfer').reduce((n, m) => n + m.armies, 0) -
      p.moves.filter((m) => m.from === 1).reduce((n, m) => n + m.armies, 0);
    expect(armiesToTake(left + COMMANDER_STRENGTH)!).toBeGreaterThan(60);
  });

  it('never takes it from the territory my commander walks from: what stands there is its transit hold', () => {
    // Caught: A's 79 + its whole deploy (~40) on T3 can land before the walk; all 40 deployed on T1 stay.
    const p = run(20, 80, 40, true);
    expect(p.moves.filter((m) => m.commander)).toEqual([expect.objectContaining({ from: 1, to: 8 })]);
    expect(p.moves.filter((m) => m.from === 1 && m.kind === 'attack' && m.reason.includes(CHEAP_EXPANSION))).toEqual([]);
    const check = commanderSafety({
      graph: g,
      board: cb(20, 80),
      me: ME,
      deploys: p.deploys,
      moves: p.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies, ...(m.commander ? { withCommander: true } : {}) })),
      opponents: [{ id: A, deploy: 40 }],
      settings: OFF,
      killedBy: false,
    })!;
    expect(check).toBeDefined();
  });

  it('walking and not caught, the transit hold still keeps T1 whole until the walk', () => {
    const p = run(30, 5, 5, true);
    expect(p.moves.filter((m) => m.commander)).toEqual([expect.objectContaining({ from: 1, to: 8 })]);
    expect(p.moves.filter((m) => m.from === 1 && m.reason.includes(CHEAP_EXPANSION))).toEqual([]);
  });
});
