// Reading what an opponent did between two boards (split from shared.ts): fog visibility, frontier coverage,
// the evidence my orders left (failed attacks, hold losses, repelled and repulsed attacks, proven captures)
// and the observed deploy itself (`observeDeploy`, #57, #69, #123). Pure; shared.ts re-exports all of it.
import type { BoardState, TerritoryState } from '../../board.js';
import { } from '../../commerce.js';
import type { MyOrders } from '../opponents.js';
import { } from '../opponents.js';
import type { } from '../../normalize.js';
import { bonusTerritories } from '../bonuses.js';
import {


  DEFAULT_DEFENSIVE_KILL_RATE,
  DEFAULT_OFFENSIVE_KILL_RATE,
  fewestAttackersToKill,
  fewestAttackersToTake,
  guaranteedKills,

  specialUnitStrength,
  straightKills,


  type KillRates,
} from '../combat.js';
import { neighborsOf, type MapGraph } from '../graph.js';
import type { } from '../outlook.js';
import type { } from '../lookahead.js';
import type { } from '../schedule.js';
import { byNum } from './util.js';
import type { PlannerSettings } from './shared.js';
import type { } from './team.js';
import type { } from './jabs.js';


/**
 * Fog levels that hide a territory's armies. The live board names war.app's StandingFogLevel
 * (1 You, 2 Visible, 3 OwnerOnly, 4 Fogged; the client refuses a deploy on 3 or 4 as "fogged");
 * a GameFeed standing may spell it as a word or as the raw number (every GameFeed scalar is a
 * string).
 */
const HIDDEN_FOG = /fog|owneronly|^\s*[34]\s*$/i;
/** Fog levels that hide a territory's owner too (StandingFogLevel 4, Fogged). */
const OWNER_HIDDEN_FOG = /fog|^\s*4\s*$/i;

/**
 * `t` when a board shows both its owner (a player or a neutral) and its armies, else
 * `undefined`: a fogged territory (owner unknown, armies `null`), or one whose fog level hides
 * its armies even if a placeholder owner or count came with it (issue #69).
 *
 * One exception: an entry named `"OwnerOnly"` that still carries a count is fog level 2
 * (Visible) from a board cache written before #69, which misnamed it; every current board nulls
 * an owner-only territory's armies, and the old cache left level 3 unnamed (`"3"`).
 */
export function visibleState(t: TerritoryState | undefined): TerritoryState | undefined {
  if (!t || t.armies === null) return undefined;
  if (t.owner.kind !== 'player' && t.owner.kind !== 'neutral') return undefined;
  if (t.fogLevel !== undefined && HIDDEN_FOG.test(t.fogLevel) && !/^\s*owneronly\s*$/i.test(t.fogLevel)) return undefined;
  return t;
}

/**
 * `t` when a board shows its owner (a player or a neutral), whatever its armies: visible, or
 * owner-only (light fog); `undefined` when fogged, even under a placeholder owner.
 */
export function ownerShown(t: TerritoryState | undefined): TerritoryState | undefined {
  if (!t || (t.owner.kind !== 'player' && t.owner.kind !== 'neutral')) return undefined;
  if (t.fogLevel !== undefined && OWNER_HIDDEN_FOG.test(t.fogLevel)) return undefined;
  return t;
}

/**
 * #294: how much of an opponent's frontier one observed turn (`previous` → `board`) could read. Its
 * frontier is approximate: its territories `board` shows as its with a neighbour not visibly its, plus
 * every territory beside one of those whose owner `board` hides (it could hold it, and deploy there
 * unseen). A frontier territory is read when it is in view with its armies on both boards (as
 * {@link observeDeploy} counts it). Deep fog no visible territory borders is left out, so the share is
 * an upper bound on what the turn saw.
 */
export interface FrontierCoverage {
  /** Its frontier territories in view with armies on both boards: its deploy there was read. */
  inView: number;
  /** Its frontier on `board`, approximately (the "~M" of the warning). */
  frontier: number;
  /** inView ÷ frontier; 0 with no frontier and none of its territories shown, 1 with no frontier but some shown. */
  share: number;
  /** Positive bonuses it could still hold (no member visibly another's) with a member whose owner `board` hides. */
  hiddenBonuses: number;
}

/** #294: {@link FrontierCoverage} of one opponent on one observed turn. Pure. */
export function frontierCoverage(g: MapGraph, board: BoardState, previous: BoardState, playerId: number): FrontierCoverage {
  const now = new Map(board.territories.map((t) => [t.territoryId, t]));
  const before = new Map(previous.territories.map((t) => [t.territoryId, t]));
  const its = (id: number) => {
    const st = ownerShown(now.get(id));
    return st?.owner.kind === 'player' && st.owner.playerId === playerId;
  };
  const shownIts = [...g.territoryById.keys()].filter(its);
  const frontier = new Set<number>();
  let inView = 0;
  for (const t of shownIts) {
    const ns = neighborsOf(g, t);
    if (ns.every(its)) continue;
    frontier.add(t);
    const a = visibleState(now.get(t));
    const b = visibleState(before.get(t));
    if (a && b) inView++;
    for (const n of ns) if (!ownerShown(now.get(n))) frontier.add(n);
  }
  let hiddenBonuses = 0;
  for (const bonus of g.map.bonuses) {
    const ts = bonusTerritories(g, bonus.id);
    if (bonus.value <= 0 || !ts.length) continue;
    const taken = ts.some((t) => {
      const st = ownerShown(now.get(t));
      return st !== undefined && !(st.owner.kind === 'player' && st.owner.playerId === playerId);
    });
    if (!taken && ts.some((t) => !ownerShown(now.get(t)))) hiddenBonuses++;
  }
  const share = frontier.size ? inView / frontier.size : shownIts.length ? 1 : 0;
  return { inView, frontier: frontier.size, share, hiddenBonuses };
}

/** #294: an opponent's {@link FrontierCoverage} over several observed turns (its income window). */
export interface TrackCoverage {
  /** The `from` turns that carried a coverage, oldest first. */
  turns: number[];
  /** The fewest and the most frontier territories a turn read. */
  inView: { min: number; max: number };
  /** The smallest and the largest frontier of a turn. */
  frontier: { min: number; max: number };
  /** Σ inView ÷ Σ frontier (each turn's share when every frontier is 0: their mean). */
  share: number;
  /** The newest of those turns' hidden bonuses. */
  hiddenBonuses: number;
}

/** #294: {@link TrackCoverage} over `turns` (those carrying a coverage); `null` when none does. */
export function trackCoverage(turns: readonly { from: number; coverage?: FrontierCoverage }[]): TrackCoverage | null {
  const withIt = turns.filter((x) => x.coverage !== undefined);
  if (!withIt.length) return null;
  const inView = withIt.reduce((n, x) => n + x.coverage!.inView, 0);
  const frontier = withIt.reduce((n, x) => n + x.coverage!.frontier, 0);
  const range = (xs: number[]) => ({ min: Math.min(...xs), max: Math.max(...xs) });
  return {
    turns: withIt.map((x) => x.from),
    inView: range(withIt.map((x) => x.coverage!.inView)),
    frontier: range(withIt.map((x) => x.coverage!.frontier)),
    share: frontier ? inView / frontier : withIt.reduce((n, x) => n + x.coverage!.share, 0) / withIt.length,
    hiddenBonuses: withIt.at(-1)!.coverage!.hiddenBonuses,
  };
}

/**
 * #294: "1 of ~4 frontier territories (25%)" (a range, "1–2 of ~4–5", when the turns differ; the share
 * is Σ read ÷ Σ frontier), and ", N bonus(es) it could hold out of view" when any: the words beside a
 * tracked figure.
 */
export function coverageText(c: TrackCoverage): string {
  const b = c.hiddenBonuses;
  const range = (r: { min: number; max: number }) => (r.min === r.max ? `${r.min}` : `${r.min}–${r.max}`);
  return `${range(c.inView)} of ~${range(c.frontier)} frontier territories (${Math.round(c.share * 100)}%)${b ? `, ${b} ${b === 1 ? 'bonus' : 'bonuses'} it could hold out of view` : ''}`;
}

/**
 * #294: one of an opponent's stacks that grew (held by it, in view with armies on both boards), its
 * growth split: what its neighbours in view, its own on both boards, visibly sent away could have
 * moved in (each shrink claimed once: first by the stacks with no hidden neighbour, then by those beside
 * the fog, each in id order), then — beside a territory hidden on either board — what could have come
 * out of the fog, else what can only be deploy.
 */
export interface StackGrowth {
  territoryId: number;
  /** after − before, plus what my failed attacks killed there (#226). */
  growth: number;
  /** The neighbours in view whose shrink could have moved in, and how much of it. */
  moved: { from: number; armies: number }[];
  /** The rest, beside the fog: it could have come out of it (or been deployed). */
  fog: number;
  /** The rest, with no hidden neighbour: it can only be deploy. */
  deploy: number;
}

/** What {@link observeDeploy} read off two boards for one opponent. */
export interface DeployObservation {
  /** #294: its stacks that grew, each growth split ({@link StackGrowth}), in territory id order. */
  stacks: StackGrowth[];
  /** Its observed deploy last turn, floored at 0. */
  deploy: number;
  /** Its territories now that were visible last turn too (held both times, or captured), by id. */
  counted: number[];
  /** Of `counted`, those it took from another visible owner (a player, me included, or a neutral). */
  captured: number[];
  /**
   * Of `captured`, those taken (at least partly) from the fog (issue #86): more armies stand there
   * than its territories next to them visibly sent away, and a neighbour was hidden on a board,
   * so the rest arrived from the fog — a move, not income. They count only what the capture
   * cost plus what the visible sources sent; the stack stays a threat.
   */
  fromFog: number[];
  /**
   * The armies read as moves out of the fog, never income: the stacks on `fromFog` beyond what
   * visible sources sent, plus the ambiguous armies (growth on `grewFromFog`, a reinforced
   * capture's surplus) beyond the turn's bound ({@link ambiguousBound}).
   */
  fogArmies: number;
  /** Its territories now that last turn's board did not show: fog reveals, never income. */
  reveals: number[];
  /**
   * Of `captured`, those it took with more armies than its visible neighbours visibly sent, where
   * one of them did shrink into it and a neighbour was hidden (#123): the surplus counts as a
   * deploy on the visible stack that attacked (deploy-then-capture) up to the turn's bound
   * ({@link ambiguousBound}), though a stack out of the fog may have joined it (`low` counts it
   * so); beyond the bound it is in `fromFog` too.
   */
  reinforced: number[];
  /**
   * Its territories held on both boards, next to a territory hidden on either, whose growth was
   * read (at least partly) as a move out of the fog (#123): the growth there beyond the turn's
   * bound ({@link ambiguousBound}: twice what it was expected to deploy, at most what it could earn).
   */
  grewFromFog: number[];
  /** The armies of that growth read as moves (part of `fogArmies`). */
  fogGrowth: number;
  /**
   * #293: under Local Deployment ({@link ObserveContext.localFree}), the territories of `grewFromFog`
   * in no bonus it could hold, whose growth the free income `free` capped (a walk from a neighbour in
   * view never counted). Absent when none.
   */
  localCut?: { free: number; territories: number[] };
  /** {@link ObserveContext.expected}, when given. */
  expected: number | null;
  /**
   * Of `captured`, those taken from me (#123, given {@link ObserveContext.me}): my orders are
   * unknown here, so the capture is priced at what the guard I may have left kills, never at my
   * stack last turn (I may have attacked out of it).
   */
  emptied: number[];
  /** What `high` adds for `emptied` (my stack last turn standing there, not the guard). */
  emptiedHigh: number;
  /**
   * #226: its territories my failed attacks hit last turn (held by it on both boards, my source mine
   * on both: {@link failedAttackKills}), given {@link ObserveContext.myOrders}; empty otherwise.
   */
  attacked: number[];
  /**
   * #226: the defenders my failed attacks killed there (straight-rounded at the offensive kill rate):
   * defenders after = before + deploy + transfers in − kills, so they count back into its growth
   * there (a lower bound on what stood there). Beside the fog that growth is ambiguous like any other
   * ({@link ambiguousBound}). 0 without my orders.
   */
  attackKills: number;
  /**
   * #271 (3): the armies standing on its captures that its stacks in view on the earlier board beside
   * them, hidden on the later one, may have sent (each stack's armies less the guard, claimed once,
   * after what its stacks in view on both boards visibly sent): arrivals, never deploy nor a move
   * out of the fog. The source's shrink is unseen, so they count in no figure but `high` (had the
   * source stayed put, they were deployed).
   */
  arrivals: number;
  /**
   * #271 (2): its captures of a neutral in view beside the fog that needed more attackers
   * ({@link fewestAttackersToTake}) than its stacks in view sent: what stands there beyond those is
   * read as deploy within the turn's bound ({@link ambiguousBound}), the rest a move out of the fog.
   */
  unseenAttackers: number[];
  /**
   * The attackers those captures needed beyond what its stacks in view sent (the capture's cost
   * included when none of them sent any), unbounded: the opponent tracker reads a repeated pattern
   * of them as income.
   */
  unseenAttackerArmies: number;
  /** #271 (1): my holds it attacked and failed to take, read as a bound on its deploy ({@link repelledFloor}); given my orders. */
  repelled: number[];
  /** #271 (1): that bound: the deploy, `low` and `high` are never below it. 0 without my orders. */
  repelledFloor: number;
  /** #418: its captures read with every source army in view, read as a bound on its deploy ({@link captureFloor}). */
  proven: number[];
  /** #418: that bound (proof may always raise an estimate): the deploy, `low` and `high` are never below it. */
  captureFloor: number;
  /** The deploy with every ambiguous army read the low way (fog moves, emptied captures), floored at 0. */
  low: number;
  /** The deploy with every ambiguous army read the high way (deploys, my stack standing), floored at 0. */
  high: number;
}

/**
 * What {@link observeSigned} knows beyond the two boards (#123); every field optional, and
 * without them the reading is the board-only one.
 */
export interface ObserveContext {
  /** My player id: a capture from me is priced at the guard (`emptied`). */
  me?: number;
  /** Armies that stand guard on a territory (1, or 0 when the game lets a territory empty); default 1. */
  guard?: number;
  /**
   * What it was expected to deploy without this observation (its visible income, the fog prior,
   * or its tracked/carried income): ambiguous armies (growth on its territories next to a hidden
   * one, a reinforced capture's surplus) beyond twice that are moves out of the fog
   * (`grewFromFog`, `fromFog`), not income ({@link ambiguousBound}). Absent: every growth counts
   * as deploy.
   */
  expected?: number;
  /**
   * The most it could deploy (its base plus every bonus it could hold): the turn's deploy never
   * reads above it once ambiguous armies are counted (`reinforced`, growth beside the fog); the
   * rest arrived from the fog. With neither this nor `expected` (a board-only reading), a
   * capture's surplus is all a move, as before #123.
   */
  most?: number;
  /**
   * #226: my orders on the turn between the two boards (the deploys and moves warapp_submit_turn sent,
   * `TurnBoard.orders`): a failed attack of mine on its territory killed defenders the board reads as
   * a shrink, so they count back ({@link failedAttackKills}). Requires `me`.
   */
  myOrders?: MyOrders;
  /**
   * #293: under Local Deployment (`localDeployments` in the settings), its free income on the turn read
   * (base, never below {@link MIN_ENEMY_DEPLOY}, plus a Reinforcement card the clock lets it hold by
   * then: {@link localFreeOn}). Growth beside the fog on a
   * territory in no bonus it could hold on the earlier board (none of its territories shown with another
   * owner) could only be deployed from that free income: what a neighbour in view visibly sent there (the
   * growth split, `stacks`) is a walk, and the rest reads as deploy only up to this figure, shared by all
   * such growth; beyond it the armies came out of the fog. Ignored without an expected figure.
   */
  localFree?: number;
  /**
   * #271 review: an opponent may have played a Bomb card on the turn read ({@link bombPossibleOn}):
   * {@link repelledFloor} leaves out the half of a hold a bomb could take. Default false.
   */
  bomb?: boolean;
}

/**
 * #226: what my failed attacks on `playerId` killed, by target, on the turn `before` → `after`: each
 * move of mine onto a territory it holds on both boards (shown with armies both times), from a
 * source mine on both (one that fell may have been taken before my attack ran), kills
 * round(armies × the offensive kill rate) — a straight-rounded expectation, which luck can move.
 * The board reads that loss as a shrink. The opponent tracker's `measureOrders` counts the same.
 */
export function failedAttackKills(
  g: MapGraph,
  before: BoardState,
  after: BoardState,
  me: number,
  playerId: number,
  orders: MyOrders,
  rates: KillRates = {},
): Map<number, number> {
  const offensive = rates.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const out = new Map<number, number>();
  for (const m of failedAttackMoves(g, before, after, me, playerId, orders))
    out.set(m.to, (out.get(m.to) ?? 0) + straightKills(Math.max(0, m.armies), offensive));
  return out;
}

/**
 * The moves {@link failedAttackKills} counts: each move of mine onto a territory `playerId` holds on
 * both boards (shown with armies both times), from a source mine on both. #240 review: the armies
 * {@link repulsedAttacks} reports are these moves' too, so they match the kills.
 */
function failedAttackMoves(
  g: MapGraph,
  before: BoardState,
  after: BoardState,
  me: number,
  playerId: number,
  orders: MyOrders,
): MyOrders['moves'] {
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  const owns = (t: TerritoryState | undefined, p: number) => {
    const v = visibleState(t);
    return v?.owner.kind === 'player' && v.owner.playerId === p;
  };
  return orders.moves.filter(
    (m) =>
      g.territoryById.has(m.to) &&
      owns(was.get(m.from), me) &&
      owns(now.get(m.from), me) &&
      owns(was.get(m.to), playerId) &&
      owns(now.get(m.to), playerId),
  );
}

/** A hold of mine (mine, with armies, on both boards) that lost armies my orders do not explain. */
export interface HoldLoss {
  territoryId: number;
  /** What stood there when it was attacked: my armies there, plus what I deployed there, less what I sent out. */
  defenders: number;
  /** What it lost beyond what my orders explain: the defenders plus what I moved in, less what the later board shows. */
  loss: number;
  /** What stood there before any move: my armies there plus what I deployed there (what a Bomb halves). */
  standing: number;
  /**
   * #271 review: every transfer counted in (`loss` adds it at its ordered size) surely arrived whole:
   * its source is mine on both boards, kept what my orders leave there (lost nothing they do not
   * explain, issued no attack of mine that failed) and could send everything ordered from it. Else the
   * order may have sent less (an order sends what is left) or nothing (a territory captured first),
   * so `loss` may overstate. True when nothing came in.
   */
  inflowSure: boolean;
}

/**
 * #271 review: the territories an order of mine touched that `orders.moves` does not carry, so what
 * they held after my orders is not known: a move order in `sent` beyond the plain ones `moves` keeps on
 * the same pair (#165 leaves out Transfer Only, Attack Only and percentage orders), both its ends; and
 * each territory a card play names (an Airlift's `from` and `to`, a card's `target`).
 */
function ordersNotInMoves(orders: MyOrders): Set<number> {
  const out = new Set<number>();
  const key = (from: number, to: number) => `${from}>${to}`;
  const carried = new Map<string, number>();
  for (const m of orders.moves) carried.set(key(m.from, m.to), (carried.get(key(m.from, m.to)) ?? 0) + 1);
  for (const o of orders.sent ?? []) {
    const left = carried.get(key(o.from, o.to)) ?? 0;
    if (left > 0) carried.set(key(o.from, o.to), left - 1);
    else out.add(o.from).add(o.to);
  }
  for (const c of orders.cards ?? []) for (const id of [c.from, c.to, c.target]) if (id !== undefined) out.add(id);
  return out;
}

/**
 * My holds (mine, with armies, on both boards) that lost armies my orders do not explain, by id: the
 * defenders were my armies there plus what I deployed there, less what I sent out; what the later
 * board shows less (what I moved in from a territory mine on the earlier board counted on top) is what
 * an attack on it that failed killed. A hold I attacked out of and failed is skipped: the survivors of
 * my own attack came back to it, so its loss is not known. So is a hold an order `moves` does not carry
 * touched (#271 review, {@link ordersNotInMoves}: a Transfer Only, Attack Only or percentage order, a
 * card play), and a transfer from a source one touched is not surely whole. The opponent tracker's attacks on my holds
 * and the #271 bound ({@link repelledFloor}) both read these.
 */
export function holdLosses(g: MapGraph, before: BoardState, after: BoardState, me: number, orders: MyOrders, guard = 1): HoldLoss[] {
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  const owns = (t: TerritoryState | undefined, p: number) => t?.owner.kind === 'player' && t.owner.playerId === p;
  const held = (id: number) => owns(visibleState(was.get(id)), me) && owns(visibleState(now.get(id)), me);
  const deployed = new Map<number, number>();
  for (const d of orders.deploys) deployed.set(d.territoryId, (deployed.get(d.territoryId) ?? 0) + Math.max(0, d.armies));
  const sent = new Map<number, number>();
  const came = new Map<number, number>();
  /** The sources of what `came`, by the hold they sent to. */
  const cameFrom = new Map<number, Set<number>>();
  const failedFrom = new Set<number>();
  const untracked = ordersNotInMoves(orders);
  for (const m of orders.moves) {
    const armies = Math.max(0, m.armies);
    sent.set(m.from, (sent.get(m.from) ?? 0) + armies);
    if (held(m.to) && owns(visibleState(was.get(m.from)), me)) {
      came.set(m.to, (came.get(m.to) ?? 0) + armies);
      if (armies > 0) cameFrom.set(m.to, (cameFrom.get(m.to) ?? new Set()).add(m.from));
    }
    if (!owns(visibleState(was.get(m.to)), me) && !owns(visibleState(now.get(m.to)), me)) failedFrom.add(m.from);
  }
  /**
   * #271 review: a source that surely sent all ordered from it ({@link HoldLoss.inflowSure}): mine on
   * both boards, no failed attack of mine out of it, nothing moved into it (when that arrived is not
   * known), and it shows exactly what my orders leave there. An order sends what is left down to the
   * guard, so a loss before it shows only when my orders leave more than the guard there; else only
   * when no other player (nor the fog) was beside it to attack or bomb it.
   */
  const sentWhole = (id: number) => {
    if (!held(id) || failedFrom.has(id) || came.has(id) || untracked.has(id)) return false;
    const left = visibleState(was.get(id))!.armies! + (deployed.get(id) ?? 0) - (sent.get(id) ?? 0);
    if (left < 0 || visibleState(now.get(id))!.armies! !== left) return false;
    if (left > guard) return true;
    return neighborsOf(g, id).every((n) => {
      const o = ownerShown(was.get(n))?.owner;
      return o !== undefined && (o.kind === 'neutral' || (o.kind === 'player' && o.playerId === me));
    });
  };
  const out: HoldLoss[] = [];
  for (const id of [...new Set(after.territories.map((t) => t.territoryId))].sort(byNum)) {
    if (!g.territoryById.has(id) || !held(id) || failedFrom.has(id) || untracked.has(id)) continue;
    const standing = visibleState(was.get(id))!.armies! + (deployed.get(id) ?? 0);
    const defenders = Math.max(0, standing - (sent.get(id) ?? 0));
    const loss = defenders + (came.get(id) ?? 0) - visibleState(now.get(id))!.armies!;
    const inflowSure = [...(cameFrom.get(id) ?? [])].every(sentWhole);
    if (loss > 0) out.push({ territoryId: id, defenders, loss, standing, inflowSure });
  }
  return out;
}

/** #271: what {@link repelledFloor} read: the holds of mine `playerId` attacked and failed to take. */
export interface RepelledAttacks {
  /** My holds it attacked, by id. */
  territories: number[];
  /** The fewest attackers my losses there needed, summed. */
  attackers: number;
  /** What its stacks beside them could send at the start of the turn (each counted once, less the guard; a commander as 7). */
  supply: number;
  /** The lower bound on its deploy that turn: the attackers beyond that supply, at least 0. */
  floor: number;
}

/**
 * #271: a failed attack on a hold of mine is a measurement, the mirror of #226. My loss there
 * ({@link holdLosses}: what my orders do not explain) needed at least {@link fewestAttackersToKill}
 * attackers (every attacker killing its most, luck included), and without Multi-Attack each army
 * moves once, so they all came from its territories beside the hold at the start of the turn: their
 * armies then (less the guard) plus what it deployed there. A hold counts only when every neighbour
 * showed its owner on the earlier board, every territory of `playerId` beside it showed its armies,
 * and `playerId` is the only other player beside it. Over every such hold the bound is the larger of
 * the best single hold and all of them together (the attackers summed against the stacks beside any
 * of them, each counted once).
 * #271 review: a hold reads only when what I moved in surely arrived whole ({@link HoldLoss.inflowSure}),
 * so the bound uses the least my orders can have brought. On a turn an opponent may have played a Bomb
 * card (`bomb`, {@link bombPossibleOn}), which halves a territory of mine beside the bomber after the
 * deploys and reads as an attack, the most it could take (half the stack before any move, rounded up)
 * is left out of the loss first. Orders cached without `sent` or `cards` (before they were kept) bound
 * nothing: an order `moves` leaves out, or a card play, may have moved armies out of a hold.
 */
export function repelledFloor(
  g: MapGraph,
  before: BoardState,
  after: BoardState,
  me: number,
  playerId: number,
  orders: MyOrders,
  settings: PlannerSettings = {},
  guard = (settings.oneArmyStandsGuard ?? true) ? 1 : 0,
  bomb = false,
): RepelledAttacks {
  const none: RepelledAttacks = { territories: [], attackers: 0, supply: 0, floor: 0 };
  // #271 review: orders cached before `sent` and `cards` were kept may have left out an order or a card
  // play that moved armies out of a hold: what ran is unknown, so they bound nothing.
  if (settings.multiAttack || !orders.sent || !orders.cards) return none;
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const sendable = (id: number) => {
    const st = visibleState(was.get(id))!;
    return Math.max(0, st.armies! - guard) + specialUnitStrength(st.specialUnits?.filter((u) => u.playerId === playerId));
  };
  const holds: { id: number; attackers: number; beside: number[] }[] = [];
  for (const h of holdLosses(g, before, after, me, orders, guard)) {
    if (!h.inflowSure) continue;
    const loss = h.loss - (bomb ? Math.ceil(h.standing / 2) : 0);
    if (loss <= 0) continue;
    const ns = neighborsOf(g, h.territoryId);
    if (ns.some((n) => !ownerShown(was.get(n)))) continue;
    const others = new Set<number>();
    const beside: number[] = [];
    let hidden = false;
    for (const n of ns) {
      const o = ownerShown(was.get(n))!.owner;
      if (o.kind !== 'player' || o.playerId === me) continue;
      others.add(o.playerId);
      if (o.playerId === playerId) {
        if (!visibleState(was.get(n))) hidden = true;
        beside.push(n);
      }
    }
    if (hidden || others.size !== 1 || !others.has(playerId)) continue;
    const attackers = fewestAttackersToKill(loss, settings, settings.luckModifier, settings.roundingMode);
    if (attackers === null) continue;
    holds.push({ id: h.territoryId, attackers, beside });
  }
  if (!holds.length) return none;
  const supplyOf = (ids: Iterable<number>) => [...new Set(ids)].reduce((n, id) => n + sendable(id), 0);
  let best: RepelledAttacks = { ...none, territories: holds.map((h) => h.id) };
  const all = {
    attackers: holds.reduce((n, h) => n + h.attackers, 0),
    supply: supplyOf(holds.flatMap((h) => h.beside)),
  };
  best = { ...best, ...all, floor: Math.max(0, all.attackers - all.supply) };
  for (const h of holds) {
    const supply = supplyOf(h.beside);
    if (h.attackers - supply > best.floor) best = { ...best, attackers: h.attackers, supply, floor: h.attackers - supply };
  }
  return best;
}

/** #418: the captures {@link captureFloor} read, and the deploy they prove. */
export interface ProvenCaptures {
  /** Its captures read, by id. */
  territories: number[];
  /** The fewest attackers they needed (summed, or the one capture that sets the floor). */
  attackers: number;
  /** What its stacks beside them could send at the start of the turn (each counted once, less the guard; a commander as 7). */
  supply: number;
  /** The deploy that turn proves: the attackers beyond that supply, at least 0. */
  floor: number;
}

/**
 * #418 (the owner's decision of 2026-11-20: proof may always raise an estimate): the fewest armies that
 * can kill `defenders` however the attack is split into orders. One attack of `a` kills at most
 * round(a × the best kill rate luck allows) (straight; weighted rounding rounds up a fraction); a split
 * gains most per army at the smallest attack, so the most kills per army is the best over small attacks.
 */
function fewestAttackersAnySplit(defenders: number, settings: PlannerSettings): number | null {
  if (defenders <= 0) return 0;
  let perArmy = 0;
  for (let a = 1; a <= 20; a++) {
    // The most kills `a` attackers can make: the largest k with fewestAttackersToKill(k) ≤ a.
    let k = 0;
    for (;;) {
      const need = fewestAttackersToKill(k + 1, settings, settings.luckModifier, settings.roundingMode);
      if (need === null || need > a) break;
      k++;
    }
    perArmy = Math.max(perArmy, k / a);
  }
  return perArmy > 0 ? Math.ceil(defenders / perArmy - 1e-9) : null;
}

/**
 * #418: a capture with every source army in view proves a minimum deploy. Without Multi-Attack each army
 * moves once, so every attacker on a territory it took — and every army that then moved in — came from
 * its territories beside the target at the start of the turn: their armies then (less the guard, a
 * commander as 7) plus what it deployed on them. What arrived is at least what stands there now plus the
 * attacker the last defender surely killed ({@link guaranteedKills} of one), and at least the fewest
 * armies that kill every defender however the attack was split ({@link fewestAttackersAnySplit}); what
 * that leaves beyond the supply was deployed.
 * A capture reads only when: the target was a neutral or mine, shown with its armies, and its now, shown
 * with its armies, no special unit on it; every neighbour of the target showed its owner on the earlier
 * board and each of its showed its armies (a hidden one may have sent a stack); no other player borders
 * the target on either board (it may have worn the defenders down first); and, when the target was mine
 * or borders mine, my orders are known in full (`sent` and `cards`) and none of them leaves the target,
 * enters it or plays a card on it (a move of mine out of it leaves fewer defenders; an attack of mine in
 * kills some first). A Bomb it may have played (`bomb`) halves the defenders first. Over every such
 * capture the floor is the larger of the best single capture and all of them together (their attackers
 * summed against the stacks beside any of them, each counted once), as {@link repelledFloor} does.
 */
export function captureFloor(
  g: MapGraph,
  before: BoardState,
  after: BoardState,
  playerId: number,
  settings: PlannerSettings = {},
  guard = (settings.oneArmyStandsGuard ?? true) ? 1 : 0,
  opts: { me?: number; orders?: MyOrders | undefined; bomb?: boolean } = {},
): ProvenCaptures {
  const none: ProvenCaptures = { territories: [], attackers: 0, supply: 0, floor: 0 };
  if (settings.multiAttack) return none;
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  const { me, orders } = opts;
  const ordersKnown = !!orders?.sent && !!orders.cards;
  const touchedByMe = (id: number) =>
    !ordersKnown ||
    orders!.sent!.some((m) => m.from === id || m.to === id) ||
    orders!.moves.some((m) => m.from === id || m.to === id) ||
    orders!.cards!.some((c) => c.from === id || c.to === id || c.target === id);
  const its = (t: TerritoryState | undefined) => t?.owner.kind === 'player' && t.owner.playerId === playerId;
  const sendable = (id: number) => {
    const st = visibleState(was.get(id))!;
    return Math.max(0, st.armies! - guard) + specialUnitStrength(st.specialUnits?.filter((u) => u.playerId === playerId));
  };
  const lastKill = guaranteedKills(1, settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE, settings.luckModifier, settings.roundingMode);
  const caps: { id: number; attackers: number; beside: number[] }[] = [];
  for (const t of [...after.territories].sort((a, b) => a.territoryId - b.territoryId)) {
    const id = t.territoryId;
    if (!g.territoryById.has(id)) continue;
    const a = visibleState(t);
    const b = visibleState(was.get(id));
    if (!its(a) || !b || its(b) || a!.specialUnits?.length || b.specialUnits?.length) continue;
    const mineBefore = me !== undefined && b.owner.kind === 'player' && b.owner.playerId === me;
    if (b.owner.kind !== 'neutral' && !mineBefore) continue;
    const ns = neighborsOf(g, id);
    let ok = true;
    let bordersMe = false;
    const beside: number[] = [];
    for (const n of ns) {
      const o = ownerShown(was.get(n));
      if (!o) {
        ok = false;
        break;
      }
      for (const side of [o, ownerShown(now.get(n))]) {
        if (side?.owner.kind !== 'player' || side.owner.playerId === playerId) continue;
        if (side.owner.playerId === me) bordersMe = true;
        else ok = false;
      }
      if (its(o)) {
        if (!visibleState(o)) ok = false;
        else beside.push(n);
      }
    }
    if (!ok || ((mineBefore || bordersMe) && touchedByMe(id))) continue;
    const defenders = opts.bomb ? Math.floor(b.armies! / 2) : b.armies!;
    const kill = fewestAttackersAnySplit(defenders, settings);
    if (kill === null) continue;
    const attackers = Math.max(kill, a!.armies! + (defenders > 0 ? lastKill : 0));
    caps.push({ id, attackers, beside });
  }
  if (!caps.length) return none;
  const supplyOf = (ids: Iterable<number>) => [...new Set(ids)].reduce((n, id) => n + sendable(id), 0);
  const all = { attackers: caps.reduce((n, c) => n + c.attackers, 0), supply: supplyOf(caps.flatMap((c) => c.beside)) };
  let best: ProvenCaptures = { territories: caps.map((c) => c.id), ...all, floor: Math.max(0, all.attackers - all.supply) };
  for (const c of caps) {
    const supply = supplyOf(c.beside);
    if (c.attackers - supply > best.floor) best = { ...best, attackers: c.attackers, supply, floor: c.attackers - supply };
  }
  return best;
}

/** #240: the turns {@link repulsedAttacks} looks back over, ending on the board being planned. */
export const REPULSE_WINDOW = 3;
/** #240: failed, reinforced attacks on one territory within the window that make it repulsed. */
export const REPULSE_MIN = 2;

/** #240: one failed attack of mine on a territory whose owner reinforced it ({@link repulsedAttacks}). */
export interface RepulsedAttack {
  /** The turn I sent it on (the board it was planned on). */
  turn: number;
  /** The armies I sent: every move of mine onto it that turn whose kills count (a source mine on both boards). */
  armies: number;
  /** Its armies on that turn's board, and on the next. */
  before: number;
  after: number;
  /** What my attackers killed there, straight-rounded at the offensive kill rate ({@link failedAttackKills}). */
  kills: number;
}

/** #240: a territory my attacks failed on repeatedly while its owner reinforced it. */
export interface RepulsedTarget {
  territoryId: number;
  /** Its owner, on every board read and on the newest. */
  playerId: number;
  /** The failed, reinforced attacks, oldest first ({@link REPULSE_MIN} or more). */
  attacks: RepulsedAttack[];
}

/**
 * #240: repeated failure is evidence. Over my board history (`boards`, the newest being the board
 * being planned; consecutive turns only, each with my cached orders — `TurnBoard.orders`, what
 * warapp_submit_turn sent), a failed attack of mine on a territory — its owner the same player on
 * both boards, my source mine on both ({@link failedAttackKills}) — whose owner reinforced it: its
 * armies after plus what my attack killed exceed its armies before (after = before + deploys and
 * transfers in − kills). A territory with such an attack on {@link REPULSE_MIN} or more of the last
 * {@link REPULSE_WINDOW} turns, still that player's on the newest board, is reported, by id. Kill
 * counts are straight-rounded expectations: luck can move them. Pure; unknown orders give nothing.
 */
export function repulsedAttacks(
  g: MapGraph,
  boards: readonly { turn: number; board: BoardState; orders?: MyOrders | undefined }[],
  me: number,
  rates: KillRates = {},
): RepulsedTarget[] {
  const sorted = [...boards].sort((a, b) => a.turn - b.turn);
  const newest = sorted[sorted.length - 1];
  if (!newest) return [];
  // #240 review: kept per territory and owner, so failed attacks on a territory under an earlier
  // owner never hide those under its newest one (the filter below keeps the newest owner's only).
  const found = new Map<string, RepulsedTarget>();
  for (let i = 0; i + 1 < sorted.length; i++) {
    const was = sorted[i]!;
    const now = sorted[i + 1]!;
    if (!was.orders || now.turn !== was.turn + 1 || was.turn < newest.turn - REPULSE_WINDOW) continue;
    const orders = was.orders;
    const before = new Map(was.board.territories.map((t) => [t.territoryId, t]));
    const after = new Map(now.board.territories.map((t) => [t.territoryId, t]));
    const owners = new Set<number>();
    for (const m of orders.moves) {
      const o = visibleState(before.get(m.to))?.owner;
      if (o?.kind === 'player' && o.playerId !== me) owners.add(o.playerId);
    }
    for (const p of [...owners].sort(byNum)) {
      for (const [t, kills] of [...failedAttackKills(g, was.board, now.board, me, p, orders, rates)].sort(([a], [b]) => a - b)) {
        const b = visibleState(before.get(t))!.armies!;
        const a = visibleState(after.get(t))!.armies!;
        if (kills <= 0 || a + kills <= b) continue;
        const armies = failedAttackMoves(g, was.board, now.board, me, p, orders)
          .filter((m) => m.to === t)
          .reduce((n, m) => n + Math.max(0, m.armies), 0);
        // #361: a single-army jab never tries to take it (one army takes no defended territory): no evidence.
        if (armies <= 1) continue;
        const attack: RepulsedAttack = { turn: was.turn, armies, before: b, after: a, kills };
        const key = `${t}:${p}`;
        const entry = found.get(key);
        if (!entry) found.set(key, { territoryId: t, playerId: p, attacks: [attack] });
        else entry.attacks.push(attack);
      }
    }
  }
  const latest = new Map(newest.board.territories.map((t) => [t.territoryId, t]));
  return [...found.values()]
    .filter((r) => {
      const o = visibleState(latest.get(r.territoryId))?.owner;
      return r.attacks.length >= REPULSE_MIN && o?.kind === 'player' && o.playerId === r.playerId;
    })
    .sort((a, b) => a.territoryId - b.territoryId);
}

/**
 * One opponent's deploy last turn as seen across two boards (issues #57, #69): the *net*
 * change of its visible armies plus what it visibly lost attacking, floored at 0. Only
 * territories visible on both boards count ({@link visibleState}): one hidden last time
 * (fogged, or under a fog level that hid its armies) only came into view, so it is a fog
 * reveal whoever holds it now — never growth, never a capture.
 * - under it both times: armies now − armies then, shrinks included — a transfer between
 *   its own territories nets to zero, so it is never read as deploy;
 * - taken from another visible owner (another player, me included, or a visible neutral): what
 *   the capture cost it — the attackers the previous defenders killed at the game's defensive
 *   kill rate (`straightKills`, as in `armiesToTake`); taken from me (given `context.me`), the
 *   defenders are the guard I may have left, not my stack last turn (#123, `emptied`: I may have
 *   attacked out of it) — plus the armies now on it up to what its territories next to it, shown
 *   on both boards, visibly sent away (their total shrink, each army claimed by one capture only):
 *   those moved in from a visible source, whose shrink they cancel, so source shrink + destination
 *   gain nets to the attrition (issue #86). An unchanged visible neighbour sent nothing, so it
 *   explains nothing. The rest, when a neighbour was hidden on either board, is ambiguous (#123):
 *   a deploy on a visible source that shrank into it (`reinforced`), or a move out of the fog —
 *   never income (`fromFog`), still a threat to the borders next to it. With every neighbour in
 *   view it can only be a deploy on the source.
 * - growth on its territory next to a hidden one is ambiguous the same way (`grewFromFog`).
 * Ambiguous armies count as deploy while the turn's total stays within {@link ambiguousBound}
 * (twice `context.expected`, never past `context.most`); the rest are moves. Without `expected`,
 * growth is all deploy and a capture's surplus counts up to `most` (none without it, #86).
 * `low` and `high` read every ambiguous army one way or the other (fog moves and the guard, or
 * deploys and my stack standing there).
 * Not counted: armies it lost on a territory it attacked but did not take. The defender's
 * count there also moves with the defender's own deploys and transfers (mine included —
 * this board says nothing about my orders), so the loss cannot be read off it; leaving it
 * out keeps the figure a lower bound (the failed attack's losses still shrink its source). The
 * opponent tracker adds it back when my orders that turn are known (#119, `measureOrders`).
 * Given those orders here (`context.myOrders`, #226), the defenders my failed attack killed on a
 * territory that stayed its count back into its growth there (`attacked`, `attackKills`): after =
 * before + deploy + transfers in − kills, so deploy ≥ after + kills − before — beside the fog an
 * ambiguous growth like any other, read as deploy up to the turn's bound. #271: given those orders,
 * a failed attack on a hold of mine bounds the deploy from below ({@link repelledFloor}: `deploy`,
 * `low` and `high` never below it), and so does a capture with every source army in view (#418,
 * {@link captureFloor}: proof may always raise an estimate). A capture also claims, after the visible sources, what its stacks
 * in view last turn and hidden now could have sent (`arrivals`: no figure counts them but `high`); a
 * capture of a neutral beside the fog that no visible source sent into reads the attackers it needed
 * beyond its cost ({@link fewestAttackersToTake}) as ambiguous, deploy up to the bound
 * (`unseenAttackers`; the tracker reads a pattern of them as income), the rest a move out of the fog.
 * One turn only, not smoothed (the tracker reads a history). Transfers in from (or out to) the
 * fog still bias it — income in the fog is unseen anyway.
 */
export function observeDeploy(
  g: MapGraph,
  board: BoardState,
  previous: BoardState,
  playerId: number,
  rates: PlannerSettings = {},
  context: ObserveContext = {},
): DeployObservation {
  const { signed: _signed, ...o } = observeSigned(g, board, previous, playerId, rates, context);
  return o;
}

/**
 * {@link observeDeploy} with its total before the floor at 0 (`signed`): the opponent tracker
 * adds what my own orders measure (#119) to it before flooring.
 */
export function observeSigned(
  g: MapGraph,
  board: BoardState,
  previous: BoardState,
  playerId: number,
  rates: PlannerSettings = {},
  context: ObserveContext = {},
): DeployObservation & { signed: number } {
  const before = new Map(previous.territories.map((t) => [t.territoryId, t]));
  let total = 0;
  /** What `low` and `high` differ from `total` by. */
  let lowExtra = 0;
  let highExtra = 0;
  const counted: number[] = [];
  const captured: number[] = [];
  const fromFog: number[] = [];
  let fogArmies = 0;
  const reveals: number[] = [];
  const reinforced: number[] = [];
  const emptied: number[] = [];
  let emptiedHigh = 0;
  /**
   * The ambiguous armies (#123): growth on its held territories next to a hidden one (a stack
   * may have walked in) and a capture's surplus over what a visible source that shrank into it
   * sent (deploy-then-capture, or a stack out of the fog joined). Read after the loop against
   * one bound, the same for both ({@link ambiguousBound}).
   */
  const ambiguous: { id: number; armies: number; kind: 'growth' | 'capture' | 'needed' }[] = [];
  const now = new Map(board.territories.map((t) => [t.territoryId, t]));
  const defensive = rates.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const guard = Math.max(0, context.guard ?? 1);
  // #226: my failed attacks' kills, by target: they count back into its growth there.
  const kills =
    context.me !== undefined && context.myOrders
      ? failedAttackKills(g, previous, board, context.me, playerId, context.myOrders, rates)
      : new Map<number, number>();
  const killsAt = (id: number) => kills.get(id) ?? 0;
  /** Held by the observed player (`playerId`, not me) and shown with armies on both boards. */
  const heldBothTimes = (id: number) => {
    const a = visibleState(now.get(id));
    const b = visibleState(before.get(id));
    return a?.owner.kind === 'player' && a.owner.playerId === playerId && b?.owner.kind === 'player' && b.owner.playerId === playerId;
  };
  /**
   * What each of its territories shown with armies on both boards visibly sent away (its
   * shrink): the most a capture next to it can have received from it. A capture draws on it
   * (ascending ids), so two captures never both claim the same armies. What my failed attack killed
   * there (#226: these are exactly {@link failedAttackKills}' targets) is a loss, not armies sent
   * away, so it is taken out of the shrink.
   */
  const shrinkLeft = new Map<number, number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && heldBothTimes(t.territoryId))
      shrinkLeft.set(t.territoryId, Math.max(0, visibleState(before.get(t.territoryId))!.armies! - t.armies! - killsAt(t.territoryId)));
  /** Not shown with armies on both boards: armies could have left it unseen. */
  const hidden = (id: number) => !visibleState(now.get(id)) || !visibleState(before.get(id));
  // #294: each grown stack's growth split, against its own copy of the shrinks (captures claim theirs below).
  // The stacks with no hidden neighbour claim first (what they leave can only be deploy, so a shrink
  // taken by a stack beside the fog would turn a move into a false "can only be deploy"), then those
  // beside the fog; each in id order, and reported in id order.
  const stacks: StackGrowth[] = [];
  const shrinkForSplit = new Map(shrinkLeft);
  const grown = [...shrinkLeft.keys()]
    .sort(byNum)
    .map((id) => ({
      id,
      growth: visibleState(now.get(id))!.armies! - visibleState(before.get(id))!.armies! + killsAt(id),
      beside: neighborsOf(g, id).some(hidden),
    }))
    .filter((x) => x.growth > 0);
  for (const { id, growth, beside } of [...grown.filter((x) => !x.beside), ...grown.filter((x) => x.beside)]) {
    let left = growth;
    const moved: StackGrowth['moved'] = [];
    for (const n of [...neighborsOf(g, id)].sort(byNum)) {
      const can = shrinkForSplit.get(n);
      if (!can || !left) continue;
      const take = Math.min(can, left);
      shrinkForSplit.set(n, can - take);
      left -= take;
      moved.push({ from: n, armies: take });
    }
    stacks.push({ territoryId: id, growth, moved, fog: beside ? left : 0, deploy: beside ? 0 : left });
  }
  stacks.sort((a, b) => a.territoryId - b.territoryId);
  /**
   * #271 (3): its territories shown with armies on the earlier board and hidden on the later one: what
   * each could have sent (its armies less the guard), the most a capture beside it can have received
   * from it. Claimed after `shrinkLeft`, in ascending ids, each army once.
   * #271 review, a known under-read: a stack hidden now is claimed whether or not it emptied, and it is
   * usually hidden because the capture took my territory and my sight of it with it. So a real
   * deploy-then-capture beside a source in view both times and such a stack reads its surplus as an
   * arrival (counted only in `high`), not deploy. Accepted: a merge read as deploy once read +45.
   */
  const hiddenLeft = new Map<number, number>();
  for (const t of previous.territories) {
    const b = visibleState(t);
    if (!g.territoryById.has(t.territoryId) || b?.owner.kind !== 'player' || b.owner.playerId !== playerId) continue;
    if (!visibleState(now.get(t.territoryId))) hiddenLeft.set(t.territoryId, Math.max(0, b.armies! - guard));
  }
  let arrivals = 0;
  const unseenAttackers: number[] = [];
  let unseenAttackerArmies = 0;
  for (const t of [...board.territories].sort((a, b) => a.territoryId - b.territoryId)) {
    if (!g.territoryById.has(t.territoryId) || !visibleState(t)) continue;
    if (t.owner.kind !== 'player' || t.owner.playerId !== playerId) continue;
    const was = visibleState(before.get(t.territoryId));
    if (!was) {
      reveals.push(t.territoryId);
      continue;
    }
    counted.push(t.territoryId);
    const ns = [...neighborsOf(g, t.territoryId)].sort((a, b) => a - b);
    if (was.owner.kind === 'player' && was.owner.playerId === playerId) {
      // #226: what my failed attack killed there stood there too: defenders after = before + deploy
      // + transfers in − kills.
      const growth = t.armies! - was.armies! + killsAt(t.territoryId);
      if (growth > 0 && ns.some(hidden)) ambiguous.push({ id: t.territoryId, armies: growth, kind: 'growth' });
      else total += growth;
    } else {
      captured.push(t.territoryId);
      // What the capture cost it, always. Taken from me (#123), the defenders were what I left
      // there, which this board cannot tell (I may have attacked out of it): priced at the guard,
      // my stack last turn the high reading.
      if (context.me !== undefined && was.owner.kind === 'player' && was.owner.playerId === context.me) {
        const least = straightKills(Math.min(was.armies!, guard), defensive);
        total += least;
        highExtra += straightKills(was.armies!, defensive) - least;
        emptiedHigh += straightKills(was.armies!, defensive) - least;
        emptied.push(t.territoryId);
      } else total += straightKills(was.armies!, defensive);
      // The armies standing there only as far as a visible source's shrink accounts for them
      // (it cancels them). Beyond that, with a neighbour that was hidden on either board: when a
      // visible source did shrink into it, the attack came from that stack and the rest was
      // deployed on it first (deploy-then-capture, #123); when none did, the rest arrived from
      // the fog — a move, not income (#86). With no hidden neighbour, the rest can only be a
      // deploy on a visible source before it attacked.
      let arrived = t.armies!;
      let claimed = 0;
      for (const n of ns) {
        const left = shrinkLeft.get(n);
        if (!left || !arrived) continue;
        const take = Math.min(left, arrived);
        shrinkLeft.set(n, left - take);
        arrived -= take;
        claimed += take;
        total += take;
      }
      // #271 (3): its stacks in view last turn beside it, hidden now, may have moved in: arrivals.
      let came = 0;
      for (const n of ns) {
        const left = hiddenLeft.get(n);
        if (!left || !arrived) continue;
        const take = Math.min(left, arrived);
        hiddenLeft.set(n, left - take);
        arrived -= take;
        came += take;
      }
      arrivals += came;
      // Had its source stayed put (hidden now, it may have), they were deployed: the high reading.
      highExtra += came;
      if (arrived > 0 && ns.some(hidden)) {
        // #271 (2): a neutral in view needed attackers; what stands there beyond what its stacks in
        // view sent, up to what that need leaves standing, came from out of sight.
        let unseen = 0;
        if (was.owner.kind === 'neutral') {
          const need = fewestAttackersToTake(was.armies!, rates, rates.luckModifier, rates.roundingMode);
          const cost = straightKills(was.armies!, defensive);
          unseen = need === null ? 0 : Math.min(arrived, Math.max(0, need - cost - claimed - came));
          if (unseen > 0) {
            unseenAttackers.push(t.territoryId);
            // The attackers out of sight: what the capture needed less what came from view
            // (need − claimed − came), within what stands there.
            unseenAttackerArmies += unseen + cost;
          }
        }
        if (claimed > 0) ambiguous.push({ id: t.territoryId, armies: arrived, kind: 'capture' });
        else {
          if (unseen > 0) ambiguous.push({ id: t.territoryId, armies: unseen, kind: 'needed' });
          const rest = arrived - unseen;
          if (rest > 0) {
            fromFog.push(t.territoryId);
            fogArmies += rest;
            highExtra += rest;
          }
        }
      } else total += arrived;
    }
  }
  // #123: the ambiguous armies, read as deploy up to one bound on the turn's deploy — the same
  // bound for growth beside the fog and a reinforced capture's surplus, shared in id order —
  // and the rest as moves out of the fog. The low reading takes all of them out, the high one
  // counts all of them.
  const grewFromFog: number[] = [];
  let fogGrowth = 0;
  const bound = ambiguousBound(context);
  // Without an expected deploy (a board-only reading), growth is all deploy, as before #123.
  if (bound === null)
    for (const x of ambiguous) if (x.kind === 'growth') total += x.armies;
  // A board-only reading (neither `expected` nor `most`) has no room at all: a negative total (a
  // stack of its own that shrank into the fog) must not make room for a capture's surplus.
  let room = bound === null && context.most === undefined ? 0 : Math.max(0, (bound ?? Math.max(0, context.most!)) - total);
  // #293: under Local Deployment, the territories a bonus pool could have paid into on the turn read
  // (the bonuses it could hold on the earlier board); growth beside the fog elsewhere draws on `freeLeft`.
  const local = rates.localDeployments === true && bound !== null && context.localFree !== undefined;
  const pooledOn = new Set<number>();
  if (local)
    for (const b of g.map.bonuses) {
      if (b.value <= 0) continue;
      const ts = bonusTerritories(g, b.id);
      const possible = ts.every((t) => {
        const o = ownerShown(before.get(t))?.owner;
        return o === undefined || (o.kind === 'player' && o.playerId === playerId);
      });
      if (possible) for (const t of ts) pooledOn.add(t);
    }
  let freeLeft = Math.max(0, context.localFree ?? 0);
  const localCut: number[] = [];
  // #293 review: a walled growth's walk draws on the shrink the captures left (`shrinkLeft`, after
  // the capture loop), less what the other grown stacks' splits took (their growth already nets it),
  // in ascending ids: one claim pass, so one neighbour's shrink never offsets a capture and a walk both.
  const walled = (x: (typeof ambiguous)[number]) => local && x.kind === 'growth' && !pooledOn.has(x.id);
  const walkLeft = new Map(shrinkLeft);
  if (local) {
    const walledIds = new Set(ambiguous.filter(walled).map((x) => x.id));
    for (const st of stacks)
      if (!walledIds.has(st.territoryId))
        for (const m of st.moved) walkLeft.set(m.from, Math.max(0, (walkLeft.get(m.from) ?? 0) - m.armies));
  }
  for (const x of [...ambiguous].sort((a, b) => a.id - b.id)) {
    if (bound === null && x.kind === 'growth') {
      lowExtra -= x.armies;
      continue;
    }
    // #293: a walk from a neighbour in view (the growth split) nets its shrink; the rest is deploy only
    // as far as the free income still reaches.
    const isWalled = walled(x);
    let walk = 0;
    if (isWalled)
      for (const n of [...neighborsOf(g, x.id)].sort(byNum)) {
        const can = walkLeft.get(n);
        if (!can || walk >= x.armies) continue;
        const take = Math.min(can, x.armies - walk);
        walkLeft.set(n, can - take);
        walk += take;
      }
    total += walk;
    room = Math.max(0, room - walk);
    const deployed = Math.min(x.armies - walk, room, isWalled ? freeLeft : Infinity);
    if (isWalled) freeLeft -= deployed;
    room -= deployed;
    total += deployed;
    lowExtra -= deployed;
    const moved = x.armies - walk - deployed;
    if (isWalled && moved > 0) localCut.push(x.id);
    highExtra += moved;
    if (x.kind === 'capture') {
      if (deployed > 0) reinforced.push(x.id);
      if (moved > 0) fromFog.push(x.id);
    } else if (x.kind === 'needed') {
      if (moved > 0 && !fromFog.includes(x.id)) fromFog.push(x.id);
    } else if (moved > 0) {
      grewFromFog.push(x.id);
      fogGrowth += moved;
    }
    fogArmies += moved;
  }
  fromFog.sort((a, b) => a - b);
  // #271 (1): a failed attack on a hold of mine bounds its deploy from below, fog or not.
  const repelled =
    context.me !== undefined && context.myOrders
      ? repelledFloor(g, previous, board, context.me, playerId, context.myOrders, rates, guard, context.bomb === true)
      : { territories: [], floor: 0 };
  // #418: a capture with every source army in view proves a minimum deploy, fog or not.
  const proof = captureFloor(g, previous, board, playerId, rates, guard, {
    ...(context.me !== undefined ? { me: context.me } : {}),
    orders: context.myOrders,
    bomb: context.bomb === true,
  });
  const floor = Math.max(repelled.floor, proof.floor);
  return {
    stacks,
    deploy: Math.max(0, total, floor),
    signed: total,
    counted,
    captured,
    fromFog,
    fogArmies,
    reveals,
    reinforced,
    grewFromFog,
    fogGrowth,
    ...(localCut.length ? { localCut: { free: Math.max(0, context.localFree ?? 0), territories: localCut } } : {}),
    expected: context.expected ?? null,
    attacked: [...kills.keys()].sort(byNum),
    attackKills: [...kills.values()].reduce((n, k) => n + k, 0),
    emptied,
    emptiedHigh,
    arrivals,
    unseenAttackers,
    unseenAttackerArmies,
    repelled: repelled.territories,
    repelledFloor: repelled.floor,
    proven: proof.territories,
    captureFloor: proof.floor,
    low: Math.max(0, total + lowExtra, floor),
    high: Math.max(0, total + highExtra, floor),
  };
}

/**
 * How much more than it was expected to deploy an opponent may earn unseen (#123 review): under
 * fog the visible income reads 2–3× low (#119), so ambiguous armies count as deploy up to twice
 * the expected figure. A one-off stack out of the fog is not read as a phantom income; a steady
 * hidden bonus (as large as the visible income) still is, and the tracker, which raises the
 * expected figure to its carried income, learns a larger one over a few turns.
 */
export const HIDDEN_INCOME_FACTOR = 2;

/**
 * The most an opponent's deploy may total once ambiguous armies are counted (#123): twice what
 * it was expected to deploy ({@link HIDDEN_INCOME_FACTOR}), never more than it could earn
 * (`most`). Null without an expected figure: then growth is all deploy and a capture's surplus
 * counts up to `most` (none without it, #86).
 */
function ambiguousBound(context: ObserveContext): number | null {
  if (context.expected === undefined) return null;
  const twice = HIDDEN_INCOME_FACTOR * Math.max(0, context.expected);
  return context.most !== undefined ? Math.min(Math.max(0, context.most), twice) : twice;
}

/** {@link observeDeploy}'s deploy figure alone. */
export function observedDeploy(
  g: MapGraph,
  board: BoardState,
  previous: BoardState,
  playerId: number,
  rates: KillRates = {},
): number {
  return observeDeploy(g, board, previous, playerId, rates).deploy;
}

