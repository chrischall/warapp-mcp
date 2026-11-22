// Issue #426: a neutral whose defenders kill none of my attackers (a no-loss capture: 0 armies at the
// 70% defensive rate) costs only the army that lands on it. Live (a 12-seat guard-off game, turn 4), 25
// such 0-army neutrals beside idle stacks of mine were skipped because each sat in a bonus too costly to
// finish, while the leftover went elsewhere. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

interface Scenario {
  edges: string;
  bonuses?: Array<[number, number, number[]]>;
  /** 'M5' mine 5, 'n2' neutral 2, 'E3' player 20 with 3, 'F3' player 30 with 3. */
  cells: Record<number, string>;
  settings?: PlannerSettings;
  income: number;
  turn?: number;
  previous?: Record<number, string>;
}

const cell = (id: number, s: string): TerritoryState => {
  const n = Number(s.slice(1));
  if (s[0] === 'n') return { territoryId: id, owner: { kind: 'neutral' }, armies: n };
  const playerId = s[0] === 'M' ? ME : s[0] === 'E' ? 20 : 30;
  return { territoryId: id, owner: { kind: 'player', playerId }, armies: n };
};
const boardOf = (cells: Record<number, string>): BoardState => board(Object.entries(cells).map(([id, s]) => cell(Number(id), s)), true);

function input(sc: Scenario): PlanInput {
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
    name: 'Free',
    territories: [...ids].sort((a, b) => a - b).map((id) => ({ id, name: `T${id}`, connectedTo: [...(adj.get(id) ?? [])].sort((a, b) => a - b) })),
    bonuses: (sc.bonuses ?? []).map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
  return {
    graph: buildGraph(map),
    board: boardOf(sc.cells),
    ...(sc.previous ? { previousBoard: boardOf(sc.previous) } : {}),
    me: ME,
    income: sc.income,
    settings: sc.settings ?? STD,
    options: { adapt: true },
    game: { players: [ME, 20, 30].map((id) => ({ id })), turn: sc.turn ?? 6, fog: 'Foggy' },
    turn: sc.turn ?? 6,
  };
}
const why = (p: TurnPlan) => p.rationale.join('\n');
const attacked = (p: TurnPlan, to: number) => p.moves.some((m) => m.kind === 'attack' && m.to === to);

describe('#426 a no-loss neutral capture is taken even in a bonus too costly to finish', () => {
  // My T1 (3) and T5 (2) sit far from player 20's T9 (behind T8, a 9-neutral). T2 is a 0-army neutral beside
  // T1 in bonus B100 (+1), whose other member T3 holds 40: B100 is uneconomic. T4, also beside T1, is a
  // 0-army neutral in B101 (−2): never taken, it would cut income.
  const sc: Scenario = {
    edges: '1-2 1-4 1-5 2-3 5-8 8-9',
    cells: { 1: 'M3', 2: 'n0', 3: 'n40', 4: 'n0', 5: 'M2', 8: 'n9', 9: 'E3' },
    bonuses: [
      [100, 1, [2, 3]],
      [101, -2, [4]],
    ],
    income: 5,
  };

  it('takes the 0-army neutral in the uneconomic bonus, and says why', () => {
    const p = planTurn(input(sc));
    expect(attacked(p, 2)).toBe(true);
    expect(why(p)).toMatch(/T2 \(#2\).*no-loss capture.*#426/);
  });

  it('never takes a member of a negative bonus, no-loss or not', () => {
    const p = planTurn(input(sc));
    expect(attacked(p, 4)).toBe(false);
  });

  it('never calls a neutral its attackers lose armies on a no-loss capture', () => {
    const p = planTurn(input({ ...sc, cells: { ...sc.cells, 2: 'n2' } }));
    expect(why(p)).not.toMatch(/#426/);
  });
});

describe('#426 rule 4d lets a no-loss capture through when only fog faces its new border', () => {
  // My T1 (2) alone, guarded goal. T2, a 0-army neutral beside it, borders T3: player 20's, its armies hidden
  // (owner shown, armies fogged), whose deploy is ~12 (a what-if): holding T2 next turn would need more than
  // my next income of 5, so rule 4d stopped it. With T3 in view (player 20's 1 army there), the border faces
  // a stack I can see: still stopped.
  const fogged = (id: number): TerritoryState => ({ territoryId: id, owner: { kind: 'player', playerId: 20 }, armies: null, fogLevel: 'OwnerOnly' });
  const sc: Scenario = { edges: '1-2 2-3 1-4', cells: { 1: 'M2', 2: 'n0', 4: 'n9' }, income: 5 };
  const deploy12 = (i: PlanInput): PlanInput => ({ ...i, options: { ...i.options, enemyDeploy: 12 } });
  const withFog = (): PlanInput => {
    const i = deploy12(input({ ...sc, cells: { ...sc.cells, 3: 'E1' } }));
    return { ...i, board: { ...i.board, territories: i.board.territories.map((t) => (t.territoryId === 3 ? fogged(3) : t)) } };
  };

  it('takes it, and says only the fog faces the new border', () => {
    const p = planTurn(withFog());
    expect(attacked(p, 2)).toBe(true);
    expect(why(p)).toMatch(/Take T2 \(#2\).*only the fog faces its new border.*#426/);
  });

  it('still stops it when a stack in view faces the new border', () => {
    const p = planTurn(deploy12(input({ ...sc, cells: { ...sc.cells, 3: 'E1' } })));
    expect(attacked(p, 2)).toBe(false);
    expect(why(p)).toMatch(/Frontier grows|frontier would then need/);
  });
});

