// #437 task 3 at the capture points: warapp_plan_picks logs its summary (a re-plan replaces it),
// warapp_submit_picks logs the list sent and read back once confirmed (a preview logs nothing), and the turn
// tools' award read on turn 1 is logged once. Synthetic ids; the fixture's players carry names only to prove
// none is ever written.
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { decisionLogPath, readDecisionLog } from '../src/decision-log.js';
import { writePickList } from '../src/pick-list.js';
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
const ME = Number(ANN.feed);
const SIGNED_IN_ANN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

/** The lobby fixture's first two seats (Ann and Bob), in a given state. */
function game(state: string, turn = 0): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>)
    .slice(0, 2)
    .map((p, i) => ({ ...p, id: [ANN, BOB][i]!.feed, name: ['Ann', 'Bob'][i]!, state: 'Playing' }));
  return {
    ...f,
    state,
    numberOfTurns: String(turn - 1),
    players,
    settings: { ...(f.settings as object), InitialPlayerArmiesPerTerritory: 5 },
  };
}

const PICK_BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 2, owner: -2, armies: 3 },
  { id: 161, fogLevel: 2, owner: -2, armies: 3 },
  { id: 157, fogLevel: 2, owner: -2, armies: 3 },
  { id: 135, fogLevel: 2, owner: -2, armies: 3 },
  { id: 133, fogLevel: 2, owner: -2, armies: 3 },
  { id: 134, fogLevel: 2, owner: -2, armies: 3 },
  { id: 158, fogLevel: 2, owner: 0, armies: 2 },
];
const FOG: Omit<SyntheticTerritory, 'id'> = { fogLevel: 4, owner: -1, armies: 0, fogged: true };
const TURN1_BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 5 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, ...FOG },
  { id: 135, ...FOG },
];

function server(territories: SyntheticTerritory[]) {
  const sent: number[][] = [];
  return {
    sent,
    warapp: (req: DecodedRequest): Partial<ReplyFrame> => {
      if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) };
      if (req.method === Method.SendTerritoryPicks) {
        req.body.int32();
        sent.push(req.body.bool() ? (req.body.list((r) => r.int32()) ?? []) : []);
        return { body: (w) => w.bool(true).bool(false) };
      }
      if (req.method === Method.GetTerritoryPicks) return { body: (w) => w.bool(true).list(sent.at(-1) ?? [], (ww, id) => ww.int32(id)) };
      if (req.method === Method.GetMyGames) throw new Error('no game list here');
      throw new Error(`unexpected method ${req.method}`);
    },
  };
}

const log = () => readDecisionLog(h!.dataDir, GAME);
const text = () => readFileSync(decisionLogPath(h!.dataDir, GAME), 'utf8');

describe('warapp_plan_picks logs its summary (#437 task 3)', () => {
  for (const hosted of [false, true]) {
    it(`logs ids, scores and warning codes as the signed-in seat, and a re-plan replaces them${hosted ? ' (hosted)' : ''}`, async () => {
      h = await liveHarness({
        feed: [game('DistributingTerritories')],
        pages: SIGNED_IN_ANN,
        warapp: server(PICK_BOARD).warapp,
        ...(hosted ? { env: { MCP_HOST_CONFIRM_SECRET: 'synthetic' } } : {}),
      });
      const p = payload<{ submitPicks: { territories: number[] }; groups: { primary: { territories: { id: number }[] } } }>(
        await h.call('warapp_plan_picks', { game_id: GAME }),
      );
      let l = (await log())!;
      expect(l.playerId).toBe(ME);
      expect(l.picks!.advice!.list).toEqual(p.submitPicks.territories);
      expect(l.picks!.advice!.primary).toEqual(p.groups.primary.territories.map((t) => t.id));
      expect(l.picks!.advice!.players).toBe(2);
      expect(l.picks!.advice!.award?.orders).toEqual(['reversing']);
      expect(l.picks!.advice!.scores.length).toBeGreaterThan(0);
      expect(l.picks!.advice!.warnings.every((w) => /^[a-z-]+$/.test(w))).toBe(true);
      await h.call('warapp_plan_picks', { game_id: GAME, spread: true });
      l = (await log())!;
      expect(l.picks!.advices).toBe(2);
      expect(l.picks!.advice!.spread).toBe(true);
      expect(text()).not.toMatch(/\b(Ann|Bob)\b/);
    });
  }

  it('logs nothing when no seat of the game can be told, or with the decision log off', async () => {
    h = await liveHarness({ feed: [game('DistributingTerritories')], warapp: server(PICK_BOARD).warapp });
    expect((await h.call('warapp_plan_picks', { game_id: GAME })).isError).toBeFalsy();
    expect(await log()).toBeUndefined();
    await h.harness.close();
    h = await liveHarness({ feed: [game('DistributingTerritories')], pages: SIGNED_IN_ANN, warapp: server(PICK_BOARD).warapp, env: { WARAPP_DECISION_LOG: 'off' } });
    await h.call('warapp_plan_picks', { game_id: GAME });
    expect(await log()).toBeUndefined();
  });
});

describe('warapp_submit_picks logs the list sent and read back (#437 task 3)', () => {
  it('a preview logs nothing; a confirmed send logs it once, beside the advice', async () => {
    const s = server(PICK_BOARD);
    h = await liveHarness({ feed: [game('DistributingTerritories')], pages: SIGNED_IN_ANN, warapp: s.warapp });
    await h.call('warapp_plan_picks', { game_id: GAME });
    const preview = payload<{ confirmToken: string }>(await h.call('warapp_submit_picks', { game_id: GAME, territories: [161, 159, 135] }));
    expect((await log())!.picks!.submitted).toBeUndefined();
    await h.call('warapp_submit_picks', { game_id: GAME, territories: [161, 159, 135], confirmToken: preview.confirmToken });
    const picks = (await log())!.picks!;
    expect(picks.submitted).toMatchObject({ sent: [161, 159, 135], readBack: [161, 159, 135], verified: true, outcome: 'confirmed' });
    expect(picks.submits).toBe(1);
    expect(picks.advice).toBeDefined();
    expect(text()).not.toMatch(/\b(Ann|Bob)\b/);
  });
});

describe('the award read on turn 1 is logged once (#437 task 3)', () => {
  it('warapp_plan_turn logs the award it reads; a second plan leaves it as it was', async () => {
    h = await liveHarness({ feed: [game('Playing', 1)], pages: SIGNED_IN_ANN, warapp: server(TURN1_BOARD).warapp });
    // Two starts each. Listed: 159, 158, 161, 157. Granted numbers 1 and 3, so number 2 (158) was taken.
    await writePickList(h.dataDir, GAME, ME, [159, 158, 161, 157]);
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    const first = (await log())!.picks!.award!;
    expect(first).toMatchObject({ turn: 1, reading: { granted: [159, 161], opponentStarts: [158] } });
    await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' });
    expect((await log())!.picks!.award).toEqual(first);
  });
});
