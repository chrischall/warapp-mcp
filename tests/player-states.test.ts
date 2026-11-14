import { describe, expect, it } from 'vitest';
import { holdsSeat, PLAYER_STATE_NAMES, playerStateName } from '../src/player-states.js';

describe('player states: one definition of "holds a seat" (#133)', () => {
  it('an invitation not yet accepted, a declined one and a removal by the host hold no seat', () => {
    for (const s of ['Invited', 'Declined', 'RemovedByHost']) expect(holdsSeat(s)).toBe(false);
  });

  it('every other state held a seat, finished ones included; an absent state is Playing', () => {
    for (const s of ['Playing', 'Eliminated', 'Won', 'SurrenderAccepted', 'Booted', 'EndedByVote', undefined]) {
      expect(holdsSeat(s)).toBe(true);
    }
  });

  it('names the web client\'s GamePlayerState codes as GameFeed does, so both transports share the test', () => {
    expect(playerStateName(1)).toBe('Invited');
    expect(playerStateName(5)).toBe('Declined');
    expect(playerStateName(6)).toBe('RemovedByHost');
    expect(holdsSeat(playerStateName(2))).toBe(true);
    expect(holdsSeat(playerStateName(1))).toBe(false);
    expect(playerStateName(42)).toBe('42');
    expect(Object.keys(PLAYER_STATE_NAMES)).toHaveLength(9);
  });
});
