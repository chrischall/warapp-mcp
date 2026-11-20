// #420 (owner decision of 2026-11-20, "Total hold cap"): plain holds take at most 50% of my income when
// even or ahead, and 70% when behind. A held bonus's own gate and my commander are funded first, outside
// the cap. A plain hold past it is conceded with a "(#420)" line, so the armies go to captures; what the
// captures leave can still hold it after all (the leftover's revival).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { HOLD_CAP_BEHIND, HOLD_CAP_EVEN } from '../../src/analysis/plan/holds.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

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
const foe = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE }, armies });
const deployOn = (p: TurnPlan, t: number) => p.deploys.filter((d) => d.territoryId === t).reduce((n, d) => n + d.armies, 0);
const capLines = (p: TurnPlan) => p.warnings.filter((w) => w.includes('within the hold cap (#420'));

// My plain borders T1, T2, T3 each face a 4-stack of the opponent (its +4 B902 {11, 12, 13} in view:
// ~9 deploy) and each shields 30 armies behind it (T21–T23, #235's cut). Behind them my T5, T6 and the
// neutral T7 complete my +4 B901.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 5, 6, 7, 11, 12, 13, 21, 22, 23],
    [[1, 11], [2, 12], [3, 13], [1, 5], [2, 5], [3, 6], [5, 6], [6, 7], [1, 21], [2, 22], [3, 23]],
    [[901, 4, [5, 6, 7]], [902, 4, [11, 12, 13]]],
  ),
);
const input = (income: number, t1: number, options: PlanInput['options'] = {}): PlanInput => ({
  graph: g,
  board: board([
    mine(1, t1), mine(2, 3), mine(3, 3), mine(5, 1), mine(6, 3), neutral(7, 2),
    foe(11, 4), foe(12, 4), foe(13, 4), mine(21, 30), mine(22, 30), mine(23, 30),
  ]),
  me: ME,
  income,
  settings: STD,
  game: { players: [{ id: ME }, { id: FOE }], turn: 8 },
  options: { adapt: true, ...options },
});

describe('#420: the total hold cap', () => {
  it('is half my income when even or ahead, 70% when behind', () => {
    expect(HOLD_CAP_EVEN).toBe(0.5);
    expect(HOLD_CAP_BEHIND).toBe(0.7);
  });

  it('ahead on 12: one hold of 5 fits the 6; the next two are conceded for the cap, and the armies take T11', () => {
    const p = planTurn(input(12, 3));
    expect(p.profile.standing).toBe('ahead');
    expect(p.conceded).toEqual([2, 3]);
    expect(capLines(p)).toHaveLength(2);
    expect(capLines(p)[0]).toMatch(/plain holds take at most 6 of my 12 income, 50% when even or ahead; 5 already go to holds, and it needs 5/);
    expect(p.expected.captures).toContain(11);
  });

  it('even on 8: a hold of 5 is past the 4, so it is conceded where the plan without the cap holds it', () => {
    const p = planTurn(input(8, 3));
    const off = planTurn(input(8, 3, { holdCap: false }));
    expect(p.profile.standing).toBe('even');
    expect(p.conceded).toContain(1);
    expect(deployOn(p, 1)).toBe(0);
    expect(capLines(p)[0]).toMatch(/T1 \(#1\) cannot be held within the hold cap \(#420: plain holds take at most 4 of my 8 income/);
    expect(off.conceded).not.toContain(1);
    expect(deployOn(off, 1)).toBeGreaterThanOrEqual(5);
    expect(capLines(off)).toEqual([]);
  });

  it('behind on 7: a hold of 4 fits 70% (4), where half (3) would concede it', () => {
    const p = planTurn(input(7, 4));
    expect(p.profile.standing).toBe('behind');
    expect(p.conceded).not.toContain(1);
    expect(deployOn(p, 1)).toBeGreaterThanOrEqual(4);
    expect(capLines(p).every((l) => l.includes('70% when behind'))).toBe(true);
  });

  it('a defend goal the caller gave is not capped', () => {
    const p = planTurn(input(12, 3, { goal: 'defend' }));
    expect(capLines(p)).toEqual([]);
  });
});

// A held bonus's gate: my +5 B901 {1, 2} with T1 (2 armies) facing the opponent's 8-stack: its hold
// costs more than half my 12, and it is funded outside the cap.
const g2 = buildGraph(makeMap([1, 2, 3, 11, 13], [[1, 2], [2, 3], [1, 11], [3, 13]], [[901, 5, [1, 2]]]));
const gate = (holdCap?: false): PlanInput => ({
  graph: g2,
  board: board([mine(1, 2), mine(2, 1), mine(3, 6), foe(11, 8), foe(13, 4)]),
  me: ME,
  income: 12,
  settings: STD,
  game: { players: [{ id: ME }, { id: FOE }], turn: 8 },
  options: { adapt: true, enemyDeploy: 5, ...(holdCap === false ? { holdCap } : {}) },
});

describe('#420: a held bonus\'s gate is funded first, outside the cap', () => {
  it('T1 holds B901 whole past half my income, and counts nothing toward the cap', () => {
    const p = planTurn(gate());
    const off = planTurn(gate(false));
    expect(p.conceded).not.toContain(1);
    expect(deployOn(p, 1)).toBeGreaterThan(6);
    expect(deployOn(p, 1)).toBe(deployOn(off, 1));
    expect(capLines(p)).toEqual([]);
  });
});
