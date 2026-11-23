// #430: a member of a bonus I held in full last turn (`previousBoard`), now an opponent's, is a bonus
// target in every format under `balanced` — not only for the 1v1 strike stack — when every missing
// member is in view and beside mine, their capture costs together are at most RETAKE_VALUE_TURNS (5) ×
// the bonus's value (owner decision of 2026-11-22), and I am not behind (the profile's standing). Stronger holds still fund first: the
// retake is a completion in rule 4a's greedy step, ranked as one. Synthetic map, made-up ids.
//
//   9 ─ 1 ─ 2 ─ 3 ─ 4        Fen (+5): 1, 2, 3 — I held all three last turn; player 20 took 3
//                            4 player 20's stack behind it; 9 a far neutral of no bonus
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type TurnPlan } from '../../src/analysis/planner.js';
import { RETAKE_VALUE_TURNS } from '../../src/analysis/plan/targets.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const B = 30;
const FEN = 501;

const held = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

const edges: [number, number][] = [
  [9, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
];
const map = (value = 5): GameMap => ({
  id: 1,
  name: 'Retake',
  territories: [1, 2, 3, 4, 5, 9].map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [{ id: FEN, name: 'Fen', value, territoryIds: [1, 2, 3], bonusIds: [] }],
  distributionModes: [],
});

/** This turn: player 20 took 3 from me (2 there), its 4 and player 30's 5 behind. */
const now = (a3 = 2, a4 = 4): BoardState => board([mine(1, 3), mine(2, 8), held(3, a3, A), held(4, a4, A), held(5, 4, B), neutral(9, 6)]);
/** Last turn: Fen all mine. */
const before = (): BoardState => board([mine(1, 3), mine(2, 6), mine(3, 3), held(4, 6, A), held(5, 4, B), neutral(9, 6)]);

function input(over: Partial<PlanInput> = {}, value = 5): PlanInput {
  return {
    graph: buildGraph(map(value)),
    board: now(),
    previousBoard: before(),
    me: ME,
    income: 8,
    settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
    game: { players: [ME, A, B].map((id) => ({ id, state: 'Playing' })), turn: 12 },
    turn: 12,
    options: { goal: 'balanced', minWinChance: 1 },
    ...over,
  };
}
const attacksOn = (p: TurnPlan, t: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === t);
const said = (p: TurnPlan) => p.rationale.join('\n');

describe('#430: retake a lost held-bonus member', () => {
  it('an FFA: the member taken from a bonus I held last turn is retaken, completing it again', () => {
    const p = planTurn(input());
    expect(p.profile.format).toBe('ffa');
    expect(attacksOn(p, 3)).toHaveLength(1);
    expect(p.expected.bonusesCompleted).toContain(FEN);
    expect(said(p)).toMatch(/Retake T3 \(#3\): .*Fen.*held in full last turn.*\(#430\)/);
  });

  it('no previous board, or a bonus I did not hold in full last turn: no retake (an enemy member stays no target)', () => {
    expect(attacksOn(planTurn(input({ previousBoard: undefined })), 3)).toEqual([]);
    const notHeld = board([mine(1, 3), mine(2, 6), held(3, 2, A), held(4, 6, A), held(5, 4, B), neutral(9, 6)]);
    expect(attacksOn(planTurn(input({ previousBoard: notHeld })), 3)).toEqual([]);
  });

  it('a retake costing more than RETAKE_VALUE_TURNS × the value is not made (5×, not PAYBACK_TURNS 10×)', () => {
    expect(RETAKE_VALUE_TURNS).toBe(5);
    // +1: 5 armies at most. 3 on 4 costs 6 to take: within 10× (the draft's cap), over 5×.
    const p = planTurn(input({ board: now(4) }, 1));
    expect(attacksOn(p, 3)).toEqual([]);
    expect(said(p)).not.toMatch(/#430/);
    // +2: 10 at most, so the same 6 is retaken.
    expect(said(planTurn(input({ board: now(4) }, 2)))).toMatch(/Retake T3 \(#3\): .*for 6 armies \(at most 5 × its value\)/);
  });

  it('behind (the profile standing): no retake', () => {
    // Player 20 earns far more than my 8 (a visible stack and a big tracked deploy): standing behind.
    const p = planTurn(input({ income: 3, deployEstimates: [{ playerId: A, estimate: 20 }, { playerId: B, estimate: 5 }] } as Partial<PlanInput>));
    expect(p.profile.standing).toBe('behind');
    expect(attacksOn(p, 3)).toEqual([]);
  });

  it('starves no stronger hold: a held +10 whose border needs the turn is funded first, the retake waits', () => {
    // Big (+10) is T6 alone, mine, beside player 30's 5: holding it takes the deploy the retake would use.
    const big: GameMap = {
      ...map(),
      territories: [...map().territories.map((t) => (t.id === 5 ? { ...t, connectedTo: [...t.connectedTo, 6] } : t)), { id: 6, name: 'T6', connectedTo: [5] }],
      bonuses: [...map().bonuses, { id: 502, name: 'Big', value: 10, territoryIds: [6], bonusIds: [] }],
    };
    // T1 and T2 stand on 1 each: the retake needs deploys the hold takes.
    const thin = (t: TerritoryState) => (t.territoryId === 1 || t.territoryId === 2 ? mine(t.territoryId, 1) : t);
    const withBig = (b: BoardState) => board([...b.territories.map((t) => (t.territoryId === 5 ? held(5, 7, B) : thin(t))), mine(6, 2)]);
    const p = planTurn(input({ graph: buildGraph(big), board: withBig(now()), previousBoard: withBig(before()) }));
    expect(said(p)).toMatch(/Retake T3 \(#3\)/);
    expect(p.deploys.filter((d) => d.territoryId === 6).reduce((n, d) => n + d.armies, 0)).toBeGreaterThanOrEqual(7);
    expect(attacksOn(p, 3)).toEqual([]);
  });

  it('not under `expand` or `defend`: those goals take no enemy territory', () => {
    expect(attacksOn(planTurn(input({ options: { goal: 'expand', minWinChance: 1 } })), 3)).toEqual([]);
    expect(attacksOn(planTurn(input({ options: { goal: 'defend', minWinChance: 1 } })), 3)).toEqual([]);
  });
});
