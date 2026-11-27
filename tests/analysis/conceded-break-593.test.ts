// #593 (follow-up): a break may attack out of a conceded border, funded by a deploy there. Rule 1a concedes a
// border it cannot hold, and a conceded border used to attack only with the armies already on it, so a bonus
// of his beside it went unbroken while the deploy went elsewhere. Now the deploy that lands there leaves with
// the break, sized for the attack alone. In miniature (every map, id and name made up):
//
//   T6 (his 30) ─ T1 (mine 2) ─ T2 (his 2) ─ T3 (his 2)      B900 (+4): T2, T3
//                  │
//                  T8 (mine 6) ─ T9 (neutral 2)               B901 (+1): T8, T9
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const HIM = 20;
const his = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId: HIM },
  armies,
});
const edges: [number, number][] = [[6, 1], [1, 2], [2, 3], [1, 8], [8, 9], [6, 7]];
const ids = [1, 2, 3, 6, 7, 8, 9];
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: ids.map((id) => ({
    id,
    name: `T${id}`,
    connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
  })),
  bonuses: [
    { id: 900, name: 'B900', value: 4, territoryIds: [2, 3], bonusIds: [] },
    { id: 901, name: 'B901', value: 1, territoryIds: [8, 9], bonusIds: [] },
    { id: 902, name: 'B902', value: 2, territoryIds: [6, 7], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(map);
const settings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true } as const;
const input = (t3: TerritoryState = his(3, 2)): PlanInput => ({
  graph: g,
  board: board([mine(1, 2), his(2, 2), t3, his(6, 30), his(7, 2), mine(8, 6), neutral(9, 2)]),
  me: ME,
  income: 6,
  settings,
  game: { players: [{ id: ME }, { id: HIM }], turn: 8 },
  turn: 8,
  options: { adapt: true },
});

describe('a break out of a conceded border (#593)', () => {
  it('deploys on the conceded border and attacks out to break the bonus', () => {
    const plan = planTurn(input());
    const attack = plan.moves.find((m) => m.from === 1 && m.to === 2);
    expect(plan.conceded).toContain(1);
    expect(attack?.kind).toBe('attack');
    expect(plan.deploys.find((d) => d.territoryId === 1)?.armies ?? 0).toBeGreaterThan(0);
    expect(plan.rationale.some((l) => l.includes('a break may be funded on a conceded source') && l.includes('(#593)'))).toBe(true);
  });

  it('funds no plain capture there: with T3 neutral, T2 breaks nothing and T1 still withdraws', () => {
    const plan = planTurn(input(neutral(3, 2)));
    expect(plan.conceded).toContain(1);
    expect(plan.moves.some((m) => m.from === 1 && m.to === 2)).toBe(false);
    expect(plan.deploys.find((d) => d.territoryId === 1)).toBeUndefined();
  });
});
