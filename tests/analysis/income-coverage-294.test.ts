// #294: a tracked income said nothing of how much of the opponent's frontier was in view when it was
// read. Synthetic maps only: every id and name here is made up.
//  (1) each observed turn carries its frontier coverage (`frontierCoverage`, pure): its territories
//      in view with a neighbour not its own, plus every territory beside them whose owner is hidden;
//  (2) the warning says "read from N of ~M frontier territories";
//  (3) #235's prior shrink is scaled by the coverage of the observed turns, not the newest board's edge;
//  (4) while coverage is low the estimate never falls below tracked × LOW_COVERAGE_FACTOR;
//  (5) one line splits each grown stack: a move from a neighbour in view, out of the fog, or only deploy.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { trackOpponents, type ObservedTurn, type OpponentTrack } from '../../src/analysis/opponents.js';
import {
  coverageText,
  enemyDeployEstimates,
  frontierCoverage,
  LOW_COVERAGE,
  LOW_COVERAGE_FACTOR,
  observeDeploy,
  planTurn,
  trackCoverage,
  type PlannerSettings,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 10 };

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

const enemy = (territoryId: number, armies: number, playerId = A): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

// My T1, T2, T4 in a line; player A's T5 beside my T4 and the fogged T20–T22, which make a +30 bonus.
// Only one of its territories is ever in view: 1 of ~4 frontier territories.
const low = buildGraph(
  makeMap(
    [1, 2, 4, 5, 20, 21, 22],
    [[1, 2], [2, 4], [4, 5], [5, 20], [5, 21], [5, 22], [20, 21], [21, 22]],
    [[900, 30, [20, 21, 22]]],
  ),
);
const lowAt = (a5: number): BoardState =>
  board([mine(1, 40), mine(2, 3), mine(4, 40), enemy(5, a5), fogged(20), fogged(21), fogged(22)]);
// Its stack on T5 grows +15 a turn beside the fog, within twice its visible income (10): deploy.
const lowBoards = [10, 25, 40, 55].map((a5, i) => ({ turn: i + 1, board: lowAt(a5) }));

describe('(1) frontier coverage, per observed turn', () => {
  it('counts its territories in view on both boards against its frontier and the fog beside it', () => {
    const c = frontierCoverage(low, lowAt(25), lowAt(10), A);
    expect(c).toEqual({ inView: 1, frontier: 4, share: 0.25, hiddenBonuses: 1 });
  });

  it('a territory not in view on the earlier board is frontier, not read', () => {
    const before = board([mine(1, 40), mine(2, 3), mine(4, 40), fogged(5), fogged(20), fogged(21), fogged(22)]);
    expect(frontierCoverage(low, lowAt(25), before, A)).toMatchObject({ inView: 0, frontier: 4, share: 0 });
  });

  it('its whole frontier in view reads 1; an interior territory is no frontier', () => {
    const clear = board([mine(1, 40), mine(2, 3), mine(4, 40), enemy(5, 9), enemy(20, 3), enemy(21, 3), enemy(22, 3)]);
    expect(frontierCoverage(low, clear, clear, A)).toEqual({ inView: 1, frontier: 1, share: 1, hiddenBonuses: 0 });
  });

  it('none of its territories in view: nothing read', () => {
    const none = board([mine(1, 40), mine(2, 3), mine(4, 40), fogged(5), fogged(20), fogged(21), fogged(22)]);
    expect(frontierCoverage(low, none, none, A)).toMatchObject({ inView: 0, frontier: 0, share: 0 });
  });

  it('the tracker keeps it on every observed turn, and sums its income window', () => {
    const [t] = trackOpponents(low, lowBoards, ME, STD);
    expect(t!.turns.map((x) => x.observed)).toEqual([15, 15, 15]);
    for (const x of t!.turns) expect(x.coverage).toEqual({ inView: 1, frontier: 4, share: 0.25, hiddenBonuses: 1 });
    expect(t!.coverage).toEqual({ turns: [1, 2, 3], inView: { min: 1, max: 1 }, frontier: { min: 4, max: 4 }, share: 0.25, hiddenBonuses: 1 });
  });

  it('trackCoverage: ΣinView ÷ Σfrontier over the turns that carry it; none carry it, null', () => {
    const turn = (from: number, inView: number, frontier: number) =>
      ({ from, coverage: { inView, frontier, share: frontier ? inView / frontier : 0, hiddenBonuses: 0 } }) as ObservedTurn;
    expect(trackCoverage([turn(1, 1, 4), turn(2, 3, 5)])).toEqual({
      turns: [1, 2],
      inView: { min: 1, max: 3 },
      frontier: { min: 4, max: 5 },
      share: 4 / 9,
      hiddenBonuses: 0,
    });
    expect(coverageText(trackCoverage([turn(1, 1, 4), turn(2, 3, 5)])!)).toBe('1–3 of ~4–5 frontier territories (44%)');
    expect(trackCoverage([{ from: 1 } as ObservedTurn])).toBeNull();
  });
});

describe('(4) while coverage is low, never below tracked × LOW_COVERAGE_FACTOR', () => {
  const tracks = trackOpponents(low, lowBoards, ME, STD);

  it('the constants are named', () => {
    expect(LOW_COVERAGE).toBe(0.5);
    expect(LOW_COVERAGE_FACTOR).toBe(1.5);
  });

  it('tracked 15 read from a quarter of its frontier: at least 23', () => {
    const [e] = enemyDeployEstimates(low, lowAt(55), ME, STD, lowAt(40), tracks, undefined, { turn: 4 });
    expect(e).toMatchObject({ tracked: 15, estimate: 23, source: 'tracked' });
    expect(e!.coverage).toMatchObject({ inView: { min: 1, max: 1 }, frontier: { min: 4, max: 4 }, share: 0.25 });
    expect(e!.coverageFloor).toEqual({ tracked: 15, share: 0.25, factor: 1.5, figure: 23 });
  });

  it('a tracked figure no higher than its visible base + bonuses says nothing the board does not: no floor', () => {
    // A still stack: nothing observed beyond its base 10.
    const still = trackOpponents(low, [10, 10, 10, 10].map((a5, i) => ({ turn: i + 1, board: lowAt(a5) })), ME, STD);
    const [e] = enemyDeployEstimates(low, lowAt(10), ME, STD, lowAt(10), still, undefined, { turn: 4 });
    expect(e).toMatchObject({ tracked: 10, estimate: 10, coverageFloor: null });
    expect(e!.coverage).toMatchObject({ share: 0.25 });
  });

  it('the tracker notes what its income was read from', () => {
    const [t] = tracks;
    expect(t!.notes.join('\n')).toMatch(
      /Income read from 1 of ~4 frontier territories \(25%\), 1 bonus it could hold out of view: the rest of where it can deploy was out of view, so the figure is a lower bound, and the planner keeps at least 1\.5 × it\./,
    );
  });

  it('never above what it could earn', () => {
    const small = buildGraph(makeMap([1, 2, 4, 5, 20, 21, 22], [[1, 2], [2, 4], [4, 5], [5, 20], [5, 21], [5, 22], [20, 21], [21, 22]], [[900, 2, [20, 21, 22]]]));
    const t = trackOpponents(small, lowBoards, ME, STD);
    const [e] = enemyDeployEstimates(small, lowAt(55), ME, STD, lowAt(40), t, undefined, { turn: 4 });
    // Base 10 + the +2 it could hold: 12, its tracked figure capped there too.
    expect(e).toMatchObject({ couldEarn: 12, estimate: 12 });
  });

  it('its frontier in view: the tracked figure stands', () => {
    const t = tracks.map((x) => ({
      ...x,
      turns: x.turns.map((y) => ({ ...y, coverage: { inView: 4, frontier: 4, share: 1, hiddenBonuses: 0 } })),
    }));
    const { coverage: _c, ...bare } = t[0]!;
    for (const track of [t[0]!, bare as OpponentTrack]) {
      const [e] = enemyDeployEstimates(low, lowAt(55), ME, STD, lowAt(40), [track], undefined, { turn: 4 });
      expect(e).toMatchObject({ tracked: 15, estimate: 15, coverageFloor: null });
    }
  });

  it('a track without coverage (built by hand) gets no floor', () => {
    const t = tracks.map((x) => {
      const { coverage: _c, ...rest } = x;
      return { ...rest, turns: x.turns.map(({ coverage: _d, ...y }) => y) };
    });
    const [e] = enemyDeployEstimates(low, lowAt(55), ME, STD, lowAt(40), t, undefined, { turn: 4 });
    expect(e).toMatchObject({ tracked: 15, estimate: 15, coverage: null, coverageFloor: null });
  });
});

describe('(3) the prior shrinks by the coverage of the observed turns', () => {
  const tracks = trackOpponents(low, lowBoards, ME, STD);

  it('evidence is the sum of the turns\' coverage, not turns × the newest edge share', () => {
    const [e] = enemyDeployEstimates(low, lowAt(55), ME, STD, lowAt(40), tracks, { myIncome: 40 }, { turn: 4 });
    // The prior: my income 40, capped at the 40 it could earn. Three turns at 25% coverage: 0.75.
    expect(e!.priorBlend).toMatchObject({ prior: 40, toward: 15, turns: 3, share: 0.25 });
    expect(e!.priorBlend!.weight).toBeCloseTo(4 / 4.75, 9);
    expect(e).toMatchObject({ estimate: 15 + Math.ceil((4 / 4.75) * 25), source: 'prior' });
  });

  it('more coverage, more shrink', () => {
    const fuller = tracks.map((x) => ({
      ...x,
      turns: x.turns.map((y) => ({ ...y, coverage: { inView: 3, frontier: 4, share: 0.75, hiddenBonuses: 1 } })),
    }));
    const [a] = enemyDeployEstimates(low, lowAt(55), ME, STD, lowAt(40), tracks, { myIncome: 40 }, { turn: 4 });
    const [b] = enemyDeployEstimates(low, lowAt(55), ME, STD, lowAt(40), fuller, { myIncome: 40 }, { turn: 4 });
    expect(b!.priorBlend!.share).toBe(0.75);
    expect(b!.estimate).toBeLessThan(a!.estimate);
  });
});

describe('(2) and (5) the plan says it', () => {
  const tracks = trackOpponents(low, lowBoards, ME, STD);
  const plan = () =>
    planTurn({
      graph: low,
      board: lowAt(55),
      previousBoard: lowAt(40),
      tracks,
      me: ME,
      income: 15,
      settings: STD,
      turn: 4,
      game: { players: [{ id: ME }, { id: A }], turn: 4, symmetricStart: false },
      options: { adapt: true },
    });

  it('the tracked figure names its coverage, and the floor its factor', () => {
    const w = plan().warnings.join('\n');
    expect(w).toMatch(
      /Enemy deploy estimate for player 20: ~23 \(tracked over 3 observed turns, read from 1 of ~4 frontier territories \(25%\), 1 bonus it could hold out of view; more than base 10/,
    );
    expect(w).toMatch(
      /Player 20's tracked ~15 was read from 1 of ~4 frontier territories \(25%, under 50%\): the estimate is at least ~15 × 1\.5 = 23 \(the factor is unmeasured\)/,
    );
  });

  it('no coverage words without fog', () => {
    const clear = (a5: number) => board([mine(1, 40), mine(2, 3), mine(4, 40), enemy(5, a5), neutral(20, 2), neutral(21, 2), neutral(22, 2)]);
    const t = trackOpponents(low, [10, 25, 40, 55].map((a, i) => ({ turn: i + 1, board: clear(a) })), ME, STD);
    expect(t[0]!.coverage).toMatchObject({ share: 1 });
    const [e] = enemyDeployEstimates(low, clear(55), ME, STD, clear(40), t, undefined, { turn: 4 });
    expect(e).toMatchObject({ coverageFloor: null });
  });

  // T5 grew +12: its T6 in view shrank 5 (a move it could be), the rest beside the fog. T7 grew +4
  // with no hidden neighbour; T6's shrink is claimed by T5 first, so T7's growth can only be deploy.
  const split = buildGraph(
    makeMap(
      [1, 2, 4, 5, 6, 7, 20, 21, 22],
      [[1, 2], [2, 4], [4, 5], [5, 20], [5, 21], [5, 22], [20, 21], [21, 22], [5, 6], [6, 7], [7, 1]],
      [],
    ),
  );
  const at = (a5: number, a6: number, a7: number) =>
    board([mine(1, 40), mine(2, 3), mine(4, 40), enemy(5, a5), enemy(6, a6), enemy(7, a7), fogged(20), fogged(21), fogged(22)]);

  it('observeDeploy splits each grown stack', () => {
    const o = observeDeploy(split, at(22, 5, 9), at(10, 10, 5), A, STD, { me: ME, expected: 10 });
    expect(o.stacks).toEqual([
      { territoryId: 5, growth: 12, moved: [{ from: 6, armies: 5 }], fog: 7, deploy: 0 },
      { territoryId: 7, growth: 4, moved: [], fog: 0, deploy: 4 },
    ]);
  });

  it('one rationale line per opponent, largest growth first', () => {
    const p = planTurn({
      graph: split,
      board: at(22, 5, 9),
      previousBoard: at(10, 10, 5),
      me: ME,
      income: 15,
      settings: STD,
      turn: 4,
      game: { players: [{ id: ME }, { id: A }], turn: 4, symmetricStart: false },
      options: { adapt: true },
    });
    expect(p.rationale.join('\n')).toMatch(
      /Player 20's growth by stack, turn 3 → turn 4: T5 \(#5\) \+12 \(5 could be a move from T6 \(#6\) in view, 7 could have come out of the fog\); T7 \(#7\) \+4 \(4 can only be deploy\)\./,
    );
  });
});
