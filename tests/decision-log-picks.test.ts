// #437 task 3: the picks phase in the decision log — the pick advisor's summary (a re-plan replaces it),
// the list warapp_submit_picks sent and read back (the latest send wins, counted), and the award read on
// turn 1 (written once). Kept through compaction and the end-of-game passes; old logs still read.
// Synthetic ids only.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardState } from '../src/board.js';
import {
  compactDecisionLog,
  decisionLogPath,
  finishDecisionLogs,
  type PicksAdvice,
  readDecisionLog,
  recordObservation,
  recordPicksAdvice,
  recordPicksAward,
  recordPicksSent,
} from '../src/decision-log.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-decisions-picks-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ME = 1001;
const GAME = 7004;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const board: BoardState = { source: 'gamefeed', verified: true, territories: [{ territoryId: 1, owner: { kind: 'player', playerId: ME }, armies: 5 }] };

const advice = (primary: number[], over: Partial<PicksAdvice> = {}): PicksAdvice => ({
  at: new Date(T0).toISOString(),
  players: 2,
  territoryLimit: primary.length,
  maxPicks: primary.length + 2,
  spread: false,
  list: [...primary, 40, 41],
  primary,
  fallback: [40, 41],
  scores: primary.map((t, i) => ({ territory: t, score: 10 - i })),
  groupScores: { primary: 20, fallback: 8 },
  warnings: ['luck'],
  award: { outcomes: 3, orders: ['reversing'], worst: { territories: [primary[0]!, 40], score: 12, opponentStarts: [primary[1]!] }, reordered: false },
  coverage: { share: 0.5, covered: 2, reasonable: 4 },
  ...over,
});

describe('recordPicksAdvice', () => {
  it('starts a log with the advisor summary, and a re-plan replaces it', async () => {
    expect(await recordPicksAdvice(dir, GAME, ME, advice([10, 11]))).toBe(true);
    expect((await readDecisionLog(dir, GAME))!.picks!.advice!.primary).toEqual([10, 11]);
    expect(await recordPicksAdvice(dir, GAME, ME, advice([12, 13], { warnings: [] }))).toBe(true);
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.picks!.advice).toEqual(advice([12, 13], { warnings: [] }));
    expect(log.picks!.advices).toBe(2);
  });
});

describe('recordPicksSent', () => {
  it('keeps the list sent and read back; a later send replaces it and is counted', async () => {
    await recordPicksAdvice(dir, GAME, ME, advice([10, 11]));
    expect(await recordPicksSent(dir, GAME, ME, { sent: [10, 11], readBack: [11, 10], verified: false, outcome: 'unconfirmed', now: T0 })).toBe(true);
    let picks = (await readDecisionLog(dir, GAME))!.picks!;
    expect(picks.submitted).toEqual({ at: new Date(T0).toISOString(), sent: [10, 11], readBack: [11, 10], verified: false, outcome: 'unconfirmed' });
    expect(picks.advice!.primary).toEqual([10, 11]);
    await recordPicksSent(dir, GAME, ME, { sent: [10, 11], readBack: [10, 11], verified: true, outcome: 'confirmed', now: T0 + 1000 });
    picks = (await readDecisionLog(dir, GAME))!.picks!;
    expect(picks.submitted!.verified).toBe(true);
    expect(picks.submits).toBe(2);
  });

  it('starts a log when the game has none', async () => {
    await recordPicksSent(dir, GAME, ME, { sent: [5], readBack: null, verified: false, outcome: 'unknown', now: T0 });
    expect((await readDecisionLog(dir, GAME))!.picks!.submitted!.readBack).toBeNull();
  });
});

describe('recordPicksAward', () => {
  const reading = { granted: [10], unlisted: [], opponentStarts: [11], allStartsKnown: true, role: 'first' as const, opponentFirstAward: 11 };

  it('keeps the award read on turn 1 once, never overwriting it', async () => {
    expect(await recordPicksAward(dir, GAME, ME, { turn: 1, reading, now: T0 })).toBe(true);
    expect(await recordPicksAward(dir, GAME, ME, { turn: 1, reading: null, now: T0 + 1 })).toBe(false);
    expect((await readDecisionLog(dir, GAME))!.picks!.award).toEqual({ at: new Date(T0).toISOString(), turn: 1, reading });
  });

  it('keeps an award that could not be read as null', async () => {
    await recordPicksAward(dir, GAME, ME, { turn: 1, reading: null, now: T0 });
    expect((await readDecisionLog(dir, GAME))!.picks!.award!.reading).toBeNull();
  });
});

describe('the picks block through the end of a game and old logs', () => {
  it('compaction keeps it, and a log holding only picks is finished and compacted', async () => {
    await recordPicksAdvice(dir, GAME, ME, advice([10, 11]));
    await recordPicksSent(dir, GAME, ME, { sent: [10, 11], readBack: [10, 11], verified: true, outcome: 'confirmed', now: T0 });
    expect(await finishDecisionLogs(dir, [GAME], ME, { mode: 'on' })).toEqual([GAME]);
    const before = (await readDecisionLog(dir, GAME))!;
    expect(await compactDecisionLog(dir, GAME, ME, { mode: 'on' })).toBe(true);
    const after = (await readDecisionLog(dir, GAME))!;
    expect(after.status).toBe('compacted');
    expect(after.picks).toEqual(before.picks);
  });

  it('a turn logged later keeps the picks block', async () => {
    await recordPicksAdvice(dir, GAME, ME, advice([10, 11]));
    await recordObservation(dir, GAME, ME, 1, board, 'live');
    expect((await readDecisionLog(dir, GAME))!.picks!.advice!.primary).toEqual([10, 11]);
  });

  it('an old log without it still reads, and gains it additively', async () => {
    await mkdir(join(dir, 'decisions'), { recursive: true });
    await writeFile(
      decisionLogPath(dir, GAME),
      JSON.stringify({ version: 1, gameId: GAME, playerId: ME, status: 'active', turns: { '2': { kind: 'observed', source: 'live' } } }),
    );
    expect((await readDecisionLog(dir, GAME))!.picks).toBeUndefined();
    await recordPicksAward(dir, GAME, ME, { turn: 1, reading: null, now: T0 });
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.version).toBe(1);
    expect(log.picks!.award!.turn).toBe(1);
    expect(log.turns['2']!.kind).toBe('observed');
  });

  it('writes nothing with the decision log off', async () => {
    expect(await recordPicksAdvice(dir, GAME, ME, advice([10]), { mode: 'off' })).toBe(false);
    expect(await recordPicksSent(dir, GAME, ME, { sent: [10], readBack: [10], verified: true, outcome: 'confirmed' }, { mode: 'off' })).toBe(false);
    expect(await recordPicksAward(dir, GAME, ME, { turn: 1, reading: null }, { mode: 'off' })).toBe(false);
    expect(await readDecisionLog(dir, GAME)).toBeUndefined();
  });
});
