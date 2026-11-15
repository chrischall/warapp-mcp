// #274: warapp_submit_turn refuses orders that leave my commander takeable by a single-deploy
// reply (sized at the larger of the opponent's estimate and my own income) unless the call passes
// accept_commander_risk: true, which the result then records. Synthetic board, ids only.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

// Fixture map: 159 Hornwood – 161 Sheepshead Hills – 157 Widow's Watch form bonus 118 (+2);
// 158 Bolton Moors borders all three. Ann holds the bonus: income 7. Bob's estimate is 5.
const GAME = 12345678;
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const ANN_CMDR = '0123456789abcdef0123456789abcdef';
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

/** My commander on 159 behind 6; Bob's 16 beside it. 16 + 5 − 1 = 20 attackers kill 12 (it survives); 16 + 7 − 1 = 22 kill 13 (it falls). */
const BOARD = (withUnit = true): SyntheticTerritory[] => [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6, ...(withUnit ? { units: [{ kind: 'commander' as const, id: ANN_CMDR, owner: ANN.inGame }] } : {}) },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 16 },
];

function feedGame(settings: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p,
  );
  return { ...f, state: 'Playing', numberOfTurns: '2', players, settings: { ...(f.settings as Record<string, unknown>), SanctionsCard: 'none', ...settings }, ...extra };
}

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

function server(board: SyntheticTerritory[]) {
  const sent: Uint8Array[] = [];
  const warapp = (req: DecodedRequest): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, board, [ANN.inGame, BOB.inGame]) };
    if (req.method === Method.SendOrders) {
      sent.push(req.body.raw(req.body.remaining));
      return { body: (w) => w.bool(true).bool(false) };
    }
    throw new Error(`unexpected method ${req.method}`);
  };
  return { sent, warapp };
}

const CMD = { Commanders: true };
const AWAY = [{ kind: 'deploy', territory: 161, armies: 7 }];
const HOME = [{ kind: 'deploy', territory: 159, armies: 7 }];

describe('warapp_submit_turn commander check (#274)', () => {
  it('refuses orders that leave the commander takeable at my income, naming the armies that would hold', async () => {
    const s = server(BOARD());
    h = await liveHarness({ feed: [feedGame(CMD)], pages: ME_PAGE, warapp: s.warapp });
    const res = await h.call('warapp_submit_turn', { game_id: GAME, orders: AWAY });
    expect(res.isError).toBe(true);
    const text = textOf(res);
    expect(text).toMatch(/commander on territory 159/);
    // Sized at my income 7, the larger of the two.
    expect(text).toMatch(/single deploy of 7/);
    expect(text).toMatch(/needs (\d+) armies there \(6 after your orders\)/);
    expect(text).toMatch(/accept_commander_risk/);
    expect(s.sent).toEqual([]);
    // The armies named do hold: 7 there (6 + 1) survives the 22.
    expect(Number(/needs (\d+) armies/.exec(text)![1])).toBe(7);
  });

  it('passes orders that keep the commander safe', async () => {
    const s = server(BOARD());
    h = await liveHarness({ feed: [feedGame(CMD)], pages: ME_PAGE, warapp: s.warapp });
    const preview = payload<Record<string, unknown>>(await h.call('warapp_submit_turn', { game_id: GAME, orders: HOME }));
    expect(preview.confirmToken).toEqual(expect.any(String));
    expect(JSON.stringify(preview)).not.toMatch(/accept_commander_risk/);
  });

  it('with accept_commander_risk the preview warns first and the result records the risk taken', async () => {
    const s = server(BOARD());
    h = await liveHarness({ feed: [feedGame(CMD), feedGame(CMD), feedGame(CMD, { numberOfTurns: '3' })], pages: ME_PAGE, warapp: s.warapp });
    const args = { game_id: GAME, orders: AWAY, accept_commander_risk: true };
    const preview = payload<{ confirmToken: string; preview: { warnings: string[] } }>(await h.call('warapp_submit_turn', args));
    expect(preview.preview.warnings[0]).toMatch(/^accept_commander_risk is true: .*commander on territory 159/);
    const p = payload<Record<string, unknown>>(await h.call('warapp_submit_turn', { ...args, confirmToken: preview.confirmToken }));
    expect(p).toMatchObject({ status: 'resolved', commanderRiskAccepted: { territory: 159, armies: 6, needs: 7, replyDeploy: 7 } });
    expect(s.sent.length).toBe(1);
  });

  it('never refuses in a game without commanders', async () => {
    const s = server(BOARD(false));
    h = await liveHarness({ feed: [feedGame({ Commanders: false })], pages: ME_PAGE, warapp: s.warapp });
    const preview = payload<Record<string, unknown>>(await h.call('warapp_submit_turn', { game_id: GAME, orders: AWAY }));
    expect(preview.confirmToken).toEqual(expect.any(String));
  });

  it('describes the flag', async () => {
    h = await liveHarness({ feed: [feedGame(CMD)], pages: ME_PAGE, warapp: server(BOARD()).warapp });
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_submit_turn')!;
    expect(JSON.stringify(tool.inputSchema)).toMatch(/accept_commander_risk/);
    expect(tool.description).toMatch(/accept_commander_risk/);
  });
});

interface CommanderBlock {
  territory: { id: number; name: string };
  armies: number;
  movesToEnemy: number | null;
  killedBy: { deploy: number; player: { id: number } } | null;
  needs: number | null;
  safe: boolean;
  replyDeploy: number;
  text: string;
}
interface PlanPayload {
  commander?: CommanderBlock;
  deploys: Array<{ territory: { id: number }; armies: number }>;
  warnings: string[];
}

describe('warapp_plan_turn commander block (#274)', () => {
  const plan = async () => payload<PlanPayload>(await h!.call('warapp_plan_turn', { game_id: GAME }));

  it('reports the commander every turn: its territory, the armies after the plan, the moves to the enemy, the deploy that kills it', async () => {
    h = await liveHarness({ feed: [feedGame(CMD)], pages: ME_PAGE, warapp: server(BOARD()).warapp });
    const p = await plan();
    const onIt = p.deploys.filter((d) => d.territory.id === 159).reduce((n, d) => n + d.armies, 0);
    expect(p.commander).toMatchObject({ territory: { id: 159 }, armies: 6 + onIt, movesToEnemy: 1, replyDeploy: 7 });
    // Bob's 16 beside it: some single deploy kills it, and it is more than none.
    expect(p.commander!.killedBy).toMatchObject({ player: { id: Number(BOB.feed) } });
    expect(p.commander!.killedBy!.deploy).toBeGreaterThan(0);
    expect(p.commander!.text).toMatch(/^Your commander on territory 159/);
    // The plan holds it (its territory is must-hold): no warning that submit would refuse.
    expect(p.commander!.safe).toBe(true);
    expect(p.warnings.join('\n')).not.toMatch(/accept_commander_risk/);
  });

  it('warns first when the plan leaves it takeable at the larger of the estimate and my income', async () => {
    // Bob's 40 beside it: nothing my 7 can add holds 6 + the commander.
    const board = BOARD().map((t) => (t.id === 158 ? { ...t, armies: 40 } : t));
    h = await liveHarness({ feed: [feedGame(CMD)], pages: ME_PAGE, warapp: server(board).warapp });
    const p = await plan();
    expect(p.commander!.safe).toBe(false);
    expect(p.commander!.needs).toBeGreaterThan(p.commander!.armies);
    expect(p.warnings[0]).toMatch(/commander on territory 159.*accept_commander_risk/s);
  });

  it('no block in a game without commanders', async () => {
    h = await liveHarness({ feed: [feedGame({ Commanders: false })], pages: ME_PAGE, warapp: server(BOARD(false)).warapp });
    const p = await plan();
    expect(p).not.toHaveProperty('commander');
  });
});
