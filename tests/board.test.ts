import { describe, expect, it } from 'vitest';
import { boardFromStanding } from '../src/board.js';

describe('boardFromStanding (loose — the live in-progress shape is unverified)', () => {
  it('reads an array of territory entries with string scalars', () => {
    const board = boardFromStanding([
      { terrID: '1', ownedBy: '1000', armies: '5', fogLevel: 'Visible' },
      { terrID: '2', ownedBy: 'Neutral', armies: '2', fogLevel: 'Visible' },
      { terrID: '3', ownedBy: 'AvailableForDistribution', armies: '2' },
      { terrID: '4', ownedBy: 'Neutral', armies: 'Fogged', fogLevel: 'Fogged' },
    ]);
    expect(board).toEqual({
      source: 'gamefeed',
      verified: false,
      territories: [
        { territoryId: 1, owner: { kind: 'player', playerId: 1000 }, armies: 5, fogLevel: 'Visible' },
        { territoryId: 2, owner: { kind: 'neutral' }, armies: 2, fogLevel: 'Visible' },
        { territoryId: 3, owner: { kind: 'available' }, armies: 2 },
        { territoryId: 4, owner: { kind: 'unknown' }, armies: null, fogLevel: 'Fogged' },
      ],
    });
  });

  it('accepts alternative key spellings and a { territories } wrapper', () => {
    const board = boardFromStanding({
      territories: [
        { id: 7, ownerID: 1001, numArmies: 3, fog: 'Visible' },
        { territoryID: '8', owner: 'Neutral', NumArmies: '4' },
      ],
    });
    expect(board?.territories).toEqual([
      { territoryId: 7, owner: { kind: 'player', playerId: 1001 }, armies: 3, fogLevel: 'Visible' },
      { territoryId: 8, owner: { kind: 'neutral' }, armies: 4 },
    ]);
  });

  it('accepts an object keyed by territory id', () => {
    const board = boardFromStanding({ '5': { ownedBy: '1000', armies: '9' } });
    expect(board?.territories).toEqual([{ territoryId: 5, owner: { kind: 'player', playerId: 1000 }, armies: 9 }]);
  });

  it('reads an armies object ({ numArmies }) as its count', () => {
    const board = boardFromStanding([{ terrID: '1', ownedBy: '1000', armies: { numArmies: '6', specialUnits: [] } }]);
    expect(board?.territories[0]!.armies).toBe(6);
  });

  it('skips entries without a territory id and returns undefined when nothing is usable', () => {
    expect(boardFromStanding([{ ownedBy: '1000' }, { terrID: '2', ownedBy: 'Neutral', armies: '1' }])?.territories).toHaveLength(1);
    expect(boardFromStanding([{ foo: 1 }])).toBeUndefined();
    expect(boardFromStanding(undefined)).toBeUndefined();
    expect(boardFromStanding(null)).toBeUndefined();
    expect(boardFromStanding('nope')).toBeUndefined();
    expect(boardFromStanding([])).toBeUndefined();
    expect(boardFromStanding({})).toBeUndefined();
  });

  it('treats an unrecognised owner string as unknown, keeping its text', () => {
    const board = boardFromStanding([{ terrID: '1', ownedBy: 'SomethingNew', armies: '1' }]);
    expect(board?.territories[0]!.owner).toEqual({ kind: 'unknown', raw: 'SomethingNew' });
  });
});
