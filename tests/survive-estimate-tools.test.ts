// #275 pattern 1 through the tools: the headroom table in warapp_plan_turn and warapp_check_plan, the
// broken-estimate tripwire read from my board history and kept in the board cache's side store, and
// warapp_submit_turn's warning for a held bonus's border left below my own income. Synthetic board on
// the anonymized lobby fixture's map; no war.app traffic.
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../src/board.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { readSurvival, writeBoardCache, writeOrdersCache, writeSurvival } from '../src/trend.js';
import { liveHarness, lobbyFixture, payload, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const ME_PAGE = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

// A 1v1 (the fixture's other seats dropped: with nine seats and no team read, the teams are unknown) with
// no Airlift in play (one lands armies anywhere: the tripwire reads nothing then).
function game(turnsDone = '2', o: { allSeats?: boolean; airlift?: boolean; bomb?: boolean; bobOut?: boolean } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>)
    .map((p, i) =>
      i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob', ...(o.bobOut ? { state: 'SurrenderAccepted' } : {}) } : p,
    )
    .slice(0, o.allSeats ? undefined : 2);
  const settings = { ...(f.settings as object), SanctionsCard: 'none', ...(o.airlift ? {} : { AirliftCard: 'none' }), ...(o.bomb ? { BombCard: { NumPieces: 6, InitialPieces: 6, MinimumPiecesPerTurn: 0, Weight: 1.0 } } : {}) };
  return { ...f, state: 'Playing', numberOfTurns: turnsDone, players, settings };
}

// Fixture map: 159 Hornwood – 161 Sheepshead Hills – 157 Widow's Watch form bonus 118 (+2); 158 Bolton
// Moors borders all three; 1567 borders 161 and 157; 135 borders 159 and 158.
async function live(territories: SyntheticTerritory[], dataDir?: string, feed = [game()]): Promise<Harness> {
  return liveHarness({
    feed,
    pages: ME_PAGE,
    ...(dataDir ? { dataDir } : {}),
    warapp: (req: DecodedRequest): Partial<ReplyFrame> => {
      if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) };
      throw new Error(`unexpected method ${req.method}`);
    },
  });
}

interface HeadroomView {
  territory: { id: number; name: string };
  armies: number;
  deploy: number | null;
  opponent: number;
  from: { id: number };
  needsFirstMove?: string;
  belowMyIncome: boolean;
  bonuses: Array<{ id: number; value: number }>;
  breach: { territories: Array<{ id: number }>; income: number };
}
interface Checked {
  headroom: HeadroomView[];
  warnings: string[];
  enemyDeploy: Array<{ player: { id: number }; deploy: number; source: string }>;
}

const two: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 20 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 20 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 3 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

describe('the headroom table (#275 a)', () => {
  it('warapp_check_plan gives each border the smallest single deploy that takes it after the orders, weakest first', async () => {
    h = await live(two);
    const p = payload<Checked>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 159, armies: 5 }] }));
    // Bob's 3 send 2: my 20 on 161 need 33 (a deploy of 31), my 25 on 159 need 41 (39).
    expect(p.headroom.map((r) => [r.territory.id, r.armies, r.deploy, r.from.id, r.belowMyIncome])).toEqual([
      [161, 20, 31, 158, false],
      [159, 25, 39, 158, false],
    ]);
    expect(p.headroom[0]!.opponent).toBe(Number(BOB.feed));
    // #275 pattern 2: each row says what a breach of it opens; both borders face Bob, nothing lies behind.
    for (const r of p.headroom) expect(r.breach).toEqual({ territories: [], income: 0 });
  });

  it('warapp_plan_turn gives it on the plan\'s orders', async () => {
    h = await live(two);
    const p = payload<{ headroom: HeadroomView[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.headroom.map((r) => r.territory.id).sort()).toEqual(expect.arrayContaining([159, 161]));
    for (const r of p.headroom) expect(r.from.id).toBe(158);
  });
});

describe('the broken-estimate tripwire (#275 b)', () => {
  const owner = (id: string): TerritoryState['owner'] => ({ kind: 'player', playerId: Number(id) });
  const prev: BoardState = {
    source: 'browser',
    verified: true,
    territories: [
      { territoryId: 159, owner: owner(ANN.feed), armies: 20 },
      { territoryId: 161, owner: owner(ANN.feed), armies: 20 },
      { territoryId: 157, owner: owner(ANN.feed), armies: 10 },
      { territoryId: 158, owner: owner(BOB.feed), armies: 3 },
      { territoryId: 1567, owner: { kind: 'neutral' }, armies: 2 },
      { territoryId: 135, owner: { kind: 'unknown' }, armies: null, fogLevel: 'Fogged' },
    ],
  };
  // Bob took my 10 on 157 from his 3 on 158: 16 attackers needed, where 2 and a deploy of 5 allow 7.
  const now: SyntheticTerritory[] = [
    { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 20 },
    { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 20 },
    { id: 157, fogLevel: 1, owner: BOB.inGame, armies: 8 },
    { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 1 },
    { id: 1567, fogLevel: 1, owner: 0, armies: 2 },
    { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
  ];

  // My orders as this server caches them (`myOrdersOf`): `sent` lists every move order, here none.
  async function seeded(orders: { deploys: []; moves: []; sent?: [] } = { deploys: [], moves: [], sent: [] }): Promise<string> {
    const probe = await live(two);
    const dir = probe.dataDir;
    await probe.harness.close();
    await writeBoardCache(dir, GAME, Number(ANN.feed), 2, prev);
    await writeOrdersCache(dir, GAME, Number(ANN.feed), 2, orders);
    await writeSurvival(dir, GAME, Number(ANN.feed), 2, { estimates: new Map([[Number(BOB.feed), 5]]), tripwires: [] });
    return dir;
  }

  it('warapp_plan_turn marks the opponent untrusted, says so first and keeps the mark', async () => {
    const dir = await seeded();
    h = await live(now, dir);
    const p = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.warnings[0]).toMatch(new RegExp(`^Player ${BOB.feed}'s deploy estimate .*untrusted until turn 5.*capture on territory 157 needed 16 armies where the estimate allowed 7`));
    // The figure the warning names is the one the plan was sized for: the larger of 14 and my income.
    expect(p.warnings[0]).toMatch(/are sized for 14 /);
    const kept = await readSurvival(dir, GAME, Number(ANN.feed));
    expect(kept.tripwires).toEqual([
      { player: Number(BOB.feed), since: 3, until: 5, kind: 'capture', territory: 157, observed: 16, allowed: 7, implied: 14 },
    ]);
    expect(kept.estimates.get(3)?.has(Number(BOB.feed))).toBe(true);
  });

  it('warapp_plan_turn under enemy_deploy still names the mark but not a sizing the what-if does not use', async () => {
    const dir = await seeded();
    h = await live(now, dir);
    const p = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', enemy_deploy: 3 }));
    expect(p.warnings[0]).toMatch(/untrusted until turn 5/);
    expect(p.warnings[0]).not.toMatch(/are sized for/);
    expect(p.warnings[0]).toMatch(/would be sized for 14 /);
    expect(p.warnings[0]).toMatch(/This what-if plan sizes every border for enemy_deploy 3 instead/);
    // The mark and the default estimate are kept as the default plan keeps them: both come from the
    // boards, never from enemy_deploy.
    const kept = await readSurvival(dir, GAME, Number(ANN.feed));
    expect(kept.tripwires.map((w) => [w.player, w.implied])).toEqual([[Number(BOB.feed), 14]]);
    expect(kept.estimates.get(3)?.get(Number(BOB.feed))).not.toBe(3);
  });

  it('warapp_check_plan tries the untrusted figure by default and says so first, writing nothing', async () => {
    const dir = await seeded();
    h = await live(now, dir);
    const p = payload<Checked>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [] }));
    expect(p.warnings[0]).toMatch(/untrusted.*are sized for 14 /);
    // My income is 5: the larger of 14 and 5.
    expect(p.enemyDeploy).toEqual([{ player: { id: Number(BOB.feed), name: 'Bob' }, deploy: 14, source: 'untrusted' }]);
    expect((await readSurvival(dir, GAME, Number(ANN.feed))).tripwires).toEqual([]);
    // enemy_deploy is a what-if: it wins, and no warning is made of the mark.
    const w = payload<Checked>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [], enemy_deploy: 3 }));
    expect(w.enemyDeploy[0]).toMatchObject({ deploy: 3, source: 'enemy_deploy' });
    expect(w.warnings.some((x) => /untrusted/.test(x))).toBe(false);
  });

  it('reads nothing from orders cached before `sent` existed: what left my territory is unknown', async () => {
    const dir = await seeded({ deploys: [], moves: [] });
    h = await live(now, dir);
    const p = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.warnings.some((x) => /untrusted/.test(x))).toBe(false);
    expect((await readSurvival(dir, GAME, Number(ANN.feed))).tripwires).toEqual([]);
  });

  it('reads nothing when an opponent may hold an Airlift card: armies it lands look like income', async () => {
    const dir = await seeded();
    h = await live(now, dir, [game('2', { airlift: true })]);
    const p = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.warnings.some((x) => /untrusted/.test(x))).toBe(false);
    expect((await readSurvival(dir, GAME, Number(ANN.feed))).tripwires).toEqual([]);
  });

  it('reads nothing while the teams are unknown, and flags each headroom row: the opponent may be a teammate', async () => {
    const dir = await seeded();
    h = await live(now, dir, [game('2', { allSeats: true })]);
    const p = payload<{ warnings: string[]; headroom: Array<HeadroomView & { mayBeTeammate?: boolean }> }>(
      await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }),
    );
    expect(p.warnings.some((x) => /untrusted/.test(x))).toBe(false);
    expect((await readSurvival(dir, GAME, Number(ANN.feed))).tripwires).toEqual([]);
    expect(p.headroom.length).toBeGreaterThan(0);
    for (const r of p.headroom) expect(r.mayBeTeammate).toBe(true);
    const c = payload<Checked & { headroom: Array<{ mayBeTeammate?: boolean }> }>(
      await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [] }),
    );
    expect(c.warnings.some((x) => /untrusted/.test(x))).toBe(false);
    for (const r of c.headroom) expect(r.mayBeTeammate).toBe(true);
  });

  it('keeps a running mark unchanged, and applies none, while the teams are unknown for a plan', async () => {
    const dir = await seeded();
    const mark = { player: Number(BOB.feed), since: 2, until: 4, kind: 'fog-stack' as const, territory: 158, observed: 40, allowed: 12, implied: 20 };
    await writeSurvival(dir, GAME, Number(ANN.feed), 2, { estimates: new Map([[Number(BOB.feed), 5]]), tripwires: [mark] });
    h = await live(now, dir, [game('2', { allSeats: true })]);
    const p = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.warnings.some((x) => /untrusted/.test(x))).toBe(false);
    const kept = await readSurvival(dir, GAME, Number(ANN.feed));
    expect(kept.tripwires).toEqual([mark]);
    // This turn's estimates are still kept.
    expect(kept.estimates.has(3)).toBe(true);
  });

  it('reads nothing when an opponent may hold a Bomb card: one halves my territory before it is taken', async () => {
    const dir = await seeded();
    h = await live(now, dir, [game('2', { bomb: true })]);
    const p = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.warnings.some((x) => /untrusted/.test(x))).toBe(false);
    expect((await readSurvival(dir, GAME, Number(ANN.feed))).tripwires).toEqual([]);
  });

  it('reads nothing of a static seat (#270), even with an estimate kept for it from before it went out', async () => {
    const dir = await seeded();
    h = await live(now, dir, [game('2', { bobOut: true })]);
    const p = payload<{ warnings: string[] }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
    expect(p.warnings.some((x) => /untrusted/.test(x))).toBe(false);
    expect((await readSurvival(dir, GAME, Number(ANN.feed))).tripwires).toEqual([]);
    const c = payload<Checked>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [] }));
    expect(c.warnings.some((x) => /untrusted/.test(x))).toBe(false);
  });

  it('reads nothing without the previous board', async () => {
    h = await live(now);
    const p = payload<Checked>(await h.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [] }));
    expect(p.warnings.some((x) => /untrusted/.test(x))).toBe(false);
    expect(p.enemyDeploy[0]!.source).toBe('estimate');
  });
});

describe('warapp_submit_turn warns of a held bonus left below my income (#275 c)', () => {
  const held: SyntheticTerritory[] = [
    { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 10 },
    { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 10 },
    { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 10 },
    { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 3 },
    { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
  ];
  const preview = async (orders: unknown[]) => JSON.stringify(payload(await h!.call('warapp_submit_turn', { game_id: GAME, orders })));

  it('names the border, the deploy that takes it and my income, and still previews', async () => {
    h = await live(held);
    // Walking 9 off Hornwood leaves 1, which Bob's 3 take with no deploy whoever moves first: moving
    // first, he holds his attack back behind a filler order until my transfer has gone.
    const text = await preview([
      { kind: 'deploy', territory: 157, armies: 7 },
      { kind: 'move', from: 159, to: 161, armies: 9 },
    ]);
    expect(text).toMatch(/Territory 159 guards bonus 118 \(\+2\) and these orders leave it falling to a deploy of 0 by player 7176543229 on territory 158: below your own income of 7/);
    expect(text).toMatch(/confirmToken/);
  });

  it('says the opponent may be a teammate while the teams are unknown', async () => {
    h = await live(held, undefined, [game('2', { allSeats: true })]);
    const text = await preview([
      { kind: 'deploy', territory: 157, armies: 7 },
      { kind: 'move', from: 159, to: 161, armies: 9 },
    ]);
    expect(text).toMatch(/Territory 159 guards bonus 118 .*player 7176543229 \(may be a teammate: this game's teams could not be read\)/);
  });

  it('says nothing of a static seat (#270): a player out whose seat no AI plays deploys nothing', async () => {
    h = await live(held, undefined, [game('2', { bobOut: true })]);
    const text = await preview([
      { kind: 'deploy', territory: 157, armies: 7 },
      { kind: 'move', from: 159, to: 161, armies: 9 },
    ]);
    expect(text).toMatch(/confirmToken/);
    expect(text).not.toMatch(/#275 headroom/);
  });

  it('says nothing when every border of the bonus has headroom above my income', async () => {
    h = await live(held);
    const text = await preview([{ kind: 'deploy', territory: 159, armies: 7 }]);
    expect(text).not.toMatch(/#275 headroom/);
  });
});
