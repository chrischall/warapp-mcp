// #274 review: the border guess's draw never stands beside the plan when it leaves my commander
// takeable where the plan's own orders do not (warapp_submit_turn would refuse it). Pure.
import { describe, expect, it } from 'vitest';
import { guessKeepsCommander, type CommanderCheck } from '../src/tools/commander-check.js';

const check = (killers: number, lostUnanswered = false): CommanderCheck => ({
  safety: { territory: 1, from: 1, armies: 5, distance: 1, killers, needs: null, killedBy: null, lostUnanswered, exact: true },
  replyDeploy: 5,
});

describe('guessKeepsCommander', () => {
  it('keeps the guess with no commander on the board, or when its draw keeps the commander safe', () => {
    expect(guessKeepsCommander(undefined, undefined)).toBe(true);
    expect(guessKeepsCommander(check(0), check(0))).toBe(true);
    expect(guessKeepsCommander(check(2), check(0))).toBe(true);
  });

  it('drops it when the draw leaves the commander takeable and the plan does not', () => {
    expect(guessKeepsCommander(check(0), check(1))).toBe(false);
    expect(guessKeepsCommander(check(0), check(0, true))).toBe(false);
  });

  it('when the plan is already refused, drops it only if the draw is worse', () => {
    expect(guessKeepsCommander(check(3), check(3))).toBe(true);
    expect(guessKeepsCommander(check(3), check(4))).toBe(false);
    expect(guessKeepsCommander(check(3), check(1, true))).toBe(false);
  });
});
