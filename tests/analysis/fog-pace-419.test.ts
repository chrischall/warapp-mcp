// #419 (owner decision of 2026-11-20): while an opponent's frontier is mostly hidden (#368's thin evidence), the top
// of its estimate range is the larger of the fog prior (my income) and the past winners' pace at this turn: the
// median past winner on this map (3+ games), else my income × the format's median winner ÷ mine. The #368 midpoint
// stays and uses it as its upper bound; the warning names the basis. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { trackOpponents } from '../../src/analysis/opponents.js';
import { enemyDeployEstimates, fogPaceIncome, planTurn, type FogPace, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine } from './helpers.js';

const ME = 10;
const A = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 10 };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)) })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: A }, armies });

// As #294's fixture: player A's T5 beside my T4 and the fogged +30 bonus; 1 of ~4 frontier territories in view.
const low = buildGraph(makeMap([1, 2, 4, 5, 20, 21, 22], [[1, 2], [2, 4], [4, 5], [5, 20], [5, 21], [5, 22], [20, 21], [21, 22]], [[900, 30, [20, 21, 22]]]));
const lowAt = (a5: number): BoardState => board([mine(1, 40), mine(2, 3), mine(4, 40), enemy(5, a5), fogged(20), fogged(21), fogged(22)]);
const tracks = trackOpponents(low, [10, 25, 40, 55].map((a5, i) => ({ turn: i + 1, board: lowAt(a5) })), ME, STD);
const est = (pace?: FogPace, myIncome = 20) =>
  enemyDeployEstimates(low, lowAt(55), ME, STD, lowAt(40), tracks, { myIncome, ...(pace ? { winnerPace: pace } : {}) }, { turn: 4 })[0]!;
const MAP_PACE: FogPace = { basis: 'map', afterTurn: 3, games: 3, income: 34 };

describe('#419: the past winners\' pace tops thin evidence\'s range', () => {
  it('without a pace: the #368 midpoint toward the prior (my income), as before', () => {
    // Tracked 15 at 25% coverage; prior 20, blended toward 15 → 20. Midpoint 18, half way from 20: 19.
    expect(est()).toMatchObject({ estimate: 19, thinEvidence: { lower: 15, upper: 20, midpoint: 18, toward: 20, figure: 19 } });
    expect(est()!.thinEvidence).not.toHaveProperty('pace');
  });

  it('the map\'s median winner above my income: the upper bound, the midpoint between it and the track', () => {
    const e = est(MAP_PACE);
    // Upper 34, midpoint 15 + ceil(19 / 2) = 25, half way from 20: 23.
    expect(e).toMatchObject({ estimate: 23, prior: 20, thinEvidence: { upper: 34, midpoint: 25, toward: 20, figure: 23, pace: { figure: 34, basis: 'map', games: 3 } } });
  });

  it('the format\'s relative pace scales my income', () => {
    const p: FogPace = { basis: 'format', afterTurn: 3, games: 4, ratio: 1.5 };
    expect(fogPaceIncome(p, 20)).toBe(30);
    expect(est(p)).toMatchObject({ estimate: 22, thinEvidence: { upper: 30, midpoint: 23, pace: { figure: 30, basis: 'format', ratio: 1.5 } } });
  });

  it('a pace at or below my income changes nothing; one above what it could earn is capped there', () => {
    expect(est({ ...MAP_PACE, income: 18 })).toEqual(est());
    expect(est({ ...MAP_PACE, income: 20 })).toEqual(est());
    expect(est({ ...MAP_PACE, income: 90 })).toMatchObject({ couldEarn: 40, thinEvidence: { upper: 40, midpoint: 28, figure: 24 } });
  });

  it('never the prior itself, nor an opponent read from enough of its frontier', () => {
    const e = est(MAP_PACE);
    expect(e.prior).toBe(20);
    expect(e.priorBlend).toMatchObject({ prior: 20, figure: 20 });
    const full = tracks.map((x) => ({ ...x, turns: x.turns.map((y) => ({ ...y, coverage: { inView: 4, frontier: 4, share: 1, hiddenBonuses: 0 } })) }));
    const a = enemyDeployEstimates(low, lowAt(55), ME, STD, lowAt(40), full, { myIncome: 20 }, { turn: 4 })[0]!;
    const b = enemyDeployEstimates(low, lowAt(55), ME, STD, lowAt(40), full, { myIncome: 20, winnerPace: MAP_PACE }, { turn: 4 })[0]!;
    expect(b).toEqual(a);
  });

  it('no fog prior (an uneven start), no pace', () => {
    const a = enemyDeployEstimates(low, lowAt(55), ME, STD, lowAt(40), tracks, undefined, { turn: 4 })[0]!;
    expect(a.thinEvidence).toMatchObject({ upper: 40 });
  });
});

describe('#419: the plan names the basis', () => {
  const plan = (mapPace?: FogPace) =>
    planTurn({
      graph: low,
      board: lowAt(55),
      previousBoard: lowAt(40),
      tracks,
      me: ME,
      income: 20,
      settings: STD,
      turn: 4,
      game: { players: [{ id: ME }, { id: A }], turn: 4, symmetricStart: true, ...(mapPace ? { mapPace } : {}) },
      options: { adapt: true },
    });

  it('the map\'s median winner', () => {
    expect(plan(MAP_PACE).warnings.join('\n')).toMatch(
      /upper bound ~34 \(the median past winner's income after turn 3 on this map, 3 games of this format and settings \(#419\)\): the midpoint ~25/,
    );
  });

  it('the format\'s pace', () => {
    expect(plan({ basis: 'format', afterTurn: 3, games: 4, ratio: 1.5 }).warnings.join('\n')).toMatch(
      /upper bound ~30 \(my income × 1\.5, the median past winner's pace against mine after turn 3 in this format, 4 games \(fewer than 3 on this map\) \(#419\)\)/,
    );
  });

  it('without one, the fog prior as before', () => {
    expect(plan().warnings.join('\n')).toMatch(/upper bound ~20 \(the fog prior, not shrunk toward the track\)/);
  });
});
