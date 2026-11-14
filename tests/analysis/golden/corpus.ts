// The golden corpus (#133): deterministic, seeded synthetic planTurn inputs, plus the inputs the
// test suite makes (captured once, see capture.setup.ts), each with the hash of its plan. The
// split of planTurn into phases must leave every one of these plans byte-identical.
//
// The generator depends only on its own PRNG and on graph/opponents/outlook helpers the split does
// not touch, so the same seed always builds the same inputs. Never change it without regenerating
// the hashes against the UNCHANGED planner (`GOLDEN_UPDATE=1`, see planner-golden.test.ts).
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import type { BoardState, TerritoryState } from '../../../src/board.js';
import type { Bonus, GameMap, Territory } from '../../../src/normalize.js';
import { buildGraph, type MapGraph } from '../../../src/analysis/graph.js';
import { trackOpponents, type TurnBoard } from '../../../src/analysis/opponents.js';
import { gameOutlook } from '../../../src/analysis/outlook.js';
import type {
  PlanGameContext,
  PlanGoal,
  PlanInput,
  PlanOptions,
  PlannerSettings,
} from '../../../src/analysis/planner.js';
import type { ProfilePlayer } from '../../../src/analysis/profile.js';
import { decode, type Json } from './codec.js';

/** Synthetic boards in the full corpus; the default run takes every {@link DEFAULT_STRIDE}th. */
export const SYNTHETIC_COUNT = 2000;
export const DEFAULT_STRIDE = 5;
const SEED = 0x5eed_0133;

export const SUITE_INPUTS = new URL('./suite-inputs.json.gz', import.meta.url);
export const HASHES = new URL('./hashes.json', import.meta.url);

// ---- PRNG (mulberry32) ----

class Rng {
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
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.next() * xs.length)]!;
  }
  shuffle<T>(xs: T[]): T[] {
    for (let i = xs.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [xs[i], xs[j]] = [xs[j]!, xs[i]!];
    }
    return xs;
  }
}

// ---- maps ----

function makeMap(r: Rng, idx: number): GameMap {
  const n = r.int(8, 42);
  const base = r.pick([1, 1, 1, 100, 2000]);
  const ids = Array.from({ length: n }, (_, i) => base + i);
  const adj = new Map<number, Set<number>>(ids.map((id) => [id, new Set<number>()]));
  const link = (a: number, b: number) => {
    if (a === b) return;
    adj.get(a)!.add(b);
  };
  // A connected spine: each territory links back to one of the few before it, then extra links.
  for (let i = 1; i < n; i++) link(ids[i]!, ids[Math.max(0, i - r.int(1, 3))]!);
  const extra = r.int(0, Math.ceil(n * 0.8));
  for (let k = 0; k < extra; k++) {
    const i = r.int(0, n - 1);
    const j = Math.min(n - 1, Math.max(0, i + r.int(-5, 5)));
    link(ids[i]!, ids[j]!);
  }
  const territories: Territory[] = ids.map((id) => ({ id, name: `T${id}`, connectedTo: [...adj.get(id)!] }));
  // Bonuses: consecutive runs of 1–6 territories (neighbours, mostly), some left out of any bonus.
  const bonuses: Bonus[] = [];
  let bid = r.pick([1, 500, base]); // sometimes overlapping territory ids (CLAUDE.md: ids overlap)
  for (let i = 0; i < n; ) {
    const len = r.int(1, 6);
    const members = ids.slice(i, i + len);
    i += len;
    if (r.chance(0.12)) continue;
    const value = r.chance(0.1) ? r.int(-2, 0) : r.int(1, Math.max(1, members.length + r.int(-1, 2)));
    while (ids.includes(bid) && base !== 1) bid++;
    bonuses.push({ id: bid, name: `B${bid}`, value, territoryIds: members, bonusIds: [] });
    bid++;
  }
  if (bonuses.length >= 3 && r.chance(0.25)) {
    const subs = r.shuffle(bonuses.slice()).slice(0, r.int(2, 3)).map((b) => b.id);
    while (ids.includes(bid) || bonuses.some((b) => b.id === bid)) bid++;
    bonuses.push({ id: bid, name: `Super${bid}`, value: r.int(2, 8), territoryIds: [], bonusIds: subs });
  }
  return { id: 900000 + idx, name: `Golden ${idx}`, territories, bonuses, distributionModes: [] };
}

// ---- boards ----

type Format = '1v1' | 'ffa' | 'teams';

interface Scenario {
  me: number;
  players: ProfilePlayer[];
  format: Format;
  fog: 'NoFog' | 'LightFog' | 'Foggy' | 'VeryFoggy' | 'ModerateFog' | 'Mixed';
  commanders: boolean;
}

/** Owners grown from seeds, so each player holds contiguous regions with fronts between them. */
function ownership(r: Rng, g: MapGraph, playerIds: number[], fill: number): Map<number, number> {
  const ids = [...g.territoryById.keys()];
  const owner = new Map<number, number>();
  const target = Math.max(playerIds.length, Math.round(ids.length * fill));
  const frontier: [number, number][] = [];
  for (const p of playerIds) {
    const free = ids.filter((id) => !owner.has(id));
    if (!free.length) break;
    const t = r.pick(free);
    owner.set(t, p);
    frontier.push([t, p]);
  }
  let guard = 0;
  while (owner.size < target && frontier.length && guard++ < 10000) {
    const k = r.int(0, frontier.length - 1);
    const [t, p] = frontier[k]!;
    const open = (g.neighbors.get(t) ?? []).filter((n) => !owner.has(n));
    if (!open.length) {
      frontier.splice(k, 1);
      continue;
    }
    const n = r.pick(open);
    owner.set(n, p);
    frontier.push([n, p]);
    if (r.chance(0.05)) {
      // a scattered pick far from the region
      const free = ids.filter((id) => !owner.has(id));
      if (free.length) {
        const f = r.pick(free);
        owner.set(f, p);
        frontier.push([f, p]);
      }
    }
  }
  return owner;
}

function makeBoard(
  r: Rng,
  g: MapGraph,
  sc: Scenario,
  owner: ReadonlyMap<number, number>,
  turn: number,
  wastelands: { count: number; size: number } | undefined,
): BoardState {
  const ids = [...g.territoryById.keys()];
  const mineSet = new Set(ids.filter((id) => owner.get(id) === sc.me));
  const nearMe = new Set<number>(mineSet);
  for (const t of mineSet) for (const n of g.neighbors.get(t) ?? []) nearMe.add(n);
  const allies = new Set(
    sc.players.filter((p) => p.id === sc.me || (p.team !== undefined && p.team >= 0 && p.team === sc.players.find((q) => q.id === sc.me)?.team)).map((p) => p.id),
  );
  const wasteSet = new Set<number>();
  if (wastelands) for (const t of r.shuffle(ids.filter((id) => !owner.has(id))).slice(0, wastelands.count)) wasteSet.add(t);
  const territories: TerritoryState[] = [];
  const cmdPlaced = new Set<number>();
  for (const id of ids) {
    const o = owner.get(id);
    let armies: number;
    if (o === undefined) armies = wasteSet.has(id) ? wastelands!.size : r.pick([0, 1, 2, 2, 2, 3, 4, 5]);
    else armies = r.chance(0.3) ? r.int(1, 2) : r.int(1, 3 + Math.min(40, turn * 2));
    const t: TerritoryState =
      o === undefined
        ? { territoryId: id, owner: { kind: 'neutral' }, armies }
        : { territoryId: id, owner: { kind: 'player', playerId: o }, armies };
    if (sc.commanders && o !== undefined && !cmdPlaced.has(o) && r.chance(0.35)) {
      cmdPlaced.add(o);
      t.specialUnits = [{ kind: 'commander', id: `cmd-${o}`, playerId: o }];
    }
    // Fog: what I cannot see (not mine, an ally's, or next to either).
    const seen = nearMe.has(id) || (o !== undefined && allies.has(o));
    let fog = sc.fog;
    if (fog === 'Mixed') fog = r.pick(['NoFog', 'LightFog', 'Foggy']);
    if (!seen && fog !== 'NoFog') {
      if (fog === 'LightFog' || fog === 'ModerateFog') {
        t.armies = null;
        t.fogLevel = 'OwnerOnly';
        delete t.specialUnits;
      } else {
        territories.push({ territoryId: id, owner: { kind: 'unknown' }, armies: null, fogLevel: 'Fogged' });
        continue;
      }
    } else if (fog !== 'NoFog' && r.chance(0.3)) t.fogLevel = 'Visible';
    territories.push(t);
  }
  return { source: r.chance(0.5) ? 'gamefeed' : 'browser', verified: r.chance(0.5), territories };
}

/** The board one turn earlier: some armies fewer, a few territories with another owner. */
function earlierOwner(r: Rng, g: MapGraph, owner: ReadonlyMap<number, number>, playerIds: number[]): Map<number, number> {
  const prev = new Map(owner);
  for (const id of g.territoryById.keys()) {
    if (!r.chance(0.12)) continue;
    if (r.chance(0.5)) prev.delete(id);
    else prev.set(id, r.pick(playerIds));
  }
  return prev;
}

// ---- inputs ----

const GOALS: (PlanGoal | undefined)[] = [undefined, undefined, 'balanced', 'expand', 'complete-bonus', 'defend'];

function makeInput(r: Rng, idx: number): PlanInput {
  const map = makeMap(r, idx);
  const g = buildGraph(map);
  const me = r.pick([10, 10, 10, 1, 7777777]);
  const format: Format = r.pick(['1v1', '1v1', 'ffa', 'ffa', 'teams']);
  const oppCount = format === '1v1' ? 1 : format === 'ffa' ? r.int(2, 5) : r.int(2, 4);
  const opps = [20, 30, 40, 50, 60].slice(0, oppCount);
  const players: ProfilePlayer[] = [{ id: me }, ...opps.map((id) => ({ id }))];
  if (format === 'teams') {
    players.forEach((p, i) => (p.team = i % 2));
    if (players.length < 4 && r.chance(0.5)) players.push({ id: 70, team: 0 });
  }
  for (const p of players.slice(1)) {
    if (r.chance(0.08)) p.state = r.pick(['Eliminated', 'SurrenderAccepted', 'Booted', 'Declined']);
    if (r.chance(0.1)) p.isAI = true;
    if (r.chance(0.05)) p.humanTurnedIntoAI = true;
  }
  const playerIds = players.map((p) => p.id);
  const commanders = r.chance(0.15);
  const sc: Scenario = {
    me,
    players,
    format,
    fog: r.pick(['NoFog', 'NoFog', 'LightFog', 'Foggy', 'Foggy', 'VeryFoggy', 'ModerateFog', 'Mixed']),
    commanders,
  };
  const picking = r.chance(0.04);
  const turn = picking ? r.pick([0, 1]) : r.pick([1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40]);
  // Fill grows with the turn: the opening is mostly neutral, the late game mostly owned.
  const fill = Math.min(0.97, 0.12 + turn * 0.04 + r.next() * 0.25);
  const owner = ownership(r, g, r.chance(0.97) ? playerIds : playerIds.slice(1), fill);
  const wastelands = r.chance(0.15) ? { count: r.int(1, 4), size: r.pick([6, 10, 12]) } : undefined;

  // History: a few earlier boards, the last of which is `previousBoard`.
  const histLen = r.chance(0.55) ? r.int(1, 4) : 0;
  const owners = [owner];
  for (let i = 0; i < histLen; i++) owners.unshift(earlierOwner(r, g, owners[0]!, playerIds));
  const boards = owners.map((o, i) => makeBoard(r, g, sc, o, Math.max(1, turn - (owners.length - 1 - i)), wastelands));
  const board = boards[boards.length - 1]!;
  const history: TurnBoard[] = boards.map((b, i) => ({ turn: turn - (boards.length - 1 - i), board: b }));

  const settings: PlannerSettings = {};
  if (r.chance(0.6)) settings.offensiveKillRate = r.pick([60, 60, 50, 70, 80, 100, 0.6]);
  if (r.chance(0.6)) settings.defensiveKillRate = r.pick([70, 70, 50, 60, 80, 0.7]);
  if (r.chance(0.5)) settings.luckModifier = r.pick([0, 0, 0.16, 16, 0.5, 100]);
  if (r.chance(0.4)) settings.roundingMode = r.pick(['StraightRound', 'WeightedRandom', 'Unknown']);
  if (r.chance(0.2)) settings.oneArmyStandsGuard = r.chance(0.3);
  if (r.chance(0.25)) settings.multiAttack = r.chance(0.7);
  if (r.chance(0.15)) settings.allowTransferOnly = r.chance(0.5);
  if (r.chance(0.15)) settings.bonusArmyPer = r.pick([0, 2, 3, 5]);
  if (r.chance(0.3)) settings.baseIncome = r.pick([0, 3, 5, 5, 8]);
  if (r.chance(0.15)) settings.localDeployments = true;
  if (r.chance(0.15)) settings.noSplit = true;
  if (r.chance(0.12)) settings.armyCap = r.chance(0.2) ? null : r.pick([1, 2, 3, 5]);
  if (wastelands && r.chance(0.8)) settings.wastelands = wastelands;

  const options: PlanOptions = {};
  const goal = r.pick(GOALS);
  if (goal) options.goal = goal;
  if (r.chance(0.5)) options.adapt = true;
  if (r.chance(0.2)) options.minWinChance = r.pick([0.5, 0.7, 0.8, 0.9, 1, 0.3, 1.5]);
  if (r.chance(0.1)) options.reserve = r.int(0, 6);
  if (r.chance(0.1) && map.bonuses.length) options.focusBonusIds = [r.pick(map.bonuses).id];
  if (r.chance(0.1)) options.enemyDeploy = r.int(0, 15);
  if (r.chance(0.1)) options.opponents = r.int(1, 5);
  if (r.chance(0.2)) options.holdsOrderPriority = true;
  if (r.chance(0.07)) options.orderPriorityForced = true;
  if (r.chance(0.2)) options.movesFirst = r.chance(0.5);
  if (r.chance(0.15)) options.opponentsMayHoldOrderPriority = true;
  if (r.chance(0.15)) options.opponentsMayHoldBomb = true;
  if (r.chance(0.15)) options.cardPieceValue = r.pick([0, 1, 2, 3, 5]);
  if (r.chance(0.15)) {
    const fogNeutrals = board.territories.filter((t) => t.owner.kind === 'unknown');
    if (fogNeutrals.length) {
      options.rememberedNeutrals = new Map(
        r.shuffle(fogNeutrals.slice()).slice(0, r.int(1, Math.min(6, fogNeutrals.length))).map((t) => [t.territoryId, r.int(0, 6)]),
      );
    }
  }

  const game: PlanGameContext = {};
  if (r.chance(0.85)) game.players = players;
  if (r.chance(0.85)) game.turn = r.chance(0.05) ? null : turn;
  if (picking) game.picking = true;
  if (r.chance(0.85)) game.fog = sc.fog === 'Mixed' ? 'Foggy' : sc.fog;
  if (commanders || r.chance(0.05)) game.commanders = commanders;
  const cards = r.chance(0.3);
  if (cards || r.chance(0.1)) game.cards = cards;
  if (r.chance(0.4)) game.symmetricStart = r.chance(0.7);
  if (r.chance(0.12)) game.opening = new Map(opps.map((p) => [p, r.int(3, 12)]));
  if (r.chance(0.1)) game.endRules = { aisSurrenderWhenOneHumanRemains: r.chance(0.6) };
  if (cards && r.chance(0.5)) game.reinforcement = { firstTurn: r.int(1, 8), armies: r.int(2, 10), turnsPerCard: r.chance(0.3) ? null : r.int(2, 6) };

  const input: PlanInput = { graph: g, board, me, income: r.chance(0.03) ? 0 : r.int(3, 22) };
  if (cards && r.chance(0.3)) input.cardArmies = r.int(1, 6);
  if (boards.length > 1 && r.chance(0.85)) input.previousBoard = boards[boards.length - 2];
  if (r.chance(0.7)) input.turn = turn;
  if (boards.length > 1 && r.chance(0.6)) {
    input.tracks = trackOpponents(g, history, me, settings, r.chance(0.5) ? { players } : undefined);
  }
  if (boards.length > 1 && r.chance(0.35)) {
    const o = gameOutlook({ graph: g, me, boards: history, settings, game: { players } });
    options.outlook = { state: r.chance(0.6) ? r.pick(['winning', 'losing', 'even', 'stalemate']) : o.state, turns: o.turns };
  }
  if (Object.keys(settings).length || r.chance(0.5)) input.settings = settings;
  if (Object.keys(options).length || r.chance(0.5)) input.options = options;
  if (Object.keys(game).length || r.chance(0.5)) input.game = game;
  return input;
}

/** The synthetic inputs `0 … count−1` (each from its own seed, so a subset builds the same boards). */
export function syntheticInput(i: number): PlanInput {
  return makeInput(new Rng((SEED ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0), i);
}

/**
 * The committed capture of the suite's planTurn inputs: each input encoded ({@link encode}) with its
 * `graph` replaced by the key of one shared, encoded graph (most tests reuse a few small maps).
 */
export interface SuiteCapture {
  graphs: Record<string, Json>;
  inputs: Json[];
}

/** The inputs the test suite made of planTurn, decoded from the committed capture. */
export function suiteInputs(): PlanInput[] {
  const raw = JSON.parse(gunzipSync(readFileSync(SUITE_INPUTS)).toString('utf8')) as SuiteCapture;
  const graphs = new Map<string, unknown>();
  return raw.inputs.map((j) => {
    const input = decode(j) as Record<string, unknown>;
    const key = input.graph as string;
    if (!graphs.has(key)) graphs.set(key, decode(raw.graphs[key]!));
    input.graph = graphs.get(key);
    return input as unknown as PlanInput;
  });
}
