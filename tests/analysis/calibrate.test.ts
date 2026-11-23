// The calibration harness's pure parts (#318): the tracker, the fog prior and the plan's estimate
// scored against a finished history's true incomes, by format and coverage band, and the opening
// benchmark (my real start replayed on today's planner, the opponents held to the history). Synthetic
// maps, boards and histories only; nothing here reads a file or the network.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import {
  aggregateBenchmarks,
  aggregateEstimates,
  benchmarkByEra,
  estimateSamples,
  OPENING_WINDOW,
  openingBenchmark,
  openingEra,
  openingFlags,
  overlayHistory,
  PRE_RULE_4F_AT,
  PRE_RULE_4F_GAME_ID,
  ratioSummary,
} from '../../src/analysis/calibrate.js';
import { buildGraph } from '../../src/analysis/graph.js';
import type { MyOrders, TurnBoard } from '../../src/analysis/opponents.js';
import { trackGame } from '../../src/analysis/opponents.js';
import type { GameMap, GameSettings } from '../../src/normalize.js';

const ME = 1001;
const FOE = 1002;

// A line 1-2-3-4-5-6, bonus 100 = {1,2} worth 3, bonus 200 = {5,6} worth 4.
const MAP: GameMap = {
  id: 77,
  name: 'line',
  territories: [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `t${id}`, connectedTo: [id - 1, id + 1].filter((n) => n >= 1 && n <= 6) })),
  bonuses: [
    { id: 100, name: 'west', value: 3, territoryIds: [1, 2], bonusIds: [] },
    { id: 200, name: 'east', value: 4, territoryIds: [5, 6], bonusIds: [] },
  ],
  distributionModes: [],
};
const G = buildGraph(MAP);

const t = (territoryId: number, owner: number | 'neutral' | 'fog', armies: number | null): TerritoryState => ({
  territoryId,
  owner: owner === 'neutral' ? { kind: 'neutral' } : owner === 'fog' ? { kind: 'unknown' } : { kind: 'player', playerId: owner },
  armies,
  ...(owner === 'fog' ? { fogLevel: 'Fogged' } : {}),
});
const board = (...ts: TerritoryState[]): BoardState => ({ source: 'gamefeed', verified: false, territories: ts });

const SETTINGS: GameSettings = {
  minimumArmyBonus: 5,
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  luckModifier: 0,
  roundingMode: 'StraightRound',
  fog: 'Foggy',
} as GameSettings;
const PLAYERS = [{ id: ME }, { id: FOE }];

describe('estimateSamples (#318 a)', () => {
  // Truth: FOE holds the east bonus (+4) from history board 1 on, so it earns 9.
  const history = [
    { turn: 0, board: board(t(1, ME, 5), t(2, ME, 5), t(3, 'neutral', 2), t(4, 'neutral', 2), t(5, FOE, 5), t(6, 'neutral', 2)) },
    { turn: 1, board: board(t(1, ME, 5), t(2, ME, 10), t(3, 'neutral', 2), t(4, 'neutral', 2), t(5, FOE, 5), t(6, FOE, 6)) },
    { turn: 2, board: board(t(1, ME, 5), t(2, ME, 15), t(3, 'neutral', 2), t(4, FOE, 3), t(5, FOE, 9), t(6, FOE, 6)) },
  ];
  // My fogged view: territory 4 shows (next to nothing of mine? 3 is neutral, so 4 is fogged), 5 and 6 never.
  const cached: TurnBoard[] = [
    { turn: 2, board: board(t(1, ME, 5), t(2, ME, 10), t(3, 'neutral', 2), t(4, 'fog', null), t(5, 'fog', null), t(6, 'fog', null)) },
    { turn: 3, board: board(t(1, ME, 5), t(2, ME, 15), t(3, 'neutral', 2), t(4, FOE, 3), t(5, 'fog', null), t(6, 'fog', null)) },
  ];
  const input = {
    graph: G,
    me: ME,
    cached,
    history,
    plannerSettings: { baseIncome: 5, luckModifier: 0, roundingMode: 'StraightRound' },
    incomeSettings: SETTINGS,
    settings: SETTINGS,
    game: trackGame(PLAYERS, SETTINGS),
    players: PLAYERS,
    opponents: [FOE],
  };

  it('scores the plan estimate and the fog prior against the history board the turn was played on', () => {
    const samples = estimateSamples(input);
    // Turn 2 is played on history board 1, turn 3 on board 2: FOE earns 5 + 4 = 9 on both.
    expect(samples.map((s) => [s.turn, s.opponent, s.truth])).toEqual([
      [3, FOE, 9],
    ]);
    const s = samples[0]!;
    // It shows only 4: the plan reads base income (5); the prior is absent (the settings do not say the start was even).
    expect(s.plan).toBe(5);
    expect(s.prior).toBeNull();
  });

  it('leaves out an opponent the history shows with no land, and a turn the history lacks', () => {
    const short = estimateSamples({ ...input, history: history.slice(0, 1) });
    expect(short).toEqual([]);
  });

  it('aggregates each estimator by coverage band, ratios only', () => {
    const agg = aggregateEstimates([
      { turn: 3, opponent: FOE, truth: 10, coverage: null, tracker: 5, prior: null, plan: 10 },
      { turn: 4, opponent: FOE, truth: 10, coverage: 0.8, tracker: 20, prior: 10, plan: 10 },
    ]);
    expect(agg.tracker).toEqual({
      none: { n: 1, sum: 0.5, sq: 0.25, logSum: expect.closeTo(Math.log(0.5), 5), under: 0, over: 0 },
      '75-up': { n: 1, sum: 2, sq: 4, logSum: expect.closeTo(Math.log(2), 5), under: 0, over: 1 },
    });
    expect(agg.prior).toEqual({ '75-up': { n: 1, sum: 1, sq: 1, logSum: 0, under: 0, over: 0 } });
    expect(agg.plan?.none?.n).toBe(1);
  });

  it('summarises a ratio: mean, geometric mean and the low and high shares', () => {
    expect(ratioSummary({ n: 2, sum: 2.5, sq: 4.25, logSum: Math.log(0.5) + Math.log(2), under: 0, over: 1 })).toEqual({
      n: 2,
      mean: 1.25,
      geoMean: 1,
      sd: 0.75,
      under: 0,
      over: 0.5,
    });
    expect(ratioSummary(undefined)).toBeNull();
  });
});

describe('openingBenchmark (#318 b)', () => {
  // Board 0: I start on 1 (5) beside a neutral 2 (2); FOE on 6. The history has me sitting still and FOE
  // taking 5 (the east bonus) on turn 1. Replayed, the planner takes 2 at once (the west bonus, +3).
  const h0 = board(t(1, ME, 5), t(2, 'neutral', 2), t(3, 'neutral', 2), t(4, 'neutral', 2), t(5, 'neutral', 2), t(6, FOE, 5));
  const h1 = board(t(1, ME, 10), t(2, 'neutral', 2), t(3, 'neutral', 2), t(4, 'neutral', 2), t(5, FOE, 3), t(6, FOE, 7));
  const h2 = board(t(1, ME, 15), t(2, 'neutral', 2), t(3, 'neutral', 2), t(4, FOE, 3), t(5, FOE, 3), t(6, FOE, 12));
  const history = [
    { turn: 0, board: h0 },
    { turn: 1, board: h1 },
    { turn: 2, board: h2 },
  ];
  const input = {
    graph: G,
    me: ME,
    history,
    plannerSettings: { baseIncome: 5, luckModifier: 0, roundingMode: 'StraightRound', offensiveKillRate: 60, defensiveKillRate: 70 },
    incomeSettings: SETTINGS,
    players: PLAYERS,
    winners: [FOE],
    turns: 3,
  };

  it('replays my opening from the real start and compares my income with the real one and the winner', () => {
    const r = openingBenchmark(input);
    expect(r.exact).toBe(true);
    // The history ends after board 2: turn 3 is not replayed.
    expect(r.stopped).toBe('history-ends');
    expect(r.turns.map((x) => x.afterTurn)).toEqual([1, 2]);
    const first = r.turns[0]!;
    expect(first.real).toEqual({ income: 5, territories: 1 });
    expect(first.replay.income).toBe(8);
    expect(first.replay.territories).toBeGreaterThanOrEqual(2);
    expect(first.winner).toBe(9);
    expect(first.bestOpponent).toBe(9);
  });

  it('says when there is no start to replay from', () => {
    expect(openingBenchmark({ ...input, history: [{ turn: 1, board: h1 }] })).toEqual({ turns: [], exact: true, stopped: 'no-start' });
    expect(openingBenchmark({ ...input, me: 9999 })).toEqual({ turns: [], exact: true, stopped: 'no-start' });
  });

  it('runs the planner it is given, and marks a replay with luck inexact', () => {
    const r = openingBenchmark({
      ...input,
      plannerSettings: { ...input.plannerSettings, luckModifier: 0.16 },
      plan: () => ({ deploys: [{ territoryId: 1, armies: 5 }], moves: [{ from: 1, to: 2, armies: 9, kind: 'attack', reason: '' }] }),
    });
    expect(r.exact).toBe(false);
    expect(r.turns[0]!.replay.territories).toBe(2);
  });

  it('overlays the history: land I hold in the replay stays mine, the opponents hold what the history shows, the rest stays as replayed', () => {
    const sim = new Map([
      [1, { owner: ME as number | 'neutral' | 'unknown', armies: 4 }],
      [2, { owner: ME as number | 'neutral' | 'unknown', armies: 3 }],
      [3, { owner: 'neutral' as const, armies: 1 }],
      [4, { owner: 'neutral' as const, armies: 2 }],
      [5, { owner: 'neutral' as const, armies: 2 }],
      [6, { owner: FOE as number | 'neutral' | 'unknown', armies: 7 }],
    ]);
    // The history has FOE taking 2 and 5, and me (really) taking 3.
    const h = board(t(1, ME, 10), t(2, FOE, 4), t(3, ME, 4), t(4, 'neutral', 2), t(5, FOE, 3), t(6, FOE, 9));
    const out = overlayHistory(G, sim, h, ME);
    const at = (id: number) => out.territories.find((x) => x.territoryId === id)!;
    expect(at(1)).toMatchObject({ owner: { kind: 'player', playerId: ME }, armies: 4 });
    expect(at(2)).toMatchObject({ owner: { kind: 'player', playerId: ME }, armies: 3 });
    expect(at(3)).toMatchObject({ owner: { kind: 'neutral' }, armies: 1 });
    expect(at(5)).toMatchObject({ owner: { kind: 'player', playerId: FOE }, armies: 3 });
    expect(at(6)).toMatchObject({ owner: { kind: 'player', playerId: FOE }, armies: 9 });
  });

  it('aggregates benchmarks by turn, and counts land without bonuses and the 1.5x gap after turn 4', () => {
    const turn = (afterTurn: number, replay: number, real: number, territories: number, best: number) => ({
      afterTurn,
      replay: { income: replay, territories },
      real: { income: real, territories },
      winner: best,
      bestOpponent: best,
    });
    const agg = aggregateBenchmarks([
      { turns: [turn(4, 12, 6, 12, 10)], exact: true },
      { turns: [turn(4, 8, 8, 14, 20)], exact: false },
    ]);
    expect(agg.games).toBe(2);
    expect(agg.inexact).toBe(1);
    expect(agg.byTurn[0]).toEqual({ afterTurn: 4, n: 2, replay: 10, real: 7, winner: 15, winners: 2, median: { replay: 10, real: 7, winner: 15 }, replayAhead: 1, replayBehind: 0 });
    expect(agg.landWithoutBonuses).toEqual({ replay: 1, real: 2 });
    expect(agg.outpaced).toEqual({ replay: 1, real: 2 });
  });
});

describe('estimateSamples with orders (#318 a)', () => {
  it('reads my cached orders as the track does', () => {
    const orders: MyOrders = { deploys: [{ territoryId: 2, armies: 5 }], moves: [], cards: [] };
    const history = [
      { turn: 0, board: board(t(1, ME, 5), t(2, ME, 5), t(3, FOE, 5)) },
      { turn: 1, board: board(t(1, ME, 5), t(2, ME, 10), t(3, FOE, 10)) },
      { turn: 2, board: board(t(1, ME, 5), t(2, ME, 15), t(3, FOE, 15)) },
    ];
    const cached: TurnBoard[] = history.map((h) => ({ turn: h.turn + 1, board: h.board, orders }));
    const samples = estimateSamples({
      graph: G,
      me: ME,
      cached,
      history,
      plannerSettings: { baseIncome: 5 },
      incomeSettings: SETTINGS,
      settings: SETTINGS,
      game: trackGame(PLAYERS, SETTINGS),
      players: PLAYERS,
      opponents: [FOE],
    });
    // Turns 2 and 3 have a previous board: the tracker reads FOE at 5 from turn 3 (two boards up to it).
    expect(samples.map((s) => s.turn)).toEqual([1, 2, 3]);
    expect(samples.every((s) => s.truth === 5 && s.plan === 5)).toBe(true);
    expect(samples.find((s) => s.turn === 3)!.tracker).toBe(5);
  });
});

describe('the harness edges (#318)', () => {
  it('overlays a territory the replay never held from the history: my real land there reads neutral', () => {
    const out = overlayHistory(G, new Map(), board(t(1, ME, 4), t(2, 'neutral', 3), t(3, FOE, 2)), ME);
    expect(out.territories).toEqual([
      { territoryId: 1, owner: { kind: 'neutral' }, armies: 4 },
      { territoryId: 2, owner: { kind: 'neutral' }, armies: 3 },
      { territoryId: 3, owner: { kind: 'player', playerId: FOE }, armies: 2 },
    ]);
    // A territory the replay shows hidden stays hidden.
    const hidden = overlayHistory(G, new Map([[4, { owner: 'unknown' as const, armies: 0 }]]), board(), ME);
    expect(hidden.territories).toEqual([{ territoryId: 4, owner: { kind: 'unknown' }, armies: null }]);
  });

  it('reads a team game, a game with no winner, and a turn I really held nothing', () => {
    const MATE = 1003;
    const history = [
      { turn: 0, board: board(t(1, ME, 5), t(2, 'neutral', 2), t(3, MATE, 5), t(6, FOE, 5)) },
      { turn: 1, board: board(t(1, FOE, 5), t(2, 'neutral', 2), t(3, MATE, 5), t(6, FOE, 5)) },
    ];
    const r = openingBenchmark({
      graph: G,
      me: ME,
      history,
      plannerSettings: { baseIncome: 5 },
      incomeSettings: undefined,
      players: [{ id: ME, team: 0 }, { id: MATE, team: 0 }, { id: FOE, team: 1 }],
      winners: [],
      turns: 1,
      plan: () => ({ deploys: [{ territoryId: 1, armies: 5 }], moves: [{ from: 1, to: 2, armies: 1, kind: 'transfer', reason: '' }] }),
    });
    expect(r.stopped).toBeUndefined();
    expect(r.turns[0]).toMatchObject({ real: null, winner: null, bestOpponent: 5 });
    const agg = aggregateBenchmarks([r]);
    expect(agg.byTurn[0]).toMatchObject({ real: 0, winner: null, replayAhead: 1 });
    expect(ratioSummary({ n: 0, sum: 0, sq: 0, logSum: 0, under: 0, over: 0 })).toBeNull();
  });

  it('marks an opponent with no land on the truth board out, and passes the fog setting and an uneven start', () => {
    const OTHER = 1004;
    const history = [{ turn: 0, board: board(t(1, ME, 5), t(2, FOE, 5)) }];
    const settings = { ...SETTINGS, distributionMode: -3 } as GameSettings;
    const samples = estimateSamples({
      graph: G,
      me: ME,
      cached: [{ turn: 1, board: board(t(1, ME, 5), t(2, FOE, 5)) }],
      history,
      plannerSettings: { baseIncome: 5 },
      incomeSettings: settings,
      settings,
      game: trackGame([...PLAYERS, { id: OTHER }], settings),
      players: [...PLAYERS, { id: OTHER }],
      opponents: [FOE, OTHER],
    });
    expect(samples.map((s) => [s.opponent, s.truth, s.prior])).toEqual([[FOE, 5, null]]);
  });
});

describe('the opening benchmark by era (#503)', () => {
  it('reads the era off the turn-1 time where it is known, else off the game id; a game with neither is pre-tool', () => {
    expect(openingEra({ planned: true, turn1At: '2026-11-13T08:23:59Z', gameId: 45_700_000 })).toEqual({ era: 'pre-rule-4f', basis: 'turn-1 time' });
    expect(openingEra({ planned: true, turn1At: PRE_RULE_4F_AT, gameId: 45_600_000 })).toEqual({ era: 'current', basis: 'turn-1 time' });
    expect(openingEra({ planned: true, gameId: PRE_RULE_4F_GAME_ID - 1 })).toEqual({ era: 'pre-rule-4f', basis: 'game id' });
    expect(openingEra({ planned: true, gameId: PRE_RULE_4F_GAME_ID })).toEqual({ era: 'current', basis: 'game id' });
    // A record kept before the outlook line existed is still read by its id.
    expect(openingEra({ planned: false, gameId: 45_800_000 })).toEqual({ era: 'current', basis: 'game id' });
    expect(openingEra({ planned: true })).toEqual({ era: 'pre-tool', basis: 'no game id' });
    expect(openingEra({ planned: false })).toEqual({ era: 'pre-tool', basis: 'not planned' });
  });

  // I hold 1 (5 armies) on board 0. Turn 1: I take 2. Turn 2: only my armies grow (deploys, no capture or
  // attack: read as no orders, as a missed turn's board looks). Turn 3: FOE wears 1 down and I take nothing.
  // Turn 4: I take 3.
  const b0 = board(t(1, ME, 5), t(2, 'neutral', 2), t(3, 'neutral', 2), t(6, FOE, 5));
  const b1 = board(t(1, ME, 3), t(2, ME, 4), t(3, 'neutral', 2), t(6, FOE, 5));
  const b2 = board(t(1, ME, 8), t(2, ME, 4), t(3, 'neutral', 2), t(6, FOE, 5));
  const b3 = board(t(1, ME, 5), t(2, ME, 4), t(3, 'neutral', 2), t(6, FOE, 5));
  const b4 = board(t(1, ME, 3), t(2, ME, 4), t(3, ME, 4), t(6, FOE, 5));
  const hist = [b0, b1, b2, b3, b4].map((b, turn) => ({ turn, board: b }));

  it('flags the opening turns the history shows no orders of mine on, and a boot in the window', () => {
    expect(openingFlags({ me: ME, history: hist })).toEqual({ noOrderTurns: [2, 3], bootedTurn: null });
    // A failed attack or orders this server sent that turn are orders, whatever the board shows.
    expect(openingFlags({ me: ME, history: hist, sentTurns: [2], failedAttackTurns: [3] })).toEqual({ noOrderTurns: [], bootedTurn: null });
    // A boot in the window; one after it is not an opening flag; the window bounds the turns read.
    expect(openingFlags({ me: ME, history: hist, booted: { turn: 3 } })).toEqual({ noOrderTurns: [2, 3], bootedTurn: 3 });
    expect(openingFlags({ me: ME, history: hist, booted: { turn: 9 } })).toEqual({ noOrderTurns: [2, 3], bootedTurn: null });
    expect(openingFlags({ me: ME, history: hist, window: 2 })).toEqual({ noOrderTurns: [2], bootedTurn: null });
    // A turn I start with no land, or one the history lacks, is not read.
    expect(openingFlags({ me: 9999, history: hist })).toEqual({ noOrderTurns: [], bootedTurn: null });
    expect(OPENING_WINDOW).toBe(4);
  });

  it('reports medians beside means, with the games each figure rests on', () => {
    const turn = (replay: number, real: number, winner: number | null) => ({
      afterTurn: 3,
      replay: { income: replay, territories: 3 },
      real: { income: real, territories: 3 },
      winner,
      bestOpponent: winner ?? 0,
    });
    const agg = aggregateBenchmarks([
      { turns: [turn(9, 5, 10)], exact: true },
      { turns: [turn(12, 8, null)], exact: true },
      { turns: [turn(110, 30, 160)], exact: true },
    ]);
    expect(agg.byTurn[0]).toMatchObject({ afterTurn: 3, n: 3, replay: 43.667, real: 14.333, winner: 85, winners: 2 });
    expect(agg.byTurn[0]!.median).toEqual({ replay: 12, real: 8, winner: 85 });
  });

  it('groups the benchmarks by era and format, keeps flagged games apart, and counts the bases and the large maps', () => {
    const bench = (income: number) => ({ turns: [{ afterTurn: 1, replay: { income, territories: 2 }, real: { income, territories: 2 }, winner: income, bestOpponent: income }], exact: true });
    const none = { noOrderTurns: [], bootedTurn: null };
    const r = benchmarkByEra([
      { era: 'current', basis: 'game id', format: '1v1', territories: 40, flags: none, bench: bench(5) },
      { era: 'current', basis: 'game id', format: 'ffa', territories: 50, flags: none, bench: bench(7) },
      { era: 'current', basis: 'game id', format: 'ffa', territories: 2770, flags: none, bench: bench(9) },
      { era: 'current', basis: 'game id', format: '1v1', territories: 40, flags: { noOrderTurns: [2], bootedTurn: null }, bench: bench(1) },
      { era: 'pre-tool', basis: 'no game id', format: '1v1', territories: 40, flags: { noOrderTurns: [2, 3], bootedTurn: 2 }, bench: bench(2) },
    ]);
    expect(r.basis).toEqual({ 'game id': 4, 'no game id': 1 });
    expect(r.eras.current!.all.games).toBe(3);
    expect(r.eras.current!.byFormat.ffa!.games).toBe(2);
    expect(r.eras.current!.largeMaps).toBe(1);
    expect(r.eras.current!.flagged).toMatchObject({ games: 1, noOrderTurns: 1, boots: 0 });
    expect(r.eras.current!.flagged.benchmark!.byTurn[0]!.real).toBe(1);
    expect(r.eras['pre-tool']!.all.games).toBe(0);
    expect(r.eras['pre-tool']!.flagged).toMatchObject({ games: 1, noOrderTurns: 2, boots: 1 });
    expect(r.eras['pre-rule-4f']).toBeUndefined();
  });
});
