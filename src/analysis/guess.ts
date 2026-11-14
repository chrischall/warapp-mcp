// The border guess: a randomized deploy split for when no fixed split holds.
//
// One opponent touches two or more of my borders. The deploys the plan spends on those borders
// cannot hold all of them against "its stacks + its whole deploy", so the opponent picks which
// border to hit: a fixed (predictable) split loses the border it always leaves short. A split
// drawn at random, weighted by what each border is worth, cuts the expected loss (the security
// game of docs/STRATEGY.md "Guessing at a border").
//
// The model: the opponent attacks every border with the stacks beside it, and lands its whole
// deploy next to one border (its choice). I fund each border at one of its threshold levels: what
// planned moves out of it need, what holds the stacks alone, what holds the stacks plus the
// deploy (anything between two levels is wasted under exact combat). A border that falls costs
// its worth: 1, plus the value of every bonus I hold in full that contains it, plus 100 when my
// commander stands there. The best fixed split is the maximin; the mixed value is the exact
// value of the matrix game (a small simplex over the allocations × targets matrix).
//
// Only the deploys the plan puts on these borders are redistributed (`budget`): expansion and
// every other order of the plan are untouched. Pure and deterministic (ties on ascending id),
// no I/O; the sample is drawn from a caller's seed with mulberry32.

import type { BoardState, TerritoryState } from '../board.js';
import { bonusTerritories } from './bonuses.js';
import { armiesToTake, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE, luckFraction, specialUnitStrength } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import { alliesOf, type PlannedDeploy, type PlannerSettings, type TurnPlan } from './planner.js';
import type { ProfilePlayer } from './profile.js';

/** A guess is emitted only when the mix beats the best fixed split by this share of the worth at stake. */
export const MIN_GUESS_GAIN = 0.05;
/** A border with my commander on it is worth this much more (losing it can lose the game). */
export const COMMANDER_WORTH = 100;
/** At most this many borders (the allocations grow as 3^borders). */
export const MAX_GUESS_BORDERS = 7;

/** What of the plan the guess reads: its deploys, its moves (out of a border) and its enemy deploy. */
export interface GuessPlan {
  deploys: readonly PlannedDeploy[];
  moves: readonly Pick<TurnPlan['moves'][number], 'from' | 'to' | 'armies'>[];
  /** The plan's enemy deploy (its largest estimate): the fallback when no per-opponent estimate is given. */
  enemyDeploy: number;
}

export interface GuessInput {
  graph: MapGraph;
  board: BoardState;
  me: number;
  settings?: PlannerSettings;
  plan: GuessPlan;
  /** The per-opponent deploy estimates the plan worked from (`planEnemyEstimates`). */
  estimates?: readonly { playerId: number; estimate: number }[];
  /** An explicit enemy deploy (the caller's `enemy_deploy`): overrides every estimate. */
  enemyDeploy?: number;
  /** The game's players, for teams: a teammate is never an opponent. */
  players?: readonly ProfilePlayer[];
  /** Seeds the sample (e.g. {@link guessSeed}). */
  seed: number;
}

export interface GuessBorder {
  id: number;
  /** 1 + the bonuses I hold in full containing it + {@link COMMANDER_WORTH} with my commander there. */
  worth: number;
  /** Armies on it now. */
  armies: number;
  /** Armies the plan's moves take out of it. */
  movedOut: number;
  /** The least armies (after deploys and moves out) the opponent's stacks alone cannot take. */
  holdAlone: number;
  /** The least armies its stacks plus its whole deploy cannot take. */
  holdFull: number;
  /** The plan's deploy here. */
  planDeploy: number;
  /** The sampled deploy here. */
  guessDeploy: number;
  /** The chance the mix funds it to `holdFull` (it holds wherever the deploy lands). */
  holdProbability: number;
  /** The chance it holds at least the stacks alone. */
  holdAloneProbability: number;
}

export interface BorderGuess {
  kind: 'guess';
  opponent: number;
  /** The opponent's deploy the model assumed. */
  enemyDeploy: number;
  /** The armies the plan deploys on these borders: all the guess redistributes. */
  budget: number;
  borders: GuessBorder[];
  /** The sum of the borders' worth. */
  worthAtStake: number;
  /** The best fixed split's worst case. */
  fixedLoss: number;
  /** The mix's expected loss against the opponent's best reply. */
  mixedLoss: number;
  /** The plan's own split's worst case. */
  planLoss: number;
  /** The opponent's equilibrium target mix, by border id (where its deploy is worth landing). */
  targets: { id: number; probability: number }[];
  /** The mix: each allocation (per border, in `borders` order) with its probability. */
  mix: { allocation: number[]; probability: number }[];
  /** The sampled allocation, per border in `borders` order. */
  allocation: number[];
  /** The plan's deploys with those on these borders replaced by the sample (same total), sorted by id. */
  deploys: PlannedDeploy[];
}

export type GuessSkipReason =
  | 'no-contact'
  | 'several-opponents'
  | 'luck'
  | 'local-deployment'
  | 'no-split'
  | 'one-border'
  | 'too-many-borders'
  | 'fixed-split-holds'
  | 'small-gain';

export interface GuessSkipped {
  kind: 'skipped';
  reason: GuessSkipReason;
  message: string;
}

export type GuessResult = BorderGuess | GuessSkipped;

const byNum = (a: number, b: number) => a - b;
const skip = (reason: GuessSkipReason, message: string): GuessSkipped => ({ kind: 'skipped', reason, message });
const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** A 32-bit seed from a game id and a turn (FNV-1a): re-planning a turn draws the same sample. */
export function guessSeed(gameId: number, turn: number | null, salt = ''): number {
  // The salt is a local secret (src/guess-salt.ts): without it, anyone who reads this public code
  // could reproduce the draw from the game id and turn.
  const text = `warapp-guess:${salt}:${gameId}:${turn ?? 'none'}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** mulberry32: a small deterministic PRNG, one draw in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The exact value of a zero-sum matrix game where the row player minimises `loss[a][j]`:
 * its optimal mix `x`, the column player's optimal mix `q` and the value. Solved as the LP
 * max Σw s.t. (C − loss)·w ≤ 1, w ≥ 0 (C makes every payoff positive) by a dense tableau simplex
 * with Bland's rule; the row mix is read from the slacks' reduced costs.
 */
export function solveLossGame(loss: readonly (readonly number[])[]): { value: number; x: number[]; q: number[] } {
  const n = loss.length;
  const k = loss[0]?.length ?? 0;
  if (n === 0 || k === 0) return { value: 0, x: [], q: [] };
  const C = Math.max(...loss.flat()) + 1;
  const width = k + n + 1;
  const rhs = k + n;
  const T: Float64Array[] = [];
  for (let a = 0; a < n; a++) {
    const row = new Float64Array(width);
    for (let j = 0; j < k; j++) row[j] = C - loss[a]![j]!;
    row[k + a] = 1;
    row[rhs] = 1;
    T.push(row);
  }
  const obj = new Float64Array(width);
  for (let j = 0; j < k; j++) obj[j] = -1;
  const basis = Array.from({ length: n }, (_, a) => k + a);
  const EPS = 1e-12;
  for (let iter = 0; iter < 10_000; iter++) {
    let e = -1;
    for (let c = 0; c < rhs; c++)
      if (obj[c]! < -EPS) {
        e = c;
        break;
      }
    if (e < 0) break;
    let r = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const v = T[i]![e]!;
      if (v <= EPS) continue;
      const ratio = T[i]![rhs]! / v;
      if (ratio < best - EPS || (Math.abs(ratio - best) <= EPS && basis[i]! < basis[r]!)) {
        best = ratio;
        r = i;
      }
    }
    if (r < 0) break; // unbounded: impossible with positive payoffs
    const pr = T[r]!;
    const pv = pr[e]!;
    for (let c = 0; c < width; c++) pr[c] = pr[c]! / pv;
    for (let i = 0; i < n; i++) {
      if (i === r) continue;
      const row = T[i]!;
      const f = row[e]!;
      if (f !== 0) for (let c = 0; c < width; c++) row[c] = row[c]! - f * pr[c]!;
    }
    const f = obj[e]!;
    for (let c = 0; c < width; c++) obj[c] = obj[c]! - f * pr[c]!;
    basis[r] = e;
  }
  const V = obj[rhs]!;
  const vB = 1 / V;
  const w = new Array<number>(k).fill(0);
  basis.forEach((b, i) => {
    if (b < k) w[b] = T[i]![rhs]!;
  });
  const clean = (xs: number[]) => {
    const ys = xs.map((v) => (v > 1e-9 ? v : 0));
    const s = ys.reduce((a, b) => a + b, 0);
    return ys.map((v) => v / s);
  };
  const x = clean(Array.from({ length: n }, (_, a) => obj[k + a]! * vB));
  const q = clean(w.map((v) => v * vB));
  // The value of the cleaned mix against the best reply (never below the LP's).
  const value = Math.max(...Array.from({ length: k }, (_, j) => x.reduce((acc, p, a) => acc + p * loss[a]![j]!, 0)));
  return { value, x, q };
}

/**
 * The border guess for a planned turn, or why there is none. See the file header for the model.
 */
export function borderGuess(input: GuessInput): GuessResult {
  const { graph: g, board, me, plan } = input;
  const s = input.settings ?? {};
  if (luckFraction(s.luckModifier) > 0 || s.roundingMode === 'WeightedRandom')
    return skip('luck', 'Battles have luck or weighted rounding here, so hold levels are not exact.');
  if (s.localDeployments === true)
    return skip('local-deployment', 'Local Deployment is on: deploys cannot move freely between these borders.');
  const rates = { offensiveKillRate: s.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE, defensiveKillRate: s.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE };
  const guard = (s.oneArmyStandsGuard ?? true) ? 1 : 0;
  const allies = alliesOf(me, input.players);
  const state = new Map<number, TerritoryState>();
  for (const t of board.territories) if (g.territoryById.has(t.territoryId)) state.set(t.territoryId, t);
  const ownerOf = (id: number) => {
    const t = state.get(id);
    return t?.owner.kind === 'player' ? t.owner.playerId : null;
  };
  const foe = (p: number | null): p is number => p !== null && p !== me && !allies.has(p);
  /** A foe's territory with its armies shown. */
  const foeStack = (id: number) => foe(ownerOf(id)) && state.get(id)!.armies !== null;
  const mine = [...state.values()].filter((t) => ownerOf(t.territoryId) === me).map((t) => t.territoryId).sort(byNum);
  const mineSet = new Set(mine);

  const opponents = new Set<number>();
  for (const t of mine) for (const n of neighborsOf(g, t)) if (foeStack(n)) opponents.add(ownerOf(n)!);
  if (opponents.size === 0) return skip('no-contact', 'No opponent stack is in sight next to my territories.');
  if (opponents.size > 1)
    return skip('several-opponents', `${opponents.size} opponents touch my borders: the guess models one opponent with one deploy.`);
  const opp = [...opponents][0]!;
  const D = Math.max(0, Math.floor(input.enemyDeploy ?? input.estimates?.find((e) => e.playerId === opp)?.estimate ?? plan.enemyDeploy));

  const ids = mine.filter((t) => neighborsOf(g, t).some((n) => foeStack(n) && ownerOf(n) === opp));
  if (ids.length < 2) return skip('one-border', 'The opponent touches only one of my territories: there is nothing to guess between.');
  if (ids.length > MAX_GUESS_BORDERS)
    return skip('too-many-borders', `The opponent touches ${ids.length} of my territories (at most ${MAX_GUESS_BORDERS} are modelled).`);

  const held = g.map.bonuses.filter((b) => {
    if (b.value <= 0) return false;
    const ts = bonusTerritories(g, b.id);
    return ts.length > 0 && ts.every((t) => mineSet.has(t));
  });
  const planDeploy = new Map<number, number>();
  for (const d of plan.deploys) planDeploy.set(d.territoryId, (planDeploy.get(d.territoryId) ?? 0) + d.armies);
  if (s.noSplit === true && plan.moves.some((m) => ids.includes(m.from)))
    return skip('no-split', 'No-Split is on and the plan moves a whole stack out of one of these borders.');

  /** Least defenders (armies + unit strength) that `attack` armies cannot take. */
  const need = (attack: number) => {
    let d = 0;
    while ((armiesToTake(d, rates) ?? Infinity) <= attack) d++;
    return d;
  };
  const borders = ids.map((id) => {
    const t = state.get(id)!;
    const armies = t.armies ?? 0;
    const myUnits = (t.specialUnits ?? []).filter((u) => u.playerId === me);
    const strength = specialUnitStrength(myUnits);
    const stack = neighborsOf(g, id)
      .filter((n) => foeStack(n) && ownerOf(n) === opp)
      .reduce((a, n) => {
        const nt = state.get(n)!;
        const units = (nt.specialUnits ?? []).filter((u) => u.playerId === opp);
        return a + Math.max(0, (nt.armies ?? 0) - guard) + specialUnitStrength(units);
      }, 0);
    const worth =
      1 +
      held.filter((b) => bonusTerritories(g, b.id).includes(id)).reduce((a, b) => a + b.value, 0) +
      (myUnits.some((u) => u.kind === 'commander') ? COMMANDER_WORTH : 0);
    // The least deploy that keeps every planned move out of it valid (each move counting the
    // armies moved in earlier in the list, as warapp_submit_turn checks it).
    let running = armies;
    let minDeploy = 0;
    let movedOut = 0;
    for (const m of plan.moves) {
      if (m.to === id) running += m.armies;
      if (m.from === id) {
        running -= m.armies;
        movedOut += m.armies;
        minDeploy = Math.max(minDeploy, guard - running);
      }
    }
    return {
      id,
      worth,
      armies,
      movedOut,
      base: armies - movedOut,
      minDeploy,
      holdAlone: Math.max(0, need(stack) - strength),
      holdFull: Math.max(0, need(stack + D) - strength),
      planDeploy: planDeploy.get(id) ?? 0,
    };
  });
  const k = borders.length;
  const budget = borders.reduce((a, b) => a + b.planDeploy, 0);
  const richest = borders.reduce((best, b, i) => (b.worth > borders[best]!.worth ? i : best), 0);

  // Allocations: each border at one of its distinct levels within the budget, the rest on the richest.
  const levels = borders.map((b) =>
    [...new Set([b.minDeploy, Math.max(b.minDeploy, b.holdAlone - b.base), Math.max(b.minDeploy, b.holdFull - b.base)])].sort(byNum),
  );
  const seen = new Set<string>();
  const allocs: number[][] = [];
  const rec = (i: number, acc: number[], spent: number) => {
    if (i === k) {
      const a = [...acc];
      a[richest] = a[richest]! + (budget - spent);
      const key = a.join(',');
      if (!seen.has(key)) {
        seen.add(key);
        allocs.push(a);
      }
      return;
    }
    for (const c of levels[i]!) if (spent + c <= budget) rec(i + 1, [...acc, c], spent + c);
  };
  rec(0, [], 0);
  const lossOf = (alloc: readonly number[], j: number) =>
    borders.reduce((a, b, i) => a + (b.base + alloc[i]! < (i === j ? b.holdFull : b.holdAlone) ? b.worth : 0), 0);
  const worst = (alloc: readonly number[]) => Math.max(...borders.map((_, j) => lossOf(alloc, j)));
  const planAlloc = borders.map((b) => b.planDeploy);
  const planLoss = worst(planAlloc);
  if (allocs.length === 0) allocs.push(planAlloc);
  const M = allocs.map((a) => borders.map((_, j) => lossOf(a, j)));
  const fixedLoss = Math.min(...M.map((row) => Math.max(...row)));
  if (fixedLoss === 0)
    return skip('fixed-split-holds', 'A fixed split of the deploys on these borders holds every one of them: no need to guess.');

  // Drop dominated allocations (another loses no more against every target); the first of equals stays.
  const keep: number[] = [];
  for (let a = 0; a < M.length; a++) {
    const dominated = M.some((row, b) => b !== a && row.every((v, j) => v <= M[a]![j]!) && (row.some((v, j) => v < M[a]![j]!) || b < a));
    if (!dominated) keep.push(a);
  }
  const { value, x, q } = solveLossGame(keep.map((a) => M[a]!));
  const worthAtStake = borders.reduce((a, b) => a + b.worth, 0);
  if (fixedLoss - value < MIN_GUESS_GAIN * worthAtStake)
    return skip(
      'small-gain',
      `Mixing would cut the expected loss only from ${fixedLoss} to ${round(value)} of ${worthAtStake} at stake: the fixed split is as good.`,
    );

  const mix = keep.map((a, i) => ({ allocation: allocs[a]!, probability: round(x[i]!) })).filter((m) => m.probability > 0);
  const draw = mulberry32(input.seed)();
  let acc = 0;
  let pick = mix[mix.length - 1]!;
  const totalP = mix.reduce((a, m) => a + m.probability, 0);
  for (const m of mix) {
    acc += m.probability / totalP;
    if (draw < acc) {
      pick = m;
      break;
    }
  }
  const allocation = pick.allocation;
  const prob = (test: (alloc: number[], i: number) => boolean, i: number) =>
    round(mix.reduce((a, m) => a + (test(m.allocation, i) ? m.probability : 0), 0) / totalP);
  const onBorders = new Set(ids);
  const deploys = new Map<number, number>();
  for (const d of plan.deploys) if (!onBorders.has(d.territoryId)) deploys.set(d.territoryId, (deploys.get(d.territoryId) ?? 0) + d.armies);
  borders.forEach((b, i) => {
    if (allocation[i]! > 0) deploys.set(b.id, allocation[i]!);
  });
  return {
    kind: 'guess',
    opponent: opp,
    enemyDeploy: D,
    budget,
    borders: borders.map((b, i) => ({
      id: b.id,
      worth: b.worth,
      armies: b.armies,
      movedOut: b.movedOut,
      holdAlone: b.holdAlone,
      holdFull: b.holdFull,
      planDeploy: b.planDeploy,
      guessDeploy: allocation[i]!,
      holdProbability: prob((a, j) => b.base + a[j]! >= b.holdFull, i),
      holdAloneProbability: prob((a, j) => b.base + a[j]! >= b.holdAlone, i),
    })),
    worthAtStake,
    fixedLoss,
    mixedLoss: round(value),
    planLoss,
    targets: borders.map((b, j) => ({ id: b.id, probability: round(q[j] ?? 0) })),
    mix,
    allocation,
    deploys: [...deploys].sort((a, b) => a[0] - b[0]).map(([territoryId, armies]) => ({ territoryId, armies })),
  };
}
