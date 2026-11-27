// #593: a held bonus's hub member — one bordering most of the bonus's other members — is valued for the members its
// fall takes, not only for its own +V. Every map, id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
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
const enemy = (territoryId: number, armies: number, playerId = FOE): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

/**
 * B914 (+4) is T11–T15. T15, the hub, borders all four other members and is the bonus's only gate toward player 20's
 * T87; the others link to each other in a chain and to my T30, behind which neutrals T40–T43 wait. With `hub: false`
 * T15 borders only T11 (T12–T14 hang off T11 instead), so it is the same gate but no hub.
 */
function plan(opts: { hub?: boolean; foe?: number; income?: number; enemyDeploy?: number } = {}): TurnPlan {
  const hub = opts.hub ?? true;
  const edges: [number, number][] = [
    [15, 87],
    [15, 11],
    ...(hub
      ? ([
          [15, 12],
          [15, 13],
          [15, 14],
        ] as [number, number][])
      : ([
          [11, 13],
          [11, 14],
        ] as [number, number][])),
    [11, 12],
    [12, 13],
    [13, 14],
    [11, 30],
    [30, 40],
    [30, 41],
    [14, 42],
    [12, 43],
  ];
  return planTurn({
    graph: buildGraph(makeMap([11, 12, 13, 14, 15, 30, 40, 41, 42, 43, 87], edges, [[914, 4, [11, 12, 13, 14, 15]], [950, 2, [40, 41]], [951, 2, [42, 43]]])),
    board: board([
      mine(11, 1),
      mine(12, 1),
      mine(13, 1),
      mine(14, 1),
      mine(15, 3),
      mine(30, 1),
      neutral(40, 2),
      neutral(41, 2),
      neutral(42, 2),
      neutral(43, 2),
      enemy(87, opts.foe ?? 21),
    ]),
    me: ME,
    income: opts.income ?? 17,
    settings: STD,
    game: { players: [{ id: ME }, { id: FOE }], turn: 6 },
    options: { goal: 'balanced', enemyDeploy: opts.enemyDeploy ?? 8 },
  });
}
/** Game 12 turn 12's shape (below): B903 (+hv) with its hub T1, and three +cv bonuses each one 2-army neutral short. */
function game12(hv: number, cv: number, income: number, enemyDeploy: number): TurnPlan {
return planTurn({
    graph: buildGraph(
      makeMap(
        [1, 2, 3, 4, 8, 9, 20, 21, 22, 23, 24, 25],
        [
          [1, 8],
          [2, 9],
          [1, 2],
          [1, 3],
          [1, 4],
          [2, 3],
          [3, 4],
          [4, 20],
          [20, 21],
          [4, 22],
          [22, 23],
          [3, 24],
          [24, 25],
        ],
        [
          [903, hv, [1, 2, 3, 4]],
          [910, cv, [20, 21]],
          [911, cv, [22, 23]],
          [912, cv, [24, 25]],
        ],
      ),
    ),
    board: board([
      mine(1, 3),
      mine(2, 3),
      mine(3, 1),
      mine(4, 1),
      enemy(8, 9),
      enemy(9, 9),
      mine(20, 1),
      neutral(21, 2),
      mine(22, 1),
      neutral(23, 2),
      mine(24, 1),
      neutral(25, 2),
    ]),
    me: ME,
    income,
    settings: STD,
    game: { players: [{ id: ME }, { id: FOE }], turn: 6 },
    options: { goal: 'balanced', enemyDeploy },
  });
}
const deployedOn = (p: TurnPlan, t: number) => p.deploys.filter((d) => d.territoryId === t).reduce((n, d) => n + d.armies, 0);
const text = (p: TurnPlan) => [...p.rationale, ...p.warnings].join('\n');

describe('#593: a held bonus hub is valued for the members its fall takes', () => {
  it('the Brazil case: a hold needing ~15 on an income of 17, protecting +4, is held when its member is the hub', () => {
    const p = plan();
    expect(p.conceded).not.toContain(15);
    expect(deployedOn(p, 15)).toBeGreaterThanOrEqual(15);
    expect(text(p)).toMatch(/Hold bonus B914 \(#914\) \(\+4\) whole: its 1 threatened border needs 15 in all/);
    expect(text(p)).toMatch(/so it holds \(protects \+6\.4\)/);
    expect(text(p)).toMatch(/T15 \(#15\) borders 4 of bonus B914 \(#914\)'s 4 other members: its fall takes the rest, so its value counts 60% of the bonus more \(\+2\.4\) \(#593\)/);
  });

  it('the same gate bordering one other member is no hub: conceded at the +4 price, as before', () => {
    const p = plan({ hub: false });
    expect(p.conceded).toContain(15);
    expect(text(p)).not.toMatch(/#593/);
    expect(text(p)).toMatch(/T15 \(#15\) cannot be held economically \(needs 15, protects \+4\): conceded/);
  });

  it('a hold above the income is still conceded, with the same orders as without the hub', () => {
    const p = plan({ foe: 32 });
    const q = plan({ foe: 32, hub: false });
    expect(p.conceded).toContain(15);
    expect(text(p)).toMatch(/T15 \(#15\) cannot be held economically \(needs 21, protects \+6\.4\): conceded/);
    expect(p.deploys).toEqual(q.deploys);
    expect(p.moves).toEqual(q.moves);
  });

  it('names a hub once, and never one in a bonus of fewer than 4 members', () => {
    // A 3-member bonus whose middle member borders both others is no hub (HUB_MIN_MEMBERS).
    const p = planTurn({
      graph: buildGraph(
        makeMap([1, 2, 3, 87], [[1, 87], [1, 2], [1, 3], [2, 3]], [[901, 4, [1, 2, 3]]]),
      ),
      board: board([mine(1, 3), mine(2, 1), mine(3, 1), enemy(87, 21)]),
      me: ME,
      income: 17,
      settings: STD,
      game: { players: [{ id: ME }, { id: FOE }], turn: 6 },
      options: { goal: 'balanced', enemyDeploy: 8 },
    });
    expect(text(p)).not.toMatch(/#593/);
    expect(text(p).match(/#593/g) ?? []).toHaveLength(0);
    expect(text(plan()).match(/borders 4 of bonus B914/g)).toHaveLength(1);
  });

  it('a unit the hub share makes pay is still floored, not conceded, when the captures leave too little to hold it whole', () => {
    // Game 12 turn 12's shape (owner, 2026-11-27: fix it first). B903 (+3) is T1–T4; T1, its hub, borders T2–T4, and
    // T1 and T2 face player 20's 9-army stacks on T8 and T9. Three +4 bonuses (T20/T21, T22/T23, T24/T25) each complete
    // with a 2-army neutral. Without the hub share B903 is contested and floored before the captures (#118); with it,
    // it pays — and must not then be conceded with nothing deployed when the completions take the income.
    const p = game12(3, 4, 14, 6);
    expect(p.conceded).not.toContain(1);
    expect(p.conceded).not.toContain(2);
    expect(deployedOn(p, 1)).toBeGreaterThanOrEqual(3);
    expect(deployedOn(p, 2)).toBeGreaterThanOrEqual(3);
    expect(text(p)).toMatch(/Floor for bonus B903 \(#903\) \(\+3\): deploy 3 to T1 \(#1\)/);
    expect(text(p)).not.toMatch(/concedes bonus B903/);
  });

  it('#602: a floored hub-only unit does not hold back completions it cannot be starved by', () => {
    // B903 (+3) is floored (it pays only with its hub share); two +2 completions used to wait behind it ("only after
    // holding B903") and were lost when it was floored anyway. Now they go ahead and B903 keeps its floor.
    const p = game12(3, 2, 12, 6);
    expect(p.expected.bonusesCompleted).toEqual([910, 911]);
    expect(p.expected.nextIncome).toBe(16);
    expect(p.conceded).toEqual([]);
    expect(text(p)).not.toMatch(/only after holding B903/);
    expect(text(p)).toMatch(/Floor for bonus B903 \(#903\) \(\+3\): deploy/);
  });

  it('#602: a unit that pays without its hub share still holds back a completion that would starve it', () => {
    // B903 pays without its hub share here (no hub-only floor), so rule 1h.3 still postpones a completion that would starve it.
    const p = game12(3, 4, 24, 4);
    expect(text(p)).toMatch(/only after holding B903/);
  });
});
