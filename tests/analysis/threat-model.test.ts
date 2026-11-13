// Issue #128: the smaller gaps in the planner's threat model, each on a synthetic map (every id
// and name here is made up).
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { enemyDeployEstimates, planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Threats',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const player = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const deployedTo = (p: TurnPlan, id: number) => p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;
const attacksOn = (p: TurnPlan, id: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === id);

describe('teammates are allies (#128)', () => {
  // 1 2 mine (+4); 3 4 a teammate's (+3), 3 holding 20 next to my 2; 5 6 neutral; 7 an enemy far off.
  const g = buildGraph(
    makeMap(
      [1, 2, 3, 4, 5, 6, 7],
      [[1, 2], [2, 3], [3, 4], [1, 5], [5, 6], [6, 7]],
      [[101, 4, [1, 2]], [102, 3, [3, 4]]],
    ),
  );
  const TEAMMATE = 11;
  const players = [
    { id: ME, team: 0 },
    { id: TEAMMATE, team: 0 },
    { id: 20, team: 1 },
    { id: 21, team: 1 },
  ];
  it("a teammate's stack next to my held bonus is no threat: nothing is conceded or withdrawn", () => {
    const b = board([mine(1, 3), mine(2, 3), player(3, 20, TEAMMATE), player(4, 2, TEAMMATE), neutral(5, 2), neutral(6, 2), player(7, 3, 20)]);
    const plan = planTurn({ graph: g, board: b, me: ME, income: 9, settings: STD, game: { players, turn: 8 }, options: { adapt: true } });
    expect(plan.conceded).toEqual([]);
    expect(plan.moves.filter((m) => m.from === 2 && m.kind === 'transfer')).toEqual([]);
    expect(plan.warnings.join('\n')).not.toMatch(/estimate for player 11/);
    expect(plan.rationale.join('\n')).not.toMatch(/cannot be held economically/);
  });
  it('a weak teammate in reach of a big stack is never attacked', () => {
    const b = board([mine(1, 3), mine(2, 30), player(3, 2, TEAMMATE), player(4, 1, TEAMMATE), neutral(5, 2), neutral(6, 2), player(7, 3, 20)]);
    const plan = planTurn({ graph: g, board: b, me: ME, income: 9, settings: STD, game: { players, turn: 8 }, options: { adapt: true } });
    expect(attacksOn(plan, 3)).toEqual([]);
    expect(attacksOn(plan, 4)).toEqual([]);
    expect(plan.expected.captures).not.toContain(3);
    expect(plan.expected.captures).not.toContain(4);
  });
  it('without the team list the same player is an opponent (unchanged)', () => {
    const b = board([mine(1, 3), mine(2, 30), player(3, 2, TEAMMATE), player(4, 1, TEAMMATE), neutral(5, 2), neutral(6, 2), player(7, 3, 20)]);
    const plan = planTurn({ graph: g, board: b, me: ME, income: 9, settings: STD, options: { adapt: true } });
    expect(attacksOn(plan, 3).length + attacksOn(plan, 4).length).toBeGreaterThan(0);
  });
});

describe('several stacks of one owner attack separately (#128)', () => {
  // 1 2 mine (+3, held); enemy 3 (2 armies) and 4 (4 armies) both next to 1; 5 behind them.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [1, 3], [1, 4], [3, 5], [4, 5]], [[101, 3, [1, 2]]]));
  const b = board([mine(1, 3), mine(2, 1), player(3, 2, 20), player(4, 4, 20), player(5, 1, 20)]);
  it('a hold counts the 1-army softener: 6 armies fall to 1 then 8, so it needs 7', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 4, settings: STD, options: { goal: 'defend', enemyDeploy: 5 } });
    expect(deployedTo(plan, 1)).toBe(4);
    expect(plan.rationale.join('\n')).not.toMatch(/6 armies need 10 to take, above/);
    expect(plan.warnings.join('\n')).toMatch(/separate attacks \(3 then 6\), its stacks take up to 6/);
  });
  it('short of that, the plan says the bonus may fall rather than that it holds', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 3, settings: STD, options: { goal: 'defend', enemyDeploy: 5 } });
    expect(plan.rationale.join('\n')).not.toMatch(/so it holds/);
    expect(plan.warnings.join('\n')).toMatch(/T1 \(#1\) may fall/);
  });
});

describe('two opponents at one border (#128)', () => {
  // 1 2 mine (+5); 3 (player 20) and 4 (player 30), 6 armies each, both next to 1.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [1, 3], [1, 4], [3, 5], [4, 6]], [[101, 5, [1, 2]]]));
  const b = board([mine(1, 4), mine(2, 1), player(3, 6, 20), player(4, 6, 30), neutral(5, 2), neutral(6, 2)]);
  it('in an FFA a border that holds against each alone is warned about when both together could take it', () => {
    const players = [{ id: ME }, { id: 20 }, { id: 30 }];
    const plan = planTurn({ graph: g, board: b, me: ME, income: 3, settings: STD, game: { players, turn: 8 }, options: { goal: 'defend' } });
    expect(deployedTo(plan, 1)).toBe(3);
    expect(plan.warnings.join('\n')).toMatch(
      /T1 \(#1\) holds against each opponent alone, but players 20 and 30 attacking it in the same turn \(10 then 10\) could take up to 12 armies, and 7 stay there/,
    );
  });
  it('opponents on one team attack together: the hold is sized for both', () => {
    const players = [
      { id: ME, team: 0 },
      { id: 20, team: 1 },
      { id: 30, team: 1 },
    ];
    const plan = planTurn({ graph: g, board: b, me: ME, income: 12, settings: STD, game: { players, turn: 8 }, options: { goal: 'defend' } });
    // 10 then 10 take up to 12 (6 killed, then 10 take 6): 13 hold, so at least 9 go to T1.
    expect(deployedTo(plan, 1)).toBeGreaterThanOrEqual(9);
    expect(plan.rationale.join('\n')).toMatch(/Deploy 9 to T1 \(#1\) so it holds/);
  });
});

describe("the opponent's Local Deployment pools land only in their own bonus (#128)", () => {
  // 1 2 3 mine (+4); enemy 4 (20) next to 3, outside its +12 bonus 5 6 7.
  const g = buildGraph(
    makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]], [[101, 4, [1, 2, 3]], [102, 12, [5, 6, 7]]]),
  );
  const LD: PlannerSettings = { ...STD, localDeployments: true };
  it('a pool whose bonus holds no stack next to me is not part of the threat there', () => {
    const b = board([mine(1, 1), mine(2, 1), mine(3, 15), player(4, 20, 20), player(5, 1, 20), player(6, 1, 20), player(7, 1, 20)]);
    const plan = planTurn({ graph: g, board: b, me: ME, income: 9, settings: LD, options: { goal: 'defend' } });
    // 19 movable + its 5 free armies = 24: 15 need 25 to take.
    expect(plan.warnings.join('\n')).not.toMatch(/T3 \(#3\) \(15 armies\) could be taken/);
  });
  it('the same pool counts in full when its bonus holds the stack next to me', () => {
    const g2 = buildGraph(
      makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]], [[101, 4, [1, 2, 3]], [102, 12, [4, 5, 6]]]),
    );
    const b = board([mine(1, 1), mine(2, 1), mine(3, 15), player(4, 20, 20), player(5, 1, 20), player(6, 1, 20), player(7, 1, 20)]);
    const plan = planTurn({ graph: g2, board: b, me: ME, income: 9, settings: LD, options: { goal: 'defend' } });
    expect(plan.warnings.join('\n')).toMatch(/T3 \(#3\) \(15 armies\) could be taken next turn: player 20 has 19 movable armies next to it plus ~17 deploy/);
  });
  it('without Local Deployment the pool lands anywhere (unchanged)', () => {
    const b = board([mine(1, 1), mine(2, 1), mine(3, 15), player(4, 20, 20), player(5, 1, 20), player(6, 1, 20), player(7, 1, 20)]);
    const plan = planTurn({ graph: g, board: b, me: ME, income: 9, settings: STD, options: { goal: 'defend' } });
    expect(plan.warnings.join('\n')).toMatch(/T3 \(#3\) \(15 armies\) could be taken next turn: player 20 has 19 movable armies next to it plus ~17 deploy/);
  });
});

describe("an enemy commander counts in the expected attack (#128)", () => {
  // 1 2 mine (+2); enemy 3 next to 1: 9 armies and a commander (fights as 16), or 16 plain armies.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [1, 3], [3, 4], [2, 5]], [[101, 2, [1, 2]]]));
  const withCommander: TerritoryState = { ...player(3, 9, 20), specialUnits: [{ kind: 'commander', id: 'u1', playerId: 20 }] };
  const plan = (three: TerritoryState) =>
    planTurn({
      graph: g,
      board: board([mine(1, 15), mine(2, 1), three, player(4, 1, 20), neutral(5, 9)]),
      me: ME,
      income: 1,
      settings: STD,
      options: { goal: 'balanced', enemyDeploy: 15 },
    });
  it('a short border next to a commander is judged as next to the armies it fights as', () => {
    const a = plan(withCommander);
    const c = plan(player(3, 16, 20));
    expect(a.conceded).toEqual(c.conceded);
    expect(a.deploys).toEqual(c.deploys);
    expect(a.warnings.join('\n')).not.toMatch(/expected ~23 attack/);
  });
});

describe('a hold deferred for the expansion share is not then conceded (#128)', () => {
  // enemy 3 (51) - 1 (30) - 2 (1) - 5 6 (neutral +4) - 7 - 8 (a third player). Income 5: the hold
  // of 1 costs 4, the expansion share is 2, and the advance toward the +4 completes nothing.
  const g = buildGraph(makeMap([1, 2, 3, 5, 6, 7, 8], [[3, 1], [1, 2], [2, 5], [5, 6], [6, 7], [7, 8]], [[102, 4, [5, 6]]]));
  const b = board([mine(1, 30), mine(2, 1), player(3, 51, 20), neutral(5, 2), neutral(6, 2), neutral(7, 2), player(8, 3, 30)]);
  const players = [{ id: ME }, { id: 20 }, { id: 30 }];
  it('holds the 30-stack rather than advancing and withdrawing it', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, game: { players, turn: 9 }, options: { adapt: true } });
    expect(plan.conceded).toEqual([]);
    expect(deployedTo(plan, 1)).toBeGreaterThanOrEqual(4);
    expect(plan.moves.filter((m) => m.from === 1)).toEqual([]);
  });
});

describe('opening-board detection reads only the players\' stacks (#128)', () => {
  // 1 mine; 2 and 4 player 20's (it holds +5 bonus 502 in full); 5 player 30's; 3 a 2-army neutral.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [1, 3], [2, 4], [1, 5]], [[501, 1, [3]], [502, 5, [2, 4]]]));
  it('starting stacks of 5 beside 2-army neutrals are the opening board', () => {
    const b = board([mine(1, 5), player(2, 5, 20), neutral(3, 2), player(4, 5, 20), player(5, 5, 30)]);
    const es = enemyDeployEstimates(g, b, ME);
    expect(es.map((e) => [e.playerId, e.opening])).toEqual([
      [20, true],
      [30, true],
    ]);
  });
  it('one player stack off the starting count is not', () => {
    const b = board([mine(1, 5), player(2, 8, 20), neutral(3, 2), player(4, 5, 20), player(5, 5, 30)]);
    expect(enemyDeployEstimates(g, b, ME).every((e) => !e.opening)).toBe(true);
  });
});

describe('bosses and custom units are never counted as nothing in silence (#128)', () => {
  // 1 mine (10); 2 a 2-army neutral with a boss; 3 a plain 2-army neutral; 4 an enemy with a custom unit.
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [1, 3], [1, 4]], []));
  const boss: TerritoryState = { ...neutral(2, 2), specialUnits: [{ kind: 'boss', id: 'b1', playerId: 0 }] };
  const custom: TerritoryState = { ...player(4, 3, 20), specialUnits: [{ kind: 'custom', id: 'c1', playerId: 20 }] };
  const plan = planTurn({ graph: g, board: board([mine(1, 10), boss, neutral(3, 2), custom]), me: ME, income: 5, settings: STD, options: { goal: 'expand' } });
  it('a territory with a boss is not attacked at a stated certainty, and the plan says why', () => {
    expect(attacksOn(plan, 2)).toEqual([]);
    expect(plan.warnings.join('\n')).toMatch(/T2 \(#2\) holds a boss, whose strength the board does not carry: its defence is unknown, so no attack is planned on it/);
    expect(attacksOn(plan, 3).length).toBe(1);
  });
  it("an enemy's custom unit next to me is named as left out of the threat", () => {
    expect(plan.warnings.join('\n')).toMatch(/T4 \(#4\) \(player 20\) holds a custom unit, whose strength the board does not carry: the threat to T1 \(#1\) counts its armies only/);
  });
});

describe('protected value counts an overlapping negative bonus (#128)', () => {
  // 1 2 3 mine: +5 group (1 2 3) and a −4 singleton (3); enemy 4 (8) next to 3.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5], [[1, 2], [2, 3], [3, 4], [4, 5]], [[101, 5, [1, 2, 3]], [103, -4, [3]]]));
  it('a border whose loss costs 1 income protects +1, not +5', () => {
    const b = board([mine(1, 1), mine(2, 1), mine(3, 4), player(4, 8, 20), player(5, 1, 20)]);
    const plan = planTurn({ graph: g, board: b, me: ME, income: 6, settings: STD, options: { goal: 'balanced' } });
    const text = plan.rationale.join('\n') + plan.warnings.join('\n');
    expect(text).toMatch(/T3 \(#3\) so it holds \(protects \+1\)/);
    expect(text).not.toMatch(/protects \+5/);
  });
});
