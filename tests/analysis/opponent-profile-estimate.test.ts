// Part B1 (docs/PLAN-PROFILES.md section 9): the shrinkage estimate across games — this game's counts
// pooled with the player's faded totals, shrunk toward a prior from the population pool (format, then
// all) or the constant default; the basis names what contributed most; labels and counter-play.
import { describe, expect, it } from 'vitest';
import {
  addHabits,
  COUNTER_PLAY,
  emptyHabits,
  estimateHabits,
  HABIT_DEFAULTS,
  labelsOf,
  POPULATION_MIN_OPPORTUNITIES,
  PROFILE_LABELS,
  profileFormatOf,
  scaleHabits,
  type Habits,
} from '../../src/analysis/opponent-profile.js';

const withRate = (name: 'reinforce' | 'attack' | 'firstStrike' | 'retaliate' | 'retake', e: number, n: number, turns = 0): Habits => ({
  ...emptyHabits(),
  [name]: { e, n },
  turns,
});

describe('habit arithmetic', () => {
  it('adds and scales every count, turns included', () => {
    const a: Habits = {
      reinforce: { e: 1, n: 2 },
      reinforceExtra: { n: 1, sum: 3 },
      attack: { e: 2, n: 4 },
      firstStrike: { e: 1, n: 1 },
      stacking: { n: 2, sum: 1.5, sq: 1.25 },
      retaliate: { e: 0, n: 1 },
      retake: { e: 1, n: 3 },
      turns: 6,
    };
    expect(addHabits(emptyHabits(), a)).toEqual(a);
    const twice = addHabits(a, a);
    expect(twice.reinforce).toEqual({ e: 2, n: 4 });
    expect(twice.stacking).toEqual({ n: 4, sum: 3, sq: 2.5 });
    expect(twice.turns).toBe(12);
    expect(scaleHabits(a, 0.5).attack).toEqual({ e: 1, n: 2 });
    expect(addHabits(a, a, -1)).toEqual(emptyHabits());
  });
});

describe('profileFormatOf', () => {
  it('reads a team game, a 1v1 and a free-for-all from the seated players', () => {
    expect(profileFormatOf([{ state: 'Won' }, { state: 'Eliminated' }])).toBe('1v1');
    expect(profileFormatOf([{ state: 'Won' }, { state: 'Eliminated' }, { state: 'Declined' }])).toBe('1v1');
    expect(profileFormatOf([{}, {}, {}])).toBe('ffa');
    expect(profileFormatOf([{ team: 0 }, { team: 0 }, { team: 1 }, { team: 1 }])).toBe('team');
  });
});

describe('estimateHabits across games', () => {
  it('pools this game in full with the past totals and names the basis that weighs most', () => {
    // This game: 1 of 2. Past: 7 of 8 (faded). K = 4 at the default 0.5.
    const est = estimateHabits(withRate('reinforce', 1, 2), { past: withRate('reinforce', 7, 8) });
    expect(est.reinforce).toEqual({ value: Math.round(((0.5 * 4 + 8) / 14) * 100) / 100, n: 10, confidence: 0.71, basis: 'past-games' });
    // This game outweighs the past.
    expect(estimateHabits(withRate('reinforce', 6, 6), { past: withRate('reinforce', 0, 5) }).reinforce.basis).toBe('this-game');
    // Neither outweighs the prior.
    expect(estimateHabits(withRate('reinforce', 1, 2), { past: withRate('reinforce', 1, 3) }).reinforce.basis).toBe('default');
  });

  it('shrinks toward the population pool (format first, then all) once it has enough opportunities', () => {
    const format = withRate('reinforce', 9, 10);
    const all = withRate('reinforce', 2, 20);
    const est = estimateHabits(emptyHabits(), { pools: [format, all] });
    expect(est.reinforce).toEqual({ value: 0.9, n: 0, confidence: 0, basis: 'population' });
    // A format pool too small falls back to all players.
    const thin = withRate('reinforce', 1, POPULATION_MIN_OPPORTUNITIES - 1);
    expect(estimateHabits(emptyHabits(), { pools: [thin, all] }).reinforce).toMatchObject({ value: 0.1, basis: 'population' });
    // Every pool too small: the constant default.
    expect(estimateHabits(emptyHabits(), { pools: [thin] }).reinforce).toMatchObject({ value: HABIT_DEFAULTS.reinforce, basis: 'default' });
    // A habit the pool does not speak to keeps its default.
    expect(estimateHabits(emptyHabits(), { pools: [format] }).attack).toMatchObject({ value: HABIT_DEFAULTS.attack, basis: 'default' });
  });

  it('shrinks a size toward the prior mean', () => {
    const pool: Habits = { ...emptyHabits(), stacking: { n: 20, sum: 10, sq: 6 } };
    const game: Habits = { ...emptyHabits(), stacking: { n: 4, sum: 4, sq: 4 } };
    expect(estimateHabits(game, { pools: [pool] }).stacking).toEqual({ value: 0.75, n: 4, confidence: 0.5, basis: 'population' });
  });

  it('is the part-A estimate with no priors', () => {
    expect(estimateHabits(withRate('attack', 0, 8))).toEqual(estimateHabits(withRate('attack', 0, 8), {}));
    expect(estimateHabits(withRate('attack', 0, 8)).attack).toEqual({ value: 0.13, n: 8, confidence: 0.67, basis: 'this-game' });
  });

  it('labels on the pooled estimate, so a past-games read gives a label this game alone would not', () => {
    const game = withRate('reinforce', 2, 2);
    expect(labelsOf(estimateHabits(game))).toEqual([]);
    expect(labelsOf(estimateHabits(game, { past: withRate('reinforce', 5, 6) }))).toEqual(['reinforcer']);
  });

  it('has one counter-play line for every label but spreader', () => {
    for (const l of PROFILE_LABELS) expect(Boolean(COUNTER_PLAY[l])).toBe(l !== 'spreader');
  });
});
