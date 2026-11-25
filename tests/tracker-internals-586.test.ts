// #586: the decision log keeps the tracker's own figures behind each estimate (so a finished game shows which step
// held an estimate below the truth after a jump), and the map of every game with a log is pinned in the map store
// (never evicted while the log is kept). Synthetic data only.
import { readFile, rm, mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EnemyDeployEstimate, PlanInput, TurnPlan } from '../src/analysis/plan/shared.js';
import type { OpponentTrack } from '../src/analysis/opponents.js';
import type { BoardState } from '../src/board.js';
import type { GameMap } from '../src/normalize.js';
import { buildGraph } from '../src/analysis/graph.js';
import {
  compactLog,
  loggedEstimates,
  loggedTrack,
  pruneDecisionLogs,
  readDecisionLog,
  recordDecision,
  updateDecisionLog,
} from '../src/decision-log.js';
import {
  MAX_STORED_MAPS,
  mapStorePath,
  mapsDir,
  pinStoredMap,
  pinnedMapIds,
  readStoredMap,
  unpinGames,
  writeStoredMap,
} from '../src/map-store.js';
import { capturePlan } from '../src/tools/decision-capture.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-586-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ME = 1001;
const FOE = 2002;
const GAME = 7001;

const turn = (from: number, extra: Record<string, unknown> = {}) => ({
  from,
  to: from + 1,
  observed: 10 + from,
  raw: 11 + from,
  low: 8 + from,
  high: 14 + from,
  cap: 40,
  coverage: { share: 0.4 },
  measured: 0,
  broken: [],
  brokenValue: 0,
  counted: [],
  captured: [],
  fromFog: [],
  fogArmies: 0,
  reveals: [],
  reinforced: [],
  grewFromFog: [],
  emptied: [],
  combat: 0,
  visibleIncome: 5,
  earned: 10,
  net: 0,
  losses: 0,
  ...extra,
});

const track = (extra: Partial<OpponentTrack> = {}): OpponentTrack =>
  ({
    playerId: FOE,
    firstSeen: 1,
    lastTurn: 6,
    turns: [turn(1), turn(2), turn(3, { captureFloor: 12 }), turn(4, { accounted: true }), turn(5, { fogCaptures: { turns: [3, 5], armies: 9, income: 6 } })],
    base: 5,
    bonusIncome: 0,
    visibleIncome: 5,
    income: 16,
    incomeTurns: [3, 4, 5],
    observedRange: { min: 13, max: 15 },
    incomeMethod: 'rise-capped',
    incomeLowered: 0,
    incomeRise: { read: 30, before: 12, low: 14 },
    observedLow: { low: 18, high: 22, turn: 5, coverage: 0.4 },
    unexplained: 0,
    inferred: null,
    topUp: 4,
    visible: 3,
    turnsUnseen: 0,
    turnsUnseenAtLeast: false,
    earnedAtLeast: null,
    warnings: [`Player Somebody banks out of view.`],
    notes: ['A note with a name: Somebody.'],
    ...extra,
  }) as unknown as OpponentTrack;

const estimate = { playerId: FOE, estimate: 18, base: 5, bonusIncome: 0, observed: 13, tracked: 16, coverage: { share: 0.4 }, source: 'tracked' } as unknown as EnemyDeployEstimate;

describe('loggedTrack (#586)', () => {
  it('keeps the income, each window reading and what held it — figures only, no warning or note text', () => {
    const logged = loggedTrack(track())!;
    expect(logged).toEqual({
      income: 16,
      window: [
        { turn: 3, observed: 13, raw: 14, low: 11, high: 17, cap: 40, coverage: 0.4, captureFloor: 12 },
        { turn: 4, observed: 14, raw: 15, low: 12, high: 18, cap: 40, coverage: 0.4, accounted: true },
        { turn: 5, observed: 15, raw: 16, low: 13, high: 19, cap: 40, coverage: 0.4, fogCaptures: 6 },
      ],
      rise: { read: 30, before: 12, low: 14 },
      observedLow: { low: 18, high: 22, turn: 5, coverage: 0.4 },
      topUp: 4,
    });
    expect(JSON.stringify(logged)).not.toContain('Somebody');
  });

  it('a carried income keeps what it lost, a tripped one its step, a jump its verdict; unmeasured coverage is null', () => {
    const logged = loggedTrack(
      track({
        incomeMethod: 'tripped',
        incomeLowered: 3,
        incomeRise: undefined,
        observedLow: undefined,
        incomeTrip: { from: 30, proven: 12, turn: 5 },
        incomeJump: { turn: 5, observed: 40, before: 10, verdict: 'reveal', since: 3 } as unknown as OpponentTrack['incomeJump'],
        topUp: null,
        turns: [turn(5, { coverage: undefined })] as unknown as OpponentTrack['turns'],
      }),
    )!;
    expect(logged).toEqual({
      income: 16,
      window: [{ turn: 5, observed: 15, raw: 16, low: 13, high: 19, cap: 40, coverage: null }],
      lowered: 3,
      trip: { from: 30, proven: 12, turn: 5 },
      jump: { turn: 5, observed: 40, before: 10, verdict: 'reveal' },
    });
  });

  it('a track with no income field (built by hand) logs nothing; an estimate with no track carries no track', () => {
    expect(loggedTrack({ playerId: FOE, incomeMethod: 'visible' })).toBeUndefined();
    expect(loggedEstimates([estimate])[0]!.track).toBeUndefined();
    expect(loggedEstimates([estimate], [{ playerId: FOE, incomeMethod: 'visible' }])[0]).toMatchObject({ method: 'visible' });
    expect(loggedEstimates([estimate], [{ playerId: FOE, incomeMethod: 'visible' }])[0]!.track).toBeUndefined();
  });

  it('the estimate carries its own track only', () => {
    const other = track({ playerId: 3003 } as Partial<OpponentTrack>);
    const [logged] = loggedEstimates([estimate], [other, track()]);
    expect(logged).toMatchObject({ player: FOE, method: 'rise-capped', track: { income: 16, rise: { read: 30 } } });
  });
});

const board: BoardState = {
  source: 'gamefeed',
  verified: true,
  territories: [
    { territoryId: 1, owner: { kind: 'player', playerId: ME }, armies: 5 },
    { territoryId: 2, owner: { kind: 'player', playerId: FOE }, armies: 4 },
  ],
};

const plan = {
  goal: 'balanced',
  profile: { format: 'ffa', phase: 'contact', standing: 'even' },
  deploys: [],
  moves: [],
  expected: { captures: [], bonusesCompleted: [], nextIncome: 5 },
  warnings: [],
  rationale: [],
  enemyDeploy: 5,
  conceded: [],
  cardAdvice: null,
  offence: [],
} as unknown as TurnPlan;

const mapOf = (id: number): GameMap => ({
  id,
  name: `Map ${id}`,
  territories: [
    { id: 1, name: 'A', connectedTo: [2] },
    { id: 2, name: 'B', connectedTo: [1] },
  ],
  bonuses: [],
  distributionModes: [],
});

const input = { board, me: ME, income: 5, turn: 6, tracks: [track()], graph: { map: mapOf(77) } } as unknown as PlanInput;

describe('the decision log keeps the tracker internals and the map id (#586)', () => {
  it('a planned turn logs each estimate with its track, and compaction keeps it once the replay input is gone', async () => {
    // The first turns logged keep their input on compaction: log three before the one with the track.
    for (const t of [1, 2, 3]) await recordDecision(dir, GAME, ME, { turn: t, board, input: { ...input, turn: t, tracks: [] } as PlanInput, plan });
    expect(await recordDecision(dir, GAME, ME, { turn: 6, board, input, plan, estimates: [estimate], mapId: 77 })).toBe(true);
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.mapId).toBe(77);
    expect(log.turns['6']!.decision!.estimates![0]).toMatchObject({ player: FOE, track: { income: 16, rise: { read: 30, before: 12 } } });
    const compacted = compactLog(log);
    expect(compacted.turns['6']!.input).toBeUndefined();
    expect(compacted.turns['6']!.decision!.estimates![0]!.track).toEqual(log.turns['6']!.decision!.estimates![0]!.track);
  });

  it('a log written without a map id reads as before; a malformed one is dropped', async () => {
    expect(await recordDecision(dir, GAME, ME, { turn: 6, board, input, plan })).toBe(true);
    expect((await readDecisionLog(dir, GAME))!.mapId).toBeUndefined();
    const path = join(dir, 'decisions', `${GAME}.json`);
    const raw = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(path, JSON.stringify({ ...raw, mapId: 'seventy' }));
    expect((await readDecisionLog(dir, GAME))!.mapId).toBeUndefined();
  });
});

describe('pinned maps (#586)', () => {
  it('a pinned map is never evicted and does not count toward the cap; unpinned it ages out again', async () => {
    await writeStoredMap(dir, mapOf(1));
    expect(await pinStoredMap(dir, 1, GAME)).toBe(true);
    expect(await pinStoredMap(dir, 1, GAME)).toBe(false);
    for (let id = 2; id <= MAX_STORED_MAPS + 5; id++) await writeStoredMap(dir, mapOf(id));
    expect(existsSync(mapStorePath(dir, 1))).toBe(true);
    // The cap counts unpinned maps only: MAX_STORED_MAPS of them stay beside the pinned one.
    const kept = [...Array(MAX_STORED_MAPS + 5).keys()].map((i) => i + 1).filter((id) => existsSync(mapStorePath(dir, id)));
    expect(kept).toHaveLength(MAX_STORED_MAPS + 1);
    expect(await readStoredMap(dir, 1)).toMatchObject({ id: 1 });

    expect(await unpinGames(dir, [GAME])).toBe(true);
    expect(await unpinGames(dir, [GAME])).toBe(false);
    expect(await unpinGames(dir, [])).toBe(false);
    expect(await pinnedMapIds(dir)).toEqual(new Set());
    await writeStoredMap(dir, mapOf(999));
    // Least recently used again: map 1 was read above, so an older one goes first; it is only no longer protected.
    const after = [...Array(MAX_STORED_MAPS + 5).keys()].map((i) => i + 1).filter((id) => existsSync(mapStorePath(dir, id)));
    expect(after.length + 1).toBe(MAX_STORED_MAPS);
  });

  it('a game re-pinned to another map moves its pin; two games share a map until both unpin', async () => {
    await pinStoredMap(dir, 1, GAME);
    await pinStoredMap(dir, 2, GAME);
    await pinStoredMap(dir, 2, GAME + 1);
    expect(await pinnedMapIds(dir)).toEqual(new Set([2]));
    await unpinGames(dir, [GAME]);
    expect(await pinnedMapIds(dir)).toEqual(new Set([2]));
    await unpinGames(dir, [GAME + 1]);
    expect(await pinnedMapIds(dir)).toEqual(new Set());
  });

  it('a pins file that does not read is ignored (and replaced by the next pin)', async () => {
    await mkdir(mapsDir(dir), { recursive: true });
    await writeFile(join(mapsDir(dir), 'pinned.json'), '{not json');
    expect(await pinnedMapIds(dir)).toEqual(new Set());
    await writeFile(join(mapsDir(dir), 'pinned.json'), JSON.stringify({ version: 1, pins: [[GAME, 5], ['x', 6], [1]] }));
    expect(await pinnedMapIds(dir)).toEqual(new Set([5]));
    expect(await pinStoredMap(dir, 7, GAME + 1)).toBe(true);
    expect(await pinnedMapIds(dir)).toEqual(new Set([5, 7]));
  });

  it('pruning a decision log unpins its map', async () => {
    await recordDecision(dir, GAME, ME, { turn: 6, board, input, plan, mapId: 77 });
    await updateDecisionLog(dir, GAME, ME, (log) => ({ ...log, status: 'finished' }));
    await pinStoredMap(dir, 77, GAME);
    await pinStoredMap(dir, 78, GAME + 1);
    expect(await pruneDecisionLogs(dir, { maxGames: 0 })).toEqual([GAME]);
    expect(await pinnedMapIds(dir)).toEqual(new Set([78]));
  });
});

describe('capturePlan pins the map of a logged game (#586)', () => {
  const graph = buildGraph(mapOf(77));
  const args = {
    gameId: GAME,
    me: ME,
    turn: 6,
    board,
    input: { ...input, graph } as PlanInput,
    plan,
    outlookState: null,
    estimates: [estimate],
    graph,
    income: 5,
    players: [{ id: ME }, { id: FOE }],
  };

  it('logs the map id and pins it', async () => {
    await capturePlan({ dataDir: dir }, args);
    expect((await readDecisionLog(dir, GAME))!.mapId).toBe(77);
    expect(await pinnedMapIds(dir)).toEqual(new Set([77]));
    // A re-plan of a turn already sent writes nothing, but the log exists: the pin stays.
    await updateDecisionLog(dir, GAME, ME, (log) => ({ ...log, turns: { ...log.turns, '6': { ...log.turns['6']!, sent: { deploys: [], moves: [] } } } }));
    await unpinGames(dir, [GAME]);
    await capturePlan({ dataDir: dir }, args);
    expect(await pinnedMapIds(dir)).toEqual(new Set([77]));
  });

  it('with the decision log off nothing is pinned', async () => {
    await capturePlan({ dataDir: dir, decisionLog: 'off' }, args);
    expect(existsSync(join(dir, 'decisions', `${GAME}.json`))).toBe(false);
    expect(await pinnedMapIds(dir)).toEqual(new Set());
  });

  it('with no data directory nothing happens', async () => {
    await expect(capturePlan({}, args)).resolves.toBeUndefined();
  });
});
