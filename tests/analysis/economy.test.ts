// Issue #125: the economy test. A capture's cost to the economy is the armies it loses (the
// defenders' kills on its attackers) plus the army left on the captured territory — not the
// armies it sends: the survivors are still mine. Per-territory income counts as income; plain
// expansion (pass 3) has an economy test of its own; the leftover saves toward the closest
// completion it cannot yet afford; and turns to finish count the steps a chain needs.
// Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { boardIncome } from '../../src/analysis/player.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { OWNER_NEUTRAL, type LiveTerritory } from '../../src/live.js';
import { validateTurn } from '../../src/tools/turn.js';
import { board } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

export interface Scenario {
  edges: string;
  bonuses?: Array<[number, number, number[]]>;
  /** 'M5' mine 5, 'n2' neutral 2, 'E3' the enemy with 3. */
  cells: Record<number, string>;
  settings?: PlannerSettings;
  turn?: number;
  options?: PlanInput['options'];
  income?: number;
}

const cell = (id: number, s: string): TerritoryState => {
  const n = Number(s.slice(1));
  if (s[0] === 'n') return { territoryId: id, owner: { kind: 'neutral' }, armies: n };
  return { territoryId: id, owner: { kind: 'player', playerId: s[0] === 'M' ? ME : ENEMY }, armies: n };
};

export function scenario(sc: Scenario) {
  const adj = new Map<number, Set<number>>();
  const ids = new Set(Object.keys(sc.cells).map(Number));
  for (const e of sc.edges.split(/\s+/).filter(Boolean)) {
    const [a, b] = e.split('-').map(Number) as [number, number];
    ids.add(a);
    ids.add(b);
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  }
  const map: GameMap = {
    id: 1,
    name: 'Economy',
    territories: [...ids].sort((a, b) => a - b).map((id) => ({ id, name: `T${id}`, connectedTo: [...(adj.get(id) ?? [])].sort((a, b) => a - b) })),
    bonuses: (sc.bonuses ?? []).map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
  const g = buildGraph(map);
  const settings = sc.settings ?? STD;
  const b = board(Object.entries(sc.cells).map(([id, s]) => cell(Number(id), s)), true);
  const held = new Set(b.territories.filter((t) => t.owner.kind === 'player' && t.owner.playerId === ME).map((t) => t.territoryId));
  const income = sc.income ?? boardIncome(g, held, { base: settings.baseIncome ?? 5, per: settings.bonusArmyPer ?? 0 }).total;
  const players = [...new Set(b.territories.flatMap((t) => (t.owner.kind === 'player' ? [t.owner.playerId] : [])))];
  const input: PlanInput = {
    graph: g,
    board: b,
    me: ME,
    income,
    settings,
    options: { adapt: true, ...(sc.options ?? {}) },
    game: { players: players.map((id) => ({ id })), turn: sc.turn ?? 8, fog: 'Foggy' },
  };
  return { g, input, income };
}

/** Plan the scenario; the plan must pass warapp_submit_turn's validator. */
export function plan(sc: Scenario): TurnPlan {
  const { g, input } = scenario(sc);
  const p = planTurn(input);
  const map = g.map;
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  const ref = (id: number) => ({ id, name: names.get(id)! });
  const warnings = validateTurn({
    map,
    board: input.board.territories.map(
      (t): LiveTerritory => ({
        territoryId: t.territoryId,
        fogLevel: 1,
        fogged: false,
        owner: t.owner.kind === 'player' ? t.owner.playerId : t.owner.kind === 'neutral' ? OWNER_NEUTRAL : -1,
        armies: t.armies,
      }),
    ),
    myInGameId: ME,
    income: input.income,
    guard: (sc.settings ?? STD).oneArmyStandsGuard ?? true,
    deploys: p.deploys.map((d) => ({ territory: ref(d.territoryId), armies: d.armies })),
    moves: p.moves.map((m) => ({ from: ref(m.from), to: ref(m.to), armies: m.armies })),
  }).warnings;
  expect(warnings).toEqual([]);
  return p;
}

const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack').map((m) => `${m.from}->${m.to}`);

describe('#125 armies lost, not armies sent', () => {
  // +3 bonus [1,2,3,4]: I hold 1 (30), 2 and 3; 4 is a 10-army neutral. Taking it sends 16 but
  // loses 7: the bonus pays that back in under three turns. An enemy sits beside 3.
  const V1: Scenario = {
    edges: '1-2 2-3 1-4 3-5 5-6',
    bonuses: [[100, 3, [1, 2, 3, 4]]],
    cells: { 1: 'M30', 2: 'M1', 3: 'M6', 4: 'n10', 5: 'E3', 6: 'E3' },
    turn: 12,
  };
  it('completes a +3 bonus one wasteland short from the 30-stack beside it', () => {
    const p = plan(V1);
    expect(attacks(p)).toContain('1->4');
    expect(p.expected.bonusesCompleted).toContain(100);
    expect(p.rationale.join('\n')).not.toMatch(/Skip bonus B100/);
  });
});

describe('#125 the army left on a capture is waived when idle armies take it', () => {
  // +1 bonus [1,2]: 2 is a 7-army neutral (11 to take, 5 lost). Lost 5 + 1 left on it is over
  // 5 × +1 (a wasteland); with 11 idle armies on 1 (no enemy beside it) nothing is deployed for
  // it and the army left is not charged: 5, economic.
  const at = (stack: number): Scenario => ({
    edges: '1-2 1-3',
    bonuses: [[100, 1, [1, 2]]],
    cells: { 1: `M${stack}`, 2: 'n7', 3: 'n1' },
    turn: 3,
    income: 5,
  });
  it('a 2-army stack: the wasteland is skipped, its loss named', () => {
    const p = plan(at(2));
    expect(p.rationale.join('\n')).toMatch(/Skip bonus B100 \(#100\): uneconomic for \+1 \(11 armies to finish, losing ~6; 6 lost on its costliest territory\)/);
  });
  it('a 12-army stack: the same bonus is economic, and completed', () => {
    const p = plan(at(12));
    expect(p.rationale.join('\n')).not.toMatch(/Skip bonus B100/);
    expect(attacks(p)).toContain('1->2');
    expect(p.expected.bonusesCompleted).toEqual([100]);
  });
});

describe('#125 plain expansion (pass 3) has an economy test', () => {
  // The same board with 4 in no bonus: taking it sends 16 and loses 7 for +0 a turn.
  const V2: Scenario = {
    edges: '1-2 2-3 1-4 3-5 5-6',
    bonuses: [[100, 3, [1, 2, 3]]],
    cells: { 1: 'M30', 2: 'M1', 3: 'M6', 4: 'n10', 5: 'E3', 6: 'E3' },
    turn: 12,
  };
  it('does not throw 7 armies away on a 10-neutral worth +0', () => {
    const p = plan(V2);
    expect(attacks(p)).not.toContain('1->4');
    expect(p.rationale.join('\n')).toMatch(/Do not expand into T4 \(#4\): it adds no income and loses ~7 armies/);
  });
  it('still takes a cheap neutral worth +0 (it loses at most PLAIN_EXPANSION_LOSS)', () => {
    const p = plan({ ...V2, cells: { ...V2.cells, 4: 'n2' } });
    expect(attacks(p)).toContain('1->4');
  });
});
