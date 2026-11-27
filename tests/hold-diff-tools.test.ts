// #275 pattern 3 through the tools: warapp_submit_turn's preview and warapp_check_plan compare the
// given orders with the default plan (planTurn on the same live board) border by border and name every
// border left below what the plan leaves standing there, with the difference. Synthetic board on the anonymized lobby
// fixture's map; no war.app traffic.
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
  // #593: two members of 158's bonus (116) shown neutral, so Bob's 158 is neither a probable break behind
  // the fog nor (on this turn 3) one short of complete.
  { id: 134, fogLevel: 1, owner: 0, armies: 2 },
  { id: 133, fogLevel: 1, owner: 0, armies: 2 },
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

const BELOW = /below what the default plan leaves/;

const PLAN = [
  { kind: 'deploy', territory: 157, armies: 7 },
  { kind: 'move', from: 157, to: 158, armies: 5 },
];
// The hand edit: the deploy moved to 159 and no attack.
const EDIT = [{ kind: 'deploy', territory: 159, armies: 7 }];
// The same, with 159 drained too: 9 of its 10 walk to 161.
const DRAIN = [...EDIT, { kind: 'move', from: 159, to: 161, armies: 16 }];

interface Below {
  territory: { id: number; name: string };
  planLeaves: number;
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
    const text = JSON.stringify(payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: DRAIN })));
    // #306: 157, only 2 short of the plan's 12, is the plan's surplus and is not named.
    expect(text).toMatch(/These orders leave 1 border below what the default plan leaves standing there \(#275\): territory 159 with 1 where the plan leaves 10 \(9 short\)\./);
    const small = JSON.stringify(payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: EDIT })));
    expect(small).not.toMatch(BELOW);
    // No board is cached for turns 1 and 2, which warapp_plan_turn would read from GameFeed's history: said.
    expect(text).toMatch(/The board cache lacks turns 1 and 2, which warapp_plan_turn reads from GameFeed's history/);
    expect(text).toMatch(/confirmToken/);
  });

  it('warapp_submit_turn says nothing of it for the plan\'s own orders', async () => {
    h = await live();
    const text = JSON.stringify(payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: PLAN })));
    expect(text).not.toMatch(BELOW);
  });

  it('warapp_check_plan lists each border below the plan, the largest shortfall first, and an empty list for the plan', async () => {
    h = await live();
    const edit = payload<{ belowPlan: Below[] }>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: EDIT }));
    // #306: 157 is 2 short of the plan's 12: the plan's surplus, not named.
    expect(edit.belowPlan).toEqual([]);
    const worse = payload<{ belowPlan: Below[] }>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: DRAIN }));
    expect(worse.belowPlan.map((b) => [b.territory.id, b.planLeaves, b.left, b.short])).toEqual([[159, 10, 1, 9]]);
    const same = payload<{ belowPlan: Below[] }>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: PLAN }));
    expect(same.belowPlan).toEqual([]);
  });
});

// The two plans warapp_plan_turn offers must never read as below the default plan (#275 pattern 3 review).
const DUEL_GAME = (turn: number): Record<string, unknown> => {
  const f = lobbyFixture();
  const ids = [ANN, BOB];
  const players = (f.players as Array<Record<string, string>>)
    .slice(0, 2)
    .map((p, i) => ({ ...p, id: ids[i]!.feed, name: ['Ann', 'Bob'][i]!, state: 'Playing' }));
  return {
    ...f,
    state: 'Playing',
    numberOfTurns: String(turn - 1),
    players,
    settings: { ...(f.settings as object), InitialPlayerArmiesPerTerritory: 5, SanctionsCard: 'none', AirliftCard: 'none' },
  };
};

async function duel(territories: SyntheticTerritory[], turn: number, dataDir?: string): Promise<Harness> {
  return liveHarness({
    feed: [DUEL_GAME(turn)],
    ...(dataDir ? { dataDir } : {}),
    pages: { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` },
    warapp: (req: DecodedRequest): Partial<ReplyFrame> => {
      if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) };
      throw new Error(`unexpected method ${req.method}`);
    },
  });
}

interface PlanOut {
  orders: Array<{ kind: string; territory?: number; armies?: number; from?: number; to?: number }>;
  guessOrders?: PlanOut['orders'];
  award?: unknown;
}
const planOf = async (hh: Harness) => payload<PlanOut>(await hh.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
const SALT = '1'.repeat(32);

describe('the plans warapp_plan_turn offers are never below the default plan (#275 pattern 3 review)', () => {
  // Bonus 118 (+2) is mine, 4 on each of 159, 161 and 157, all beside Bob's 6 on 158: the plan splits
  // 3/2/2 and holds them all against Bob's stack, and offers a guess against his deploy.
  const guessBoard: SyntheticTerritory[] = [
    { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 4 },
    { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 4 },
    { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 4 },
    { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 6 },
    { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
  ];

  it('the guess: its orders are compared with the guess, not with the fixed split it redistributes', async () => {
    // A pinned salt (src/guess-salt.ts) whose draw differs from the plan's split.
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-below-'));
    writeFileSync(join(dir, 'guess-salt'), SALT);
    h = await duel(guessBoard, 3, dir);
    const p = await planOf(h);
    expect(p.orders).toEqual([
      { kind: 'deploy', territory: 157, armies: 3 },
      { kind: 'deploy', territory: 159, armies: 2 },
      { kind: 'deploy', territory: 161, armies: 2 },
    ]);
    // This salt's draw: nothing on Hornwood, which the comparison with the fixed split read as 2 short.
    const go = p.guessOrders!;
    expect(go).toEqual([
      { kind: 'deploy', territory: 157, armies: 3 },
      { kind: 'deploy', territory: 161, armies: 4 },
    ]);
    const sub = JSON.stringify(payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: go })));
    expect(sub).not.toMatch(BELOW);
    const check = payload<{ belowPlan: unknown[]; belowPlanAgainst?: string }>(
      await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: go }),
    );
    expect(check.belowPlan).toEqual([]);
    expect(check.belowPlanAgainst).toBe('guess');
    // The fixed split is still the plan's own: no line for it either.
    expect(JSON.stringify(payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: p.orders })))).not.toMatch(BELOW);
    // An edit of the guess is still named, against the guess: 3 of Hornwood's 4 walk to Sheepshead Hills.
    const drained = [...go, { kind: 'move', from: 159, to: 161, armies: 3 }];
    const edit = payload<{ belowPlan: Array<{ territory: { id: number }; planLeaves: number; left: number }>; belowPlanAgainst?: string }>(
      await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: drained }),
    );
    expect(edit.belowPlan.map((b) => [b.territory.id, b.planLeaves, b.left])).toEqual([[159, 4, 1]]);
    expect(edit.belowPlanAgainst).toBe('guess');
    // A hand split of my own is compared with the plan.
    const mine = payload<{ belowPlanAgainst?: string }>(
      await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 159, armies: 7 }] }),
    );
    expect(mine.belowPlanAgainst).toBe('plan');
  });

  it('the award of picks: plan_turn\'s orders made on the proven starts are not reported below a plan made without them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'warapp-mcp-below-'));
    // Two starts each, listed 159, 158, 161, 157: granted the first and third, so Bob took 158 (fogged).
    await writePickList(dir, GAME, Number(ANN.feed), [159, 158, 161, 157]);
    const fogged = { fogLevel: 4, owner: -1, armies: 0, fogged: true };
    const awardBoard: SyntheticTerritory[] = [
      { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 5 },
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 5 },
      { id: 157, fogLevel: 1, owner: BOB.inGame, armies: 5 },
      { id: 158, ...fogged },
      { id: 135, ...fogged },
    ];
    h = await duel(awardBoard, 1, dir);
    const p = await planOf(h);
    expect(p.award).toBeDefined();
    const before = readdirSync(dir, { recursive: true }).sort();
    expect(JSON.stringify(payload(await h.call('warapp_submit_turn', { game_id: GAME, orders: p.orders })))).not.toMatch(BELOW);
    const check = payload<{ belowPlan: unknown[] }>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: p.orders }));
    expect(check.belowPlan).toEqual([]);
    // The preview reads the award and writes nothing.
    expect(readdirSync(dir, { recursive: true }).sort()).toEqual(before);
  });
});
