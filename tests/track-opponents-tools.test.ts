// warapp_track_opponents (S3): the per-opponent report over my cached board history, and
// warapp_plan_turn using the tracked income once an opponent has two observed turns.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { liveHarness, lobbyFixture, payload, textOf, type Harness } from './helpers.js';
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
  'Player Bob has been out of sight for at least 1 turn (no board of mine for turn 2) and has received at least 39 armies (starting armies + base income × turns); it could be banking a stack larger than your largest (6).',
  'Player Bob has been out of sight for at least 1 turn (no board of mine for turn 2) and has received at least 39 armies (starting armies + base income × turns); it could be banking more than your total visible armies (9).',
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
    observed: Array<{ turn: number; deploy: number; reveals?: unknown[] }>;
    income: { estimate: number | null; visible: number; usedByPlanner: boolean; turns: number[] };
    unaccountedArmies: number | null;
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
    expect(tool.description).toMatch(/median/);
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
    expect(bob.income).toMatchObject({ estimate: 5, usedByPlanner: true, turns: [3, 4] });
    expect(bob.unaccountedArmies).toBe(0);
    expect(bob.notes.join(' ')).toMatch(/median/);
    const cached = JSON.parse(readFileSync(join(dir, 'boards', `${GAME}.json`), 'utf8')) as { turns: object };
    expect(Object.keys(cached.turns)).toEqual(['3', '4', '5']);
  });

  it('with one board only, says there is nothing to observe yet', async () => {
    const { last } = await playTurns('warapp_track_opponents', [7]);
    const bob = (last as TrackPayload).opponents.find((o) => o.player.name === 'Bob')!;
    expect(bob.observed).toEqual([]);
    expect(bob.income).toMatchObject({ estimate: null, usedByPlanner: false });
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
    expect(p.rationale.join('\n')).toMatch(/Tracked income for player \d+: ~5\/turn, the median of its last 2 observed turns/);
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

  it('one observed turn: no tracked line (today\'s behaviour)', async () => {
    const { last } = await playTurns('warapp_plan_turn', [7, 12]);
    expect((last as { rationale: string[] }).rationale.join('\n')).not.toMatch(/Tracked income/);
  });
});
