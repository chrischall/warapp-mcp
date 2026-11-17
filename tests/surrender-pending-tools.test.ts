import { describe, expect, it } from 'vitest';
import { readPendingSurrenders } from '../src/tools/surrender-pending.js';

// #327: where no surrender can concern me the answer is a definite empty list, read from nothing;
// null stays "could not be read".
describe('readPendingSurrenders', () => {
  const ctx = {} as Parameters<typeof readPendingSurrenders>[0];
  const game = (state: string) => ({ id: 7, state, players: [] }) as unknown as Parameters<typeof readPendingSurrenders>[1];
  const me = (state: string) => ({ id: 11, state }) as unknown as Parameters<typeof readPendingSurrenders>[2];
  const never = async () => {
    throw new Error('no details read expected');
  };

  it.each([
    ['a lobby', 'WaitingForPlayers', 'Playing'],
    ['a finished game', 'Finished', 'Won'],
    ['a game I surrendered', 'Playing', 'SurrenderAccepted'],
    ['a game I was eliminated from', 'Playing', 'Eliminated'],
  ])('%s: an empty list, no details read', async (_label, state, seat) => {
    expect(await readPendingSurrenders(ctx, game(state), me(seat), never)).toEqual([]);
  });

  it('no seat of mine to judge by: null (unknown), no details read', async () => {
    expect(await readPendingSurrenders(ctx, game('Playing'), undefined, never)).toBeNull();
  });

  it('a game in play whose details do not read: null', async () => {
    expect(await readPendingSurrenders(ctx, game('Playing'), me('Playing'), async () => undefined)).toBeNull();
  });
});
