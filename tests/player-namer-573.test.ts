// #573: warapp_check_plan's #567 warnings (and warapp_plan_turn's stated-shift warning) name a player by its
// name, delimited, beside its GameFeed id, as warapp_track_opponents' own warnings name it — not by the bare id.
import { describe, expect, it } from 'vitest';
import { observedLowWarning } from '../src/analysis/opponents.js';
import { statedShiftWarning } from '../src/analysis/plan/estimates.js';
import { playerNamer } from '../src/tools/common.js';

const players = [
  { id: 2011, name: 'Ann' },
  { id: 3022, name: 'Bob "the [builder]"' },
  { id: 4033, name: '' },
];

describe('playerNamer (#573)', () => {
  const named = playerNamer(players);

  it('names a listed player by its delimited name and its id', () => {
    expect(named(2011)).toBe('⟦Ann⟧ (2011)');
  });

  it("cleans a player's own words as every third-party name is cleaned", () => {
    const shown = named(3022);
    expect(shown).toMatch(/^⟦.*⟧ \(3022\)$/);
    expect(shown).not.toContain('"');
  });

  it('falls back to the bare id for a player not listed, or with no name', () => {
    expect(named(9999)).toBe('9999');
    expect(named(4033)).toBe('4033');
  });

  it('the stated-shift warning names both players through it', () => {
    expect(statedShiftWarning([{ player: 2011, was: 91, now: 19, by: [{ id: 9999, income: 27 }] }], named)).toBe(
      "The known income given (player 9999's 27) moved another opponent's estimate: player ⟦Ann⟧ (2011) ~91 → ~19 (#444: a stated income scales the fog prior of every opponent who stated none). To size them without it, leave that known_income out.",
    );
  });

  it('the observed-low warning names the player through it', () => {
    expect(observedLowWarning(named(2011), 17, { low: 29, high: 29, turn: 10, coverage: null }, 'rise-capped')).toMatch(
      /^Player ⟦Ann⟧ \(2011\)'s income is held at ~17, but turn 10 read it deploying at least \+29 \(#567\)/,
    );
  });
});
