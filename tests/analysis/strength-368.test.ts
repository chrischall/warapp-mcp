// #368: opponent strength was underestimated under fog. Synthetic maps only: every id and name here
// is made up.
//  (1) a player out (booted, eliminated, surrendered) no longer turns the FFA fog prior off: its share
//      of what the board hides is split among the opponents still playing;
//  (2) when the evidence is thin (income read from under LOW_COVERAGE of its frontier, or its tracked
//      income rising two turns running) the estimate is the highest of its tracked figure, the fog
//      prior (not shrunk toward the track) and the trend's projection;
//  (3) a per-player known income (`knownIncome`) overrides the estimate;
//  (4) the outlook leans behind when it read even for OUTLOOK_TURNS turns running while I lost a bonus
//      on each of them.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { gameOutlook } from '../../src/analysis/outlook.js';
import type { ObservedTurn, OpponentTrack } from '../../src/analysis/opponents.js';
import {
  enemyDeployEstimates,
  LOW_COVERAGE,
  planEnemyEstimates,
  planTurn,
  type PlanInput,
  type PlannerSettings,
} from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const A = 20;
const B = 30;
const C = 40;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true, baseIncome: 10 };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}

const enemy = (territoryId: number, armies: number, playerId = A): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});

/**
 * A hand-built track: one observed turn per entry of `readings` (its observed deploy that turn), the
 * newest read from turn `end` − 1 to `end`; `income` is the tracked figure, `share` the frontier
 * coverage every turn carries (none when undefined).
 */
function track(playerId: number, income: number, readings: number[], opts: { share?: number; end?: number; visibleIncome?: number } = {}): OpponentTrack {
  const end = opts.end ?? 12;
  const visibleIncome = opts.visibleIncome ?? 10;
  const list: ObservedTurn[] = readings.map((r, i) => ({
    from: end - readings.length + i,
    to: end - readings.length + i + 1,
    observed: r,
    raw: r,
    cap: 2000,
    counted: [],
    captured: [],
    fromFog: [],
    reveals: [],
    visibleIncome,
    earned: Math.max(visibleIncome, r),
    net: 0,
    losses: 0,
    fogArmies: 0,
    measured: 0,
    broken: [],
    brokenValue: 0,
    low: r,
    high: r,
    reinforced: [],
    grewFromFog: [],
    emptied: [],
    combat: 0,
    ...(opts.share !== undefined ? { coverage: { inView: Math.round(opts.share * 10), frontier: 10, share: opts.share, hiddenBonuses: 0 } } : {}),
  }));
  return {
    playerId,
    firstSeen: 1,
    lastTurn: end,
    turns: list,
    base: visibleIncome,
    bonusIncome: 0,
    visibleIncome,
    income,
    incomeTurns: list.slice(-3).map((x) => x.from),
    observedRange: { min: Math.min(...readings), max: Math.max(...readings) },
    incomeMethod: 'max-observed',
    incomeLowered: 0,
    unexplained: 0,
    inferred: null,
    visible: 1,
    turnsUnseen: 0,
    turnsUnseenAtLeast: false,
    earnedAtLeast: null,
    warnings: [],
    notes: [],
  };
}

// My T1–T4 in a line (+5 on T1–T2). Player A's T5 sits beside my T4, the fogged T20 and the
// visible neutral T30; player B's T6 beside my T1 and the fogged T21. T20–T27 are fogged and hold
// two +400 bonuses. Player C is in the game and nowhere in view.
const ids = [1, 2, 3, 4, 5, 6, 30, 20, 21, 22, 23, 24, 25, 26, 27];
const edges: [number, number][] = [
  [1, 2],
  [2, 3],
  [3, 4],
  [4, 5],
  [5, 20],
  [5, 30],
  [1, 6],
  [6, 21],
  ...Array.from({ length: 7 }, (_, i): [number, number] => [20 + i, 21 + i]),
];
const g = buildGraph(makeMap(ids, edges, [[901, 5, [1, 2]], [902, 400, [20, 21, 22, 23]], [903, 400, [24, 25, 26, 27]]]));
const fog = [20, 21, 22, 23, 24, 25, 26, 27].map((t) => fogged(t));
const s: BoardState = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 30), enemy(6, 30, B), neutral(30, 2), ...fog]);
const players = [{ id: ME }, { id: A }, { id: B }, { id: C }];
const ffa = (over: Partial<PlanInput> = {}): PlanInput => ({
  graph: g,
  board: s,
  me: ME,
  income: 91,
  settings: STD,
  turn: 12,
  game: { players, turn: 12, symmetricStart: true },
  options: { adapt: true },
  ...over,
});
const est = (over: Parameters<typeof planEnemyEstimates>[0]['game'], extra: Partial<Parameters<typeof planEnemyEstimates>[0]> = {}) =>
  planEnemyEstimates({ graph: g, board: s, me: ME, income: 91, settings: STD, game: over, turn: 12, ...extra });

describe('(1) a player out keeps the FFA fog prior: its share goes to the opponents still playing', () => {
  it('one booted player: the prior stays on, capped at an even share among the survivors', () => {
    const out = [...players, { id: 50, state: 'Booted' }];
    const r = est({ players: out, turn: 12, symmetricStart: true });
    expect(r.priorSkipped).toBeUndefined();
    expect(r.prior).toMatchObject({ myIncome: 91, format: 'ffa', opponents: 3, out: [{ id: 50, state: 'Booted' }] });
    const a = r.estimates.find((e) => e.playerId === A)!;
    // An even third of the hidden 800 over its base 10 caps the prior; my 91 is below it.
    expect(a).toMatchObject({ source: 'prior', prior: 91, estimate: 91, priorCap: 10 + Math.ceil(800 / 3) });
  });

  it('an opponent out but still on the board is no survivor: B booted leaves A and C to share it', () => {
    const out = players.map((p) => (p.id === B ? { ...p, state: 'Booted' } : p));
    const r = est({ players: out, turn: 12, symmetricStart: true });
    expect(r.prior).toMatchObject({ format: 'ffa', opponents: 2 });
    expect(r.estimates.find((e) => e.playerId === A)).toMatchObject({ source: 'prior', priorCap: 10 + 400 });
  });

  it('a booted seat an AI now plays is still an opponent, and shares the hidden board', () => {
    const out = players.map((p) => (p.id === B ? { ...p, state: 'Booted', humanTurnedIntoAI: true } : p));
    const r = est({ players: out, turn: 12, symmetricStart: true });
    expect(r.prior).toMatchObject({ format: 'ffa', opponents: 3 });
  });

  it('down to one survivor: the prior stays, capped at the most it could earn', () => {
    const out = [{ id: ME }, { id: A }, { id: B, state: 'Eliminated' }, { id: C, state: 'SurrenderAccepted' }];
    const r = est({ players: out, turn: 12, symmetricStart: true });
    expect(r.prior).toMatchObject({ format: 'ffa', opponents: 1 });
    expect(r.estimates.find((e) => e.playerId === A)).toMatchObject({ source: 'prior', priorCap: null, estimate: 91 });
  });

  it('the plan says the prior was kept and why, never "No fog prior"', () => {
    const out = [...players, { id: 50, state: 'Booted' }];
    const p = planTurn(ffa({ game: { players: out, turn: 12, symmetricStart: true } }));
    const text = p.warnings.join('\n');
    expect(text).not.toMatch(/No fog prior/);
    expect(text).toMatch(
      /Enemy deploy estimate for player 20: ~91 \(a prior, not an observation: in a free-for-all that started even \(no teams; player 50 is out \(Booted\), its share of what the board hides split among the 3 opponents still playing\), an opponent bordering the fog is assumed to earn at least my own income 91, capped at an even share \(1 of 3 opponents\)/,
    );
  });

  it('an uneven start still turns it off, and says so', () => {
    const r = est({ players, turn: 12, symmetricStart: false, unevenStart: 'a custom scenario' });
    expect(r.prior).toBeUndefined();
    expect(r.priorSkipped).toBe('a custom scenario');
  });
});

describe('(2) thin evidence: the estimate is the highest of the tracked figure, the fog prior and the trend', () => {
  // A 1v1 for the estimates below: one opponent (A) beside the fog; B's T6 is left out by using A only.
  const one = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 30), neutral(6, 2), neutral(30, 2), ...fog]);
  const at = (t: OpponentTrack, prior?: { myIncome: number }) =>
    enemyDeployEstimates(g, one, ME, STD, undefined, [t], prior).find((e) => e.playerId === A)!;

  it(`read from under ${LOW_COVERAGE * 100}% of its frontier: the fog prior stands whole, not shrunk toward the track`, () => {
    // Six turns of a track at 26, each turn reading 30% of its frontier; my income 91.
    const thin = at(track(A, 26, [26, 26, 26, 26, 26, 26], { share: 0.3 }), { myIncome: 91 });
    expect(thin).toMatchObject({ estimate: 91, source: 'prior' });
    expect(thin.thinEvidence).toMatchObject({ coverage: 0.3, rising: null, tracked: 26, prior: 91, trend: null, figure: 91 });
    // The same evidence read from 80% of its frontier is no thin evidence: the prior shrinks as before (#235).
    const thick = at(track(A, 26, [26, 26, 26, 26, 26, 26], { share: 0.8 }), { myIncome: 91 });
    expect(thick.thinEvidence).toBeNull();
    expect(thick.estimate).toBeLessThan(91);
  });

  it('tracked income rising two turns running: the trend projects one more step', () => {
    // Its readings 10, 20, 40, 60: the tracked figure (the most of a turn and the two before it) as of
    // each of the last three turns read 20, 40, 60 — rising twice; one more step of the mean rise
    // ((60 − 20) / 2 = 20) gives 80.
    const e = at(track(A, 60, [10, 20, 40, 60], { share: 0.8 }));
    expect(e.thinEvidence).toMatchObject({ coverage: 0.8, rising: [20, 40, 60], tracked: 60, prior: null, trend: 80, figure: 80 });
    expect(e).toMatchObject({ estimate: 80, source: 'tracked' });
  });

  it('not rising when one of the last two steps is flat', () => {
    const e = at(track(A, 40, [10, 40, 40, 40], { share: 0.8 }));
    expect(e.thinEvidence).toBeNull();
    expect(e.estimate).toBe(40);
  });

  it('the trend and the prior: the higher wins, capped at what it could earn', () => {
    const e = at(track(A, 60, [10, 20, 40, 60], { share: 0.3 }), { myIncome: 91 });
    expect(e.thinEvidence).toMatchObject({ trend: 80, prior: 91, figure: 91 });
    const huge = at(track(A, 600, [100, 200, 400, 600], { share: 0.3 }));
    // 600 + 200 = 800 projected, at most its base 10 + the fogged 800 = 810; the low-coverage floor
    // (600 × 1.5 = 900, capped at 810) is higher still and keeps its own label.
    expect(huge.estimate).toBe(810);
  });

  it('the plan warns what the estimate rests on', () => {
    const p = planTurn(
      ffa({ board: one, game: { players: [{ id: ME }, { id: A }], turn: 12, symmetricStart: false }, tracks: [track(A, 60, [10, 20, 40, 60], { share: 0.8 })] }),
    );
    expect(p.warnings.join('\n')).toMatch(
      /Enemy deploy estimate for player 20: ~80 \(thin evidence: its tracked income rose two turns running \(20, 40, 60\), so it is sized for the highest of the tracked ~60 and the trend's next step ~80, not the lower bound\)/,
    );
  });
});

describe('(3) a known per-player income overrides the estimate', () => {
  it('replaces the estimate, whatever its source, and says it was supplied', () => {
    const r = est({ players, turn: 12, symmetricStart: true }, { known: [{ player: A, income: 27 }] });
    const a = r.estimates.find((e) => e.playerId === A)!;
    expect(a).toMatchObject({ estimate: 27, known: { income: 27, was: 91 } });
    // Another player's estimate is left alone.
    expect(r.estimates.find((e) => e.playerId === B)!.known).toBeUndefined();
  });

  it('a Reinforcement card the clock says it may hold stays on top of the known income', () => {
    const r = est(
      { players, turn: 12, symmetricStart: true, reinforcement: { armies: 5, firstTurn: 3, turnsPerCard: 4 } },
      { known: [{ player: A, income: 27 }] },
    );
    expect(r.estimates.find((e) => e.playerId === A)).toMatchObject({ estimate: 32, card: { armies: 5 }, known: { income: 27 } });
  });

  it('the plan sizes for it and warns that it was supplied; one for a player not in view is named unused', () => {
    const p = planTurn(ffa({ knownIncome: [{ player: A, income: 40 }, { player: C, income: 60 }] }));
    const w = p.warnings.join('\n');
    expect(w).toMatch(/Enemy deploy estimate for player 20: ~40 \(the known income you supplied \(known_income\), in place of the estimate ~91\)/);
    expect(w).toMatch(/known_income for player 40 is not used: none of its territories is in view/);
  });

  it('enemyDeploy, a what-if for every opponent, wins over it', () => {
    const p = planTurn(ffa({ knownIncome: [{ player: A, income: 40 }], options: { adapt: true, enemyDeploy: 12 } }));
    expect(p.enemyDeploy).toBe(12);
  });
});

describe('(4) the outlook leans behind when it reads even while bonuses keep falling', () => {
  // A line of ten territories, each its own +1 bonus; no fog. I hold 1–k at 30 armies each, the foe the
  // rest at 10: every turn I lose one territory (and its bonus), and strength stays within the even band.
  const ten: GameMap = {
    id: 2,
    name: 'Line',
    territories: Array.from({ length: 10 }, (_, i) => ({
      id: i + 1,
      name: `L${i + 1}`,
      connectedTo: [i, i + 2].filter((x) => x >= 1 && x <= 10),
    })),
    bonuses: Array.from({ length: 10 }, (_, i) => ({ id: 500 + i + 1, name: `P${i + 1}`, value: 1, territoryIds: [i + 1], bonusIds: [] })),
    distributionModes: [],
  };
  const lg = buildGraph(ten);
  const held = (k: number) => board(Array.from({ length: 10 }, (_, i) => (i < k ? mine(i + 1, 30) : enemy(i + 1, 10))));
  const game = { players: [{ id: ME }, { id: A }] };
  const run = (ks: number[]) => gameOutlook({ graph: lg, me: ME, boards: ks.map((k, i) => ({ turn: 3 + i, board: held(k) })), game });

  it('even for OUTLOOK_TURNS turns running, a bonus of mine lost on each: leaning behind, with the bonuses lost', () => {
    const o = run([5, 4, 3, 2]);
    expect(o.turns.map((t) => t.state)).toEqual(['even', 'even', 'even']);
    expect(o.state).toBe('even');
    expect(o.turns.map((t) => t.bonusesLost)).toEqual([[505], [504], [503]]);
    expect(o.leaning).toEqual({ toward: 'behind', turns: 3, lost: [{ turn: 4, value: 1 }, { turn: 5, value: 1 }, { turn: 6, value: 1 }] });
    expect(o.basis).toMatch(
      /Leaning behind: even for 3 turns running while I lost bonuses on each \(turn 4 \+1, turn 5 \+1, turn 6 \+1\): the strength ratio lags a slide/,
    );
  });

  it('no lean when a turn of the run lost no bonus, or the state is not even', () => {
    expect(run([5, 4, 4, 3]).leaning).toBeUndefined();
    expect(run([5, 5, 5, 5]).leaning).toBeUndefined();
  });
});
