// #505 through the tools: on turns 1–4 (or while #319 fires) warapp_submit_turn's preview and warapp_check_plan
// say when the given orders drop the default plan's capture toward the nearest bonus and so finish it later.
// Advice only: the preview still offers its token. Synthetic board on the anonymized lobby fixture's map.
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
  return { ...f, state: 'Playing', numberOfTurns: '1', players, settings: { ...(f.settings as object), SanctionsCard: 'none', AirliftCard: 'none' } };
}

// Bonus 118 is 159, 161 and 157: I hold two, 157 is a neutral 2. Bob is far off (fogged).
const board: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  { id: 157, fogLevel: 1, owner: 0, armies: 2 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

async function live(): Promise<Harness> {
  return liveHarness({
    feed: [game()],
    pages: { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` },
    warapp: (req: DecodedRequest): Partial<ReplyFrame> => {
      if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, board, [ANN.inGame]) };
      throw new Error(`unexpected method ${req.method}`);
    },
  });
}

const DELAY = /These orders finish bonus .+ on turn \d+ instead of turn \d+ \(#505\)/;

describe('orders that delay the nearest bonus (#505)', () => {
  it('warn in warapp_check_plan and the warapp_submit_turn preview, never for the plan\'s own orders, and never refuse', async () => {
    h = await live();
    const p = payload<{ orders: Array<{ kind: string; territory?: number; armies?: number; from?: number; to?: number }> }>(
      await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }),
    );
    expect(p.orders.some((o) => o.kind === 'move' && o.to === 157)).toBe(true);
    const income = p.orders.filter((o) => o.kind === 'deploy').reduce((n, o) => n + (o.armies ?? 0), 0);
    const edit = [{ kind: 'deploy', territory: 159, armies: income }];
    const check = payload<{ warnings: string[]; bonusDelay?: { dropped: { id: number }[]; plannedTurn: number; givenTurn: number } }>(
      await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: edit }),
    );
    expect(check.warnings.some((w) => DELAY.test(w))).toBe(true);
    expect(check.bonusDelay!.dropped.map((t) => t.id)).toEqual([157]);
    expect(check.bonusDelay!.givenTurn).toBeGreaterThan(check.bonusDelay!.plannedTurn);
    const preview = JSON.stringify(payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: edit })));
    expect(preview).toMatch(DELAY);
    expect(preview).toMatch(/confirmToken/);
    const same = JSON.stringify(payload(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: p.orders })));
    expect(same).not.toMatch(DELAY);
  });
});
