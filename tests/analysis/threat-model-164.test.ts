// Issue #164: the threat model's fog gaps, each on a synthetic map (every id and name is made up).
//  - income is exact when the fog shows every owner (No, Light and Dense fog);
//  - an enemy territory next to me whose armies the fog hides is a threat of a bounded size;
//  - an opponent's Reinforcement card, from the card clock, until a deployment above its income is seen;
//  - a large stack that left view, from its last sighting, at each border it can reach.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { trackOpponents, type OpponentTrack } from '../../src/analysis/opponents.js';
import { enemyDeployEstimates, planTurn, type PlannerSettings } from '../../src/analysis/planner.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Fogland',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const foe = (territoryId: number, armies: number, playerId = FOE): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
/** A territory whose owner shows and whose armies the fog hides (Dense / Heavy fog). */
const ownerOnly = (territoryId: number, playerId = FOE): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies: null,
  fogLevel: 'OwnerOnly',
});
const why = (p: { rationale: string[]; warnings: string[] }) => [...p.rationale, ...p.warnings].join('\n');
const deployedTo = (p: { deploys: { territoryId: number; armies: number }[] }, id: number) =>
  p.deploys.find((d) => d.territoryId === id)?.armies ?? 0;

/** A hand-built track (observed over two turns) with `unexplained` armies and, optionally, stacks that left view. */
function track(playerId: number, o: { income?: number; unexplained?: number | null; lostStacks?: OpponentTrack['lostStacks']; turns?: OpponentTrack['turns'] } = {}): OpponentTrack {
  const income = o.income ?? 5;
  const turn = { from: 0, to: 1, observed: income, raw: income, cap: income, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome: income, earned: income, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: income, high: income, reinforced: [], grewFromFog: [], emptied: [], combat: 0 };
  return {
    playerId,
    firstSeen: 1,
    lastTurn: 3,
    turns: o.turns ?? [
      { ...turn, from: 1, to: 2 },
      { ...turn, from: 2, to: 3 },
    ],
    base: income,
    bonusIncome: 0,
    visibleIncome: income,
    income,
    incomeTurns: [1, 2],
    observedRange: { min: income, max: income },
    incomeMethod: 'max-observed',
    incomeLowered: 0,
    unexplained: o.unexplained === undefined ? 0 : o.unexplained,
    inferred: null,
    visible: 1,
    turnsUnseen: 0,
    turnsUnseenAtLeast: false,
    earnedAtLeast: null,
    warnings: [],
    notes: [],
    ...(o.lostStacks ? { lostStacks: o.lostStacks } : {}),
  };
}

describe('income is exact when the fog shows every owner (#164)', () => {
  // 1 2 mine; 3 4 5 6 the opponent's, holding bonus 101 (+4) = 5 6.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6], [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6]], [[101, 4, [5, 6]]]));
  const before = board([mine(1, 5), mine(2, 5), foe(3, 2), foe(4, 2), foe(5, 2), foe(6, 2)]);
  // It grew +15 over territories visible on both boards: more than base 5 + bonus 4.
  const after = board([mine(1, 5), mine(2, 5), foe(3, 10), foe(4, 5), foe(5, 4), foe(6, 4)]);
  const at = (fog: string | undefined, b = after) =>
    enemyDeployEstimates(g, b, ME, STD, before, undefined, undefined, { turn: 6, ...(fog ? { fog } : {}) }).find((e) => e.playerId === FOE)!;

  for (const fog of ['NoFog', 'LightFog', 'ModerateFog'])
    it(`${fog}: the estimate is base + held bonuses exactly, labelled exact, not the observed growth`, () => {
      const e = at(fog);
      expect(e.source).toBe('exact');
      expect(e.exact).toBe(9);
      expect(e.estimate).toBe(9);
    });
  it('under Normal and Heavy fog (and with no fog setting) it is not labelled exact', () => {
    for (const fog of ['Foggy', 'VeryFoggy', 'ExtremeFog', undefined]) {
      const e = at(fog);
      expect(e.source).toBe('visible');
      expect(e.exact).toBeNull();
      expect(e.observedRaw).toBe(15);
    }
  });
  it('exact income takes no floor: a base income below the default stands', () => {
    const e = enemyDeployEstimates(g, after, ME, { ...STD, baseIncome: 2 }, before, undefined, undefined, { turn: 6, fog: 'NoFog' }).find((x) => x.playerId === FOE)!;
    expect(e.estimate).toBe(6);
  });
  it('a board missing an owner (a fogged territory) is not exact, whatever the setting says', () => {
    const partial = board([mine(1, 5), mine(2, 5), foe(3, 10), foe(4, 5), foe(5, 4), fogged(6)]);
    expect(at('LightFog', partial).source).not.toBe('exact');
  });
  it("owner-only territories still count: Dense fog's hidden armies do not stop the income being exact", () => {
    const dense = board([mine(1, 5), mine(2, 5), ownerOnly(3), ownerOnly(4), ownerOnly(5), ownerOnly(6)]);
    const e = enemyDeployEstimates(g, dense, ME, STD, undefined, undefined, undefined, { turn: 6, fog: 'ModerateFog' }).find((x) => x.playerId === FOE)!;
    expect(e.source).toBe('exact');
    expect(e.estimate).toBe(9);
  });
  it('the plan names the exact figure and what it leaves out', () => {
    const plan = planTurn({ graph: g, board: after, previousBoard: before, me: ME, income: 5, settings: STD, turn: 6, game: { turn: 6, fog: 'LightFog' } });
    expect(plan.warnings.join('\n')).toMatch(/player 20: ~9 \(exact: .*every territory's owner shows/);
    expect(plan.warnings.join('\n')).toMatch(/army cap, Sanctions and a Reinforcement card/);
  });
});

describe("an opponent's Reinforcement card, from the card clock (#164)", () => {
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [3, 4]], []));
  const b = board([mine(1, 5), mine(2, 5), foe(3, 4), foe(4, 4)]);
  const clock = { firstTurn: 4, armies: 6, turnsPerCard: 3 };
  const est = (turn: number, tracks?: OpponentTrack[], fog = 'NoFog') =>
    enemyDeployEstimates(g, b, ME, STD, undefined, tracks, undefined, { turn, fog, reinforcement: clock }).find((e) => e.playerId === FOE)!;

  it('before the first turn a card can be in hand, nothing is added', () => {
    const e = est(3);
    expect(e.card).toBeNull();
    expect(e.estimate).toBe(5);
  });
  it('from that turn on, its armies are added to the deploy', () => {
    const e = est(4);
    expect(e.card).toEqual({ armies: 6, due: 4 });
    expect(e.estimate).toBe(11);
    expect(est(9).estimate).toBe(11);
  });
  it('a deployment above its income ends it, until the next card can be due', () => {
    // Turn 5 it deployed 11 (income 5): the card was played. The second card is due on turn 4 + 3.
    const turns: OpponentTrack['turns'] = [4, 5].map((from) => ({
      from, to: from + 1, observed: from === 5 ? 11 : 5, raw: from === 5 ? 11 : 5, cap: 20, counted: [], captured: [], fromFog: [], reveals: [], visibleIncome: 5, earned: 5, net: 0, losses: 0, fogArmies: 0, measured: 0, broken: [], brokenValue: 0, low: from === 5 ? 11 : 5, high: from === 5 ? 11 : 5, reinforced: [], grewFromFog: [], emptied: [], combat: 0,
    }));
    const tr = [track(FOE, { turns })];
    expect(est(6, tr).card).toBeNull();
    expect(est(6, tr).cardPlayed).toBe(5);
    expect(est(7, tr).card).toEqual({ armies: 6, due: 7 });
  });
  it('the plan says where the extra armies come from', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 5, settings: STD, turn: 5, game: { turn: 5, fog: 'NoFog', reinforcement: clock } });
    expect(plan.warnings.join('\n')).toMatch(/Reinforcement card from turn 4 .*\+6/);
  });
});

describe('Dense and Heavy fog: an enemy next to me whose armies are hidden (#164)', () => {
  // 1 2 mine (bonus 101, +6); 3 the opponent's, armies hidden, next to 2; 4 the opponent's behind it.
  const g = buildGraph(makeMap([1, 2, 3, 4], [[1, 2], [2, 3], [3, 4]], [[101, 6, [1, 2]]]));
  const b = board([mine(1, 1), mine(2, 3), ownerOnly(3), ownerOnly(4)]);
  it('it is a threat (its deploy at least), not unseen land: the held bonus is defended', () => {
    const plan = planTurn({ graph: g, board: b, me: ME, income: 10, settings: STD, turn: 6, game: { turn: 6, fog: 'VeryFoggy' }, options: { goal: 'defend' } });
    // 5 deploy + 0 hidden (no track: the guard alone) -> 3 armies need 5 to take: 3 + d must beat 5.
    expect(deployedTo(plan, 2)).toBeGreaterThan(0);
    expect(why(plan)).toMatch(/armies are hidden/);
    expect(why(plan)).toMatch(/win chance .* unknown/);
  });
  it("the tracker's unaccounted armies bound the hidden stack, and the hold is sized for them", () => {
    const small = planTurn({ graph: g, board: b, me: ME, income: 30, settings: STD, turn: 6, game: { turn: 6, fog: 'VeryFoggy' }, tracks: [track(FOE, { unexplained: 0 })], options: { goal: 'defend' } });
    const big = planTurn({ graph: g, board: b, me: ME, income: 30, settings: STD, turn: 6, game: { turn: 6, fog: 'VeryFoggy' }, tracks: [track(FOE, { unexplained: 12 })], options: { goal: 'defend' } });
    expect(why(small)).toMatch(/Deploy 1 to T2 \(#2\) so it holds .*above the ~5 threat/);
    expect(why(big)).toMatch(/Deploy 8 to T2 \(#2\) so it holds .*above the ~17 threat/);
    expect(why(big)).toMatch(/up to 12/);
  });
  it('no attack goes into it: its defenders are unknown', () => {
    const b2 = board([mine(1, 1), mine(2, 40), ownerOnly(3), ownerOnly(4)]);
    const plan = planTurn({ graph: g, board: b2, me: ME, income: 10, settings: STD, turn: 6, game: { turn: 6, fog: 'VeryFoggy' } });
    expect(plan.moves.filter((m) => m.kind === 'attack' && m.to === 3)).toEqual([]);
  });
});

describe('stacks that leave view (#164)', () => {
  // A line: 1 (mine) - 2 - 3 - 4 - 5 - 6; 7 a spare neutral next to 1.
  const g = buildGraph(makeMap([1, 2, 3, 4, 5, 6, 7], [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [1, 7]], [[101, 3, [1, 7]]]));
  it('the tracker keeps a large stack its last territory and turn once it is hidden', () => {
    const seen = board([mine(1, 5), mine(7, 2), neutral(2, 2), neutral(3, 2), foe(4, 3), foe(5, 30), foe(6, 2)]);
    const gone = board([mine(1, 5), mine(7, 2), neutral(2, 2), fogged(3), fogged(4), fogged(5), fogged(6)]);
    const tracks = trackOpponents(g, [
      { turn: 3, board: seen },
      { turn: 4, board: gone },
    ], ME, STD, { players: [{ id: ME }, { id: FOE }] });
    const t = tracks.find((x) => x.playerId === FOE)!;
    expect(t.lostStacks).toEqual([{ territoryId: 5, turn: 3, armies: 30 }]);
  });
  it('a stack seen again (its territory in view) is not lost', () => {
    const seen = board([mine(1, 5), mine(7, 2), neutral(2, 2), neutral(3, 2), foe(4, 3), foe(5, 30), foe(6, 2)]);
    const back = board([mine(1, 5), mine(7, 2), neutral(2, 2), fogged(3), fogged(4), foe(5, 2), fogged(6)]);
    const t = trackOpponents(g, [
      { turn: 3, board: seen },
      { turn: 4, board: back },
    ], ME, STD, { players: [{ id: ME }, { id: FOE }] }).find((x) => x.playerId === FOE)!;
    expect(t.lostStacks).toEqual([]);
  });
  // Now 2 and 3 are fogged: the stack, last seen on 5 on turn 3, is 3 hops from 2 (next to my 1).
  const now = board([mine(1, 5), mine(7, 2), fogged(2), fogged(3), fogged(4), fogged(5), fogged(6)]);
  const lost = [track(FOE, { lostStacks: [{ territoryId: 5, turn: 3, armies: 30 }] })];
  it('before it can arrive, it is no threat', () => {
    // Turn 4: one move since turn 3, it can stand on 4 at most: not next to 1.
    const plan = planTurn({ graph: g, board: now, me: ME, income: 5, settings: STD, turn: 4, game: { turn: 4 }, tracks: lost, options: { goal: 'defend' } });
    expect(why(plan)).not.toMatch(/left view/);
    expect(why(plan)).not.toMatch(/so it holds/);
  });
  it('from its earliest arrival it is a labelled threat on that border', () => {
    // Turn 6: three moves since turn 3, it can stand on 2 and attack 1.
    const plan = planTurn({ graph: g, board: now, me: ME, income: 20, settings: STD, turn: 6, game: { turn: 6 }, tracks: lost, options: { goal: 'defend' } });
    expect(why(plan)).toMatch(/30 armies last seen on T5 \(#5\) on turn 3 left view.*T1 \(#1\) from turn 6/);
    // 29 movable + the ~5 deploy (no estimate for an opponent out of view: the floor).
    expect(why(plan)).toMatch(/~34 threat/);
  });
});
