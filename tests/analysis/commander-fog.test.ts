// Part 5 of the mega-game spec: my commander, starting from one territory, against opponents the fog hides.
import { describe, expect, it } from 'vitest';
import type { BoardSpecialUnit, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import {
  defaultFoggedAttackers,
  foggedAttacks,
  foggedCommanderCheck,
  foggedStack,
  foggedTakes,
  likelyStackAt,
  type FogView,
} from '../../src/analysis/commander-fog.js';
import { simulateTurn } from '../../src/analysis/turn-sim.js';
import { planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
// Game 45736172's combat: 50/70 kill rates, straight rounding (luck left out: the checks are luck-free).
const MEGA: PlannerSettings = { offensiveKillRate: 50, defensiveKillRate: 70, oneArmyStandsGuard: false, multiAttack: false };

function makeMap(ids: number[], edges: [number, number][], bonuses: GameMap['bonuses'] = []): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses,
    distributionModes: [],
  };
}
const commander: BoardSpecialUnit = { kind: 'commander', id: `${ME}`.padStart(32, '0'), playerId: ME };
const fogged = (territoryId: number): TerritoryState => ({ territoryId, owner: { kind: 'unknown' }, armies: null });

// Turn 1 of a one-territory start under normal fog: my start T1 (250 and my commander) sees its neighbours —
// two neutral castles of 5 (T2, T3: single-territory bonuses of +5, as the mega game's) and a wasteland of 50
// (T4) — and nothing past them (T5, T6, T7).
//
//   T5 ─ T2 ─ T1 ─ T3 ─ T6
//              |
//             T4 ─ T7
const start = buildGraph(
  makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [1, 3], [1, 4], [2, 5], [3, 6], [4, 7]], [
    { id: 102, name: 'Castle 2', value: 5, territoryIds: [2], bonusIds: [] },
    { id: 103, name: 'Castle 3', value: 5, territoryIds: [3], bonusIds: [] },
  ]),
);
const startBoard = () =>
  board([{ ...mine(1, 250), specialUnits: [commander] }, neutral(2, 5), neutral(3, 5), neutral(4, 50), fogged(5), fogged(6), fogged(7)], true);
const view = (mineIds: number[], foggedIds: number[], armies: Record<number, number>): FogView => ({
  mine: (t) => mineIds.includes(t),
  fogged: (t) => foggedIds.includes(t),
  armies: (t) => armies[t] ?? null,
});

describe('foggedAttacks', () => {
  it('finds every fogged territory within two moves, less what taking the one in between costs', () => {
    const v = view([1], [5, 6, 7], { 2: 5, 3: 5, 4: 50 });
    expect(foggedAttacks(start, v, 1, { stack: 250, deploy: 15, defensiveKillRate: 70 })).toEqual([
      // 265 less round(5 × 0.7) = 4 for the neutral of 5; 35 for the wasteland of 50.
      { territory: 5, via: 2, armies: 261 },
      { territory: 6, via: 3, armies: 261 },
      { territory: 7, via: 4, armies: 230 },
    ]);
  });

  it('strikes this turn from a fogged neighbour, whole, and never through my own land or a territory gone', () => {
    const v = view([1, 3], [2, 5, 6, 7], { 4: 50 });
    expect(foggedAttacks(start, v, 1, { stack: 100, deploy: 10, defensiveKillRate: 70 }, (n) => n === 4)).toEqual([{ territory: 2, armies: 110 }]);
  });

  it('adds up the strongest attacks striking in turn', () => {
    const kills = (n: number) => Math.round(n / 2);
    expect(foggedTakes([100, 40, 100], 2, kills, (n) => n / 2)).toBe(100);
    expect(foggedTakes([100, 40, 100], 1, kills, (n) => n / 2)).toBe(50);
    expect(foggedTakes([], 2, kills, (n) => n / 2)).toBe(0);
  });
});

describe('likelyStackAt (#529)', () => {
  it("gives a start's armies only to a likely holder, else the territory's usual estimate", () => {
    const at = likelyStackAt({
      stack: 250,
      me: 10,
      starts: new Set([1]),
      shownPlayer: (t) => (t === 2 ? 30 : t === 9 ? 10 : undefined),
      lastSeen: new Map([
        [3, { armies: 40, owner: 20 }],
        [4, { armies: 12, owner: null }],
      ]),
      vacated: new Set([5]),
      vacatedArmies: 2,
      rememberedNeutrals: new Map([[6, 50]]),
      neutralArmies: 5,
    });
    // A possible start, an opponent shown, a player's stack last seen.
    expect([at(1), at(2), at(3)]).toEqual([250, 250, 250]);
    // A neutral last seen, vacated land, the picking board's wasteland, else the game's neutral size.
    expect([at(4), at(5), at(6), at(7)]).toEqual([12, 2, 50, 5]);
    expect(likelyStackAt({ stack: 250, me: 10, shownPlayer: () => undefined, vacatedArmies: 2 })(7)).toBe(0);
  });
});

describe('defaults', () => {
  it('is on only in a big free-for-all with commanders and fog', () => {
    expect(defaultFoggedAttackers({ commanders: true, fog: true, teams: false, players: 97 })).toBe(2);
    expect(defaultFoggedAttackers({ commanders: true, fog: true, teams: false, players: 7 })).toBe(0);
    expect(defaultFoggedAttackers({ commanders: false, fog: true, teams: false, players: 97 })).toBe(0);
    expect(defaultFoggedAttackers({ commanders: true, fog: true, teams: true, players: 97 })).toBe(0);
    expect(defaultFoggedAttackers({ commanders: true, fog: false, teams: false, players: 97 })).toBe(0);
  });

  it("takes a hidden player's stack as the game's start, else as my largest", () => {
    expect(foggedStack(250, 40)).toBe(250);
    expect(foggedStack(undefined, 40)).toBe(40);
    expect(foggedStack(0, 40)).toBe(40);
  });
});

describe('foggedCommanderCheck', () => {
  const v = view([1], [5, 6, 7], { 2: 5, 3: 5, 4: 50 });
  const rates = { offensiveKillRate: 50, defensiveKillRate: 70 };

  it('is undefined when off or with no fog in reach', () => {
    expect(foggedCommanderCheck(start, v, 1, 250, { count: 0, stack: 250, deploy: 15, ...rates })).toBeUndefined();
    expect(foggedCommanderCheck(start, view([1], [], { 2: 5, 3: 5, 4: 50 }), 1, 250, { count: 2, stack: 250, deploy: 15, ...rates })).toBeUndefined();
  });

  it('holds my commander against two hidden starts striking together only with most of its stack home', () => {
    const c = foggedCommanderCheck(start, v, 1, 10, { count: 2, stack: 250, deploy: 15, ...rates })!;
    expect(c).toMatchObject({ territory: 1, armies: 10, attackers: 2, safe: false });
    expect(c.from.map((a) => a.territory)).toEqual([5, 6]);
    // 261 kills 131 (50%, straight), then the second 261 must not kill the rest: 131 + 131 + 1 = 263 defenders, the commander's 7 among them.
    expect(c.needs).toBe(256);
    expect(foggedCommanderCheck(start, v, 1, 256, { count: 2, stack: 250, deploy: 15, ...rates })!.safe).toBe(true);
    expect(foggedCommanderCheck(start, v, 1, 255, { count: 2, stack: 250, deploy: 15, ...rates })!.safe).toBe(false);
    // One alone needs half as much.
    expect(foggedCommanderCheck(start, v, 1, 10, { count: 1, stack: 250, deploy: 15, ...rates })!.needs).toBe(125);
  });
});

describe('planTurn: foggedAttackers (part 5)', () => {
  type Fa = { count: number; stack: number; starts?: readonly number[] };
  const input = (foggedAttackers?: Fa, extra: Record<string, unknown> = {}) => ({
    graph: start,
    board: startBoard(),
    me: ME,
    income: 15,
    // The mega game's neutral size: a fogged territory no start and no sighting is read at that.
    settings: { ...MEGA, neutralArmies: 5 },
    turn: 1,
    options: { ...(foggedAttackers ? { foggedAttackers } : {}), ...extra },
  });
  /** What stands on my commander's territory once the plan's orders run, nobody answering. */
  const leftOnStart = (p: ReturnType<typeof planTurn>) =>
    simulateTurn({
      graph: start,
      board: startBoard(),
      deploys: p.deploys.map((d) => ({ player: ME, territoryId: d.territoryId, armies: d.armies })),
      orders: [{ player: ME, orders: p.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies })) }],
      moveOrder: [ME],
      settings: MEGA,
    }).territories.get(1)!.armies;

  it('is off by default and with a count of 0: the plan is unchanged', () => {
    const off = planTurn(input());
    expect(planTurn(input({ count: 0, stack: 250 }))).toEqual(off);
    expect(off.rationale.join('\n')).not.toMatch(/held against the fog/);
  });

  it('keeps enough on a one-territory start to survive two hidden starts striking together', () => {
    const off = planTurn(input());
    // T5 and T6 could be starts on turn 1: each may hide a start of 250.
    const on = planTurn(input({ count: 2, stack: 250, starts: [5, 6] }));
    // Without it the start's stack goes out to expand; with it, what stays holds against both.
    expect(leftOnStart(off)).toBeLessThan(256);
    expect(leftOnStart(on)).toBeGreaterThanOrEqual(256);
    expect(on.rationale.join('\n')).toMatch(/held against the fog too .*2 unknown opponents .*T5 \(#5\) \(250\), T6 \(#6\) \(250\).* plus a whole deploy of ~15/);
  });

  it('#529: reads a fogged territory that is no start and shows no sighting at its usual estimate, not a start', () => {
    // Nothing past the neutrals could be a start: each is read as the game's neutral of 5 (plus a deploy).
    const none = planTurn(input({ count: 2, stack: 250, starts: [] }));
    // The start's stack expands as it does with the test off.
    expect(leftOnStart(none)).toBe(leftOnStart(planTurn(input())));
    expect(none.rationale.join('\n')).toMatch(/held against the fog too .*T5 \(#5\) \(5\)/);
  });

  it('#529: a player stack last seen on a fogged territory is a likely holder on later turns', () => {
    const later = (lastSeen?: Map<number, { armies: number; owner: number | null }>) =>
      planTurn({ ...input({ count: 2, stack: 250 }, lastSeen ? { lastSeen } : {}), turn: 5 });
    const fogLine = (p: ReturnType<typeof planTurn>) => p.rationale.find((l) => l.includes('held against the fog too'))!;
    const threatOf = (p: ReturnType<typeof planTurn>) => Number(/, ~(\d+):/.exec(fogLine(p))![1]);
    // No start list after turn 1 and no sighting: the usual estimate everywhere (the game's neutral of 5).
    const plain = later();
    expect(fogLine(plain)).toMatch(/T5 \(#5\) \(5\), T6 \(#6\) \(5\)/);
    // A player's stack last seen on T5: it may strike with a start's 250; T6 keeps its usual estimate.
    const seen = later(new Map([[5, { armies: 40, owner: 99 }]]));
    expect(fogLine(seen)).toMatch(/T5 \(#5\) \(250\), T6 \(#6\) \(5\)/);
    expect(threatOf(seen)).toBeGreaterThan(threatOf(plain));
    // A neutral last seen there is its sighting, not a start.
    expect(fogLine(later(new Map([[5, { armies: 40, owner: null }]])))).toMatch(/T5 \(#5\) \(40\)/);
  });
});
