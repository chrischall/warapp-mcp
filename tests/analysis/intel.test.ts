// #386: stored intel (avoid targets, stated incomes) applied by default; explicit arguments win; stale incomes drop out.
import { describe, expect, it } from 'vitest';
import { emptyIntel, INCOME_STALE_TURNS, resolveIntel, type StoredIntel } from '../../src/analysis/intel.js';

const stored: StoredIntel = {
  avoidTerritories: [{ territory: 157, turn: 2, promisedTo: 9 }],
  avoidPlayers: [{ player: 7, turn: 2, reason: 'promised' }],
  incomes: [
    { player: 7, income: 20, turn: 3 },
    { player: 8, income: 11, turn: 1 },
  ],
};

describe('resolveIntel', () => {
  it('passes the arguments through untouched when nothing is stored', () => {
    expect(resolveIntel(undefined, 5, { avoidPlayers: [3] })).toEqual({ avoidPlayers: [3], warnings: [] });
    expect(resolveIntel(emptyIntel(), 5, {})).toEqual({ warnings: [] });
  });

  it('applies the stored entries by default, leaving a stale income out with a warning', () => {
    const r = resolveIntel(stored, 1 + INCOME_STALE_TURNS + 1, {});
    expect(r.avoidTerritories).toEqual([157]);
    expect(r.avoidPlayers).toEqual([7]);
    expect(r.knownIncome).toEqual([{ player: 7, income: 20 }]);
    expect(r.report).toEqual({
      applied: {
        avoidTerritories: [{ territory: 157, promisedTo: 9 }],
        avoidPlayers: [{ player: 7, reason: 'promised' }],
        knownIncome: [{ player: 7, income: 20, statedTurn: 3 }],
      },
      overridden: [],
      stale: [{ player: 8, income: 11, statedTurn: 1, turnsOld: INCOME_STALE_TURNS + 1 }],
    });
    const w = r.warnings.join('\n');
    expect(w).toMatch(/income 11 recorded for player 8 \(stated on turn 1\) is 4 turns old.*not applied/);
    expect(w).toMatch(/Recorded intel \(warapp_record_intel\) applied/);
  });

  it('keeps an income exactly INCOME_STALE_TURNS old', () => {
    const r = resolveIntel({ ...emptyIntel(), incomes: [{ player: 8, income: 11, turn: 1 }] }, 1 + INCOME_STALE_TURNS, {});
    expect(r.knownIncome).toEqual([{ player: 8, income: 11 }]);
    expect(r.report!.stale).toEqual([]);
  });

  it('lets an explicit argument of a kind replace the stored list of that kind, an empty one included', () => {
    const r = resolveIntel(stored, 4, { avoidTerritories: [], knownIncome: [{ player: 8, income: 30 }] });
    expect(r.avoidTerritories).toEqual([]);
    expect(r.knownIncome).toEqual([{ player: 8, income: 30 }]);
    expect(r.avoidPlayers).toEqual([7]);
    expect(r.report!.overridden).toEqual(['avoid_territories', 'known_income']);
    expect(r.report!.stale).toEqual([]);
  });
});
