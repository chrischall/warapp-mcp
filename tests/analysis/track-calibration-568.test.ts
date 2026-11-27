// #568 (DRAFT): past games' tracker estimate ÷ truth per frontier coverage band (#436's calibration) raises a
// tracked figure by its band's factor to the TRACK_CALIBRATION_DAMPING power, never above what the opponent could
// earn and never lowered. Synthetic maps only: every id and name here is made up.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { trackOpponents } from '../../src/analysis/opponents.js';
import { enemyDeployEstimates, planTurn, TRACK_CALIBRATION_DAMPING, trackCalibrationFactor, type PlannerSettings } from '../../src/analysis/planner.js';
import type { OutlookCalibration } from '../../src/analysis/outlook.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine } from './helpers.js';

const ME = 10;
const A = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 10 };

const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: [1, 2, 4, 5, 20, 21, 22].map((id) => {
    const edges: [number, number][] = [[1, 2], [2, 4], [4, 5], [5, 20], [5, 21], [5, 22], [20, 21], [21, 22]];
    return { id, name: `T${id}`, connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)) };
  }),
  bonuses: [{ id: 900, name: 'B900', value: 30, territoryIds: [20, 21, 22], bonusIds: [] }],
  distributionModes: [],
};
const g = buildGraph(map);
const enemy = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: A }, armies });
const at = (a5: number): BoardState => board([mine(1, 40), mine(2, 3), mine(4, 40), enemy(5, a5), fogged(20), fogged(21), fogged(22)]);
// Its stack on T5 grows +15 a turn beside the fog: tracked 15, read from a quarter of its frontier (#294).
const tracks = trackOpponents(g, [10, 25, 40, 55].map((a5, i) => ({ turn: i + 1, board: at(a5) })), ME, STD);
// A share of exactly 25% is the 25–50% band (`coverageBucket`).
const band = (geoMean: number, n = 20, key: '25-50' | 'under-25' = '25-50'): OutlookCalibration => ({ [key]: { geoMean, n } });

describe('trackCalibrationFactor', () => {
  it('the damping is the square root', () => {
    expect(TRACK_CALIBRATION_DAMPING).toBe(0.5);
  });

  it('the band of the share, its geometric mean to the damping power', () => {
    expect(trackCalibrationFactor(band(0.25, 20, 'under-25'), 0.2)).toEqual({ band: 'under-25', geoMean: 0.25, n: 20, factor: 0.5 });
    expect(trackCalibrationFactor({ none: { geoMean: 0.36, n: 9 } }, null)).toMatchObject({ band: 'none', factor: 0.6 });
  });

  it('none: no calibration, another band, too few samples, or a band that read at least the truth', () => {
    expect(trackCalibrationFactor(undefined, 0.2)).toBeUndefined();
    expect(trackCalibrationFactor(band(0.25), 0.2)).toBeUndefined();
    expect(trackCalibrationFactor(band(0.25, 4), 0.3)).toBeUndefined();
    expect(trackCalibrationFactor(band(1.1), 0.3)).toBeUndefined();
    expect(trackCalibrationFactor(band(0), 0.3)).toBeUndefined();
  });
});

describe('the tracked figure, calibrated', () => {
  it('without a calibration the estimate is as before', () => {
    const [e] = enemyDeployEstimates(g, at(55), ME, STD, at(40), tracks, undefined, { turn: 4 });
    expect(e).toMatchObject({ tracked: 15, estimate: 22 });
    expect(e!.trackCalibration).toBeUndefined();
  });

  it('a band that read 0.25× raises tracked 15 to 30 (÷ 0.5), and thin evidence works from that', () => {
    const [e] = enemyDeployEstimates(g, at(55), ME, STD, at(40), tracks, undefined, { turn: 4, calibration: band(0.25) });
    expect(e!.trackCalibration).toEqual({ raw: 15, band: '25-50', geoMean: 0.25, n: 20, factor: 0.5, figure: 30 });
    // Lower 30, upper 40 (the most it could earn), midpoint 35; weight 0.5 from 30: 30 + ceil(2.5) = 33.
    expect(e).toMatchObject({ tracked: 30, estimate: 33 });
    expect(e!.thinEvidence).toMatchObject({ lower: 30, upper: 40, midpoint: 35, toward: 30, figure: 33 });
  });

  it('never above what it could earn', () => {
    const [e] = enemyDeployEstimates(g, at(55), ME, STD, at(40), tracks, undefined, { turn: 4, calibration: band(0.01) });
    expect(e!.trackCalibration).toMatchObject({ raw: 15, figure: 40 });
    expect(e).toMatchObject({ tracked: 40, estimate: 40 });
  });

  it('the plan names it, and its rationale keeps the tracker\'s own figure', () => {
    const plan = planTurn({
      graph: g,
      board: at(55),
      previousBoard: at(40),
      tracks,
      me: ME,
      income: 15,
      settings: STD,
      turn: 4,
      game: { players: [{ id: ME }, { id: A }], turn: 4, symmetricStart: false, trackCalibration: band(0.25) },
      options: { adapt: true },
    });
    expect(plan.warnings.join('\n')).toMatch(
      /Player 20's tracked income ~15 is raised to ~30 \(#568, draft\): past games' tracker read 0\.25× the true income at this frontier coverage \(25-50, 20 samples\), divided by its square root \(0\.50\)\./,
    );
    expect(plan.rationale.join('\n')).toMatch(/Tracked income for player 20: ~15\/turn/);
  });
});
