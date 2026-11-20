import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanInput, TurnPlan } from '../src/analysis/plan/shared.js';
import type { BoardState, TerritoryState } from '../src/board.js';
import {
  DECISION_LOG_VERSION,
  FULL_BOARD_EVERY,
  MAX_DECISION_BYTES,
  MAX_DECISION_GAMES,
  boardAt,
  decisionLogMode,
  decisionLogPath,
  decodeInput,
  listDecisionLogs,
  pruneDecisionLogs,
  readDecisionLog,
  recordDecision,
  recordObservation,
  recordOutcome,
  recordSent,
  updateDecisionLog,
} from '../src/decision-log.js';
import { VERSION } from '../src/version.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'warapp-decisions-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ME = 1001;
const FOE = 2002;
const GAME = 7001;

const t = (territoryId: number, owner: number | 'neutral' | 'fog', armies: number | null, fogLevel?: string): TerritoryState => ({
  territoryId,
  owner: owner === 'neutral' ? { kind: 'neutral' } : owner === 'fog' ? { kind: 'unknown' } : { kind: 'player', playerId: owner },
  armies,
  ...(fogLevel ? { fogLevel } : {}),
});

/** A board on turn `turn`: territory 1 grows by one army a turn, 2–5 stay put. */
const boardOn = (turn: number): BoardState => ({
  source: 'gamefeed',
  verified: true,
  territories: [t(1, ME, 5 + turn), t(2, ME, 3), t(3, FOE, 4), t(4, 'neutral', 2), t(5, 'fog', null, 'Fogged')],
});

const plan = (turn: number, extra: Partial<TurnPlan> = {}): TurnPlan =>
  ({
    goal: 'balanced',
    profile: { format: '1v1', phase: 'contact', standing: 'even' },
    deploys: [{ territoryId: 1, armies: 5 }],
    moves: [{ from: 1, to: 4, armies: 4, kind: 'attack', reason: `Take 4 on turn ${turn}.` }],
    expected: { captures: [4], bonusesCompleted: [], nextIncome: 6 },
    warnings: [`Player ${FOE} may deploy 5.`],
    rationale: [`Turn ${turn}: take 4 for the bonus.`],
    enemyDeploy: 5,
    conceded: [],
    cardAdvice: null,
    multiSourceCaptures: [],
    frontier: { territories: [], facingEnemy: [], holdCost: 0, nextIncome: 6 },
    offence: [{ target: 3, kind: 'break', cost: 7, value: 2, taken: false, why: 'too dear' }],
    ...extra,
  }) as unknown as TurnPlan;

const input = (turn: number, extra: Partial<PlanInput> = {}): PlanInput =>
  ({
    graph: { map: { id: 1, name: 'Map', territories: [], bonuses: [] } },
    board: boardOn(turn),
    me: ME,
    income: 5,
    turn,
    previousBoard: turn > 1 ? boardOn(turn - 1) : undefined,
    options: { adapt: true, avoid: { territories: new Set([3]) } },
    game: { players: [{ id: ME }, { id: FOE }], opening: new Map([[FOE, 6]]) },
    untrusted: [{ player: FOE, deploy: 9 }],
    vacated: new Map([[9, 3]]),
    bonusPush: { allIn: new Set([1]), dropped: new Set() },
    ...extra,
  }) as unknown as PlanInput;

const record = (turn: number, extra: { input?: Partial<PlanInput>; plan?: Partial<TurnPlan>; players?: { id: number; name?: string }[] } = {}) =>
  recordDecision(dir, GAME, ME, {
    turn,
    board: boardOn(turn),
    input: input(turn, extra.input),
    plan: plan(turn, extra.plan),
    outlookState: 'even',
    ...(extra.players ? { players: extra.players } : {}),
  });

describe('decision log store (#412 task 1)', () => {
  it('writes a versioned, name-free, 0600 file in a 0700 folder with the decision, the input and the planner version', async () => {
    expect(await record(1)).toBe(true);
    const path = decisionLogPath(dir, GAME);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, 'decisions'))).mode & 0o777).toBe(0o700);
    const log = await readDecisionLog(dir, GAME);
    expect(log).toMatchObject({ version: DECISION_LOG_VERSION, gameId: GAME, playerId: ME, status: 'active' });
    const e = log!.turns['1']!;
    expect(e.planner).toEqual({ version: VERSION });
    expect(e.decision).toMatchObject({
      goal: 'balanced',
      deploys: [{ territoryId: 1, armies: 5 }],
      moves: [{ from: 1, to: 4, armies: 4, kind: 'attack' }],
      expected: { nextIncome: 6, captures: [4] },
      offence: [{ target: 3, taken: false, why: 'too dear' }],
      enemyDeploy: 5,
      rationale: ['Turn 1: take 4 for the bonus.'],
      warnings: [`Player ${FOE} may deploy 5.`],
      outlook: 'even',
    });
    // What the planner sets itself, and the graph, are not kept.
    const raw = JSON.parse(await readFile(path, 'utf8'));
    expect(raw.turns['1'].input.graph).toBeUndefined();
    expect(raw.turns['1'].input.vacated).toBeUndefined();
    expect(raw.turns['1'].input.bonusPush).toBeUndefined();
    expect(raw.turns['1'].input.board).toBeUndefined();
  });

  it('round-trips the input: Maps, Sets and the previous board come back as given', async () => {
    await record(2);
    const log = (await readDecisionLog(dir, GAME))!;
    const graph = { map: { id: 1 } } as unknown as PlanInput['graph'];
    const back = decodeInput(log.turns['2']!.input!, boardAt(log, 2)!, graph);
    const want = input(2);
    expect(back.graph).toBe(graph);
    expect(back.board).toEqual(boardOn(2));
    expect(back.previousBoard).toEqual(want.previousBoard);
    expect(back.income).toBe(5);
    expect(back.me).toBe(ME);
    expect(back.untrusted).toEqual(want.untrusted);
    expect(back.game?.opening).toEqual(new Map([[FOE, 6]]));
    expect(back.options?.avoid?.territories).toEqual(new Set([3]));
    expect(back.vacated).toBeUndefined();
    expect(back.bonusPush).toBeUndefined();
  });

  it('delta-encodes boards against the previous logged turn, with a full board at the first turn and every FULL_BOARD_EVERY turns', async () => {
    for (let turn = 1; turn <= 23; turn++) await record(turn);
    const raw = JSON.parse(await readFile(decisionLogPath(dir, GAME), 'utf8'));
    const kinds = Object.fromEntries(Object.entries(raw.turns as Record<string, { board: { kind: string } }>).map(([k, v]) => [k, v.board.kind]));
    expect(kinds['1']).toBe('full');
    expect(kinds['2']).toBe('delta');
    expect(kinds[String(1 + FULL_BOARD_EVERY)]).toBe('full');
    expect(kinds[String(1 + 2 * FULL_BOARD_EVERY)]).toBe('full');
    expect(Object.values(kinds).filter((k) => k === 'full')).toHaveLength(3);
    // A delta keeps only what changed (territory 1 grows every turn).
    expect(raw.turns['2'].board.changed.map((x: TerritoryState) => x.territoryId)).toEqual([1]);
    const log = (await readDecisionLog(dir, GAME))!;
    for (let turn = 1; turn <= 23; turn++) expect(boardAt(log, turn)).toEqual(boardOn(turn));
    expect(boardAt(log, 99)).toBeUndefined();
  });

  it('keeps fog levels, special units and owner changes through the delta', async () => {
    await record(1);
    const b2: BoardState = {
      source: 'gamefeed',
      verified: true,
      territories: [
        t(1, ME, 6),
        t(2, ME, 3),
        { ...t(3, FOE, 4), specialUnits: [{ kind: 'commander', id: 'g', playerId: FOE }] },
        t(4, ME, 1),
        t(5, FOE, 7, 'Visible'),
      ],
    };
    await recordDecision(dir, GAME, ME, { turn: 2, board: b2, input: input(2, { board: b2 }), plan: plan(2) });
    expect(boardAt((await readDecisionLog(dir, GAME))!, 2)).toEqual(b2);
  });

  it('never keeps teammate orders on the board', async () => {
    const b = { ...boardOn(1), teammateOrders: [{ playerId: 3003 }] } as unknown as BoardState;
    await recordDecision(dir, GAME, ME, { turn: 1, board: b, input: input(1, { board: b }), plan: plan(1) });
    expect(boardAt((await readDecisionLog(dir, GAME))!, 1)).toEqual(boardOn(1));
  });

  it('keeps teammate orders in the input, id-only, and puts them back on the rebuilt board for replay', async () => {
    const teammateOrders = [
      {
        playerId: 3003,
        orders: { deploys: [{ territoryId: 2, armies: 3 }], moves: [{ from: 2, to: 3, armies: 5 }], cards: [], discards: [], unread: [] },
        picks: null,
      },
    ];
    const b = { ...boardOn(1), teammateOrders } as unknown as BoardState;
    await recordDecision(dir, GAME, ME, { turn: 1, board: b, input: input(1, { board: b }), plan: plan(1) });
    const log = (await readDecisionLog(dir, GAME))!;
    const raw = JSON.parse(await readFile(decisionLogPath(dir, GAME), 'utf8'));
    expect(raw.turns['1'].board.teammateOrders).toBeUndefined();
    expect(raw.turns['1'].input.teammateOrders).toEqual(teammateOrders);
    const back = decodeInput(log.turns['1']!.input!, boardAt(log, 1)!, { map: { id: 1 } } as unknown as PlanInput['graph']);
    expect(back.board.teammateOrders).toEqual(teammateOrders);
    expect(back.board.territories).toEqual(boardOn(1).territories);
    expect((back as unknown as Record<string, unknown>).teammateOrders).toBeUndefined();
  });

  it('leaves the board without a teammateOrders key when none were read', async () => {
    await record(1);
    const log = (await readDecisionLog(dir, GAME))!;
    const back = decodeInput(log.turns['1']!.input!, boardAt(log, 1)!, { map: { id: 1 } } as unknown as PlanInput['graph']);
    expect('teammateOrders' in back.board).toBe(false);
  });

  it('planning a turn again replaces its entry and later boards still rebuild', async () => {
    await record(1);
    await record(2);
    await record(3);
    await recordSent(dir, GAME, ME, 2, { deploys: [{ territoryId: 1, armies: 5 }], moves: [] });
    const replanned: BoardState = { ...boardOn(2), territories: [...boardOn(2).territories.slice(0, 4), t(5, FOE, 9, 'Visible')] };
    await recordDecision(dir, GAME, ME, { turn: 2, board: replanned, input: input(2, { board: replanned }), plan: plan(2, { goal: 'defend' }) });
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.turns['2']!.decision?.goal).toBe('defend');
    expect(log.turns['2']!.sent).toBeUndefined();
    expect(boardAt(log, 2)).toEqual(replanned);
    expect(boardAt(log, 1)).toEqual(boardOn(1));
    expect(boardAt(log, 3)).toEqual(boardOn(3));
  });

  it('records the orders sent, an override with its reason, and the outcome', async () => {
    await record(4);
    const sent = { deploys: [{ territoryId: 2, armies: 5 }], moves: [{ from: 2, to: 3, armies: 7 }] };
    expect(await recordSent(dir, GAME, ME, 4, sent, { by: 'hand', reason: 'Testing a hunch.' })).toBe(true);
    const next = { income: 6, gained: [4], lost: [], capturesMade: [4], capturesMissed: [], bonusesHeld: [], eliminated: false };
    expect(await recordOutcome(dir, GAME, ME, 4, next)).toBe(true);
    const e = (await readDecisionLog(dir, GAME))!.turns['4']!;
    expect(e.sent).toEqual(sent);
    expect(e.override).toEqual({ by: 'hand', reason: 'Testing a hunch.' });
    expect(e.next).toEqual(next);
    // No entry for the turn: nothing to fill.
    expect(await recordOutcome(dir, GAME, ME, 9, next)).toBe(false);
  });

  it('records sent orders for a turn with no logged decision', async () => {
    const sent = { deploys: [{ territoryId: 2, armies: 5 }], moves: [] };
    expect(await recordSent(dir, GAME, ME, 3, sent, { by: 'hand' })).toBe(true);
    const e = (await readDecisionLog(dir, GAME))!.turns['3']!;
    expect(e.sent).toEqual(sent);
    expect(e.override).toEqual({ by: 'hand' });
    expect(e.decision).toBeUndefined();
  });

  it('scrubs player names from every string and drops a name field holding one', async () => {
    const players = [{ id: FOE, name: 'Zebulon Quux' }];
    await record(1, {
      players,
      plan: { warnings: ['Zebulon Quux may deploy 5.'], rationale: ['Watch Zebulon Quux.'] },
      input: { game: { players: [{ id: ME }, { id: FOE, name: 'Zebulon Quux' } as never] } },
    });
    const text = await readFile(decisionLogPath(dir, GAME), 'utf8');
    expect(text).not.toMatch(/Zebulon|Quux/i);
    const e = (await readDecisionLog(dir, GAME))!.turns['1']!;
    expect(e.decision?.warnings[0]).toBe(`Player ${FOE} may deploy 5.`);
  });

  it('scrubs a short name only where it stands alone, never inside a territory name or another word', async () => {
    const players = [{ id: FOE, name: 'Al' }];
    await record(1, {
      players,
      plan: {
        warnings: ['Al may deploy 5 into Albania.'],
        rationale: ['Take Albania; Player Al holds Territory 4 (al).', 'Totally calm.'],
      },
    });
    const e = (await readDecisionLog(dir, GAME))!.turns['1']!;
    expect(e.decision?.warnings[0]).toBe(`Player ${FOE} may deploy 5 into Albania.`);
    expect(e.decision?.rationale).toEqual([`Take Albania; Player ${FOE} holds Territory 4 (Player ${FOE}).`, 'Totally calm.']);
  });

  it('never overwrites a file that exists but does not parse', async () => {
    await mkdir(join(dir, 'decisions'), { recursive: true });
    await writeFile(decisionLogPath(dir, GAME), '{ not json');
    expect(await record(1)).toBe(false);
    expect(await recordSent(dir, GAME, ME, 1, { deploys: [], moves: [] })).toBe(false);
    expect(await readFile(decisionLogPath(dir, GAME), 'utf8')).toBe('{ not json');
    expect(await readDecisionLog(dir, GAME)).toBeUndefined();
  });

  it("never writes over another account's log", async () => {
    await record(1);
    expect(await recordDecision(dir, GAME, 4004, { turn: 2, board: boardOn(2), input: input(2), plan: plan(2) })).toBe(false);
    expect((await readDecisionLog(dir, GAME))!.playerId).toBe(ME);
    expect(await readDecisionLog(dir, GAME, 4004)).toBeUndefined();
  });

  it('writes nothing with WARAPP_DECISION_LOG=off', async () => {
    expect(decisionLogMode({ WARAPP_DECISION_LOG: 'off' })).toBe('off');
    expect(decisionLogMode({ WARAPP_DECISION_LOG: 'FULL' })).toBe('full');
    expect(decisionLogMode({})).toBe('on');
    const off = { mode: 'off' as const };
    expect(await recordDecision(dir, GAME, ME, { turn: 1, board: boardOn(1), input: input(1), plan: plan(1) }, off)).toBe(false);
    expect(await recordSent(dir, GAME, ME, 1, { deploys: [], moves: [] }, undefined, off)).toBe(false);
    expect(await updateDecisionLog(dir, GAME, ME, (l) => l, off)).toBe(false);
    await expect(readdir(join(dir, 'decisions'))).rejects.toThrow();
  });

  it('updateDecisionLog changes the status; leaves the file alone when the mutator returns undefined', async () => {
    await record(1);
    expect(await updateDecisionLog(dir, GAME, ME, (l) => ({ ...l, status: 'finished' }))).toBe(true);
    expect((await readDecisionLog(dir, GAME))!.status).toBe('finished');
    expect(await updateDecisionLog(dir, GAME, ME, () => undefined)).toBe(false);
    // No log yet: the mutator starts from an empty one.
    expect(await updateDecisionLog(dir, 9999, ME, (l) => l)).toBe(true);
    expect(await readDecisionLog(dir, 9999)).toMatchObject({ gameId: 9999, playerId: ME, status: 'active', turns: {} });
  });

  it('concurrent records of one game all land', async () => {
    await Promise.all([1, 2, 3, 4, 5].map((turn) => record(turn)));
    const log = (await readDecisionLog(dir, GAME))!;
    expect(Object.keys(log.turns).sort()).toEqual(['1', '2', '3', '4', '5']);
    for (let turn = 1; turn <= 5; turn++) expect(boardAt(log, turn)).toEqual(boardOn(turn));
    expect((await readdir(join(dir, 'decisions'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('observation entries (#412 no-gaps rule (a))', () => {
  it('logs a turn seen but not planned as an observation, with its board', async () => {
    expect(await recordObservation(dir, GAME, ME, 2, boardOn(2), 'live')).toBe(true);
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.turns['2']).toMatchObject({ kind: 'observed', source: 'live' });
    expect(log.turns['2']!.decision).toBeUndefined();
    expect(boardAt(log, 2)).toEqual(boardOn(2));
  });

  it('never overwrites a planned entry', async () => {
    await record(3);
    expect(await recordObservation(dir, GAME, ME, 3, boardOn(9), 'history')).toBe(false);
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.turns['3']!.kind).toBe('planned');
    expect(log.turns['3']!.source).toBeUndefined();
    expect(log.turns['3']!.decision?.goal).toBe('balanced');
    expect(boardAt(log, 3)).toEqual(boardOn(3));
  });

  it('keeps sent orders on an observation and its board, and other turns still rebuild', async () => {
    await record(1);
    const sent = { deploys: [{ territoryId: 2, armies: 5 }], moves: [] };
    await recordSent(dir, GAME, ME, 2, sent, { by: 'hand' });
    expect(await recordObservation(dir, GAME, ME, 2, boardOn(2), 'history')).toBe(true);
    await record(3);
    const log = (await readDecisionLog(dir, GAME))!;
    expect(log.turns['2']).toMatchObject({ kind: 'observed', source: 'history', sent, override: { by: 'hand' } });
    expect(boardAt(log, 1)).toEqual(boardOn(1));
    expect(boardAt(log, 2)).toEqual(boardOn(2));
    expect(boardAt(log, 3)).toEqual(boardOn(3));
  });

  it('a later plan of the turn upgrades the observation', async () => {
    await recordObservation(dir, GAME, ME, 4, boardOn(4), 'live');
    await record(4);
    const e = (await readDecisionLog(dir, GAME))!.turns['4']!;
    expect(e.kind).toBe('planned');
    expect(e.source).toBeUndefined();
    expect(e.decision?.goal).toBe('balanced');
  });

  it('writes nothing when off, and never throws', async () => {
    expect(await recordObservation(dir, GAME, ME, 1, boardOn(1), 'live', { mode: 'off' })).toBe(false);
    expect(await readDecisionLog(dir, GAME)).toBeUndefined();
    expect(await recordObservation(dir, GAME, ME, 1, null as unknown as BoardState, 'live')).toBe(false);
  });
});

describe('listing and pruning decision logs', () => {
  it('keeps generous caps by default: 1000 games and 500 MB (no-gaps rule (d))', () => {
    expect(MAX_DECISION_GAMES).toBe(1000);
    expect(MAX_DECISION_BYTES).toBe(500 * 1024 * 1024);
  });

  const game = async (gameId: number, status: 'active' | 'finished' | 'compacted', ageDays: number) => {
    await recordDecision(dir, gameId, ME, { turn: 1, board: boardOn(1), input: input(1), plan: plan(1) });
    if (status !== 'active') await updateDecisionLog(dir, gameId, ME, (l) => ({ ...l, status }));
    const when = new Date(Date.now() - ageDays * 86_400_000);
    await utimes(decisionLogPath(dir, gameId), when, when);
  };

  it('lists every log with its status and size, skipping files that do not parse', async () => {
    await game(1, 'active', 1);
    await game(2, 'finished', 2);
    await writeFile(join(dir, 'decisions', '3.json'), 'nope');
    await writeFile(join(dir, 'decisions', 'notes.txt'), 'x');
    const list = await listDecisionLogs(dir);
    expect(list.map((l) => [l.gameId, l.status])).toEqual([
      [1, 'active'],
      [2, 'finished'],
    ]);
    expect(list.every((l) => l.bytes > 0)).toBe(true);
    expect(await listDecisionLogs(join(dir, 'missing'))).toEqual([]);
  });

  it('drops the oldest finished games first past the game cap, never an active one', async () => {
    await game(1, 'active', 50);
    await game(2, 'finished', 40);
    await game(3, 'compacted', 30);
    await game(4, 'finished', 20);
    await game(5, 'active', 10);
    const removed = await pruneDecisionLogs(dir, { maxGames: 3 });
    expect(removed).toEqual([2, 3]);
    expect((await listDecisionLogs(dir)).map((l) => l.gameId)).toEqual([1, 4, 5]);
    // Only active games left over the cap: nothing more goes.
    expect(await pruneDecisionLogs(dir, { maxGames: 1 })).toEqual([4]);
    expect((await listDecisionLogs(dir)).map((l) => l.gameId)).toEqual([1, 5]);
  });

  it('drops the oldest finished games past the byte cap', async () => {
    await game(1, 'finished', 30);
    await game(2, 'finished', 20);
    await game(3, 'active', 10);
    const sizes = await listDecisionLogs(dir);
    const total = sizes.reduce((s, l) => s + l.bytes, 0);
    const removed = await pruneDecisionLogs(dir, { maxBytes: total - 1 });
    expect(removed).toEqual([1]);
    expect(await pruneDecisionLogs(dir, { maxBytes: 0 })).toEqual([2]);
    expect((await listDecisionLogs(dir)).map((l) => l.gameId)).toEqual([3]);
  });
});
