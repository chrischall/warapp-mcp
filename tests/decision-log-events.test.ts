// #437 task 2: the per-game additions to the decision log — seat events diffed against the last seen
// states, the other events (a pending surrender seen, my acceptance, my own surrender), the join context
// and the opponents (first-seen turn, level and ranked record when a tool read them). Each written once,
// bounded, kept through compaction and the end-of-game passes; old logs still read. Synthetic ids only.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardState } from '../src/board.js';
import {
  compactDecisionLog,
  decisionLogPath,
  finishDecisionLogs,
  type JoinContext,
  MAX_GAME_EVENTS,
  readDecisionLog,
  recordGameEvent,
  recordJoin,
  recordObservation,
  recordOpponentRead,
  recordSeats,
  seatEvents,
} from '../src/decision-log.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-decisions-events-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ME = 1001;
const FOE = 2002;
const CAT = 3003;
const GAME = 7003;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

const seat = (id: number, state = 'Playing', turnedAI = false) => ({ id, state, isAI: false, humanTurnedIntoAI: turnedAI });
const board: BoardState = { source: 'gamefeed', verified: true, territories: [{ territoryId: 1, owner: { kind: 'player', playerId: ME }, armies: 5 }] };

describe('seatEvents (pure)', () => {
  it('names each change into a seat state that matters, once, and says nothing for a seat still playing', () => {
    const first = seatEvents(undefined, [seat(ME), seat(FOE), seat(CAT)], 3, T0);
    expect(first.events).toEqual([]);
    expect(first.seats).toEqual({ [ME]: { state: 'Playing', ai: false }, [FOE]: { state: 'Playing', ai: false }, [CAT]: { state: 'Playing', ai: false } });
    const next = seatEvents(first.seats, [seat(ME), seat(FOE, 'Booted', true), seat(CAT, 'SurrenderAccepted')], 5, T0);
    expect(next.events).toEqual([
      { turn: 5, kind: 'booted', player: FOE, at: new Date(T0).toISOString() },
      { turn: 5, kind: 'turned-ai', player: FOE, at: new Date(T0).toISOString() },
      { turn: 5, kind: 'surrender-accepted', player: CAT, at: new Date(T0).toISOString() },
    ]);
    expect(seatEvents(next.seats, [seat(ME), seat(FOE, 'Booted', true), seat(CAT, 'SurrenderAccepted')], 6, T0).events).toEqual([]);
  });

  it('maps eliminated and ended-by-vote, and keeps any other state as a seat-state with its word', () => {
    const was = seatEvents(undefined, [seat(ME), seat(FOE), seat(CAT)], 1, T0).seats;
    const r = seatEvents(was, [seat(ME, 'Won'), seat(FOE, 'Eliminated'), seat(CAT, 'EndedByVote')], 9, T0);
    expect(r.events.map((e) => [e.kind, e.player, e.detail])).toEqual([
      ['seat-state', ME, 'Won'],
      ['eliminated', FOE, undefined],
      ['ended-by-vote', CAT, undefined],
    ]);
  });

  it('at first sight logs a seat already out (the change happened before it was seen)', () => {
    const r = seatEvents(undefined, [seat(ME), seat(FOE, 'Booted')], 4, T0);
    expect(r.events.map((e) => [e.kind, e.player])).toEqual([['booted', FOE]]);
  });

  it('never carries a state word that is not a plain word', () => {
    const was = seatEvents(undefined, [seat(ME)], 1, T0).seats;
    const r = seatEvents(was, [seat(ME, 'Some <b>thing</b>')], 2, T0);
    expect(r.events).toEqual([{ turn: 2, kind: 'seat-state', player: ME, detail: 'other', at: new Date(T0).toISOString() }]);
  });
});

describe('recordSeats', () => {
  it('writes the seat events and the last seen states, never twice for the same change', async () => {
    await recordObservation(dir, GAME, ME, 2, board, 'live');
    expect(await recordSeats(dir, GAME, ME, { turn: 2, players: [seat(ME), seat(FOE)], now: T0 })).toBe(true);
    expect((await readDecisionLog(dir, GAME))!.events ?? []).toEqual([]);
    expect(await recordSeats(dir, GAME, ME, { turn: 4, players: [seat(ME), seat(FOE, 'Booted')], now: T0 })).toBe(true);
    expect(await recordSeats(dir, GAME, ME, { turn: 5, players: [seat(ME), seat(FOE, 'Booted')], now: T0 })).toBe(false);
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.events).toEqual([{ turn: 4, kind: 'booted', player: FOE, at: new Date(T0).toISOString() }]);
    expect(log.seats).toEqual({ [ME]: { state: 'Playing', ai: false }, [FOE]: { state: 'Booted', ai: false } });
    // The turns are untouched.
    expect(log.turns['2']!.kind).toBe('observed');
  });

  it('records each other seat first seen, by id, with the turn and whether it was an AI', async () => {
    await recordSeats(dir, GAME, ME, { turn: 0, players: [seat(ME), seat(FOE)], create: true, now: T0 });
    await recordSeats(dir, GAME, ME, { turn: 3, players: [seat(ME), seat(FOE), { id: CAT, state: 'Playing', isAI: true, humanTurnedIntoAI: false }], now: T0 });
    expect((await readDecisionLog(dir, GAME))!.opponents).toEqual({ [FOE]: { firstSeen: 0 }, [CAT]: { firstSeen: 3, ai: true } });
  });

  it('starts no log unless asked to', async () => {
    expect(await recordSeats(dir, GAME, ME, { turn: 1, players: [seat(ME), seat(FOE)] })).toBe(false);
    expect(await readDecisionLog(dir, GAME)).toBeUndefined();
    expect(await recordSeats(dir, GAME, ME, { turn: 1, players: [seat(ME), seat(FOE)], create: true })).toBe(true);
    expect((await readDecisionLog(dir, GAME))!.turns).toEqual({});
  });

  it('keeps at most MAX_GAME_EVENTS, the newest, and counts the rest', async () => {
    const many = Array.from({ length: MAX_GAME_EVENTS + 5 }, (_, i) => seat(10_000 + i));
    await recordSeats(dir, GAME, ME, { turn: 1, players: [seat(ME), ...many], create: true });
    await recordSeats(dir, GAME, ME, { turn: 2, players: [seat(ME), ...many.map((p) => ({ ...p, state: 'Booted' }))] });
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.events).toHaveLength(MAX_GAME_EVENTS);
    expect(log.eventsDropped).toBe(5);
    expect(log.events!.at(-1)!.player).toBe(10_000 + MAX_GAME_EVENTS + 4);
  });
});

describe('recordGameEvent', () => {
  it('logs a pending surrender, my acceptance and my own surrender once each', async () => {
    await recordObservation(dir, GAME, ME, 4, board, 'live');
    expect(await recordGameEvent(dir, GAME, ME, { turn: 4, kind: 'surrender-pending', player: FOE, detail: 'owed', now: T0 })).toBe(true);
    expect(await recordGameEvent(dir, GAME, ME, { turn: 5, kind: 'surrender-pending', player: FOE, detail: 'owed', now: T0 })).toBe(false);
    expect(await recordGameEvent(dir, GAME, ME, { turn: 5, kind: 'surrender-accepted-by-me', player: FOE, now: T0 })).toBe(true);
    const detail = { status: 'pending' as const, income: 8, strongest: { player: CAT, income: 20, source: 'tracked' as const, thin: false }, outlook: 'losing' as const, outlookTurn: 5 };
    expect(await recordGameEvent(dir, GAME, ME, { turn: 6, kind: 'my-surrender', detail, now: T0 })).toBe(true);
    expect(await recordGameEvent(dir, GAME, ME, { turn: 6, kind: 'my-surrender', detail, now: T0 })).toBe(false);
    // Pending first, then accepted: two different moments of my surrender.
    expect(await recordGameEvent(dir, GAME, ME, { turn: 7, kind: 'my-surrender', detail: { ...detail, status: 'surrendered' }, now: T0 })).toBe(true);
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.events!.map((e) => [e.turn, e.kind, e.player ?? null])).toEqual([
      [4, 'surrender-pending', FOE],
      [5, 'surrender-accepted-by-me', FOE],
      [6, 'my-surrender', null],
      [7, 'my-surrender', null],
    ]);
    expect(log.events![2]!.detail).toEqual(detail);
  });

  it('starts a log only when asked to', async () => {
    expect(await recordGameEvent(dir, GAME, ME, { turn: 1, kind: 'surrender-pending', player: FOE })).toBe(false);
    expect(await recordGameEvent(dir, GAME, ME, { turn: 1, kind: 'surrender-pending', player: FOE }, { create: true })).toBe(true);
    expect((await readDecisionLog(dir, GAME))!.events).toHaveLength(1);
  });
});

const JOIN: JoinContext = {
  at: new Date(T0).toISOString(),
  settingsKey: 'sha256:0123456789abcdef',
  flags: { format: '1v1', seats: 2, localDeployments: false, commanders: true, killRates: { offence: 60, defence: 70 }, luck: 0, fog: 'Foggy', cards: ['Reinforcement'] },
  policy: { passes: true, broke: [], passed: ['commerce', 'mods'], unchecked: [] },
};

describe('recordJoin and recordOpponentRead', () => {
  it('keeps the join context on a new log, which a later turn keeps', async () => {
    expect(await recordJoin(dir, GAME, ME, JOIN)).toBe(true);
    await recordObservation(dir, GAME, ME, 1, board, 'live');
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.join).toEqual(JOIN);
    expect(log.turns['1']!.kind).toBe('observed');
  });

  it('adds an opponent\'s level and ranked record when read, only to a log that exists', async () => {
    const read = { turn: 3, level: 42, ranked: { completed: 10, wins: 6, games: 10 }, bootRatePct: 2 };
    expect(await recordOpponentRead(dir, GAME, ME, FOE, read)).toBe(false);
    await recordSeats(dir, GAME, ME, { turn: 1, players: [seat(ME), seat(FOE)], create: true });
    expect(await recordOpponentRead(dir, GAME, ME, FOE, read)).toBe(true);
    expect(await recordOpponentRead(dir, GAME, ME, CAT, { ...read, level: null })).toBe(true);
    expect((await readDecisionLog(dir, GAME))!.opponents).toEqual({
      [FOE]: { firstSeen: 1, level: 42, ranked: { completed: 10, wins: 6, games: 10 }, bootRatePct: 2, readTurn: 3 },
      [CAT]: { firstSeen: 3, level: null, ranked: { completed: 10, wins: 6, games: 10 }, bootRatePct: 2, readTurn: 3 },
    });
  });
});

describe('the per-game fields through the end of a game and old logs', () => {
  it('compaction and the truth keep events, seats, join and opponents', async () => {
    await recordJoin(dir, GAME, ME, JOIN);
    await recordObservation(dir, GAME, ME, 1, board, 'live');
    await recordSeats(dir, GAME, ME, { turn: 1, players: [seat(ME), seat(FOE)] });
    await recordSeats(dir, GAME, ME, { turn: 2, players: [seat(ME), seat(FOE, 'Booted')] });
    const before = (await readDecisionLog(dir, GAME))!;
    expect(await compactDecisionLog(dir, GAME, ME, { mode: 'on' })).toBe(true);
    const after = (await readDecisionLog(dir, GAME))!;
    expect(after.status).toBe('compacted');
    for (const k of ['events', 'seats', 'join', 'opponents'] as const) expect(after[k]).toEqual(before[k]);
  });

  it('a log with only per-game context (a lobby joined, never played) is finished and compacted, never left active', async () => {
    await recordJoin(dir, GAME, ME, JOIN);
    expect(await finishDecisionLogs(dir, [GAME], ME, { mode: 'on' })).toEqual([GAME]);
    expect((await readDecisionLog(dir, GAME))!.status).toBe('finished');
    await recordJoin(dir, GAME + 1, ME, JOIN);
    expect(await compactDecisionLog(dir, GAME + 1, ME, { mode: 'on' })).toBe(true);
    expect((await readDecisionLog(dir, GAME + 1))!.status).toBe('compacted');
  });

  it('an old log without any of them still reads, and gains them additively', async () => {
    await mkdir(join(dir, 'decisions'), { recursive: true });
    await writeFile(
      decisionLogPath(dir, GAME),
      JSON.stringify({ version: 1, gameId: GAME, playerId: ME, status: 'active', turns: { '2': { kind: 'observed', source: 'live' } } }),
    );
    const old = (await readDecisionLog(dir, GAME))!;
    expect(old.events).toBeUndefined();
    expect(old.turns['2']!.kind).toBe('observed');
    await recordSeats(dir, GAME, ME, { turn: 3, players: [seat(ME), seat(FOE, 'Eliminated')] });
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.version).toBe(1);
    expect(log.events!.map((e) => e.kind)).toEqual(['eliminated']);
    expect(log.turns['2']!.kind).toBe('observed');
  });

  it('writes nothing with the decision log off', async () => {
    expect(await recordSeats(dir, GAME, ME, { turn: 1, players: [seat(ME)], create: true }, { mode: 'off' })).toBe(false);
    expect(await recordJoin(dir, GAME, ME, JOIN, { mode: 'off' })).toBe(false);
    expect(await readDecisionLog(dir, GAME)).toBeUndefined();
  });
});
