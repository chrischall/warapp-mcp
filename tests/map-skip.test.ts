// Tools that never use the map never download it (#148): every GameFeed read they make, for a game
// this process has not seen, asks GetMap=false. Synthetic fixture, made-up ids.
import { afterEach, describe, expect, it } from 'vitest';
import { liveHarness, lobbyFixture, type Harness } from './helpers.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

function game(state: string): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) => (i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : p));
  return { ...f, state, numberOfTurns: state === 'Playing' ? '2' : '-1', players };
}

const CASES: Array<[tool: string, args: Record<string, unknown>, state: string]> = [
  ['warapp_surrender', { game_id: GAME }, 'Playing'],
  ['warapp_uncommit_turn', { game_id: GAME }, 'Playing'],
  ['warapp_get_chat', { game_id: GAME }, 'Playing'],
  ['warapp_send_chat', { game_id: GAME, message: 'gl hf' }, 'Playing'],
  ['warapp_begin_turn', { game_id: GAME }, 'Playing'],
  ['warapp_scout_player', { game_id: GAME, player: 'Ann' }, 'Playing'],
];

describe('tools that never use the map do not download it (#148)', () => {
  it.each(CASES)('%s reads GameFeed with GetMap=false', async (tool, args, state) => {
    h = await liveHarness({ feed: [game(state)], pages: SIGNED_IN });
    await h.call(tool, args);
    expect(h.calls.length, 'GameFeed was read').toBeGreaterThan(0);
    for (const c of h.calls) expect(c.url).toContain('GetMap=false');
  });

  it('a tool that needs the map still downloads it for a game it has not seen', async () => {
    h = await liveHarness({ feed: [game('Playing')], pages: SIGNED_IN });
    await h.call('warapp_get_map', { game_id: GAME });
    expect(h.calls[0]!.url).not.toContain('GetMap=false');
  });
});
