// #437 task 1: the per-turn additions to the decision log — the build beside the planner version, the
// turn's wall-clock times, the first mover, the cards (hand, advice, played) and the checks (at submit, and
// warapp_check_plan's latest) — written by their capture points, kept through compaction, and old logs
// (written before them) still read. Synthetic ids only.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanInput, TurnPlan } from '../src/analysis/plan/shared.js';
import type { BoardState } from '../src/board.js';
import { serverBuild } from '../src/build-id.js';
import type { CommitmentWarning } from '../src/analysis/commitments.js';
import type { Card } from '../src/cards.js';
import type { CommanderCheck } from '../src/tools/commander-check.js';
import {
  type CheckPlanSummary,
  compactDecisionLog,
  compactLog,
  type DecisionLog,
  decisionLogPath,
  readDecisionLog,
  recordCheck,
  recordDecision,
  recordObservation,
  recordSubmission,
  type SubmitChecks,
} from '../src/decision-log.js';
import { bootTimes, cardAdviceLog, checkPlanLog, handLog, headroomLog, submitChecksLog } from '../src/tools/decision-capture.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-decisions-v2-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ME = 1001;
const FOE = 2002;
const GAME = 7002;
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);

const boardOn = (turn: number): BoardState => ({
  source: 'gamefeed',
  verified: true,
  territories: [
    { territoryId: 1, owner: { kind: 'player', playerId: ME }, armies: 5 + turn },
    { territoryId: 3, owner: { kind: 'player', playerId: FOE }, armies: 4 },
  ],
});

const plan = (): TurnPlan =>
  ({
    goal: 'balanced',
    profile: { format: '1v1', phase: 'contact', standing: 'even' },
    deploys: [{ territoryId: 1, armies: 5 }],
    moves: [{ from: 1, to: 3, armies: 9, kind: 'attack', reason: 'take' }],
    expected: { captures: [3], bonusesCompleted: [], nextIncome: 6 },
    warnings: [],
    rationale: [],
    enemyDeploy: 5,
    conceded: [],
    cardAdvice: null,
    offence: [],
  }) as unknown as TurnPlan;

const input = (turn: number): PlanInput =>
  ({ graph: {}, board: boardOn(turn), me: ME, income: 5, turn, options: {} }) as unknown as PlanInput;

const CARDS = {
  hand: [
    { card: 'Reinforcement', type: 1, count: 2 },
    { card: 'Bomb', type: 13, count: 1 },
  ],
  advice: [{ kind: 'bomb', targets: [3], reason: 'capture' }],
};

const record = (turn: number, extra: Record<string, unknown> = {}) =>
  recordDecision(dir, GAME, ME, {
    turn,
    board: boardOn(turn),
    input: input(turn),
    plan: plan(),
    outlookState: 'even',
    now: T0,
    firstMover: { who: 'opponent', source: 'award', verified: false },
    cards: CARDS,
    times: { turnStartedAt: '2026-11-20T11:00:00.000Z', bootAt: { auto: '2026-11-21T11:00:00.000Z' } },
    ...extra,
  });

const SUBMIT_CHECKS: SubmitChecks = {
  commander: { territory: 1, armies: 10, needs: 12, replies: 2, replyDeploy: 6, accepted: true },
  headroom: [{ territory: 1, takeAt: 4, opponent: FOE, from: 3, protects: { bonuses: [9], behindIncome: 0, breachIncome: 2 } }],
  belowPlan: [{ territory: 1, planLeaves: 9, left: 4, short: 5 }],
  belowPlanAgainst: 'plan',
  chat: [{ kind: 'no-attack', with: FOE, moves: [0] }],
};

const CHECK: CheckPlanSummary = {
  safe: false,
  worst: { opponent: FOE, kind: 'attack', deploy: 5, lost: 1, capturesFailed: 0, bonusesLost: 1, incomeLost: 3, commanderLost: false },
  harmful: 2,
  considered: 7,
  atRisk: { commander: 0, territories: 1, captures: 1, bonuses: 1 },
};

const sub = (extra: Record<string, unknown> = {}) =>
  recordSubmission(dir, GAME, ME, 3, {
    sent: {
      deploys: [{ territoryId: 1, armies: 5 }],
      moves: [{ from: 1, to: 3, armies: 9 }],
      cards: [{ card: 'Bomb', cardId: 'c'.repeat(32), target: 3 }],
      discards: ['d'.repeat(32)],
      purchases: [],
    },
    orders: { deploys: [{ territoryId: 1, armies: 5 }], moves: [{ from: 1, to: 3, armies: 9 }] },
    now: T0 + 90_000,
    checks: SUBMIT_CHECKS,
    ...extra,
  });

describe('per-turn additions (#437 task 1)', () => {
  it('the plan writes the build beside the version, plannedAt, the boot deadline, the first mover, the hand and the advice', async () => {
    expect(await record(3)).toBe(true);
    const e = (await readDecisionLog(dir, GAME))!.turns['3']!;
    expect(e.planner).toEqual({ version: expect.any(String), build: serverBuild() });
    expect(e.times).toEqual({ plannedAt: new Date(T0).toISOString(), turnStartedAt: '2026-11-20T11:00:00.000Z', bootAt: { auto: '2026-11-21T11:00:00.000Z' } });
    expect(e.firstMover).toEqual({ who: 'opponent', source: 'award', verified: false });
    expect(e.cards).toEqual(CARDS);
  });

  it('a first mover unknown is logged as null, not left out', async () => {
    await record(3, { firstMover: null });
    expect((await readDecisionLog(dir, GAME))!.turns['3']!.firstMover).toBeNull();
  });

  it('the submit writes sentAt, the cards played (from sent) beside the hand, and the checks at submit', async () => {
    await record(3);
    expect(await sub()).toBe(true);
    const e = (await readDecisionLog(dir, GAME))!.turns['3']!;
    expect(e.times).toMatchObject({ plannedAt: new Date(T0).toISOString(), sentAt: new Date(T0 + 90_000).toISOString() });
    expect(e.cards).toEqual({ ...CARDS, played: ['Bomb'], discarded: 1 });
    expect(e.checks?.submit).toEqual(SUBMIT_CHECKS);
  });

  it('check_plan writes its summary; the latest per turn wins; a plan after it keeps it; a submit keeps it', async () => {
    expect(await recordCheck(dir, GAME, ME, 3, CHECK)).toBe(true);
    let e = (await readDecisionLog(dir, GAME))!.turns['3']!;
    expect(e.checks?.checkPlan).toEqual(CHECK);
    expect(e.kind).toBeUndefined();
    const later = { ...CHECK, safe: true, harmful: 0, worst: null };
    await recordCheck(dir, GAME, ME, 3, later);
    await record(3);
    await sub();
    e = (await readDecisionLog(dir, GAME))!.turns['3']!;
    expect(e.kind).toBe('planned');
    expect(e.checks).toEqual({ checkPlan: later, submit: SUBMIT_CHECKS });
  });

  it('an observation keeps the new fields; recordCheck writes nothing with the log off', async () => {
    await record(3);
    await recordCheck(dir, GAME, ME, 3, CHECK);
    await recordObservation(dir, GAME, ME, 3, boardOn(3), 'live');
    expect((await readDecisionLog(dir, GAME))!.turns['3']!.checks?.checkPlan).toEqual(CHECK);
    expect(await recordCheck(dir, GAME + 1, ME, 3, CHECK, { mode: 'off' })).toBe(false);
  });

  it('compaction keeps every new field (only an uninteresting turn\'s replay input goes)', async () => {
    for (const t of [1, 2, 3, 4, 5, 6]) await record(t);
    await recordCheck(dir, GAME, ME, 5, CHECK);
    await recordSubmission(dir, GAME, ME, 5, {
      sent: { deploys: [{ territoryId: 1, armies: 5 }], moves: [{ from: 1, to: 3, armies: 9 }], cards: [], discards: [], purchases: [] },
      orders: { deploys: [{ territoryId: 1, armies: 5 }], moves: [{ from: 1, to: 3, armies: 9 }] },
      now: T0,
      checks: SUBMIT_CHECKS,
    });
    const before = (await readDecisionLog(dir, GAME))!;
    expect(await compactDecisionLog(dir, GAME, ME, { mode: 'on' })).toBe(true);
    const after = (await readDecisionLog(dir, GAME))!;
    expect(after.turns['5']!.input).toBeUndefined();
    for (const k of ['planner', 'times', 'firstMover', 'cards', 'checks'] as const) expect(after.turns['5']![k]).toEqual(before.turns['5']![k]);
    expect(compactLog(before).turns['6']!.cards).toEqual(CARDS);
  });

  it('an old log written before these fields still reads, and gains them on the next write', async () => {
    const old = {
      version: 1,
      gameId: GAME,
      playerId: ME,
      status: 'active',
      turns: { '2': { kind: 'planned', planner: { version: '0.6.0' }, decision: { goal: 'balanced', deploys: [], moves: [] } } },
    };
    await mkdir(join(dir, 'decisions'), { recursive: true });
    await writeFile(decisionLogPath(dir, GAME), JSON.stringify(old));
    const l = (await readDecisionLog(dir, GAME)) as DecisionLog;
    expect(l.turns['2']!.planner).toEqual({ version: '0.6.0' });
    expect(l.turns['2']!.times).toBeUndefined();
    await recordCheck(dir, GAME, ME, 2, CHECK);
    const e = (await readDecisionLog(dir, GAME))!.turns['2']!;
    expect(e.planner).toEqual({ version: '0.6.0' });
    expect(e.checks?.checkPlan).toEqual(CHECK);
  });
});

describe('the pure capture helpers', () => {
  it('handLog: my cards by type, counted, sorted by name', () => {
    const hand: Card[] = [
      { id: 'a'.repeat(32), type: 1, name: 'Reinforcement', armies: 5 },
      { id: 'b'.repeat(32), type: 13, name: 'Bomb' },
      { id: 'c'.repeat(32), type: 1, name: 'Reinforcement', armies: 5 },
    ];
    expect(handLog(hand)).toEqual([
      { card: 'Bomb', type: 13, count: 1 },
      { card: 'Reinforcement', type: 1, count: 2 },
    ]);
  });

  it('cardAdviceLog: kind, target ids and a reason code per advice, no prose', () => {
    const out = cardAdviceLog({
      orderDelay: { card: 'x', before: 2, attacks: [1], order: { kind: 'card', card: 'x', before: 2 } },
      bomb: { target: 7, kind: 'commander', why: 'Halving 7 leaves …' },
      emergencyBlockade: { territory: 4, givesUp: 3, wall: 9, player: FOE, reach: 6, kills: 5, protects: { territories: [], bonuses: [], income: 0, commander: false }, order: { kind: 'card', card: 'y', target: 4 } },
      blockade: { territory: 5, armies: 4, wall: 12, player: FOE, reach: 9, bonuses: [9], income: 3, behind: [6], commander: false, order: { kind: 'card', card: 'z', target: 5 } },
      diplomacy: { player: FOE, borders: [1, 2], armies: 8, overTruce: 'notice', order: {} },
      sanctions: { player: FOE, order: {} },
      airlift: { from: 1, to: 2, armies: 4, order: {} },
      gift: { player: 3003, bonus: 9, territories: [5, 6], orders: [] },
      spy: { player: FOE, order: {} },
      reconnaissance: { target: 8, order: {} },
      surveillance: { bonus: 9, order: {} },
      active: [{ card: 'Diplomacy', players: [ME, FOE] }],
    });
    expect(out).toEqual([
      { kind: 'orderDelay', targets: [], reason: 'delay-attacks', before: 2 },
      { kind: 'bomb', targets: [7], reason: 'commander' },
      { kind: 'emergencyBlockade', targets: [4], player: FOE, reason: 'conceded-wall' },
      { kind: 'blockade', targets: [5], player: FOE, reason: 'gate' },
      { kind: 'diplomacy', targets: [1, 2], player: FOE, reason: 'over-truce' },
      { kind: 'sanctions', targets: [], player: FOE, reason: 'strongest' },
      { kind: 'airlift', targets: [1, 2], reason: 'border' },
      { kind: 'gift', targets: [5, 6], player: 3003, reason: 'teammate-bonus' },
      { kind: 'spy', targets: [], player: FOE, reason: 'fog' },
      { kind: 'reconnaissance', targets: [8], reason: 'fog' },
      { kind: 'surveillance', targets: [9], reason: 'fog' },
    ]);
    expect(JSON.stringify(out)).not.toMatch(/Halving/);
  });

  it('headroomLog: the weakest five rows (none taking last), each with what it protects', () => {
    const row = (territory: number, deploy: number | null) => ({
      territory, armies: 3, opponent: FOE, from: 30 + territory, deploy, bonuses: territory === 2 ? [{ id: 9, value: 4 }] : [], behind: [], behindIncome: 0, breach: { territories: [], income: 0 },
    });
    const out = headroomLog([row(1, null), row(2, 3), row(3, 0), row(4, 8), row(5, 1), row(6, 2), row(7, 5)]);
    expect(out.map((r) => r.territory)).toEqual([3, 5, 6, 2, 7]);
    expect(out[3]).toEqual({ territory: 2, takeAt: 3, opponent: FOE, from: 32, protects: { bonuses: [9], behindIncome: 0, breachIncome: 0 } });
  });

  it('checkPlanLog: the verdict, the worst reply in numbers and the at-risk counts', () => {
    const out = checkPlanLog(
      {
        safe: false,
        worst: { opponent: FOE, kind: 'attack', deployTo: 3, deploy: 5, lost: [1], capturesFailed: [3], retaken: [], bonusesLost: [{ id: 9, value: 3 }], incomeLost: 3, commanderLost: false, eliminationsFailed: [], myArmies: -4, theirArmies: 2 },
        harmful: 2,
        considered: 7,
        atRisk: { commander: 0, territories: [{ id: 1, replies: 2 }], captures: [{ id: 3, replies: 1 }], bonuses: [{ id: 9, replies: 1 }] },
      } as never,
      { whatIf: false },
    );
    expect(out).toEqual({ ...CHECK, worst: { ...CHECK.worst!, capturesFailed: 1 } });
    expect(checkPlanLog({ safe: null, worst: undefined, harmful: 0, considered: 0, atRisk: { commander: 0, territories: [], captures: [], bonuses: [] } } as never, { whatIf: true })).toEqual({
      safe: null, worst: null, harmful: 0, considered: 0, atRisk: { commander: 0, territories: 0, captures: 0, bonuses: 0 }, whatIf: true,
    });
  });

  it('submitChecksLog: the commander check, the headroom, below-plan rows and the chat warnings by id', () => {
    const commander: CommanderCheck & { accepted: boolean } = { safety: { territory: 1, from: 1, armies: 10, distance: 1, killers: 2, needs: 12, killedBy: null, lostUnanswered: false, exact: true }, replyDeploy: 6, risk: { territory: 1, armies: 10, needs: 12, replyDeploy: 6, replies: 2 }, accepted: true };
    const chat: CommitmentWarning[] = [{ commitment: 'k1', kind: 'no-attack', with: FOE, moves: [{ index: 0, from: 1, to: 3 }], text: 'promised …' }];
    const out = submitChecksLog({ commander, headroom: [], belowPlan: { rows: [{ territory: 1, planLeaves: 9, left: 4, short: 5 }], against: 'plan' }, chat });
    expect(out).toEqual({ ...SUBMIT_CHECKS, headroom: [] });
    expect(submitChecksLog({ commander: undefined, headroom: [], belowPlan: undefined, chat: [] })).toEqual({ commander: null, headroom: [], belowPlan: [], chat: [] });
  });

  it('bootTimes: the turn start and each boot deadline the game read gives, ISO', () => {
    const game = { state: 'Playing', lastTurnTime: '11/20/2026 11:00:00', endRules: { autoBootMinutes: 1440, directBootMinutes: 60 } };
    expect(bootTimes(game as never)).toEqual({
      turnStartedAt: '2026-11-20T11:00:00.000Z',
      bootAt: { auto: '2026-11-21T11:00:00.000Z', direct: '2026-11-20T12:00:00.000Z' },
    });
    expect(bootTimes({ state: 'Playing', lastTurnTime: '11/20/2026 11:00:00' } as never)).toEqual({ turnStartedAt: '2026-11-20T11:00:00.000Z' });
    expect(bootTimes({ state: 'Playing' } as never)).toEqual({});
  });
});
