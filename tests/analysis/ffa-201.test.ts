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

  it('a smaller player holding a unit the board gives no strength for is judged the same way', () => {
    // Player 20 also holds T7 beside my T1, with a custom unit: it cannot be finished off this turn,
    // but absorbing it still would not catch the leader, so its counted T2 is not attacked either.
    const g7 = buildGraph({
      ...g.map,
      territories: [
        ...g.map.territories.map((t) => (t.id === 1 ? { ...t, connectedTo: [...t.connectedTo, 7] } : t)),
        { id: 7, name: 'T7', connectedTo: [1] },
      ],
      bonuses: [{ id: 803, name: 'B803', value: 10, territoryIds: [3, 4, 5], bonusIds: [] }],
    });
    const p = planTurn({
      graph: g7,
      board: board([
        mine(1, 20),
        enemy(2, 2, 20),
        enemy(3, 40, 30),
        enemy(4, 30, 30),
        enemy(5, 30, 30),
        neutral(6, 2),
        { ...enemy(7, 2, 20), specialUnits: [{ kind: 'custom', id: 'c1', playerId: 20 }] },
      ]),
      me: ME,
      income: 5,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: { adapt: true },
    });
    expect(attacks(p).some((m) => m.to === 2)).toBe(false);
    expect(p.rationale.join('\n')).toMatch(/Not finishing off player 20 \(#201\)/);
  });

  it('an explicit goal keeps the old behaviour', () => {
    expect(attacks(run(10, false)).some((m) => m.to === 2)).toBe(true);
  });
});

describe('#201: the FFA leader holds against every adjacent opponent together', () => {
  // My T1 (+5 bonus B801) faces player 20's T2 and player 30's T3, each 9 armies. Each alone (8
  // movable + its ~5 deploy = 13) cannot take my 12 (16 to take); together they can. I lead on
  // strength (my 60-stack T4 far away), so T1 is held against both at once.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5],
      [
        [1, 2],
        [1, 3],
        [1, 4],
        [4, 5],
      ],
      [[801, 5, [1]]],
    ),
  );
  const run = (adapt: boolean, myStack = 60) =>
    planTurn({
      graph: g,
      board: board([mine(1, 12), enemy(2, 9, 20), enemy(3, 9, 30), mine(4, myStack), neutral(5, 50)]),
      me: ME,
      income: 10,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: adapt ? { adapt: true, enemyDeploy: 5 } : { goal: 'balanced', enemyDeploy: 5 },
    });
  const at = (p: TurnPlan, t: number) => p.deploys.filter((d) => d.territoryId === t).reduce((n, d) => n + d.armies, 0);

  it('leading, the border is sized for both opponents together', () => {
    const p = run(true);
    expect(p.profile.ranking?.leader).toBe(ME);
    expect(at(p, 1)).toBeGreaterThan(0);
    expect(p.rationale.join('\n')).toMatch(/I lead this free-for-all \(#201\): T1 \(#1\) is held against players 20 and 30 attacking together/);
  });

  it('not adapting, each player is judged alone (the pile-on is a warning)', () => {
    const p = run(false);
    expect(p.rationale.join('\n')).not.toMatch(/I lead this free-for-all/);
  });
});

describe('#201: the FFA leader sizes a break to land against one deploy', () => {
  // My 40 on T1 beside player 20's T2 (2 armies), a member of its +4 B802 (T2, T3). Player 20's
  // ~6 deploy can land on T2 first: the leader's break is sized for 2 + 6. Player 30 holds T5, T6.
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
  const run = (adapt: boolean) =>
    planTurn({
      graph: g,
      board: board([mine(1, 40), enemy(2, 2, 20), enemy(3, 2, 20), enemy(4, 3, 20), enemy(5, 3, 30), enemy(6, 3, 30)]),
      me: ME,
      income: 12,
      settings: STD,
      game: { players: [{ id: ME }, { id: 20 }, { id: 30 }], turn: 8 },
      options: adapt ? { adapt: true, enemyDeploy: 6 } : { goal: 'balanced', enemyDeploy: 6 },
    });

  it('leading: the break attack takes 2 + 6 defenders for certain', () => {
    const p = run(true);
    expect(p.profile.ranking?.leader).toBe(ME);
    const a = attacks(p).find((m) => m.to === 2);
    expect(a).toBeDefined();
    // 8 defenders: 13 take them for certain at 60% (13 × 0.6 = 7.8, rounded to 8).
    expect(a!.armies).toBeGreaterThanOrEqual(13);
    expect(a!.reason).toMatch(/sized to land against player 20's ~6 deploy \(#201: I lead this free-for-all\)/);
  });

  it('not adapting: the break is sized for the defenders as they stand', () => {
    const a = attacks(run(false)).find((m) => m.to === 2);
    expect(a?.reason ?? '').not.toMatch(/#201/);
  });
});
