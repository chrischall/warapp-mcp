// #428: each territory's last sighting on my board history, for the planner's fogged-member price.
import { describe, expect, it } from 'vitest';
import { lastSeenOf } from '../src/tools/turn.js';
import { board, fogged, mine, neutral } from './analysis/helpers.js';

describe('lastSeenOf', () => {
  it('keeps the newest board that showed each territory, its armies and owner (null: a neutral)', () => {
    const seen = lastSeenOf([
      { turn: 1, board: board([neutral(3, 2), mine(4, 5, 20), neutral(5, 7)]) },
      { turn: 2, board: board([fogged(3), mine(4, 9, 20), { territoryId: 5, owner: { kind: 'player', playerId: 20 }, armies: null, fogLevel: 'OwnerOnly' }]) },
    ]);
    expect(seen.get(3)).toEqual({ armies: 2, owner: null });
    expect(seen.get(4)).toEqual({ armies: 9, owner: 20 });
    // An owner-only sighting carries no armies: the last count in view stands.
    expect(seen.get(5)).toEqual({ armies: 7, owner: null });
  });

  it('never reads a board from GameFeed history (unverified in progress)', () => {
    expect(lastSeenOf([{ turn: 1, source: 'history', board: board([neutral(3, 2)]) }]).size).toBe(0);
  });
});
