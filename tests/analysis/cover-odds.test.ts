// #167: one deploy lands on one territory. Borders that hold against an opponent's stacks alone but
// not with its whole deploy on them are a gamble on where it lands, and the plan says so with the
// odds. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine } from './helpers.js';

const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: 20 }, armies });
// Player 20's T2 touches my T1 and T3, each its own held +5 bonus.
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [
    { id: 1, name: 'T1', connectedTo: [2] },
    { id: 2, name: 'T2', connectedTo: [1, 3] },
    { id: 3, name: 'T3', connectedTo: [2] },
  ],
  bonuses: [
    { id: 1, name: 'B1', value: 5, territoryIds: [1], bonusIds: [] },
    { id: 3, name: 'B3', value: 5, territoryIds: [3], bonusIds: [] },
  ],
  distributionModes: [],
};
const g = buildGraph(map);
const plan = (income: number, deploy: number) =>
  planTurn({
    graph: g,
    board: board([mine(1, 10), enemy(2, 8), mine(3, 10)]),
    me: 10,
    income,
    settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
    game: { players: [{ id: 10 }, { id: 20 }], turn: 6 },
    options: { enemyDeploy: deploy },
  });
const why = (p: ReturnType<typeof planTurn>) => p.rationale.join('\n');

describe('#167: cover odds', () => {
  it('two borders short of the whole deploy: each holds half the time, both never', () => {
    // 10 need 16 to take: player 20's 7 movable cannot, 7 + 10 can. No income covers either.
    const p = plan(0, 10);
    expect(why(p)).toMatch(
      /Cover odds against player 20 \(#167\): its one ~10 deploy can land on one of the 2 borders facing it; 2 hold against its stacks alone but not with that deploy on them \(T1 \(#1\), T3 \(#3\)\) — a gamble on where it lands: if it picks among the 2 at random, each holds with chance 50%, and all of them with 0%\./,
    );
  });

  it('one border short: the chance it holds', () => {
    // Income 1 covers T1 (11 need 18), not T3.
    expect(why(plan(1, 10))).toMatch(/\(T3 \(#3\)\) — a gamble on where it lands: if it picks among the 2 at random, it holds with chance 50%\./);
  });

  it('borders sized for the whole deploy are no gamble', () => {
    expect(why(plan(30, 10))).not.toMatch(/Cover odds/);
  });

  it('a deploy that can be split over two short borders takes both: each holds with chance 0%', () => {
    // Player 20's two separate 15-stacks each face a 10 of mine (16 to take): each border is 2 short of
    // its stack alone, so a 2/2 split of its ~10 deploy takes both at once — no coin flip.
    const split: GameMap = {
      id: 2,
      name: 'Synthetic',
      territories: [
        { id: 1, name: 'T1', connectedTo: [2] },
        { id: 2, name: 'T2', connectedTo: [1] },
        { id: 3, name: 'T3', connectedTo: [4] },
        { id: 4, name: 'T4', connectedTo: [3] },
        { id: 5, name: 'T5', connectedTo: [6] },
        { id: 6, name: 'T6', connectedTo: [5] },
      ],
      bonuses: [
        { id: 1, name: 'B1', value: 5, territoryIds: [1], bonusIds: [] },
        { id: 3, name: 'B3', value: 5, territoryIds: [3], bonusIds: [] },
        { id: 5, name: 'B5', value: 5, territoryIds: [5], bonusIds: [] },
      ],
      distributionModes: [],
    };
    const p = planTurn({
      graph: buildGraph(split),
      board: board([mine(1, 10), enemy(2, 15), mine(3, 10), enemy(4, 15), mine(5, 30), enemy(6, 2)]),
      me: 10,
      income: 0,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players: [{ id: 10 }, { id: 20 }], turn: 6 },
      options: { enemyDeploy: 10 },
    });
    const line = p.rationale.find((l) => /Cover odds/.test(l));
    expect(line).toMatch(
      /Cover odds against player 20 \(#167\): its ~10 deploy, split, can take 2 of the \d+ borders facing it at once \(T1 \(#1\) short 2, T3 \(#3\) short 2\): each of those holds with chance 0%\./,
    );
    expect(line).not.toMatch(/50%/);
  });
});

describe('#201: cover odds when the split deploy funds only some of the short borders', () => {
  // Three separate 15-stacks of player 20 each face a 10 of mine (16 to take): each border is 2
  // short of its stack alone. A ~5 deploy funds two of those shortfalls at once, not all three.
  const three: GameMap = {
    id: 3,
    name: 'Synthetic',
    territories: [
      { id: 1, name: 'T1', connectedTo: [2] },
      { id: 2, name: 'T2', connectedTo: [1] },
      { id: 3, name: 'T3', connectedTo: [4] },
      { id: 4, name: 'T4', connectedTo: [3] },
      { id: 5, name: 'T5', connectedTo: [6] },
      { id: 6, name: 'T6', connectedTo: [5] },
    ],
    bonuses: [
      { id: 1, name: 'B1', value: 5, territoryIds: [1], bonusIds: [] },
      { id: 3, name: 'B3', value: 5, territoryIds: [3], bonusIds: [] },
      { id: 5, name: 'B5', value: 5, territoryIds: [5], bonusIds: [] },
    ],
    distributionModes: [],
  };
  const run = (deploy: number) =>
    planTurn({
      graph: buildGraph(three),
      board: board([mine(1, 10), enemy(2, 15), mine(3, 10), enemy(4, 15), mine(5, 10), enemy(6, 15)]),
      me: 10,
      income: 0,
      settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
      game: { players: [{ id: 10 }, { id: 20 }], turn: 6 },
      options: { enemyDeploy: deploy },
    }).rationale.find((l) => /Cover odds/.test(l));

  it('two of three: each holds with chance 33%, never a flat 0%', () => {
    const line = run(5);
    expect(line).toMatch(
      /its ~5 deploy, split, can take 2 of the 3 borders facing it at once \(T1 \(#1\) short 2, T3 \(#3\) short 2, T5 \(#5\) short 2\): if it picks 2 of those 3 at random, each holds with chance 33%, and all of them with 0%\./,
    );
    expect(line).not.toMatch(/each of those holds with chance 0%/);
  });

  it('a deploy that funds all three says 0%', () => {
    expect(run(6)).toMatch(/can take 3 of the 3 borders facing it at once \(.*\): each of those holds with chance 0%\./);
  });
});
