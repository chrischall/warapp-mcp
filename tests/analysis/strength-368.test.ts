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
