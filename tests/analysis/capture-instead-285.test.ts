// #285: a held bonus's borders facing one enemy stack were held against its owner's deploy when
// capturing the stack would cost less and leave them interior. Owner decisions (2026-11-19): the
// capture is sized against the same deploy estimate the holds are (#368's middle figure), and the
// hold it saves is credited for HOLD_CREDIT_TURNS (3) turns, since the border stops being one.
// Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanGameContext, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const FOE = 20;
const OTHER = 30;
const SET: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70 };
const GAME: PlanGameContext = { players: [ME, FOE, OTHER].map((id) => ({ id })), turn: 12 };
const at = (territoryId: number, armies: number | null, who: number | 'neutral' | 'fog'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : who === 'fog'
      ? { territoryId, owner: { kind: 'unknown' }, armies: null }
      : { territoryId, owner: { kind: 'player', playerId: who }, armies };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'CaptureInstead',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

//   Ring (+1): my 1, 2 and 3 (thin borders) and my interior 6. Player 20's stack on 4 borders all
//   three and its own 5, which leads to its bonus Far (+3: 5, 7, 8). Player 30 sits on 9, past 8.
//   `extra` adds 10, a territory beside my 1 whose owner the fog hides.
const map = (extra = false) =>
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 8, 9, ...(extra ? [10] : [])],
    [[1, 2], [2, 3], [1, 6], [2, 6], [3, 6], [1, 4], [2, 4], [3, 4], [4, 5], [5, 7], [7, 8], [8, 9], ...(extra ? ([[1, 10]] as [number, number][]) : [])],
    [[900, 1, [1, 2, 3, 6]], [901, 3, [5, 7, 8]]],
  );
const field = (border: number, stack: number, extra = false): BoardState =>
  board([
    at(1, border, ME),
    at(2, border, ME),
    at(3, border, ME),
    at(6, 3, ME),
    at(4, stack, FOE),
    at(5, 3, FOE),
    at(7, 3, FOE),
    at(8, 3, FOE),
    at(9, 3, OTHER),
    ...(extra ? [at(10, null, 'fog')] : []),
  ]);
const plan = (b: BoardState, extra = false, income = 30): TurnPlan =>
  planTurn({ graph: buildGraph(map(extra)), board: b, me: ME, income, settings: SET, game: GAME });

describe('#285: capture the one stack facing a held bonus rather than hold every border against it', () => {
  it('captures the stack, sized for its owner deploying there first, when that costs less than the holds over 3 turns', () => {
    const p = plan(field(6, 12), false, 40);
    const attack = p.moves.find((m) => m.kind === 'attack' && m.to === 4);
    expect(attack).toBeDefined();
    // Sure against the 12 there plus player 20's ~8 deploy: the 33 the "Not attacking" line named before.
    expect(attack!.armies).toBe(33);
    const text = p.rationale.join('\n');
    // The holds still owed after the floors: 4 on each of the three borders, 12 this turn, 36 over 3 turns.
    expect(text).toMatch(/Take T4 \(#4\) from T\d \(#\d\) rather than hold T1 \(#1\), T2 \(#2\), T3 \(#3\): a deploy of \d+ sends 33, .* against the 12 the holds would cost this turn \(36 for 3 turns\); .*\(#285\)/);
    // The bonus is no longer held against the stack: no whole-hold line for it.
    expect(text).not.toMatch(/Hold bonus B900/);
  });

  it('holds as before when a border would still face the fog once the stack falls', () => {
    const p = plan(field(6, 12, true), true, 40);
    expect(p.moves.find((m) => m.kind === 'attack' && m.to === 4)).toBeUndefined();
    expect(p.rationale.join('\n')).not.toMatch(/\(#285\)/);
  });

  it('holds as before when the capture costs more than 3 turns of the holds it saves', () => {
    // 11 on each border: the holds cost 1 each, 9 over three turns; the capture needs far more.
    const p = plan(field(11, 12), false, 40);
    expect(p.moves.find((m) => m.kind === 'attack' && m.to === 4)).toBeUndefined();
    expect(p.rationale.join('\n')).not.toMatch(/\(#285\)/);
  });
});
