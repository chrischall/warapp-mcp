// The award of picks in the turn tools (#166): read from the stored pick list on the first board,
// reported by warapp_plan_turn and warapp_check_plan, and the opponent's proven starts planned on
// while fogged. Synthetic board on the anonymized lobby fixture's map; no war.app traffic.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPickRecord, writePickList } from '../src/pick-list.js';
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { boardCachePath } from '../src/trend.js';
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
const CAT = { feed: '5524681355', inGame: 246813 };
const ME = Number(ANN.feed);

/** A game of the first `seats` players of the fixture, on turn `turn`. */
function game(turn = 1, settings: Record<string, unknown> = {}, seats = 2): Record<string, unknown> {
  const f = lobbyFixture();
  const ids = [ANN, BOB, CAT];
  const players = (f.players as Array<Record<string, string>>)
    .slice(0, seats)
    .map((p, i) => ({ ...p, id: ids[i]!.feed, name: ['Ann', 'Bob', 'Cat'][i]!, state: 'Playing' }));
  return {
    ...f,
    state: 'Playing',
    numberOfTurns: String(turn - 1),
    players,
    settings: { ...(f.settings as object), InitialPlayerArmiesPerTerritory: 5, ...settings },
  };
}

// Fixture map: 159 Hornwood, 161 Sheepshead Hills and 157 Widow's Watch form bonus 118 (+2);
// 158 Bolton Moors borders all three; 135 Knife Hills borders 158 and 159.
const FOG: Omit<SyntheticTerritory, 'id'> = { fogLevel: 4, owner: -1, armies: 0, fogged: true };
/** Ann on 159 and 161; `others` says what the rest show (default: 157 a neutral, 158 and 135 fogged). */
const board = (others: Partial<Record<157 | 158 | 135, Omit<SyntheticTerritory, 'id'>>> = {}, armies = 5): SyntheticTerritory[] => [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies },
  { id: 157, ...(others[157] ?? { fogLevel: 2, owner: 0, armies: 2 }) },
  { id: 158, ...(others[158] ?? FOG) },
  { id: 135, ...(others[135] ?? FOG) },
];

async function live(territories: SyntheticTerritory[], feed: Record<string, unknown>, dataDir?: string): Promise<Harness> {
  return liveHarness({
    feed: [feed],
    ...(dataDir ? { dataDir } : {}),
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
interface Award {
  opponentStarts: Named[];
  allStartsKnown: boolean;
  awarded: 'first' | 'second' | null;
  firstMover: 'you' | 'opponent' | null;
  opponentCommanderStart?: Named | null;
  assumedOnBoard: Named[];
  notes: string[];
}
interface PlanPayload {
  award?: Award;
  warnings: string[];
}
/** The plan states a deploy estimate for each opponent it sees on its board. */
const ESTIMATE_FOR_BOB = new RegExp(`Enemy deploy estimate for player ${BOB.feed}`);
const ids = (xs: Named[]) => xs.map((x) => x.id);
const tmp = () => mkdtempSync(join(tmpdir(), 'warapp-mcp-award-'));
const plan = async (hh: Harness) => payload<PlanPayload>(await hh.call('warapp_plan_turn', { game_id: GAME, player: 'Ann' }));

describe('warapp_plan_turn — the award of picks', () => {
  it('says nothing when no pick list is kept for the game', async () => {
    h = await live(board(), game());
    const p = await plan(h);
    expect(p).not.toHaveProperty('award');
    expect(p.warnings.join(' ')).not.toMatch(ESTIMATE_FOR_BOB);
  });

  it('names the opponent start my list proves and plans on it while it is fogged', async () => {
    const dir = tmp();
    // Two starts each. Listed: 159, 158, 161, 157. Granted numbers 1 and 3, so number 2 (158) was taken.
    await writePickList(dir, GAME, ME, [159, 158, 161, 157]);
    h = await live(board(), game(), dir);
    const p = await plan(h);
    expect(ids(p.award!.opponentStarts)).toEqual([158]);
    expect(p.award).toMatchObject({ allStartsKnown: false, awarded: null, firstMover: null });
    expect(ids(p.award!.assumedOnBoard)).toEqual([158]);
    expect(p.award).not.toHaveProperty('opponentCommanderStart');
    expect(p.award!.notes.join(' ')).toMatch(/territory 158 above a pick you were granted/);
    expect(p.award!.notes.join(' ')).toMatch(/planned as the opponent's with the 5 starting armies/);
    // The opponent now stands on the board the plan is made on: it gets a deploy estimate.
    expect(p.warnings.join(' ')).toMatch(ESTIMATE_FOR_BOB);
    expect(p.warnings.join(' ')).toMatch(/Fogged territory 158 is planned as the opponent's \(5 armies each, the starting armies\)/);

    // The reading is kept; the board cached is the one war.app showed, not the completed one.
    expect((await readPickRecord(dir, GAME, ME))!.award).toMatchObject({ granted: [159, 161], opponentStarts: [158] });
    const cached = JSON.parse(readFileSync(boardCachePath(dir, GAME), 'utf8')) as { turns: Record<string, { territories: Array<{ territoryId: number; owner: { kind: string } }> }> };
    expect(cached.turns['1']!.territories.find((t) => t.territoryId === 158)!.owner.kind).toBe('unknown');
  });

  it('tells who was awarded first and who moves first under a cyclic order, and when every start is known', async () => {
    const dir = tmp();
    // Granted numbers 1 and 4 of four: only the first awarded gets that, and the opponent holds 2 and 3.
    await writePickList(dir, GAME, ME, [159, 158, 157, 161]);
    h = await live(board({ 157: FOG }), game(), dir);
    const p = await plan(h);
    expect(ids(p.award!.opponentStarts)).toEqual([158, 157]);
    expect(p.award).toMatchObject({ allStartsKnown: true, awarded: 'first', firstMover: 'opponent' });
    expect(p.award!.notes.join(' ')).toMatch(/the opponent moves first on turn 1/);
    expect(p.award!.notes.join(' ')).toMatch(/not verified live/);
  });

  it('gives no move order under a random order', async () => {
    const dir = tmp();
    await writePickList(dir, GAME, ME, [159, 158, 157, 161]);
    h = await live(board({ 157: FOG }), game(1, { MoveOrder: 'Random' }), dir);
    const p = await plan(h);
    expect(p.award).toMatchObject({ awarded: 'first', firstMover: null });
  });

  it("with commanders, names the opponent's first award when the award pins it", async () => {
    const dir = tmp();
    // Granted numbers 2 and 3: my first pick went to the opponent before I was awarded anything.
    await writePickList(dir, GAME, ME, [158, 159, 161, 157]);
    h = await live(board(), game(1, { Commanders: true }), dir);
    const p = await plan(h);
    expect(p.award).toMatchObject({ awarded: 'second', firstMover: 'you', opponentCommanderStart: { id: 158 } });
    expect(p.award!.notes.join(' ')).toMatch(/its commander is there/);
  });

  it('leaves a start the board already shows as it is', async () => {
    const dir = tmp();
    await writePickList(dir, GAME, ME, [159, 158, 161, 157]);
    h = await live(board({ 158: { fogLevel: 2, owner: BOB.inGame, armies: 5 } }), game(), dir);
    const p = await plan(h);
    expect(ids(p.award!.opponentStarts)).toEqual([158]);
    expect(p.award!.assumedOnBoard).toEqual([]);
    expect(p.warnings.join(' ')).not.toMatch(/planned as the opponent's/);
  });

  it('reads nothing from a list the start contradicts, and does not try again', async () => {
    const dir = tmp();
    // The list would make 157 the opponent's start, but the board shows it neutral.
    await writePickList(dir, GAME, ME, [159, 157, 161, 158]);
    h = await live(board(), game(), dir);
    expect(await plan(h)).not.toHaveProperty('award');
    expect((await readPickRecord(dir, GAME, ME))!.award).toBeNull();
    // A list that cannot yield this start at all.
    const other = tmp();
    await writePickList(other, GAME, ME, [158, 157, 135, 159, 161]);
    await h.harness.close();
    h = await live(board(), game(), other);
    expect(await plan(h)).not.toHaveProperty('award');
    expect((await readPickRecord(other, GAME, ME))!.award).toBeNull();
  });

  it('reuses the reading on later turns, with only the owner of a fogged start', async () => {
    const dir = tmp();
    await writePickList(dir, GAME, ME, [159, 158, 157, 161]);
    h = await live(board({ 157: FOG }), game(1), dir);
    await plan(h);
    await h.harness.close();
    // Turn 2: I hold more armies; the opponent's starts are still in the fog.
    h = await live(board({ 157: FOG }, 9), game(2), dir);
    const p = await plan(h);
    expect(ids(p.award!.assumedOnBoard)).toEqual([158, 157]);
    expect(p.award).toMatchObject({ awarded: 'first', firstMover: 'you' });
    expect(p.award!.notes.join(' ')).toMatch(/planned as the opponent's \(armies unknown\)/);
    expect(p.warnings.join(' ')).toMatch(/Fogged territories 158, 157 are planned as the opponent's \(armies unknown\)/);
  });

  it('does not read the award from a later board', async () => {
    const dir = tmp();
    await writePickList(dir, GAME, ME, [159, 158, 161, 157]);
    h = await live(board({}, 9), game(3), dir);
    expect(await plan(h)).not.toHaveProperty('award');
    expect((await readPickRecord(dir, GAME, ME))!).not.toHaveProperty('award');
  });

  it('with three players names the starts of others without planning on them', async () => {
    const dir = tmp();
    await writePickList(dir, GAME, ME, [159, 158, 161, 157, 135, 9001]);
    h = await live(board(), game(1, {}, 3), dir);
    const p = await plan(h);
    expect(ids(p.award!.opponentStarts)).toEqual([158]);
    expect(p.award).toMatchObject({ awarded: null, firstMover: null, assumedOnBoard: [] });
    expect(p.award!.notes.join(' ')).toMatch(/another player's start/);
  });
});

describe('warapp_check_plan — the award of picks', () => {
  interface CheckPayload {
    award?: Award;
    firstMover: string;
    considered: number;
    enemyDeploy: Array<{ player: Named; deploy: number }>;
    unseenOpponents: Named[];
  }
  const check = async (hh: Harness) =>
    payload<CheckPayload>(await hh.call('warapp_check_plan', { game_id: GAME, player: 'Ann', orders: [{ kind: 'deploy', territory: 159, armies: 5 }] }));

  it('tries the orders against the start the award proves, and reports the move order without narrowing to it', async () => {
    const dir = tmp();
    await writePickList(dir, GAME, ME, [159, 158, 157, 161]);
    h = await live(board({ 157: FOG }), game(), dir);
    const p = await check(h);
    expect(p.award).toMatchObject({ awarded: 'first', firstMover: 'opponent' });
    expect(ids(p.award!.assumedOnBoard)).toEqual([158, 157]);
    // Both move orders are still tried: the award's order is the wiki's rule, not verified live.
    expect(p.firstMover).toBe('unknown');
    expect(p.enemyDeploy.map((e) => e.player.id)).toEqual([Number(BOB.feed)]);
    expect(p.unseenOpponents).toEqual([]);
    expect(p.considered).toBeGreaterThan(0);
  });

  it('without a pick list the fogged opponent cannot be tried', async () => {
    h = await live(board({ 157: FOG }), game());
    const p = await check(h);
    expect(p).not.toHaveProperty('award');
    expect(p.considered).toBe(0);
    expect(ids(p.unseenOpponents)).toEqual([Number(BOB.feed)]);
  });
});
