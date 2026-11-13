// warapp_check_plan: a list of orders stress-tested on the live board against each opponent's
// single replies. Synthetic board on the anonymized lobby fixture's map; no war.app traffic.
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { CHECK_PLAN_NOT_COVERED } from '../src/tools/check-plan.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const COMMANDER_ID = '0123456789abcdef0123456789abcdef';
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };

function game(state = 'Playing', bob: Record<string, string> = {}, settings: Record<string, unknown> = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>).map((p, i) =>
    i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob', ...bob } : p,
  );
  return { ...f, state, numberOfTurns: state === 'Playing' ? '2' : '-1', players, settings: { ...(f.settings as object), ...settings } };
}

// Fixture map: 159 Hornwood – 161 Sheepshead Hills – 157 Widow's Watch form bonus 118 (+2);
// 158 Bolton Moors borders all three; 135 borders 159 and 158.
const at = (a159: number, a161: number, bob158: number, neutral157 = 2): SyntheticTerritory[] => [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: a159 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: a161 },
  { id: 157, fogLevel: 2, owner: 0, armies: neutral157 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: bob158 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

async function live(
  territories: SyntheticTerritory[],
  state = 'Playing',
  bob: Record<string, string> = {},
  settings: Record<string, unknown> = {},
): Promise<Harness> {
  return liveHarness({
    feed: [game(state, bob, settings)],
    warapp: (req: DecodedRequest): Partial<ReplyFrame> => {
      if (req.method !== Method.GetLatestGameInfo) throw new Error(`unexpected method ${req.method}`);
      return { body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) };
    },
  });
}

interface Named {
  id: number;
  name: string;
}
interface ReplyView {
  text: string;
  opponent: Named;
  kind: string;
  deploy: number;
  deployTo: Named;
  attack?: { from: Named; to: Named; armies: number };
  attacks?: Array<{ from: Named; to: Named }>;
  attacksTried?: number;
  needsFirstMove: 'you' | 'opponent' | 'either';
  lost: Named[];
  lostMore?: number;
  capturesFailed: Named[];
  retaken: Named[];
  bonusesLost: Array<Named & { value: number }>;
  incomeLost: number;
  commanderLost: boolean;
}
interface CheckPayload {
  game: { id: number; turn: number | null };
  player: Named;
  safe: boolean | null;
  summary: string;
  exact: boolean;
  firstMover: string;
  orderPriority: boolean;
  enemyDeploy: Array<{ player: Named; deploy: number; source: string }>;
  unseenOpponents: Named[];
  plan: {
    captures: Named[];
    failedAttacks: Named[];
    shortOrders: Array<{ order: number; ordered: number; sent: number; result: string; reason?: string }>;
    orders?: unknown[];
  };
  worst: ReplyView | null;
  otherReplies: ReplyView[];
  harmful: number;
  considered: number;
  income: number;
  deployed: number;
  warnings: string[];
  atRisk: { commander: number; territories: Array<{ territory: Named; replies: number }>; territoriesMore?: number; captures: unknown[]; bonuses: unknown[] };
  blindBorders: Named[];
  notCovered: string[];
  assumptions?: string[];
  untrusted_content?: boolean;
}

const check = async (args: Record<string, unknown>) => payload<CheckPayload>(await h!.call('warapp_check_plan', { game_id: GAME, player: 'Ann', ...args }));

describe('warapp_check_plan', () => {
  it('is a read-only tool', async () => {
    h = await live(at(20, 20, 3));
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_check_plan')!;
    expect(tool.annotations?.readOnlyHint).toBe(true);
    expect(tool.description).toMatch(/never submits orders/);
  });

  it('finds no harmful reply for orders that leave every border holding', async () => {
    // Bob's 3 with his 5 make 7 attackers: neither of my 20s falls.
    h = await live(at(20, 20, 3));
    const p = await check({ orders: [{ kind: 'deploy', territory: 159, armies: 5 }] });
    expect(p.safe).toBe(true);
    expect(p.worst).toBeNull();
    expect(p.otherReplies).toEqual([]);
    // Bob's one stack touches both of my territories: two replies.
    expect(p.considered).toBe(2);
    expect(p.summary).toMatch(/^None of the 2 replies tried costs you/);
    expect(p.income).toBe(5);
    expect(p.deployed).toBe(5);
    expect(p.warnings).toEqual([]);
    expect(p.enemyDeploy).toEqual([{ player: { id: Number(BOB.feed), name: 'Bob' }, deploy: 5, source: 'estimate' }]);
    // The fixture's other players hold nothing in view: named, since no reply could be tried for them.
    expect(p.unseenOpponents.length).toBeGreaterThan(0);
    expect(p.unseenOpponents.map((o) => o.id)).not.toContain(Number(BOB.feed));
    // 159 borders the fogged 135: said, since nothing there could be tested.
    expect(p.blindBorders.map((t) => t.id)).toEqual([159]);
    expect(p.summary).toMatch(/border the fog/);
    expect(p.notCovered).toEqual([...CHECK_PLAN_NOT_COVERED]);
    expect(p.exact).toBe(true);
    expect(p.untrusted_content).toBe(true);
  });

  it('names the reply that takes a border the orders emptied, and which side has to move first', async () => {
    // I walk 11 of 12 off Hornwood. Moving first, Bob's 7 then take the 1 left; struck first, the 12 hold.
    h = await live(at(12, 12, 3));
    const orders = [{ kind: 'move', from: 'Hornwood', to: 161, armies: 11 }];
    const p = await check({ orders });
    expect(p.safe).toBe(false);
    expect(p.worst).toMatchObject({
      kind: 'attack',
      deploy: 5,
      deployTo: { id: 158 },
      attack: { from: { id: 158 }, to: { id: 159, name: 'Hornwood' }, armies: 7 },
      needsFirstMove: 'you',
    });
    expect(p.worst!.lost.map((t) => t.id)).toEqual([159]);
    expect(p.worst!.text).toBe('If player 7176543229 deploys 5 on territory 158 and attacks territory 159 with 7, and you move first: you lose territory 159.');
    expect(p.summary).toBe(`1 of the 2 replies tried costs you something. Worst: ${p.worst!.text}`);
    expect(p.atRisk.territories).toEqual([{ territory: { id: 159, name: 'Hornwood' }, replies: 1 }]);
    // Knowing who moves first settles it either way.
    expect((await check({ orders, first_mover: 'opponent' })).safe).toBe(true);
    expect((await check({ orders, first_mover: 'me' })).safe).toBe(false);
  });

  it('an Order Priority play in the orders makes my first order run first, whoever moves first', async () => {
    h = await live(at(12, 12, 3));
    const move = { kind: 'move', from: 159, to: 161, armies: 11 };
    const p = await check({ orders: [{ kind: 'card', card: 'Order Priority' }, move], first_mover: 'opponent' });
    expect(p.orderPriority).toBe(true);
    // My transfer now runs before Bob's attack, so the emptied border falls after all.
    expect(p.safe).toBe(false);
    expect(p.worst!.lost.map((t) => t.id)).toEqual([159]);
  });

  it('tests a stronger opponent with enemy_deploy', async () => {
    h = await live(at(20, 20, 3));
    const p = await check({ orders: [{ kind: 'deploy', territory: 159, armies: 5 }], enemy_deploy: 40 });
    // 42 attackers kill 25: each 20 falls to it, the reinforced 25 holds only when struck after the deploy.
    expect(p.safe).toBe(false);
    expect(p.enemyDeploy[0]).toMatchObject({ deploy: 40, source: 'enemy_deploy' });
    expect(p.atRisk.territories.map((t) => t.territory.id)).toContain(161);
  });

  it('reports a capture that is taken straight back, and an attack that fails when reinforced', async () => {
    h = await live(at(12, 12, 6));
    // Take the neutral 157 with 3 (2 survive beside Bob's stack), and hit Bob's 6 with 10.
    const p = await check({
      orders: [
        { kind: 'move', from: 161, to: 157, armies: 3 },
        { kind: 'move', from: 159, to: 158, armies: 10 },
      ],
      view: 'full',
    });
    expect(p.plan.captures.map((t) => t.id)).toEqual([157, 158]);
    expect(p.safe).toBe(false);
    const all = [p.worst!, ...p.otherReplies];
    const reinforce = all.find((r) => r.kind === 'reinforce')!;
    expect(reinforce.capturesFailed.map((t) => t.id)).toEqual([158]);
    // Bob's 6 + 5 strike the 2 armies I left on 157 after my capture ran: taken straight back.
    const back = all.find((r) => r.kind === 'attack' && r.attack!.to.id === 157 && r.needsFirstMove === 'you')!;
    expect(back.retaken.map((t) => t.id)).toEqual([157]);
    expect(back.capturesFailed).toEqual([]);
    expect(p.plan.orders).toHaveLength(2);
    expect(p.assumptions).toBeDefined();
  });

  it('lists, for an attack by every stack at once, only the attacks on what was lost', async () => {
    // Bob also holds 135 (it touches Hornwood): two stacks, so the all-out reply is tried.
    h = await live([
      { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 3 },
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
      { id: 157, fogLevel: 2, owner: 0, armies: 2 },
      { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 9 },
      { id: 135, fogLevel: 1, owner: BOB.inGame, armies: 9 },
    ]);
    const p = await check({ orders: [{ kind: 'deploy', territory: 161, armies: 5 }], view: 'full' });
    const all = [p.worst!, ...p.otherReplies].find((r) => r.kind === 'all-attack' && r.attacksTried === 2 && r.attacks!.length === 1)!;
    // 135 (the larger after its deploy) takes Hornwood; 158 goes for the other border and fails on its 8.
    expect(all.attacksTried).toBe(2);
    expect(all.attacks!.map((a) => `${a.from.id}>${a.to.id}`)).toEqual(['135>159']);
    expect(all.lost.map((t) => t.id)).toEqual([159]);
    expect(all.text).toMatch(/attacks with every stack at once \(2 attacks\)/);
    expect(p.blindBorders).toEqual([]);
  });

  it('shows orders that send fewer armies than ordered, or none', async () => {
    h = await live(at(4, 20, 3));
    const p = await check({ orders: [{ kind: 'move', from: 159, to: 161, armies: 9 }] });
    expect(p.plan.shortOrders).toEqual([expect.objectContaining({ order: 1, ordered: 9, sent: 3, result: 'transferred' })]);
  });

  it('tests every stack on the board, whoever holds it: a booted player\'s armies still attack', async () => {
    // GameFeed says Bob is no longer playing; his 60 are on the board all the same.
    h = await live(at(2, 2, 60), 'Playing', { state: 'Booted' });
    const p = await check({ orders: [{ kind: 'deploy', territory: 159, armies: 5 }] });
    expect(p.safe).toBe(false);
    expect(p.enemyDeploy.map((e) => e.player.id)).toEqual([Number(BOB.feed)]);
    expect(p.considered).toBeGreaterThan(0);
  });

  it('says nothing was tested, never "safe", when no opposing stack is in view', async () => {
    h = await live([
      { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
      { id: 157, fogLevel: 2, owner: 0, armies: 2 },
      { id: 158, fogLevel: 3, owner: BOB.inGame, armies: 0, fogged: true },
      { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
    ]);
    const p = await check({ orders: [{ kind: 'deploy', territory: 159, armies: 5 }] });
    expect(p.safe).toBeNull();
    expect(p.considered).toBe(0);
    expect(p.summary).toMatch(/^Nothing could be tested/);
    expect(p.blindBorders.map((t) => t.id).sort()).toEqual([159, 161]);
    expect(p.unseenOpponents.map((o) => o.id)).toContain(Number(BOB.feed));
  });

  it('refuses a deploy on a territory that is not mine, and warns when the deploys are not my income', async () => {
    h = await live(at(20, 20, 3));
    const bad = await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 158, armies: 5 }] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/not yours/);
    const over = await check({ orders: [{ kind: 'deploy', territory: 159, armies: 400 }] });
    expect(over.deployed).toBe(400);
    expect(over.warnings.join(' ')).toMatch(/deploy 400.*income is 5/);
  });

  it('says so when battles are not exact, and names what it did not try', async () => {
    h = await live(at(20, 20, 3), 'Playing', {}, { LuckModifier: 0.16, MultiAttack: true });
    const p = await check({ orders: [{ kind: 'deploy', territory: 159, armies: 5 }, { kind: 'card', card: 'Blockade', target: 161 }] });
    expect(p.exact).toBe(false);
    expect(p.summary).toMatch(/not exact/);
    expect(p.notCovered.join(' ')).toMatch(/Multi-Attack/);
    expect(p.notCovered.join(' ')).toMatch(/card play other than/);
  });

  it('keeps the answer small when a reply costs everything: a count, not every territory', async () => {
    // My commander on Hornwood behind 2 armies, 12 more territories elsewhere; Bob's 40 kill it.
    const others: SyntheticTerritory[] = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111].map((id) => ({ id, fogLevel: 1, owner: ANN.inGame, armies: 1 }));
    h = await live(
      [
        { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 2, units: [{ kind: 'commander', id: COMMANDER_ID, owner: ANN.inGame }] },
        { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
        { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 40 },
        ...others,
      ],
      'Playing',
      {},
      { Commanders: true },
    );
    const p = await check({ orders: [{ kind: 'deploy', territory: 161, armies: 5 }] });
    expect(p.worst).toMatchObject({ commanderLost: true });
    expect(p.worst!.lost.length).toBeLessThanOrEqual(10);
    expect(p.worst!.lostMore).toBe(4);
    expect(p.worst!.text).toMatch(/you lose your commander and the game/);
    expect(p.atRisk.commander).toBeGreaterThan(0);
    expect(p.atRisk.territories.length).toBeLessThanOrEqual(10);
  });

  it('never treats a teammate\'s stack as an opponent\'s', async () => {
    // Cid (in-game 222222) is on my team and holds 135 beside Hornwood with 50 armies.
    const CID = { feed: '5522222277', inGame: 222222 };
    const f = lobbyFixture();
    const players = (f.players as Array<Record<string, string>>).map((p, i) =>
      i === 0 ? { ...p, id: ANN.feed, name: 'Ann', team: '0' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob', team: '1' } : i === 2 ? { ...p, id: CID.feed, name: 'Cid', team: '0' } : { ...p, team: '1' },
    );
    const territories: SyntheticTerritory[] = [
      { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 2 },
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 20 },
      { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 1 },
      { id: 135, fogLevel: 1, owner: CID.inGame, armies: 50 },
    ];
    h = await liveHarness({
      feed: [{ ...f, state: 'Playing', numberOfTurns: '2', players }],
      warapp: () => ({ body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) }),
    });
    const p = await check({ orders: [{ kind: 'move', from: 159, to: 135, armies: 1 }] });
    expect(p.enemyDeploy.map((e) => e.player.name)).toEqual(['Bob']);
    // Bob's 1 + 5 − 1 = 5 take Hornwood's last army once mine has left for the teammate.
    expect(p.safe).toBe(false);
    expect(p.worst!.opponent.name).toBe('Bob');
    expect(p.plan.captures).toEqual([]);
  });

  it('the compact view lists the worst reply and two more; full lists them all', async () => {
    // Five of my territories each beside the same big stack: five single replies and more.
    h = await live([
      { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 1 },
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 1 },
      { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 1 },
      { id: 135, fogLevel: 1, owner: ANN.inGame, armies: 1 },
      { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 9 },
    ]);
    const orders = [{ kind: 'deploy', territory: 159, armies: 5 }];
    const compact = await check({ orders });
    const full = await check({ orders, view: 'full' });
    expect(compact.otherReplies).toHaveLength(2);
    expect(full.otherReplies.length).toBeGreaterThan(2);
    expect(full.harmful).toBe(compact.harmful);
    expect(full.otherReplies.slice(0, 2)).toEqual(compact.otherReplies);
  });

  it('refuses outside a turn phase', async () => {
    h = await live(at(20, 20, 3), 'DistributingTerritories');
    const res = await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 159, armies: 5 }] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/turn/i);
  });
});
