// Issue #382: the siege goal. Against one opponent, fund its cheapest bonus breaks every turn, build one
// strike stack facing it, and hold the main assault until it is weakened (its income at 0.6× its tracked
// baseline, mine at 1.8× its, or a stack of mine able to take a member of its held bonus against its
// whole deploy). Every map, id and name here is made up.
// Kill rates 60/70, no luck, guard on.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { OpponentTrack } from '../../src/analysis/opponents.js';
import { planTurn, type PlanInput, type PlannerSettings, type TurnPlan } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic siege',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: ENEMY }, armies });
const attacks = (p: TurnPlan) => p.moves.filter((m) => m.kind === 'attack');

// My T1 (20) faces the opponent's T11 (2, in +5 B1 with T12), T15 (6, in +2 B3 with T16) and T17 (1, in no
// bonus). My T2 (4) faces T13 (1, in +3 B2 with T14). The opponent holds every bonus in view: income
// 5 + 5 + 3 + 2 = 15. My T3 (interior) keeps a neutral T4 beside it.
const MAP = makeMap(
  [1, 2, 3, 4, 11, 12, 13, 14, 15, 16, 17],
  [
    [1, 2],
    [1, 3],
    [3, 4],
    [1, 11],
    [11, 12],
    [1, 15],
    [15, 16],
    [1, 17],
    [17, 12],
    [2, 13],
    [13, 14],
  ],
  [
    [1, 5, [11, 12]],
    [2, 3, [13, 14]],
    [3, 2, [15, 16]],
    [9, 4, [1, 2, 3, 4]],
  ],
);
const BOARD = board([
  mine(1, 20),
  mine(2, 4),
  mine(3, 1),
  neutral(4, 2),
  enemy(11, 2),
  enemy(12, 2),
  enemy(13, 1),
  enemy(14, 2),
  enemy(15, 6),
  enemy(16, 2),
  enemy(17, 1),
]);

const input = (o: { income?: number; tracks?: OpponentTrack[]; goal?: 'siege' | 'balanced'; siegeTarget?: number } = {}): PlanInput => ({
  graph: buildGraph(MAP),
  board: BOARD,
  me: ME,
  income: o.income ?? 10,
  settings: STD,
  game: { players: [{ id: ME, state: 'Playing' }, { id: ENEMY, state: 'Playing' }] } as PlanInput['game'],
  ...(o.tracks ? { tracks: o.tracks } : {}),
  options: { goal: o.goal ?? 'siege', ...(o.siegeTarget !== undefined ? { siegeTarget: o.siegeTarget } : {}) },
});

/** A track over two observed turns: `then` on the first, `now` on the second (its income `now`). */
function track(then: number, now: number): OpponentTrack {
  const turn = { from: 0, to: 1, observed: now, raw: now, cap: now, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome: 15, earned: now, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: now, high: now, reinforced: [], grewFromFog: [], emptied: [], combat: 0 };
  return {
    playerId: ENEMY,
    firstSeen: 1,
    lastTurn: 3,
    turns: [
      { ...turn, from: 1, to: 2, observed: then, raw: then, cap: then, earned: then, low: then, high: then },
      { ...turn, from: 2, to: 3 },
    ],
    base: 5,
    bonusIncome: 10,
    visibleIncome: 15,
    income: now,
    incomeTurns: [1, 2],
    observedRange: { min: Math.min(then, now), max: Math.max(then, now) },
    incomeMethod: 'max-observed',
    incomeLowered: 0,
    unexplained: 0,
    visible: 7,
    turnsUnseen: 0,
    turnsUnseenAtLeast: false,
    earnedAtLeast: null,
    warnings: [],
    inferred: null,
    notes: [],
  } as OpponentTrack;
}

describe('#382 siege goal', () => {
  it('turn 1: funds the cheapest breaks, attacks nothing of the target but its bonus members, and holds the assault', () => {
    const p = planTurn(input());
    expect(p.goal).toBe('siege');
    expect(p.siege).toMatchObject({ target: ENEMY, opponentIncome: 15, baseline: 15, ready: false, trigger: null });
    // Cheapest per income lost first: B1 (+5 for 3 armies: 0.6 a point), then B2 (+3 for 2: 0.67), then B3 (+2 for 10: 5).
    expect(p.siege!.breaks.map((b) => [b.bonusId, b.cost])).toEqual([
      [1, 3],
      [2, 2],
      [3, 10],
    ]);
    const hit = attacks(p).map((m) => m.to);
    // Only members of its breakable bonuses are attacked: never T17, which breaks nothing.
    expect(hit.length).toBeGreaterThan(0);
    expect(hit.every((t) => [11, 12, 13, 14, 15, 16].includes(t))).toBe(true);
    expect(hit).not.toContain(17);
    expect(p.siege!.brokenThisTurn.length).toBeGreaterThan(0);
    // The cheapest break (B1) is funded; B2's member stays: T2 spends its deploy on its own hold (holds as usual).
    expect(p.siege!.brokenThisTurn.map((b) => b.bonusId)).toContain(1);
    expect(p.deploys).toContainEqual({ territoryId: 2, armies: 6 });
    expect(p.rationale[0]).toMatch(/^Siege on player 20 \(#382\)/);
    expect(p.rationale.join('\n')).toMatch(/Assault held/);
  });

  it('balanced on the same board carries no siege', () => {
    const p = planTurn(input({ goal: 'balanced' }));
    expect(p.goal).toBe('balanced');
    expect(p.siege).toBeUndefined();
  });

  it('releases the assault when my income reaches 1.8× the target’s', () => {
    const p = planTurn(input({ income: 30 }));
    expect(p.siege).toMatchObject({ ready: true, trigger: 'income-lead', ratio: 2 });
    expect(p.rationale.join('\n')).toMatch(/Assault released: my income is 2× player 20's/);
    // The strike stack strikes: the target's other territory beside it is no longer held back.
    expect(attacks(p).map((m) => m.to)).toContain(17);
  });

  it('releases the assault when the target’s income falls to 0.6× its tracked baseline', () => {
    const p = planTurn(input({ tracks: [track(30, 15)] }));
    expect(p.siege).toMatchObject({ opponentIncome: 15, baseline: 30, baselineTurns: 2, fallenTo: 0.5, ready: true, trigger: 'income-fell' });
    const held = planTurn(input({ tracks: [track(20, 15)] }));
    expect(held.siege).toMatchObject({ baseline: 20, fallenTo: 0.75, ready: false });
  });

  it('releases the assault when a stack can take a held bonus member against the whole deploy', () => {
    const big = board(BOARD.territories.map((t) => (t.territoryId === 1 ? mine(1, 60) : t)));
    const p = planTurn({ ...input(), board: big });
    expect(p.siege).toMatchObject({ ready: true, trigger: 'core-strike' });
  });

  it('a siege_target that is not an opponent is a warning and a balanced plan', () => {
    const p = planTurn(input({ siegeTarget: 99 }));
    expect(p.goal).toBe('siege');
    expect(p.siege).toBeUndefined();
    expect(p.warnings.join('\n')).toMatch(/siege_target 99/);
  });
});
