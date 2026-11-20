// #417, the breach force (owner decision of 2026-11-20): my stacks beside land a static seat (#270) left
// stay and attack into it, at the VACATED_FOG_ARMIES (2-defender) price, until it is taken or another
// player gets there first. Synthetic map, made-up ids.
//
//   9 ─ 8 ─ 3 ─ 1 ─ 4 ─ 5     1 mine (my stack); 4, 5 S's land (S out, no AI), fogged now;
//                              3 mine; 8 mine, beside A's 9 (the live front)
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import { VACATED_FOG_ARMIES } from '../../src/analysis/plan/vacated.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const S = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 5 };

const held = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic breach force',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

const players = [
  { id: ME, state: 'Playing' },
  { id: A, state: 'Playing' },
  { id: S, state: 'SurrenderAccepted' },
];
const text = (p: TurnPlan) => p.rationale.join('\n');
const attacksOn = (p: TurnPlan, t: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === t);
const transfersFrom = (p: TurnPlan, t: number) => p.moves.filter((m) => m.kind === 'transfer' && m.from === t);

const g = buildGraph(
  makeMap(
    [1, 3, 4, 5, 8, 9],
    [
      [9, 8],
      [8, 3],
      [3, 1],
      [1, 4],
      [4, 5],
    ],
  ),
);
// Fogged now; last seen as S's.
const seen = new Map([
  [4, S],
  [5, S],
]);
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  graph: g,
  board: board([mine(1, 12), mine(3, 1), fogged(4), fogged(5), mine(8, 20), held(9, 3, A)]),
  foggedLastSeen: seen,
  me: ME,
  income: 5,
  settings: STD,
  turn: 14,
  game: { players, turn: 14 },
  options: { adapt: true },
  ...over,
});

describe('the breach force (#417)', () => {
  it('attacks fogged land the seat left at the 2-defender price instead of planning nothing into the fog', () => {
    expect(VACATED_FOG_ARMIES).toBe(2);
    const p = planTurn(input());
    expect(attacksOn(p, 4)).toEqual([expect.objectContaining({ from: 1, armies: 3 })]);
    expect(text(p)).toMatch(/T4 \(#4\) is fogged and was player 30's \(out, no AI\): .* priced at 2 defenders \(3 armies\) \(#417\)/);
    expect(p.warnings.join('\n')).not.toMatch(/Fogged territory T4 \(#4\)/);
  });

  it('never when the fog shows another player there now: someone got there first', () => {
    const p = planTurn(input({ board: board([mine(1, 12), mine(3, 1), { territoryId: 4, owner: { kind: 'player', playerId: A }, armies: null, fogLevel: 'OwnerOnly' }, fogged(5), mine(8, 20), held(9, 3, A)]) }));
    expect(attacksOn(p, 4)).toEqual([]);
    expect(text(p)).not.toMatch(/#417/);
  });

  it('a fogged territory never seen as the seat\'s stays unattacked', () => {
    const p = planTurn(input({ foggedLastSeen: new Map() }));
    expect(attacksOn(p, 4)).toEqual([]);
    expect(p.warnings.join('\n')).toMatch(/Fogged territory T4 \(#4\) borders my T1 \(#1\)/);
  });

  it('the stack beside it stays while the land is untaken (no transfer toward the live front)', () => {
    // complete-bonus makes no plain expansion, so the land stays untaken this turn.
    const p = planTurn(input({ options: { goal: 'complete-bonus' } }));
    expect(attacksOn(p, 4)).toEqual([]);
    expect(transfersFrom(p, 1)).toEqual([]);
    expect(text(p)).toMatch(/Keep the 16 idle armies on T1 \(#1\): the breach force beside T4 \(#4\), land player 30 left \(out, no AI\), until it is taken \(#417\)\./);
  });

  it('without the seat\'s land beside it, the same stack walks toward the front', () => {
    const p = planTurn(input({ options: { goal: 'complete-bonus' }, foggedLastSeen: new Map() }));
    expect(transfersFrom(p, 1).length).toBeGreaterThan(0);
  });

  it('once the land is taken this turn the stack is free to move on', () => {
    const p = planTurn(input());
    expect(text(p)).not.toMatch(/the breach force beside T4/);
  });

  it('taken though it sits in a bonus not worth completing (its member is still up for taking)', () => {
    //   11 ─ 9 ─ 8 ─ 3 ─ 1 ─ 4 ─ 5, 1 ─ 6: bonus B700 (+1) = 4, 6; 6 a neutral of 40 makes it uneconomic.
    // Player 40 on T11 keeps it a free-for-all, so the 1v1 race (#417) does not take T4: pass 3 must
    // (`plainEligible`'s vacated clause; without it T4 is skipped as an uneconomic bonus's member).
    const gb = buildGraph(
      makeMap([1, 3, 4, 5, 6, 8, 9, 11], [[9, 8], [8, 3], [3, 1], [1, 4], [4, 5], [1, 6], [9, 11]], [[700, 1, [4, 6]]]),
    );
    const b = board([mine(1, 12), mine(3, 1), fogged(4), fogged(5), neutral(6, 40), mine(8, 20), held(9, 3, A), held(11, 6, 40)]);
    const p = planTurn(input({ graph: gb, board: b, game: { players: [...players, { id: 40, state: 'Playing' }], turn: 14 } }));
    expect(text(p)).toMatch(/Skip bonus B700 \(#700\): uneconomic/);
    expect(text(p)).not.toMatch(/1v1 race for vacated land/);
    expect(attacksOn(p, 4)).toEqual([expect.objectContaining({ from: 1, armies: 3 })]);
  });

  it('a visible vacated wall too dear to take at the 2-defender price keeps no breach force', () => {
    const wall = board([mine(1, 12), mine(3, 1), held(4, 40, S), fogged(5), mine(8, 20), held(9, 3, A)]);
    const p = planTurn(input({ board: wall, foggedLastSeen: new Map([[5, S]]), options: { goal: 'complete-bonus' } }));
    expect(text(p)).not.toMatch(/breach force/);
  });
});
