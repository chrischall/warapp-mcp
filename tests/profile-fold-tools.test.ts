// The fold triggers (docs/PLAN-PROFILES.md B2): the first read that shows a game finished folds its
// per-game profile file into the cross-game stores — in warapp_get_game, and in warapp_wait_for_turn's
// read. Synthetic GameFeed answers only; no war.app traffic.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TurnPrimitives } from '../src/analysis/opponent-profile.js';
import { profileGamePath, profileGamesDir, profilePlayersPath, readProfileHistory } from '../src/profile-store.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';
import { fakeSocketIo, type FakeSocketIo } from './push/fake-socket.js';

const GAME = 12345678;
const ANN = 3312345644;
const BOB = 7176543229;

let h: Harness | undefined;
let socket: FakeSocketIo | undefined;
afterEach(async () => {
  socket?.close();
  await h?.harness.close();
  h = undefined;
  socket = undefined;
});

function game(state: string): Record<string, unknown> {
  const f = lobbyFixture();
  const [a, b] = f.players as Array<Record<string, string>>;
  return {
    ...f,
    id: String(GAME),
    state,
    numberOfTurns: '6',
    players: [
      { ...a, id: String(ANN), name: 'Ann', state: state === 'Finished' ? 'Won' : 'Playing' },
      { ...b, id: String(BOB), name: 'Bob', state: state === 'Finished' ? 'SurrenderAccepted' : 'Playing' },
    ],
  };
}

const turn = (attackedMe: boolean): TurnPrimitives => ({
  contact: true,
  attackedMe,
  iAttacked: false,
  reinforce: { n: 0, e: 0, extra: 0 },
  stack: null,
  tookFromMe: [],
  lostToMe: [],
});

/** A per-game profile file as the board-caching tools leave it: Bob attacked me on two of three turns. */
function seed(): string {
  const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-foldtools-'));
  mkdirSync(profileGamesDir(dir), { recursive: true });
  writeFileSync(
    profileGamePath(dir, GAME, ANN),
    JSON.stringify({ version: 1, gameId: GAME, playerId: ANN, turns: { 1: { [BOB]: turn(true) }, 2: { [BOB]: turn(false) }, 3: { [BOB]: turn(true) } } }),
  );
  return dir;
}

describe('the fold triggers', () => {
  it('warapp_get_game folds a finished game once and marks its file', async () => {
    const dir = seed();
    h = await liveHarness({ feed: [game('Finished')], dataDir: dir });
    const r = await h.call('warapp_get_game', { game_id: GAME });
    expect(payload(r)).toMatchObject({ game: { id: GAME } });
    expect(JSON.parse(readFileSync(profileGamePath(dir, GAME, ANN), 'utf8')).folded).toBe('live');
    const hist = await readProfileHistory(dir, [BOB], {}, {});
    if (typeof hist !== 'object') throw new Error(String(hist));
    expect(hist.players.get(BOB)).toMatchObject({ games: 1, past: { attack: { e: 2, n: 3 }, turns: 3 } });
    const text = readFileSync(profilePlayersPath(dir), 'utf8');
    expect(text).toContain('"ending":"SurrenderAccepted"');
    expect(text).not.toContain(String(BOB));
    expect(text).not.toContain(String(GAME));
  });

  it('warapp_get_game folds nothing for a game in progress, nor with profiling off', async () => {
    const dir = seed();
    h = await liveHarness({ feed: [game('Playing')], dataDir: dir });
    await h.call('warapp_get_game', { game_id: GAME });
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
    await h.harness.close();
    h = await liveHarness({ feed: [game('Finished')], dataDir: dir, env: { WARAPP_PLAYER_PROFILE: 'off' } });
    await h.call('warapp_get_game', { game_id: GAME });
    expect(existsSync(profilePlayersPath(dir))).toBe(false);
  });

  it("warapp_wait_for_turn's read folds a finished game", async () => {
    const dir = seed();
    socket = fakeSocketIo();
    h = await liveHarness({
      feed: [game('Finished')],
      dataDir: dir,
      socket,
      pages: { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN}</p>` },
    });
    const r = await h.call('warapp_wait_for_turn', { game_ids: [GAME], timeout_seconds: 5 });
    expect(payload(r)).toMatchObject({ status: 'game_over' });
    expect(JSON.parse(readFileSync(profileGamePath(dir, GAME, ANN), 'utf8')).folded).toBe('live');
    expect(existsSync(profilePlayersPath(dir))).toBe(true);
  });
});
