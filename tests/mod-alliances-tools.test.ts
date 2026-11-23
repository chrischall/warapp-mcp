// The Diplomacy 2 mod's alliances (mod 191) in the turn and diplomacy tools: a synthetic game that runs the
// mod, its details (GameRefresh) carrying the mod's public data (an alliance of Ann and Bob) and Ann's own.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame, Writer } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { DIPLOMACY2_MOD_ID } from '../src/mod-alliances.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';
import { writeGameDetailsAndChat } from './protocol/chat-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
const MODS = [{ ModID: '336', Name: 'Local Deployment Helper' }, { ModID: String(DIPLOMACY2_MOD_ID), Name: 'Diplomacy 2' }];

function game(mods: unknown[] = MODS, state = 'Playing'): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return { ...f, state, numberOfTurns: '2', players, settings: { ...(f.settings as Record<string, unknown>), Mods: mods } };
}

// 158 Bolton Moors (Bob's) borders Ann's 159 and 161.
const BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

const arr = (key: string, rows: Record<string, number | string>[]) =>
  `<e k="s|${key}"><v>${rows
    .map((r, i) => `<e k="d|${i + 1}.0"><v>${Object.entries(r).map(([k, v]) => `<e k="s|${k}" v="${typeof v === 'number' ? `d|${v}.0` : `s|${v}`}" />`).join('')}</v></e>`)
    .join('')}</v></e>`;
const doc = (...e: string[]) => `<?xml version="1.0" encoding="UTF-8"?> <m>${e.join('')}</m>`;
const ALLIED = doc('<e k="s|Identity" v="d|3.0" />', arr('Alliances', [{ ID: 2, PlayerOne: BOB.inGame, PlayerTwo: ANN.inGame }]));

let refreshes = 0;
const details = (pub: string | null, mine: string | null = null) => (req: DecodedRequest) => {
  const r = req.body;
  expect([r.int32(), r.bool(), r.bool()]).toEqual([GAME, false, true]);
  refreshes++;
  return {
    body: (w: Writer) =>
      writeGameDetailsAndChat(w, null, null, {
        public: pub === null ? null : new Map([[DIPLOMACY2_MOD_ID, pub]]),
        mine: mine === null ? null : new Map([[DIPLOMACY2_MOD_ID, mine]]),
      }),
  } satisfies Partial<ReplyFrame>;
};
type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;
const routes = (r: Routes) => (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
  const f = r[req.method];
  if (!f) throw new Error(`unexpected method ${req.method}`);
  return f(req, n);
};
const board = () => ({ body: (w: Writer) => writeLatestGameInfo(w, BOARD, [ANN.inGame]) }) satisfies Partial<ReplyFrame>;
const harness = (pub: string | null, opts: { mods?: unknown[]; mine?: string | null } = {}) => {
  refreshes = 0;
  return liveHarness({
    feed: [game(opts.mods)],
    pages: ME_PAGE,
    warapp: routes({ [Method.GetLatestGameInfo]: board, [Method.GameRefresh]: details(pub, opts.mine ?? null) }),
  });
};

interface Plan {
  moves: Array<{ kind: string; to: { id: number } }>;
  relations?: Array<Record<string, unknown> & { player: { id: number } }>;
  modAlliances?: { read: boolean; allies: Array<{ id: number }> | null };
  rationale: string[];
  warnings: string[];
}

describe('warapp_plan_turn: a Diplomacy 2 alliance is an enforced truce (T9)', () => {
  it('never plans an attack on the ally and counts it for next turn only', async () => {
    h = await harness(ALLIED);
    const p = payload<Plan>(await h.call('warapp_plan_turn', { game_id: GAME, view: 'full' }));
    expect(p.relations).toEqual([
      expect.objectContaining({ player: expect.objectContaining({ id: Number(BOB.feed) }), mod: 'Diplomacy 2', enforced: true, enforcedUntil: 4, honoured: true }),
    ]);
    expect(p.moves.filter((m) => m.kind === 'attack').map((m) => m.to.id)).not.toContain(158);
    expect(p.modAlliances).toMatchObject({ read: true, allies: [expect.objectContaining({ id: Number(BOB.feed) })] });
    expect(p.rationale.join('\n')).toMatch(/Diplomacy 2 alliance with player 7176543229: the Diplomacy 2 mod's alliance is in effect, so the game skips every attack/);
  });

  it('honours nothing and says so when the details cannot be read', async () => {
    h = await harness('garbage');
    const p = payload<Plan>(await h.call('warapp_plan_turn', { game_id: GAME }));
    expect(p.relations).toBeUndefined();
    expect(p.modAlliances).toMatchObject({ read: false, allies: null });
    expect(p.warnings.join('\n')).toMatch(/runs the Diplomacy 2 mod, but its alliances could not be read/);
  });

  it('a game without the mod reads no mod data and plans as before', async () => {
    h = await harness(ALLIED, { mods: [] });
    const p = payload<Plan>(await h.call('warapp_get_relations', { game_id: GAME }));
    expect(p).not.toHaveProperty('modAlliances');
    expect(refreshes).toBe(0);
  });
});

describe('warapp_check_plan and warapp_submit_turn on an attack on an ally', () => {
  const ATTACK = [{ kind: 'deploy', territory: 159, armies: 5 }, { kind: 'move', from: 159, to: 158, armies: 10 }];

  it('check_plan warns that the game skips it', async () => {
    h = await harness(ALLIED);
    const p = payload<{ warnings: string[] }>(await h.call('warapp_check_plan', { game_id: GAME, orders: ATTACK }));
    expect(p.warnings.join('\n')).toMatch(/These orders attack a Diplomacy 2 ally — move 1 attacks Bolton Moors from Hornwood, held by player 7176543229 .*the game skips each such attack/);
  });

  it('submit_turn refuses it, sending nothing, unless attack_ally is true', async () => {
    h = await harness(ALLIED);
    const refused = await h.call('warapp_submit_turn', { game_id: GAME, orders: ATTACK });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/These orders attack a Diplomacy 2 ally: move 1 attacks 158 from 159, held by player 7176543229 .*Nothing was sent/);
    expect(textOf(refused)).toMatch(/attack_ally: true/);
    const preview = payload<{ preview: { warnings?: string[] }; confirmToken?: string }>(
      await h.call('warapp_submit_turn', { game_id: GAME, orders: ATTACK, attack_ally: true }),
    );
    expect(preview.confirmToken).toEqual(expect.any(String));
    expect(preview.preview.warnings?.join('\n')).toMatch(/attack_ally is true: move 1 attacks 158 from 159/);
  });

  it('an attack on a player with no alliance is not refused', async () => {
    h = await harness(doc());
    const preview = payload<{ confirmToken?: string }>(await h.call('warapp_submit_turn', { game_id: GAME, orders: ATTACK }));
    expect(preview.confirmToken).toEqual(expect.any(String));
  });
});

describe('warapp_get_relations and warapp_get_mod_alliances', () => {
  it('get_relations shows the alliance (source mod), flags it mod-only, and a break alert as a notice', async () => {
    const mine = doc(arr('Alerts', [{ ID: 3, Message: 'Somebody has broken their alliance with you' }]));
    h = await harness(ALLIED, { mine });
    const p = payload<{ agreements: unknown[]; modAlliances: Record<string, unknown> }>(await h.call('warapp_get_relations', { game_id: GAME }));
    expect(p.modAlliances).toMatchObject({
      source: 'mod',
      read: true,
      alliances: [{ source: 'mod', player: expect.objectContaining({ id: Number(BOB.feed) }), proposedBy: 'them', id: 2 }],
      mismatches: [{ player: expect.objectContaining({ id: Number(BOB.feed) }), kind: 'mod-only' }],
      notices: [{ id: 3, message: expect.stringContaining('has broken their alliance with you') }],
    });
  });

  it('get_relations flags a recorded truce the mod does not enforce (ledger-only)', async () => {
    h = await harness(doc());
    payload(await h.call('warapp_record_agreement', { game_id: GAME, player: 'Ann', with: 'Bob', status: 'agreed' }));
    const p = payload<{ agreements: Array<{ source: string }>; modAlliances: { mismatches: unknown[] } }>(await h.call('warapp_get_relations', { game_id: GAME }));
    expect(p.agreements[0]!.source).toBe('ledger');
    expect(p.modAlliances.mismatches).toEqual([expect.objectContaining({ kind: 'ledger-only', agreement: 'a1' })]);
  });

  it('get_mod_alliances lists each pair and a proposal to me (a break order of mine: tests/mod-alliances.test.ts)', async () => {
    const mine = doc(arr('PendingProposals', [{ ID: 4, PlayerOne: 1004, PlayerTwo: ANN.inGame }]));
    h = await harness(ALLIED, { mine });
    const res = await h.call('warapp_get_mod_alliances', { game_id: GAME });
    expect(res.isError, textOf(res)).toBeFalsy();
    const p = payload<{ alliances: Array<Record<string, unknown>>; allies: Array<{ id: number }>; modDiplomacy: string }>(res);
    expect(p.alliances[0]).toMatchObject({ state: 'allied', id: 2, proposer: { id: Number(BOB.feed), inGameId: BOB.inGame } });
    expect(p.alliances[1]).toMatchObject({ state: 'pending', id: 4, proposer: { inGameId: 1004 } });
    expect(p.allies).toEqual([expect.objectContaining({ id: Number(BOB.feed) })]);
    expect(p.modDiplomacy).toMatch(/manual only/);
  });

  it('advise_diplomacy shows the alliance beside the ledger', async () => {
    h = await harness(ALLIED);
    const res = await h.call('warapp_advise_diplomacy', { game_id: GAME });
    expect(res.isError, textOf(res)).toBeFalsy();
    const p = payload<{ modAlliances: Record<string, unknown> }>(res);
    expect(p.modAlliances).toMatchObject({ source: 'mod', read: true, alliances: [expect.objectContaining({ proposedBy: 'them' })] });
  });

  it('get_mod_alliances refuses a game without the mod', async () => {
    h = await harness(ALLIED, { mods: [] });
    const res = await h.call('warapp_get_mod_alliances', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/does not run the Diplomacy 2 mod/);
  });
});
