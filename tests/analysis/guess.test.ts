// The border guess: one opponent, one deploy, two or more of my borders it touches. When no fixed
// split of the deploys the plan spends on those borders holds them all, a split drawn at random
// (weighted by what each border is worth) cuts the expected loss. Synthetic maps only.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { borderGuess, guessSeed, solveLossGame, MIN_GUESS_GAIN, type GuessInput, type GuessPlan } from '../../src/analysis/guess.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;
const OTHER = 30;
const STD = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };

function makeMap(n: number, edges: [number, number][], bonuses: [number, number, number[]][] = []): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
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

const foe = (id: number, armies: number, player = FOE): TerritoryState => mine(id, armies, player);

/**
 * My borders 1 and 2 both touch the foe's 3; 4 is mine behind them, 5 a neutral beside 2.
 * The foe's 5 armies move 4 (the guard stays); with its deploy of 5 they attack with 9.
 * At 60/70, 4 attackers take up to 2 defenders and 9 take up to 5: 3 hold the stack alone,
 * 6 hold the stack plus the deploy.
 */
const EDGES: [number, number][] = [
  [1, 3],
  [2, 3],
  [1, 4],
  [2, 4],
  [2, 5],
];
const TWO = makeMap(5, EDGES);
const START = [mine(1, 3), mine(2, 3), foe(3, 5), mine(4, 1), neutral(5, 2)];
/** The plan: 3 on border 1 (holds it whatever comes), 2 behind on 4. */
const PLAN: GuessPlan = {
  deploys: [
    { territoryId: 1, armies: 3 },
    { territoryId: 4, armies: 2 },
  ],
  moves: [],
  enemyDeploy: 5,
};

function guess(over: Partial<GuessInput> = {}, map: GameMap = TWO, entries: TerritoryState[] = START) {
  return borderGuess({
    graph: buildGraph(map),
    board: board(entries),
    me: ME,
    settings: STD,
    plan: PLAN,
    seed: 1,
    ...over,
  });
}

function must(r: ReturnType<typeof guess>) {
  if (r.kind !== 'guess') throw new Error(`expected a guess, got ${r.reason}: ${r.message}`);
  return r;
}

const total = (ds: readonly { armies: number }[]) => ds.reduce((a, d) => a + d.armies, 0);

describe('borderGuess', () => {
  it('two equal borders, a budget that holds one: a coin flip that halves the loss', () => {
    const g = must(guess());
    expect(g.opponent).toBe(FOE);
    expect(g.enemyDeploy).toBe(5);
    expect(g.budget).toBe(3);
    expect(g.borders.map((b) => b.id)).toEqual([1, 2]);
    for (const b of g.borders) {
      expect(b).toMatchObject({ worth: 1, armies: 3, holdAlone: 3, holdFull: 6 });
      expect(b.holdProbability).toBeCloseTo(0.5, 6);
    }
    expect(g.fixedLoss).toBe(1);
    expect(g.planLoss).toBe(1);
    expect(g.mixedLoss).toBeCloseTo(0.5, 6);
    expect(g.worthAtStake).toBe(2);
    // The sampled split puts all 3 on one border.
    expect([...g.allocation].sort()).toEqual([0, 3]);
  });

  it('unequal worth: the worthier border is funded more often', () => {
    // Bonus 100 (+1) is 1 and 4, both mine: border 1 is worth 2, border 2 worth 1.
    const map = makeMap(5, EDGES, [[100, 1, [1, 4]]]);
    const g = must(guess({}, map));
    const [b1, b2] = g.borders;
    expect(b1!.worth).toBe(2);
    expect(b2!.worth).toBe(1);
    // Indifference: 2·(1 − p) = p → p = 2/3.
    expect(b1!.holdProbability).toBeCloseTo(2 / 3, 6);
    expect(b2!.holdProbability).toBeCloseTo(1 / 3, 6);
    expect(g.fixedLoss).toBe(1);
    expect(g.mixedLoss).toBeCloseTo(2 / 3, 6);
  });

  it('no guess when a fixed split holds every border', () => {
    const r = guess({
      plan: { ...PLAN, deploys: [{ territoryId: 1, armies: 3 }, { territoryId: 2, armies: 3 }] },
    });
    expect(r).toMatchObject({ kind: 'skipped', reason: 'fixed-split-holds' });
  });

  it("my commander's defence counts: it holds its border alone, so a fixed split holds everything", () => {
    const withCommander = START.map((t) => (t.territoryId === 2 ? { ...t, specialUnits: [{ kind: 'commander' as const, id: 'c', playerId: ME }] } : t));
    const r = guess({}, TWO, withCommander);
    expect(r).toMatchObject({ kind: 'skipped', reason: 'fixed-split-holds' });
  });

  it('skips several opponents, with the reason', () => {
    const r = guess({}, TWO, [...START.slice(0, 4), foe(5, 4, OTHER)]);
    expect(r).toMatchObject({ kind: 'skipped', reason: 'several-opponents' });
    expect(r.kind === 'skipped' && r.message).toMatch(/2 opponents touch my borders/);
  });

  it('a teammate next to my border is never an opponent', () => {
    const r = guess({ players: [{ id: ME, team: 1 }, { id: FOE, team: 2 }, { id: OTHER, team: 1 }] }, TWO, [
      ...START.slice(0, 4),
      foe(5, 4, OTHER),
    ]);
    expect(r.kind).toBe('guess');
  });

  it('skips luck, weighted rounding and Local Deployment', () => {
    expect(guess({ settings: { ...STD, luckModifier: 0.16 } })).toMatchObject({ kind: 'skipped', reason: 'luck' });
    expect(guess({ settings: { ...STD, roundingMode: 'WeightedRandom' } })).toMatchObject({ kind: 'skipped', reason: 'luck' });
    expect(guess({ settings: { ...STD, localDeployments: true } })).toMatchObject({ kind: 'skipped', reason: 'local-deployment' });
  });

  it('skips a single border and no contact', () => {
    const one = makeMap(5, [
      [1, 3],
      [1, 4],
      [2, 4],
      [2, 5],
    ]);
    expect(guess({}, one)).toMatchObject({ kind: 'skipped', reason: 'one-border' });
    expect(guess({}, TWO, [mine(1, 3), mine(2, 3), neutral(3, 2), mine(4, 1), neutral(5, 2)])).toMatchObject({
      kind: 'skipped',
      reason: 'no-contact',
    });
  });

  it('skips when mixing gains too little', () => {
    // Worth 20 against 1: funding the big border always is within a few percent of the mix.
    const map = makeMap(5, EDGES, [[100, 19, [1, 4]]]);
    const r = guess({}, map);
    expect(r).toMatchObject({ kind: 'skipped', reason: 'small-gain' });
    expect(MIN_GUESS_GAIN).toBeGreaterThan(0);
  });

  it('keeps the deploy total, and touches only the deploys on these borders', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const g = must(guess({ seed }));
      expect(total(g.deploys)).toBe(total(PLAN.deploys));
      expect(g.deploys.find((d) => d.territoryId === 4)).toEqual({ territoryId: 4, armies: 2 });
      expect(g.deploys.every((d) => d.armies > 0)).toBe(true);
      expect(g.deploys.map((d) => d.territoryId)).toEqual([...g.deploys.map((d) => d.territoryId)].sort((a, b) => a - b));
    }
  });

  it('is deterministic for a seed, and different seeds can differ', () => {
    expect(guess({ seed: 7 })).toEqual(guess({ seed: 7 }));
    const seen = new Set<string>();
    for (let seed = 1; seed <= 30; seed++) seen.add(JSON.stringify(must(guess({ seed })).allocation));
    expect(seen.size).toBe(2);
  });

  it('never deploys below what a planned move out of a border needs', () => {
    // The plan deploys 4 on border 1 and moves 4 of its 7 to 4: border 1 needs at least 2 deployed.
    const plan: GuessPlan = {
      deploys: [
        { territoryId: 1, armies: 4 },
        { territoryId: 2, armies: 3 },
      ],
      moves: [{ from: 1, to: 4, armies: 4 }],
      enemyDeploy: 5,
    };
    const seen = new Set<number>();
    for (let seed = 1; seed <= 20; seed++) {
      const r = must(guess({ plan, seed }));
      const on1 = r.deploys.find((d) => d.territoryId === 1)?.armies ?? 0;
      expect(on1).toBeGreaterThanOrEqual(2);
      seen.add(on1);
      expect(total(r.deploys)).toBe(7);
    }
    // Either 7 on border 1 (it holds everything, 2 holds the stack) or 4 and 3 (the other way round).
    expect([...seen].sort()).toEqual([4, 7]);
  });

  it("uses the opponent's own estimate over the plan's largest, and an explicit enemy_deploy over both", () => {
    // Estimated at 0: 4 attack, 3 defenders hold it whatever comes — nothing to guess.
    expect(guess({ estimates: [{ playerId: FOE, estimate: 0 }] })).toMatchObject({ kind: 'skipped', reason: 'fixed-split-holds' });
    expect(must(guess({ estimates: [{ playerId: FOE, estimate: 0 }], enemyDeploy: 5 })).enemyDeploy).toBe(5);
  });

  it('seven equal borders, a budget that fully holds five: each held 5/7 of the time', () => {
    // The foe's 8 touches my 1..7; each of mine has 3 (holds the stack alone), 3 more hold it all.
    const map = makeMap(8, [1, 2, 3, 4, 5, 6, 7].map((t) => [t, 8] as [number, number]));
    const entries = [...[1, 2, 3, 4, 5, 6, 7].map((t) => mine(t, 3)), foe(8, 5)];
    const plan: GuessPlan = { deploys: [{ territoryId: 1, armies: 15 }], moves: [], enemyDeploy: 5 };
    const started = Date.now();
    const g = must(guess({ plan }, map, entries));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(g.fixedLoss).toBe(1);
    expect(g.mixedLoss).toBeCloseTo(2 / 7, 6);
    for (const b of g.borders) expect(b.holdProbability).toBeCloseTo(5 / 7, 6);
    expect(total(g.deploys)).toBe(15);
  });

  it('guessSeed is stable per game and turn', () => {
    expect(guessSeed(123, 4)).toBe(guessSeed(123, 4));
    expect(guessSeed(123, 4)).not.toBe(guessSeed(123, 5));
    expect(Number.isInteger(guessSeed(123, null))).toBe(true);
  });
});

describe('solveLossGame', () => {
  it('solves known games exactly', () => {
    const pennies = solveLossGame([
      [1, 0],
      [0, 1],
    ]);
    expect(pennies.value).toBeCloseTo(0.5, 9);
    expect(pennies.x[0]).toBeCloseTo(0.5, 9);
    // Rock-paper-scissors as losses 0/1/2: uniform, value 1.
    const rps = solveLossGame([
      [1, 2, 0],
      [0, 1, 2],
      [2, 0, 1],
    ]);
    expect(rps.value).toBeCloseTo(1, 9);
    for (const p of [...rps.x, ...rps.q]) expect(p).toBeCloseTo(1 / 3, 9);
    // A dominant row: a pure answer.
    const pure = solveLossGame([
      [3, 3],
      [1, 2],
    ]);
    expect(pure.value).toBeCloseTo(2, 9);
    expect(pure.x).toEqual([0, 1]);
  });

  it('matches a brute-force grid on random games with two targets', () => {
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 50; trial++) {
      const rows = 2 + Math.floor(rnd() * 6);
      const M = Array.from({ length: rows }, () => [Math.floor(rnd() * 10), Math.floor(rnd() * 10)]);
      const r = solveLossGame(M);
      // The column player's side: max over q of min over rows, on a fine grid (a lower bound within 10/2000).
      let lower = -Infinity;
      for (let i = 0; i <= 2000; i++) {
        const q = i / 2000;
        lower = Math.max(lower, Math.min(...M.map((row) => q * row[0]! + (1 - q) * row[1]!)));
      }
      expect(r.value).toBeGreaterThanOrEqual(lower - 1e-9);
      expect(r.value).toBeLessThanOrEqual(lower + 10 / 2000 + 1e-9);
      expect(r.x.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    }
  });
});
