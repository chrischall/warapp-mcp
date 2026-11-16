// #281: land a player who is out left behind (a static seat, #270), and what taking it denies; and the
// owner's extension, empty enemy territory with the guard off. The judgements are pure; pass 3's
// target bookkeeping and capture (`addEmptyEnemyTargets`, `tryEmptyEnemy`) change the plan state.
//
// planTurn plans a static seat's territories as neutrals; `BoardCtx.vacated` keeps which ones they
// were. Such a territory beside a live opponent is one that opponent takes next turn, for next to
// nothing, when its stack there can (nobody defends it but its static armies), so the border it would add comes
// either way: taking it first moves the front one step out, onto land the opponent would otherwise
// gain. Rule 4d's frontier budget therefore never refuses a cheap one on its hold cost alone, and
// pass 3 ranks it with the denial credited — a credit that can put it ahead of every plain capture
// (its score may fall to 0 or below, where a plain capture's never goes below one army). Everything
// else is as any neutral: the capture spends only the armies above what holds its source (#121), and
// is sized at its cost (the fewest that take it).
//
// The owner's extension (#281, 2026-11-16): with One Army Must Stand Guard off, a live opponent's own
// territory beside mine standing at 0 (no special unit) that breaks none of its bonuses (that is
// #165's one-army break) and was not mine on the previous board (#276's retake) is cheap expansion
// too (`emptyEnemiesOf`). Pass 3 takes it, sized for its owner's deploy there (#120) when a source
// can pay that, else at its bare cost with #120's warning, ranked as a capture of that size; rule 4d
// does not undo it when the border it adds faces only enemy territories a border of mine beside it
// already faces (`sameFront`: the front moves one step, no new exposure). A border to a new stack is
// judged by rule 4d as before. Never a truce's covered territory, one my attacks failed on (#240) or
// one lowering income; the capture spends what stands above its source's hold, as any.
import { neighborsOf } from '../graph.js';
import type { BoardState } from '../../board.js';
import type { Captures } from './captures.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Targets } from './targets.js';

/** The end of every empty enemy capture's reason (#281, the owner's extension): tests and sweeps match on it. */
export const CHEAP_EXPANSION = 'cheap expansion (#281)';

/** A vacated territory costing at most this many armies to take is cheap enough to deny (#281). */
export const VACATED_MAX_COST = 2;

/** What taking a vacated territory denies the opponent beside it (#281). */
export interface Denial {
  /** The live opponent that would take it free: the one it gives the most, then the lowest id. */
  player: number;
  /** My capture cost. */
  cost: number;
  /** The income it would give that opponent: a bonus it completes, else its share of the bonuses it advances. */
  progress: number;
  /** The bonuses it completes for that opponent, by id. */
  completes: number[];
}

/** The vacated territories that are denials (#281), by territory: {@link denialOf} over them, computed once. */
export function denialsOf(pc: PlanCtx): Map<number, Denial> {
  const out = new Map<number, Denial>();
  for (const t of [...pc.vacated.keys()].sort((a, b) => a - b)) {
    const d = denialOf(pc, t);
    if (d) out.set(t, d);
  }
  return out;
}

/**
 * What capturing `t` denies (#281), or `null`: `t` must be vacated by a static seat (still a neutral
 * on this board), cost me at most {@link VACATED_MAX_COST}, and border a visible live opponent's stack
 * that can take it with the armies it has (a teammate never counts).
 */
export function denialOf(pc: PlanCtx, t: number): Denial | null {
  if (!pc.vacated.has(t) || pc.territories.get(t)?.owner.kind !== 'neutral') return null;
  const cost = pc.costAt(t);
  if (cost === null || cost > VACATED_MAX_COST) return null;
  let best: Denial | null = null;
  for (const n of [...neighborsOf(pc.g, t)].sort((a, b) => a - b)) {
    const o = pc.territories.get(n);
    if (o?.owner.kind !== 'player' || !pc.foe(o.owner.playerId) || pc.allies.has(o.owner.playerId)) continue;
    if (o.armies === null || o.armies - pc.guard < cost) continue;
    const player = o.owner.playerId;
    const holds = (x: number) => {
      const s = pc.territories.get(x);
      return s?.owner.kind === 'player' && s.owner.playerId === player;
    };
    let progress = 0;
    const completes: number[] = [];
    for (const id of pc.bonusesWith.get(t) ?? []) {
      const value = pc.g.bonusById.get(id)?.value ?? 0;
      const members = pc.bonusTs.get(id) ?? [];
      if (value <= 0 || !members.length) continue;
      const others = members.filter((x) => x !== t);
      const theirs = others.filter(holds).length;
      if (theirs === others.length) {
        progress += value;
        completes.push(id);
      } else if (theirs > 0) progress += value / members.length;
    }
    progress = Math.round(progress * 100) / 100;
    if (!best || progress > best.progress) best = { player, cost, progress, completes };
  }
  return best;
}

/**
 * A denial's credit in a score, in armies: the territory the opponent would gain (1) plus its income
 * over the payback horizon.
 */
export function denialCredit(pc: PlanCtx, d: Denial): number {
  return 1 + pc.paybackTurns * d.progress;
}

/** The rationale line for a vacated territory taken though it adds a border facing an enemy (#281). */
export function denialLine(pc: PlanCtx, t: number, d: Denial): string {
  const by = `player ${pc.vacated.get(t)}`;
  const gives = d.completes.length
    ? `, completing bonus ${d.completes.map((id) => `${pc.bonusName(id)} (+${pc.g.bonusById.get(id)!.value})`).join(', ')} for it`
    : d.progress > 0
      ? `, toward its bonuses (~+${d.progress} a turn)`
      : '';
  const takes = d.cost <= 1 ? 'free' : `for ${d.cost}`;
  return `Take ${pc.label(t)} though it faces player ${d.player}: ${by} left it (out, no AI), it costs ${d.cost}, and player ${d.player} would take it ${takes} next turn${gives} — the border comes either way (#281).`;
}

/** #281 (owner's extension): an empty territory of a live opponent beside mine, with the guard off. */
export interface EmptyEnemy {
  /** Its owner. */
  player: number;
  /** #120: what its owner may deploy there before my attack lands. */
  extra: number;
  /** The armies that take it even if its owner deploys {@link extra} there first; `null` when that is its bare cost. */
  sure: number | null;
  /** The armies that take it as it stands. */
  bare: number;
  /** The border it adds faces only enemy territories a border of mine beside it already faces. */
  sameFront: boolean;
  /** The enemy territories (and hidden ones) beside it, by id. */
  faces: number[];
}

/**
 * #281 (owner's extension): the empty enemy territories pass 3 may take, by territory. Only with One
 * Army Must Stand Guard off, not under No-Split, under a guarded goal (`expand` never attacks a
 * player; `complete-bonus` makes no plain expansion): a live opponent's territory (never a
 * teammate's) beside mine, in view at 0 with no special unit, whose owner holds no positive bonus it
 * is in (#165 breaks those), not mine on `previousBoard` (#276 retakes those), not already a target
 * (a counter-attack), never a truce's covered territory, one my attacks failed on (#240) or one whose
 * capture lowers income. Pure.
 */
export function emptyEnemiesOf(
  pc: PlanCtx,
  previousBoard: BoardState | undefined,
  reinforcementAt: (t: number) => number,
  skip: (t: number) => boolean,
): Map<number, EmptyEnemy> {
  const { g, territories: state, mineSet, foe, allies, guard, noSplit, guarded, unitsAt, uncounted, costAt, me } = pc;
  const out = new Map<number, EmptyEnemy>();
  if (guard || noSplit || !guarded) return out;
  const was = new Map(previousBoard?.territories.map((t) => [t.territoryId, t.owner]));
  const enemyOf = (id: number) => {
    const o = state.get(id)?.owner;
    return o?.kind === 'player' && foe(o.playerId) && !allies.has(o.playerId) ? o.playerId : undefined;
  };
  /** A neighbour a stack may stand on: an enemy's, or one whose owner or armies the board hides. */
  const exposure = (id: number) => {
    if (mineSet.has(id)) return false;
    const st = state.get(id);
    if (!st || st.owner.kind === 'unknown' || st.armies === null) return true;
    return enemyOf(id) !== undefined;
  };
  for (const t of [...state.keys()].sort((a, b) => a - b)) {
    const st = state.get(t)!;
    const player = enemyOf(t);
    if (player === undefined || st.armies !== 0 || st.specialUnits?.length || unitsAt(t) > 0 || uncounted(t)) continue;
    const near = neighborsOf(g, t);
    if (!near.some((n) => mineSet.has(n)) || skip(t)) continue;
    const before = was.get(t);
    if (before?.kind === 'player' && before.playerId === me) continue;
    const breaks = [...g.bonusById.values()].some(
      (b) =>
        b.value > 0 &&
        b.territoryIds.includes(t) &&
        b.territoryIds.every((x) => {
          const o = state.get(x)?.owner;
          return o?.kind === 'player' && o.playerId === player;
        }),
    );
    if (breaks) continue;
    const bare = costAt(t);
    if (bare === null) continue;
    const extra = reinforcementAt(t);
    const sureCost = extra > 0 ? costAt(t, extra) : null;
    const sure = sureCost !== null && sureCost > bare ? sureCost : null;
    const faces = near.filter(exposure).sort((a, b) => a - b);
    const already = new Set(near.filter((n) => mineSet.has(n)).flatMap((n) => neighborsOf(g, n).filter((x) => x !== t && exposure(x))));
    out.set(t, { player, extra, sure, bare, sameFront: faces.every((x) => already.has(x)), faces });
  }
  return out;
}

/** The rationale line for an empty enemy territory rule 4d let through on the same front (#281). */
export function emptyEnemyLine(pc: PlanCtx, t: number, e: EmptyEnemy): string {
  const faces = e.faces.map(pc.label).join(', ');
  return `Take ${pc.label(t)} though it adds a border facing an enemy: One Army Must Stand Guard is off and player ${e.player} left it empty, and the border it adds faces only ${faces}, which my borders beside it already face — the front moves one step, no new exposure (#281).`;
}

/**
 * Pass 3's order (and rule 5b's), computed once per target: capture cost plus the frontier it adds. A
 * denial (#281) pays no hold need there — its border comes either way — and is credited with
 * {@link denialCredit}, so it can outrank every plain capture. An empty enemy territory (#281's
 * extension) costs the size it is first tried at (its sure size, else its bare one), plus the
 * frontier without its own hold need when its border is on the same front, else the whole frontier.
 */
export function plainOrderCosts(
  pc: PlanCtx,
  tgt: Pick<Targets, 'targetScoreCost' | 'landScoreCost' | 'denials' | 'emptyEnemies' | 'scoreCost' | 'frontierDelta'>,
  ids: Iterable<number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const t of ids) {
    const d = tgt.denials.get(t);
    const e = tgt.emptyEnemies.get(t);
    if (d) out.set(t, tgt.landScoreCost(t) - denialCredit(pc, d));
    else if (e) {
      const size = e.sure ?? e.bare;
      const frontier = tgt.frontierDelta(pc.mineSet, [t], (x) => (x === t ? size : pc.armiesOf(x)), !e.sameFront).armies;
      out.set(t, tgt.scoreCost(size, frontier));
    } else out.set(t, tgt.targetScoreCost(t));
  }
  return out;
}

/**
 * #281 (the owner's extension): make the empty enemy territories pass 3 may take targets, before it
 * ranks them (with their frontier cost alone, as every target has). Returns their ids.
 */
export function addEmptyEnemyTargets(pc: PlanCtx, ps: PlanState, tgt: Pick<Targets, 'targets' | 'emptyEnemies' | 'edgeCost' | 'frontierDelta' | 'survivorsOf'>): number[] {
  const added: number[] = [];
  for (const [t, e] of tgt.emptyEnemies) {
    if (ps.captured.has(t) || tgt.targets.has(t)) continue;
    tgt.targets.set(t, { id: t, cost: e.bare, enemy: true, sources: neighborsOf(pc.g, t).filter((x) => pc.mineSet.has(x)) });
    tgt.edgeCost.set(t, tgt.frontierDelta(pc.mineSet, [t], (x) => (x === t ? tgt.survivorsOf(t) : pc.armiesOf(x))).armies);
    added.push(t);
  }
  return added;
}

/** #281: after pass 3, an empty enemy territory it did not take is no target again (rule 4e and the rest size their own). */
export function dropEmptyEnemyTargets(ps: PlanState, tgt: Pick<Targets, 'targets' | 'edgeCost'>, added: readonly number[]): void {
  for (const t of added)
    if (!ps.captured.has(t)) {
      tgt.targets.delete(t);
      tgt.edgeCost.delete(t);
    }
}

/**
 * #281 (the owner's extension): pass 3's capture of an empty enemy territory. Sized first for what its
 * owner may deploy there before it lands (#120: no "assumes" warning, a worst case); only when no source
 * can pay that (a refusal — R3, a trade, rule 4d — stands) is it taken at its bare cost, with #120's
 * warning. What the #276 second line still lacks is kept out of this turn's deploy while it is tried,
 * so the capture is never paid from a held bonus's garrison.
 */
export function tryEmptyEnemy(
  pc: Pick<PlanCtx, 'commanderAt'>,
  ps: PlanState,
  book: Pick<DeployBook, 'secondLine' | 'secondLineKept'>,
  tgt: Pick<Targets, 'targets' | 'emptyEnemies'>,
  caps: Pick<Captures, 'tryExpand' | 'worstCase' | 'stopped'>,
  t: number,
): boolean {
  const e = tgt.emptyEnemies.get(t)!;
  const sources0 = tgt.targets.get(t)!.sources;
  const tg = notFromTransit(pc, tgt.targets.get(t)!);
  if (!tg.sources.length) return false;
  let owed = 0;
  for (const [id, x] of book.secondLine) owed += Math.max(0, x.size - (book.secondLineKept.get(id) ?? 0));
  const kept = Math.min(owed, Math.max(0, ps.budget));
  ps.budget -= kept;
  tgt.targets.set(t, tg);
  try {
    const reason = `player ${e.player}'s territory stands empty with One Army Must Stand Guard off: ${CHEAP_EXPANSION}`;
    if (e.sure !== null) {
      tgt.targets.set(t, { ...tg, cost: e.sure });
      caps.worstCase.set(t, e.extra);
      const ok = caps.tryExpand(t, `${reason}, sized to land even if player ${e.player} deploys its ~${e.extra} there first (#120)`);
      tgt.targets.set(t, ok ? { ...tg, cost: e.sure } : tg);
      if (ok) return true;
      caps.worstCase.delete(t);
      if (ps.refusal !== undefined || caps.stopped.some((x) => x.t === t)) return false;
    }
    return caps.tryExpand(t, reason);
  } finally {
    ps.budget += kept;
    const now = tgt.targets.get(t)!;
    tgt.targets.set(t, { ...now, sources: sources0 });
  }
}

/**
 * #281 × #282: the territory my commander walks from this turn, or `undefined`. Everything standing
 * there is its transit hold (`commanderTransit` sizes the hold on the whole stack until the walk runs),
 * so no #281 capture — a denial or an empty enemy territory — is ever sourced from it. My commander's
 * territory when it stays needs no such rule: `keepOf` keeps its worst-case hold (rule 1w) from every capture.
 */
export function commanderTransitFrom(pc: Pick<PlanCtx, 'commanderAt'>): number | undefined {
  return pc.commanderAt?.retreat?.from;
}

/** `tg` without the territory my commander walks from among its sources (#281 × #282). */
export function notFromTransit<T extends { sources: number[] }>(pc: Pick<PlanCtx, 'commanderAt'>, tg: T): T {
  const from = commanderTransitFrom(pc);
  return from === undefined || !tg.sources.includes(from) ? tg : { ...tg, sources: tg.sources.filter((x) => x !== from) };
}

/**
 * #281 × #282: try a denial's capture with the territory my commander walks from left out of its
 * sources, its sources restored after (the capture itself keeps no reference to the list).
 */
export function withoutTransit(pc: Pick<PlanCtx, 'commanderAt'>, tgt: Pick<Targets, 'targets'>, t: number, attempt: () => boolean): boolean {
  const tg = tgt.targets.get(t)!;
  const narrowed = notFromTransit(pc, tg);
  if (narrowed === tg) return attempt();
  if (!narrowed.sources.length) return false;
  tgt.targets.set(t, narrowed);
  try {
    return attempt();
  } finally {
    tgt.targets.set(t, { ...tgt.targets.get(t)!, sources: tg.sources });
  }
}
