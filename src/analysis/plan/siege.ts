// The siege goal (#382): against one opponent, break its cheapest bonuses every turn and hold the main
// assault until it is weakened. `goal: 'siege'` plans as `balanced` does, with three changes:
//   1. the target's bonus breaks are scored `SIEGE_BREAK_WEIGHT` × a 1v1 break (never skipped as a
//      second front), so the cheapest breaks per income lost are funded first (planner rule 4a);
//   2. until the assault trigger fires, no pass attacks the target's territories other than the
//      members of its breakable bonuses (they join the truce's no-target set, as #375's avoid does);
//   3. the spare deploys build one strike stack facing the target (rule 0p.3c, in any format), which
//      only grows (or breaks) until the trigger fires, and then strikes as the 1v1 stack does.
// The trigger reads the target's income now against its baseline (the most the tracker saw it
// deploy over its window, or now), my income against its, and a stack of mine able to take a member
// of one of its held bonuses against its whole deploy. The siege's memory (`SiegeMemory`, kept per game by
// src/siege-store.ts) adds the target's income on the siege's first turn to the baseline, and reports the
// siege's turns, the target's income trend and the bonuses broken and broken again.
import type { TerritoryState } from '../../board.js';
import { bonusTerritories } from '../bonuses.js';
import { neighborsOf, type MapGraph } from '../graph.js';
import type { OpponentTrack } from '../opponents.js';
import { captureCost, ownerShown, TRACKED_MIN_TURNS, type PlannerSettings } from './shared.js';

/** A target's break is scored this many times a 1v1 break, so breaks outrank completions and advances. */
export const SIEGE_BREAK_WEIGHT = 3;
/** The assault is released once the target's income falls to this share of its baseline. */
export const SIEGE_INCOME_DROP = 0.6;
/** … or my income reaches this multiple of the target's. */
export const SIEGE_INCOME_LEAD = 1.8;

export interface Breakable {
  bonusId: number;
  value: number;
  player: number;
  /** Why an inferred bonus is probably held (absent when every member is visible). */
  probable?: string;
}

/**
 * The enemy bonuses I could break: every territory visible and held by one enemy, or (#72) inferred
 * behind the fog: its track (over at least TRACKED_MIN_TURNS observed turns) lists it in every
 * combination of bonuses that fits the opponent's income gap (all of them listed), or in its single
 * best fit (the first listed, with fewer bonuses than the next), and on this board every member is
 * that opponent's or hidden. Such a break is "probable".
 */
export function breakableBonuses(
  g: MapGraph,
  state: ReadonlyMap<number, TerritoryState>,
  foe: (p: number) => boolean,
  tracks: readonly OpponentTrack[] | undefined,
): Breakable[] {
  const breakable: Breakable[] = [];
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    const ts = bonusTerritories(g, b.id);
    if (b.value <= 0 || !ts.length) continue;
    const owners = new Set<number>();
    let visible = true;
    for (const t of ts) {
      const st = state.get(t);
      if (st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) visible = false;
      else owners.add(st.owner.playerId);
    }
    if (visible && owners.size === 1) {
      breakable.push({ bonusId: b.id, value: b.value, player: [...owners][0]! });
      continue;
    }
    // Inferred (#72): one opponent's visible members, the rest hidden, and its track fits it.
    if (owners.size !== 1) continue;
    const player = [...owners][0]!;
    const hiddenOrTheirs = ts.every((t) => {
      const st = ownerShown(state.get(t));
      return st === undefined || (st.owner.kind === 'player' && st.owner.playerId === player);
    });
    if (!hiddenOrTheirs) continue;
    const tr = tracks?.find((x) => x.playerId === player);
    const fits = tr && tr.income !== null && tr.turns.length >= TRACKED_MIN_TURNS ? tr.inferred?.candidates : undefined;
    if (!fits?.length) continue;
    // "Every" only when the tracker listed every fit (no "and N more"). The best fit must be
    // strictly smaller than the next: equal-sized fits are ordered only by bonus id.
    const more = tr!.inferred!.more;
    const inEvery = more === 0 && fits.every((c) => c.bonusIds.includes(b.id));
    const single = fits.length === 1 && more === 0;
    const inBest =
      fits[0]!.bonusIds.includes(b.id) && (single || (fits[1] !== undefined && fits[0]!.bonusIds.length < fits[1].bonusIds.length));
    if (!inEvery && !inBest) continue;
    breakable.push({
      bonusId: b.id,
      value: b.value,
      player,
      probable: inEvery ? 'in every combination of bonuses that fits its income gap' : 'in the best fit of its income gap',
    });
  }
  return breakable;
}

/** A siege whose newest kept turn is more than this many turns old is over: a new one starts. */
export const SIEGE_MEMORY_GAP = 3;
/** Turns a siege's memory keeps (the newest). */
export const MAX_SIEGE_TURNS = 100;

/** One planned turn of a siege, as kept between turns (ids and numbers only). */
export interface SiegeTurnRecord {
  turn: number;
  /** The target's income that turn (as the siege read it). */
  opponentIncome: number;
  myIncome: number;
  /** The target's bonuses that turn's plan broke (its captures took a member). */
  breaks: number[];
}

/** A siege's memory: its target and its turns, oldest first (`PlanInput.siegeMemory`). */
export interface SiegeMemory {
  target: number;
  turns: SiegeTurnRecord[];
}

/**
 * The turns of the siege on `target` before `turn` that `memory` keeps, oldest first: none when the
 * memory is another target's, the turn is unknown, or its newest turn before this one is more than
 * {@link SIEGE_MEMORY_GAP} turns back (that siege lapsed).
 */
export function priorSiegeTurns(memory: SiegeMemory | undefined, target: number, turn: number | undefined): SiegeTurnRecord[] {
  if (!memory || memory.target !== target || turn === undefined) return [];
  const before = memory.turns.filter((t) => t.turn < turn).sort((a, b) => a.turn - b.turn);
  const newest = before[before.length - 1];
  return newest && turn - newest.turn <= SIEGE_MEMORY_GAP ? before : [];
}

/** The memory to keep after planning `turn`: this turn's record after the earlier turns of the same siege. */
export function rememberSiegeTurn(memory: SiegeMemory | undefined, turn: number, r: SiegeReport): SiegeMemory {
  const record: SiegeTurnRecord = { turn, opponentIncome: r.opponentIncome, myIncome: r.myIncome, breaks: r.brokenThisTurn.map((b) => b.bonusId) };
  return { target: r.target, turns: [...priorSiegeTurns(memory, r.target, turn), record].slice(-MAX_SIEGE_TURNS) };
}

/** What `SiegeReport.memory` says of the siege so far, this turn included. */
export interface SiegeMemoryReport {
  startedTurn: number;
  /** Turns of the siege, this one included. */
  turns: number;
  /** The target's income on the siege's first turn. */
  startIncome: number;
  opponentIncomeTrend: { turn: number; income: number }[];
  /** Each target bonus the siege's plans broke, with the turns. */
  broken: { bonusId: number; turns: number[] }[];
  /** The bonuses broken on two or more turns (retaken in between). */
  rebroken: number[];
}

export type SiegeTrigger = 'income-fell' | 'income-lead' | 'core-strike';

/** The siege as the plan reads it before planning (`PlanCtx.siege`). */
export interface Siege {
  target: number;
  /** The target's income now (its estimate less a Reinforcement card, or the known income given). */
  opponentIncome: number;
  /** The most the tracker saw it deploy over its window, or its income now when larger or with no track. */
  baseline: number;
  /** Observed turns the baseline read (0: none, so the income-fell test cannot fire without a remembered start). */
  baselineTurns: number;
  /** Where the baseline came from: the income now, the tracker's window, or the siege's first turn. */
  baselineFrom: 'now' | 'tracked' | 'siege-start';
  /** My income now (card armies out). */
  myIncome: number;
  /** My income ÷ the target's (`null` when it earns nothing). */
  ratio: number | null;
  /** The target's income ÷ its baseline. */
  fallenTo: number | null;
  /** The target's breakable bonuses, cheapest per income lost first (cost: its cheapest member's capture now). */
  breaks: { bonusId: number; value: number; cost: number | null; probable?: true }[];
  ready: boolean;
  trigger: SiegeTrigger | null;
  /** With `core-strike`: the stack and the member it takes against the target's whole deploy. */
  core?: { from: number; to: number; bonusId: number; send: number; need: number };
  /** The members of the target's breakable bonuses: the only territories of its a siege attacks before the trigger. */
  breakMembers: ReadonlySet<number>;
  /** The turn planned (absent when unknown: no memory then). */
  turn?: number;
  /** The siege's earlier turns kept (oldest first; empty on its first turn). */
  earlier: SiegeTurnRecord[];
}

/** What `warapp_plan_turn` reports (`TurnPlan.siege`). */
export interface SiegeReport {
  target: number;
  opponentIncome: number;
  baseline: number;
  baselineTurns: number;
  baselineFrom: Siege['baselineFrom'];
  myIncome: number;
  ratio: number | null;
  fallenTo: number | null;
  /** The siege so far (absent when the turn is unknown). */
  memory?: SiegeMemoryReport;
  /** The target's bonuses this plan's captures break. */
  brokenThisTurn: { bonusId: number; value: number }[];
  /** Its breakable bonuses, cheapest per income lost first. */
  breaks: Siege['breaks'];
  ready: boolean;
  trigger: SiegeTrigger | null;
  /** Always said: what the baseline and the memory are. */
  note: string;
}

export const SIEGE_NOTE =
  "The baseline is the larger of the most the tracker saw the target deploy over its window of recent boards and its income on the siege's first turn (kept per game by warapp_plan_turn while the siege runs; a gap of more than 3 turns starts a new one). A bonus counts as broken on a turn when that turn's plan took one of its members, as planned, not as the board later showed.";

const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * The siege of this turn, or a reason it cannot run. `target`: the caller's (`siegeTarget`), else
 * the strongest opponent in contact (by income; ties to the lower id).
 */
export function siegeOf(o: {
  g: MapGraph;
  state: ReadonlyMap<number, TerritoryState>;
  mineAtStart: ReadonlySet<number>;
  foe: (p: number) => boolean;
  target: number | undefined;
  incomeOfPlayer: (p: number) => number;
  deployOf: (p: number) => number;
  myIncome: number;
  tracks: readonly OpponentTrack[] | undefined;
  settings: PlannerSettings;
  /** The turn planned and the siege's memory (#382): the target's income when the siege began joins the baseline. */
  turn?: number;
  memory?: SiegeMemory;
}): { siege: Siege } | { warning: string } {
  const { g, state, mineAtStart, foe } = o;
  const guard = o.settings.oneArmyStandsGuard === false ? 0 : 1;
  const ownerOf = (t: number) => {
    const st = state.get(t);
    return st?.owner.kind === 'player' ? st.owner.playerId : undefined;
  };
  const inContact = new Set<number>();
  for (const x of mineAtStart)
    for (const n of neighborsOf(g, x)) {
      const p = ownerOf(n);
      if (p !== undefined && foe(p)) inContact.add(p);
    }
  let target = o.target;
  if (target !== undefined) {
    if (!foe(target)) return { warning: `siege_target ${target} is not an opponent of mine still on the board (me, a teammate or a player at peace): no siege this turn, the plan is balanced.` };
    if (![...state.values()].some((st) => st.owner.kind === 'player' && st.owner.playerId === target))
      return { warning: `siege_target ${target} holds no territory in view: no siege this turn, the plan is balanced.` };
  } else {
    target = [...inContact].sort((a, b) => o.incomeOfPlayer(b) - o.incomeOfPlayer(a) || a - b)[0];
    if (target === undefined) return { warning: 'goal siege: no opponent borders my territories, so there is no one to besiege: the plan is balanced.' };
  }
  const p = target;
  const opponentIncome = Math.max(0, o.incomeOfPlayer(p));
  const tr = o.tracks?.find((t) => t.playerId === p);
  const observed = (tr?.turns ?? []).filter((t) => !tr?.incomeTurns.length || tr.incomeTurns.includes(t.from)).map((t) => t.observed);
  const earlier = priorSiegeTurns(o.memory, p, o.turn);
  const tracked = Math.max(0, ...observed);
  const start = earlier[0]?.opponentIncome ?? 0;
  const baseline = Math.max(opponentIncome, tracked, start);
  const baselineFrom: Siege['baselineFrom'] = baseline === opponentIncome ? 'now' : start > tracked ? 'siege-start' : 'tracked';
  const fallenTo = baseline > 0 ? round2(opponentIncome / baseline) : null;
  const ratio = opponentIncome > 0 ? round2(o.myIncome / opponentIncome) : null;
  const breakable = breakableBonuses(g, state, foe, o.tracks).filter((b) => b.player === p);
  const breakMembers = new Set(breakable.flatMap((b) => bonusTerritories(g, b.bonusId)));
  const armiesAt = (t: number) => state.get(t)?.armies ?? null;
  /** The cheapest capture of a visible member next to mine, at its defenders as they stand (`null`: none in reach). */
  const cheapest = (bonusId: number) => {
    const costs = bonusTerritories(g, bonusId).flatMap((t) => {
      const a = armiesAt(t);
      if (a === null || ownerOf(t) !== p || !neighborsOf(g, t).some((n) => mineAtStart.has(n))) return [];
      const c = captureCost(a, o.settings);
      return c === null ? [] : [c];
    });
    return costs.length ? Math.min(...costs) : null;
  };
  const breaks = breakable
    .map((b) => ({ bonusId: b.bonusId, value: b.value, cost: cheapest(b.bonusId), ...(b.probable ? { probable: true as const } : {}) }))
    .sort((a, b) => (a.cost ?? Infinity) / a.value - (b.cost ?? Infinity) / b.value || a.bonusId - b.bonusId);
  // The core strike: one stack of mine takes a member of a bonus the target holds in full (every
  // member in view, so the break is sure) against its defenders plus the target's whole deploy.
  let core: Siege['core'];
  for (const b of breakable.filter((x) => !x.probable).sort((x, y) => y.value - x.value || x.bonusId - y.bonusId)) {
    for (const t of [...bonusTerritories(g, b.bonusId)].sort((x, y) => x - y)) {
      const a = armiesAt(t);
      if (a === null) continue;
      const need = captureCost(a + o.deployOf(p), o.settings);
      if (need === null) continue;
      for (const x of neighborsOf(g, t).filter((n) => mineAtStart.has(n)).sort((m, n) => m - n)) {
        const send = Math.max(0, (armiesAt(x) ?? 0) - guard);
        if (send >= need && (!core || send - need > core.send - core.need)) core = { from: x, to: t, bonusId: b.bonusId, send, need };
      }
    }
    if (core) break;
  }
  const fell = (observed.length > 0 || earlier.length > 0) && baseline > 0 && opponentIncome <= SIEGE_INCOME_DROP * baseline;
  const lead = opponentIncome === 0 ? o.myIncome > 0 : o.myIncome >= SIEGE_INCOME_LEAD * opponentIncome;
  const trigger: SiegeTrigger | null = fell ? 'income-fell' : lead ? 'income-lead' : core ? 'core-strike' : null;
  return {
    siege: {
      target: p,
      opponentIncome,
      baseline,
      baselineTurns: observed.length,
      baselineFrom,
      myIncome: o.myIncome,
      ratio,
      fallenTo,
      breaks,
      ready: trigger !== null,
      trigger,
      ...(core ? { core } : {}),
      breakMembers,
      ...(o.turn !== undefined ? { turn: o.turn } : {}),
      earlier,
    },
  };
}

/** The rationale lines a siege adds (first in the plan's rationale). */
export function siegeLines(s: Siege, label: (t: number) => string, bonusName: (b: number) => string): string[] {
  const ratio = s.ratio === null ? 'it earns nothing' : `my ${s.myIncome} is ${s.ratio}× its income`;
  const fell =
    s.baselineFrom === 'siege-start'
      ? `its income ~${s.opponentIncome} against a baseline of ~${s.baseline} (${s.fallenTo === null ? '—' : `${Math.round(s.fallenTo * 100)}%`}, its income on turn ${s.earlier[0]!.turn}, when the siege began)`
      : s.baselineTurns > 0
      ? `its income ~${s.opponentIncome} against a baseline of ~${s.baseline} (${s.fallenTo === null ? '—' : `${Math.round(s.fallenTo * 100)}%`}, the most seen over ${s.baselineTurns} tracked turn${s.baselineTurns === 1 ? '' : 's'})`
      : `its income ~${s.opponentIncome} (no tracked turns yet, so no baseline to fall from)`;
  const so = s.earlier.length ? `; siege turn ${s.earlier.length + 1} (since turn ${s.earlier[0]!.turn}): its income ${[...s.earlier.map((t) => t.opponentIncome), s.opponentIncome].join(' → ')}` : '';
  const head = `Siege on player ${s.target} (#382): ${fell}; ${ratio}${so}.`;
  const breaks = s.breaks.length
    ? `Its bonuses to break, cheapest per income lost first: ${s.breaks
        .map((b) => `${bonusName(b.bonusId)} (+${b.value}${b.cost === null ? ', no member in reach' : `, ${b.cost} to take a member as it stands`}${b.probable ? ', probable' : ''})`)
        .join('; ')}. Each break is sized for its defenders plus the deploy player ${s.target} may put there first where the armies allow (#120).`
    : `No bonus of player ${s.target} is breakable in view this turn.`;
  const state = !s.ready
    ? `Assault held: player ${s.target}'s income has not fallen to ${Math.round(SIEGE_INCOME_DROP * 100)}% of its baseline, mine is not ${SIEGE_INCOME_LEAD}× its, and no stack of mine can take a member of its held bonuses against its whole deploy; only its bonus members are attacked, and the spare deploys build one strike stack facing it.`
    : s.trigger === 'income-fell'
      ? `Assault released: player ${s.target}'s income fell to ${Math.round((s.fallenTo ?? 0) * 100)}% of its baseline (at most ${Math.round(SIEGE_INCOME_DROP * 100)}%); the strike stack strikes.`
      : s.trigger === 'income-lead'
        ? `Assault released: my income is ${s.ratio ?? '∞'}× player ${s.target}'s (at least ${SIEGE_INCOME_LEAD}×); the strike stack strikes.`
        : `Assault released: ${label(s.core!.from)} can send ${s.core!.send} to take ${label(s.core!.to)} of ${bonusName(s.core!.bonusId)} (${s.core!.need} take it even after player ${s.target}'s whole deploy there); the strike stack strikes.`;
  return [head, breaks, state];
}

/** The report of a siege once the plan's captures are known. */
export function siegeReport(s: Siege, g: MapGraph, captured: ReadonlySet<number>): SiegeReport {
  const brokenThisTurn = s.breaks
    .filter((b) => bonusTerritories(g, b.bonusId).some((t) => captured.has(t)))
    .map((b) => ({ bonusId: b.bonusId, value: b.value }));
  let memory: SiegeMemoryReport | undefined;
  if (s.turn !== undefined) {
    const turns = [...s.earlier.map((t) => ({ turn: t.turn, breaks: t.breaks, income: t.opponentIncome })), { turn: s.turn, breaks: brokenThisTurn.map((b) => b.bonusId), income: s.opponentIncome }];
    const broken = new Map<number, number[]>();
    for (const t of turns) for (const b of t.breaks) broken.set(b, [...(broken.get(b) ?? []), t.turn]);
    const list = [...broken].sort(([a], [b]) => a - b).map(([bonusId, ts]) => ({ bonusId, turns: ts }));
    memory = {
      startedTurn: turns[0]!.turn,
      turns: turns.length,
      startIncome: turns[0]!.income,
      opponentIncomeTrend: turns.map((t) => ({ turn: t.turn, income: t.income })),
      broken: list,
      rebroken: list.filter((b) => b.turns.length > 1).map((b) => b.bonusId),
    };
  }
  return {
    target: s.target,
    opponentIncome: s.opponentIncome,
    baseline: s.baseline,
    baselineTurns: s.baselineTurns,
    baselineFrom: s.baselineFrom,
    myIncome: s.myIncome,
    ratio: s.ratio,
    fallenTo: s.fallenTo,
    ...(memory ? { memory } : {}),
    brokenThisTurn,
    breaks: s.breaks,
    ready: s.ready,
    trigger: s.trigger,
    note: SIEGE_NOTE,
  };
}
