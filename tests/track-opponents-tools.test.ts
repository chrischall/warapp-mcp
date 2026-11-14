// warapp_track_opponents (S3): the per-opponent report over my cached board history, and
// warapp_plan_turn using the tracked income once an opponent has two observed turns.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';
import { readGameRecord } from '../src/replay.js';
import { writeOrdersCache } from '../src/trend.js';

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const GAME = 12345678;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ANN = { feed: '3312345644', inGame: 123456 };
const BOB = { feed: '7176543229', inGame: 765432 };

function game(state: string, numberOfTurns: string, only1v1 = false): Record<string, unknown> {
  const f = lobbyFixture();
  const players = (f.players as Array<Record<string, string>>)
    .map((p, i) => (i === 0 ? { ...p, id: ANN.feed, name: 'Ann' } : i === 1 ? { ...p, id: BOB.feed, name: 'Bob' } : p))
    .slice(0, only1v1 ? 2 : undefined);
  return { ...f, state, numberOfTurns, players };
}

// #94: Bob never in view (158 fogged). The fixture's settings: base income 5, TerritoryLimit 3,
// InitialPlayerArmiesPerTerritory 8. At turn 3 Bob has received at least 3 × 8 + 3 × 5 = 39.
const unseenBoard: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 4, owner: -1, armies: 0, fogged: true },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];
const BOB_WARNINGS = [
  'Player Bob has been out of sight for at least 1 turn (no board of mine for turn 2) and has received at least 39 armies since the game started (starting armies 24 + base income 5 × 3 turns); it could be banking a stack larger than your largest (6).',
  'Player Bob has been out of sight for at least 1 turn (no board of mine for turn 2) and has received at least 39 armies since the game started (starting armies 24 + base income 5 × 3 turns); it could be banking more than your total visible armies (9).',
];

// Ann holds 159 and 161; Bob's 158 borders both. 135 stays fogged.
const boardAt = (bob: number): SyntheticTerritory[] => [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: 0, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: bob },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

type Routes = Partial<Record<number, (req: DecodedRequest, n: number) => Partial<ReplyFrame>>>;
const routes = (r: Routes) => (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
  const f = r[req.method];
  if (!f) throw new Error(`unexpected method ${req.method}`);
  return f(req, n);
};
const live = (territories: SyntheticTerritory[]) =>
  routes({
    [Method.GetLatestGameInfo]: () => ({ body: (w) => writeLatestGameInfo(w, territories, [ANN.inGame]) }),
  });

interface TrackPayload {
  game: { id: number; name: string | null; turn: number | null };
  player: { id: number; name: string };
  turns: number[];
  opponents: Array<{
    player: { id: number; name: string };
    firstSeen: number;
    observed: Array<{
      turn: number;
      deploy: number;
      measured?: number;
      brokenBonuses?: Array<{ id: number; value: number }>;
      reveals?: unknown[];
    }>;
    income: {
      estimate: number | null;
      visible: number;
      usedByPlanner: boolean;
      turns: number[];
      method: string | null;
      lowered?: number;
      observedRange: { min: number; max: number } | null;
    };
    unexplainedArmies: number | null;
    inferredBonuses: unknown;
    notes: string[];
  }>;
  untrusted_content?: boolean;
}

/** Track (or plan) turns 3, 4, 5 … with Bob's stack at each count, sharing one data dir. */
async function playTurns(tool: string, bobs: number[], extra: Record<string, unknown> = {}) {
  let dir: string | undefined;
  let last: unknown;
  for (const [i, bob] of bobs.entries()) {
    h = await liveHarness({
      ...(dir ? { dataDir: dir } : {}),
      feed: [game('Playing', String(i + 2))],
      warapp: live(boardAt(bob)),
    });
    dir = h.dataDir;
    last = payload(await h.call(tool, { game_id: GAME, player: 'Ann', ...extra }));
    if (i < bobs.length - 1) {
      await h.harness.close();
      h = undefined;
    }
  }
  return { dir: dir!, last };
}

describe('warapp_track_opponents', () => {
  it('lists the tool as read-only', async () => {
    h = await liveHarness();
    const tool = (await h.harness.client.listTools()).tools.find((t) => t.name === 'warapp_track_opponents')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    expect(tool.description).toMatch(/largest of its last three observed turns/);
    expect(tool.description).not.toMatch(/median/);
  });

  it('reports each opponent by name over the cached history, and caches the board it read', async () => {
    // Bob deploys 5, 5 on 158 (7 → 12 → 17) over turns 3–5.
    const { dir, last } = await playTurns('warapp_track_opponents', [7, 12, 17]);
    const p = last as TrackPayload;
    expect(p.untrusted_content).toBe(true);
    expect(p.game).toMatchObject({ id: GAME, turn: 5 });
    expect(p.turns).toEqual([3, 4, 5]);
    const bob = p.opponents.find((o) => o.player.name === 'Bob')!;
    expect(bob.player.id).toBe(Number(BOB.feed));
    expect(bob.firstSeen).toBe(3);
    expect(bob.observed.map((o) => [o.turn, o.deploy])).toEqual([
      [3, 5],
      [4, 5],
    ]);
    expect(bob.income).toMatchObject({
      estimate: 5,
      usedByPlanner: true,
      turns: [3, 4],
      method: 'visible',
      observedRange: { min: 5, max: 5 },
    });
    expect(bob.unexplainedArmies).toBe(0);
    expect(bob.notes.join(' ')).toMatch(/its visible base \+ bonuses, observed 5–5 over turns 3–4/);
    const cached = JSON.parse(readFileSync(join(dir, 'boards', `${GAME}.json`), 'utf8')) as { turns: object };
    expect(Object.keys(cached.turns)).toEqual(['3', '4', '5']);
    expect((await readGameRecord(dir, GAME))?.numberOfTurns).toBe(4);
  });

  it('#123: a stack that may have walked in from the fog reads as a move, with the range', async () => {
    // Bob's 158 (next to the fogged 135) goes 7 → 27: beyond twice his visible 5, the 10 more may
    // be a stack out of the fog. The deploy reads 10; the range says 0–20.
    const { last } = await playTurns('warapp_track_opponents', [7, 27]);
    const bob = (last as TrackPayload).opponents.find((o) => o.player.name === 'Bob')! as TrackPayload['opponents'][number] & {
      observed: Array<{ range?: { low: number; high: number } }>;
    };
    expect(bob.observed[0]).toMatchObject({ turn: 3, deploy: 10, range: { low: 0, high: 20 } });
    expect(bob.notes.join(' ')).toMatch(/walked in from the fog/);
    const full = payload<TrackPayload>(await h!.call('warapp_track_opponents', { game_id: GAME, player: 'Ann', view: 'full' }));
    expect(full.opponents.find((o) => o.player.name === 'Bob')!.observed[0]).toMatchObject({ grewFromFog: [{ id: 158 }] });
  });

  it('#164: returns a large stack that left view as lostStacks', async () => {
    // Turn 3: Bob's 30 on 158 in view. Turn 4: 158 fogged, and no stack of his in view since.
    const fogged158: SyntheticTerritory[] = boardAt(0).map((t) => (t.id === 158 ? { id: 158, fogLevel: 4, owner: -1, armies: 0, fogged: true } : t));
    let dir: string | undefined;
    for (const [i, territories] of [boardAt(30), fogged158].entries()) {
      await h?.harness.close();
      h = await liveHarness({ ...(dir ? { dataDir: dir } : {}), feed: [game('Playing', String(i + 2))], warapp: live(territories) });
      dir = h.dataDir;
      // Each call caches the board it read.
      await h.call('warapp_track_opponents', { game_id: GAME, player: 'Ann' });
    }
    const p = payload<TrackPayload>(await h!.call('warapp_track_opponents', { game_id: GAME, player: 'Ann' }));
    const bob = p.opponents.find((o) => o.player.name === 'Bob')! as TrackPayload['opponents'][number] & { lostStacks?: unknown };
    expect(bob.lostStacks).toEqual([{ territoryId: 158, turn: 3, armies: 30 }]);
    // A stack still in view is not lost: the key is left out.
    const { last } = await playTurns('warapp_track_opponents', [7, 12]);
    expect((last as TrackPayload).opponents.find((o) => o.player.name === 'Bob')).not.toHaveProperty('lostStacks');
  });

  it('with one board only, says there is nothing to observe yet', async () => {
    const { last } = await playTurns('warapp_track_opponents', [7]);
    const bob = (last as TrackPayload).opponents.find((o) => o.player.name === 'Bob')!;
    expect(bob.observed).toEqual([]);
    expect(bob.income).toMatchObject({ estimate: null, usedByPlanner: false, method: null, observedRange: null });
    expect(bob.notes.join(' ')).toMatch(/fewer than 2 observed turns/);
  });

  it('compact leaves out the per-turn territory lists; full has them', async () => {
    await playTurns('warapp_track_opponents', [7, 12]);
    const full = payload<TrackPayload>(await h!.call('warapp_track_opponents', { game_id: GAME, player: 'Ann', view: 'full' }));
    const compact = payload<TrackPayload>(await h!.call('warapp_track_opponents', { game_id: GAME, player: 'Ann' }));
    expect(full.opponents[0]!.observed[0]).toHaveProperty('reveals');
    expect(full.opponents[0]!.observed[0]).toHaveProperty('fromFog');
    expect(compact.opponents[0]!.observed[0]).not.toHaveProperty('reveals');
  });

  it('lists an opponent still playing with nothing in view, by name, with what it has received (#94)', async () => {
    h = await liveHarness({ feed: [game('Playing', '2', true)], warapp: live(unseenBoard) });
    const p = payload<TrackPayload & { warnings: string[] }>(await h.call('warapp_track_opponents', { game_id: GAME, player: 'Ann' }));
    expect(p.opponents).toHaveLength(1);
    const bob = p.opponents[0]! as TrackPayload['opponents'][number] & Record<string, unknown>;
    expect(bob.player).toEqual({ id: Number(BOB.feed), name: 'Bob' });
    expect(bob).toMatchObject({
      firstSeen: null,
      visible: 0,
      // Only the current board (turn 3): it may have been in view on turn 2, so at least 1 turn.
      turnsUnseen: 1,
      turnsUnseenAtLeast: true,
      earnedAtLeast: { total: 39, start: 24, baseIncome: 5, turns: 3, largestStack: 6, visibleArmies: 9 },
      warnings: BOB_WARNINGS,
    });
    expect(p.warnings).toEqual(BOB_WARNINGS);
    expect(bob.notes.join(' ')).toMatch(/could be banking up to roughly this, minus what its expansion cost/);
  });

  it('a visible opponent carries visible and turnsUnseen 0, no bound and no warning', async () => {
    h = await liveHarness({ feed: [game('Playing', '2', true)], warapp: live(boardAt(7)) });
    const p = payload<TrackPayload & { warnings: string[] }>(await h.call('warapp_track_opponents', { game_id: GAME, player: 'Ann' }));
    expect(p.opponents[0]).toMatchObject({ visible: 1, turnsUnseen: 0, earnedAtLeast: null, warnings: [] });
    expect(p.warnings).toEqual([]);
  });

  it('counts my own cached orders as measurements: a failed attack of mine adds back the defenders it killed (#119)', async () => {
    // Bob 7 → 9 on 158 while Ann's 5 from 159 failed there: 5 × 0.6 = 3 defenders killed, so
    // Bob deployed 2 + 3 = 5, not the 2 the board alone shows.
    const track = async (dir: string | undefined, turnsDone: string, bob: number) => {
      h = await liveHarness({ ...(dir ? { dataDir: dir } : {}), feed: [game('Playing', turnsDone)], warapp: live(boardAt(bob)) });
      return payload<TrackPayload>(await h.call('warapp_track_opponents', { game_id: GAME, player: 'Ann' }));
    };
    await track(undefined, '2', 7);
    const dir = h!.dataDir;
    await h!.harness.close();
    h = undefined;
    const without = await track(dir, '3', 9);
    expect(without.opponents.find((o) => o.player.name === 'Bob')!.observed[0]).toMatchObject({ turn: 3, deploy: 2 });
    await h!.harness.close();
    h = undefined;
    expect(
      await writeOrdersCache(dir, GAME, Number(ANN.feed), 3, { deploys: [{ territoryId: 159, armies: 5 }], moves: [{ from: 159, to: 158, armies: 5 }] }),
    ).toBe(true);
    const p = await track(dir, '3', 9);
    const bob = p.opponents.find((o) => o.player.name === 'Bob')!;
    expect(bob.observed[0]).toMatchObject({ turn: 3, deploy: 5, measured: 3 });
    expect(bob.notes.join(' ')).toMatch(/My own orders on turn 3 \(\+3\) count as measurements/);
  });

  it('reports a visibly broken bonus on its turn and how far the carried income was lowered (#119)', async () => {
    // Bob visibly holds bonus 116 (+2: 133, 134, 135, 158), deploys 20 on turn 3, then nothing;
    // on turn 7 Ann holds 135. The 20 is carried (no decay) and lowered by the broken +2 to 18.
    const at = (bob: number, broken = false): SyntheticTerritory[] => [
      { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
      { id: 157, fogLevel: 2, owner: 0, armies: 2 },
      { id: 158, fogLevel: 1, owner: BOB.inGame, armies: bob },
      { id: 133, fogLevel: 1, owner: BOB.inGame, armies: 1 },
      { id: 134, fogLevel: 1, owner: BOB.inGame, armies: 1 },
      { id: 135, fogLevel: 1, owner: broken ? ANN.inGame : BOB.inGame, armies: broken ? 3 : 1 },
    ];
    const seq = [at(7), at(27), at(27), at(27), at(27, true)];
    let dir: string | undefined;
    let p: TrackPayload | undefined;
    for (const [i, territories] of seq.entries()) {
      if (h) {
        await h.harness.close();
        h = undefined;
      }
      h = await liveHarness({ ...(dir ? { dataDir: dir } : {}), feed: [game('Playing', String(i + 2))], warapp: live(territories) });
      dir = h.dataDir;
      p = payload<TrackPayload>(await h.call('warapp_track_opponents', { game_id: GAME, player: 'Ann' }));
    }
    const bob = p!.opponents.find((o) => o.player.name === 'Bob')!;
    expect(bob.observed.map((o) => o.deploy)).toEqual([20, 0, 0, expect.any(Number)]);
    expect(bob.observed.slice(0, 3).every((o) => o.brokenBonuses === undefined)).toBe(true);
    expect(bob.observed[3]!.brokenBonuses).toEqual([expect.objectContaining({ id: 116, value: 2 })]);
    expect(bob.income).toMatchObject({ estimate: 18, method: 'carried', lowered: 2 });
  });

  it('refuses outside a turn phase', async () => {
    h = await liveHarness({ feed: [game('WaitingForPlayers', '-1')] });
    const res = await h.call('warapp_track_opponents', { game_id: GAME });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/not in a turn phase/);
  });
});

describe('warapp_plan_turn with a tracked history', () => {
  it('uses the tracked income once an opponent has two observed turns, and says so', async () => {
    const { last } = await playTurns('warapp_plan_turn', [7, 12, 17]);
    const p = last as { rationale: string[] };
    expect(p.rationale.join('\n')).toMatch(/Tracked income for player \d+: ~5\/turn \(its visible base \+ bonuses, observed 5–5 over turns 3–4\)/);
  });

  it('warns about an opponent out of sight, and the profile names what it has received (#94)', async () => {
    h = await liveHarness({ feed: [game('Playing', '2', true)], warapp: live(unseenBoard) });
    const p = payload<{ warnings: string[]; profile: { standing: string; notes: string[] } }>(
      await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann', view: 'full' }),
    );
    expect(p.warnings).toEqual(expect.arrayContaining(BOB_WARNINGS));
    expect(p.profile.standing).toBe('unknown');
    expect(p.profile.notes.join(' ')).toMatch(/has been out of sight for at least 1 turn and has received at least 39 armies/);
  });

  it('in an even-start 1v1, an opponent bordering the fog is assumed to earn my income: a prior, not an observation (#119)', async () => {
    // Ann holds bonus 118 (+2: 157, 159, 161): income 7. Bob's 158 shows only its base 5 and
    // borders the fogged 135. The fixture's DistributionMode is a normal map distribution.
    const territories: SyntheticTerritory[] = [
      { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
      { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
      { id: 157, fogLevel: 1, owner: ANN.inGame, armies: 2 },
      { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
      { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
    ];
    const plan = async (only1v1: boolean) => {
      h = await liveHarness({ feed: [game('Playing', '2', only1v1)], warapp: live(territories) });
      const p = payload<{ warnings: string[]; enemyDeploy: number }>(await h.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));
      await h.harness.close();
      h = undefined;
      return p;
    };
    const duel = await plan(true);
    expect(duel.enemyDeploy).toBe(7);
    expect(duel.warnings.join('\n')).toMatch(/Enemy deploy estimate for player \d+: ~7 \(a prior, not an observation/);
    // The fixture's full lobby is an FFA: no prior.
    const ffa = await plan(false);
    expect(ffa.warnings.join('\n')).not.toMatch(/a prior/);
  });

  it('one observed turn: no tracked line (today\'s behaviour)', async () => {
    const { last } = await playTurns('warapp_plan_turn', [7, 12]);
    expect((last as { rationale: string[] }).rationale.join('\n')).not.toMatch(/Tracked income/);
  });
});
