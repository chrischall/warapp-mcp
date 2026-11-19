// Issue #290 (owner decision 2026-11-19): before the even leftover spread (#268), a border whose enemy
// stack beside it grew this turn is topped up to hold against that stack plus its owner's whole
// observed deploy, highest protected value first. Synthetic map: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { armiesToTake } from '../../src/analysis/combat.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const FOE = 20;
const LOW: PlannerSettings = { offensiveKillRate: 20, defensiveKillRate: 80, oneArmyStandsGuard: false, luckModifier: 0, roundingMode: 'StraightRound' };
// My X (T1, 7, in the +5 bonus B100) faces player 20's T11; my Y (T2, 7) and Z (T3, 4) face its T12
// and T13. Everything else as #268's shape: four players, one opponent in view, the leftover spread.
const EDGES = '1-11 2-12 3-12 3-13 1-2 2-3 1-5 4-5 3-6 5-6 11-12 12-13 13-14 11-14';
const NOW: Record<number, string> = { 1: 'M7', 2: 'M7', 3: 'M4', 4: 'M30', 5: 'M2', 6: 'M2', 11: 'E16', 12: 'E7', 13: 'E4', 14: 'U' };

function input(previous?: Record<number, string>, now: Record<number, string> = NOW): PlanInput {
  const adj = new Map<number, Set<number>>();
  for (const e of EDGES.split(' ')) {
    const [a, b] = e.split('-').map(Number) as [number, number];
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  }
  const map: GameMap = {
    id: 1,
    name: 'Grown',
    territories: [...adj.keys()].sort((a, b) => a - b).map((id) => ({ id, name: `T${id}`, connectedTo: [...adj.get(id)!].sort((a, b) => a - b) })),
    bonuses: [
      { id: 100, name: 'B100', value: 5, territoryIds: [1, 5], bonusIds: [] },
      { id: 101, name: 'B101', value: 2, territoryIds: [3, 6], bonusIds: [] },
      { id: 102, name: 'B102', value: 21, territoryIds: [11, 12, 13], bonusIds: [] },
    ],
    distributionModes: [],
  };
  const cells = (c: Record<number, string>): TerritoryState[] =>
    Object.entries(c).map(([id, s]) =>
      s === 'U'
        ? { territoryId: Number(id), owner: { kind: 'unknown' }, armies: null }
        : { territoryId: Number(id), owner: { kind: 'player', playerId: s[0] === 'M' ? ME : FOE }, armies: Number(s.slice(1)) },
    );
  return {
    graph: buildGraph(map),
    board: board(cells(now), true),
    ...(previous ? { previousBoard: board(cells(previous), true) } : {}),
    me: ME,
    income: 29,
    settings: LOW,
    options: { adapt: true },
    game: { players: [{ id: ME }, { id: FOE }, { id: 30 }, { id: 40 }], turn: 9, fog: 'Foggy' },
  };
}
const deployedTo = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);
const line = (p: TurnPlan) => p.rationale.find((l) => l.includes('(#290)'));

describe('#290 a border whose enemy stack grew is funded before the even spread', () => {
  it('without growth nothing changes', () => {
    expect(line(planTurn(input()))).toBeUndefined();
  });

  it('tops up the borders beside grown stacks to the whole observed deploy, highest protected value first', () => {
    // Every stack of player 20 grew (T11 +15, T12 +19, T13 +3): the board reads +19 to +37 against an
    // estimate of ~26 (the growth beside the fog read as a move, not income).
    const now = { ...NOW, 12: 'E20' };
    const p = planTurn(input({ ...NOW, 11: 'E1', 12: 'E1', 13: 'E1' }, now));
    const lines = p.rationale.filter((l) => l.includes('(#290)'));
    // X (T1, +5) first, then Z (T3, +2), then Y (T2, +0), each sized on the high reading, ~37.
    expect(lines.map((l) => /to (T\d) /.exec(l)![1])).toEqual(['T1', 'T3', 'T2']);
    expect(lines[0]).toMatch(/grew this turn \(\+15\), so it is topped up toward its 16 movable armies plus its whole observed deploy \(~37\) \(protects \+5\)/);
    // X now holds its stack plus the whole observed deploy.
    const take = armiesToTake(7 + deployedTo(p, 1), { offensiveKillRate: 20, defensiveKillRate: 80 })!;
    expect(take).toBeGreaterThan(16 + 37);
    expect(p.deploys.reduce((n, d) => n + d.armies, 0)).toBe(29);
    // The same board with no previous one: no stack is known to have grown, and the rule stays out.
    expect(line(planTurn(input(undefined, now)))).toBeUndefined();
  });
});
