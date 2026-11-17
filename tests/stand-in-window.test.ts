// The owner, 2026-11-17: "I want to fallback gracefully in the future. I'm assuming the old version is
// supported for some amount of time giving us a window to adapt." A build that decoded a live board is
// recorded; while a stand-in decodes, the window shows in the tools; when war.app stops answering the old
// protocol, the error says so instead of a generic decode failure. Synthetic boards, no war.app traffic.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { WarappBundle, type RecordOutcome } from '../src/protocol/bundle.js';
import { standInLine } from '../src/tools/live-context.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { LIVE_BUNDLE, writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';
import { MY_GAMES_BUNDLE } from './protocol/my-games-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const SINCE = '2026-11-17T03:00:00.000Z';

function game(): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return { ...f, state: 'Playing', numberOfTurns: '2', players };
}

const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 20 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 20 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 3 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

/** The synthetic bundle, with a recorder spy; a stand-in when `standIn` is given. */
function bundle(standIn = false): { b: WarappBundle; recorded: number[] } {
  const b = new WarappBundle(`${LIVE_BUNDLE}\n${MY_GAMES_BUNDLE}`, standIn ? 'old-build' : 'test');
  const recorded: number[] = [];
  b.digest = 'a'.repeat(64);
  b.recorder = async (): Promise<RecordOutcome> => {
    recorded.push(1);
    return 'recorded';
  };
  if (standIn) {
    b.standInFor = { version: 'new-build', reason: 'renamed readers' };
    b.standIn = { version: 'old-build', refusedVersion: 'new-build', since: SINCE, reason: 'renamed readers' };
  }
  return { b, recorded };
}

type Reply = (req: DecodedRequest) => Partial<ReplyFrame>;
const boardReply: Reply = () => ({ body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame]) });
/** The board with bytes the readers never read appended: what a changed layout looks like. */
const longReply: Reply = () => ({
  body: (w) => {
    writeLatestGameInfo(w, BOARD, [ANN.inGame]);
    w.int32(7).int32(9);
  },
});
/** A reply framed in another protocol version. */
const otherVersion: Reply = () => ({ version: 243, body: (w) => writeLatestGameInfo(w, BOARD, [ANN.inGame]) });

async function harness(b: WarappBundle, reply: Reply): Promise<Harness> {
  return liveHarness({
    feed: [game()],
    bundle: b,
    warapp: (req) => {
      if (req.method !== Method.GetLatestGameInfo) throw new Error(`unexpected method ${req.method}`);
      return reply(req);
    },
  });
}

describe('a build that decodes a live board is recorded', () => {
  it('records the bundle once its board decodes with every byte read', async () => {
    const { b, recorded } = bundle();
    h = await harness(b, boardReply);
    expect((await h.call('warapp_get_live_board', { game_id: GAME })).isError).toBeFalsy();
    expect(recorded).toEqual([1]);
    await h.call('warapp_get_live_board', { game_id: GAME });
    expect(recorded).toEqual([1]);
  });

  it('records nothing when bytes are left over, and without a stand-in the error stays the decode error', async () => {
    const { b, recorded } = bundle();
    h = await harness(b, longReply);
    const res = await h.call('warapp_get_live_board', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/bytes left unread/);
    expect(textOf(res)).not.toMatch(/#340/);
    expect(recorded).toEqual([]);
  });
});

describe('when war.app stops answering the old protocol, the error says so', () => {
  it('a stand-in whose reply has bytes left over: the window has closed (#340)', async () => {
    const { b, recorded } = bundle(true);
    h = await harness(b, longReply);
    const res = await h.call('warapp_get_live_board', { game_id: GAME });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/no longer answers .*old-build/);
    expect(text).toMatch(/new-build/);
    expect(text).toMatch(/#340/);
    expect(recorded).toEqual([]);
  });

  it('a stand-in answered in another protocol version: the window has closed', async () => {
    const { b } = bundle(true);
    h = await harness(b, otherVersion);
    const res = await h.call('warapp_get_live_board', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no longer answers/);
    expect(textOf(res)).toMatch(/protocol version 243/);
  });

  it('without a stand-in, another protocol version is the plain version error', async () => {
    const { b } = bundle();
    h = await harness(b, otherVersion);
    const res = await h.call('warapp_get_live_board', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/protocol version 243/);
    expect(textOf(res)).not.toMatch(/no longer answers/);
  });
});

describe('the open window is shown', () => {
  it('standInLine names the build, the client it stands in for and since when', () => {
    expect(standInLine(undefined)).toBeUndefined();
    const line = standInLine({ version: 'old-build', refusedVersion: 'new-build', since: SINCE, reason: 'x' });
    expect(line).toMatch(/new-build/);
    expect(line).toMatch(/old-build/);
    expect(line).toMatch(new RegExp(SINCE.slice(0, 16)));
  });

  it('warapp_session_status reports the window once a live board has been read', async () => {
    const { b } = bundle(true);
    h = await harness(b, boardReply);
    await h.call('warapp_get_live_board', { game_id: GAME });
    const s = payload<{ decoder: { standIn: unknown } }>(await h.call('warapp_session_status'));
    expect(s.decoder.standIn).toEqual({ version: 'old-build', refusedVersion: 'new-build', since: SINCE, reason: 'renamed readers' });
  });

  it('warapp_healthcheck reports the window', async () => {
    const { b } = bundle(true);
    h = await harness(b, boardReply);
    await h.call('warapp_get_live_board', { game_id: GAME });
    expect(textOf(await h.call('warapp_healthcheck'))).toMatch(/"refusedVersion":\s*"new-build"/);
  });

  it('warapp_check_plan and warapp_plan_turn lead their warnings with it', async () => {
    const { b } = bundle(true);
    h = await harness(b, boardReply);
    const check = payload<{ warnings: string[] }>(
      await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 159, armies: 5 }] }),
    );
    expect(check.warnings[0]).toMatch(/old-build/);
    const plan = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(plan.warnings[0]).toMatch(/old-build/);
  });

  it('no warning line without a stand-in', async () => {
    const { b } = bundle();
    h = await harness(b, boardReply);
    const plan = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(plan.warnings.join('\n')).not.toMatch(/stands in/);
  });
});
