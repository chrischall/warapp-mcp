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

interface Scenario {
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

function scenario(sc: Scenario) {
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
function plan(sc: Scenario): TurnPlan {
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

describe('#125 per-territory income counts', () => {
  // Extra armies for territories: 1 a territory over a base of 3, at 20/80. I hold 1–5 (income 5).
  // 6 is a 1-army neutral (3 to take, 1 lost) in Moor (+2), whose 20-army members make it a
  // wasteland; 9, a 1-army neutral, is Nook (+1) of its own. Taking 6 adds +1 a turn.
  const PER = { offensiveKillRate: 20, defensiveKillRate: 80, oneArmyStandsGuard: true, bonusArmyPer: 1, baseIncome: 3 };
  const sc: Scenario = {
    edges: '1-2 2-3 3-4 4-5 5-6 6-7 7-8 4-9 1-30 30-31',
    bonuses: [
      [100, 2, [6, 7, 8]],
      [101, 1, [9]],
    ],
    cells: { 1: 'M3', 2: 'M3', 3: 'M3', 4: 'M3', 5: 'M3', 6: 'n1', 7: 'n20', 8: 'n20', 9: 'n1', 30: 'n5', 31: 'E5' },
    settings: PER,
    turn: 4,
  };
  it('takes a 1-army neutral worth +1 a turn though its bonus is a wasteland', () => {
    const { income } = scenario(sc);
    expect(income).toBe(5);
    const p = plan(sc);
    expect(attacks(p)).toEqual(expect.arrayContaining(['4->9', '5->6']));
    expect(p.expected.nextIncome).toBe(8);
  });
  it("a bonus's worth adds the per-territory income its members bring", () => {
    // With 12-army members Moor loses 2 + 11 + 11 = 24 (each with the army left on it): over
    // 10 × +2, but within 10 × (+2 + the +3 its three territories add).
    const p = plan({ ...sc, cells: { ...sc.cells, 7: 'n12', 8: 'n12' } });
    expect(p.rationale.join('\n')).not.toMatch(/Skip bonus B100/);
  });
});

describe('#125 turns to finish count the layers a chain needs', () => {
  // Chain (+3): 2, 3, 4 in a line from my 1 — 2-army neutrals, 9 to finish, but one layer a turn:
  // 3 turns. Pair (+3): 5, a 6-neutral beside my 1 — 10 to finish, 2 turns at income 5.
  const sc: Scenario = {
    edges: '1-2 2-3 3-4 1-5 1-9 9-10',
    bonuses: [
      [100, 3, [1, 2, 3, 4]],
      [101, 3, [5, 9]],
    ],
    cells: { 1: 'M4', 2: 'n2', 3: 'n2', 4: 'n2', 5: 'n6', 9: 'M1', 10: 'E2' },
    turn: 3,
    income: 5,
  };
  it('a three-deep chain is three turns away, not one', () => {
    const p = plan(sc);
    const line = p.rationale.find((l) => l.includes('closest to completion first'));
    expect(line).toMatch(/B101 \(#101\) 10 armies to finish, 2 turns at income 5, B100 \(#100\) 9, 3 turns/);
  });
});

const deployedTo = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);

describe('#125 the leftover saves toward the closest completion', () => {
  // +4 bonus [1,2]: 2 is a 10-neutral (16 to take); 1 has 6. A corridor of 2-neutrals in no bonus
  // runs from 3. The leftover went to the corridor's expansion stack, and the bonus waited.
  const B3: Scenario = {
    edges: '1-2 1-3 3-4 4-5 5-6 6-7 7-8 8-9',
    bonuses: [[100, 4, [1, 2]]],
    cells: { 1: 'M6', 2: 'n10', 3: 'M2', 4: 'n2', 5: 'n2', 6: 'n2', 7: 'n2', 8: 'n2', 9: 'n2' },
    turn: 3,
  };
  it('deploys the leftover on the stack beside the member it cannot yet afford', () => {
    const p = plan(B3);
    expect(deployedTo(p, 1)).toBeGreaterThan(0);
    expect(p.rationale.join('\n')).toMatch(/Deploy the leftover \d+ to T1 \(#1\): save toward T2 \(#2\) \(16 to take\), the next step of bonus B100 \(#100\)/);
  });
});

describe('#125 staging: unthreatened stacks move toward a capture not yet affordable', () => {
  // 30/75: a 4-neutral (T5) needs 12 attackers. It is the last member of Ridge (+5) [1,2,5]. Only
  // T2 (1 army) borders it; my 11-stack on T3 is two steps away, beside 2-neutrals worth +0
  // (T6 and T7, in no bonus) and far from every enemy. It stood still for turns.
  const R = { offensiveKillRate: 30, defensiveKillRate: 75, oneArmyStandsGuard: true };
  const sc: Scenario = {
    edges: '1-2 2-5 2-3 3-6 3-7 1-8 8-9 9-10',
    bonuses: [[100, 5, [1, 2, 5]]],
    cells: { 1: 'M1', 2: 'M1', 3: 'M11', 5: 'n4', 6: 'n4', 7: 'n4', 8: 'n4', 9: 'n4', 10: 'E5' },
    settings: R,
    turn: 4,
    income: 5,
  };
  it('deploys beside the target and walks the stack one step toward it', () => {
    const p = plan(sc);
    expect(deployedTo(p, 2)).toBe(5);
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 3, to: 2, armies: 10, kind: 'transfer' }));
    expect(p.rationale.join('\n')).toMatch(/Move 10 from T3 \(#3\) to T2 \(#2\): stages toward T5 \(#5\)/);
  });
});
