import { McpToolError } from '@chrischall/mcp-utils';
import { describe, expect, it } from 'vitest';
import type { Game, GameMap, Player } from '../src/normalize.js';
import { WarappServerError } from '../src/protocol/rpc.js';
import { namer } from '../src/tools/common.js';
import {
  accountUnknown,
  mySeat,
  refuse,
  requireMe,
  requireMySeat,
  requirePlaying,
  sendAndVerify,
  type SendAndVerify,
} from '../src/tools/write-kit.js';

const ME = 3312345644;
const player = (id: number, name: string, state = 'Playing'): Player => ({ id, name, state }) as Player;
const game = (players: Player[]): Game => ({ id: 4001, state: 'Playing', players }) as unknown as Game;
const ctxOf = (token: number | undefined, hosted = false) => {
  const reads: Array<{ fresh?: boolean } | undefined> = [];
  return {
    reads,
    hosted,
    myInviteToken: async (o?: { fresh?: boolean }) => {
      reads.push(o);
      return token;
    },
  };
};

async function refusal(p: Promise<unknown> | (() => unknown)): Promise<McpToolError> {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    expect(e).toBeInstanceOf(McpToolError);
    return e as McpToolError;
  }
  throw new Error('expected a refusal');
}

describe('refuse', () => {
  it('throws an McpToolError with the hint', async () => {
    const e = await refusal(() => refuse('No.', 'Try that.'));
    expect(e.message).toBe('No.');
    expect(e.hint).toBe('Try that.');
  });
});

describe('namer', () => {
  it('names a territory by id, falling back to the id', () => {
    const name = namer({ territories: [{ id: 1, name: 'Alpha' }] } as unknown as GameMap);
    expect(name(1)).toEqual({ id: 1, name: 'Alpha' });
    expect(name(9)).toEqual({ id: 9, name: '9' });
  });
});

describe('accountUnknown / requireMe: one refusal for an unreadable account', () => {
  it('says nothing was sent, with the signed-in hint (link offered only locally)', () => {
    const local = accountUnknown(false);
    expect(local.message).toBe('Could not tell which war.app account is signed in, so nothing was sent.');
    expect(local.hint).toMatch(/warapp_link_session/);
    expect(local.hint).toMatch(/reload or focus/);
    expect(accountUnknown(true).hint).not.toMatch(/warapp_link_session/);
    expect(accountUnknown(false, 'its games cannot be listed').message).toMatch(/so its games cannot be listed\.$/);
  });

  it('reads the account fresh by default and refuses when it is unknown', async () => {
    const ctx = ctxOf(undefined);
    const e = await refusal(requireMe(ctx));
    expect(e.message).toMatch(/Could not tell which war\.app account is signed in/);
    expect(ctx.reads).toEqual([{ fresh: true }]);
    const known = ctxOf(ME);
    expect(await requireMe(known)).toBe(ME);
    const cached = ctxOf(ME);
    await requireMe(cached, { fresh: false });
    expect(cached.reads).toEqual([{ fresh: false }]);
  });
});

describe('mySeat / requirePlaying / requireMySeat', () => {
  const me = player(ME, 'Ann');
  const bob = player(5512345699, 'Bob');

  it('finds the seat, else refuses with one wording', async () => {
    expect(mySeat(game([bob, me]), ME)).toBe(me);
    const e = await refusal(() => mySeat(game([bob]), ME));
    expect(e.message).toBe('The signed-in war.app account is not a player in game 4001, so nothing was sent.');
  });

  it('refuses a seat that is no longer playing (a missing state included)', async () => {
    requirePlaying(game([me]), me);
    expect((await refusal(() => requirePlaying(game([]), player(ME, 'Ann', 'Booted')))).message).toBe(
      'You are no longer playing in game 4001 (your state: Booted).',
    );
    const stateless = { id: ME, name: 'Ann' } as Player;
    expect((await refusal(() => requirePlaying(game([]), stateless))).message).toMatch(/your state: unknown/);
  });

  it('checks the account, then a named player, then the seat, then that it is playing', async () => {
    expect((await refusal(requireMySeat(ctxOf(undefined), game([me]), { player: 'Ann' }))).message).toMatch(/Could not tell/);
    // A named player who is not the signed-in account is refused even when the account holds no seat.
    const named = await refusal(requireMySeat(ctxOf(ME), game([bob]), { player: 'Bob' }));
    expect(named.message).toBe(
      '⟦Bob⟧ is not the signed-in war.app account, so nothing was sent: writes always act as the signed-in account.',
    );
    expect((await refusal(requireMySeat(ctxOf(ME), game([bob])))).message).toMatch(/not a player in game 4001/);
    const out = player(ME, 'Ann', 'Eliminated');
    expect((await refusal(requireMySeat(ctxOf(ME), game([out])))).message).toMatch(/no longer playing.*Eliminated/);
    expect(await requireMySeat(ctxOf(ME), game([out]), { playing: false })).toBe(out);
    expect(await requireMySeat(ctxOf(ME), game([bob, me]), { player: 'Ann' })).toBe(me);
    expect(await requireMySeat(ctxOf(ME), game([bob, me]), { player: '  ' })).toBe(me);
  });
});

describe('sendAndVerify: send, classify the failure, read back', () => {
  type R = { outcome: string; status: string; detail?: string };
  const spec = (over: Partial<SendAndVerify<number, R, R, R>> = {}): SendAndVerify<number, R, R, R> => ({
    send: async () => {},
    unanswered: (failure: string): R => ({ outcome: 'unknown', status: 'unknown', detail: failure }),
    readBack: async () => 7,
    unreadable: (failure: string): R => ({ outcome: 'unconfirmed', status: 'unconfirmed', detail: failure }),
    classify: (after: number): R => ({ outcome: 'confirmed', status: 'done', detail: String(after) }),
    ...over,
  });

  it('classifies what is read back after a send', async () => {
    expect(await sendAndVerify(spec())).toEqual({ outcome: 'confirmed', status: 'done', detail: '7' });
  });

  it('war.app not answering is `unknown`, and nothing is read back', async () => {
    let read = false;
    const r = await sendAndVerify(
      spec({
        send: async () => {
          throw new Error('timed out');
        },
        readBack: async () => {
          read = true;
          return 1;
        },
      }),
    );
    expect(r).toEqual({ outcome: 'unknown', status: 'unknown', detail: 'timed out' });
    expect(read).toBe(false);
  });

  it("a refusal is rethrown (nothing changed), through the tool's own wording when it has one", async () => {
    const refused = new WarappServerError(99, 'nope');
    await expect(sendAndVerify(spec({ send: async () => Promise.reject(refused) }))).rejects.toBe(refused);
    await expect(
      sendAndVerify(spec({ send: async () => Promise.reject(refused), refused: () => new Error('worded') })),
    ).rejects.toThrow('worded');
  });

  it('a refusal the tool ignores carries on to the read-back, which is told of it', async () => {
    const ignored = new WarappServerError(4, 'ignored');
    const r = await sendAndVerify(
      spec({
        send: async () => Promise.reject(ignored),
        refused: () => 'ignore',
        classify: (after, e) => ({ outcome: 'confirmed', status: 'done', detail: `${after} ${e?.code}` }),
      }),
    );
    expect(r.detail).toBe('7 4');
  });

  it('a failed read-back is `unconfirmed`, with the failure text', async () => {
    const r = await sendAndVerify(spec({ readBack: async () => Promise.reject(new Error('feed down')) }));
    expect(r).toEqual({ outcome: 'unconfirmed', status: 'unconfirmed', detail: 'feed down' });
  });
});
