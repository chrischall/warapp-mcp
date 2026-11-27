// The arena: two bots play a whole 1v1 on a synthetic map, each turn resolved by the turn simulator
// (`simulateTurn`), so a planner change can be judged by games won rather than by plans that differ.
// Research tooling (scripts/arena.mjs runs tournaments); nothing in the server calls it.
//
// The game it plays is the one most of our 1v1s are: no luck, straight rounding, 60/70 kill rates, the
// guard on, base income 5, neutrals of 2 with a few wastelands of 10, three starts of 4 armies each, no
// cards, and (optionally) fog: a player sees its own territories and their neighbours. Move order cycles
// (the first mover alternates every turn). A game ends when a player holds nothing, or at `maxTurns`,
// where the player with the larger income (then armies, then territories) is the winner on points.
//
// Pure and deterministic: the map, the starts and every bot decision come from the seed.
import type { BoardState, TerritoryState } from '../board.js';
import type { Bonus, GameMap, Territory } from '../normalize.js';
import { armiesToTake } from './combat.js';
import { bfsDistances, buildGraph, neighborsOf, type MapGraph } from './graph.js';
import { trackOpponents, type MyOrders, type TurnBoard } from './opponents.js';
import { boardIncome } from './player.js';
import { planTurn, type PlanOptions, type PlannerSettings, type TurnPlan } from './planner.js';
import { simulateTurn, type SimOrder, type SimTerritory } from './turn-sim.js';

/** The rules every arena game is played under. */
export const ARENA_SETTINGS: Readonly<PlannerSettings> = {
  offensiveKillRate: 60,
  defensiveKillRate: 70,
  luckModifier: 0,
  roundingMode: 'StraightRound',
  oneArmyStandsGuard: true,
  baseIncome: 5,
};
const BASE_INCOME = 5;
const NEUTRAL = 2;
const WASTELAND = 10;
const STARTS = 3;
const START_ARMIES = 4;

/** A small deterministic PRNG (mulberry32). */
export class ArenaRng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
}

/**
 * A world-like map: a `w` × `h` grid of territories, each linked to its four neighbours and, at random,
 * a diagonal one, a few links cut (never disconnecting it); bonuses grown as contiguous regions of 2 to 6
 * territories worth their size less one (at least 1); `wastelands` territories start at 10.
 */
export function arenaMap(seed: number, w = 11, h = 10): { map: GameMap; wastelands: number[] } {
  const r = new ArenaRng(seed);
  const id = (x: number, y: number) => 1 + y * w + x;
  const links = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    links.get(a)!.add(b);
    links.get(b)!.add(a);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) links.set(id(x, y), new Set());
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (x + 1 < w) link(id(x, y), id(x + 1, y));
      if (y + 1 < h) link(id(x, y), id(x, y + 1));
      if (x + 1 < w && y + 1 < h && r.next() < 0.35) link(id(x, y), r.next() < 0.5 ? id(x + 1, y + 1) : id(x + 1, y));
      if (x > 0 && y + 1 < h && r.next() < 0.2) link(id(x, y), id(x - 1, y + 1));
    }
  // Cut some links where both ends keep three or more (the grid stays connected: checked below).
  for (const a of [...links.keys()])
    for (const b of [...links.get(a)!])
      if (a < b && r.next() < 0.12 && links.get(a)!.size > 3 && links.get(b)!.size > 3) {
        links.get(a)!.delete(b);
        links.get(b)!.delete(a);
        if (!connected(links)) link(a, b);
      }
  const ids = [...links.keys()].sort((a, b) => a - b);
  const territories: Territory[] = ids.map((t) => ({ id: t, name: `T${t}`, connectedTo: [...links.get(t)!].sort((a, b) => a - b) }));
  // Bonuses: regions grown from random seeds over unassigned territories.
  const owner = new Map<number, number>();
  const bonuses: Bonus[] = [];
  let bid = 1;
  for (const seedT of shuffle(r, ids)) {
    if (owner.has(seedT)) continue;
    const size = r.int(2, 6);
    const members = [seedT];
    owner.set(seedT, bid);
    while (members.length < size) {
      const open = members.flatMap((m) => [...links.get(m)!]).filter((n) => !owner.has(n));
      if (!open.length) break;
      const n = r.pick(open.sort((a, b) => a - b));
      owner.set(n, bid);
      members.push(n);
    }
    bonuses.push({ id: bid, name: `B${bid}`, value: Math.max(1, members.length - 1), territoryIds: members.sort((a, b) => a - b), bonusIds: [] });
    bid++;
  }
  const wastelands = shuffle(r, ids).slice(0, Math.max(1, Math.round(ids.length / 18)));
  return { map: { id: 990000 + (seed % 1000), name: `Arena ${seed}`, territories, bonuses, distributionModes: [] }, wastelands };
}

function connected(links: Map<number, Set<number>>): boolean {
  const ids = [...links.keys()];
  const seen = new Set([ids[0]!]);
  const queue = [ids[0]!];
  while (queue.length)
    for (const n of links.get(queue.shift()!)!)
      if (!seen.has(n)) {
        seen.add(n);
        queue.push(n);
      }
  return seen.size === ids.length;
}

function shuffle<T>(r: ArenaRng, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r.next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** What a bot sees and knows on its turn. */
export interface BotView {
  graph: MapGraph;
  /** Its view of the board (fogged when the game is). */
  board: BoardState;
  me: number;
  /** Its income this turn (base plus the bonuses it holds in full). */
  income: number;
  /** The turn being played, from 1. */
  turn: number;
  /** Its earlier views, oldest first, each with the orders it sent that turn. */
  history: readonly TurnBoard[];
  /** Its income on every earlier turn. */
  incomes: readonly { turn: number; income: number }[];
  /** Both players' ids. */
  players: readonly number[];
  fog: boolean;
}

export interface BotOrders {
  deploys: { territoryId: number; armies: number }[];
  moves: SimOrder[];
}

export interface ArenaBot {
  name: string;
  orders(view: BotView): BotOrders;
}

/** The planner as warapp_plan_turn calls it (adapting, its tracks and income history), with `options` on top. */
export function plannerBot(name: string, options: PlanOptions = {}, onPlan?: (plan: TurnPlan, view: BotView) => void): ArenaBot {
  return {
    name,
    orders(v) {
      const boards = v.history.map((h) => h);
      const tracks = boards.length ? trackOpponents(v.graph, [...boards, { turn: v.turn, board: v.board }], v.me, ARENA_SETTINGS) : undefined;
      const plan = planTurn({
        graph: v.graph,
        board: v.board,
        me: v.me,
        income: v.income,
        turn: v.turn,
        ...(boards.length ? { previousBoard: boards[boards.length - 1]!.board, previousOrders: boards[boards.length - 1]!.orders! } : {}),
        ...(tracks ? { tracks } : {}),
        incomeHistory: v.incomes,
        settings: ARENA_SETTINGS,
        game: {
          players: v.players.map((id) => ({ id })),
          turn: v.turn,
          fog: v.fog ? 'Foggy' : 'NoFog',
          symmetricStart: true,
          cards: false,
        },
        options: { adapt: true, ...options },
      });
      onPlan?.(plan, v);
      return {
        deploys: plan.deploys.map((d) => ({ territoryId: d.territoryId, armies: d.armies })),
        moves: plan.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies })),
      };
    },
  };
}

/**
 * A plain greedy expander, the play our 1v1 opponents showed: every turn it takes as many cheap
 * territories as it can, nearest-to-complete bonus first, with exactly what each needs; it attacks an
 * enemy territory only when the armies beside it are twice what defends it; leftover income goes to the
 * border facing the largest enemy stack, and idle interior armies walk toward the nearest border.
 */
export function spreaderBot(name = 'spreader'): ArenaBot {
  return {
    name,
    orders(v) {
      const { graph: g, me } = v;
      const st = new Map(v.board.territories.map((t) => [t.territoryId, t]));
      const mine = (t: number) => {
        const x = st.get(t);
        return x?.owner.kind === 'player' && x.owner.playerId === me;
      };
      const armies = new Map<number, number>();
      for (const t of v.board.territories) if (mine(t.territoryId)) armies.set(t.territoryId, t.armies ?? 0);
      const held = new Set(armies.keys());
      const spare = new Map([...armies].map(([t, a]) => [t, Math.max(0, a - 1)]));
      let budget = v.income;
      const deploys = new Map<number, number>();
      const moves: SimOrder[] = [];
      const taken = new Set<number>();
      const need = (t: number) => {
        const x = st.get(t);
        const def = x?.armies ?? (x?.owner.kind === 'unknown' ? NEUTRAL : NEUTRAL);
        return armiesToTake(def, ARENA_SETTINGS) ?? def * 2 + 1;
      };
      // Each bonus's members still missing (for the "nearest to complete" order).
      const missing = new Map<number, number>();
      for (const b of g.map.bonuses) missing.set(b.id, b.territoryIds.filter((t) => !held.has(t)).length);
      const bonusOf = new Map<number, number[]>();
      for (const b of g.map.bonuses) for (const t of b.territoryIds) bonusOf.set(t, [...(bonusOf.get(t) ?? []), b.id]);
      const rank = (t: number) => Math.min(...(bonusOf.get(t) ?? []).map((b) => missing.get(b)!), 99);
      const candidates = [...new Set([...held].flatMap((t) => neighborsOf(g, t)))]
        .filter((t) => !held.has(t))
        .filter((t) => {
          const x = st.get(t);
          return x !== undefined && x.owner.kind !== 'unknown';
        })
        .sort((a, b) => rank(a) - rank(b) || need(a) - need(b) || a - b);
      for (const t of candidates) {
        const x = st.get(t)!;
        const enemy = x.owner.kind === 'player';
        const cost = enemy ? Math.max(need(t), 2 * (x.armies ?? 0)) : need(t);
        const sources = neighborsOf(g, t).filter((n) => held.has(n)).sort((a, b) => (spare.get(b) ?? 0) - (spare.get(a) ?? 0) || a - b);
        const src = sources[0];
        if (src === undefined) continue;
        const have = spare.get(src) ?? 0;
        const add = Math.max(0, cost - have);
        if (add > budget) continue;
        if (enemy && have < cost / 2) continue;
        budget -= add;
        if (add) deploys.set(src, (deploys.get(src) ?? 0) + add);
        spare.set(src, have + add - cost);
        moves.push({ from: src, to: t, armies: cost });
        taken.add(t);
      }
      // Leftover: the border facing the largest enemy stack, else the territory with the most spare.
      if (budget > 0) {
        let best: number | undefined;
        let bestThreat = -1;
        for (const t of [...held].sort((a, b) => a - b)) {
          const threat = Math.max(0, ...neighborsOf(g, t).map((n) => {
            const x = st.get(n);
            return x?.owner.kind === 'player' && x.owner.playerId !== me ? (x.armies ?? 0) : 0;
          }));
          if (threat > bestThreat) {
            best = t;
            bestThreat = threat;
          }
        }
        if (best !== undefined) deploys.set(best, (deploys.get(best) ?? 0) + budget);
      }
      // Idle interior armies walk one step toward the nearest territory not mine.
      const outside = [...st.keys()].filter((t) => !held.has(t));
      const dist = bfsDistances(g, outside);
      for (const t of [...held].sort((a, b) => a - b)) {
        const left = spare.get(t) ?? 0;
        if (left <= 0 || neighborsOf(g, t).some((n) => !held.has(n))) continue;
        const step = neighborsOf(g, t)
          .filter((n) => held.has(n))
          .sort((a, b) => (dist.get(a) ?? 99) - (dist.get(b) ?? 99) || a - b)[0];
        if (step !== undefined) moves.push({ from: t, to: step, armies: left });
      }
      return { deploys: [...deploys].map(([territoryId, a]) => ({ territoryId, armies: a })), moves };
    },
  };
}

export interface ArenaOptions {
  seed: number;
  /** The two bots: the first plays player 1, the second player 2. */
  bots: readonly [ArenaBot, ArenaBot];
  maxTurns?: number;
  fog?: boolean;
  /** Map size (default 11 × 10). */
  width?: number;
  height?: number;
}

export interface ArenaResult {
  /** The winning bot's index (0 or 1), or `null` for a draw at the turn limit. */
  winner: 0 | 1 | null;
  /** `eliminated` (the loser held nothing) or `points` (decided at the turn limit). */
  by: 'eliminated' | 'points' | 'draw';
  turns: number;
  /** Each bot's income at the start of every turn played. */
  incomes: [number[], number[]];
  /** Each bot's territories at the start of every turn played. */
  territories: [number[], number[]];
}

const PLAYERS = [101, 202] as const;

/** Play one game. */
export function playArena(o: ArenaOptions): ArenaResult {
  const { map, wastelands } = arenaMap(o.seed, o.width, o.height);
  const g = buildGraph(map);
  const r = new ArenaRng(o.seed ^ 0x51ed);
  const maxTurns = o.maxTurns ?? 40;
  const cells = new Map<number, SimTerritory>();
  const waste = new Set(wastelands);
  for (const t of map.territories) cells.set(t.id, { owner: 'neutral', armies: waste.has(t.id) ? WASTELAND : NEUTRAL });
  // Starts: alternately, the free territory farthest from every start taken (ties at random), never a wasteland.
  const starts: number[] = [];
  const pool = map.territories.map((t) => t.id).filter((t) => !waste.has(t));
  for (let k = 0; k < STARTS * 2; k++) {
    const player = PLAYERS[k % 2]!;
    let choice: number;
    if (!starts.length) choice = r.pick(pool);
    else {
      const d = bfsDistances(g, starts);
      const far = Math.max(...pool.filter((t) => !starts.includes(t)).map((t) => d.get(t) ?? 0));
      // Spread, not maximal: anything at least half the farthest distance.
      choice = r.pick(pool.filter((t) => !starts.includes(t) && (d.get(t) ?? 0) >= Math.max(2, Math.floor(far / 2))));
    }
    starts.push(choice);
    cells.set(choice, { owner: player, armies: START_ARMIES });
  }
  const history: [TurnBoard[], TurnBoard[]] = [[], []];
  const incomeLog: [{ turn: number; income: number }[], { turn: number; income: number }[]] = [[], []];
  const result: ArenaResult = { winner: null, by: 'draw', turns: 0, incomes: [[], []], territories: [[], []] };
  for (let turn = 1; turn <= maxTurns; turn++) {
    const held = PLAYERS.map((p) => new Set([...cells].filter(([, c]) => c.owner === p).map(([t]) => t)));
    const alive = held.map((h) => h.size > 0);
    if (!alive[0] || !alive[1]) {
      result.winner = alive[0] ? 0 : 1;
      result.by = 'eliminated';
      return result;
    }
    result.turns = turn;
    const incomes = held.map((h) => boardIncome(g, h, { base: BASE_INCOME, per: 0 }).total);
    const orders = PLAYERS.map((p, i) => {
      result.incomes[i as 0 | 1].push(incomes[i]!);
      result.territories[i as 0 | 1].push(held[i]!.size);
      const board = viewOf(g, cells, p, o.fog === true);
      const view: BotView = {
        graph: g,
        board,
        me: p,
        income: incomes[i]!,
        turn,
        history: history[i as 0 | 1],
        incomes: incomeLog[i as 0 | 1],
        players: PLAYERS,
        fog: o.fog === true,
      };
      const out = legal(o.bots[i]!.orders(view), p, held[i]!, incomes[i]!);
      history[i as 0 | 1].push({ turn, board, orders: myOrders(out) });
      incomeLog[i as 0 | 1].push({ turn, income: incomes[i]! });
      return out;
    });
    const full: BoardState = { source: 'browser', verified: true, territories: boardOf(cells) };
    const sim = simulateTurn({
      graph: g,
      board: full,
      deploys: orders.flatMap((x, i) => x.deploys.map((d) => ({ player: PLAYERS[i]!, ...d }))),
      orders: orders.map((x, i) => ({ player: PLAYERS[i]!, orders: x.moves })),
      moveOrder: turn % 2 === 1 ? [PLAYERS[0], PLAYERS[1]] : [PLAYERS[1], PLAYERS[0]],
      settings: ARENA_SETTINGS,
    });
    cells.clear();
    for (const [t, c] of sim.territories) cells.set(t, { owner: c.owner, armies: c.armies });
  }
  // Decided on points: income, then armies, then territories.
  const score = PLAYERS.map((p) => {
    const h = new Set([...cells].filter(([, c]) => c.owner === p).map(([t]) => t));
    const armies = [...cells].filter(([, c]) => c.owner === p).reduce((n, [, c]) => n + c.armies, 0);
    return [boardIncome(g, h, { base: BASE_INCOME, per: 0 }).total, armies, h.size];
  });
  const cmp = score[0]![0]! - score[1]![0]! || score[0]![1]! - score[1]![1]! || score[0]![2]! - score[1]![2]!;
  if (cmp !== 0) {
    result.winner = cmp > 0 ? 0 : 1;
    result.by = 'points';
  }
  return result;
}

/** The board as `player` sees it: with fog, territories neither its own nor beside its own are hidden. */
export function viewOf(g: MapGraph, cells: ReadonlyMap<number, SimTerritory>, player: number, fog: boolean): BoardState {
  const own = new Set([...cells].filter(([, c]) => c.owner === player).map(([t]) => t));
  const seen = new Set(own);
  for (const t of own) for (const n of neighborsOf(g, t)) seen.add(n);
  const territories: TerritoryState[] = [];
  for (const [t, c] of [...cells].sort((a, b) => a[0] - b[0])) {
    if (fog && !seen.has(t)) territories.push({ territoryId: t, owner: { kind: 'unknown' }, armies: null, fogLevel: 'Fogged' });
    else territories.push(stateOf(t, c));
  }
  return { source: 'browser', verified: true, territories };
}

function boardOf(cells: ReadonlyMap<number, SimTerritory>): TerritoryState[] {
  return [...cells].sort((a, b) => a[0] - b[0]).map(([t, c]) => stateOf(t, c));
}

function stateOf(t: number, c: SimTerritory): TerritoryState {
  return {
    territoryId: t,
    owner: typeof c.owner === 'number' ? { kind: 'player', playerId: c.owner } : { kind: 'neutral' },
    armies: c.armies,
  };
}

/** A bot's orders cut to what war.app would take: deploys on its own territories, within its income. */
export function legal(out: BotOrders, player: number, held: ReadonlySet<number>, income: number): BotOrders {
  let left = income;
  const deploys: BotOrders['deploys'] = [];
  for (const d of out.deploys) {
    if (!held.has(d.territoryId) || d.armies <= 0) continue;
    const a = Math.min(d.armies, left);
    if (a <= 0) continue;
    left -= a;
    deploys.push({ territoryId: d.territoryId, armies: a });
  }
  void player;
  return { deploys, moves: out.moves.filter((m) => held.has(m.from) && m.armies > 0) };
}

function myOrders(o: BotOrders): MyOrders {
  return { deploys: o.deploys, moves: o.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies })), sent: o.moves.map((m) => ({ from: m.from, to: m.to })), cards: [] };
}
