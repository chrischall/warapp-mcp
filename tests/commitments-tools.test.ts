// B4 (docs/PLAN-TEAMS.md section 8): warapp_send_chat's `commitments` — each kind accepted and refused
// against the plan made in the call (or the orders already submitted) and the ledger, recorded in the
// ledger on a sent message, and warapp_submit_turn's warning when later orders break one. The pure
// check is tested in tests/analysis/commitments.test.ts. Every id and name here is made up.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { readLedger, writeLedger, emptyLedger } from '../src/relations-store.js';
import { writeOrdersCache } from '../src/trend.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const CAT = { feed: '5523456788', inGame: 234567 };
const SIGNED_IN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };
const TURN = 3;

/** The lobby fixture as a game on turn 3, played by Ann, Bob and Cat. */
function game() {
  const f = lobbyFixture();
  const named = [
    { id: ANN.feed, name: 'Ann' },
    { id: BOB.feed, name: 'Bob' },
    { id: CAT.feed, name: 'Cat' },
  ];
  const players = (f.players as Array<Record<string, string>>).map((p, i) => ({ ...p, ...named[i] })).slice(0, 3);
  return { ...f, state: 'Playing', numberOfTurns: String(TURN - 1), players };
}

// Ann holds 159 and 161; Bob's 158 borders both; 157 neutral. The plan expands into 157 and leaves Bob be.
const quiet: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];
// Ann is rich and Bob's 158 is thin: the plan attacks 158.
const striking: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 3 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
  { id: 9825, fogLevel: 1, owner: ANN.inGame, armies: 3 },
];

/** war.app: the live board, and SendChat answered with an unreadable reply (outcome `accepted`) or `send`. */
function server(territories: SyntheticTerritory[], send: Partial<ReplyFrame> = { body: (w) => w.bool(false) }) {
  const sent: string[] = [];
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) };
    if (req.method === Method.SendChat) {
      req.body.int32();
      sent.push(req.body.string() ?? "");
      return send;
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { sent, warapp };
}

async function start(territories: SyntheticTerritory[], send?: Partial<ReplyFrame>) {
  const s = server(territories, send);
  h = await liveHarness({ feed: [game()], pages: SIGNED_IN, warapp: s.warapp });
  return s;
}

const send = (commitments: unknown[], message = 'a message') => h!.call('warapp_send_chat', { game_id: GAME, message, to: 'Bob', commitments });
async function confirmed(commitments: unknown[], message = 'a message') {
  const preview = payload(await send(commitments, message));
  expect(preview.confirmToken).toEqual(expect.any(String));
  return h!.call('warapp_send_chat', { game_id: GAME, message, to: 'Bob', commitments, confirmToken: preview.confirmToken });
}
const ledger = async () => readLedger(h!.dataDir, GAME, Number(ANN.feed));
const plannedMoves = async () =>
  payload<{ moves: Array<{ from: { id: number }; to: { id: number } }> }>(await h!.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' })).moves.map(
    (m) => [m.from.id, m.to.id],
  );

describe('warapp_send_chat commitments', () => {
  it('the description says a promise must be declared, and the text is never read', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_send_chat')!;
    expect(tool.description).toMatch(/must be declared in `commitments`/);
    expect(tool.description).toMatch(/text is never read/);
  });

  it('the fixtures: the quiet plan leaves Bob be, the striking plan attacks 158', async () => {
    await start(quiet);
    expect((await plannedMoves()).some(([, to]) => to === 158)).toBe(false);
    await h!.harness.close();
    await start(striking);
    expect((await plannedMoves()).some(([, to]) => to === 158)).toBe(true);
  });

  describe('no-attack', () => {
    it('carried by a plan that leaves Bob be: previewed, sent once confirmed, and recorded as mine', async () => {
      const s = await start(quiet);
      const preview = payload<{ preview: { commitments: { turn: number; checkedAgainst: string; carried: Array<{ kind: string; carried: string }> } } }>(
        await send([{ kind: 'no-attack', player: 'Bob', turns: 2 }]),
      );
      expect(preview.preview.commitments).toMatchObject({ turn: TURN, checkedAgainst: 'the plan made now' });
      expect(preview.preview.commitments.carried[0]!.carried).toMatch(new RegExp(`player ${BOB.feed}'s territories .*through turn 4`));
      expect(s.sent).toEqual([]);
      const p = payload<{ outcome: string; commitments: { recorded: Array<{ id: string; kind: string }> } }>(
        await confirmed([{ kind: 'no-attack', player: 'Bob', turns: 2 }]),
      );
      expect(p.outcome).toBe('accepted');
      expect(p.commitments.recorded).toEqual([{ index: 0, kind: 'no-attack', id: 'c1' }]);
      expect(s.sent).toEqual(['a message']);
      expect((await ledger())?.commitments).toEqual([
        { id: 'c1', sentTurn: TURN, kind: 'no-attack', with: Number(BOB.feed), scope: 'all', fromTurn: TURN, toTurn: TURN + 1 },
      ]);
    });

    it('refused when the plan attacks Bob, naming the commitment and the move; nothing is sent', async () => {
      const s = await start(striking);
      const res = await send([{ kind: 'no-attack', player: 'Bob', territories: [158], turns: 1 }]);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/do not carry this commitment — commitment 1 \(no-attack\): the planned move \d+ \(\d+ → 158\) attacks player \d+'s territory 158/);
      expect(textOf(res)).toMatch(/undeclared promise is not allowed/);
      expect(s.sent).toEqual([]);
      expect(await ledger()).toBeUndefined();
    });
  });

  describe('will-attack', () => {
    it('carried by a plan that attacks the territory, and recorded', async () => {
      await start(striking);
      const p = payload<{ commitments: { recorded: Array<{ id: string }> } }>(await confirmed([{ kind: 'will-attack', territory: 158 }]));
      expect(p.commitments.recorded[0]).toMatchObject({ id: 'c1', kind: 'will-attack' });
      expect((await ledger())?.commitments).toEqual([{ id: 'c1', sentTurn: TURN, kind: 'will-attack', territory: 158, turn: TURN }]);
    });

    it('refused when the plan does not attack, and for a later turn', async () => {
      const s = await start(quiet);
      expect(textOf(await send([{ kind: 'will-attack', player: 'Bob' }]))).toMatch(/no planned order this turn attacks player \d+/);
      expect(textOf(await send([{ kind: 'will-attack', territory: 158, turn: TURN + 1 }]))).toMatch(/turn 4 is not planned yet/);
      expect(s.sent).toEqual([]);
    });

    it('orders this server already submitted this turn stand in for the plan', async () => {
      await start(quiet);
      await writeOrdersCache(h!.dataDir, GAME, Number(ANN.feed), TURN, { deploys: [], moves: [{ from: 159, to: 158, armies: 5 }] });
      const preview = payload<{ preview: { commitments: { checkedAgainst: string; carried: Array<{ carried: string }> } } }>(
        await send([{ kind: 'will-attack', player: 'Bob' }]),
      );
      expect(preview.preview.commitments.checkedAgainst).toBe('the orders already submitted');
      expect(preview.preview.commitments.carried[0]!.carried).toMatch(/^the submitted move 1 \(159 → 158\) attacks player/);
    });

    it('submitted orders keep their mode: a Transfer Only order attacks nothing, an Attack Only one does', async () => {
      await start(quiet);
      const me = Number(ANN.feed);
      await writeOrdersCache(h!.dataDir, GAME, me, TURN, { deploys: [], moves: [], sent: [{ from: 159, to: 158, transferOnly: true }] });
      expect(payload<{ preview: { commitments: { checkedAgainst: string } } }>(await send([{ kind: 'no-attack', player: 'Bob', turns: 1 }])).preview.commitments).toMatchObject({
        checkedAgainst: 'the orders already submitted',
      });
      // An Attack Only order is not in `moves` (it may not run), but it is an attack the promise would break.
      await writeOrdersCache(h!.dataDir, GAME, me, TURN, { deploys: [], moves: [], sent: [{ from: 159, to: 158 }] });
      expect(textOf(await send([{ kind: 'no-attack', player: 'Bob', turns: 1 }]))).toMatch(/the submitted move 1 \(159 → 158\) attacks player \d+'s territory 158/);
    });
  });

  describe('notice', () => {
    const agreed = async (noticeTurns = 2) => {
      payload(await h!.call('warapp_record_agreement', { game_id: GAME, player: 'Ann', with: 'Bob', status: 'agreed', notice_turns: noticeTurns }));
    };

    it('carried on an agreed truce: recorded, and the agreement moves to notice-by-me', async () => {
      await start(quiet);
      await agreed();
      const p = payload<{ commitments: { recorded: Array<{ agreement?: { id: string; status: string } }> } }>(
        await confirmed([{ kind: 'notice', agreement: 'a1', ends_turn: TURN + 2 }]),
      );
      expect(p.commitments.recorded[0]!.agreement).toMatchObject({ id: 'a1', status: 'notice-by-me', playerRecord: 'updated' });
      const l = await ledger();
      expect(l?.agreements[0]).toMatchObject({ id: 'a1', status: 'notice-by-me', noticeTurn: TURN });
      expect(l?.commitments).toEqual([{ id: 'c1', sentTurn: TURN, kind: 'notice', agreement: 'a1', with: Number(BOB.feed), endsTurn: TURN + 2 }]);
    });

    it('refused when the message names an end before the agreed notice has run, and on no agreement', async () => {
      const s = await start(quiet);
      await agreed();
      expect(textOf(await send([{ kind: 'notice', agreement: 'a1', ends_turn: TURN + 1 }]))).toMatch(
        /carries 2 turns of notice: given on turn 3, it binds until turn 5, so the message cannot say it ends on turn 4/,
      );
      expect(textOf(await send([{ kind: 'notice', agreement: 'a1', ends_turn: TURN + 9 }]))).toMatch(
        /it binds until turn 5, so the message cannot say it ends on turn 12 \(the ledger frees its territories on turn 5/,
      );
      expect(textOf(await send([{ kind: 'notice', agreement: 'a7' }]))).toMatch(/no agreement a7/);
      expect(s.sent).toEqual([]);
      expect((await ledger())?.agreements[0]?.status).toBe('agreed');
    });
  });

  describe('propose and accept', () => {
    it('a proposal creates the agreement as proposed-by-me through the ledger path', async () => {
      await start(quiet);
      const p = payload<{ commitments: { recorded: Array<{ agreement?: { id: string; status: string; playerRecord?: string } }> } }>(
        await confirmed([{ kind: 'propose', player: 'Bob', territories: [159, 161, 158], notice_turns: 1 }]),
      );
      expect(p.commitments.recorded[0]!.agreement).toEqual({ id: 'a1', status: 'proposed-by-me', playerRecord: 'updated' });
      const l = await ledger();
      expect(l?.agreements[0]).toMatchObject({ id: 'a1', with: Number(BOB.feed), status: 'proposed-by-me', terms: { scope: { territories: [158, 159, 161] } } });
      expect(l?.commitments?.[0]).toEqual({ id: 'c1', sentTurn: TURN, kind: 'propose', agreement: 'a1', with: Number(BOB.feed) });
    });

    it('accepting a recorded proposal agrees it', async () => {
      await start(quiet);
      payload(await h!.call('warapp_record_agreement', { game_id: GAME, player: 'Ann', with: 'Bob', status: 'proposed-by-them' }));
      payload(await confirmed([{ kind: 'accept', agreement: 'a1' }]));
      expect((await ledger())?.agreements[0]).toMatchObject({ id: 'a1', status: 'agreed', agreedTurn: TURN });
    });

    it('an accept that restates only some of a proposal\'s terms is compared on those alone', async () => {
      await start(quiet);
      payload(
        await h!.call('warapp_record_agreement', { game_id: GAME, player: 'Ann', with: 'Bob', status: 'proposed-by-them', territories: [159, 158], notice_turns: 2 }),
      );
      payload(await confirmed([{ kind: 'accept', agreement: 'a1', notice_turns: 2 }]));
      expect((await ledger())?.agreements[0]).toMatchObject({ id: 'a1', status: 'agreed', terms: { scope: { territories: [158, 159] }, noticeTurns: 2 } });
    });

    it('a truce whose last turn is already past is refused', async () => {
      const s = await start(quiet);
      expect(textOf(await send([{ kind: 'propose', player: 'Bob', until_turn: TURN - 1 }]))).toMatch(/bind only until turn 2, before this turn \(3\)/);
      expect(s.sent).toEqual([]);
    });

    it('refused while the plan attacks what the truce would cover, and for a counter-offer passed as an accept', async () => {
      const s = await start(striking);
      expect(textOf(await send([{ kind: 'propose', player: 'Bob' }]))).toMatch(/which the proposed truce covers/);
      await h!.harness.close();
      const q = await start(quiet);
      payload(await h!.call('warapp_record_agreement', { game_id: GAME, player: 'Ann', with: 'Bob', status: 'proposed-by-them' }));
      expect(textOf(await send([{ kind: 'accept', agreement: 'a1', notice_turns: 3 }]))).toMatch(/counter-offer is a propose/);
      expect([...s.sent, ...q.sent]).toEqual([]);
    });
  });

  it('a message not confirmed sent records nothing, and says so', async () => {
    await start(quiet, { msgNum: 999 });
    const p = payload<{ outcome: string; commitments: { recorded: unknown[]; why: string } }>(await confirmed([{ kind: 'no-attack', player: 'Bob', turns: 1 }]));
    expect(p.outcome).toBe('unknown');
    expect(p.commitments.recorded).toEqual([]);
    expect(p.commitments.why).toMatch(/not confirmed sent/);
    expect(await ledger()).toBeUndefined();
  });

  it('refused outside a turn phase, before anything is sent', async () => {
    const s = server(quiet);
    h = await liveHarness({ feed: [{ ...game(), state: 'Finished' }], pages: SIGNED_IN, warapp: s.warapp });
    expect(textOf(await send([{ kind: 'no-attack', player: 'Bob', turns: 1 }]))).toMatch(/not in a turn phase/);
    expect(s.sent).toEqual([]);
  });
});

describe('warapp_submit_turn warns when orders break a commitment', () => {
  it('an attack on a player I promised no attack, and a promised attack the orders leave out', async () => {
    await start(striking);
    const me = Number(ANN.feed);
    await writeLedger(h!.dataDir, {
      ...emptyLedger(GAME, me),
      commitments: [
        { id: 'c1', sentTurn: TURN - 1, kind: 'no-attack', with: Number(BOB.feed), scope: 'all', fromTurn: TURN - 1, toTurn: TURN },
        { id: 'c2', sentTurn: TURN, kind: 'will-attack', territory: 157, turn: TURN },
      ],
    });
    const preview = payload<{ preview: { warnings: string[] } }>(
      await h!.call('warapp_submit_turn', {
        game_id: GAME,
        orders: [
          { kind: 'deploy', territory: 159, armies: payload<{ income: number }>(await h!.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' })).income },
          { kind: 'move', from: 159, to: 158, armies: 4 },
        ],
      }),
    );
    const text = JSON.stringify(preview);
    expect(text).toMatch(new RegExp(`Your chat commitment c1 \\(sent turn 2\\) promised player ${BOB.feed} no attack there through turn 3: move 1 \\(159 → 158\\) attacks it`));
    expect(text).toMatch(/Your chat commitment c2 \(sent turn 3\) said you would attack territory 157 this turn: no order here does/);
    expect(text).toMatch(/never silently/);
  });
});
