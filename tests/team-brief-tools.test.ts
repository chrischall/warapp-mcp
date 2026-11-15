// warapp_team_brief (C4, docs/PLAN-TEAMS.md): the facts for a team-chat message, by stage, as data — never sent.
// Read-only; refuses outside a team game. Every id is synthetic.
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { normalizeMap } from '../src/normalize.js';
import { writePickList } from '../src/pick-list.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { untrustedText } from '../src/tools/common.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticCard, type SyntheticTeammateOrders, type SyntheticTerritory } from './protocol/live-bundle.js';
import { writeMyGamesReturn } from './protocol/my-games-bundle.js';

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
const RF = '0123456789abcdef0123456789abcdef';

/** Ann (me) and Bob on team 0 with an AI seat; Cy on team 1. `teams: false` sends no team at all. */
function game(state: string, opts: { teams?: boolean; turns?: string; extra?: Record<string, unknown> } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const team = (t: string) => (opts.teams === false ? {} : { team: t });
  const base = { isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Playing' };
  const players = [
    { ...base, id: ANN.feed, name: 'Ann', ...team('0') },
    { ...base, id: BOB.feed, name: 'Bob', hasCommittedOrders: 'True', ...team('0') },
    { ...base, id: '1002', name: 'AI 2', isAI: 'True', ...team('0') },
    { ...base, id: CY.feed, name: 'Cy‮', ...team('1') },
  ];
  const settings = { ...(f.settings as Record<string, unknown>), SanctionsCard: 'none', MoveOrder: 'Cycle' };
  return { ...f, id: String(GAME), state, numberOfTurns: opts.turns ?? (state === 'Playing' ? '2' : '-1'), players, settings, ...opts.extra };
}

// Fixture map: 159 Hornwood – 161 – 157 form bonus 118 (+2); 158 borders 159/161/157; 135 borders 159 and 158.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];
const PICK_BOARD: SyntheticTerritory[] = BOARD.map((t) => (t.fogged ? t : { ...t, owner: -2, fogLevel: 2 }));
// Cy holds Knife Hills (135) with 25, beside my Hornwood (50) and Bob's Bolton Moors (20).
const CONTESTED: SyntheticTerritory[] = BOARD.map((t) =>
  t.id === 135 ? { id: 135, fogLevel: 1, owner: CY.inGame, armies: 25 } : t.id === 159 ? { ...t, armies: 50 } : t.id === 158 ? { ...t, armies: 20 } : t,
);

type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;
const routes = (r: Routes) => (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
  const f = r[req.method];
  if (!f) throw new Error(`unexpected method ${req.method}`);
  return f(req, n);
};
const latest =
  (board: SyntheticTerritory[], hands: Record<number, SyntheticCard[]> = {}, mates?: Record<number, SyntheticTeammateOrders>) =>
  () => ({ body: (w: Parameters<typeof writeLatestGameInfo>[0]) => writeLatestGameInfo(w, board, [ANN.inGame, BOB.inGame], hands, mates) });

const bob = { id: Number(BOB.feed), name: untrustedText('Bob') };
const cy = { id: Number(CY.feed), name: untrustedText('Cy‮') };

interface BriefPayload {
  game: { id: number; state: string; turn: number | null };
  team: { id: number; source: string };
  me: { id: number; name: string };
  teammates: Array<{ id: number; name: string | null; kind: string; committed: boolean }>;
  stage: 'picks' | 'turn';
  picks?: Record<string, unknown>;
  opponents?: Array<{ player: { id: number; name: string | null }; estimate: number | null; source: string | null; basis: string }>;
  income?: number;
  deploys?: unknown[];
  attacks?: Array<{ from: unknown; to: unknown; armies: number }>;
  asks?: unknown[];
  offers?: unknown[];
  cards?: { play: unknown[]; discard: unknown[]; leftToTeammates: unknown[] };
  conflicts?: { read: unknown[] | null; list: Array<Record<string, unknown>>; note: string };
  notes: string[];
  untrusted_content?: boolean;
}

describe('warapp_team_brief', () => {
  it('is read-only', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_team_brief')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
  });

  it('refuses outside a team game', async () => {
    h = await liveHarness({
      feed: [game('Playing', { teams: false })],
      pages: ME_PAGE,
      warapp: routes({ [Method.GetMyGames]: () => ({ body: (w) => writeMyGamesReturn(w, []) }) }),
    });
    const res = await h.call('warapp_team_brief', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not a team game/);
  });

  it('refuses a lobby or a finished game, reading no board', async () => {
    h = await liveHarness({ feed: [game('WaitingForPlayers')], pages: ME_PAGE, warapp: routes({}) });
    const res = await h.call('warapp_team_brief', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not being picked or played/);
  });

  it('while picking: my list, each teammate\'s, the overlap and the bonuses we both pick into', async () => {
    h = await liveHarness({
      feed: [game('DistributingTerritories')],
      pages: ME_PAGE,
      warapp: routes({
        [Method.GetLatestGameInfo]: latest(PICK_BOARD, {}, { [BOB.inGame]: { picks: [157, 135] } }),
        [Method.GetTerritoryPicks]: (req) => {
          req.body.int32();
          const id = req.body.int32();
          if (id === ANN.inGame) return { body: (w) => w.bool(true).list([159, 157], (ww, n) => ww.int32(n)) };
          return { error: { code: 4, message: 'no' } };
        },
      }),
    });
    const p = payload<BriefPayload>(await h.call('warapp_team_brief', { game_id: GAME }));
    expect(p.untrusted_content).toBe(true);
    expect(p.stage).toBe('picks');
    expect(p.team).toEqual({ id: 0, source: 'gamefeed' });
    expect(p.picks).toMatchObject({
      mine: [T(159), T(157)],
      teammates: [
        { player: bob, list: [T(157), T(135)], source: 'teammate-orders' },
        // The AI seat has no in-game id: its list is unknown.
        { player: { id: 1002, name: untrustedText('AI 2') }, list: null, source: null },
      ],
      overlap: [{ territory: T(157), mine: 2, teammate: bob, theirs: 1 }],
    });
    // Bonus 118 (159, 161, 157): both of us pick into it.
    expect(p.picks!.sharedBonuses).toContainEqual(
      expect.objectContaining({ bonus: expect.objectContaining({ id: 118 }), mine: [T(157), T(159)], teammate: bob, theirs: [T(157)] }),
    );
    expect(p.notes.join('\n')).toMatch(/never sent.*channel: "team"/s);
  });

  it('each turn: incomes and their basis, deploys and attacks, the ask, the offer, the cards and the conflicts', async () => {
    h = await liveHarness({
      feed: [game('Playing')],
      pages: ME_PAGE,
      warapp: routes({
        [Method.GetLatestGameInfo]: latest(CONTESTED, { [ANN.inGame]: [{ id: RF, type: 1, armies: 5 }] }, {
          [BOB.inGame]: {
            orders: [
              { kind: 'move', from: 158, to: 135, armies: 19 },
              { kind: 'card', tag: 5, card: RF },
            ],
          },
        }),
      }),
    });
    const res = await h.call('warapp_team_brief', { game_id: GAME });
    const p = payload<BriefPayload>(res);
    expect(p.stage).toBe('turn');
    expect(p.teammates.map((t) => [t.id, t.kind, t.committed])).toEqual([
      [Number(BOB.feed), 'human', true],
      [1002, 'ai', false],
    ]);
    // Cy, the one opponent, with the figure the plan works from and why.
    expect(p.opponents).toEqual([{ player: cy, estimate: expect.any(Number), source: expect.any(String), basis: expect.any(String) }]);
    expect(p.opponents![0]!.basis).toMatch(/base \d+ \+ visibly held bonuses \d+|tracked|observed|prior|exact/);
    expect(textOf(res)).not.toMatch(/‮/);
    expect(p.deploys!.length).toBeGreaterThan(0);
    // The ask: keep the joint attack on Knife Hills (either order takes it under the cycle).
    expect(p.asks).toContainEqual({ kind: 'joint-capture', target: T(135), teammates: [bob], mustGoFirst: 'either' });
    // The offer: Bolton Moors falls once Bob's attack leaves; my idle 20 on Hornwood would hold it.
    expect(p.offers).toEqual([{ territory: T(158), teammate: bob, threat: 34, from: cy, need: 20, mine: [{ territory: T(159), armies: 20 }] }]);
    // Bob has entered my Reinforcement card: it is left to him.
    expect(p.cards).toEqual({ play: [], discard: [], leftToTeammates: [{ id: RF, type: 'Reinforcement', armies: 5, teammate: bob, kind: 'play' }] });
    expect(p.conflicts?.read).toEqual([bob]);
    // Nothing was sent.
    expect(h.exchanges.map((e) => e.path)).not.toContainEqual(expect.stringMatching(/Send/));
  });

  it('a target we both attack is a conflict; no teammate orders read means conflicts unknown (null)', async () => {
    // My plan takes Widow's Watch (157) to complete bonus 118; Bob has entered an attack on it too.
    const both = latest(BOARD, {}, { [BOB.inGame]: { orders: [{ kind: 'move', from: 158, to: 157, armies: 5 }] } });
    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: routes({ [Method.GetLatestGameInfo]: both }) });
    const p = payload<BriefPayload>(await h.call('warapp_team_brief', { game_id: GAME }));
    expect(p.attacks!.map((a) => (a.to as { id: number }).id)).toContain(157);
    expect(p.conflicts?.list).toContainEqual(
      expect.objectContaining({ kind: 'same-target', territory: T(157), teammate: bob, theirs: 5, joint: false }),
    );
    await h.harness.close();

    h = await liveHarness({ feed: [game('Playing')], pages: ME_PAGE, warapp: routes({ [Method.GetLatestGameInfo]: latest(BOARD) }) });
    const q = payload<BriefPayload>(await h.call('warapp_team_brief', { game_id: GAME }));
    expect(q.conflicts?.read).toBeNull();
    expect(q.conflicts?.list).toEqual([]);
  });

  it('turn 1: the picks my kept list lost, and to whom; it writes nothing (no award, no board cache)', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'warapp-brief-'));
    // My list: 158 first (Bob's start), then 159 and 161 (granted).
    await writePickList(dataDir, GAME, Number(ANN.feed), [158, 159, 161]);
    h = await liveHarness({
      dataDir,
      feed: [game('Playing', { turns: '0' })],
      pages: ME_PAGE,
      warapp: routes({ [Method.GetLatestGameInfo]: latest(BOARD) }),
    });
    const p = payload<BriefPayload>(await h.call('warapp_team_brief', { game_id: GAME }));
    expect(p.game.turn).toBe(1);
    expect(p.picks).toMatchObject({ granted: [T(159), T(161)], lost: [{ territory: T(158), rank: 1, by: 'teammate' }] });
    expect(existsSync(join(dataDir, 'boards'))).toBe(false);
    const { readPickRecord } = await import('../src/pick-list.js');
    expect((await readPickRecord(dataDir, GAME, Number(ANN.feed)))?.award).toBeUndefined();
  });

  it('turn 1 with no list kept says so', async () => {
    h = await liveHarness({ feed: [game('Playing', { turns: '0' })], pages: ME_PAGE, warapp: routes({ [Method.GetLatestGameInfo]: latest(BOARD) }) });
    const p = payload<BriefPayload>(await h.call('warapp_team_brief', { game_id: GAME }));
    expect(p.picks).toMatchObject({ lost: null, note: expect.stringMatching(/No pick list/) });
  });
});
