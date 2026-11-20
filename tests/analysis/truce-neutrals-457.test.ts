// #457: while a truce with player P binds (active or in notice), the plan treats a neutral the way #441 treats an
// avoided player's: it skips one whose only enemy neighbour is P, or one in a bonus P visibly holds most of, unless
// the capture completes a bonus of mine — and says so. A neutral it does take beside P's land is warned of, so the
// owner can tell P first. Ids and names are made up.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput } from '../../src/analysis/planner.js';
import type { PlanRelation } from '../../src/analysis/plan/shared.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const P = 20;
const OTHER = 30;

// The #441 layout: my T1 (30) beside the neutrals T2, T4 and T5. T2 also borders P's T3; T5 sits in bonus B
// (T5, T6, T7), whose T6 and T7 P holds, and borders T6 and player 30's T8.
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
const truce = (over: Partial<PlanRelation> = {}): PlanRelation => ({
  player: P,
  coveredMine: [1],
  coveredTheirs: [3, 6, 7],
  state: 'active',
  trust: 'clear',
  ...over,
});
const input = (o: { relations?: PlanRelation[]; stack?: number; bonuses?: GameMap['bonuses'] } = {}): PlanInput => ({
  graph: buildGraph(map(o.bonuses)),
  board: board([mine(1, 30), neutral(2, 2), mine(3, o.stack ?? 20, P), neutral(4, 2), neutral(5, 2), mine(6, 12, P), mine(7, 1, P), mine(8, 1, OTHER)]),
  me: ME,
  income: 20,
  settings: { offensiveKillRate: 60, defensiveKillRate: 70 },
  game: { players: [{ id: ME }, { id: P }, { id: OTHER }], turn: 5 },
  options: { enemyDeploy: 1 },
  ...(o.relations ? { relations: o.relations } : {}),
});
const attacks = (p: ReturnType<typeof planTurn>) =>
  p.moves
    .filter((m) => m.kind === 'attack')
    .map((m) => m.to)
    .sort();

describe('a truce partner\'s neutrals (#457)', () => {
  it('takes them with no truce, and with a broken one', () => {
    expect(attacks(planTurn(input()))).toEqual(expect.arrayContaining([2, 5]));
    const broken = planTurn(input({ relations: [truce({ state: 'broken', breach: { term: 'x', turn: 4, evidence: 'y', territories: [1] } })] }));
    expect(attacks(broken)).toEqual(expect.arrayContaining([2, 5]));
  });

  for (const state of ['active', 'notice'] as const) {
    it(`skips, while the truce is ${state}, a neutral whose only enemy neighbour is the partner and one in a bonus it holds most of, saying so`, () => {
      const p = planTurn(input({ relations: [truce({ state, ...(state === 'notice' ? { endsTurn: 7, noticeBy: 'them' as const } : {}) })] }));
      const t = attacks(p);
      expect(t).not.toContain(2);
      expect(t).not.toContain(5);
      expect(t).toContain(4);
      const why = p.rationale.join('\n');
      expect(why).toMatch(/Not taking T2 \(#2\): its only enemy neighbour is player 20, with whom a truce binds you.*may read as a breach to player 20.*\(#457\)/);
      expect(why).toMatch(/Not taking T5 \(#5\): it sits in a bonus player 20 visibly holds most of, with whom a truce binds you.*\(#457\)/);
      // Nothing taken beside the partner: no breach warning.
      expect(p.warnings.join('\n')).not.toMatch(/may read as a breach/);
    });
  }

  it('skips one even when the capture would hold next turn (unlike #441: the point is the partner, not the hold)', () => {
    expect(attacks(planTurn(input({ relations: [truce()], stack: 2 })))).not.toContain(2);
  });

  it('takes one that completes a bonus of mine, and warns that it may read as a breach to the partner', () => {
    const p = planTurn(input({ relations: [truce()], bonuses: [{ id: 2, name: 'Mine', value: 2, territoryIds: [1, 2], bonusIds: [] }] }));
    expect(attacks(p)).toContain(2);
    expect(p.warnings.join('\n')).toMatch(/Taking T2 \(#2\), a neutral beside player 20's land, may read as a breach to player 20 \(a truce binds you\): tell player 20 first \(#457\)/);
  });
});
