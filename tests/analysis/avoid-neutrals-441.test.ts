// #441: avoiding a player also skips the neutrals inside the bonus it is collecting — a neutral whose only
// enemy neighbour is that player, or in a bonus it visibly holds most of — unless the capture completes a
// bonus of mine or would hold next turn. Ids and names are made up.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const OTHER = 30;

// My T1 (20) beside the neutrals T2 (2) and T4 (2) and the neutral T5 (2). T2 also borders the
// avoided player's T3; T5 sits in bonus B (T5, T6, T7), whose T6 and T7 the avoided player holds,
// and borders T6 and player 30's T8.
const map = (bonuses: GameMap['bonuses'] = []): GameMap => ({
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2, 4, 5] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
    { id: 4, name: 'T4', connectedTo: [1] },
    { id: 5, name: 'T5', connectedTo: [1, 6, 8] },
    { id: 6, name: 'T6', connectedTo: [5, 7] },
    { id: 7, name: 'T7', connectedTo: [6] },
    { id: 8, name: 'T8', connectedTo: [5] },
  ],
  bonuses: [{ id: 1, name: 'B', value: 3, territoryIds: [5, 6, 7], bonusIds: [] }, ...bonuses],
  distributionModes: [],
});
const input = (o: { avoid?: boolean; stack?: number; bonuses?: GameMap['bonuses'] } = {}): PlanInput => ({
  graph: buildGraph(map(o.bonuses)),
  board: board([
    mine(1, 30),
    neutral(2, 2),
    mine(3, o.stack ?? 20, FOE),
    neutral(4, 2),
    neutral(5, 2),
    mine(6, 12, FOE),
    mine(7, 1, FOE),
    mine(8, 1, OTHER),
  ]),
  me: ME,
  income: 20,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70 },
  game: { players: [{ id: ME }, { id: FOE }, { id: OTHER }], turn: 5 },
  options: { enemyDeploy: 1, ...(o.avoid ? { avoid: { players: [FOE] } } : {}) },
});
const plan = (o: Parameters<typeof input>[0]) => planTurn(input(o));
const targets = (o: Parameters<typeof input>[0]) =>
  plan(o)
    .moves.filter((m) => m.kind === 'attack')
    .map((m) => m.to)
    .sort();

describe('avoiding a player skips the neutrals it is collecting (#441)', () => {
  it('takes them when nobody is avoided', () => {
    expect(targets({})).toEqual(expect.arrayContaining([2, 5]));
  });
  it('skips a neutral whose only enemy neighbour is the avoided player, and one in a bonus it holds most of', () => {
    const p = plan({ avoid: true });
    const t = p.moves.filter((m) => m.kind === 'attack').map((m) => m.to);
    expect(t).not.toContain(2);
    expect(t).not.toContain(5);
    expect(t).toContain(4);
    expect(p.rationale.join('\n')).toMatch(/T2 \(#2\).*#441/);
    expect(p.rationale.join('\n')).toMatch(/T5 \(#5\).*#441/);
  });
  it('still takes one the capture would hold next turn', () => {
    expect(targets({ avoid: true, stack: 2 })).toContain(2);
  });
  it('still takes one that completes a bonus of mine', () => {
    expect(targets({ avoid: true, bonuses: [{ id: 2, name: 'Mine', value: 2, territoryIds: [1, 2], bonusIds: [] }] })).toContain(2);
  });
});
