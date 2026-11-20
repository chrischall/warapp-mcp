// The decision log at the end of a game (#412 task 3): the truth and accuracy written for every turn,
// compaction that drops only uninteresting turns' replay input (no-gaps rule (b)), and the prune that
// runs after writes. Synthetic ids only.
import { mkdtemp, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TruthResult } from '../src/analysis/decision-truth.js';
import type { BoardState, TerritoryState } from '../src/board.js';
import {
  compactDecisionLog,
  compactLog,
  type DecisionEntry,
  type DecisionLog,
  decisionLogPath,
  interestingTurns,
  loggedEstimates,
  type loggedTurns,
  loggedTurns as loggedTurnsOf,
  readDecisionLog,
  recordDecision,
  recordTruth,
  updateDecisionLog,
} from '../src/decision-log.js';
import type { PlanInput, TurnPlan } from '../src/analysis/plan/shared.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-decisions-end-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ME = 1001;
const FOE = 2002;
const GAME = 7101;

const t = (territoryId: number, owner: number | 'fog', armies: number | null): TerritoryState => ({
  territoryId,
  owner: owner === 'fog' ? { kind: 'unknown' } : { kind: 'player', playerId: owner },
  armies,
  ...(owner === 'fog' ? { fogLevel: 'Fogged' } : {}),
});
const full = (turn: number): BoardState => ({ source: 'gamefeed', verified: true, territories: [t(1, ME, turn), t(2, 'fog', null)] });

/** A decided entry: an input, a decision with the given outlook and expected next income, and its outcome. */
const decided = (turn: number, o: { outlook?: string; outlookLean?: string; expected?: number; next?: number; eliminated?: boolean; override?: boolean } = {}): DecisionEntry =>
  ({
    kind: 'planned',
    board: { kind: 'full', source: 'gamefeed', verified: true, territories: full(turn).territories },
    input: { income: 5, turn },
    planner: { version: 'test' },
    decision: {
      goal: 'balanced',
      deploys: [{ territoryId: 1, armies: 5 }],
      moves: [],
      expected: { captures: [], bonusesCompleted: [], nextIncome: o.expected ?? 5 },
      conceded: [],
      offence: [],
      enemyDeploy: 5,
      rationale: [`Turn ${turn}.`],
      warnings: [],
      outlook: o.outlook ?? 'even',
      ...(o.outlookLean ? { outlookLean: o.outlookLean } : {}),
      estimates: [{ player: FOE, estimate: 5, source: 'tracked', coverage: 0.5, thin: false }],
      income: 5,
    },
    ...(o.next !== undefined || o.eliminated ? { next: { income: o.next ?? 5, gained: [], lost: [], capturesMade: [], capturesMissed: [], bonusesHeld: [], eliminated: !!o.eliminated } } : {}),
    ...(o.override ? { sent: { deploys: [], moves: [] }, override: { by: 'hand' } } : {}),
  }) as unknown as DecisionEntry;

const logOf = (turns: Record<number, DecisionEntry>): DecisionLog => ({
  version: 1,
  gameId: GAME,
  playerId: ME,
  status: 'active',
  turns: Object.fromEntries(Object.entries(turns)),
});

const write = (log: DecisionLog) => updateDecisionLog(dir, GAME, ME, () => log, { mode: 'on' });

/** Twelve decided turns: nothing interesting but the first three, unless a test adds it. */
const twelve = (patch: Record<number, Parameters<typeof decided>[1]> = {}) =>
  logOf(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, decided(i + 1, { next: 5, ...patch[i + 1] })])));

describe('compaction (#412 task 3, no-gaps rule (b))', () => {
  it('keeps the first three decided turns whole and drops only the input of uninteresting ones', () => {
    const log = twelve();
    expect([...interestingTurns(log)].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    const c = compactLog(log);
    expect(c.status).toBe('compacted');
    for (const k of Object.keys(log.turns)) {
      const before = log.turns[k]!;
      const after = c.turns[k]!;
      // Never dropped: the board, the decision (rationale, warnings, estimates), sent, override, next.
      expect(after.board).toEqual(before.board);
      expect(after.decision).toEqual(before.decision);
      expect(after.next).toEqual(before.next);
      expect(!!after.input).toBe(Number(k) <= 3);
    }
  });

  it('keeps an override, an outlook change, an income shortfall, an estimate off by 1.5×, and the turns up to an elimination', () => {
    const log = twelve({
      5: { override: true },
      7: { outlook: 'winning' }, // changed from 6 (even) — and 8 changes back
      9: { expected: 10, next: 8 }, // 20% short
      12: { eliminated: true },
    });
    log.turns['6']!.accuracy = {
      estimates: [{ player: FOE, estimate: 2, truth: 9, ratio: 0.22, source: 'tracked', coverage: 0.1, thin: true }],
      outlook: { logged: 'even', truth: 'losing', right: false },
      myIncome: 5,
      hiddenStacks: 0,
    };
    const keep = [...interestingTurns(log)].sort((a, b) => a - b);
    expect(keep).toEqual([1, 2, 3, 5, 6, 7, 8, 9, 10, 11, 12]);
    // A game lost: the last five decided turns are kept even with no elimination logged.
    const lost = twelve();
    expect([...interestingTurns(lost, { lost: true })].sort((a, b) => a - b)).toEqual([1, 2, 3, 8, 9, 10, 11, 12]);
  });

  it('#454: an income lean beside an even outlook is an outlook change too, and a decision logged with the lean as the state reads alike', () => {
    // Turn 5 leans behind beside even (#454's additive field); turn 8 was written with `behind` as the state (#453).
    const log = twelve({ 5: { outlookLean: 'behind' }, 8: { outlook: 'behind' } });
    expect([...interestingTurns(log)].sort((a, b) => a - b)).toEqual([1, 2, 3, 5, 6, 8, 9]);
    const turns = loggedTurnsOf(log);
    expect(turns.get(5)?.outlook).toBe('behind');
    expect(turns.get(8)?.outlook).toBe('behind');
    expect(turns.get(6)?.outlook).toBe('even');
  });

  it('compacts a stored log once: the board, decision and truth of every turn survive, status compacted, idempotent', async () => {
    const log = twelve();
    log.turns['4']!.truth = { board: 3, mine: { income: 5, armies: 4, territories: 1 }, opponents: [] };
    log.turns['13'] = { truth: { board: 12, mine: { income: 5, armies: 4, territories: 1 }, opponents: [] } };
    expect(await write(log)).toBe(true);
    expect(await compactDecisionLog(dir, GAME, ME, { mode: 'on' })).toBe(true);
    const once = await readFile(decisionLogPath(dir, GAME), 'utf8');
    const c = (await readDecisionLog(dir, GAME))!;
    expect(c.status).toBe('compacted');
    for (const k of Object.keys(log.turns)) {
      expect(c.turns[k]!.board).toEqual(log.turns[k]!.board);
      expect(c.turns[k]!.decision).toEqual(log.turns[k]!.decision);
      expect(c.turns[k]!.truth).toEqual(log.turns[k]!.truth);
    }
    expect(c.turns['4']!.input).toBeUndefined();
    expect(c.turns['1']!.input).toBeDefined();
    // Again: nothing to drop, nothing written.
    expect(await compactDecisionLog(dir, GAME, ME, { mode: 'on' })).toBe(false);
    expect(await readFile(decisionLogPath(dir, GAME), 'utf8')).toBe(once);
  });

  it('keeps everything under WARAPP_DECISION_LOG=full (marked finished), writes nothing when off, and starts no log', async () => {
    await write(twelve());
    expect(await compactDecisionLog(dir, GAME, ME, { mode: 'full' })).toBe(true);
    const f = (await readDecisionLog(dir, GAME))!;
    expect(f.status).toBe('finished');
    expect(Object.values(f.turns).every((e) => e.input)).toBe(true);
    expect(await compactDecisionLog(dir, GAME, ME, { mode: 'off' })).toBe(false);
    expect(await compactDecisionLog(dir, GAME + 1, ME, { mode: 'on' })).toBe(false);
    expect(await readDecisionLog(dir, GAME + 1)).toBeUndefined();
  });
});

describe('end-of-game truth in the log (#412 task 3)', () => {
  const result = (turns: number[]): TruthResult => ({
    truth: new Map(turns.map((turn) => [turn, { board: turn - 1, mine: { income: 5, armies: 3, territories: 1 }, opponents: [{ player: FOE, income: 9, armies: 7, territories: 2, bonuses: [], hidden: [[2, 7]] }] }])),
    accuracy: new Map([[2, { estimates: [{ player: FOE, estimate: 5, truth: 9, ratio: 0.555556, source: 'tracked', coverage: 0.5, thin: false }], outlook: { logged: 'even', truth: 'even', right: true }, myIncome: 5, hiddenStacks: 1 }]]),
    summary: { estimates: { n: 1, mean: 0.555556, geoMean: 0.555556, under: 0, over: 0 }, byCoverage: {}, bySource: {}, outlook: { right: 1, wrong: 0 }, turns: turns.length, turnsWithHiddenStacks: 1 },
    missing: [4],
  });

  it('hands the logged turns to the scorer and writes truth for every turn (truth-only entries too), accuracy, summary and missing turns', async () => {
    await write(logOf({ 2: decided(2) }));
    let seen: ReturnType<typeof loggedTurns> | undefined;
    expect(
      await recordTruth(dir, GAME, ME, (l) => {
        seen = l;
        return result([1, 2, 3]);
      }, { mode: 'on' }),
    ).toBe(true);
    expect([...seen!.keys()]).toEqual([2]);
    expect(seen!.get(2)).toMatchObject({ outlook: 'even', myIncome: 5, estimates: [{ player: FOE, estimate: 5 }] });
    expect(seen!.get(2)!.board).toEqual(full(2));
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.status).toBe('finished');
    expect(log.turns['1']).toEqual({ truth: result([1]).truth.get(1) });
    expect(log.turns['2']!.decision).toBeDefined();
    expect(log.turns['2']!.accuracy).toMatchObject({ hiddenStacks: 1, outlook: { right: true } });
    expect(log.truthMissing).toEqual([4]);
    expect(log.accuracySummary).toMatchObject({ outlook: { right: 1 } });
  });

  it('is idempotent: running it again replaces what it wrote', async () => {
    await write(logOf({ 2: decided(2) }));
    await recordTruth(dir, GAME, ME, () => result([1, 2, 3]), { mode: 'on' });
    const once = await readFile(decisionLogPath(dir, GAME), 'utf8');
    await recordTruth(dir, GAME, ME, () => result([1, 2, 3]), { mode: 'on' });
    expect(await readFile(decisionLogPath(dir, GAME), 'utf8')).toBe(once);
    // A narrower truth drops the truth-only entries it no longer covers.
    await recordTruth(dir, GAME, ME, () => result([2]), { mode: 'on' });
    expect(Object.keys((await readDecisionLog(dir, GAME))!.turns)).toEqual(['2']);
  });

  it('my income reads the same after compaction: the planned income (card armies out) is kept in the decision', async () => {
    await recordDecision(dir, GAME, ME, {
      turn: 1,
      board: full(1),
      input: { board: full(1), me: ME, income: 9, cardArmies: 2, turn: 1 } as unknown as PlanInput,
      plan: decided(1).decision as unknown as TurnPlan,
    });
    expect((await readDecisionLog(dir, GAME))!.turns['1']!.decision!.income).toBe(7);
  });

  it('is idempotent on a compacted log: an uninteresting turn that lost its input, with no outcome on the turn before, scores the same', async () => {
    // Turn 5 has no outcome; turn 6 planned on 8 income with 1 from cards (7 earned) and is uninteresting.
    const log = twelve({ 5: { next: undefined } });
    delete log.turns['5']!.next;
    log.turns['6']!.input = { income: 8, cardArmies: 1, turn: 6 } as never;
    // Written before the decision kept its income: compaction copies it over from the input it drops.
    delete log.turns['6']!.decision!.income;
    await write(log);
    // What the scorer is handed for my income, echoed into the accuracy it writes.
    const echo = (l: ReturnType<typeof loggedTurns>): TruthResult => ({
      ...result([]),
      accuracy: new Map(
        [...l].map(([turn, lt]) => [turn, { estimates: [], outlook: { logged: lt.outlook, truth: null, right: null }, myIncome: lt.myIncome ?? -1, hiddenStacks: 0 }]),
      ),
    });
    expect(await recordTruth(dir, GAME, ME, echo, { mode: 'on' })).toBe(true);
    expect(await compactDecisionLog(dir, GAME, ME, { mode: 'on' })).toBe(true);
    const once = await readFile(decisionLogPath(dir, GAME), 'utf8');
    const c = (await readDecisionLog(dir, GAME))!;
    expect(c.turns['6']!.input).toBeUndefined();
    expect(c.turns['6']!.decision!.income).toBe(7);
    expect(c.turns['6']!.accuracy!.myIncome).toBe(7);
    // The pass again on the compacted log: the same file.
    await recordTruth(dir, GAME, ME, echo, { mode: 'on' });
    expect(await compactDecisionLog(dir, GAME, ME, { mode: 'on' })).toBe(false);
    expect(await readFile(decisionLogPath(dir, GAME), 'utf8')).toBe(once);
  });

  it('starts no log for a game played without one (nor fills a truth-only one), and keeps a compacted log compacted', async () => {
    let asked = false;
    const make = () => {
      asked = true;
      return result([1]);
    };
    expect(await recordTruth(dir, GAME, ME, make, { mode: 'on' })).toBe(false);
    expect(await readDecisionLog(dir, GAME)).toBeUndefined();
    await write(logOf({}));
    expect(await recordTruth(dir, GAME, ME, make, { mode: 'on' })).toBe(false);
    await write({ ...logOf({}), turns: { '1': { truth: result([1]).truth.get(1) } } as never });
    expect(await recordTruth(dir, GAME, ME, make, { mode: 'on' })).toBe(false);
    expect(asked).toBe(false);
    await write({ ...logOf({ 2: decided(2) }), status: 'compacted' });
    expect(await recordTruth(dir, GAME, ME, make, { mode: 'on' })).toBe(true);
    expect((await readDecisionLog(dir, GAME))!.status).toBe('compacted');
  });

  it('logs estimates name-free: ids, figures, source, coverage and the thin flag', () => {
    expect(
      loggedEstimates([
        { playerId: 3, estimate: 9, source: 'prior', coverage: { share: 0.25 }, thinEvidence: { midpoint: 9 } },
        { playerId: 2, estimate: 5, source: 'visible', coverage: null, thinEvidence: null },
      ] as never),
    ).toEqual([
      { player: 2, estimate: 5, source: 'visible', coverage: null, thin: false },
      { player: 3, estimate: 9, source: 'prior', coverage: 0.25, thin: true },
    ]);
  });
});

describe('the prune after writes (#412 task 3)', () => {
  it('runs after a write at most once per interval, oldest finished games first', async () => {
    const caps = { maxGames: 2 };
    for (const [i, g] of [9001, 9002, 9003].entries()) {
      await updateDecisionLog(dir, g, ME, (l) => ({ ...l, status: 'finished', turns: { '1': decided(1) } }), { mode: 'on' });
      const when = new Date(Date.UTC(2026, 0, 1 + i));
      await utimes(decisionLogPath(dir, g), when, when);
    }
    // The first write in this dir already used the interval (with the default caps: nothing went).
    expect(await readDecisionLog(dir, 9001)).toBeDefined();
    // Within the interval: no prune, even with tight caps.
    await updateDecisionLog(dir, GAME, ME, (l) => ({ ...l, turns: { '1': decided(1) } }), { mode: 'on', caps });
    expect(await readDecisionLog(dir, 9001)).toBeDefined();
  });

  it('prunes on the first write in a data dir with the caps given', async () => {
    const other = await mkdtemp(join(tmpdir(), 'warapp-decisions-prune-'));
    try {
      // Two finished logs written straight to disk (no write through the store yet in this dir).
      const { writeJsonAtomic } = await import('../src/map-store.js');
      for (const [i, g] of [9001, 9002].entries()) {
        await writeJsonAtomic(decisionLogPath(other, g), join(other, 'decisions'), { version: 1, gameId: g, playerId: ME, status: 'finished', turns: {} });
        const when = new Date(Date.UTC(2026, 0, 1 + i));
        await utimes(decisionLogPath(other, g), when, when);
      }
      await updateDecisionLog(other, GAME, ME, (l) => ({ ...l, turns: { '1': decided(1) } }), { mode: 'on', caps: { maxGames: 2 } });
      expect(await readDecisionLog(other, 9001)).toBeUndefined();
      expect(await readDecisionLog(other, 9002)).toBeDefined();
      expect(await readDecisionLog(other, GAME)).toBeDefined();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });
});
