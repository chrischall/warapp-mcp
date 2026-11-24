// #569 warapp_calibration and #570 warapp_turn_history over a synthetic data directory (decision logs written
// through the real writers, then given a plan, orders, an outcome and the end-of-game truth by hand).
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { BoardState } from '../src/board.js';
import { decisionLogPath, readDecisionLog, recordObservations } from '../src/decision-log.js';
import type { Player } from '../src/normalize.js';
import { captureSeenTurn } from '../src/tools/decision-capture.js';
import { liveHarness, payload, textOf, type Harness } from './helpers.js';

const ANN = 4412345677; // in-game 123456
const BOB = 7176543229; // in-game 765432
const GAME = 4567;
const players = [
  { id: ANN, name: 'Ann', state: 'Playing' },
  { id: BOB, name: 'Bob', state: 'Playing' },
] as unknown as Player[];

let h: Harness | undefined;
afterEach(async () => {
  await h?.harness.close();
  h = undefined;
});

const board = (owners: [number, number | 'n' | '?', number | null][]): BoardState => ({
  source: 'browser',
  verified: true,
  territories: owners.map(([territoryId, o, armies]) => ({
    territoryId,
    owner: o === 'n' ? ({ kind: 'neutral' } as const) : o === '?' ? ({ kind: 'unknown' } as const) : ({ kind: 'player', playerId: o } as const),
    armies,
  })),
});

const turnInfo = (turnIndex: number, orders: unknown[]) => ({
  $type: 'warlight.shared.LatestGameInfo',
  lE: { $type: 'warlight.shared.GameTurn', Li: null, ac: orders, vh: turnIndex, zY: '2026-11-24T00:00:00.000Z' },
});
const deploy = (t: number, n: number, player: number) => ({ $type: 'warlight.shared.GameOrderDeploy', t, f: false, n, $a: player, Sf: null, Yg: null });

/** A two-turn finished log: boards on turns 3 and 4, BOB takes territory 2 on turn 3, a plan, sent orders and the truth. */
async function seed(dir: string): Promise<void> {
  await recordObservations(dir, GAME, ANN, [
    { turn: 3, board: board([[1, ANN, 5], [2, ANN, 2], [3, BOB, 4], [4, '?', null]]), source: 'live' },
    { turn: 4, board: board([[1, ANN, 6], [2, BOB, 3], [3, BOB, 1], [4, '?', null]]), source: 'live' },
  ]);
  expect(await captureSeenTurn({ dataDir: dir }, { id: GAME, players }, ANN, turnInfo(2, [deploy(1, 3, 123456), deploy(3, 5, 765432)]), 4)).toBe(true);
  // A GameTurn that is not the turn just before the one played is not kept.
  expect(await captureSeenTurn({ dataDir: dir }, { id: GAME, players }, ANN, turnInfo(0, [deploy(1, 3, 123456)]), 4)).toBe(false);
  const path = decisionLogPath(dir, GAME);
  const log = JSON.parse(readFileSync(path, 'utf8'));
  log.status = 'finished';
  log.seats = { [ANN]: { state: 'Lost' }, [BOB]: { state: 'Won' } };
  const t3 = log.turns['3'];
  t3.kind = 'planned';
  t3.decision = {
    goal: 'balanced',
    profile: {},
    deploys: [{ territoryId: 1, armies: 5 }],
    moves: [],
    expected: { nextIncome: 7 },
    conceded: [],
    offence: [],
    enemyDeploy: 5,
    cardAdvice: null,
    rationale: ['Hold.'],
    warnings: ['A warning.'],
    outlook: 'even',
    estimates: [{ player: BOB, estimate: 4, source: 'tracked', coverage: 0.3, thin: true, method: 'rise-capped' }],
    income: 5,
  };
  t3.sent = { deploys: [{ territoryId: 1, armies: 3 }, { territoryId: 2, armies: 2 }], moves: [] };
  t3.next = { income: 5, gained: [], lost: [2], capturesMade: [], capturesMissed: [], bonusesHeld: [], eliminated: false };
  t3.truth = { board: 2, mine: { income: 5, armies: 7, territories: 2 }, opponents: [{ player: BOB, income: 16, armies: 4, territories: 2, bonuses: [], hidden: [] }] };
  t3.accuracy = {
    estimates: [{ player: BOB, estimate: 4, truth: 16, ratio: 0.25, source: 'tracked', coverage: 0.3, thin: true }],
    outlook: { logged: 'even', truth: 'losing', right: false },
    myIncome: 5,
    hiddenStacks: 0,
  };
  writeFileSync(path, JSON.stringify(log));
}

describe('warapp_turn_history (#570)', () => {
  it('shows each kept turn as seen, the visible orders, the plan beside the orders sent, and the outcome', async () => {
    h = await liveHarness();
    await seed(h.dataDir);
    const res = await h.call('warapp_turn_history', { game_id: GAME, view: 'full', board: true });
    expect(res.isError, textOf(res)).toBeFalsy();
    const r = payload<{ turns: Record<string, unknown>[]; keptTurns: unknown; player: number }>(res);
    expect(r.player).toBe(ANN);
    expect(r.keptTurns).toEqual({ first: 3, last: 4, count: 2 });
    const [t3, t4] = r.turns as Array<Record<string, any>>;
    expect(t3!.turn).toBe(3);
    expect(t3!.seen).toEqual({ mine: { territories: 2, armies: 7 }, others: [{ player: BOB, territories: 1, armies: 4 }], neutral: 0, hidden: 1 });
    expect(t3!.orders).toEqual({
      [ANN]: { deploys: [[1, 3]], moves: [], cards: [], discards: 0, other: [] },
      [BOB]: { deploys: [[3, 5]], moves: [], cards: [], discards: 0, other: [] },
    });
    expect(t3!.plan).toMatchObject({ goal: 'balanced', income: 5, rationale: ['Hold.'], warnings: ['A warning.'] });
    expect(t3!.differsFromPlan).toBe(true);
    expect(t3!.outcome).toMatchObject({ lost: [2] });
    expect(t3!.accuracy).toMatchObject({ estimates: [{ ratio: 0.25 }] });
    expect(t3!.board).toEqual([[1, ANN, 5], [2, ANN, 2], [3, BOB, 4], [4, null, null]]);
    expect(t4!.changedHands).toEqual([[2, ANN, BOB]]);
    expect(t4!.orders).toBeUndefined();
    // The log keeps ids only.
    expect(JSON.stringify(await readDecisionLog(h.dataDir, GAME))).not.toMatch(/Ann|Bob/);
  });

  it('pages, compact by default, and refuses a game with nothing kept', async () => {
    h = await liveHarness();
    await seed(h.dataDir);
    const r = payload<{ turns: Array<Record<string, any>>; next?: unknown }>(await h.call('warapp_turn_history', { game_id: GAME, from_turn: 3, to_turn: 3 }));
    expect(r.turns.map((t) => t.turn)).toEqual([3]);
    expect(r.turns[0]!.plan.warnings).toBe(1);
    expect(r.turns[0]!.board).toBeUndefined();
    const none = await h.call('warapp_turn_history', { game_id: 999 });
    expect(none.isError).toBe(true);
    expect(textOf(none)).toMatch(/No turn history is kept for game 999/);
  });
});

describe('warapp_calibration (#569)', () => {
  it('scores the finished logs, name-free, with the rows on request', async () => {
    h = await liveHarness();
    await seed(h.dataDir);
    const r = payload<{ sources: Record<string, number>; report: any; samples: any[] }>(await h.call('warapp_calibration', { samples: true }));
    expect(r.sources).toMatchObject({ finishedLogs: 1, scoredGames: 1, lotteriesLeftOut: 0, withoutTruth: 0 });
    expect(r.report.all).toMatchObject({ n: 1, mean: 0.25, meanError: -12 });
    expect(r.report.byFormat).toHaveProperty('1v1');
    expect(r.report.byMethod).toHaveProperty('rise-capped');
    expect(r.samples).toEqual([expect.objectContaining({ game: 1, turn: 3, ratio: 0.25, method: 'rise-capped', leader: true })]);
    expect(JSON.stringify(r)).not.toContain(String(GAME));
    expect(JSON.stringify(r)).not.toContain(String(BOB));
    expect(h.calls).toHaveLength(0);
  });

  it('says so when no finished game carries the truth yet', async () => {
    h = await liveHarness();
    const r = payload<{ report: unknown; empty: string }>(await h.call('warapp_calibration'));
    expect(r.report).toBeNull();
    expect(r.empty).toMatch(/No finished game/);
  });
});

describe('loggedEstimates keeps the tracker method (#569)', () => {
  it('adds `method` from the plan input\'s tracks, absent without one', async () => {
    const { loggedEstimates } = await import('../src/decision-log.js');
    const est = [
      { playerId: 9, estimate: 12, source: 'tracked', coverage: { share: 0.4 }, thinEvidence: undefined },
      { playerId: 8, estimate: 5, source: 'visible', coverage: null },
    ] as never;
    expect(loggedEstimates(est, [{ playerId: 9, incomeMethod: 'rise-capped' }])).toEqual([
      { player: 8, estimate: 5, source: 'visible', coverage: null, thin: false },
      { player: 9, estimate: 12, source: 'tracked', coverage: 0.4, thin: false, method: 'rise-capped' },
    ]);
    expect(loggedEstimates(est)[1]).not.toHaveProperty('method');
  });
});
