// #257: an idle interior stack that would make a conceded border hold walked to a neutral edge
// instead. Live (a free-for-all, made up here): guard on, income 9, my 11 on an interior
// territory, two of my 1-army borders beside an opponent's 1-army territory, each needing 11 more
// against its ~19 estimate, so both were conceded; the plan attacked the opponent from one of them
// and rule 6 sent the idle stack to a third territory beside neutrals. Now the stack goes to the
// conceded border the plan attacks from, which then holds. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const FOE = 20;
// Base income 19 makes every opponent's estimate ~19; my income is given (9).
const RULES: PlannerSettings = {
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  oneArmyStandsGuard: true,
  luckModifier: 0,
  roundingMode: 'StraightRound',
  baseIncome: 19,
};

function makeMap(ids: number[], edges: [number, number][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [],
    distributionModes: [],
  };
}
const at = (territoryId: number, armies: number, who: number | 'neutral'): TerritoryState =>
  who === 'neutral'
    ? { territoryId, owner: { kind: 'neutral' }, armies }
    : { territoryId, owner: { kind: 'player', playerId: who }, armies };

/**
 * My interior `u` (11 armies) borders my `v` and `gT` (1 each, both beside the opponent's 1-army D = 10,
 * behind which stands its 30 on 11) and my S = 4, whose other neighbours are neutrals 20 and 21.
 */
function plan(v: number, gT: number, uArmies = 11, extra: Partial<PlanInput> = {}): TurnPlan {
  const u = 1;
  const g = buildGraph(
    makeMap([u, v, gT, 4, 10, 11, 20, 21], [[u, v], [u, gT], [u, 4], [v, 10], [gT, 10], [4, 20], [4, 21], [10, 11]]),
  );
  return planTurn({
    graph: g,
    board: board([at(u, uArmies, ME), at(v, 1, ME), at(gT, 1, ME), at(4, 1, ME), at(10, 1, FOE), at(11, 30, FOE), at(20, 6, 'neutral'), at(21, 6, 'neutral')]),
    me: ME,
    income: 9,
    settings: RULES,
    ...extra,
  });
}
const into = (p: TurnPlan, to: number) => p.moves.filter((m) => m.kind === 'transfer' && m.to === to).reduce((n, m) => n + m.armies, 0);

describe('#257: an idle stack revives a conceded border it makes hold', () => {
  it('moves the idle stack into the conceded border the plan attacks from, which is then held', () => {
    const p = plan(2, 3);
    const attack = p.moves.find((m) => m.kind === 'attack' && m.to === 10);
    expect(attack?.from).toBe(2);
    // 1 left on T2 after its attack: 11 more need 20 to take, above the ~19.
    expect(into(p, 2)).toBeGreaterThanOrEqual(11);
    expect(into(p, 4)).toBe(0);
    // One transfer from T1 to T2, never two.
    expect(p.moves.filter((m) => m.from === 1 && m.to === 2)).toHaveLength(1);
    expect(p.conceded).not.toContain(2);
    expect(p.conceded).toContain(3);
    expect(p.warnings.some((w) => w.startsWith('T2 (#2) cannot be held') && w.endsWith(': conceded'))).toBe(false);
    expect(p.rationale.join('\n')).toMatch(/T2 \(#2\) after all \(not conceded\).*idle armies from T1 \(#1\).*the border the plan attacks T10 \(#10\) from/);
  });

  it('prefers the border the plan attacks from over a lower id', () => {
    // T3 borders D = 10 and T2 the opponent's other 1-army territory 12 (beside its 30 on 11): both
    // need 11, equally worth holding, and T2 has the lower id; the plan attacks D from T3.
    const u = 1;
    const g = buildGraph(
      makeMap([u, 2, 3, 4, 10, 11, 12, 20, 21], [[u, 3], [u, 2], [u, 4], [3, 10], [2, 12], [12, 11], [4, 20], [4, 21], [10, 11]]),
    );
    const p = planTurn({
      graph: g,
      board: board([at(u, 11, ME), at(3, 1, ME), at(2, 1, ME), at(4, 1, ME), at(10, 1, FOE), at(11, 30, FOE), at(12, 1, FOE), at(20, 6, 'neutral'), at(21, 6, 'neutral')]),
      me: ME,
      income: 9,
      settings: RULES,
    });
    expect(p.moves.find((m) => m.kind === 'attack')).toMatchObject({ from: 3, to: 10 });
    expect(into(p, 3)).toBeGreaterThanOrEqual(11);
    expect(into(p, 2)).toBe(0);
    expect(p.conceded).toEqual([2]);
  });

  it('leaves a conceded border conceded when the idle stack cannot make it hold', () => {
    // 2 on T1: with the leftover 7 deployed there, 8 movable, short of the 11 T2 needs.
    const p = plan(2, 3, 2);
    expect(p.conceded).toEqual(expect.arrayContaining([2, 3]));
    expect(p.rationale.join('\n')).not.toMatch(/after all \(not conceded\)/);
  });

  it('does nothing when idle transfers are off', () => {
    const p = plan(2, 3, 11, { settings: { ...RULES, idleTransfers: false } });
    expect(p.moves.filter((m) => m.kind === 'transfer')).toEqual([]);
    expect(p.conceded).toEqual(expect.arrayContaining([2, 3]));
  });
});
