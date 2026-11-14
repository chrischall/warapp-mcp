// #165: order options — Transfer Only, Attack Only, percentage orders, the commander and attack
// teammates — each refused unless the game allows it. Synthetic board, ids and GUIDs only.
import { afterEach, describe, expect, it } from 'vitest';
import { checkMoveOptions, type OptionMove } from '../src/tools/order-options.js';
import { Writer, type DecodedRequest, type ReplyFrame } from '../src/protocol/codec.js';
import { AttackTransferMode, Method, writeSendOrdersParams } from '../src/protocol/methods.js';
import { myOrdersOf } from '../src/tools/turn.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';
import type { LiveTerritory } from '../src/live.js';
import { normalizeSettings } from '../src/normalize.js';

const ME = 501;
const MATE = 502;
const FOE = 503;
const CMDR = 'aabbccddeeff00112233445566778899';
const T = (id: number) => ({ id, name: `T${id}` });

const BOARD: LiveTerritory[] = [
  { territoryId: 1, fogLevel: 1, fogged: false, owner: ME, armies: 6, specialUnits: [{ kind: 'commander', id: CMDR, owner: ME }] },
  { territoryId: 2, fogLevel: 1, fogged: false, owner: ME, armies: 3 },
  { territoryId: 3, fogLevel: 2, fogged: false, owner: FOE, armies: 2 },
  { territoryId: 4, fogLevel: 2, fogged: false, owner: MATE, armies: 2 },
  { territoryId: 5, fogLevel: 2, fogged: false, owner: 0, armies: 2 },
];

const ALL_ON = normalizeSettings({ AllowTransferOnly: true, AllowAttackOnly: true, AllowPercentageAttacks: true, Commanders: true, OneArmyStandsGuard: true });
const ALL_OFF = normalizeSettings({ AllowTransferOnly: false, AllowAttackOnly: false, AllowPercentageAttacks: false, Commanders: false });

function check(moves: OptionMove[], settings = ALL_ON, teammates: number[] = [MATE], deployed: Record<number, number> = {}) {
  return checkMoveOptions({
    moves,
    board: BOARD,
    myInGameId: ME,
    settings,
    teammates: new Set(teammates),
    deployedOn: new Map(Object.entries(deployed).map(([k, v]) => [Number(k), v])),
  });
}

describe('checkMoveOptions (#165)', () => {
  it('plain moves pass with nothing to say', () => {
    const r = check([{ from: T(1), to: T(3), armies: 4 }], ALL_OFF, []);
    expect(r.warnings).toEqual([]);
    expect(r.commanders.size).toBe(0);
  });

  it.each([
    ['transfer-only', /Transfer Only.*off in this game.*AllowTransferOnly.*361/s],
    ['attack-only', /Attack Only.*off in this game.*AllowAttackOnly.*362/s],
  ] as const)('refuses %s when the game does not allow it', (mode, msg) => {
    expect(() => check([{ from: T(1), to: T(2), armies: 2, mode }], ALL_OFF)).toThrow(msg);
  });

  it('refuses an option whose setting the feed did not send (unknown is not allowed)', () => {
    expect(() => check([{ from: T(1), to: T(2), armies: 2, mode: 'transfer-only' }], normalizeSettings({}))).toThrow(/Transfer Only/);
  });

  it('Transfer Only onto a territory not mine says it does nothing unless it is mine when it runs', () => {
    const r = check([{ from: T(1), to: T(3), armies: 2, mode: 'transfer-only' }]);
    expect(r.warnings.join('\n')).toMatch(/Transfer Only.*T3.*does nothing unless it is yours/s);
    // Into my own territory: the textbook use, nothing to say beyond the unverified note.
    const own = check([{ from: T(1), to: T(2), armies: 2, mode: 'transfer-only' }]);
    expect(own.warnings.join('\n')).not.toMatch(/does nothing/);
  });

  it('Attack Only onto my own territory says it fires only if that territory has fallen', () => {
    const r = check([{ from: T(1), to: T(2), armies: 2, mode: 'attack-only' }]);
    expect(r.warnings.join('\n')).toMatch(/Attack Only.*T2.*only if it has fallen/s);
  });

  it('every option is flagged unverified until a live commit', () => {
    const r = check([{ from: T(1), to: T(2), armies: 2, mode: 'transfer-only' }]);
    expect(r.warnings.join('\n')).toMatch(/not yet verified/);
  });

  it('percentage orders: allowed by the game, 1–100, and the preview says what that is now', () => {
    expect(() => check([{ from: T(1), to: T(5), armies: 50, percent: true }], ALL_OFF)).toThrow(/percentage.*AllowPercentageAttacks.*360/is);
    expect(() => check([{ from: T(1), to: T(5), armies: 150, percent: true }])).toThrow(/1 to 100/);
    // 6 + 4 deployed, less the guard: 9 can move; 50% is 4 (a half rounds down).
    const r = check([{ from: T(1), to: T(5), armies: 50, percent: true }], ALL_ON, [], { 1: 4 });
    expect(r.estimates.get(0)).toBe(4);
    expect(r.warnings.join('\n')).toMatch(/50% of the armies .*T1.* can move when it runs.*about 4 now/s);
  });

  it('refuses an order of 0 armies unless it takes the commander', () => {
    expect(() => check([{ from: T(2), to: T(5), armies: 0 }])).toThrow(/sends no armies/);
    const r = check([{ from: T(1), to: T(5), armies: 0, commander: true }]);
    expect(r.commanders.get(0)).toEqual({ id: CMDR, owner: ME });
  });

  it('the commander: only in a commander game, only from where it stands, and once', () => {
    expect(() => check([{ from: T(1), to: T(5), armies: 2, commander: true }], ALL_OFF)).toThrow(/no commanders/);
    expect(() => check([{ from: T(2), to: T(5), armies: 2, commander: true }])).toThrow(/commander is not on .*T2.*stands on territory 1/s);
    expect(() =>
      check([
        { from: T(1), to: T(2), armies: 1, commander: true },
        { from: T(2), to: T(5), armies: 1, commander: true },
      ]),
    ).toThrow(/moves once/);
    const r = check([{ from: T(1), to: T(3), armies: 4, commander: true }]);
    expect(r.commanders.get(0)).toEqual({ id: CMDR, owner: ME });
    expect(r.warnings.join('\n')).toMatch(/commander.*eliminated/s);
  });

  it('the commander may go on under Multi-Attack from the territory it took', () => {
    const multi = normalizeSettings({ Commanders: true, MultiAttack: true });
    const r = check(
      [
        { from: T(1), to: T(5), armies: 4, commander: true },
        { from: T(5), to: T(3), armies: 2, commander: true },
      ],
      multi,
    );
    expect([...r.commanders.keys()]).toEqual([0, 1]);
  });

  it("under Multi-Attack, a commander move onto a teammate's land leaves it home, so it cannot go on from there", () => {
    const multi = normalizeSettings({ Commanders: true, MultiAttack: true });
    expect(() =>
      check(
        [
          { from: T(1), to: T(4), armies: 2, commander: true },
          { from: T(4), to: T(3), armies: 1, commander: true },
        ],
        multi,
      ),
    ).toThrow(/commander/);
  });

  it('under Multi-Attack, an Attack Only commander move onto my own territory may not fire, so it cannot go on from there', () => {
    const multi = normalizeSettings({ Commanders: true, MultiAttack: true, AllowAttackOnly: true });
    expect(() =>
      check(
        [
          { from: T(1), to: T(2), armies: 2, commander: true, mode: 'attack-only' },
          { from: T(2), to: T(3), armies: 1, commander: true },
        ],
        multi,
      ),
    ).toThrow(/commander/);
  });

  it("warns that a commander does not move onto a teammate's territory", () => {
    const r = check([{ from: T(1), to: T(4), armies: 2, commander: true }]);
    expect(r.warnings.join('\n')).toMatch(/teammate.*commander stays/s);
  });

  it('refuses no commander of mine on the board', () => {
    const board = BOARD.map((t) => ({ ...t, specialUnits: undefined }));
    expect(() =>
      checkMoveOptions({ moves: [{ from: T(1), to: T(5), armies: 2, commander: true }], board, myInGameId: ME, settings: ALL_ON, teammates: new Set(), deployedOn: new Map() }),
    ).toThrow(/No commander of yours/);
  });

  it('attack teammates: refused with no teammate in the game, noted when the target is not a teammate', () => {
    expect(() => check([{ from: T(1), to: T(4), armies: 2, attackTeammates: true }], ALL_ON, [])).toThrow(/no teammates/);
    const ok = check([{ from: T(1), to: T(4), armies: 2, attackTeammates: true }]);
    expect(ok.warnings.join('\n')).not.toMatch(/is not a teammate/);
    const odd = check([{ from: T(1), to: T(3), armies: 2, attackTeammates: true }]);
    expect(odd.warnings.join('\n')).toMatch(/T3.*not a teammate's/s);
  });
});

// ---- through warapp_submit_turn ----
// Fixture map: 159 Hornwood – 161 Sheepshead Hills – 157 Widow's Watch; 158 Bolton Moors borders
// all three. Ann (synthetic) holds 159 (6, with her commander) and 161 (3); income 5.
const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const ANN_CMDR = '0123456789abcdef0123456789abcdef';
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
const SYN_BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6, units: [{ kind: 'commander', id: ANN_CMDR, owner: ANN.inGame }] },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

function feedGame(settings: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return {
    ...f,
    state: 'Playing',
    numberOfTurns: '2',
    players,
    settings: { ...(f.settings as Record<string, unknown>), SanctionsCard: 'none', ...settings },
    ...extra,
  };
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

function server() {
  const sent: Uint8Array[] = [];
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, SYN_BOARD, [ANN.inGame, BOB.inGame]) };
    if (req.method === Method.SendOrders) {
      sent.push(req.body.raw(req.body.remaining));
      return { body: (w) => w.bool(true).bool(false) };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { sent, warapp };
}

const ON = { AllowTransferOnly: true, AllowAttackOnly: true, AllowPercentageAttacks: true, Commanders: true };

describe('warapp_submit_turn order options (#165)', () => {
  it('sends Transfer Only, Attack Only, a percentage and the commander as the client encodes them', async () => {
    const s = server();
    h = await liveHarness({ feed: [feedGame(ON), feedGame(ON), feedGame(ON, { numberOfTurns: '3' })], pages: ME_PAGE, warapp: s.warapp });
    const orders = [
      { kind: 'deploy', territory: 159, armies: 5 },
      { kind: 'move', from: 159, to: 161, armies: 2, mode: 'transfer-only' },
      { kind: 'move', from: 161, to: 157, armies: 50, percent: true },
      { kind: 'move', from: 159, to: 158, armies: 8, commander: true, mode: 'attack-only' },
    ];
    const preview = payload<Record<string, unknown>>(await h.call('warapp_submit_turn', { game_id: GAME, orders }));
    const text = JSON.stringify(preview);
    expect(text).toMatch(/not yet verified/);
    expect(text).toMatch(/"percent":50/);
    expect(text).toMatch(/"commander":true/);
    expect(s.sent).toEqual([]);
    const p = payload(await h.call('warapp_submit_turn', { game_id: GAME, orders, confirmToken: preview.confirmToken }));
    expect(p).toMatchObject({ status: 'resolved' });
    const want = new Writer();
    writeSendOrdersParams(
      want,
      GAME,
      ANN.inGame,
      [
        { kind: 'deploy', territoryId: 159, armies: 5 },
        { kind: 'move', from: 159, to: 161, armies: 2, mode: 2 },
        { kind: 'move', from: 161, to: 157, armies: 50, byPercent: true },
        { kind: 'move', from: 159, to: 158, armies: 8, mode: 1, commander: { id: ANN_CMDR, owner: ANN.inGame } },
      ],
      3,
    );
    expect(Array.from(s.sent[0]!)).toEqual(Array.from(want.bytes()));
  });

  it.each([
    ['Transfer Only', { mode: 'transfer-only' }, /Transfer Only orders are off/],
    ['Attack Only', { mode: 'attack-only' }, /Attack Only orders are off/],
    ['a percentage', { percent: true }, /Percentage orders are off/],
    ['the commander', { commander: true }, /no commanders/],
  ])('refuses %s in a game that does not allow it, sending nothing', async (_what, opt, msg) => {
    const s = server();
    h = await liveHarness({ feed: [feedGame({})], pages: ME_PAGE, warapp: s.warapp });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [
        { kind: 'deploy', territory: 159, armies: 5 },
        { kind: 'move', from: 159, to: 161, armies: 2, ...opt },
      ],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(msg);
    expect(s.sent).toEqual([]);
  });

  it('a commander alone moves with 0 armies; 0 armies without it is refused', async () => {
    const s = server();
    h = await liveHarness({ feed: [feedGame(ON), feedGame(ON)], pages: ME_PAGE, warapp: s.warapp });
    const alone = payload<Record<string, unknown>>(
      await h.call('warapp_submit_turn', {
        game_id: GAME,
        orders: [
          { kind: 'deploy', territory: 161, armies: 5 },
          { kind: 'move', from: 159, to: 161, armies: 0, commander: true },
        ],
      }),
    );
    expect(alone.confirmToken).toEqual(expect.any(String));
    const none = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [
        { kind: 'deploy', territory: 161, armies: 5 },
        { kind: 'move', from: 159, to: 161, armies: 0 },
      ],
    });
    expect(textOf(none)).toMatch(/sends no armies/);
  });

  it('attack_teammates is refused outside a team game', async () => {
    const s = server();
    h = await liveHarness({ feed: [feedGame(ON)], pages: ME_PAGE, warapp: s.warapp });
    const res = await h.call('warapp_submit_turn', {
      game_id: GAME,
      orders: [
        { kind: 'deploy', territory: 159, armies: 5 },
        { kind: 'move', from: 159, to: 158, armies: 2, attack_teammates: true },
      ],
    });
    expect(textOf(res)).toMatch(/no teammates/);
  });
});

describe('mods and guard off in plans (#165)', () => {
  it('plan_turn and check_plan say the rules may not hold when the game runs mods', async () => {
    const s = server();
    h = await liveHarness({ feed: [feedGame({ Mods: [{ ID: 1 }] }), feedGame({ Mods: [{ ID: 1 }] })], pages: ME_PAGE, warapp: s.warapp });
    const plan = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(plan.warnings.join('\n')).toMatch(/runs 1 mod: .*may not hold/);
    const check = payload<{ warnings: string[] }>(
      await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 159, armies: 5 }] }),
    );
    expect(check.warnings.join('\n')).toMatch(/runs 1 mod/);
  });

  it('no mods, no warning', async () => {
    const s = server();
    h = await liveHarness({ feed: [feedGame({})], pages: ME_PAGE, warapp: s.warapp });
    const plan = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(plan.warnings.join('\n')).not.toMatch(/mod/);
  });

  it('submit_turn warns, with the guard off, of a territory its orders leave empty beside the enemy', async () => {
    const s = server();
    const noGuard = { OneArmyStandsGuard: false };
    h = await liveHarness({ feed: [feedGame(noGuard)], pages: ME_PAGE, warapp: s.warapp });
    const preview = payload<{ preview: { warnings?: string[] } }>(
      await h.call('warapp_submit_turn', {
        game_id: GAME,
        orders: [
          { kind: 'deploy', territory: 161, armies: 5 },
          { kind: 'move', from: 161, to: 159, armies: 8 },
        ],
      }),
    );
    // Hornwood keeps Ann's commander, so only Sheepshead Hills is empty.
    expect((preview.preview.warnings ?? []).join('\n')).toMatch(/Guard is off: these orders leave [^,]*Sheepshead Hills.* \(161\) at 0 armies/);
  });
});

describe('check_plan and plan_turn: order options and the guard (#165)', () => {
  it('check_plan refuses attack_teammates outside a team game, as submit does', async () => {
    const s = server();
    h = await liveHarness({ feed: [feedGame(ON)], pages: ME_PAGE, warapp: s.warapp });
    const res = await h.call('warapp_check_plan', {
      game_id: GAME,
      player: 'Ann',
      orders: [
        { kind: 'deploy', territory: 159, armies: 5 },
        { kind: 'move', from: 159, to: 158, armies: 2, attack_teammates: true },
      ],
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/no teammates/);
  });

  it('check_plan warns, with the guard off, of a territory its orders leave empty beside the enemy', async () => {
    const s = server();
    h = await liveHarness({ feed: [feedGame({ OneArmyStandsGuard: false })], pages: ME_PAGE, warapp: s.warapp });
    const r = payload<{ warnings: string[] }>(
      await h.call('warapp_check_plan', {
        game_id: GAME,
        player: 'Ann',
        orders: [
          { kind: 'deploy', territory: 161, armies: 5 },
          { kind: 'move', from: 161, to: 159, armies: 8 },
        ],
      }),
    );
    expect(r.warnings.join('\n')).toMatch(/Guard is off: these orders leave [^,]*Sheepshead Hills.* \(161\) at 0 armies/);
  });

  it('check_plan says nothing of the guard when it is on', async () => {
    const s = server();
    h = await liveHarness({ feed: [feedGame({})], pages: ME_PAGE, warapp: s.warapp });
    const r = payload<{ warnings: string[] }>(
      await h.call('warapp_check_plan', {
        game_id: GAME,
        player: 'Ann',
        orders: [
          { kind: 'deploy', territory: 161, armies: 5 },
          { kind: 'move', from: 161, to: 159, armies: 5 },
        ],
      }),
    );
    expect(r.warnings.join('\n')).not.toMatch(/Guard is off/);
  });

  // #165: the planner now keeps one army on a territory next to an enemy (this plan withdraws all
  // but one from its conceded border), so the "left empty" warning has nothing to name here.
  it('plan_turn keeps one army next to an enemy with the guard off, and says so', async () => {
    const s = server();
    h = await liveHarness({ feed: [feedGame({ OneArmyStandsGuard: false })], pages: ME_PAGE, warapp: s.warapp });
    const plan = payload<{ warnings: string[]; rationale: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', view: 'full' }));
    expect(plan.rationale.join('\n')).toMatch(/One Army Must Stand Guard is off: .* keeps one army \(next to an enemy\)/);
    expect(plan.warnings.join('\n')).not.toMatch(/these orders leave .* at 0 armies/);
  });
});

describe('myOrdersOf: what opponent tracking reads of my sent turn (#165)', () => {
  it('leaves out percentage, Transfer Only and Attack Only moves: they may send other armies or none', () => {
    const r = myOrdersOf([
      { kind: 'deploy', territoryId: 1, armies: 3 },
      { kind: 'move', from: 1, to: 3, armies: 4 },
      { kind: 'move', from: 1, to: 3, armies: 4, mode: AttackTransferMode.AttackTransfer },
      { kind: 'move', from: 1, to: 2, armies: 2, mode: AttackTransferMode.Transfer },
      { kind: 'move', from: 2, to: 1, armies: 2, mode: AttackTransferMode.Attack },
      { kind: 'move', from: 1, to: 5, armies: 50, byPercent: true },
    ]);
    expect(r.deploys).toEqual([{ territoryId: 1, armies: 3 }]);
    expect(r.moves).toEqual([
      { from: 1, to: 3, armies: 4 },
      { from: 1, to: 3, armies: 4 },
    ]);
  });
});
