// Issue #418: the tracker ratcheted on fog arrivals. Each turn's ambiguous growth beside the fog is
// read as deploy up to twice the income carried so far (#123), so walk-ins compounded the carry
// (10, 20, 40, …) while nothing read in full backed it. Every board here is synthetic.
//  1. A rise no turn read in full confirmed is held to RISE_CAP × the carry before it, each turn, while
//     I lead it on the board (my income above the carry before the rise, LEAD_ARMIES × its armies in view).
//  2. A rise a turn read in full confirmed is kept whole.
//  3. No trend step on thin evidence when I lead it on income and on armies in view (with LEAD_ARMIES ×
//     its armies in view, on income above what it earned before the newest rise, however high it reads).
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { incomeBasis, LEAD_ARMIES, RISE_CAP, trackOpponents, type ObservedTurn, type OpponentTrack, type TurnBoard } from '../../src/analysis/opponents.js';
import { enemyDeployEstimates, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const ENEMY = 20;
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
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: ENEMY }, armies });
const line = (n: number) => Array.from({ length: n - 1 }, (_, i) => [i + 1, i + 2] as [number, number]);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const history = (boards: BoardState[]): TurnBoard[] => boards.map((board, i) => ({ turn: 8 + i, board }));

// My +5 bonus {1, 2, 3}; the enemy's T4 and T5 in view; T6–T9 fogged (+20 and +25 it could hold).
const g = buildGraph(
  makeMap(range(1, 9), line(9), [
    [101, 5, [1, 2, 3]],
    [102, 20, [6, 7]],
    [103, 25, [8, 9]],
  ]),
);
const fog = range(6, 9).map(fogged);

describe('1. an unconfirmed rise is held to RISE_CAP × the carry a turn while I lead (#418)', () => {
  // The same line with my bonus at +30 (income 35). +45 walks onto T5 (beside the fog) every turn:
  // read as deploy up to twice the carry each time. My 600 on T3 are over three times its armies.
  const gl = buildGraph(
    makeMap(range(1, 9), line(9), [
      [101, 30, [1, 2, 3]],
      [102, 20, [6, 7]],
      [103, 25, [8, 9]],
    ]),
  );
  const at = (t5: number, t3 = 600) => board([mine(1, 1), mine(2, 1), mine(3, t3), enemy(4, 1), enemy(5, t5), ...fog]);

  it('walk-ins no longer compound the carry: 10, then 13, then 17', () => {
    const [t] = trackOpponents(gl, history([at(5), at(50), at(95), at(140)]), ME, STD);
    expect([RISE_CAP, LEAD_ARMIES]).toEqual([1.3, 3]);
    expect(t!.turns.map((x) => x.leadIncome)).toEqual([35, 35, 35]);
    // The bound now follows the held carry: 10, then up to twice 10, then up to twice 13.
    expect(t!.turns.map((x) => x.observed)).toEqual([10, 20, 26]);
    expect(t!.income).toBe(17);
    expect(t!.incomeMethod).toBe('rise-capped');
    expect(t!.incomeRise).toEqual({ read: 26, before: 13 });
    expect(incomeBasis(t!)).toBe(`max observed over turns 8–10, observed 10–26, held to ${RISE_CAP}× the ~13 before it: no turn read in full reached 26`);
  });

  it('a turn read in full that observed less ends the rise: it never climbs while the walk-ins sit in the window', () => {
    const [t] = trackOpponents(gl, history([at(5), at(50), at(95), at(140), at(145), at(150), at(155)]), ME, STD);
    expect(t!.turns.map((x) => x.observed)).toEqual([10, 20, 26, 5, 5, 5]);
    expect(t!.income).toBe(5);
  });

  it('not leading on armies in view: the rise is read as before (10, 20, 40)', () => {
    const [t] = trackOpponents(gl, history([at(5, 28), at(50, 28), at(95, 28), at(140, 28)]), ME, STD);
    expect(t!.turns.map((x) => x.observed)).toEqual([10, 20, 40]);
    expect(t!.income).toBe(40);
    expect(t!.incomeMethod).toBe('max-observed');
  });

  it('a reading above my income while I lead three to one on armies is still held: my income is above the carry before it', () => {
    // My bonus +10: income 15, above the carry of 10 but below the walk-in read up to twice it (20).
    const g15 = buildGraph(
      makeMap(range(1, 9), line(9), [
        [101, 10, [1, 2, 3]],
        [102, 20, [6, 7]],
        [103, 25, [8, 9]],
      ]),
    );
    const [t] = trackOpponents(g15, history([at(5), at(50), at(95)]), ME, STD);
    expect(t!.turns.map((x) => x.leadIncome)).toEqual([15, 15]);
    expect(t!.turns.map((x) => x.observed)).toEqual([10, 20]);
    expect(t!.income).toBe(13);
    expect(t!.incomeMethod).toBe('rise-capped');
    expect(t!.incomeRise).toEqual({ read: 20, before: 10 });
  });

  it('my income not above the carry before the rise: the rise is read as before, however many armies I have', () => {
    // The first map: my bonus +5, income 10, not above the carry of 10 the first walk-in rose from.
    const [t] = trackOpponents(g, history([at(5), at(50), at(95), at(140)]), ME, STD);
    expect(t!.turns.map((x) => x.observed)).toEqual([10, 20, 40]);
    expect(t!.income).toBe(40);
  });
});

describe('2. a rise a turn read in full confirmed is kept whole (#418)', () => {
  // T4 sits between my T3 and its own T5: its growth is no fog arrival, every army of it is deploy.
  const at = (t4: number) => board([mine(1, 1), mine(2, 1), mine(3, 28), enemy(4, t4), enemy(5, 1), ...fog]);

  it('10, 10, then 30 read in full: income 30', () => {
    const [t] = trackOpponents(g, history([at(5), at(15), at(25), at(55)]), ME, STD);
    expect(t!.turns.map((x) => [x.observed, x.fogArmies])).toEqual([
      [10, 0],
      [10, 0],
      [30, 0],
    ]);
    expect(t!.income).toBe(30);
    expect(t!.incomeMethod).toBe('max-observed');
  });
});

describe('3. no trend step when I lead on income and armies in view (#418)', () => {
  // My T1–T4 (+100 on T1–T2); its T5 beside my T4 and the fogged T20; T20–T27 two fogged +400 bonuses.
  const ids = [1, 2, 3, 4, 5, 6, 20, 21, 22, 23, 24, 25, 26, 27];
  const edges: [number, number][] = [[1, 2], [2, 3], [3, 4], [4, 5], [5, 20], [1, 6], ...Array.from({ length: 7 }, (_, i): [number, number] => [20 + i, 21 + i])];
  const g2 = buildGraph(makeMap(ids, edges, [[901, 100, [1, 2]], [902, 400, [20, 21, 22, 23]], [903, 400, [24, 25, 26, 27]]]));
  const fog2 = [20, 21, 22, 23, 24, 25, 26, 27].map((t) => fogged(t));
  const S: PlannerSettings = { ...STD, baseIncome: 10 };
  const track = (readings: number[]): OpponentTrack => {
    const turns: ObservedTurn[] = readings.map((r, i) => ({
      from: 8 + i,
      to: 9 + i,
      observed: r,
      raw: r,
      cap: 2000,
      counted: [],
      captured: [],
      fromFog: [],
      reveals: [],
      visibleIncome: 10,
      earned: Math.max(10, r),
      net: 0,
      losses: 0,
      fogArmies: 0,
      measured: 0,
      broken: [],
      brokenValue: 0,
      low: r,
      high: r,
      reinforced: [],
      grewFromFog: [],
      emptied: [],
      combat: 0,
      coverage: { inView: 8, frontier: 10, share: 0.8, hiddenBonuses: 0 },
    }));
    return {
      playerId: ENEMY,
      firstSeen: 1,
      lastTurn: 12,
      turns,
      base: 10,
      bonusIncome: 0,
      visibleIncome: 10,
      income: readings.at(-1)!,
      incomeTurns: turns.slice(-3).map((x) => x.from),
      observedRange: { min: Math.min(...readings), max: Math.max(...readings) },
      incomeMethod: 'max-observed',
      incomeLowered: 0,
      unexplained: 0,
      inferred: null,
      visible: 1,
      turnsUnseen: 0,
      turnsUnseenAtLeast: false,
      earnedAtLeast: null,
      warnings: [],
      notes: [],
    };
  };
  const at = (theirs: number, readings = [10, 20, 40, 60]) => {
    const b = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, theirs), neutral(6, 2), ...fog2]);
    return enemyDeployEstimates(g2, b, ME, S, undefined, [track(readings)]).find((e) => e.playerId === ENEMY)!;
  };

  it('my income 110 and 86 armies in view against its tracked 60 and 30 armies: the tracked figure, no step to 80', () => {
    const e = at(30);
    expect(e.thinEvidence).toBeNull();
    expect(e.estimate).toBe(60);
  });

  it('its tracked 160 above my income 110, but 80 before the newest rise, and 86 armies against 20: the lead holds, no step to 220', () => {
    const e = at(20, [10, 40, 80, 160]);
    expect(LEAD_ARMIES * 20).toBeLessThanOrEqual(86);
    expect(e.thinEvidence).toBeNull();
    expect(e.estimate).toBe(160);
  });

  it('the same reads under three to one on armies (86 against 30): the trend still steps above the tracked 160', () => {
    const e = at(30, [10, 40, 80, 160]);
    expect(e.thinEvidence).toMatchObject({ rising: [40, 80, 160], trend: 220 });
  });

  it('more armies in view than mine: the trend still raises the lower bound', () => {
    const e = at(100);
    expect(e.thinEvidence).toMatchObject({ rising: [20, 40, 60], trend: 80, figure: 80 });
    expect(e.estimate).toBe(80);
  });
});
