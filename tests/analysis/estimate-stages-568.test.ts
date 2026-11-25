// #568: the decision log keeps each stage of an opponent's deploy estimate, warapp_calibration scores each stage
// against the truth, and a what-if says what correcting the tracked figure by its coverage band would have read.
// Synthetic logs only.
import { describe, expect, it } from 'vitest';
import { estimateStages, loggedEstimates, type EstimateStages } from '../../src/decision-log.js';
import {
  incomeCalibration,
  incomeSamples,
  stageErrors,
  trackedWhatIf,
  WHAT_IF_DAMPINGS,
  type CalibrationGame,
} from '../../src/analysis/income-calibration.js';
import type { EnemyDeployEstimate } from '../../src/analysis/planner.js';

const base = {
  playerId: 7,
  estimate: 30,
  held: 4,
  base: 5,
  bonusIncome: 3,
  observed: 12,
  tracked: 15,
  prior: 40,
  priorBlend: null,
  thinEvidence: null,
  card: null,
  coverage: { share: 0.3 },
  source: 'tracked',
} as unknown as EnemyDeployEstimate;

describe('estimateStages', () => {
  it('reads each stage off the estimate; a stage that did not apply is null', () => {
    expect(estimateStages(base)).toEqual({ visible: 8, observed: 12, tracked: 15, prior: 40, stated: null, blend: null, thin: null, known: null, card: 0 });
  });

  it('the prior before and after #444, the blend, thin evidence, a known income and a card', () => {
    const e = {
      ...base,
      prior: 20,
      stated: { full: 40, scaled: 20, lower: 15, midpoint: null },
      priorBlend: { figure: 33 },
      thinEvidence: { figure: 28 },
      known: { income: 50, was: 28 },
      card: { armies: 6, due: 3 },
    } as unknown as EnemyDeployEstimate;
    expect(estimateStages(e)).toEqual({ visible: 8, observed: 12, tracked: 15, prior: 40, stated: 20, blend: 33, thin: 28, known: 50, card: 6 });
  });

  it('the logged estimate carries them', () => {
    expect(loggedEstimates([base])[0]).toMatchObject({ player: 7, estimate: 30, stages: { tracked: 15, prior: 40 } });
  });
});

/** One game whose every turn logs opponent 7 with these stages, against a true income. */
function game(rows: { turn: number; stages: Partial<EstimateStages>; truth: number; coverage?: number | null }[]): CalibrationGame {
  const turns: Record<string, CalibrationGame['turns'][string]> = {};
  for (const r of rows) {
    const stages: EstimateStages = { visible: 5, observed: null, tracked: null, prior: null, stated: null, blend: null, thin: null, known: null, card: 0, ...r.stages };
    const estimate = stages.thin ?? stages.tracked ?? stages.visible;
    const coverage = r.coverage === undefined ? 0.3 : r.coverage;
    turns[String(r.turn)] = {
      decision: { estimates: [{ player: 7, estimate, source: 'tracked', coverage, thin: false, stages }] } as never,
      accuracy: { estimates: [{ player: 7, estimate, truth: r.truth, ratio: estimate / r.truth, source: 'tracked', coverage, thin: false }] } as never,
      truth: { opponents: [{ player: 7, income: r.truth }] } as never,
    };
  }
  return { format: '1v1', seats: 2, turns };
}

describe('scoring the stages', () => {
  it('each stage ÷ truth over the samples that logged it, a stage not applied left out', () => {
    const g = game([
      { turn: 5, stages: { tracked: 10, prior: 40 }, truth: 40 },
      { turn: 6, stages: { tracked: 20, prior: 40, thin: 30 }, truth: 40 },
    ]);
    const by = stageErrors(incomeSamples([g]));
    expect(by.visible).toMatchObject({ n: 2, median: 0.125 });
    expect(by.tracked).toMatchObject({ n: 2, mean: 0.375, meanError: -25 });
    expect(by.prior).toMatchObject({ n: 2, mean: 1, meanError: 0 });
    expect(by.thin).toMatchObject({ n: 1, mean: 0.75 });
    expect(by.observed).toBeUndefined();
  });

  it('an estimate logged before #568 has no stages and is left out of them', () => {
    const g = game([{ turn: 5, stages: { tracked: 10 }, truth: 40 }]);
    delete (g.turns['5']!.decision!.estimates![0] as { stages?: unknown }).stages;
    const s = incomeSamples([g]);
    expect(s[0]!.stages).toBeNull();
    expect(stageErrors(s)).toEqual({});
    expect(incomeCalibration([g])).toMatchObject({ byStage: {}, samples: 1 });
  });
});

describe('the tracked what-if', () => {
  // Four games, each reading the tracked figure at 0.25× the truth in the 25–50% band, two samples each.
  const games = [1, 2, 3, 4].map(() =>
    game([
      { turn: 5, stages: { tracked: 10 }, truth: 40 },
      { turn: 6, stages: { tracked: 20 }, truth: 80 },
    ]),
  );

  it('tries each damping; 0 is the tracker as read', () => {
    const w = trackedWhatIf(incomeSamples(games));
    expect(w.map((x) => x.damping)).toEqual([...WHAT_IF_DAMPINGS]);
    expect(w[0]).toMatchObject({ raised: 0, error: { n: 8, geoMean: 0.25 } });
  });

  it('a game is corrected by the other games\' band only: 0.25× → ÷ 0.5 at the square root, ÷ 0.25 in full', () => {
    const w = trackedWhatIf(incomeSamples(games));
    expect(w.find((x) => x.damping === 0.5)).toMatchObject({ raised: 8, error: { geoMean: 0.5 } });
    expect(w.find((x) => x.damping === 1)).toMatchObject({ raised: 8, error: { geoMean: 1 }, byBand: { '25-50': { n: 8, geoMean: 1 } } });
  });

  it('too few samples in the other games: no correction', () => {
    // Three games: each sees 4 samples of the other two, under 5.
    const w = trackedWhatIf(incomeSamples(games.slice(0, 3)));
    expect(w.every((x) => x.raised === 0)).toBe(true);
  });

  it('a band that read at least the truth is never lowered', () => {
    const high = [1, 2, 3, 4].map(() => game([{ turn: 5, stages: { tracked: 60 }, truth: 40 }, { turn: 6, stages: { tracked: 90 }, truth: 60 }]));
    expect(trackedWhatIf(incomeSamples(high)).every((x) => x.raised === 0 && x.error!.geoMean === 1.5)).toBe(true);
  });

  it('bands apart: another band\'s samples never correct this one', () => {
    const mixed = [1, 2, 3].map(() => game([{ turn: 5, stages: { tracked: 10 }, truth: 40, coverage: 0.6 }]));
    const w = trackedWhatIf(incomeSamples([...games.slice(0, 1), ...mixed]));
    // The one 25–50% game has no other game in its band; the 50–75% games have only 2 other samples each.
    expect(w.every((x) => x.raised === 0)).toBe(true);
  });

  it('the report carries both', () => {
    const r = incomeCalibration(games);
    expect(r.byStage.tracked).toMatchObject({ n: 8, geoMean: 0.25 });
    expect(r.trackedWhatIf).toHaveLength(WHAT_IF_DAMPINGS.length);
  });
});
