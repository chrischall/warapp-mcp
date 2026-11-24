// #569: the decision logs' income estimates scored against the truth — synthetic logs only.
import { describe, expect, it } from 'vitest';
import { catchUp, consequences, errorView, incomeCalibration, incomeSamples, phaseOf, seatBand, type CalibrationGame } from '../../src/analysis/income-calibration.js';

type Turns = CalibrationGame['turns'];

/** One logged turn: estimates [player, estimate, source, coverage, thin, method?] beside the true incomes. */
function turn(
  est: [number, number, string, number | null, boolean, string?][],
  truth: Record<number, number>,
  extra: { lost?: number[]; conceded?: number[] } = {},
): Turns[string] {
  return {
    decision: {
      estimates: est.map(([player, estimate, source, coverage, thin, method]) => ({ player, estimate, source: source as never, coverage, thin, ...(method ? { method } : {}) })),
      conceded: extra.conceded ?? [],
    } as never,
    accuracy: {
      estimates: est.map(([player, estimate, source, coverage, thin]) => ({
        player,
        estimate,
        truth: truth[player] ?? 0,
        ratio: truth[player] ? estimate / truth[player]! : null,
        source,
        coverage,
        thin,
      })),
    } as never,
    truth: { board: 0, mine: { income: 10, armies: 0, territories: 0 }, opponents: Object.entries(truth).map(([p, income]) => ({ player: Number(p), income })) } as never,
    ...(extra.lost ? { next: { income: 10, gained: [], lost: extra.lost, capturesMade: [], capturesMissed: [], bonusesHeld: [], eliminated: false } } : {}),
  };
}

describe('income calibration (#569)', () => {
  it('bands phases and seats', () => {
    expect([phaseOf(1), phaseOf(4), phaseOf(5), phaseOf(10), phaseOf(11)]).toEqual(['turns-1-4', 'turns-1-4', 'turns-5-10', 'turns-5-10', 'turns-11-up']);
    expect([seatBand(2), seatBand(5), seatBand(12), seatBand(40), seatBand(null)]).toEqual(['2', '3-6', '7-16', '17-up', 'unknown']);
  });

  it('scores each logged estimate with its context, leader marked, a zero truth skipped', () => {
    const g: CalibrationGame = {
      format: 'ffa',
      seats: 3,
      turns: { '6': turn([[7, 10, 'tracked', 0.3, true, 'rise-capped'], [8, 5, 'visible', 0.8, false], [9, 4, 'prior', null, true]], { 7: 40, 8: 5, 9: 0 }) },
    };
    const s = incomeSamples([g]);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ game: 1, turn: 6, phase: 'turns-5-10', ratio: 0.25, error: -30, source: 'tracked', band: '25-50', thin: true, method: 'rise-capped', leader: true });
    expect(s[1]).toMatchObject({ ratio: 1, error: 0, band: '75-up', method: null, leader: false });
  });

  it('summarises ratios: mean, median, geometric mean, tails and signed error', () => {
    const v = errorView([
      { ratio: 0.25, error: -30 },
      { ratio: 1, error: 0 },
      { ratio: 2, error: 10 },
    ])!;
    expect(v).toMatchObject({ n: 3, median: 1, geoMean: 0.794, under: 0.333, over: 0.333, meanError: -6.667 });
    expect(errorView([])).toBeNull();
  });

  it('counts the catch-up after a true income jump, and a jump never caught as censored', () => {
    const g: CalibrationGame = {
      format: '1v1',
      seats: 2,
      turns: {
        '3': turn([[7, 10, 'tracked', 0.5, false]], { 7: 10 }),
        '4': turn([[7, 10, 'tracked', 0.5, false]], { 7: 30 }), // jump ×3; estimate 10 < 20
        '5': turn([[7, 15, 'tracked', 0.5, false]], { 7: 30 }),
        '6': turn([[7, 21, 'tracked', 0.5, false]], { 7: 30 }), // caught: lag 2
        '7': turn([[7, 21, 'tracked', 0.5, false]], { 7: 60 }), // jump ×2, never caught
      },
    };
    expect(catchUp([g])).toEqual({ jumps: 2, caught: 1, meanLag: 2, medianLag: 2, lags: { '2': 1 }, censored: 1 });
  });

  it('splits turns that lost an unconceded territory by whether an estimate read under half', () => {
    const g: CalibrationGame = {
      format: 'ffa',
      seats: 4,
      turns: {
        '2': turn([[7, 2, 'tracked', 0.2, true]], { 7: 10 }, { lost: [5], conceded: [] }),
        '3': turn([[7, 9, 'tracked', 0.2, true]], { 7: 10 }, { lost: [5], conceded: [5] }),
        '4': turn([[7, 9, 'tracked', 0.2, true]], { 7: 10 }, { lost: [6] }),
      },
    };
    expect(consequences([g])).toEqual({ turns: 3, underTurns: 1, underWithLoss: 1, otherTurns: 2, otherWithLoss: 1 });
  });

  it('reports every breakdown, games without truth left out of the count', () => {
    const g1: CalibrationGame = { format: '1v1', seats: 2, turns: { '2': turn([[7, 5, 'tracked', 0.6, false, 'carried']], { 7: 10 }) } };
    const g2: CalibrationGame = { format: 'ffa', seats: 8, turns: { '12': turn([[8, 30, 'prior', 0.1, true]], { 8: 20 }) } };
    const none: CalibrationGame = { format: 'ffa', seats: 3, turns: { '1': {} } };
    const r = incomeCalibration([g1, g2, none]);
    expect(r.games).toBe(2);
    expect(r.samples).toBe(2);
    expect(Object.keys(r.byFormat)).toEqual(['1v1', 'ffa']);
    expect(Object.keys(r.bySeats)).toEqual(['2', '7-16']);
    expect(Object.keys(r.byPhase)).toEqual(['turns-1-4', 'turns-11-up']);
    expect(Object.keys(r.byMethod)).toEqual(['carried', 'unlogged']);
    expect(r.byThin.thin?.n).toBe(1);
    expect(r.byLeader.leader?.n).toBe(2);
    expect(r.byPhaseAndCoverage['turns-1-4']?.['50-75']?.n).toBe(1);
    expect(r.worst[0]).toMatchObject({ game: 1, ratio: 0.5 });
    expect(JSON.stringify(r)).not.toMatch(/"player"/);
  });
});
