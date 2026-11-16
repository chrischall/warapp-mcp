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
