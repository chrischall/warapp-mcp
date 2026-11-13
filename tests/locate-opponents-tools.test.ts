// warapp_locate_opponents: where each opponent is and what it is doing, from the boards this
// server saw, the kept pickable territories, the award of picks and cached map statistics.
// Synthetic boards on the anonymized lobby fixture's map; no war.app traffic.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPickRecord, writePickable, writePickList } from '../src/pick-list.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { recordPath } from '../src/stats.js';
import { boardCachePath } from '../src/trend.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
const MAP = 39905;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };
const CAT = { feed: '5524681355', inGame: 246813 };
const ME = Number(ANN.feed);
const SIGNED_IN_ANN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

/** A game of the first `seats` players of the fixture on turn `turn`: two starts each, 5 armies on a start. */
function game(turn = 1, settings: Record<string, unknown> = {}, seats = 2, state = 'Playing'): Record<string, unknown> {
  const f = lobbyFixture();
  const ids = [ANN, BOB, CAT];
  const players = (f.players as Array<Record<string, string>>)
    .slice(0, seats)
    .map((p, i) => ({ ...p, id: ids[i]!.feed, name: ['Ann', 'Bob', 'Cat'][i]!, state: 'Playing' }));
  return {
    ...f,
    state,
    numberOfTurns: String(turn - 1),
    players,
    settings: { ...(f.settings as object), InitialPlayerArmiesPerTerritory: 5, TerritoryLimit: 2, ...settings },
  };
}

// Fixture map: 159 Hornwood, 161 Sheepshead Hills and 157 Widow's Watch form bonus 118 (+2);
// 158 Bolton Moors borders all three (and 134, 135); 135 Knife Hills borders 158 and 159.
const FOG: Omit<SyntheticTerritory, 'id'> = { fogLevel: 4, owner: -1, armies: 0, fogged: true };
const BOBS = (armies: number): Omit<SyntheticTerritory, 'id'> => ({ fogLevel: 2, owner: BOB.inGame, armies });
/** Ann on 159 and 161; `others` says what the rest show (default: 157 a neutral, 158 and 135 fogged). */
const board = (others: Partial<Record<157 | 158 | 135, Omit<SyntheticTerritory, 'id'>>> = {}, armies = 5): SyntheticTerritory[] => [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies },
  { id: 157, ...(others[157] ?? { fogLevel: 2, owner: 0, armies: 2 }) },
  { id: 158, ...(others[158] ?? FOG) },
  { id: 135, ...(others[135] ?? FOG) },
];
const PICKABLE = [134, 135, 157, 158, 159, 161];

type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;
const routes = (r: Routes) => (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
  const f = r[req.method];
  if (!f) throw new Error(`unexpected method ${req.method}`);
  return f(req, n);
};
const showing = (territories: SyntheticTerritory[]) =>
  routes({ [Method.GetLatestGameInfo]: () => ({ body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) }) });

async function live(
  territories: SyntheticTerritory[],
  feed: Record<string, unknown>,
  opts: { dataDir?: string; env?: Record<string, string>; pages?: Record<string, string> } = {},
): Promise<Harness> {
  return liveHarness({ feed: [feed], warapp: showing(territories), ...opts });
}

interface Named {
  id: number;
  name: string;
}
interface Opponent {
  player: Named;
  summary: string;
  seen: {
    inView: Array<{ territory: Named; armies: number | null }>;
    lastSeen: Array<{ territory: Named; turn: number; armies: number | null }>;
    bonuses: Named[];
  };
  starts: {
    source: 'none' | 'pickable' | 'statistics';
    prior: { source: 'uniform' | 'statistics'; sample: number | null; weak: boolean };
    proven: Named[];
    likely: Array<{ territory: Named; likelihood: number }>;
    ruledOut?: Named[];
    unknown: number | null;
    method: string;
  };
  presence: Array<{ territory: Named; likelihood: number; basis: string[] }>;
  presenceMore?: number;
  bonuses: Array<{ bonus: Named & { value: number }; likelihood: number; basis: string[] }>;
  income: { estimate: number; method: string | null } | null;
  hiddenArmies: number | null;
  approaches: Array<{ text: string; turn: number; target: Named; from: Named; source: 'seen' | 'guessed'; path: Named[]; armies: number | null }>;
  doing: Array<{ rule: string; text: string }>;
}
interface WherePayload {
  game: { id: number; name: string | null; turn: number | null };
  player: Named;
  turns: number[];
  opponents: Opponent[];
  prepare: Array<{ kind: string; text: string; turn: number; opponent: Named; territory?: Named; bonus?: Named & { value: number } }>;
  assumptions?: string[];
  untrusted_content?: boolean;
}

const tmp = () => mkdtempSync(join(tmpdir(), 'warapp-mcp-where-'));
const ids = (xs: Named[]) => xs.map((x) => x.id);
const locate = async (hh: Harness, args: Record<string, unknown> = {}) =>
  payload<WherePayload>(await hh.call('warapp_locate_opponents', { game_id: GAME, player: 'Ann', ...args }));
const bob = (p: WherePayload) => p.opponents.find((o) => o.player.name === 'Bob')!;

/** A finished game's stats record on the fixture's map: who started where (ids only). */
function statsRecord(dir: string, gameId: number, starts: number[][]): void {
  mkdirSync(join(dir, 'stats', String(MAP)), { recursive: true });
  const players = starts.map((s, i) => ({ playerId: 9000 + i, won: i === 0, starts: s, anchorBonusId: null, firstBonusTurn: null }));
  writeFileSync(recordPath(dir, MAP, gameId), JSON.stringify({ gameId, mapId: MAP, turnsSeen: 4, players }));
}

describe('warapp_locate_opponents', () => {
  it('is listed as read-only, and says what is seen, what is guessed and what it reads', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_locate_opponents')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.description).toMatch(/`seen`[^.]*fact/);
    expect(tool.description).toMatch(/estimates of a simple model, not measured probabilities/);
    expect(tool.description).toMatch(/uniform/);
    expect(tool.description).toMatch(/WARAPP_STATS=1/);
    expect(tool.description).toMatch(/no war\.app request beyond the live board/);
    expect(tool.description).toMatch(/Refuses outside a turn phase/);
  });

  it('with no history and no candidates, works from what is seen', async () => {
    h = await live(board({ 158: BOBS(5) }), game(3));
    const p = await locate(h);
    expect(p.untrusted_content).toBe(true);
    expect(p.game).toMatchObject({ id: GAME, turn: 3 });
    expect(p.player).toEqual({ id: ME, name: 'Ann' });
    expect(p.turns).toEqual([3]);
    expect(p.opponents).toHaveLength(1);
    const o = bob(p);
    expect(o.player).toEqual({ id: Number(BOB.feed), name: 'Bob' });
    expect(o.seen.inView).toEqual([{ territory: { id: 158, name: 'Bolton Moors' }, armies: 5 }]);
    expect(o.seen.lastSeen).toEqual([]);
    expect(o.starts).toMatchObject({ source: 'none', proven: [], likely: [], method: 'none' });
    expect(o.presence).toEqual([]);
    expect(o.income).toBeNull();
    // 4 movable + its base income of 5: it can attack either of my territories this turn.
    expect(o.approaches.map((a) => [a.target.id, a.turn, a.source, a.from.id, a.armies])).toEqual([
      [159, 3, 'seen', 158, 9],
      [161, 3, 'seen', 158, 9],
    ]);
    expect(o.approaches[0]!.path).toEqual([
      { id: 158, name: 'Bolton Moors' },
      { id: 159, name: 'Hornwood' },
    ]);
    expect(o.approaches[0]!.text).toBe('Player 7176543229 could attack territory 159 on turn 3 from territory 158 (seen) with up to 9 armies.');
    expect(o.doing.map((d) => d.rule)).toContain('can-attack');
    expect(o.summary).toMatch(/^Player 7176543229: 1 territory in view; no start guess; soonest attack on territory 159 on turn 3 with up to 9 \(seen\)\.$/);
    // I hold two of bonus 118's three territories, and its stack can take the third.
    const contested = p.prepare.find((x) => x.kind === 'contested' && x.bonus?.id === 118)!;
    expect(contested).toMatchObject({ turn: 3, opponent: { name: 'Bob' }, territory: { id: 157, name: "Widow's Watch" }, bonus: { id: 118, value: 2 } });
    expect(contested.text).toMatch(/^Bonus 118 \(\+2\): you hold 2 of 3; player 7176543229 could take territory 157 by turn 3 from territory 158\.$/);
    // The compact view leaves the assumptions out; the full one states them.
    expect(p).not.toHaveProperty('assumptions');
    const full = await locate(h, { view: 'full' });
    expect(full.assumptions!.join(' ')).toMatch(/No start candidates are known/);
    expect(full.assumptions!.join(' ')).toMatch(/not measured probabilities/);
  });

  it('names territories and players by id in every sentence, with the names in fields beside them', async () => {
    h = await live(board({ 158: BOBS(5) }), game(3));
    const p = await locate(h, { view: 'full' });
    const sentences = [
      ...p.opponents.flatMap((o) => [o.summary, ...o.doing.map((d) => d.text), ...o.approaches.map((a) => a.text)]),
      ...p.prepare.map((x) => x.text),
      ...p.assumptions!,
    ].join('\n');
    expect(sentences).not.toMatch(/Bob|Ann|Bolton|Hornwood|Sheepshead|Widow/);
  });

  it('caches the board it read, as war.app showed it', async () => {
    const dir = tmp();
    await writePickList(dir, GAME, ME, [159, 158, 161, 157]);
    h = await live(board(), game(1), { dataDir: dir });
    await locate(h);
    const cached = JSON.parse(readFileSync(boardCachePath(dir, GAME), 'utf8')) as {
      playerId: number;
      turns: Record<string, { territories: Array<{ territoryId: number; owner: { kind: string } }> }>;
    };
    expect(cached.playerId).toBe(ME);
    expect(Object.keys(cached.turns)).toEqual(['1']);
    // 158 is the opponent's proven start, and still what war.app showed: fogged.
    expect(cached.turns['1']!.territories.find((t) => t.territoryId === 158)!.owner.kind).toBe('unknown');
  });

  it('reads my earlier boards: a territory last seen as its own keeps its presence', async () => {
    const dir = tmp();
    h = await live(board({ 158: BOBS(7) }), game(3), { dataDir: dir });
    await locate(h);
    await h.harness.close();
    h = await live(board(), game(4), { dataDir: dir });
    const p = await locate(h);
    expect(p.turns).toEqual([3, 4]);
    const o = bob(p);
    expect(o.seen.inView).toEqual([]);
    expect(o.seen.lastSeen).toEqual([{ territory: { id: 158, name: 'Bolton Moors' }, turn: 3, armies: 7 }]);
    expect(o.presence).toEqual([{ territory: { id: 158, name: 'Bolton Moors' }, likelihood: 0.95, basis: ['last-seen'] }]);
    expect(o.approaches[0]).toMatchObject({ target: { id: 159 }, turn: 4, source: 'guessed', armies: null });
    expect(o.approaches[0]!.text).toBe('Player 7176543229 could attack territory 159 on turn 4 from territory 158 (guessed).');
    expect(o.doing.map((d) => d.rule)).toContain('out-of-sight');
  });

  it('with the pickable territories kept, guesses the starts among those the boards leave open', async () => {
    const dir = tmp();
    await writePickable(dir, GAME, ME, PICKABLE);
    h = await live(board(), game(1), { dataDir: dir });
    const p = await locate(h, { view: 'full' });
    const o = bob(p);
    expect(o.starts).toMatchObject({ source: 'pickable', prior: { source: 'uniform', sample: null, weak: false }, proven: [], unknown: 2, method: 'enumerated' });
    // 157 shows as a neutral, 159 and 161 are mine: two starts among 134, 135 and 158.
    expect(ids(o.starts.ruledOut!)).toEqual([157, 159, 161]);
    expect(o.starts.likely.map((s) => [s.territory.id, s.likelihood])).toEqual([
      [134, 0.67],
      [135, 0.67],
      [158, 0.67],
    ]);
    expect(o.presence.map((x) => [x.territory.id, x.likelihood, x.basis])).toEqual([
      [134, 0.67, ['start']],
      [135, 0.67, ['start']],
      [158, 0.67, ['start']],
    ]);
    expect(o.approaches[0]).toMatchObject({ source: 'guessed', turn: 1, armies: null });
    const scout = p.prepare.find((x) => x.kind === 'scout')!;
    expect(scout.opponent.name).toBe('Bob');
    expect(scout.text).toMatch(/player 7176543229 may be/);
    expect(p.assumptions!.join(' ')).toMatch(/the 6 territories the live board showed as pickable/);
    expect(p.assumptions!.join(' ')).toMatch(/prior is uniform/);
  });

  it('takes a start my kept pick list proves as certain', async () => {
    const dir = tmp();
    await writePickable(dir, GAME, ME, PICKABLE);
    // Listed: 159, 158, 161, 157. Granted numbers 1 and 3, so number 2 (158) was taken first.
    await writePickList(dir, GAME, ME, [159, 158, 161, 157]);
    h = await live(board(), game(1), { dataDir: dir });
    const o = bob(await locate(h));
    expect(o.starts.proven).toEqual([{ id: 158, name: 'Bolton Moors' }]);
    expect(o.starts.unknown).toBe(1);
    expect(o.starts.likely.map((s) => [s.territory.id, s.likelihood])).toEqual([
      [134, 0.5],
      [135, 0.5],
    ]);
    expect(o.presence[0]).toEqual({ territory: { id: 158, name: 'Bolton Moors' }, likelihood: 0.95, basis: ['start'] });
    expect(o.summary).toMatch(/start 158 proven/);
    // The reading is kept for the other tools, as warapp_plan_turn keeps it.
    expect((await readPickRecord(dir, GAME, ME))!.award).toMatchObject({ opponentStarts: [158] });
  });

  it('a proven start needs no candidates', async () => {
    const dir = tmp();
    await writePickList(dir, GAME, ME, [159, 158, 161, 157]);
    h = await live(board(), game(1), { dataDir: dir });
    const o = bob(await locate(h));
    expect(o.starts).toMatchObject({ source: 'none', proven: [{ id: 158 }], likely: [] });
    expect(ids(o.presence.map((x) => x.territory))).toEqual([158]);
  });

  describe('cached map statistics', () => {
    /** Two finished games on this map: 158 started on twice, 134 and 135 once each. */
    function withStats(): string {
      const dir = tmp();
      statsRecord(dir, 501, [[158, 134], [159, 161]]);
      statsRecord(dir, 502, [[158, 135], [159, 161]]);
      return dir;
    }

    it('give the candidates and the prior when WARAPP_STATS=1, with the sample', async () => {
      const dir = withStats();
      h = await live(board(), game(1), { dataDir: dir, env: { WARAPP_STATS: '1' } });
      const p = await locate(h, { view: 'full' });
      const o = bob(p);
      expect(o.starts).toMatchObject({ source: 'statistics', prior: { source: 'statistics', sample: 2, weak: true }, unknown: 2 });
      // Weights (starts + 1): 158 → 3, 134 → 2, 135 → 2. The sets weigh 6, 6 and 4.
      expect(o.starts.likely.map((s) => [s.territory.id, s.likelihood])).toEqual([
        [158, 0.75],
        [134, 0.63],
        [135, 0.63],
      ]);
      expect(p.assumptions!.join(' ')).toMatch(/2 finished games on this map, plus one: a small sample, so a weak prior/);
      // The cache was only read: no game-ID feed, no finished game fetched.
      expect(h.calls.every((c) => /GameFeed\?GameID=12345678/.test(c.url))).toBe(true);
      expect(existsSync(recordPath(dir, MAP, 501))).toBe(true);
    });

    it('weigh the kept pickable territories when both are there', async () => {
      const dir = withStats();
      await writePickable(dir, GAME, ME, PICKABLE);
      h = await live(board(), game(1), { dataDir: dir, env: { WARAPP_STATS: '1' } });
      const o = bob(await locate(h));
      expect(o.starts).toMatchObject({ source: 'pickable', prior: { source: 'statistics', sample: 2, weak: true } });
      expect(o.starts.likely[0]).toEqual({ territory: { id: 158, name: 'Bolton Moors' }, likelihood: 0.75 });
    });

    it('are not read without WARAPP_STATS=1', async () => {
      const dir = withStats();
      h = await live(board(), game(1), { dataDir: dir });
      expect(bob(await locate(h)).starts).toMatchObject({ source: 'none', prior: { source: 'uniform' }, likely: [] });
    });

    it('are never read when hosted, whatever WARAPP_STATS says', async () => {
      const dir = withStats();
      h = await live(board(), game(1), { dataDir: dir, env: { WARAPP_STATS: '1', FLY_MACHINE_ID: 'synthetic' } });
      expect(bob(await locate(h)).starts).toMatchObject({ source: 'none', prior: { source: 'uniform' }, likely: [] });
    });
  });

  it('refuses outside a turn phase', async () => {
    h = await live(board(), game(1, {}, 2, 'DistributingTerritories'));
    const res = await h.call('warapp_locate_opponents', { game_id: GAME, player: 'Ann' });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not in a turn phase/);
    expect(existsSync(boardCachePath(h.dataDir, GAME))).toBe(false);
  });

  it('lists every opponent of a larger game, seen or not, and trims the compact lists', async () => {
    const dir = tmp();
    await writePickable(dir, GAME, ME, PICKABLE);
    h = await live(board({ 158: BOBS(5) }, 6), game(2, {}, 3), { dataDir: dir });
    const p = await locate(h);
    expect(p.opponents.map((o) => o.player.name)).toEqual(['Cat', 'Bob']);
    const cat = p.opponents.find((o) => o.player.name === 'Cat')!;
    expect(cat.seen.inView).toEqual([]);
    expect(cat.doing[0]).toMatchObject({ rule: 'unseen' });
    expect(cat.doing[0]!.text).toMatch(/has received at least \d+ armies/);
    for (const o of p.opponents) expect(o.presence.length).toBeLessThanOrEqual(10);
    // The compact view names what the boards ruled out only in the full one.
    expect(cat.starts).not.toHaveProperty('ruledOut');
  });

  it('keeps on the full view every hidden territory the compact view shows, however unlikely', async () => {
    const dir = tmp();
    // Many pickable territories: two starts among ~30 puts every one under 0.15.
    const f = lobbyFixture() as { map: { territories: Array<{ id: string | number }> } };
    const extra = f.map.territories.map((t) => Number(t.id)).filter((id) => !PICKABLE.includes(id)).slice(0, 30);
    await writePickable(dir, GAME, ME, [...PICKABLE, ...extra]);
    h = await live(board(), game(1), { dataDir: dir });
    const compact = bob(await locate(h));
    const full = bob(await locate(h, { view: 'full' }));
    expect(compact.presence).toHaveLength(10);
    expect(compact.presence.every((x) => x.likelihood < 0.15)).toBe(true);
    // The full view adds to the compact one: the same first ten, nothing dropped.
    expect(full.presence.slice(0, 10)).toEqual(compact.presence);
    // Past the first ten, only those at 0.15 or more; the rest are counted.
    expect(full.presence.slice(10).every((x) => x.likelihood >= 0.15)).toBe(true);
    expect(full.presence.length + (full.presenceMore ?? 0)).toBe(compact.presence.length + (compact.presenceMore ?? 0));
  });
});

describe('the pickable territories are kept during distribution', () => {
  // Fixture map: bonus 118 (+2) = 159, 161, 157; bonus 116 (+2) = 133, 134, 135, 158.
  const PICK_BOARD: SyntheticTerritory[] = [
    { id: 159, fogLevel: 2, owner: -2, armies: 3 },
    { id: 161, fogLevel: 2, owner: -2, armies: 3 },
    { id: 157, fogLevel: 2, owner: -2, armies: 3 },
    { id: 135, fogLevel: 2, owner: -2, armies: 3 },
    { id: 133, fogLevel: 2, owner: -2, armies: 3 },
    { id: 134, fogLevel: 2, owner: -2, armies: 3 },
    { id: 158, fogLevel: 2, owner: 0, armies: 2 },
  ];
  const picking = () => game(0, {}, 2, 'DistributingTerritories');

  it('by warapp_plan_picks, for the signed-in account', async () => {
    h = await live(PICK_BOARD, picking(), { pages: SIGNED_IN_ANN });
    expect((await h.call('warapp_plan_picks', { game_id: GAME })).isError).toBeFalsy();
    expect(await readPickRecord(h.dataDir, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, pickable: [133, 134, 135, 157, 159, 161] });
  });

  it('by warapp_plan_picks not at all when the signed-in account cannot be told, and the plan still comes', async () => {
    h = await live(PICK_BOARD, picking());
    const res = await h.call('warapp_plan_picks', { game_id: GAME });
    expect(res.isError).toBeFalsy();
    expect(existsSync(join(h.dataDir, 'picks', `${GAME}.json`))).toBe(false);
  });

  it("by the preview of warapp_submit_picks, before anything is sent", async () => {
    h = await live(PICK_BOARD, picking(), { pages: SIGNED_IN_ANN });
    const preview = payload<{ confirmToken?: string }>(await h.call('warapp_submit_picks', { game_id: GAME, territories: [159, 161] }));
    expect(preview.confirmToken).toEqual(expect.any(String));
    expect(h.exchanges.map((e) => e.request.method)).toEqual([Method.GetLatestGameInfo]);
    expect(await readPickRecord(h.dataDir, GAME, ME)).toEqual({ gameId: GAME, playerId: ME, pickable: [133, 134, 135, 157, 159, 161] });
  });

  it('and a later turn then finds them: the whole path, picks to the first turn', async () => {
    h = await live(PICK_BOARD, picking(), { pages: SIGNED_IN_ANN });
    const dir = h.dataDir;
    await h.call('warapp_plan_picks', { game_id: GAME });
    await h.harness.close();
    h = await live(board(), game(1), { dataDir: dir, pages: SIGNED_IN_ANN });
    const o = bob(payload<WherePayload>(await h.call('warapp_locate_opponents', { game_id: GAME })));
    expect(o.starts.source).toBe('pickable');
    // 157 shows as a neutral; 159 and 161 are mine; 133, 134 and 135 are left (158 was never pickable).
    expect(o.starts.likely.map((s) => s.territory.id)).toEqual([133, 134, 135]);
  });
});
