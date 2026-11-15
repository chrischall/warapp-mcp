// warapp_get_team (C1, docs/PLAN-TEAMS.md): who is on my team, human or AI, committed or not, their visible
// income, the orders or picks they have entered, the team's hand and unread team chat. Read-only; refuses
// outside a team game. GameFeed's team is UNVERIFIED (V1): without it the team comes from GetMyGames.
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeMap } from '../src/normalize.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { untrustedText } from '../src/tools/common.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticCard, type SyntheticTeammateOrders, type SyntheticTerritory } from './protocol/live-bundle.js';
import { writeMyGamesReturn } from './protocol/my-games-bundle.js';
import { writeGameDetailsAndChat } from './protocol/chat-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const CY = { feed: '5522222211', inGame: 222222 };
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
const map = normalizeMap(lobbyFixture().map);
const T = (id: number) => ({ id, name: map.territories.find((t) => t.id === id)!.name });

const OP = 'fedcba9876543210fedcba9876543210';
const RF = '0123456789abcdef0123456789abcdef';

/** Ann and Bob on team 0 with an AI seat; Cy on team 1. `team: false` sends no team at all. */
function game(state: string, opts: { teams?: boolean; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const team = (t: string) => (opts.teams === false ? {} : { team: t });
  const base = { isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Playing' };
  const players = [
    { ...base, id: ANN.feed, name: 'Ann', ...team('0') },
    { ...base, id: BOB.feed, name: 'Bob‮', hasCommittedOrders: 'True', ...team('0') },
    { ...base, id: '1002', name: 'AI 2', isAI: 'True', ...team('0') },
    { ...base, id: CY.feed, name: 'Cy', ...team('1') },
  ];
  return { ...f, id: String(GAME), state, numberOfTurns: state === 'Playing' ? '2' : '-1', players, ...opts.extra };
}

// Ann holds 159 and 161, Bob 158; 157 neutral; 135 fogged.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 2, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];
const PICK_BOARD: SyntheticTerritory[] = BOARD.map((t) => (t.fogged ? t : { ...t, owner: -2, fogLevel: 2 }));

type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;
const routes = (r: Routes) => (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
  const f = r[req.method];
  if (!f) throw new Error(`unexpected method ${req.method}`);
  return f(req, n);
};
const latest =
  (board: SyntheticTerritory[], hands: Record<number, SyntheticCard[]> = {}, mates?: Record<number, SyntheticTeammateOrders>) =>
  () => ({ body: (w: Parameters<typeof writeLatestGameInfo>[0]) => writeLatestGameInfo(w, board, [ANN.inGame, BOB.inGame], hands, mates) });

interface TeamPayload {
  game: { id: number; state: string; turn: number | null };
  team: { id: number; source: string };
  me: { id: number; name: string };
  teammates: Array<{
    id: number;
    name: string;
    kind: string;
    state: string | null;
    committed: boolean;
    visibleIncome: number | null;
    orders: unknown;
    picks: unknown;
  }>;
  opponents: Array<{ id: number; name: string; team: number | null }>;
  hand: unknown;
  chat: unknown;
  notes: string[];
  warnings?: string[];
  untrusted_content?: boolean;
}

describe('warapp_get_team', () => {
  it('is read-only', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_get_team')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('refuses outside a team game (no team from GameFeed nor GetMyGames)', async () => {
    h = await liveHarness({
      feed: [game('Playing', { teams: false })],
      pages: ME_PAGE,
      warapp: routes({
        [Method.GetMyGames]: () => ({ body: (w) => writeMyGamesReturn(w, []) }),
        [Method.GetLatestGameInfo]: latest(BOARD),
      }),
    });
    const res = await h.call('warapp_get_team', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not a team game, or your team there is unknown/);
  });

  it("reads each teammate's kind, commit, visible income and entered orders, and the team's hand", async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      pages: ME_PAGE,
      warapp: routes({
        [Method.GetLatestGameInfo]: latest(BOARD, { [ANN.inGame]: [{ id: OP, type: 4 }], [BOB.inGame]: [{ id: RF, type: 1, armies: 5 }] }, {
          [BOB.inGame]: {
            orders: [
              { kind: 'deploy', territory: 158, armies: 5 },
              { kind: 'move', from: 158, to: 157, armies: 6 },
              { kind: 'card', tag: 5, card: RF },
            ],
          },
        }),
      }),
    });
    const p = payload<TeamPayload>(await h.call('warapp_get_team', { game_id: GAME }));
    expect(p.untrusted_content).toBe(true);
    expect(p.team).toEqual({ id: 0, source: 'gamefeed' });
    expect(p.me).toEqual({ id: Number(ANN.feed), name: untrustedText('Ann') });
    expect(p.teammates).toEqual([
      {
        id: Number(BOB.feed),
        name: untrustedText('Bob‮'),
        kind: 'human',
        state: 'Playing',
        committed: true,
        visibleIncome: expect.any(Number),
        orders: {
          deploys: [{ territory: T(158), armies: 5 }],
          moves: [{ from: T(158), to: T(157), armies: 6, mode: 'attack-transfer' }],
          cards: [{ card: RF, type: 'Reinforcement' }],
        },
        picks: null,
      },
      // An AI seat has no in-game id to read orders by: unknown.
      { id: 1002, name: untrustedText('AI 2'), kind: 'ai', state: 'Playing', committed: false, visibleIncome: null, orders: null, picks: null },
    ]);
    expect(p.teammates[0]!.name).not.toMatch(/‮/);
    expect(p.opponents).toEqual([{ id: Number(CY.feed), name: untrustedText('Cy'), team: 1 }]);
    expect(p.hand).toMatchObject({
      readable: true,
      cards: [
        { id: OP, name: 'Order Priority' },
        { id: RF, name: 'Reinforcement', armies: 5 },
      ],
    });
    expect(p.notes.join('\n')).toMatch(/UNVERIFIED/);
    // Nothing was written: no SendOrders, no picks.
    expect(h.exchanges.map((e) => e.path)).not.toContainEqual(expect.stringMatching(/Send/));
  });

  it('takes the team from GetMyGames when GameFeed sends none (V1)', async () => {
    h = await liveHarness({
      feed: [game('Playing', { teams: false })],
      pages: ME_PAGE,
      warapp: routes({
        [Method.GetMyGames]: () => ({
          body: (w) =>
            writeMyGamesReturn(w, [
              {
                id: GAME,
                name: 'synthetic',
                lastTurn: 1,
                state: 3,
                players: [
                  { id: ANN.inGame, name: 'Ann', state: 2, committed: false, team: 4 },
                  { id: BOB.inGame, name: 'Bob', state: 2, committed: true, team: 4 },
                  { id: CY.inGame, name: 'Cy', state: 2, committed: false, team: 5 },
                ],
              },
            ]),
        }),
        [Method.GetLatestGameInfo]: latest(BOARD),
      }),
    });
    const p = payload<TeamPayload>(await h.call('warapp_get_team', { game_id: GAME }));
    expect(p.team).toEqual({ id: 4, source: 'my-games' });
    expect(p.teammates.map((t) => t.id)).toEqual([Number(BOB.feed)]);
    // No TeammateOrders sent: unknown, not "none entered".
    expect(p.teammates[0]!.orders).toBeNull();
    // The AI seat has no in-game id to match: its team is unknown (null), listed with the others.
    expect(p.opponents).toEqual([
      { id: 1002, name: untrustedText('AI 2'), team: null },
      { id: Number(CY.feed), name: untrustedText('Cy'), team: 5 },
    ]);
  });

  it("reads a teammate's picks from the teammate orders while distributing", async () => {
    h = await liveHarness({
      feed: [game('DistributingTerritories')],
      pages: ME_PAGE,
      warapp: routes({ [Method.GetLatestGameInfo]: latest(PICK_BOARD, {}, { [BOB.inGame]: { picks: [157, 159] } }) }),
    });
    const p = payload<TeamPayload>(await h.call('warapp_get_team', { game_id: GAME }));
    expect(p.teammates[0]!.picks).toEqual({ source: 'teammate-orders', territories: [T(157), T(159)] });
  });

  it('falls back to GetTerritoryPicks with the teammate id (V6); a refusal reads as unknown', async () => {
    const asked: number[] = [];
    h = await liveHarness({
      feed: [game('DistributingTerritories')],
      pages: ME_PAGE,
      warapp: routes({
        [Method.GetLatestGameInfo]: latest(PICK_BOARD),
        [Method.GetTerritoryPicks]: (req) => {
          req.body.int32(); // game id
          const id = req.body.int32();
          asked.push(id);
          if (id === BOB.inGame) return { body: (w) => w.bool(true).list([161], (ww, n) => ww.int32(n)) };
          return { error: { code: 4, message: 'no' } };
        },
      }),
    });
    const p = payload<TeamPayload>(await h.call('warapp_get_team', { game_id: GAME }));
    expect(asked).toEqual([BOB.inGame]);
    expect(p.teammates[0]!.picks).toEqual({ source: 'territory-picks', territories: [T(161)] });
    expect(p.teammates[1]!.picks).toBeNull();
  });

  it('a refused GetTerritoryPicks is unknown, not an error', async () => {
    h = await liveHarness({
      feed: [game('DistributingTerritories')],
      pages: ME_PAGE,
      warapp: routes({
        [Method.GetLatestGameInfo]: latest(PICK_BOARD),
        [Method.GetTerritoryPicks]: () => ({ error: { code: 4, message: 'no' } }),
      }),
    });
    const res = await h.call('warapp_get_team', { game_id: GAME });
    expect(res.isError).toBeFalsy();
    expect(payload<TeamPayload>(res).teammates[0]!.picks).toBeNull();
  });

  it('counts unread team chat from the web chat (no text), mine and other channels left out', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      pages: ME_PAGE,
      warapp: routes({
        [Method.GetLatestGameInfo]: latest(BOARD),
        [Method.GameRefresh]: () => ({
          body: (w) =>
            writeGameDetailsAndChat(w, [
              { id: 1, from: BOB.inGame, text: 'team plan', channel: 0 },
              { id: 2, from: BOB.inGame, text: 'more', channel: 0 },
              { id: 3, from: ANN.inGame, text: 'mine', channel: 0 },
              { id: 4, from: CY.inGame, text: 'public', channel: -1 },
            ]),
        }),
      }),
    });
    const res = await h.call('warapp_get_team', { game_id: GAME });
    const p = payload<TeamPayload>(res);
    expect(p.chat).toEqual({ unreadTeam: 2, source: 'web' });
    expect(textOf(res)).not.toMatch(/team plan/);
  });

  it('a game with no card in play says so (inPlay: false), not "hand unknown"', async () => {
    const settings = Object.fromEntries(
      Object.entries(lobbyFixture().settings as Record<string, unknown>).map(([k, v]) => [k, k.endsWith('Card') ? 'none' : v]),
    );
    h = await liveHarness({
      feed: [game('Playing', { extra: { settings } })],
      pages: ME_PAGE,
      warapp: routes({ [Method.GetLatestGameInfo]: latest(BOARD) }),
    });
    const p = payload<TeamPayload>(await h.call('warapp_get_team', { game_id: GAME }));
    expect(p.hand).toEqual({ inPlay: false });
  });

  it('a lobby has no board: the roster only', async () => {
    h = await liveHarness({ feed: [game('WaitingForPlayers')], pages: ME_PAGE, warapp: routes({}) });
    const p = payload<TeamPayload>(await h.call('warapp_get_team', { game_id: GAME }));
    expect(p.teammates.map((t) => [t.id, t.orders, t.visibleIncome])).toEqual([
      [Number(BOB.feed), null, null],
      [1002, null, null],
    ]);
    expect(p.hand).toBeNull();
  });
});
