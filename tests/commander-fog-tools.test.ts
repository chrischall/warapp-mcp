// Part 5 of the mega-game spec: my commander against unknown opponents in the fog striking it together —
// warapp_check_plan's `fogged_attackers` and warapp_plan_turn's default in a big free-for-all. Synthetic
// board (ids only); the mega game's own settings from its name-free fixture.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeGame } from '../src/normalize.js';
import { foggedAttackersFor } from '../src/tools/turn.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticCard, type SyntheticTerritory } from './protocol/live-bundle.js';

// Fixture map: 159 Hornwood – 161 Sheepshead Hills – 157 Widow's Watch form bonus 118 (+2);
// 158 Bolton Moors borders all three. Ann holds the bonus: income 7. Bob's estimate is 5.
const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const CID = { feed: '5524681399', inGame: 246813 };
const DAN = { feed: '4413579288', inGame: 135792 };
const ANN_CMDR = '0123456789abcdef0123456789abcdef';
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

/** My commander on 159 behind 6; Bob's 16 beside it. 16 + 5 − 1 = 20 attackers kill 12 (it survives); 16 + 7 − 1 = 22 kill 13 (it falls). */
const BOARD = (withUnit = true): SyntheticTerritory[] => [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6, ...(withUnit ? { units: [{ kind: 'commander' as const, id: ANN_CMDR, owner: ANN.inGame }] } : {}) },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 16 },
];

function feedGame(
  settings: Record<string, unknown>,
  extra: Record<string, unknown> = {},
  opts: { ffa?: boolean; cidState?: string } = {},
): Record<string, unknown> {
  const f = lobbyFixture();
  // With `ffa`, a free-for-all: Ann, Bob and Cid playing, and Dan out (eliminated), on a custom scenario
  // (DistributionMode -3), so no fog prior lifts Bob's and Cid's estimates to my income (#235; since #368
  // a player out no longer turns the prior off): I lead, 7 against base 5 each.
  const all = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0
      ? { ...p, id: ANN.feed, name: 'Ann' }
      : i === 1
        ? { ...p, id: BOB.feed, name: 'Bob' }
        : i === 2 && opts.ffa
          ? { ...p, id: CID.feed, name: 'Cid', ...(opts.cidState ? { state: opts.cidState } : {}) }
          : i === 3 && opts.ffa
            ? { ...p, id: DAN.feed, name: 'Dan', state: 'Eliminated' }
            : p,
  );
  const players = opts.ffa ? all.slice(0, 4) : all;
  return { ...f, state: 'Playing', numberOfTurns: '2', players, settings: { ...(f.settings as Record<string, unknown>), SanctionsCard: 'none', ...(opts.ffa ? { DistributionMode: '-3' } : {}), ...settings }, ...extra };
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

function server(board: SyntheticTerritory[], opts: { ffa?: boolean; hand?: SyntheticCard[] } = {}) {
  const sent: Uint8Array[] = [];
  const ids = opts.ffa ? [ANN.inGame, BOB.inGame, CID.inGame] : [ANN.inGame, BOB.inGame];
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo)
      return { body: (w) => writeLatestGameInfo(w, board, ids, opts.hand ? { [ANN.inGame]: opts.hand } : {}) };
    if (req.method === Method.SendOrders) {
      sent.push(req.body.raw(req.body.remaining));
      return { body: (w) => w.bool(true).bool(false) };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { sent, warapp };
}

const CMD = { Commanders: true };
/**
 * A three-player free-for-all I lead (my 7 against base 5 each): my commander on 159 behind 6, Bob's 12
 * on 158 and Cid's 12 on 135, both beside it. Alone (18 attackers kill 11) neither takes 6 + 7 + my 7;
 * together (11 + 11) they do.
 */
const FFA_BOARD: SyntheticTerritory[] = [
  ...BOARD(),
  { id: 135, fogLevel: 1, owner: CID.inGame, armies: 12 },
].map((t) => (t.id === 158 ? { ...t, armies: 12 } : t));
const AWAY = [{ kind: 'deploy', territory: 161, armies: 7 }];
const HOME = [{ kind: 'deploy', territory: 159, armies: 7 }];


type Fogged = { safe: boolean; needs: number; attackers: number; stack: number; deploy: number; text: string };
type Report = { summary: string; safe: boolean | null; commander?: { fogged?: Fogged } };

describe('warapp_check_plan fogged_attackers (part 5)', () => {
  it('tests the commander against two fogged neighbours striking together by default', async () => {
    const s = server(BOARD());
    h = await liveHarness({ feed: [feedGame(CMD)], pages: ME_PAGE, warapp: s.warapp });
    const r = payload<Report>(await h.call('warapp_check_plan', { game_id: GAME, orders: HOME }));
    expect(r.commander?.fogged).toMatchObject({ attackers: 2, safe: true });
    expect(r.summary).not.toMatch(/unknown opponent/);
  });

  it('names a commander the fog can take in the summary, never changing `safe`', async () => {
    const s = server(BOARD());
    h = await liveHarness({ feed: [feedGame(CMD), feedGame(CMD)], pages: ME_PAGE, warapp: s.warapp });
    const two = payload<Report>(await h.call('warapp_check_plan', { game_id: GAME, orders: AWAY, fogged_attackers: 2 }));
    const fogged = two.commander!.fogged!;
    expect(fogged.safe).toBe(false);
    expect(fogged.needs).toBeGreaterThan(6);
    expect(two.summary).toMatch(/could fall to 2 unknown opponents the fog may hide within two moves/);
    const none = payload<Report>(await h.call('warapp_check_plan', { game_id: GAME, orders: AWAY, fogged_attackers: 0 }));
    expect(none.commander?.fogged).toBeUndefined();
    expect(none.safe).toBe(two.safe);
  });
});

describe('warapp_plan_turn fogged_attackers (part 5)', () => {
  it('is off by default in a small free-for-all, and on when asked', async () => {
    const s = server(FFA_BOARD, { ffa: true });
    const ffa = () => feedGame(CMD, {}, { ffa: true });
    h = await liveHarness({ feed: [ffa(), ffa()], pages: ME_PAGE, warapp: s.warapp });
    const off = payload<{ commander: { fogged?: Fogged } }>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(off.commander.fogged).toBeUndefined();
    const on = payload<{ commander: { fogged?: Fogged } }>(await h.call('warapp_plan_turn', { game_id: GAME, fogged_attackers: 2 }));
    expect(on.commander.fogged).toMatchObject({ attackers: 2 });
  });

  it('is on by default in a free-for-all of eight or more players', async () => {
    const s = server(BOARD());
    h = await liveHarness({ feed: [feedGame(CMD)], pages: ME_PAGE, warapp: s.warapp });
    const on = payload<{ commander: { fogged?: Fogged } }>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(on.commander.fogged).toMatchObject({ attackers: 2 });
  });
});

describe('foggedAttackersFor (the mega game, 45736172)', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/gamefeed-settings-45736172.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  const game = normalizeGame({ ...raw, state: 'Playing' });
  const board = { source: 'gamefeed' as const, verified: true, territories: [{ territoryId: 1, owner: { kind: 'player' as const, playerId: 88200011 }, armies: 265 }] };

  it("holds my commander against two hidden starts of the game's 250 armies by default", () => {
    expect(game.players.length).toBe(97);
    expect(foggedAttackersFor(game, board, 88200011)).toEqual({ count: 2, stack: 250 });
    expect(foggedAttackersFor(game, board, 88200011, 3)).toEqual({ count: 3, stack: 250 });
    expect(foggedAttackersFor(game, board, 88200011, 0)).toBeUndefined();
  });

  it('is off without commanders, with teams, without fog or with fewer than eight players playing', () => {
    expect(foggedAttackersFor({ ...game, settings: { ...game.settings!, commanders: false } }, board, 88200011)).toBeUndefined();
    expect(foggedAttackersFor({ ...game, settings: { ...game.settings!, fog: 'NoFog' } }, board, 88200011)).toBeUndefined();
    expect(foggedAttackersFor({ ...game, players: game.players.map((p, i) => ({ ...p, team: i % 2 })) }, board, 88200011)).toBeUndefined();
    expect(foggedAttackersFor({ ...game, players: game.players.slice(0, 7) }, board, 88200011)).toBeUndefined();
    expect(foggedAttackersFor({ ...game, players: game.players.map((p, i) => (i >= 7 ? { ...p, state: 'Eliminated' } : p)) }, board, 88200011)).toBeUndefined();
    // Without a starting army count, as strong as my largest stack.
    const { initialPlayerArmiesPerTerritory: _, ...rest } = game.settings!;
    expect(foggedAttackersFor({ ...game, settings: rest }, board, 88200011)).toEqual({ count: 2, stack: 265 });
  });
});
