// #428: each fogged territory's newest earlier sighting, one source for #417's owner and #428's fog price.
import { describe, expect, it } from 'vitest';
import { countsOf, foggedLastSeen, fogSightings, ownersOf } from '../src/analysis/plan/vacated.js';
import { board, fogged, mine, neutral } from './analysis/helpers.js';

const ownerOnly = (territoryId: number, playerId: number) =>
  ({ territoryId, owner: { kind: 'player' as const, playerId }, armies: null, fogLevel: 'OwnerOnly' });

describe('fogSightings', () => {
  const now = board([fogged(3), fogged(4), fogged(5), fogged(6), mine(7, 2)]);
  const boards = [
    { turn: 1, board: board([neutral(3, 2), mine(4, 5, 20), neutral(5, 7), fogged(6), neutral(7, 2)]) },
    { turn: 2, board: board([fogged(3), mine(4, 9, 20), ownerOnly(5, 20), fogged(6), mine(7, 1)]) },
  ];

  it('keeps, for each territory fogged now, the newest board that showed its owner, with its armies when shown', () => {
    const s = fogSightings(now, boards);
    expect(s.get(3)).toEqual({ owner: null, armies: 2 });
    expect(s.get(4)).toEqual({ owner: 20, armies: 9 });
    // The newest sighting showed only its owner: who holds it now is known, its armies are not.
    expect(s.get(5)).toEqual({ owner: 20, armies: null });
    expect(s.has(6)).toBe(false);
    // In view now: no sighting needed.
    expect(s.has(7)).toBe(false);
  });

  it("feeds both readers from the one map, so #417's owner and #428's count never come from different boards", () => {
    const s = fogSightings(now, boards);
    expect(ownersOf(s)).toEqual(foggedLastSeen(now, boards));
    expect([...ownersOf(s)].sort((a, b) => a[0] - b[0])).toEqual([[4, 20], [5, 20]]);
    // An owner-only sighting gives no count: the older neutral 7 is never used against a newer owner.
    expect([...countsOf(s)].sort((a, b) => a[0] - b[0])).toEqual([[3, { armies: 2, owner: null }], [4, { armies: 9, owner: 20 }]]);
  });
});
