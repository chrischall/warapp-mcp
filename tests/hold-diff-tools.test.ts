// #275 pattern 3 through the tools: warapp_submit_turn's preview and warapp_check_plan compare the
// given orders with the default plan (planTurn on the same live board) border by border and name every
// border left below the plan's hold, with the difference. Synthetic board on the anonymized lobby
// fixture's map; no war.app traffic.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };

function game(): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>)
    .map((p, i) => (i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p))
    .slice(0, 2);
  return { ...f, state: 'Playing', numberOfTurns: '2', players, settings: { ...(f.settings as object), SanctionsCard: 'none', AirliftCard: 'none' } };
}

// Bonus 118 (+2) is 159, 161 and 157, all mine; Bob's 3 on 158 border all three. The default plan
// deploys 7 on 157 and attacks Bob from it with 5: 12 stand on 157, 10 on each of the others.
const held: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 10 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 10 },
  { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 10 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 3 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

async function live(): Promise<Harness> {
  return liveHarness({
    feed: [game()],
    pages: { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` },
    warapp: (req: DecodedRequest): Partial<ReplyFrame> => {
      if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, held, [ANN.inGame]) };
      throw new Error(`unexpected method ${req.method}`);
    },
  });
}

const PLAN = [
  { kind: 'deploy', territory: 157, armies: 7 },
  { kind: 'move', from: 157, to: 158, armies: 5 },
];
// The hand edit: the deploy moved to 159 and no attack.
const EDIT = [{ kind: 'deploy', territory: 159, armies: 7 }];

interface Below {
  territory: { id: number; name: string };
  hold: number;
  left: number;
  short: number;
}

describe('given orders against the default plan (#275 pattern 3)', () => {
  it('the plan is the one warapp_plan_turn makes on this board', async () => {
    h = await live();
    const p = payload<{ orders: unknown[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.orders).toEqual(PLAN);
  });

  it('warapp_submit_turn names a border the given orders leave below the plan, with the difference, and still previews', async () => {
    h = await live();
    const text = JSON.stringify(payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: EDIT })));
    expect(text).toMatch(/These orders leave 1 border below the hold the default plan gives it \(#275\): territory 157 with 10 where the plan leaves 12 \(2 short\)/);
    expect(text).toMatch(/confirmToken/);
  });

  it('warapp_submit_turn says nothing of it for the plan\'s own orders', async () => {
    h = await live();
    const text = JSON.stringify(payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: PLAN })));
    expect(text).not.toMatch(/below the hold the default plan/);
  });

  it('warapp_check_plan lists each border below the plan, the largest shortfall first, and an empty list for the plan', async () => {
    h = await live();
    const edit = payload<{ belowPlan: Below[] }>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: EDIT }));
    expect(edit.belowPlan).toEqual([{ territory: { id: 157, name: expect.any(String) }, hold: 12, left: 10, short: 2 }]);
    // Draining 159 too: 9 of its 10 walk to 161.
    const worse = payload<{ belowPlan: Below[] }>(
      await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [...EDIT, { kind: 'move', from: 159, to: 161, armies: 16 }] }),
    );
    expect(worse.belowPlan.map((b) => [b.territory.id, b.hold, b.left, b.short])).toEqual([
      [159, 10, 1, 9],
      [157, 12, 10, 2],
    ]);
    const same = payload<{ belowPlan: Below[] }>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: PLAN }));
    expect(same.belowPlan).toEqual([]);
  });
});
