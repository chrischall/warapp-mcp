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
import { symmetricStart, unevenStart, type OpponentTrack } from '../../src/analysis/opponents.js';
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

/** A hand-built track: `turns` consecutive observed turns ending at turn 11, income `income`. */
function track(playerId: number, income: number, turns: number, visibleIncome = 10): OpponentTrack {
  const t = { from: 0, to: 1, observed: income, raw: income, cap: income, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome, earned: income, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: income, high: income, reinforced: [], grewFromFog: [], emptied: [], combat: 0 };
  const list = Array.from({ length: turns }, (_, i) => ({ ...t, from: 11 - turns + i, to: 12 - turns + i }));
  return {
    playerId,
    firstSeen: 1,
    lastTurn: 12,
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

  it('in an FFA, a prior not applied says why: a player out', () => {
    const out = [...players, { id: 50, state: 'Eliminated' }];
    const p = planTurn(ffa({ game: { players: out, turn: 12, symmetricStart: true } }));
    expect(p.warnings.join('\n')).toMatch(/No fog prior for the opponents beside the fog \(players 20, 30\) in this free-for-all: player 50 is out \(Eliminated\)/);
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

describe('(1) a tracked figure below the newest turn read with it does not stand alone', () => {
  // Player A's T5 grew 20 → 120 beside the fog (no visible neighbour of its own shrank): ambiguous
  // (#123), read as deploy up to twice what it was expected to deploy. The track (two observed
  // turns) says 20; the newest turn, read against that, says more.
  const before = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 20), enemy(6, 30, B), neutral(30, 2), ...fog]);
  const now = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 120), enemy(6, 30, B), neutral(30, 2), ...fog]);

  it('the estimate is at least the newest observed turn, labelled with both figures', () => {
    const [a] = enemyDeployEstimates(g, now, ME, STD, before, [track(A, 20, 2)]);
    expect(a).toMatchObject({ playerId: A, tracked: 20, observed: 40, estimate: 40, source: 'observed' });
    const p = planTurn(ffa({ board: now, previousBoard: before, tracks: [track(A, 20, 2)], game: { players, turn: 12, symmetricStart: false } }));
    expect(p.warnings.join('\n')).toMatch(
      /Enemy deploy estimate for player 20: ~40 \(observed \+40 on the newest turn, read against its tracked income, above its tracked ~20 over 2 observed turns\)/,
    );
  });

  it('a newest turn below the track leaves the track standing', () => {
    const quiet = board([mine(1, 40), mine(2, 3), mine(3, 3), mine(4, 40), enemy(5, 25), enemy(6, 30, B), neutral(30, 2), ...fog]);
    const [a] = enemyDeployEstimates(g, quiet, ME, STD, before, [track(A, 20, 2)]);
    expect(a).toMatchObject({ tracked: 20, estimate: 20, source: 'tracked' });
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
});
