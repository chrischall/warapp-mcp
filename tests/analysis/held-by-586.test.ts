// #586: which step of the tracker held a low estimate below the truth, from the logged track — synthetic only.
import { describe, expect, it } from 'vitest';
import type { LoggedTrack, LoggedTrackTurn } from '../../src/decision-log.js';
import { heldByOf, incomeCalibration, incomeSamples, type CalibrationGame } from '../../src/analysis/income-calibration.js';

const reading = (turn: number, observed: number, extra: Partial<LoggedTrackTurn> = {}): LoggedTrackTurn => ({
  turn,
  observed,
  raw: observed,
  low: observed,
  high: observed,
  cap: 1000,
  coverage: 0.4,
  ...extra,
});
const track = (income: number, window: LoggedTrackTurn[], extra: Partial<LoggedTrack> = {}): LoggedTrack => ({ income, window, ...extra });

describe('the step that held a low estimate (#586)', () => {
  // truth 90: an estimate is low under 60.
  it('is nothing for an estimate that reached two thirds of the truth', () => {
    expect(heldByOf(60, 90, track(60, [reading(5, 60)]))).toBeNull();
  });

  it('names a later stage when the tracker itself reached it', () => {
    expect(heldByOf(30, 90, track(70, [reading(5, 70)]))).toBe('after-tracker');
  });

  it('names the rise cap when a reading reached it and the cap held the income', () => {
    expect(heldByOf(40, 90, track(40, [reading(5, 70)], { rise: { read: 70, before: 30 } }))).toBe('rise-cap');
  });

  it('names the tripwire when it stepped a reading down', () => {
    expect(heldByOf(40, 90, track(40, [reading(5, 70)], { trip: { from: 70, proven: 30, turn: 5 } }))).toBe('tripwire');
  });

  it('names the window when a reading reached it and nothing named held it', () => {
    expect(heldByOf(40, 90, track(40, [reading(5, 70)], { lowered: 30 }))).toBe('window');
  });

  it('names the could-earn ceiling when it cut a reading that reached', () => {
    expect(heldByOf(40, 90, track(40, [reading(5, 40, { raw: 80, high: 80, cap: 40 })]))).toBe('ceiling');
  });

  it('names the ambiguous armies when only the high end reached', () => {
    expect(heldByOf(40, 90, track(40, [reading(5, 40, { high: 75 })]))).toBe('ambiguous');
  });

  it('names the readings when nothing the boards showed reached', () => {
    expect(heldByOf(40, 90, track(40, [reading(5, 40, { high: 50 })]))).toBe('readings');
  });

  it('names no track when the estimate used none, and is unknown when the track was not logged', () => {
    expect(heldByOf(40, 90, undefined, { tracked: null })).toBe('no-track');
    expect(heldByOf(40, 90, track(40, []))).toBe('no-track');
    expect(heldByOf(40, 90, undefined, { tracked: 40 })).toBe('unlogged');
    expect(heldByOf(40, 90, undefined, null)).toBe('unlogged');
  });

  it('counts each step over the low estimates, in the report and on each sample', () => {
    const est = (player: number, estimate: number, t?: LoggedTrack) => ({ player, estimate, source: 'tracked', coverage: 0.4, thin: true, ...(t ? { track: t } : {}) });
    const acc = (player: number, estimate: number, truth: number) => ({ player, estimate, truth, ratio: estimate / truth, source: 'tracked', coverage: 0.4, thin: true });
    const g: CalibrationGame = {
      format: 'ffa',
      seats: 4,
      turns: {
        '10': {
          decision: {
            estimates: [
              est(7, 40, track(40, [reading(9, 70)], { rise: { read: 70, before: 30 } })),
              est(8, 40, track(40, [reading(9, 40, { high: 50 })])),
              est(9, 80, track(80, [reading(9, 80)])),
              est(11, 40),
            ],
          } as never,
          accuracy: { estimates: [acc(7, 40, 90), acc(8, 40, 90), acc(9, 80, 90), acc(11, 40, 90)] } as never,
          truth: { opponents: [] } as never,
        },
      },
    };
    const report = incomeCalibration([g]);
    expect(report.heldBy).toEqual({
      low: 3,
      steps: { 'rise-cap': { n: 1, share: 0.5 }, readings: { n: 1, share: 0.5 } },
      unlogged: 1,
    });
    expect(incomeSamples([g]).map((x) => x.heldBy)).toEqual(['rise-cap', 'readings', null, 'unlogged']);
  });
});
