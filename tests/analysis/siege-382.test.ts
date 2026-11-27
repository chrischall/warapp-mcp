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
import { rememberSiegeTurn, type SiegeMemory } from '../../src/analysis/plan/siege.js';
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

const input = (
  o: { income?: number; tracks?: OpponentTrack[]; goal?: 'siege' | 'balanced'; siegeTarget?: number; turn?: number; memory?: SiegeMemory } = {},
): PlanInput => ({
  graph: buildGraph(MAP),
  board: BOARD,
  me: ME,
  income: o.income ?? 10,
  settings: STD,
  game: { players: [{ id: ME, state: 'Playing' }, { id: ENEMY, state: 'Playing' }] } as PlanInput['game'],
  ...(o.tracks ? { tracks: o.tracks } : {}),
  ...(o.turn !== undefined ? { turn: o.turn } : {}),
  ...(o.memory ? { siegeMemory: o.memory } : {}),
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

  it('#361: jabs a break member it cannot take this turn with one army from the strike stack\'s spare', () => {
    const b = board(BOARD.territories.map((t) => (t.territoryId === 2 ? mine(2, 35) : t.territoryId === 13 ? enemy(13, 30) : t)));
    const p = planTurn({ ...input(), board: b });
    // T13 (30) needs 50, more than the strike stack T2 can send: one army from what T2 has beyond its
    // hold wears it down by one for the break (#361), and nothing else of the target is jabbed.
    expect(p.jabs).toEqual([{ from: 2, to: 13, player: ENEMY, defenders: 30, kills: 1, loses: 1, why: 'siege-break' }]);
    expect(attacks(p).filter((m) => m.to === 13)).toEqual([expect.objectContaining({ from: 2, armies: 1, winChance: 0 })]);
    expect(attacks(p).map((m) => m.to)).not.toContain(17);
    // `jabs: false` turns them off under a siege too.
    expect(planTurn({ ...input(), board: b, options: { goal: 'siege', jabs: false } }).jabs).toBeUndefined();
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

  describe('memory across turns', () => {
    const turn = (t: number, opponentIncome: number, breaks: number[] = []) => ({ turn: t, opponentIncome, myIncome: 10, breaks });

    it('with no turn known keeps no memory', () => {
      expect(planTurn(input()).siege!.memory).toBeUndefined();
    });

    it('the first turn of a siege starts its memory', () => {
      const p = planTurn(input({ turn: 4 }));
      expect(p.siege!.memory).toEqual({
        startedTurn: 4,
        turns: 1,
        startIncome: 15,
        opponentIncomeTrend: [{ turn: 4, income: 15 }],
        broken: p.siege!.brokenThisTurn.map((b) => ({ bonusId: b.bonusId, turns: [4] })),
        rebroken: [],
      });
    });

    it('the income when the siege began is its baseline: the assault is released once the target falls to 0.6× it', () => {
      const memory: SiegeMemory = { target: ENEMY, turns: [turn(2, 30, [1]), turn(3, 22, [2])] };
      const p = planTurn(input({ turn: 4, memory }));
      expect(p.siege).toMatchObject({ opponentIncome: 15, baseline: 30, fallenTo: 0.5, ready: true, trigger: 'income-fell' });
      expect(p.siege!.memory).toMatchObject({
        startedTurn: 2,
        turns: 3,
        startIncome: 30,
        opponentIncomeTrend: [
          { turn: 2, income: 30 },
          { turn: 3, income: 22 },
          { turn: 4, income: 15 },
        ],
      });
      // B1 broken on turn 2 and again now (it was retaken in between): re-broken.
      expect(p.siege!.brokenThisTurn.map((b) => b.bonusId)).toContain(1);
      expect(p.siege!.memory!.broken).toContainEqual({ bonusId: 1, turns: [2, 4] });
      expect(p.siege!.memory!.rebroken).toContain(1);
      expect(p.rationale[0]).toMatch(/^Siege on player 20 \(#382\)/);
      expect(p.rationale[0]).toMatch(/siege turn 3 \(since turn 2\): its income 30 → 22 → 15\./);
    });

    it('ignores the memory of another target, a stale siege, or turns not before this one', () => {
      for (const memory of [
        { target: 99, turns: [turn(3, 30)] },
        { target: ENEMY, turns: [turn(1, 30)] }, // more than SIEGE_MEMORY_GAP turns ago
        { target: ENEMY, turns: [turn(5, 30)] }, // this turn, planned again
      ] satisfies SiegeMemory[]) {
        const p = planTurn(input({ turn: 5, memory }));
        expect(p.siege).toMatchObject({ baseline: 15, ready: false });
        expect(p.siege!.memory).toMatchObject({ startedTurn: 5, turns: 1 });
      }
    });

    it('rememberSiegeTurn appends this turn, replaces a re-planned one and restarts on a new target or a gap', () => {
      const report = planTurn(input({ turn: 4 })).siege!;
      const broke = report.brokenThisTurn.map((b) => b.bonusId);
      expect(rememberSiegeTurn(undefined, 4, report)).toEqual({ target: ENEMY, turns: [{ turn: 4, opponentIncome: 15, myIncome: 10, breaks: broke }] });
      const kept: SiegeMemory = { target: ENEMY, turns: [turn(2, 30), turn(3, 22), turn(4, 99)] };
      expect(rememberSiegeTurn(kept, 4, report).turns.map((t) => [t.turn, t.opponentIncome])).toEqual([
        [2, 30],
        [3, 22],
        [4, 15],
      ]);
      expect(rememberSiegeTurn({ target: 99, turns: [turn(3, 30)] }, 4, report).turns).toHaveLength(1);
      expect(rememberSiegeTurn({ target: ENEMY, turns: [turn(0, 30)] }, 4, report).turns).toHaveLength(1);
    });
  });
});

// #603: the profile no longer picks the siege by itself (the self-play arena measured no gain); an explicit goal does.
describe('#382 siege: only on an explicit goal', () => {
  it('adapting with no goal on the same board carries no siege', () => {
    const base = input();
    const { goal: _goal, ...options } = base.options!;
    const p = planTurn({ ...base, options: { ...options, adapt: true } });
    expect(p.siege).toBeUndefined();
    expect(p.goal).not.toBe('siege');
  });
});
