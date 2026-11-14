// warapp_check_plan: a list of orders stress-tested on the live board against each opponent's
// single replies. Synthetic board on the anonymized lobby fixture's map; no war.app traffic.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as analysis from '../src/analysis/index.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { CHECK_PLAN_NOT_COVERED } from '../src/tools/check-plan.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

// A pass-through spy on planEnemyEstimates, to see what warapp_check_plan hands it (#164).
vi.mock('../src/analysis/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/analysis/index.js')>();
  return { ...actual, planEnemyEstimates: vi.fn(actual.planEnemyEstimates) };
});

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
  atRisk: {
    commander: number;
    territories: Array<{ territory: Named; replies: number }>;
    territoriesMore?: number;
    captures: Array<{ territory: Named; replies: number }>;
    capturesMore?: number;
    bonuses: unknown[];
    bonusesMore?: number;
  };
  exposedNextTurn: Array<{
    text: string;
    territory: Named;
    armies: number;
    needs: number;
    attackers: number;
    from: Named;
    via: Named;
    opponent: Named;
    bonusesLost: Array<Named & { value: number }>;
    incomeLost: number;
  }>;
  exposedMore?: number;
  blindBorders: Named[];
  leader: boolean;
  dodges: Array<{
    text: string;
    opponent: Named;
    stack: Named;
    exit: Named;
    exitOwner: string;
    took: boolean;
    escaped: number;
    commander: boolean;
    strikes: Array<{ from: Named; result: string; sent: number }>;
    harmful: boolean;
  }>;
  jointFalls: unknown[];
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

  it("#164: passes the fog setting and an opponent's Reinforcement clock to the estimates", async () => {
    const spy = vi.mocked(analysis.planEnemyEstimates);
    const orders = [{ kind: 'deploy', territory: 159, armies: 5 }];
    // The fixture's Reinforcement card is progressive with none in hand: what it adds is unknown.
    h = await live(at(20, 20, 3));
    spy.mockClear();
    const plain = await check({ orders });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0].game).toMatchObject({ fog: 'Foggy' });
    expect(spy.mock.calls[0]![0].game).not.toHaveProperty('reinforcement');
    await h.harness.close();
    // A fixed 20-army card, in a hand from the start: Bob's deploy carries it.
    const fixed = { ReinforcementCard: { NumPieces: 1, InitialPieces: 1, MinimumPiecesPerTurn: 1, Weight: 1.0, FixedArmies: 20 } };
    h = await live(at(20, 20, 3), 'Playing', {}, fixed);
    spy.mockClear();
    const carded = await check({ orders });
    expect(spy.mock.calls[0]![0].game).toMatchObject({ fog: 'Foggy', reinforcement: expect.objectContaining({ armies: 20 }) });
    expect(carded.enemyDeploy[0]!.deploy).toBe(plain.enemyDeploy[0]!.deploy + 20);
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

  it('carries order options to the resolver, and warns when the game would refuse one (#165)', async () => {
    h = await live(at(10, 20, 3), 'Playing', {}, { AllowTransferOnly: true });
    // Transfer Only onto Bob's stack does nothing: the order is skipped, not an attack.
    const p = await check({ orders: [{ kind: 'move', from: 159, to: 158, armies: 9, mode: 'transfer-only' }] });
    expect(p.plan.shortOrders).toEqual([expect.objectContaining({ order: 1, ordered: 9, sent: 0, reason: 'transfer-only' })]);
    expect(p.warnings.join('\n')).not.toMatch(/would refuse/);
    await h.harness.close();
    h = await live(at(10, 20, 3));
    const off = await check({ orders: [{ kind: 'move', from: 159, to: 161, armies: 50, percent: true }] });
    expect(off.warnings.join('\n')).toMatch(/percentage.*war\.app would refuse/is);
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

  it('shows a stack I strike stepping out first, and what my strike then hits (#180)', async () => {
    // I hit Bob's 3 on 158 with 19. Moving first, his 3 and 5 send 7 into the neutral 157 (2): 6 get away.
    h = await live(at(20, 20, 3));
    const orders = [{ kind: 'move', from: 159, to: 158, armies: 19 }];
    const p = await check({ orders });
    expect(p.leader).toBe(false);
    expect(p.jointFalls).toEqual([]);
    expect(p.dodges).toEqual([
      expect.objectContaining({
        opponent: { id: Number(BOB.feed), name: 'Bob' },
        stack: expect.objectContaining({ id: 158 }),
        exit: expect.objectContaining({ id: 157 }),
        exitOwner: 'neutral',
        took: true,
        escaped: 6,
        strikes: [{ from: expect.objectContaining({ id: 159 }), result: 'captured', sent: 19 }],
      }),
    ]);
    expect(p.dodges[0]!.text).toMatch(/out first into territory 157 \(neutral\), 6 getting away\. Your strike on territory 158 then captured\./);
    expect(p.summary).toMatch(/1 of the stacks you attack can move out first and get away/);
    // Known to move first, I strike it where it stands: no dodge is tried.
    expect((await check({ orders, first_mover: 'me' })).dodges).toEqual([]);
  });

  it('tries two free-for-all opponents on one territory when I lead, and says what would hold it (#180)', async () => {
    // A third player, Cy, on 135 (it touches Hornwood 159 and Bob's 158). I hold bonus 118 (+2): my 7 beat their 5s.
    const CY = { feed: '5523456781', inGame: 234567 };
    const g = game();
    (g.players as Array<Record<string, string>>)[2] = { ...(g.players as Array<Record<string, string>>)[2]!, id: CY.feed, name: 'Cy' };
    const territories: SyntheticTerritory[] = [
      { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 20 },
      { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 20 },
      { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 4 },
      { id: 135, fogLevel: 1, owner: CY.inGame, armies: 4 },
    ];
    h = await liveHarness({
      feed: [g],
      warapp: (req: DecodedRequest): Partial<ReplyFrame> => {
        if (req.method !== Method.GetLatestGameInfo) throw new Error(`unexpected method ${req.method}`);
        return { body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) };
      },
    });
    const p = await check({ orders: [{ kind: 'deploy', territory: 159, armies: 7 }] });
    expect(p.income).toBe(7);
    expect(p.leader).toBe(true);
    // Each side brings 8 and kills 5: together 10 of my 13 on Hornwood, so nothing falls.
    expect(p.jointFalls).toEqual([]);
    const thin = await check({ orders: [{ kind: 'deploy', territory: 161, armies: 7 }] });
    // My 6 on Hornwood: 8 from each side kill 5 and 5 — it needs 11.
    expect(thin.jointFalls).toEqual([
      expect.objectContaining({ territory: expect.objectContaining({ id: 159 }), armies: 6, needs: 11, attackers: [8, 8] }),
    ]);
    expect(thin.safe).toBe(false);
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

  it('looks one turn ahead: a territory two steps from a stack, behind one it can take this turn (#156)', async () => {
    // Bob's 20 on Knife Hills touch Hornwood (1 army) but not Sheepshead Hills (1 army) behind it.
    const two: SyntheticTerritory[] = [
      { id: 135, fogLevel: 1, owner: BOB.inGame, armies: 20 },
      { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 1 },
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 1 },
      { id: 158, fogLevel: 2, owner: 0, armies: 2 },
      { id: 157, fogLevel: 2, owner: 0, armies: 2 },
    ];
    h = await live(two);
    const p = await check({ orders: [{ kind: 'deploy', territory: 159, armies: 5 }] });
    // Two ways through: Hornwood (6 after my deploy) or the 2-army neutral Bolton Moors. The neutral
    // costs the stack less (23 survive, against 20), so that is the path reported: 23 + 5 − 1 = 27.
    expect(p.exposedNextTurn).toEqual([
      expect.objectContaining({
        territory: { id: 161, name: 'Sheepshead Hills' },
        armies: 1,
        attackers: 27,
        needs: 17,
        from: { id: 135, name: 'Knife Hills' },
        via: { id: 158, name: 'Bolton Moors' },
        opponent: { id: Number(BOB.feed), name: 'Bob' },
        bonusesLost: [],
        incomeLost: 0,
      }),
    ]);
    expect(p.exposedNextTurn[0]!.text).toBe(
      `Next turn player ${BOB.feed} can reach territory 161 (1 there) with 27 from territory 135 by taking territory 158 this turn: it needs 17 to hold.`,
    );
    expect(p.summary).toMatch(/Next turn: 1 territory .* within reach/);
    // Enough armies behind, and it is no longer listed.
    const held = await check({ orders: [{ kind: 'deploy', territory: 161, armies: 60 }] });
    expect(held.exposedNextTurn).toEqual([]);
    expect(held.summary).not.toMatch(/Next turn/);
  });

  it('counts what a capped at-risk list leaves out (#154, #161)', async () => {
    // Twelve separate fronts on the fixture map, each a territory of mine (4 armies), a neutral
    // beside it (2) and a stack of Bob's beside that (30): I take every neutral with 3, and each
    // can be taken straight back. Twelve captures at risk, two more than a list names.
    const map = lobbyFixture().map as { territories: Array<{ id: string; connectedTo: Array<string | number> }> };
    const links = new Map<number, Set<number>>();
    for (const t of map.territories) links.set(Number(t.id), new Set());
    for (const t of map.territories) {
      for (const n of t.connectedTo.map(Number)) {
        if (!links.has(n) || n === Number(t.id)) continue;
        links.get(Number(t.id))!.add(n);
        links.get(n)!.add(Number(t.id));
      }
    }
    const used = new Set<number>();
    const fronts: Array<{ mine: number; neutral: number; bob: number }> = [];
    for (const [neutral, around] of [...links].sort((x, y) => x[0] - y[0])) {
      if (fronts.length === 12) break;
      // Keep the fronts apart: nothing in or next to one may touch another.
      const free = [...around].filter((id) => !used.has(id)).sort((x, y) => x - y);
      if (used.has(neutral) || free.length < 2) continue;
      const [mine, bob] = free as [number, number];
      const zone = [neutral, mine, bob, ...links.get(mine)!, ...links.get(bob)!, ...around];
      if (zone.some((id) => used.has(id))) continue;
      fronts.push({ mine, neutral, bob });
      for (const id of zone) used.add(id);
    }
    expect(fronts).toHaveLength(12);
    h = await live(
      fronts.flatMap((f): SyntheticTerritory[] => [
        { id: f.mine, fogLevel: 1, owner: ANN.inGame, armies: 4 },
        { id: f.neutral, fogLevel: 2, owner: 0, armies: 2 },
        { id: f.bob, fogLevel: 1, owner: BOB.inGame, armies: 30 },
      ]),
    );
    const p = await check({ orders: fronts.map((f) => ({ kind: 'move', from: f.mine, to: f.neutral, armies: 3 })) });
    expect(p.plan.captures).toHaveLength(12);
    expect(p.atRisk.captures).toHaveLength(10);
    expect(p.atRisk.capturesMore).toBe(2);
    // No bonus is held here, so that list is empty and gives no count.
    expect(p.atRisk.bonuses).toEqual([]);
    expect(p.atRisk.bonusesMore).toBeUndefined();
  });

  it('works from the estimates warapp_plan_turn uses: the fog prior in an even-start 1v1', async () => {
    // A 1v1 (only Ann and Bob) that started even: Bob borders the fog (135), so he is assumed to
    // earn at least my own income, 5 + bonus 118's 2 = 7, not only the 5 he visibly earns.
    const f = lobbyFixture();
    const players = (f.players as Array<Record<string, string>>)
      .slice(0, 2)
      .map((p, i) => (i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : { ...p, id: BOB.feed, name: 'Bob' }));
    const territories: SyntheticTerritory[] = [
      { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 20 },
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 20 },
      { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 20 },
      { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 3 },
      { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
    ];
    h = await liveHarness({
      feed: [{ ...f, state: 'Playing', numberOfTurns: '2', players }],
      warapp: () => ({ body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) }),
    });
    const p = await check({ orders: [{ kind: 'deploy', territory: 159, armies: 7 }] });
    expect(p.income).toBe(7);
    expect(p.enemyDeploy).toEqual([{ player: { id: Number(BOB.feed), name: 'Bob' }, deploy: 7, source: 'estimate' }]);
  });

  it('reads the opening board on the first turn only: equal stacks mid-game are not the opening (#128)', async () => {
    // Turn 3, no earlier board cached: every visible player stack holds 4, but Bob visibly holds
    // bonus 118 (+2), so he earns 7, not the opening floor of 5.
    h = await live([
      { id: 159, fogLevel: 1, owner: BOB.inGame, armies: 4 },
      { id: 161, fogLevel: 1, owner: BOB.inGame, armies: 4 },
      { id: 157, fogLevel: 1, owner: BOB.inGame, armies: 4 },
      { id: 158, fogLevel: 1, owner: ANN.inGame, armies: 4 },
    ]);
    const p = await check({ orders: [{ kind: 'deploy', territory: 158, armies: 5 }] });
    expect(p.game.turn).toBeGreaterThan(1);
    expect(p.enemyDeploy).toEqual([{ player: { id: Number(BOB.feed), name: 'Bob' }, deploy: 7, source: 'estimate' }]);
  });

  it('refuses outside a turn phase', async () => {
    h = await live(at(20, 20, 3), 'DistributingTerritories');
    const res = await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 159, armies: 5 }] });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/turn/i);
  });
});
