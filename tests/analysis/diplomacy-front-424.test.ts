// Issue #424: a Diplomacy card in force with the only opponent beside me leaves no foe in view, yet its
// border is still the front the card's end reopens: the leftover goes there, not central or to the
// expansion stack. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { PlanRelation } from '../../src/analysis/plan/shared.js';
import type { GameMap } from '../../src/normalize.js';
import { board } from './helpers.js';

const ME = 10;
const PARTNER = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

/** 'M5' mine 5, 'n2' neutral 2, 'E3' player 20 with 3. */
const cell = (id: number, s: string): TerritoryState => {
  const n = Number(s.slice(1));
  if (s[0] === 'n') return { territoryId: id, owner: { kind: 'neutral' }, armies: n };
  return { territoryId: id, owner: { kind: 'player', playerId: s[0] === 'M' ? ME : PARTNER }, armies: n };
};

function input(edges: string, cells: Record<number, string>, relations: PlanRelation[] = []): PlanInput {
  const adj = new Map<number, Set<number>>();
  const ids = new Set(Object.keys(cells).map(Number));
  for (const e of edges.split(/\s+/).filter(Boolean)) {
    const [a, b] = e.split('-').map(Number) as [number, number];
    ids.add(a);
    ids.add(b);
    (adj.get(a) ?? adj.set(a, new Set()).get(a)!).add(b);
    (adj.get(b) ?? adj.set(b, new Set()).get(b)!).add(a);
  }
  const map: GameMap = {
    id: 1,
    name: 'Peace',
    territories: [...ids].sort((a, b) => a - b).map((id) => ({ id, name: `T${id}`, connectedTo: [...(adj.get(id) ?? [])].sort((a, b) => a - b) })),
    bonuses: [],
    distributionModes: [],
  };
  return {
    graph: buildGraph(map),
    board: board(Object.entries(cells).map(([id, s]) => cell(Number(id), s)), true),
    me: ME,
    income: 30,
    settings: STD,
    options: { adapt: true },
    game: { players: [ME, PARTNER, 30].map((id) => ({ id })), turn: 12, fog: 'Foggy' },
    ...(relations.length ? { relations } : {}),
  };
}
const deployedTo = (p: TurnPlan, id: number) => p.deploys.filter((d) => d.territoryId === id).reduce((n, d) => n + d.armies, 0);
const why = (p: TurnPlan) => p.rationale.join('\n');
const card: PlanRelation = { player: PARTNER, coveredMine: [], coveredTheirs: [], state: 'active', trust: 'clear', enforced: true, enforcedUntil: 14, card: 'Diplomacy' };

describe('#424 the Diplomacy partner border stays the front for the leftover', () => {
  // My land is a line T1..T7; the cheap expansion is T8 off T7; the partner's 30 stand on T11 beside T1.
  const edges = '1-2 2-3 3-4 4-5 5-6 6-7 7-8 8-10 1-11';
  const cells = { 1: 'M2', 2: 'M2', 3: 'M2', 4: 'M2', 5: 'M2', 6: 'M2', 7: 'M5', 8: 'n2', 10: 'n2', 11: 'E30' };

  it('goes to the border facing the partner, not central', () => {
    const p = planTurn(input(edges, cells, [card]));
    expect(p.moves).toContainEqual(expect.objectContaining({ from: 7, to: 8, kind: 'attack' }));
    expect(p.moves.some((m) => m.to === 11)).toBe(false);
    expect(deployedTo(p, 1)).toBe(30);
    expect(why(p)).toMatch(
      /Deploy the leftover 30 to T1 \(#1\): the border facing player 20, at peace by a Diplomacy card in force until turn 14 — no other enemy is in view, and its border is the front again once the card ends \(#424\)\./,
    );
    expect(why(p)).not.toMatch(/no front to go to/);
  });

  it('a partner with no stack beside me changes nothing', () => {
    const p = planTurn(input('1-2 2-3 3-4 4-5 5-6 6-7 7-8 8-10 1-9 10-11', { ...cells, 9: 'n4' }, [card]));
    expect(why(p)).not.toMatch(/#424/);
  });
});
