// #201: the parts of #167's free-for-all items deferred from planner batch 3 — absorbing a smaller
// neighbour only when it closes the gap to the leader, the leader's holds against every adjacent
// opponent together and its breaks sized against one deploy, and the retaliation a break without an
// elimination invites. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
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
const enemy = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');

describe('#201: a break without an elimination invites retaliation', () => {
  // My 30 on T1 beside player 20's T2 (2), a member of its +4 B802 (T2, T3). Its T4 (10) is out of
  // my reach, so taking T2 breaks the bonus without eliminating it. Player 30's T5 also faces T1.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6],
      [
        [1, 2],
        [2, 3],
        [3, 4],
        [1, 5],
        [5, 6],
      ],
      [[802, 4, [2, 3]]],
    ),
  );
  const input = (players: number[]): PlanInput => ({
    graph: g,
    board: board([mine(1, 30), enemy(2, 2, 20), enemy(3, 2, 20), enemy(4, 10, 20), ...(players.includes(30) ? [enemy(5, 3, 30)] : [neutral(5, 3)]), neutral(6, 2)]),
    me: ME,
    income: 5,
    settings: STD,
    game: { players: players.map((id) => ({ id })), turn: 8 },
    options: { goal: 'balanced', enemyDeploy: 5 },
  });

  it('in an FFA, a break that leaves its owner alive is a warning', () => {
    const p = planTurn(input([ME, 20, 30]));
    expect(attacks(p).some((m) => m.to === 2)).toBe(true);
    expect(p.warnings.join('\n')).toMatch(
      /Breaking player 20's bonus B802 \(\+4\) without eliminating it invites retaliation \(#201\): it keeps 2 territories in view \(\d+ armies\) and a ~5 deploy, and loses \+4 a turn to me/,
    );
  });

  it('in a 1v1 the opponent attacks me anyway: no warning', () => {
    const p = planTurn(input([ME, 20]));
    expect(attacks(p).some((m) => m.to === 2)).toBe(true);
    expect(p.warnings.join('\n')).not.toMatch(/invites retaliation/);
  });
});

describe('#201: absorb a smaller neighbour only when it closes the gap to the leader', () => {
  // My 20 on T1 beside player 20's lone T2 (2 armies): fully visible, an elimination in reach.
  // Player 30 leads far away (T3–T5, 100 armies) with bonus B803 worth `lead`.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6],
      [
        [1, 2],
        [1, 6],
        [3, 4],
        [4, 5],
        [5, 6],
      ],
      [[803, 0, [3, 4, 5]]],
    ),
  );
  const run = (lead: number, adapt = true) =>
    planTurn({
      graph: buildGraph({ ...g.map, bonuses: [{ id: 803, name: 'B803', value: lead, territoryIds: [3, 4, 5], bonusIds: [] }] }),
      board: board([mine(1, 20), enemy(2, 2, 20), enemy(3, 40, 30), enemy(4, 30, 30), enemy(5, 30, 30), neutral(6, 2)]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: adapt ? { adapt: true } : { goal: 'balanced' },
    });

  it('my income plus its income short of the leader: not finished off', () => {
    const p = run(10);
    expect(attacks(p).some((m) => m.to === 2)).toBe(false);
    expect(p.rationale.join('\n')).toMatch(
      /Not finishing off player 20 \(#201\): player 30 leads the free-for-all on ~15 income; absorbing player 20's ~5 brings mine from 5 to 10, short of it — the others are better spent against the leader\./,
    );
    expect(p.rationale.join('\n')).toMatch(/Not attacking .*T2 \(#2\).*would not bring my income to the FFA leader's/);
  });

  it('enough to match the leader: finished off', () => {
    const p = run(4);
    expect(attacks(p).some((m) => m.to === 2)).toBe(true);
    expect(p.rationale.join('\n')).toMatch(/Absorb player 20 \(#201\): its ~5 income brings mine from 5 to 10, matching leader player 30's ~9\./);
  });

  it('an explicit goal keeps the old behaviour', () => {
    expect(attacks(run(10, false)).some((m) => m.to === 2)).toBe(true);
  });
});
