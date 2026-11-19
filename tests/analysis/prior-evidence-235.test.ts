// #235: after #234, three re-plans by the play session. Synthetic maps only: every id and name here
// is made up.
//  (1) the FFA fog prior skipped an even-start game whose map distribution is a "scenario" (the
//      client's own help: a map scenario only says where each player starts, and still gives each
//      the same territories at the same armies; only a custom scenario does not), a skipped prior
//      in an FFA is now named, and a tracked figure below the newest turn's own reading of the
//      same board no longer stands alone;
//  (2) the prior shrinks toward the evidence (observed turns × the visible share of its edge), and
//      in an FFA it is capped at an even share of what the board hides, not all of it;
//  (3) the Standing-still warning names the source the plan stages on.
import { describe, expect, it } from 'vitest';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { symmetricStart, trackOpponents, unevenStart, type OpponentTrack } from '../../src/analysis/opponents.js';
import {
  enemyDeployEstimates,
  planTurn,
  PRIOR_EVIDENCE_TURNS,
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
 * A hand-built track: `turns` consecutive observed turns, the newest read from turn `end` − 1 to
 * `end` (default 12, the newest board's turn), income `income`.
 */
function track(playerId: number, income: number, turns: number, visibleIncome = 10, end = 12): OpponentTrack {
  const t = { from: 0, to: 1, observed: income, raw: income, cap: income, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome, earned: income, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: income, high: income, reinforced: [], grewFromFog: [], emptied: [], combat: 0 };
  const list = Array.from({ length: turns }, (_, i) => ({ ...t, from: end - turns + i, to: end - turns + i + 1 }));
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
    observedRange: { min: income, max: income },
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
const s = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 30), enemy(6, 30, B), neutral(30, 2), ...fog]);
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
const text = (p: { warnings: string[]; rationale: string[] }) => [...p.warnings, ...p.rationale].join('\n');

describe('(1) which starts are even: every distribution but a custom scenario', () => {
  it("a map's scenario distribution starts every player even; a custom scenario does not; unknown is not", () => {
    // A map distribution of any type: the client gives every player the same count at the same armies.
    expect(symmetricStart({ distributionMode: 2 })).toBe(true);
    expect(symmetricStart({ distributionMode: 2, raw: { CustomScenario: 'null', AutomaticTerritoryDistribution: 'Automatic' } })).toBe(true);
    // Full, random warlords, random cities (the client's 0, -1, -2).
    for (const mode of [0, -1, -2]) expect(symmetricStart({ distributionMode: mode })).toBe(true);
    // A custom scenario: DistributionMode -3, or the CustomScenario setting.
    expect(symmetricStart({ distributionMode: -3 })).toBe(false);
    expect(symmetricStart({ distributionMode: 2, raw: { CustomScenario: { Territories: [] } } })).toBe(false);
    expect(unevenStart({ distributionMode: -3 })).toMatch(/custom scenario/);
    expect(symmetricStart({})).toBe(false);
    expect(unevenStart(undefined)).toMatch(/DistributionMode/);
  });

  it('in an FFA, a prior not applied says why: the start', () => {
    const p = planTurn(ffa({ game: { players, turn: 12, symmetricStart: false, unevenStart: 'the game uses a custom scenario, which sets each player\'s starting territories and armies by hand' } }));
    expect(p.warnings.join('\n')).toMatch(
      /No fog prior for the opponents beside the fog \(players 20, 30\) in this free-for-all: the game uses a custom scenario, which sets each player's starting territories and armies by hand;/,
    );
    expect(p.warnings.join('\n')).not.toMatch(/a prior, not an observation/);
  });

  it('#368: a player out no longer turns the prior off, so there is no "No fog prior" line for it', () => {
    const out = [...players, { id: 50, state: 'Eliminated' }];
    const p = planTurn(ffa({ game: { players: out, turn: 12, symmetricStart: true } }));
    expect(p.warnings.join('\n')).not.toMatch(/No fog prior/);
    expect(p.warnings.join('\n')).toMatch(/player 50 is out \(Eliminated\), its share of what the board hides split among the 3 opponents still playing/);
  });

  it('#368: a player out with no AI on its seat gets no prior itself: its land reads as neutral (#270)', () => {
    // Player B (30) still holds T6 beside the fog but was booted: out, not an opponent the prior covers.
    const out = players.map((p) => (p.id === B ? { ...p, state: 'Booted' } : p));
    const p = planTurn(ffa({ game: { players: out, turn: 12, symmetricStart: true } }));
    expect(p.warnings.join('\n')).not.toMatch(/No fog prior|Enemy deploy estimate for player 30/);
    expect(p.warnings.join('\n')).toMatch(/player 30 is out \(Booted\), its share of what the board hides split among the 2 opponents still playing/);
  });

  it('no such line in a team game, a 1v1, or when no opponent borders the fog', () => {
    const teams = players.map((p, i) => ({ ...p, team: i % 2 }));
    expect(text(planTurn(ffa({ game: { players: teams, turn: 12, symmetricStart: false } })))).not.toMatch(/No fog prior/);
    const duel = [{ id: ME }, { id: A }];
    const one = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 30), neutral(30, 2), ...fog]);
    expect(text(planTurn(ffa({ board: one, game: { players: duel, turn: 12, symmetricStart: false } })))).not.toMatch(/No fog prior/);
    const open = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 30), enemy(6, 30, B), neutral(30, 2), ...fog.map((t) => neutral(t.territoryId, 2))]);
    expect(text(planTurn(ffa({ board: open, game: { players, turn: 12, symmetricStart: false } })))).not.toMatch(/No fog prior/);
  });
});

describe('(1) a usable track replaces the newest observed turn: a walk-in is labelled, never income (#235 1c)', () => {
  // Player A's T5 grew 20 → 120 beside the fog (no visible neighbour of its own shrank): ambiguous
  // (#123). The track (two observed turns, the newest 10 → 11) says 20 and has not read turn 11 → 12.
  // The planner's own reading of that turn never lifts the estimate above the track: a stack walking
  // in beside the fog is not income (lesson 5).
  const before = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 20), enemy(6, 30, B), neutral(30, 2), ...fog]);
  const now = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 120), enemy(6, 30, B), neutral(30, 2), ...fog]);
  const behind = (income: number, turns: number) => track(A, income, turns, 10, 11);
  const when = { turn: 12 };

  it('the estimate is the tracked figure, never the newest turn read above it', () => {
    const [a] = enemyDeployEstimates(g, now, ME, STD, before, [behind(20, 2)], undefined, when);
    expect(a).toMatchObject({ playerId: A, tracked: 20, estimate: 20, source: 'tracked' });
    const p = planTurn(ffa({ board: now, previousBoard: before, tracks: [behind(20, 2)], game: { players, turn: 12, symmetricStart: false } }));
    expect(p.warnings.join('\n')).not.toMatch(/on the newest turn, read against its tracked income/);
  });

  it('with the fog prior on, the prior shrinks toward the track alone, not the newest reading', () => {
    // FFA prior 91 (my income), a six-turn track of 26 ending at turn 11, one short of the newest
    // board: no shrink, and the newest turn's reading is no part of `toward`.
    const prior = { myIncome: 91, format: 'ffa' as const, opponents: 3 };
    const a = enemyDeployEstimates(g, now, ME, STD, before, [behind(26, 6)], prior, when).find((e) => e.playerId === A)!;
    expect(a).toMatchObject({ tracked: 26, prior: 91, source: 'prior', estimate: 91 });
    expect(a.priorBlend).toMatchObject({ prior: 91, toward: 26, turns: 0, weight: 1, figure: 91 });
    const [bare] = enemyDeployEstimates(g, now, ME, STD, before, [behind(26, 6)], undefined, when);
    expect(bare).toMatchObject({ estimate: 26, source: 'tracked' });
  });

  it('a newest turn below the track leaves the track standing', () => {
    const quiet = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 25), enemy(6, 30, B), neutral(30, 2), ...fog]);
    const [a] = enemyDeployEstimates(g, quiet, ME, STD, before, [behind(20, 2)], undefined, when);
    expect(a).toMatchObject({ tracked: 20, estimate: 20, source: 'tracked', newestCut: null });
  });
});

describe('(1) a one-off walk-in beside the fog is not income above the track (#123 lesson 5, #235 review)', () => {
  // Base 10 and a fogged +100 bonus. Player A's interior T6 grows +30 a turn (unambiguous: the
  // tracker reads 30, 30, 30); on the last turn a one-off +100 walks in on T5, beside the fog. The
  // tracker reads that turn against twice what it carried (2 × 30 = 60): tracked 60. Reading the
  // same turn again against twice that (120) took 110 of it as income.
  const map = makeMap(
    [1, 2, 4, 5, 6, 30, 20, 21, 22],
    [[1, 2], [2, 4], [4, 5], [5, 20], [5, 30], [5, 6], [6, 30], [20, 21], [21, 22]],
    [[900, 100, [20, 21, 22]]],
  );
  const gw = buildGraph(map);
  const at = (a5: number, a6: number) =>
    board([mine(1, 40), mine(2, 3), mine(4, 40), enemy(5, a5), enemy(6, a6), neutral(30, 2), fogged(20), fogged(21), fogged(22)]);
  const stacks: [number, number][] = [[20, 10], [20, 40], [20, 70], [20, 100], [120, 130]];
  const boards = stacks.map(([a5, a6], i) => ({ turn: i + 1, board: at(a5, a6) }));
  const tracks = trackOpponents(gw, boards, ME, STD);

  it("the estimate is the track's own reading, never the newest turn read a second time", () => {
    const t = tracks.find((x) => x.playerId === A)!;
    expect(t.turns.map((x) => x.observed)).toEqual([30, 30, 30, 60]);
    // The newest turn was bounded by twice the 30 carried before it.
    expect(t.turns.at(-1)!.expected).toBe(30);
    expect(t.income).toBe(60);
    for (const w of [{ turn: 5 }, undefined]) {
      const [e] = enemyDeployEstimates(gw, at(120, 130), ME, STD, at(20, 100), tracks, undefined, w);
      expect(e).toMatchObject({ tracked: 60, observed: 60, estimate: 60, source: 'tracked' });
    }
  });

  it('production shape (tracks include the newest board, prior off): the cut reading is labelled, the estimate unchanged', () => {
    const [e] = enemyDeployEstimates(gw, at(120, 130), ME, STD, at(20, 100), tracks, undefined, { turn: 5 });
    // Every ambiguous army read as deploy (+30 on T6, +100 on T5: 130), at most what it could earn:
    // base 10 + the fogged +100.
    expect(e).toMatchObject({ tracked: 60, estimate: 60, source: 'tracked' });
    expect(e!.newestCut).toEqual({ from: 4, to: 5, observed: 60, reading: 110, expected: 30 });
    const p = planTurn({
      graph: gw,
      board: at(120, 130),
      previousBoard: at(20, 100),
      tracks,
      me: ME,
      income: 15,
      settings: STD,
      turn: 5,
      game: { players: [{ id: ME }, { id: A }], turn: 5, symmetricStart: false },
      options: { adapt: true },
    });
    const w = p.warnings.join('\n');
    expect(w).toMatch(
      /Player 20's newest turn \(turn 4 → turn 5\) reads up to \+110 if the armies that arrived beside the fog were deploys \(\+60 with those beyond twice the ~30 it was expected to deploy read as moves\); the estimate keeps ~60 \(tracked\) because a stack walking in is not income \(#123\)\. To test the higher figure, pass enemy_deploy 110 to warapp_check_plan\./,
    );
    expect(w).toMatch(/Enemy deploy estimate for player 20: ~60 \(tracked over 3 observed turns/);
    expect(w).not.toMatch(/on the newest turn, read against/);
  });

  it('no label when the newest turn was not cut', () => {
    const quiet = trackOpponents(gw, stacks.slice(0, 4).map(([a5, a6], i) => ({ turn: i + 1, board: at(a5, a6) })), ME, STD);
    const [e] = enemyDeployEstimates(gw, at(20, 100), ME, STD, at(20, 70), quiet, undefined, { turn: 4 });
    expect(e).toMatchObject({ tracked: 30, newestCut: null });
  });

  it('a 1v1 fog prior below the track does not lift it either', () => {
    const [e] = enemyDeployEstimates(gw, at(120, 130), ME, STD, at(20, 100), tracks, { myIncome: 30 }, { turn: 5 });
    expect(e).toMatchObject({ tracked: 60, estimate: 60 });
  });
});

describe('(2) the prior counts only an observed run that ends at the newest board (#235 review)', () => {
  it('a run that stopped two turns ago is no evidence: the prior stands whole', () => {
    const stale = track(A, 26, 6, 10, 10);
    const e = enemyDeployEstimates(g, s, ME, STD, undefined, [stale], { myIncome: 91, format: 'ffa', opponents: 3 }, { turn: 12 }).find((x) => x.playerId === A)!;
    expect(e.priorBlend).toMatchObject({ turns: 0, weight: 1, figure: 91 });
    expect(e).toMatchObject({ estimate: 91, source: 'prior' });
    // The same run ending at turn 12 shrinks it.
    const fresh = enemyDeployEstimates(g, s, ME, STD, undefined, [track(A, 26, 6)], { myIncome: 91, format: 'ffa', opponents: 3 }, { turn: 12 }).find((x) => x.playerId === A)!;
    expect(fresh.priorBlend).toMatchObject({ turns: 6 });
  });
});

describe('(2) the prior shrinks toward the evidence', () => {
  const at = (turns: number, b: BoardState = s) =>
    enemyDeployEstimates(g, b, ME, STD, undefined, [track(A, 26, turns)], { myIncome: 91, format: 'ffa', opponents: 3 }).find((e) => e.playerId === A)!;

  it('the gap to the tracked figure keeps PRIOR_EVIDENCE_TURNS / (PRIOR_EVIDENCE_TURNS + turns × visible share)', () => {
    expect(PRIOR_EVIDENCE_TURNS).toBe(4);
    // T5's edge: T4 (mine) and T30 (a neutral) in view, T20 fogged: 2/3 visible.
    const two = at(2);
    expect(two.priorBlend).toMatchObject({ prior: 91, toward: 26, turns: 2, share: 2 / 3 });
    expect(two.priorBlend!.weight).toBeCloseTo(4 / (4 + 4 / 3), 9);
    expect(two).toMatchObject({ estimate: 26 + Math.ceil((4 / (4 + 4 / 3)) * 65), source: 'prior' });
    const six = at(6);
    expect(six).toMatchObject({ estimate: 26 + Math.ceil(0.5 * 65), source: 'prior' });
  });

  it('monotone: more observed turns, or more of its edge in view, move it toward the tracked figure', () => {
    const figures = [2, 3, 5, 8, 12].map((n) => at(n).estimate);
    for (let i = 1; i < figures.length; i++) expect(figures[i]).toBeLessThanOrEqual(figures[i - 1]!);
    expect(figures.at(-1)).toBeGreaterThan(26);
    // T30 fogged as well: only 1/3 of its edge in view, so the prior keeps more.
    const darker = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 30), enemy(6, 30, B), fogged(30), ...fog]);
    expect(at(6, darker).estimate).toBeGreaterThan(at(6).estimate);
  });

  it('no track, no shrink: the prior stands whole', () => {
    const e = enemyDeployEstimates(g, s, ME, STD, undefined, undefined, { myIncome: 91, format: 'ffa', opponents: 3 }).find((x) => x.playerId === A)!;
    expect(e).toMatchObject({ estimate: 91, priorBlend: null, source: 'prior' });
  });

  it('the warning names the prior, the tracked figure and the evidence that moved it', () => {
    const p = planTurn(ffa({ tracks: [track(A, 26, 6), track(B, 12, 6)] }));
    expect(p.warnings.join('\n')).toMatch(
      /Enemy deploy estimate for player 20: ~59 \(a prior, not an observation: in a free-for-all that started even \(no teams, every player still in\), an opponent bordering the fog is assumed to earn at least my own income 91, capped at an even share \(1 of 3 opponents\) of what the board hides, 277 \(all of it would be 810\) — shrunk toward its tracked ~26 by the evidence: 6 observed turns with 67% of its edge in view keep 50% of the gap from 91; base 10 \+ visible bonuses \+0 = 10, tracked ~26\)/,
    );
  });
});

describe('(2) in an FFA the prior is capped at an even share of what the board hides', () => {
  it('each of three opponents is credited a third of the hidden bonuses, not all of them', () => {
    const rich = { myIncome: 500 };
    const [a1] = enemyDeployEstimates(g, s, ME, STD, undefined, undefined, rich);
    // A 1v1 credits it every fogged bonus: base 10 + 800.
    expect(a1).toMatchObject({ couldEarn: 810, prior: 500, estimate: 500 });
    const [a3] = enemyDeployEstimates(g, s, ME, STD, undefined, undefined, { ...rich, format: 'ffa', opponents: 3 });
    // An FFA of three opponents: base 10 + a third of 800, rounded up.
    expect(a3).toMatchObject({ couldEarn: 810, prior: 10 + Math.ceil(800 / 3), estimate: 10 + Math.ceil(800 / 3), source: 'prior' });
  });

  it('per-territory income: an even share of the hidden territories too', () => {
    const per: PlannerSettings = { ...STD, bonusArmyPer: 1 };
    const [a] = enemyDeployEstimates(g, s, ME, per, undefined, undefined, { myIncome: 2000, format: 'ffa', opponents: 3 });
    // Its 1 visible territory plus a third of the 8 fogged (3), at one army each, over the base 10;
    // plus a third of the 800.
    expect(a!.couldHold).toBe(9);
    expect(a!.prior).toBe(10 + Math.ceil(800 / 3));
    const [b] = enemyDeployEstimates(g, s, ME, { ...per, baseIncome: 0 }, undefined, undefined, { myIncome: 2000, format: 'ffa', opponents: 3 });
    expect(b!.prior).toBe(1 + 3 + Math.ceil(800 / 3));
  });
});

describe('(3) the Standing-still warning names the source the plan stages on', () => {
  // B100 (+3): T1, T2, T3, T5. T3 is a 12-neutral that takes 58 at a 20% offensive kill rate. T1
  // (13) and T2 (32) both face player 20's T4. Taking T3 now would leave T1 unable to hold, and
  // the leftover saves toward it on T2.
  const LOW: PlannerSettings = { offensiveKillRate: 20, defensiveKillRate: 80, oneArmyStandsGuard: false, luckModifier: 0, roundingMode: 'StraightRound' };
  const map = makeMap([1, 2, 3, 4, 5, 6, 7, 8], [[1, 2], [1, 3], [2, 3], [1, 4], [2, 4], [2, 5], [3, 5], [3, 6], [4, 7], [4, 8]], [[100, 3, [1, 2, 3, 5]]]);
  const b = board([mine(1, 13), mine(2, 32), neutral(3, 12), enemy(4, 22), mine(5, 0), mine(6, 0), enemy(7, 5, B), enemy(8, 3)], true);
  it('it says the plan stages on T2, and still why T1 cannot take it now', () => {
    const p = planTurn({
      graph: buildGraph(map),
      board: b,
      me: ME,
      income: 18,
      settings: LOW,
      turn: 13,
      game: { players: [{ id: ME }, { id: A }, { id: B }], turn: 13, fog: 'Foggy' },
      options: { adapt: true, enemyDeploy: 30 },
    });
    expect(p.rationale.join('\n')).toMatch(/Deploy the leftover 17 to T2 \(#2\): save toward T3 \(#3\) \(58 to take\)/);
    expect(p.warnings.join('\n')).toMatch(
      /Standing still: no capture is planned, and the cheapest expansion \(T3 \(#3\), 58 armies, toward bonus B100 \(#100\)\) is not taken this turn: the plan stages on T2 \(#2\) toward it \(the leftover saves there\); taking it now would leave T1 \(#1\) unable to hold its border \(3 would stay, 4 with the 1 deploys left there, against a threat of 52\)\./,
    );
  });
  it('a conceded border the leftover holds after all, in the same plan, does not shift the restatement onto another warning', () => {
    // T9 (1 army) faces player 20's 8 on T10: conceded in triage (its warning pushed before 4e),
    // then held after all by the leftover, which splices that warning out before the restatement.
    const map2 = makeMap(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      [[1, 2], [1, 3], [2, 3], [1, 4], [2, 4], [2, 5], [3, 5], [3, 6], [4, 7], [4, 8], [9, 6], [9, 10]],
      [[100, 3, [1, 2, 3, 5]]],
    );
    const b2 = board([mine(1, 13), mine(2, 32), neutral(3, 12), enemy(4, 22), mine(5, 0), mine(6, 0), enemy(7, 5, B), enemy(8, 3), mine(9, 1), enemy(10, 8)], true);
    const p = planTurn({
      graph: buildGraph(map2),
      board: b2,
      me: ME,
      income: 18,
      settings: LOW,
      turn: 13,
      game: { players: [{ id: ME }, { id: A }, { id: B }], turn: 13, fog: 'Foggy' },
      options: { adapt: true, enemyDeploy: 30 },
    });
    expect(p.rationale.join('\n')).toMatch(/Hold T9 \(#9\) after all \(not conceded\)/);
    const still = p.warnings.filter((w) => w.startsWith('Standing still:'));
    expect(still).toHaveLength(1);
    expect(still[0]).toMatch(/the plan stages on T2 \(#2\) toward it/);
    // Every other warning survives: the restatement replaced only its own.
    expect(p.warnings.some((w) => w.startsWith('T9 (#9) (1 armies) could be taken next turn'))).toBe(true);
    expect(p.warnings.some((w) => w.startsWith('Enemy deploy estimate'))).toBe(true);
  });
});
