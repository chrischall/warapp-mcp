// The holds of a planning pass (#133): which threatened territories of mine to hold and which to
// concede (rule 1, 1a, 1k), the stacks two steps away (#172), held-bonus units and their floor tier
// (rule 1h, #51, #118), the withdrawals from conceded borders (rule 1b), the concessions this
// turn's captures make worth keeping (rule 1c, R2) and the garrisons of bonuses completed this
// turn (#122). Defined once the threats are read; planPass runs them between the capture passes.
import { carriesTeam } from '../../teams.js';
import { bonusTerritories } from '../bonuses.js';
import { bfsDistances, neighborsOf } from '../graph.js';
import { chargeDeploys } from '../local-deploy.js';
import { twoStepReaches, type TwoStepReach } from '../lookahead.js';
import {
  CITE_CLOSE,
  CITE_OPEN,
  CITE_SEP,
  CONCEDE_FACTOR,
  nearMissMargin,
  type PlannedMove,
  type TwoStepHoldAt,
  type TwoStepPass,
} from './shared.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';


/** A territory of mine with a threat next to it (rule 1): what it has, what it faces, what holding it costs. */
export interface Threatened {
  id: number;
  have: number;
  threat: number;
  holdCost: number;
  value: number;
  /** Protected value plus the armies a hold saves, in income terms (armies / PAYBACK_TURNS). */
  worth: number;
  /** A weak opponent that held it last turn and threatens it now: it is never conceded economically. */
  recentFrom?: number;
  /** The armies my special units there fight as (my commander: {@link COMMANDER_STRENGTH}); they never move. */
  units: number;
  /** My commander stands here: must-hold (rule 1k), never conceded. */
  critical?: true;
  /**
   * Deploys already given toward its hold (#118: rule 1h's floor tier, then the shared-deploy
   * split); `have` includes them and `holdCost` is what is still needed.
   */
  given?: number;
}
/** Rule 1h (#51): a bonus I hold in full with a threatened border, held whole or conceded. */
export interface Unit {
  bonusId: number;
  value: number;
  members: Threatened[];
  /** Sum of its members' hold costs (a border shared with another unit counted in both). */
  cost: number;
  /** Local Deployment (#103): its own pool, deployable nowhere else (0 with the flag off). */
  pool: number;
  /** What holding it costs beyond its own pool, judged against its worth: max(0, cost − pool). */
  net: number;
  /** Its value plus the armies its holds save, in income terms. */
  worth: number;
  /** Why it does not pay for itself, if it does not (see {@link UnitLoss}). */
  loss: 'payback' | 'factor' | null;
  conceded: boolean;
  /** Rule 1h's floor tier (#118): every threatened border beats the armies already next to it. */
  floored: boolean;
  /**
   * Not held in full and not conceded (#118): floored, then upgraded to a whole hold or given
   * a share of what is left against the one deploy its opponent has ({@link settleContested}).
   */
  contested: boolean;
}
/** Why a unit is conceded: it does not pay for itself, or the armies left cannot cover it. */
export type UnitLoss = { economic: 'payback' | 'factor' } | { economic: false; left: number };
/**
 * The collections the holds share, made up front so each step of the phase can reach those a
 * later step fills.
 */
export interface HoldBook {
  /** Rule 1's threatened borders, filled by {@link holdOrConcede}'s assessThreats. */
  threatened: Threatened[];
  /** Borders the plan concedes. */
  conceded: Set<number>;
  /**
   * Rule 1h's units: every bonus I hold in full with a threatened border is one unit: all its
   * threatened borders are held, or none (holding some while conceding another breaks it anyway).
   */
  units: Unit[];
  /** Under `balanced`, holds worth paying for compete with expansion in the greedy step. */
  holds: Threatened[];
  /** Conceded borders kept because this turn's captures complete a bonus they protect (rule 1c). */
  kept: Set<number>;
  /** #122: members garrisoned so: like a border rule 1c keeps, the leftover tops them up to a comfortable margin first. */
  garrisoned: Set<number>;
  /**
   * #215: the pending holds rule 1a's triage itself locked (under `balanced`), so the greedy step
   * unlocks only those when it concedes one — never a lock some other rule added.
   */
  pendingLocks: Set<number>;
  /**
   * #215 review: the bonuses this turn's captures may complete — every missing member a capture
   * target — by their armies to finish (rule 4's bonus plans; filled once the targets are known,
   * before rule 1a's triage runs).
   */
  completable: Map<number, number>;
}

/** The holds phase's helpers, for planPass to run. */
export type Holds = ReturnType<typeof holdsPhase>;

/**
 * Define the holds of one pass, step by step in planPass's order. Nothing here deploys, moves or
 * says anything yet: planPass runs assessThreats, triage, withdraw, reconsider and
 * garrisonCompleted where the capture passes need them.
 */
export function holdsPhase(pc: PlanCtx, ps: PlanState, book: DeployBook, threats: Threats, pass: TwoStepPass) {
  const hb: HoldBook = {
    threatened: [], conceded: new Set(), units: [], holds: [], kept: new Set(), garrisoned: new Set(),
    pendingLocks: new Set(), completable: new Map(),
  };
  const h0 = holdBasics(pc, ps, book, threats);
  const h1 = { ...h0, ...twoStepHolds(pc, ps, book, threats, hb, pass, h0) };
  const h2 = { ...h1, ...holdOrConcede(pc, ps, book, threats, hb, h1) };
  const h3 = { ...h2, ...heldBonusUnits(pc, ps, book, threats, hb, h2) };
  const h4 = { ...h3, ...floorTier(pc, ps, book, threats, hb, h3) };
  const h5 = { ...h4, ...withdrawals(pc, ps, book, threats, hb, h4) };
  const h6 = { ...h5, ...reconsiderAndGarrison(pc, ps, book, threats, hb, h5) };
  return { ...hb, ...h6 };
}

/** Rule 1's threatened borders, rule 1a's economic test, and what stays on or must stay on a territory of mine. */
export function holdBasics(pc: PlanCtx, ps: PlanState, book: DeployBook, threats: Threats) {
  const { profile, unitsAt, myCommanders } = pc;
  const { avail, coverKeep, captured, incoming } = ps;
  const { guardAt } = book;
  const { holdArmies, borderAt } = threats;
  /**
   * Rule 1a's economic test: its hold costs more than CONCEDE_FACTOR × its worth. Never for a
   * border just taken from a weak opponent, nor (#122) in the opening when the hold costs no more
   * than the armies already there — a start is the whole position then, and the top-up saves at
   * least as many as it spends (live, three starts around an enemy start were each stripped for
   * want of 2 armies, and neutrals attacked out of each).
   */
  const uneconomic = (t: Threatened) =>
    t.recentFrom === undefined &&
    t.holdCost > CONCEDE_FACTOR * t.worth &&
    !(profile.phase === 'opening' && t.holdCost <= t.have);
  /** Armies that stay on my `id` after this turn's deploys, outgoing moves and incoming withdrawals so far. */
  const stayAt = (id: number) => avail.get(id)! + guardAt(id) + (incoming.get(id) ?? 0);
  /**
   * Armies (in `avail` terms) that must stay on my `x` for it to hold against the visible
   * threat next to it (its special units counted; the territories `gone` says fall this turn
   * left out: once taken they threaten nothing); 0 with no enemy next to it. When it cannot
   * hold on what it has: everything on my commander's territory (rule 1k: nothing leaves it),
   * else everything only if `room` deploys would make it hold, and nothing otherwise (triage
   * would concede it, so keeping its armies home saves nothing). Armies withdrawn into it count
   * only when I am known to move first (#215, {@link lateArrivals}).
   */
  const keepFor = (x: number, gone: (n: number) => boolean, room = Infinity) => {
    const a = avail.get(x)!;
    const covering = Math.max(0, Math.min(a, coverKeep.get(x) ?? 0));
    const b = borderAt(x, (n) => captured.has(n) || gone(n));
    if (!b) return covering;
    const need = Math.max(0, holdArmies(b.threat) - unitsAt(x));
    // #215: armies withdrawn into it hold it only if I move first: sized for the worse order.
    const short = need - (stayAt(x) - lateArrivals(pc, ps, x));
    if (short > room && !myCommanders.has(x)) return covering;
    return Math.max(covering, a - Math.max(0, Math.min(a, -short)));
  };
  return { uneconomic, stayAt, keepFor };
}

/** #172: the holds a stack two steps away asks of a territory worth guarding, and how an order cites them. */
export function twoStepHolds(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hb: HoldBook,
  pass: TwoStepPass,
  prev: HoldsUpTo0,
) {
  const {
    g, board, me, s, opts, income, game: ctx, foe, deployOf, territories: state, label, mineSet, cardArmies, unitsAt,
    bonusTs, bonusesWith, heldAtStart, myCommanders,
  } = pc;
  const { avail, captured } = ps;
  const { pools } = book;
  const local = pools !== null && pools.bonuses.length > 0;
  const { holdArmies, borderAt } = threats;
  const { conceded } = hb;
  const { stayAt } = prev;
  // ---- #172: two steps away ----
  /**
   * What my `t` protects against a stack two steps away: the bonuses I hold in full that contain
   * it (net of negative ones, floored at 0) — and, with my commander there, everything. A
   * territory protecting nothing is never held against a reach (its armies serve the front).
   */
  const heldBonusValueMemo = new Map<number, number>();
  const heldBonusValue = (t: number): number => {
    let v = heldBonusValueMemo.get(t);
    if (v === undefined) {
      v = 0;
      for (const id of bonusesWith.get(t) ?? []) if (bonusTs.get(id)!.every((x) => heldAtStart.has(x))) v += g.bonusById.get(id)!.value;
      heldBonusValueMemo.set(t, (v = Math.max(0, v)));
    }
    return v;
  };
  const guardsTwoStep = (t: number) => myCommanders.has(t) || heldBonusValue(t) > 0;
  /**
   * Every two-step reach to a territory of mine worth guarding (lookahead.ts, as check_plan), by
   * territory: found once per {@link planTurn} (it depends only on the start board) and shared by
   * its passes, each of which filters it by its own plan ({@link twoStepHold}).
   */
  /**
   * Territories whose two-step hold an order cited (see {@link twoStepCite}), with the hold it
   * met: each is stated once, at the end, with the stay the plan ends on.
   */
  const twoStepCited = new Map<number, TwoStepHoldAt>();
  /**
   * Armies rule 6 moves into each territory of mine (staging and idle interior transfers), which
   * {@link stayAt}'s `incoming` leaves out: they end the plan there, so a two-step hold counts them.
   */
  const arrived = new Map<number, number>();
  /** {@link stayAt} with rule 6's arrivals: what stays on my `t` once every order has run. */
  const finalStayAt = (t: number) => stayAt(t) + (arrived.get(t) ?? 0);
  /**
   * Territories whose two-step hold kept back armies some order could otherwise have used (an
   * attack's size, a softener, a finisher, a top-up): each is explained at the end, unless an
   * order already said so.
   */
  const twoStepBound = new Set<number>();
  const twoStepAt = (t: number): readonly TwoStepReach[] => {
    if (!pass.shared.reaches) {
      const byTerritory = new Map<number, TwoStepReach[]>();
      const teams = new Map<number, number>();
      for (const p of ctx.players ?? []) if (carriesTeam(p.team)) teams.set(p.id, p.team);
      const opponents = [
        ...new Set(board.territories.flatMap((x) => (x.owner.kind === 'player' && foe(x.owner.playerId) && x.armies !== null ? [x.owner.playerId] : []))),
      ]
        .sort(byNum)
        .map((id) => ({ id, deploy: deployOf(id) }));
      const reaches = twoStepReaches({
        graph: g,
        board,
        me,
        opponents,
        settings: {
          ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
          ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
          ...(s.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
          ...(s.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
          ...(s.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: s.oneArmyStandsGuard } : {}),
          ...(s.multiAttack !== undefined ? { multiAttack: s.multiAttack } : {}),
        },
        ...(teams.size ? { teams } : {}),
        ...(opts.movesFirst !== undefined ? { firstMover: opts.movesFirst ? ('me' as const) : ('opponent' as const) } : {}),
        only: guardsTwoStep,
      });
      for (const r of reaches) byTerritory.set(r.territory, [...(byTerritory.get(r.territory) ?? []), r]);
      pass.shared.reaches = byTerritory;
    }
    return pass.shared.reaches.get(t) ?? [];
  };
  /**
   * #172: the armies that stay on my `t` (in {@link stayAt} terms) to hold against the strongest
   * stack that can reach it next turn by taking the territory in between this turn, and that
   * reach; `null` when none binds. A reach through, or from, a territory this turn takes (or
   * `gone` says falls) is cut, and so is one through a territory of mine the plan does not concede
   * (its own one-step hold covers it), and so is one it cannot hold even with next turn's whole
   * income deployed there. One-step holds are separate: callers take the larger, never both.
   */
  /**
   * Whether my `v`, in between a reach and its target, is held — kept and holding its own border —
   * as the plan's end decides it (see {@link settledPass}): learned from an earlier pass, else
   * judged by the concession so far and checked at the end.
   */
  const viaHeld = (v: number): boolean => {
    const d = pass.viaNever ? false : (pass.viaHeld.get(v) ?? !conceded.has(v));
    const seen = pass.viaSeen.get(v);
    if (seen !== undefined && seen !== d) pass.viaMixed = true;
    pass.viaSeen.set(v, d);
    return d;
  };
  const twoStepHold = (t: number, gone: (n: number) => boolean = () => false, final = false): TwoStepHoldAt | null => {
    if (!mineSet.has(t) || conceded.has(t) || !guardsTwoStep(t)) return null;
    let best: TwoStepHoldAt | null = null;
    for (const r of twoStepAt(t)) {
      if (captured.has(r.via) || captured.has(r.from) || gone(r.via) || gone(r.from)) continue;
      // Taken by an order of this plan that lands later (planTurn's refining passes).
      if (pass.cut.has(r.via) || pass.cut.has(r.from)) continue;
      // Through a territory of mine the plan holds: that is its border's one-step hold, not this.
      if (mineSet.has(r.via) && viaHeld(r.via)) continue;
      // Measured as a one-step hold is (holdArmies: under luck or weighted-random rounding, it
      // falls at most HOLD_FALL_CHANCE of the time), never below check_plan's luck-free `needs`.
      const needs = Math.max(r.needs, holdArmies(r.power));
      const stay = Math.max(0, needs - unitsAt(t));
      // Hopeless — not even what is there now and what next turn can deploy there make it hold:
      // keeping its armies home saves nothing (as {@link keepFor} judges a one-step hold). Judged
      // by `t`'s own stay: rule 6's arrivals do not make a hold worth keeping `t`'s armies for
      // (they already cover it, and counting them would make the decision depend on whether the
      // transfer in runs before `t`'s own order). Only the end of the plan (`final`), deciding
      // whether a hold an order cited still applies, counts them.
      if ((final ? finalStayAt(t) : stayAt(t)) + nextRoomAt(t) < stay) continue;
      if (!best || stay > best.stay) best = { stay, needs, reach: r };
    }
    if (!best || best.stay <= 0) return null;
    pass.used = true;
    return best;
  };
  /**
   * What next turn could deploy on my `t`, card armies aside: the whole income, or under Local
   * Deployment only what may land there — the pools of the bonuses holding it and the free rest.
   */
  const nextRoomAt = (t: number): number => {
    const whole = Math.max(0, income - cardArmies);
    if (!local) return whole;
    const own = pools.bonuses.filter((b) => b.territoryIds.includes(t)).reduce((n, b) => n + b.value, 0);
    return Math.min(whole, Math.max(0, pools.anywhere - cardArmies) + own);
  };
  /** {@link twoStepHold} in `avail` terms: what of `t`'s movable armies stays (0 with none). */
  const twoStepKeep = (t: number, gone?: (n: number) => boolean): number => {
    const h = twoStepHold(t, gone);
    if (!h) return 0;
    const a = avail.get(t)!;
    return a - Math.max(0, Math.min(a, stayAt(t) - h.stay));
  };
  /**
   * An order that keeps `t`'s two-step hold (#172) names it, without numbers: the hold is stated
   * once, at the end ({@link twoStepNote}), with the stay the plan ends on — a stay read mid-plan
   * disagrees with the orders after it. `clause` renders the rationale text that names it; the
   * text is marked, so the end of the plan keeps it only if the hold still applies then (a later
   * capture or a smaller stay can end it), and puts `fallback` in its place otherwise (by default
   * nothing; a line that is only the citation falls back to a plain account of what it kept).
   */
  const twoStepCite = (t: number, h: TwoStepHoldAt, clause: (cite: string) => string, fallback = '') => {
    twoStepCited.set(t, h);
    return `${CITE_OPEN}${t}${CITE_SEP}${clause('its hold against a stack two steps away')}${CITE_SEP}${fallback}${CITE_CLOSE}`;
  };
  /**
   * The rationale clause for a two-step hold (#172), at the end of the plan: the armies the plan
   * ends with there (rule 6's arrivals included), its special units named, since they count toward
   * what it needs. A hold kept short of that (kept because next turn's deploy can make up the rest)
   * says how many more to bring.
   */
  const twoStepNote = (t: number, h: TwoStepHoldAt) => {
    const r = h.reach;
    const kept = finalStayAt(t);
    const units = unitsAt(t);
    const short = h.needs - units - kept;
    const near = nearHoldAt(t);
    // #192: the one-step hold (or #128's) already pins at least what the reach needs: "kept N"
    // would read as if this hold claimed them, so the line says they are held already.
    if (near && near.needs >= h.needs)
      return `already held against the adjacent stack (~${near.threat}; it needs ${near.needs} to hold): player ${r.opponent} can reach it next turn from ${label(r.from)} via ${label(r.via)} (~${r.attackers} attacking; the two-step reach needs ${h.needs}${short > 0 ? `; bring ${short} more next turn` : ''})`;
    return `kept ${kept} on ${label(t)}${units ? ` (with its special units, worth ${units})` : ''}: player ${r.opponent} can reach it next turn from ${label(r.from)} via ${label(r.via)} (~${r.attackers} attacking; it needs ${h.needs} to hold${short > 0 ? `; bring ${short} more next turn` : ''})`;
  };
  /**
   * #192: the one-step hold on my `t` once every order has run — against the stacks beside it
   * this turn's captures leave, or (#128) while an attack on a player beside it is pending, as if
   * those attacks fail — as what it needs (special units included) and the threat; `null` with
   * no enemy beside it.
   */
  const nearHoldAt = (t: number): { needs: number; threat: number } | null => {
    const pending = neighborsOf(g, t).some((x) => captured.has(x) && state.get(x)?.owner.kind === 'player');
    const b = pending ? borderAt(t, () => false) : borderAt(t, (x) => captured.has(x));
    return b ? { needs: holdArmies(b.threat), threat: b.threat } : null;
  };
  return { twoStepCited, arrived, twoStepBound, twoStepHold, twoStepKeep, twoStepCite, twoStepNote };
}

/** Rule 1a: judge each threatened border, hold it or concede it, and say why (rule 1k's commander included). */
export function holdOrConcede(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hb: HoldBook,
  prev: HoldsUpTo1,
) {
  const { goal, paybackTurns, label, unitsAt, bombOn, toTake, myCommanders } = pc;
  const { warnings, rationale, locked } = ps;
  const { deploy, valueOf } = book;
  const { borders, recentlyTakenFrom } = threats;
  const { threatened, conceded } = hb;
  const { stayAt } = prev;
  /**
   * Fill `threatened` from `borders`, judging each by the armies that stay on it (its
   * armies at the start of the turn unless a finishing-off attack already left).
   */
  /** Rule 1a's pre-deploy threat warning per border, restated once the deploys are known. */
  const threatWarnings = new Map<number, { text: string; threat: number }>();
  const assessThreats = () => {
    for (const b of borders.values()) {
      const have = stayAt(b.id);
      const units = unitsAt(b.id);
      const take = toTake(have + units);
      if (take === null || take > b.threat) continue;
      const text = `${label(b.id)} (${have} armies${units ? ' and my commander' : ''}) could be taken next turn: player ${b.player} ${b.chain ? `can attack it with ~${b.chain.armies} armies by a Multi-Attack chain from ${label(b.chain.path[0]!)} (its deploy included)` : `has ${b.movable} movable armies next to it plus ~${b.growth > b.deploy ? `${b.growth} (its growth per turn)` : `${b.deploy} deploy`}`}, and ${bombOn ? toTake(Math.floor(have / 2) + units) : take} would do${b.split ? ` — sent as separate attacks (${b.split.attacks.join(' then ')}), its stacks take up to ${b.split.takes}` : ''}${bombOn ? ' once a Bomb halves it (an opponent may hold one)' : ''}.`;
      // #201: a border sized for the expected attack is restated against its worst case, never
      // called held when the worst case still takes it.
      threatWarnings.set(b.id, { text, threat: b.worst ?? b.threat });
      warnings.push(text);
      // armiesToTake grows at least one army per ~(100 / offensive kill rate) defenders, so this ends.
      let d = 1;
      while ((toTake(have + units + d) ?? Infinity) <= b.threat) d++;
      const value = valueOf(b.id);
      const from = recentlyTakenFrom(b.id);
      threatened.push({
        id: b.id,
        have,
        threat: b.threat,
        holdCost: d,
        value,
        worth: value + have / paybackTurns,
        ...(from !== undefined && from === b.player ? { recentFrom: from } : {}),
        units,
        ...(myCommanders.has(b.id) ? { critical: true as const } : {}),
      });
    }
    threatened.sort(
      (a, b) =>
        Number(b.critical === true) - Number(a.critical === true) ||
        Number(b.recentFrom !== undefined) - Number(a.recentFrom !== undefined) ||
        b.worth / b.holdCost - a.worth / a.holdCost ||
        a.holdCost - b.holdCost ||
        a.id - b.id,
    );
  };

  const acting = goal === 'defend';
  const concedeUnaffordable = (t: Threatened, left: number) => {
    conceded.add(t.id);
    warnings.push(
      `${label(t.id)} cannot be held with the ${left} armies left to deploy (needs ${t.holdCost}, protects +${t.value}): conceded`,
    );
  };
  /** Said only once its hold is actually deployed. */
  const noteRecent = (t: Threatened) => {
    if (t.recentFrom !== undefined)
      rationale.push(
        `${label(t.id)} was captured from player ${t.recentFrom} last turn, and that opponent is weak: it is not conceded economically (conceding hands it back for free).`,
      );
  };
  /** What stays on a held border, for the rationale: its armies, and my commander when it stands there. */
  const heldStack = (t: Threatened) => `${t.have + t.holdCost} armies${t.units ? ' and my commander' : ''}`;
  /** The borders a hold deployed to, by the player threatening them (for the #69 rationale). */
  const heldAgainst = new Map<number, Set<number>>();
  const hold = (t: Threatened) => {
    noteRecent(t);
    deploy(t.id, t.holdCost);
    locked.add(t.id);
    const by = borders.get(t.id)?.player;
    if (by !== undefined) heldAgainst.set(by, (heldAgainst.get(by) ?? new Set()).add(t.id));
    rationale.push(
      `Deploy ${t.holdCost + (t.given ?? 0)} to ${label(t.id)} so it holds (protects +${t.value}): ${heldStack(t)} need ${toTake(t.have + t.units + t.holdCost)} to take, above the ~${t.threat} threat.`,
    );
  };
  return { threatWarnings, assessThreats, acting, concedeUnaffordable, noteRecent, heldStack, heldAgainst, hold };
}

/** Rule 1h (#51): every bonus I hold in full with a threatened border is one unit, held whole or conceded. */
export function heldBonusUnits(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hb: HoldBook,
  prev: HoldsUpTo2,
) {
  const { g, paybackTurns, label, bonusName, incomeAfter, toTake } = pc;
  const { warnings, rationale, locked } = ps;
  const { deploy, undeploy, pools, roomAt } = book;
  const local = pools !== null && pools.bonuses.length > 0;
  const { expectedAt } = threats;
  const { threatened, conceded, units } = hb;
  const { noteRecent, hold } = prev;
  // ---- 1h. held-bonus units (#51) ----
  // #128: what the plan can count on excludes the borders it concedes, and those of a held bonus
  // it has not decided to hold whole yet (contested, #118): R3 runs before that is settled.
  /**
   * #128: the next income the plan can count on — {@link incomeAfter} without the borders it
   * concedes (it does not plan to hold them, so the bonuses they break do not pay for anything).
   * R3, rule 4d and the frontier report use it.
   */
  const keptIncome = (after: ReadonlySet<number>) =>
    incomeAfter(
      new Set(
        [...after].filter(
          (t) => !conceded.has(t) && !units.some((u) => (u.conceded || u.contested) && u.members.some((m) => m.id === t)),
        ),
      ),
    );
  /** Borders a funded unit (or an individual hold) already holds. */
  const heldBorders = new Set<number>();
  /** My commander's borders whose whole hold rule 1k deployed. */
  const commanderHeld = new Set<number>();
  /** Local Deployment: the armies bonus `id`'s own pool holds this turn (0 with the flag off). */
  const poolOf = (id: number) => (local ? (pools.bonuses.find((p) => p.bonusId === id)?.value ?? 0) : 0);
  const buildUnits = () => {
    for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length || !ts.every((x) => ps.holdings.has(x))) continue;
      const members = threatened.filter((t) => ts.includes(t.id)).sort((x, y) => x.id - y.id);
      if (!members.length) continue;
      // My commander's border, once its hold is funded (rule 1k), is held whatever it costs: a
      // sunk cost the unit no longer pays, and a stack it no longer saves, so it is left out of
      // the unit's cost and its payback test. A hold rule 1k could not fully fund still counts.
      const paying = members.filter((m) => !commanderHeld.has(m.id));
      const cost = paying.reduce((n, m) => n + m.holdCost, 0);
      const worth = b.value + paying.reduce((n, m) => n + m.have / paybackTurns, 0);
      // It pays back within PAYBACK_TURNS, and (as rule 1a asks of every border) costs at
      // most CONCEDE_FACTOR × its worth, unless a member was just taken from a weak opponent.
      const recent = members.some((m) => m.recentFrom !== undefined);
      // Local Deployment (#103): the bonus's own armies can be deployed nowhere else, so
      // spending them on its defence costs nothing — only what holding it needs beyond them.
      const pool = poolOf(b.id);
      const net = Math.max(0, cost - pool);
      units.push({
        bonusId: b.id,
        value: b.value,
        members,
        cost,
        pool,
        net,
        worth,
        loss: net > paybackTurns * b.value ? 'payback' : !recent && net > CONCEDE_FACTOR * worth ? 'factor' : null,
        conceded: false,
        floored: false,
        contested: false,
      });
    }
  };
  /** A threatened border still owned by a unit not conceded (it is held or conceded with it). */
  const inLiveUnit = (id: number) => units.some((u) => !u.conceded && u.members.some((m) => m.id === id));
  /** `t` judged on its own: its protected value less the bonuses of the units conceded with it. */
  const residual = (t: Threatened): Threatened => {
    const lost = units.filter((u) => u.conceded && u.members.some((m) => m.id === t.id)).reduce((n, u) => n + u.value, 0);
    const value = Math.max(0, t.value - lost);
    return { ...t, value, worth: value + t.have / paybackTurns };
  };
  const unitBorders = (u: Unit) =>
    `${u.members.length} threatened border${u.members.length === 1 ? '' : 's'}`;
  /**
   * Concede `u` as a whole, then judge each of its members no other live unit owns on its
   * own merits (`single`, quietly: other bonuses, per-territory income, the stack it saves).
   * One warning: rule 1a's for a one-border unit that stays conceded (so it names the full
   * value it protects), else "conceding <bonus>: holding all N borders needs X, …".
   */
  const concedeUnit = (u: Unit, loss: UnitLoss, single: (t: Threatened, quiet: boolean) => void) => {
    u.conceded = true;
    for (const m of u.members) if (!heldBorders.has(m.id) && !inLiveUnit(m.id)) single(residual(m), true);
    const [only] = u.members;
    if (u.members.length === 1) {
      if (conceded.has(only!.id) && !heldBorders.has(only!.id))
        warnings.push(
          loss.economic
            ? `${label(only!.id)} cannot be held economically (needs ${only!.holdCost}, protects +${only!.value}): conceded`
            : `${label(only!.id)} cannot be held with the ${loss.left} armies left to deploy (needs ${only!.holdCost}, protects +${only!.value}): conceded`,
        );
      return;
    }
    const why =
      loss.economic === false
        ? `more than the ${loss.left} armies left to deploy`
        : loss.economic === 'payback'
          ? `more than it pays back in ${paybackTurns} turns (${paybackTurns} × +${u.value} = ${paybackTurns * u.value})`
          : `more than ${CONCEDE_FACTOR} × its worth (~${Math.round(u.worth * 10) / 10})`;
    const needs = u.pool > 0 && loss.economic ? `${u.cost} (${u.net} beyond its own ${Math.min(u.pool, u.cost)} local armies)` : `${u.cost}`;
    warnings.push(
      `conceding bonus ${bonusName(u.bonusId)} (+${u.value}): holding all ${u.members.length} threatened borders (${u.members.map((m) => label(m.id)).join(', ')}) needs ${needs}, ${why}`,
    );
  };
  /** The armies `u` may still deploy, for its warning: a one-border unit's room (pools respected). */
  const leftFor = (u: Unit) => {
    if (u.members.length === 1) return roomAt(u.members[0]!.id);
    if (!local) return ps.budget;
    // Local Deployment: what may be deployed on its borders together (pools respected).
    const given = u.members.map((m) => {
      const n = roomAt(m.id);
      deploy(m.id, n);
      return { id: m.id, n };
    });
    for (const x of given) undeploy(x.id, x.n);
    return given.reduce((n, x) => n + x.n, 0);
  };
  /**
   * Deploy every hold of `u` not yet funded, or nothing: false when they do not all fit.
   * `each` may take over one member's hold (attacking on top of it), given the deploys
   * the members after it still need; it returns false to leave it a plain hold.
   */
  const fundUnit = (u: Unit, each?: (m: Threatened, rest: number) => boolean, line?: string): boolean => {
    // A commander border rule 1k could not fully hold is still owed (it cannot be deployed to further).
    const todo = u.members.filter((m) => !heldBorders.has(m.id) || (m.critical && !commanderHeld.has(m.id)));
    const cost = todo.reduce((n, m) => n + m.holdCost, 0);
    if (cost > ps.budget) return false;
    if (local) {
      // Pools: each hold must fit its own territory's room, the earlier ones deployed.
      const done: Threatened[] = [];
      for (const m of todo) {
        if (m.holdCost > roomAt(m.id)) {
          for (const d of done) undeploy(d.id, d.holdCost);
          return false;
        }
        deploy(m.id, m.holdCost);
        done.push(m);
      }
      for (const d of done) undeploy(d.id, d.holdCost);
    }
    const one = u.members.length === 1;
    // What this unit deploys itself: a border another unit already holds costs it nothing (its
    // own floor, #118, counts as its own).
    const own = cost + todo.reduce((n, m) => n + (m.given ?? 0), 0);
    const needs = !todo.length
      ? u.members.every((m) => commanderHeld.has(m.id))
        ? `${one ? 'is' : 'are'} already held for my commander`
        : `${one ? 'is' : 'are'} already held for another bonus`
      : own < u.cost
        ? `need${one ? 's' : ''} ${own} more (${u.cost - own} already deployed for another bonus)`
        : `need${one ? 's' : ''} ${own} in all`;
    rationale.push(
      line ??
        `Hold bonus ${bonusName(u.bonusId)} (+${u.value}) whole: its ${unitBorders(u)} ${needs} (it pays back within ${paybackTurns} turns), before any capture that completes no bonus.`,
    );
    let rest = cost;
    for (const m of todo) {
      rest -= m.holdCost;
      if (!each?.(m, rest)) hold(m);
      heldBorders.add(m.id);
    }
    return true;
  };
  /**
   * Rule 1h near miss (issue #59), when {@link fundUnit} cannot cover `u`: give each of its
   * borders not yet held what may still be deployed there, up to its hold cost (pools
   * respected). It is kept — those deploys stay, nothing is withdrawn — when the total is
   * short by at most {@link nearMissMargin} of the need, or when every short border still
   * holds against the expected attack ({@link expectedAt}: movable + deploy estimate, not the
   * trend's worst case). Otherwise every deploy is rolled back: false.
   */
  const fundNearMiss = (u: Unit): boolean => {
    const todo = u.members.filter((m) => !heldBorders.has(m.id));
    if (!todo.length) return false;
    const given = todo.map((m) => {
      const n = Math.max(0, Math.min(m.holdCost, roomAt(m.id)));
      deploy(m.id, n);
      return { m, n };
    });
    // A floor already deployed (#118) counts toward both, as if deployed here.
    const need = todo.reduce((n, m) => n + m.holdCost + (m.given ?? 0), 0);
    const total = given.reduce((n, x) => n + x.n + (x.m.given ?? 0), 0);
    const short = need - total;
    const margin = nearMissMargin(need);
    const shortOnes = given.filter((x) => x.n < x.m.holdCost);
    const holdsExpected = shortOnes.every(
      (x) => (toTake(x.m.have + x.n) ?? Infinity) > expectedAt(x.m.id),
    );
    if (short > margin && !holdsExpected) {
      for (const x of given) if (x.n > 0) undeploy(x.m.id, x.n);
      return false;
    }
    const expected = Math.max(...shortOnes.map((x) => expectedAt(x.m.id)));
    const why =
      short <= margin
        ? `short by ${short}, within the near-miss margin of ${Math.round(margin * 10) / 10}`
        : `enough to hold against the expected ~${expected} attack (movable + deploy estimate), not the worst case`;
    const one = todo.length === 1;
    warnings.push(
      `Bonus ${bonusName(u.bonusId)} (+${u.value}) is held though short: its ${todo.length} threatened border${one ? '' : 's'} need${one ? 's' : ''} ${need}, only ${total} left to deploy, so ${total ? `all ${total} go there` : 'its armies stay'} (${why}); ${shortOnes.map((x) => label(x.m.id)).join(', ')} may fall.`,
    );
    for (const { m, n } of given) {
      noteRecent(m);
      locked.add(m.id);
      heldBorders.add(m.id);
      rationale.push(
        n + (m.given ?? 0) > 0
          ? `Deploy ${n + (m.given ?? 0)} to ${label(m.id)} so bonus ${bonusName(u.bonusId)} (+${u.value}) is not conceded: ${m.have + n} armies need ${toTake(m.have + n)} to take, against the ~${m.threat} threat (its armies stay: withdrawing them would guarantee the loss).`
          : `Keep the armies on ${label(m.id)} so bonus ${bonusName(u.bonusId)} (+${u.value}) is not conceded: ${m.have} armies need ${toTake(m.have)} to take, against the ~${m.threat} threat.`,
      );
    }
    return true;
  };
  return {
    keptIncome, heldBorders, commanderHeld, buildUnits, unitBorders, concedeUnit, leftFor, fundUnit, fundNearMiss,
  };
}

/** Rule 1h's floor tier and one shared deploy (#118), the contested units, and the triage that runs them all. */
export function floorTier(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hb: HoldBook,
  prev: HoldsUpTo3,
) {
  const { g, goal, balanced, guarded, paybackTurns, label, bonusName, toTake, bonusTs, mineSet, income } = pc;
  const { warnings, rationale, locked, captured, avail } = ps;
  const { deploy, undeploy, pools, roomAt } = book;
  const local = pools !== null && pools.bonuses.length > 0;
  const { chainAt, stacksAt, borders } = threats;
  const { threatened, conceded, units, holds, pendingLocks, completable } = hb;
  /**
   * #215 review: `id` is a member of a positive bonus this turn's captures may complete without
   * it — every missing member a capture target next to another territory of mine, and its armies
   * to finish within this turn's income plus the armies on those territories (kept, `id` sends
   * none) — so rule 1c may keep `id` (and the leftover garrison it) once the captures are known.
   */
  const mayComplete = (id: number) =>
    g.map.bonuses.some((b) => {
      const cost = completable.get(b.id);
      const ts = bonusTs.get(b.id) ?? [];
      if (cost === undefined || b.value <= 0 || !ts.includes(id)) return false;
      const sourcesOf = (x: number) => neighborsOf(g, x).filter((n) => mineSet.has(n) && n !== id);
      const missing = ts.filter((x) => !mineSet.has(x));
      // A member only `id` reaches is completed out of `id` itself: no reason to keep it locked.
      if (missing.some((x) => !sourcesOf(x).length)) return false;
      const near = new Set(missing.flatMap(sourcesOf));
      return cost <= income + [...near].reduce((n, x) => n + avail.get(x)!, 0);
    });
  const {
    uneconomic, acting, concedeUnaffordable, heldStack, hold, heldBorders, commanderHeld, buildUnits, unitBorders,
    concedeUnit, leftFor, fundUnit, fundNearMiss,
  } = prev;
  // ---- 1h. floor tier and one shared deploy (#118) ----
  // One enemy deploy lands on one target. Sizing every border of a held bonus for the whole of
  // it conceded every bonus once the deploy outgrew them, though the stacks already next to the
  // borders could take none. So a held bonus first gets its floor — every threatened border beats
  // the armies already next to it — and, when it is not then held whole, what is left is spread
  // over its borders so the deploy must be aimed at a border to break it.
  /**
   * The most movable armies (special units included) one enemy player has next to my `t`: its
   * visible stacks, and (#164) its hidden pool once per border and its stacks that left view, as
   * {@link forceAt} counts them — a hidden stack is armies already there, not deploy to aim.
   * #199: a Multi-Attack chain of a stack's armies alone (no deploy) lands armies already there too.
   */
  const adjacentMovable = (t: number) => {
    const gone = (n: number) => captured.has(n);
    const byPlayer = stacksAt(t, gone, false);
    const chain = chainAt(t, gone, true)?.armies ?? 0;
    return Math.max(0, chain, ...[...byPlayer.values()].map((p) => p.stacks.reduce((n, x) => n + x.movable, 0)));
  };
  /** The deploys `m` needs to beat the armies already next to it (never more than its hold cost). */
  const floorOf = (m: Threatened) => {
    const movable = adjacentMovable(m.id);
    let d = 0;
    while (d < m.holdCost && (toTake(m.have + m.units + d) ?? Infinity) <= movable) d++;
    return d;
  };
  /** Deploy `n` to `m` as part of its hold: what it has grows and what its hold still needs shrinks. */
  const give = (m: Threatened, n: number) => {
    deploy(m.id, n);
    m.have += n;
    m.holdCost -= n;
    m.given = (m.given ?? 0) + n;
  };
  /**
   * Fund the floors of `us` — units about to be conceded — best value per army first (ties:
   * cheaper, then its first border's id), all of a unit's floor or none; a unit whose floor is
   * funded is `floored`.
   */
  const floorUnits = (us: readonly Unit[]) => {
    const need = (u: Unit) => u.members.filter((m) => !commanderHeld.has(m.id)).map((m) => ({ m, f: floorOf(m) }));
    // A floor only helps where the deploy must choose: against a player with one threatened
    // border of mine to aim at, all of its deploy lands there, and a floor alone saves nothing.
    const targetsOf = new Map<number, number>();
    for (const t of threatened) {
      const p = borders.get(t.id)?.player;
      if (p !== undefined) targetsOf.set(p, (targetsOf.get(p) ?? 0) + 1);
    }
    const spread = (u: Unit) => u.members.every((m) => (targetsOf.get(borders.get(m.id)?.player ?? -1) ?? 0) >= 2);
    const order = us
      .filter(spread)
      .map((u) => ({ u, cost: need(u).reduce((n, x) => n + x.f, 0) }))
      .sort((a, b) => (b.cost ? b.u.value / b.cost : Infinity) - (a.cost ? a.u.value / a.cost : Infinity) || a.cost - b.cost || a.u.members[0]!.id - b.u.members[0]!.id);
    for (const { u } of order) {
      // Recomputed: a border shared with a unit floored before it already has its floor.
      const todo = need(u).filter((x) => x.f > 0);
      if (todo.reduce((n, x) => n + x.f, 0) > ps.budget) continue;
      const done: { m: Threatened; f: number }[] = [];
      let fits = true;
      for (const x of todo) {
        if (x.f > roomAt(x.m.id)) {
          fits = false;
          break;
        }
        give(x.m, x.f);
        done.push(x);
      }
      if (!fits) {
        for (const x of done) {
          undeploy(x.m.id, x.f);
          x.m.have -= x.f;
          x.m.holdCost += x.f;
          x.m.given = (x.m.given ?? 0) - x.f;
        }
        continue;
      }
      u.floored = true;
      rationale.push(
        ...done.map(
          (x) =>
            `Floor for bonus ${bonusName(u.bonusId)} (+${u.value}): deploy ${x.f} to ${label(x.m.id)} so its ${x.m.have} armies beat the ${adjacentMovable(x.m.id)} already next to it (${toTake(x.m.have + x.m.units)} to take): one enemy deploy lands on one target, so every border first holds against what is already there.`,
        ),
      );
    }
  };
  /**
   * #122: would `u` survive on `left` armies short of its whole hold — kept as a near miss (short
   * by at most {@link nearMissMargin}) or floored (every border faces a player with two or more
   * targets, and its floor fits)? An estimate for rule 1h.3's starve check: `left` is pool-aware
   * under Local Deployment (the caller passes what may be deployed on its borders), but the
   * expected-attack test of the near miss and `fundable`'s greedy order are left out.
   */
  const keptShort = (u: Unit, left: number): 'near' | 'floor' | null => {
    const todo = u.members.filter((m) => !heldBorders.has(m.id));
    const need = todo.reduce((n, m) => n + m.holdCost, 0);
    if (need - left <= nearMissMargin(need)) return 'near';
    const targetsOf = new Map<number, number>();
    for (const t of threatened) {
      const p = borders.get(t.id)?.player;
      if (p !== undefined) targetsOf.set(p, (targetsOf.get(p) ?? 0) + 1);
    }
    const spread = todo.every((m) => (targetsOf.get(borders.get(m.id)?.player ?? -1) ?? 0) >= 2);
    return spread && todo.reduce((n, m) => n + floorOf(m), 0) <= left ? 'floor' : null;
  };
  /** Keep a floored unit that is not held whole (#118): its borders stay, nothing is withdrawn. */
  const contest = (u: Unit) => {
    u.contested = true;
    for (const m of u.members) locked.add(m.id);
  };
  /** A unit that cannot be held whole now: floored and kept when it can be (#118), else conceded whole. */
  const floorOrConcede = (u: Unit, left: number, single: (t: Threatened, quiet: boolean) => void) => {
    floorUnits([u]);
    if (u.floored) contest(u);
    else concedeUnit(u, { economic: false, left }, single);
  };
  /** Its borders' threat beyond the armies already next to them: the opponent's deploy (or growth). */
  const deployShare = (m: Threatened) => m.threat - adjacentMovable(m.id);
  /**
   * After the captures (the better use of the armies): hold each contested unit whole when what
   * is left covers it (best worth per army first), else spread what is left over the borders
   * still short, one army at a time to the one the opponent's deploy breaks most cheaply (ties:
   * the higher bonus value, then id), each up to its full hold.
   */
  /** A member of a unit conceded after the captures, judged on its own (rule 1a, against what is left). */
  const singleLate = (t: Threatened, quiet: boolean) => {
    if (t.critical) return;
    if (uneconomic(t)) {
      conceded.add(t.id);
      if (!quiet) warnings.push(`${label(t.id)} cannot be held economically (needs ${t.holdCost}, protects +${t.value}): conceded`);
      return;
    }
    const room = roomAt(t.id);
    if (t.holdCost > room) {
      if (quiet) conceded.add(t.id);
      else concedeUnaffordable(t, room);
      return;
    }
    hold(t);
    heldBorders.add(t.id);
  };
  /** Armies the opponent's deploy needs on my `m` to take it, with `have` armies there. */
  const breakCostWith = (m: Threatened, have: number) => (toTake(have + m.units) ?? Infinity) - adjacentMovable(m.id);
  /**
   * The bonus value the opponents' best response takes from the floored units in `us`, given
   * the armies on each border: per player, its one deploy split to break the most value (each
   * unit broken through its cheapest short border facing that player; a 0/1 knapsack), as
   * `guaranteedFalls` sizes a single budget on offence.
   */
  const bestResponse = (us: readonly Unit[], have: ReadonlyMap<Threatened, number>, short: (m: Threatened) => boolean) => {
    const players = new Map<number, { deploy: number; items: Map<Unit, number> }>();
    for (const u of us)
      for (const m of u.members) {
        if (!short(m)) continue;
        const p = borders.get(m.id)?.player;
        if (p === undefined) continue;
        const e = players.get(p) ?? { deploy: 0, items: new Map<Unit, number>() };
        e.deploy = Math.max(e.deploy, deployShare(m));
        const c = Math.max(0, breakCostWith(m, have.get(m) ?? m.have));
        e.items.set(u, Math.min(e.items.get(u) ?? Infinity, c));
        players.set(p, e);
      }
    let loss = 0;
    const by: { player: number; deploy: number; units: Unit[]; of: Unit[]; cost: number; value: number }[] = [];
    for (const [player, { deploy, items }] of [...players].sort((a, b) => a[0] - b[0])) {
      const d = Math.max(0, Math.floor(deploy));
      // best[x]: the most value x armies of the deploy break, with the cheapest such pick.
      type Pick = { value: number; cost: number; units: Unit[] };
      const best: Pick[] = Array.from({ length: d + 1 }, () => ({ value: 0, cost: 0, units: [] }));
      for (const [u, c] of items) {
        if (c > d) continue;
        for (let x = d; x >= c; x--) {
          const prev = best[x - c]!;
          const cand = { value: prev.value + u.value, cost: prev.cost + c, units: [...prev.units, u] };
          const cur = best[x]!;
          if (cand.value > cur.value || (cand.value === cur.value && cand.cost < cur.cost)) best[x] = cand;
        }
      }
      const pick = best[d]!;
      loss += pick.value;
      if (pick.value > 0) by.push({ player, deploy: d, units: pick.units, of: [...items.keys()], cost: pick.cost, value: pick.value });
    }
    return { loss, by };
  };
  const bestResponseLoss = (us: readonly Unit[], have: ReadonlyMap<Threatened, number>, short: (m: Threatened) => boolean) =>
    bestResponse(us, have, short).loss;
  /**
   * `wholeOnly` (#215, rule 0p.1: a 1v1 in contact, before the first advance): only hold each
   * contested unit whole that pays back within PAYBACK_TURNS (one CONCEDE_FACTOR made contested)
   * and that what is left covers (best worth per army first, never weighed against spreading) — no
   * concession, no spread — leaving the rest contested for the call after the captures.
   */
  const settleContested = (wholeOnly = false) => {
    const open = units.filter((u) => u.contested && !u.conceded && (!wholeOnly || u.loss !== 'payback'));
    if (!open.length) return;
    const need = (u: Unit) => u.members.filter((m) => !heldBorders.has(m.id)).reduce((n, m) => n + m.holdCost, 0);
    const ratio = (u: Unit) => u.worth / Math.max(1, need(u));
    const order = [...open].sort((a, b) => ratio(b) - ratio(a) || a.members[0]!.id - b.members[0]!.id);
    // Holding one floored unit whole can leave the others thinner than spreading the same
    // armies over all of them: simulate both and keep whole holds unless spreading loses less
    // to the opponents' best response (Local Deployment: whole holds, pools decide the room).
    const simulate = (wholeFirst: boolean) => {
      let b = ps.budget;
      const have = new Map<Threatened, number>();
      const left = new Map<Threatened, number>();
      for (const u of open)
        for (const m of u.members)
          if (!heldBorders.has(m.id)) {
            have.set(m, m.have);
            left.set(m, m.holdCost);
          }
      let lost = 0;
      for (const u of order) {
        if (u.floored && !wholeFirst) continue;
        const ms = u.members.filter((m) => (left.get(m) ?? 0) > 0);
        const more = ms.reduce((n, m) => n + left.get(m)!, 0);
        if (more <= b) {
          b -= more;
          for (const m of ms) {
            have.set(m, have.get(m)! + left.get(m)!);
            left.set(m, 0);
          }
        } else if (!u.floored) lost += u.value;
      }
      const floored = open.filter((u) => u.floored);
      const valueAt = (m: Threatened) => Math.max(0, ...floored.filter((u) => u.members.includes(m)).map((u) => u.value));
      const fill = [...new Set(floored.flatMap((u) => u.members))].filter((m) => left.has(m));
      while (b > 0) {
        const next = fill
          .filter((m) => left.get(m)! > 0)
          .sort((x, y) => breakCostWith(x, have.get(x)!) - breakCostWith(y, have.get(y)!) || valueAt(y) - valueAt(x) || x.id - y.id)[0];
        if (!next) break;
        have.set(next, have.get(next)! + 1);
        left.set(next, left.get(next)! - 1);
        b--;
      }
      return lost + bestResponseLoss(floored, have, (m) => (left.get(m) ?? 0) > 0);
    };
    // wholeOnly: whole holds first, whatever spreading would save — what is left is spread after the captures.
    const spreadFloored = !wholeOnly && !local && open.some((u) => u.floored) && simulate(false) < simulate(true);
    for (const u of order) {
      if (u.floored && spreadFloored) continue;
      const more = need(u);
      const floored = u.members.some((m) => (m.given ?? 0) > 0);
      const why =
        u.loss === 'payback'
          ? `more than it pays back in ${paybackTurns} turns`
          : u.loss === 'factor'
            ? `more than ${CONCEDE_FACTOR} × its worth`
            : null;
      if (
        more <= ps.budget &&
        fundUnit(
          u,
          undefined,
          `Hold bonus ${bonusName(u.bonusId)} (+${u.value}) whole: ${floored ? 'past its floor ' : ''}its ${unitBorders(u)} need${u.members.length === 1 ? 's' : ''} ${more}${floored ? ' more' : ''}${why ? ` (${why})` : ''}, ${
            wholeOnly
              ? 'before any expansion that completes no bonus (1v1 in contact: an advance ranks below every hold).'
              : 'and nothing else this turn uses those armies.'
          }`,
        )
      ) {
        u.contested = false;
        continue;
      }
      if (wholeOnly) continue;
      // Not floored (one target for the deploy): the old concession, now that the captures had their turn.
      if (!u.floored) {
        u.contested = false;
        concedeUnit(u, u.loss ? { economic: u.loss } : { economic: false, left: leftFor(u) }, singleLate);
        // As a conceded border always could: it may still attack out (rule 1a).
        for (const m of u.members) if (conceded.has(m.id)) locked.delete(m.id);
      }
    }
    if (wholeOnly) return;
    const short = units
      .filter((u) => u.contested && !u.conceded)
      .flatMap((u) => u.members.filter((m) => !heldBorders.has(m.id)).map((m) => ({ m, u })));
    const value = (m: Threatened) => Math.max(...short.filter((x) => x.m === m).map((x) => x.u.value));
    const members = [...new Set(short.map((x) => x.m))];
    const given = new Map<Threatened, number>();
    const breakCost = (m: Threatened) => breakCostWith(m, m.have);
    if (spreadFloored)
      rationale.push(
        `Spread what is left over the floored bonuses' borders rather than hold one whole: against the opponent's best use of its deploy that loses less.`,
      );
    while (ps.budget > 0) {
      const next = members
        .filter((m) => m.holdCost > 0 && roomAt(m.id) > 0)
        .sort((a, b) => breakCost(a) - breakCost(b) || value(b) - value(a) || a.id - b.id)[0];
      if (!next) break;
      give(next, 1);
      given.set(next, (given.get(next) ?? 0) + 1);
    }
    for (const [m, n] of [...given].sort((a, b) => a[0].id - b[0].id))
      rationale.push(
        m.holdCost <= 0
          ? `Deploy ${n} more to ${label(m.id)} so it holds (${m.have} armies, ${toTake(m.have + m.units)} to take, above the ~${m.threat} threat).`
          : `Deploy ${n} more to ${label(m.id)} against the one shared deploy: ${m.have} armies, so player ${borders.get(m.id)?.player}'s deploy needs ${breakCost(m)} of its ~${deployShare(m)} there to take it.`,
      );
    for (const m of members) if (m.holdCost <= 0) heldBorders.add(m.id);
    const stillShort: Unit[] = [];
    for (const u of units) {
      if (!u.contested || u.conceded) continue;
      const left = u.members.filter((m) => !heldBorders.has(m.id));
      if (!left.length) {
        u.contested = false;
        continue;
      }
      stillShort.push(u);
      warnings.push(
        `Bonus ${bonusName(u.bonusId)} (+${u.value}) is not safe against the whole enemy deploy (its ${unitBorders(u)} would need ${left.reduce((n, m) => n + m.holdCost, 0)} more), but it is not conceded: every border beats the armies already next to it, so it falls only to armies deployed against it — ${left.map((m) => `${label(m.id)} (${m.have} armies; ${breakCost(m)} of the ~${deployShare(m)} deploy take it)`).join(', ')}.`,
      );
    }
    // Read together, the lines above can suggest one deploy breaks only one bonus: say what
    // each opponent's best use of its one deploy breaks (the same knapsack the spread used).
    const have = new Map(stillShort.flatMap((u) => u.members.map((m) => [m, m.have] as const)));
    for (const r of bestResponse(stillShort, have, (m) => !heldBorders.has(m.id)).by) {
      const list = (us: readonly Unit[]) => {
        const names = us.map((u) => bonusName(u.bonusId));
        return `bonus${names.length > 1 ? 'es' : ''} ${names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]}`;
      };
      const what = r.units.length === r.of.length ? `${list(r.units)}${r.units.length > 1 ? ' at once' : ''}` : `${r.units.length} of ${list(r.of)}`;
      warnings.push(`Player ${r.player}'s ~${r.deploy} deploy can still break ${what} (${r.cost} of it needed): +${r.value} at risk this turn.`);
    }
  };

  const triage = () => {
    // ---- 1k. my commander's border is must-hold (#61) ----
    // Losing the commander eliminates me: its border is never conceded, and it is held
    // first, under every goal. When the hold does not fit, everything left that may be
    // deployed there goes there, and nothing leaves it.
    for (const t of threatened) {
      if (!t.critical) continue;
      heldBorders.add(t.id);
      locked.add(t.id);
      const room = roomAt(t.id);
      if (t.holdCost <= room) {
        deploy(t.id, t.holdCost);
        commanderHeld.add(t.id);
        rationale.push(
          `Deploy ${t.holdCost} to ${label(t.id)}: my commander stands there, so it must hold (losing the commander eliminates me): ${heldStack(t)} need ${toTake(t.have + t.units + t.holdCost)} to take, above the ~${t.threat} threat.`,
        );
        continue;
      }
      deploy(t.id, room);
      warnings.push(
        `My commander's territory ${label(t.id)} cannot be made safe this turn: it needs ${t.holdCost} more armies against the ~${t.threat} threat, but only ${room} can be deployed there. ${room ? `All ${room} go there, and` : 'Still,'} nothing leaves it (losing the commander eliminates me; it is never conceded).`,
      );
    }
    let triageBudget = ps.budget;
    buildUnits();
    if (goal === 'expand')
      for (const u of units)
        if (!u.loss)
          warnings.push(
            `goal expand does not defend held bonus ${bonusName(u.bonusId)} (+${u.value}) first: holding its ${unitBorders(u)} needs ${u.cost} (it pays back within ${paybackTurns} turns).`,
          );
    if (!guarded) units.length = 0;
    /** The per-border triage of rule 1a. */
    const single = (t: Threatened, quiet = false) => {
      // My commander's border is already held (rule 1k).
      if (t.critical) return;
      const left = Math.min(acting ? ps.budget : triageBudget, local ? roomAt(t.id) : Infinity);
      if (uneconomic(t)) {
        conceded.add(t.id);
        if (!quiet)
          warnings.push(`${label(t.id)} cannot be held economically (needs ${t.holdCost}, protects +${t.value}): conceded`);
        return;
      }
      if (balanced) {
        // #215: a hold no deploy this turn can pay for is conceded now, not left to the greedy
        // step: locked as a pending hold, its armies could not attack out (a border taken last
        // turn from a weak opponent, exempt from the economic test, sat on 7 armies beside a 2-army
        // member of an enemy bonus while the deploy went elsewhere). The budget only shrinks from
        // here, so the greedy step could never have held it.
        // Never quiet here: under `balanced` this triage runs only non-quietly (quiet concessions
        // go through the greedy step's `singleNow` / `singleLate`).
        // #215 review: not a member of a bonus this turn's captures may complete — conceded now, it
        // attacked out (under No-Split with its whole stack) before rule 1c kept it for the completed
        // bonus, empty. Left pending, the greedy step concedes it and decides once the captures are
        // known (planner.ts `concedePending`).
        if (t.holdCost > left && !mayComplete(t.id)) return concedeUnaffordable(t, left);
        // Its armies stay put until the greedy step decides: holding assumes they are all there.
        holds.push(t);
        if (!locked.has(t.id)) pendingLocks.add(t.id);
        locked.add(t.id);
        return;
      }
      if (t.holdCost > left) {
        if (quiet) conceded.add(t.id);
        else concedeUnaffordable(t, left);
        return;
      }
      triageBudget -= t.holdCost;
      if (acting) {
        hold(t);
        heldBorders.add(t.id);
      }
    };
    // #118: CONCEDE_FACTOR and the payback test concede a floored unit only when the armies have
    // a better use: it is kept, and held whole after the captures if what is left covers it.
    const losing = units.filter((u) => u.loss);
    floorUnits(losing);
    for (const u of losing) contest(u);
    type Item = { unit: Unit } | { border: Threatened };
    const items: Item[] = [
      ...units.filter((u) => !u.conceded && !u.contested).map((unit) => ({ unit })),
      ...threatened.filter((t) => !units.some((u) => u.members.some((m) => m.id === t.id))).map((border) => ({ border })),
    ];
    if (!acting) {
      // Under `balanced` the units compete in the greedy step; their members stay put.
      for (const u of units) if (!u.conceded && !u.contested) for (const m of u.members) locked.add(m.id);
      for (const it of items) if ('border' in it) single(it.border);
      return;
    }
    // `defend`: units and single borders by worth per army (a recent capture first).
    const key = (it: Item) =>
      'unit' in it
        ? { recent: it.unit.members.some((m) => m.recentFrom !== undefined), ratio: it.unit.worth / it.unit.net, cost: it.unit.cost, id: it.unit.members[0]!.id }
        : { recent: it.border.recentFrom !== undefined, ratio: it.border.worth / it.border.holdCost, cost: it.border.holdCost, id: it.border.id };
    items.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return Number(y.recent) - Number(x.recent) || y.ratio - x.ratio || x.cost - y.cost || x.id - y.id;
    });
    for (const it of items) {
      if ('border' in it) {
        if (!heldBorders.has(it.border.id) && !conceded.has(it.border.id)) single(it.border);
        continue;
      }
      if (!fundUnit(it.unit) && !fundNearMiss(it.unit)) floorOrConcede(it.unit, leftFor(it.unit), single);
    }
  };
  return { keptShort, floorOrConcede, settleContested, triage, mayComplete };
}

/**
 * #215: I am known to move first (#127) — from a source the hold sizing trusts: one the user gave,
 * not the award of picks' unverified rule (`movesFirstUnverified`, #215 review) — and no opponent
 * may hold an Order Priority card (`opponentsMayHoldOrderPriority`, #215 review): played, it puts
 * its first order (an all-in on a border) before my first.
 */
export const knownFirst = (pc: PlanCtx) =>
  pc.opts.movesFirst === true && pc.opts.movesFirstUnverified !== true && pc.opts.opponentsMayHoldOrderPriority !== true;

/**
 * #215: the armies withdrawn into my `id` this turn (rule 1b) that a hold may count only if I move
 * first. A transfer in is my own order: when the opponent moves first, its first order — an all-in
 * on `id` — runs before any of mine. So unless I am known to move first (#127, {@link knownFirst})
 * they are late, and a hold sized for the worse order leaves them out. 0 when I am known to move first.
 */
export function lateArrivals(pc: PlanCtx, ps: PlanState, id: number): number {
  return knownFirst(pc) ? 0 : withdrawnInto(ps, id);
}

/** #215: the armies withdrawn into my `id` this turn (rule 1b), whatever the move order. */
export function withdrawnInto(ps: PlanState, id: number): number {
  const sent = ps.moves.reduce((n, m) => (m.kind === 'transfer' && m.to === id ? n + m.armies : n), 0);
  return Math.max(0, Math.min(ps.incoming.get(id) ?? 0, sent));
}

/** Rule 1b: withdraw from conceded borders (and Order Priority when a withdrawal must go first). */
export function withdrawals(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hb: HoldBook,
  prev: HoldsUpTo4,
) {
  const { g, label, bonusName, mine, mineSet, unitsAt, toTake, noSplit } = pc;
  const { warnings, rationale, avail, locked, moves, incoming } = ps;
  const { coverOf, orderOf, warnSplit, pools, valueOf } = book;
  const local = pools !== null && pools.bonuses.length > 0;
  const { expectedAt, borders } = threats;
  const { conceded, units } = hb;
  const { stayAt, unitBorders } = prev;
  // ---- 1b. withdraw from conceded borders ----
  ps.cardAdvice = null;
  /** Conceded borders of a held bonus whose garrison stays (it holds against the expected attack). */
  const stood = new Set<number>();
  /** Bonuses whose Local Deployment concession warning (#103) is already given. */
  const warnedLocal = new Set<number>();
  /** Local Deployment (#103): conceded borders of a held bonus that might still hold; the leftover may go there. */
  const mayHold = new Set<number>();
  /** Local Deployment: the armies every pool containing `id` holds this turn. */
  const poolsAt = (id: number) =>
    local ? pools.bonuses.filter((p) => p.territoryIds.includes(id)).reduce((n, p) => n + p.value, 0) : 0;
  /** A border no deploy this turn can hold: its hold needs more than its pools and every free army. */
  const lostAnywayAt = (m: Threatened) => local && m.holdCost > poolsAt(m.id) + pools.anywhere;
  /** A held bonus that falls whatever this turn deploys: one of its threatened borders cannot be held. */
  const lostAnyway = (u: Unit) => u.members.some(lostAnywayAt);
  const withdraw = () => {
    if (!conceded.size) return;
    const withdrawals: PlannedMove[] = [];
    const keep = (id: number) => mineSet.has(id) && !conceded.has(id);
    // Borders that can hold: mine, not conceded, next to something not mine.
    const holding = mine.filter((id) => keep(id) && neighborsOf(g, id).some((n) => !mineSet.has(n)));
    for (const t of [...conceded].sort(byNum)) {
      // #179: a covered exit keeps its cover; only the rest may leave.
      const n = avail.get(t)! - coverOf(t);
      // No-Split (#124): a transfer sends the whole stack, so a covered exit sends none.
      if (n <= 0 || (noSplit && coverOf(t) > 0)) continue;
      // Issue #59: a held bonus's border keeps its garrison while it still holds against the
      // expected attack — withdrawing it would guarantee the loss.
      const held = g.map.bonuses
        .filter((b) => {
          const ts = bonusTerritories(g, b.id);
          return b.value > 0 && ts.includes(t) && ts.every((x) => mineSet.has(x));
        })
        .sort((a, b) => a.id - b.id);
      const stays = stayAt(t);
      const take = toTake(stays) ?? Infinity;
      const expected = expectedAt(t);
      if (held.length && take > expected) {
        locked.add(t);
        stood.add(t);
        rationale.push(
          `Keep the ${n} movable armies on ${label(t)} (not withdrawn): it is a border of held bonus ${held.map((b) => bonusName(b.id)).join(', ')}, and its ${stays} armies need ${take} to take, above the expected ~${expected} attack (movable + deploy estimate).`,
        );
        continue;
      }
      // Local Deployment (#103): a conceded held bonus keeps its garrisons unless it truly
      // cannot be held — some threatened border needs more than its pools and every free army
      // could give it. Withdrawing turns "might lose it" into "certainly loses it".
      if (local && held.length) {
        const mine1 = units.filter((u) => u.conceded && u.members.some((m) => m.id === t));
        const maybe = mine1.filter((u) => !lostAnyway(u));
        if (maybe.length) {
          locked.add(t);
          stood.add(t);
          mayHold.add(t);
          for (const u of maybe) {
            if (warnedLocal.has(u.bonusId)) continue;
            warnedLocal.add(u.bonusId);
            warnings.push(
              `Bonus ${bonusName(u.bonusId)} (+${u.value}) is conceded but might still hold: each of its ${unitBorders(u)} could be held with its own ${u.pool} local armies and the ${pools.anywhere} free ones, so its garrisons stay and its local armies defend it (withdrawing would make the loss certain); it may fall.`,
            );
          }
          rationale.push(
            `Keep the ${n} movable armies on ${label(t)} (not withdrawn): bonus ${maybe.map((u) => bonusName(u.bonusId)).join(', ')} might still hold under Local Deployment, and withdrawing would guarantee the loss.`,
          );
          continue;
        }
        for (const u of mine1) {
          if (warnedLocal.has(u.bonusId)) continue;
          warnedLocal.add(u.bonusId);
          const worst = u.members.find((m) => lostAnywayAt(m))!;
          warnings.push(
            `Bonus ${bonusName(u.bonusId)} (+${u.value}) cannot be held: ${label(worst.id)} needs ${worst.holdCost}, more than its own ${poolsAt(worst.id)} local armies and all ${pools.anywhere} free ones could give it, so its garrisons withdraw (it is lost either way).`,
          );
        }
      }
      const options = neighborsOf(g, t)
        .filter(keep)
        .map((c) => {
          const dist = bfsDistances(g, [c], { passable: keep });
          let best = Infinity;
          let value = 0;
          for (const h of holding) {
            const d = dist.get(h);
            if (d === undefined) continue;
            if (d < best || (d === best && valueOf(h) > value)) [best, value] = [d, valueOf(h)];
          }
          return { id: c, best, value };
        })
        .sort((a, b) => a.best - b.best || b.value - a.value || a.id - b.id);
      const to = options[0];
      if (!to) {
        warnings.push(`${label(t)} is conceded and has nowhere to withdraw to: its ${n} movable armies stay.`);
        continue;
      }
      // #118: a border of a bonus I hold in full keeps its garrison — those armies kill attackers
      // where they stand — unless withdrawing them makes another valued border hold this turn.
      // (Under Local Deployment rule 1b's pool test above decides instead.)
      if (held.length && !local) {
        const dest = borders.get(to.id);
        const at = stayAt(to.id) + unitsAt(to.id);
        const makesHold =
          dest !== undefined &&
          !conceded.has(to.id) &&
          valueOf(to.id) > 0 &&
          (toTake(at) ?? Infinity) <= dest.threat &&
          (toTake(at + n) ?? Infinity) > dest.threat;
        if (!makesHold) {
          locked.add(t);
          stood.add(t);
          rationale.push(
            `Keep the ${n} movable armies on ${label(t)} (not withdrawn): it is a border of held bonus ${held.map((b) => bonusName(b.id)).join(', ')}, and withdrawing them would make no other valued border hold this turn, while there they kill attackers.`,
          );
          continue;
        }
      }
      if (orderOf(t)) {
        warnSplit(t, `its ${n} remaining armies are not withdrawn to ${label(to.id)}`);
        locked.add(t);
        continue;
      }
      avail.set(t, avail.get(t)! - n);
      locked.add(t);
      const reason = 'withdraws from a conceded border';
      withdrawals.push({ from: t, to: to.id, armies: n, kind: 'transfer', reason });
      incoming.set(to.id, (incoming.get(to.id) ?? 0) + n);
      rationale.push(`Withdraw ${n} from ${label(t)} to ${label(to.id)}: ${reason}, toward a border that holds.`);
      warnings.push(
        `The withdrawal from ${label(t)} only executes if ${label(t)} is still mine when the order runs; play Order Priority so it goes first.`,
      );
      ps.cardAdvice = 'order-priority';
    }
    // Withdrawals go first: they only execute while the border is still mine.
    moves.unshift(...withdrawals);
  };
  return { stood, mayHold, withdraw };
}

/** Rule 1c (R2): reconsider concessions after the capture passes; #122: garrison a bonus completed this turn. */
export function reconsiderAndGarrison(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hb: HoldBook,
  prev: HoldsUpTo5,
) {
  const { g, guarded, reserve, paybackTurns, label, bonusName, mine, mineSet, unitsAt, toTake, myCommanders } = pc;
  const { warnings, rationale, deployed, locked, captured, moves } = ps;
  const { orderOf, deploy, pools, valueCache, valueOf } = book;
  const local = pools !== null && pools.bonuses.length > 0;
  const { borders } = threats;
  const { conceded, kept, garrisoned } = hb;
  const { stayAt, heldBorders } = prev;
  // ---- 1c. reconsider concessions after the capture passes (R2) ----
  // Triage ran before captures were known, so a border in a bonus this turn's
  // captures complete was valued +0 and conceded. Re-value every border against
  // the holdings after the captures; a conceded border in a bonus completed this
  // turn is kept (never withdrawn from) and garrisoned from the leftover.
  const reconsider = () => {
    if (!captured.size) return;
    ps.holdings = new Set([...mine, ...captured]);
    valueCache.clear();
    if (!conceded.size) return;
    for (const t of [...conceded].sort(byNum)) {
      // Already withdrawn from (rule 1b ran first): its armies are gone, and it stays conceded.
      if (moves.some((m) => m.from === t && m.reason === 'withdraws from a conceded border')) continue;
      const completes = g.map.bonuses
        .filter((b) => {
          const ts = bonusTerritories(g, b.id);
          return b.value > 0 && ts.includes(t) && ts.every((x) => ps.holdings.has(x)) && !ts.every((x) => mineSet.has(x));
        })
        .sort((a, b) => a.id - b.id);
      if (!completes.length) continue;
      conceded.delete(t);
      kept.add(t);
      locked.add(t);
      // Drop its concession warning: it is no longer conceded.
      const conceding = `${label(t)} cannot be held `;
      for (let i = warnings.length - 1; i >= 0; i--)
        if (warnings[i]!.startsWith(conceding) && warnings[i]!.endsWith(': conceded')) warnings.splice(i, 1);
      rationale.push(
        `Keep ${label(t)} (not conceded): this turn's captures complete ${completes.map((b) => `bonus ${b.name} (#${b.id}) (+${b.value})`).join(', ')}, so it protects +${valueOf(t)}.`,
      );
    }
  };
  // (Under `defend` the withdrawal runs after the capture passes, once `reconsider` has
  // kept any border this turn's captures make valuable; it still goes first in the orders.)

  // ---- #122: a bonus completed this turn is garrisoned like a held one (rule 1h) ----
  // Its members I held at the start of the turn that face an enemy would otherwise get only the
  // leftover (rule 1c), after every advance had spent the income: live, completed bonuses stood
  // beside enemies on 1-army borders and never paid a turn. So once a capture completes a bonus,
  // its threatened members are held whole right away — before any later capture — when the holds
  // pay for themselves as a held bonus's do (cost ≤ PAYBACK_TURNS × value and ≤ CONCEDE_FACTOR ×
  // its worth) and fit what may still be deployed; otherwise they are left to the leftover as
  // before. Captured members are not garrisoned: next turn's deploys land before any attack.
  /** Bonuses whose garrison was judged (funded or not), so each is judged once. */
  const garrisonJudged = new Set<number>();
  /** Do these deploys fit together what may still be deployed (the budget, and the pools under Local Deployment)? */
  const fitsTogether = (adds: readonly { id: number; d: number }[]): boolean => {
    if (adds.reduce((n, x) => n + x.d, 0) > ps.budget) return false;
    if (!local) return true;
    const next = new Map(deployed);
    for (const x of adds) next.set(x.id, (next.get(x.id) ?? 0) + x.d);
    return chargeDeploys(pools, next).anywhereUsed <= pools.anywhere;
  };
  const garrisonCompleted = () => {
    if (!guarded || !captured.size) return;
    const after = new Set([...mine, ...captured]);
    for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
      if (b.value <= 0 || garrisonJudged.has(b.id)) continue;
      const ts = bonusTerritories(g, b.id);
      if (!ts.length || !ts.every((x) => after.has(x)) || ts.every((x) => mineSet.has(x))) continue;
      garrisonJudged.add(b.id);
      const todo: { id: number; d: number; threat: number }[] = [];
      let have = 0;
      let split = false;
      for (const t of ts) {
        const border = borders.get(t);
        if (!mineSet.has(t) || !border || heldBorders.has(t) || myCommanders.has(t)) continue;
        const stays = stayAt(t) + unitsAt(t);
        let d = 0;
        while ((toTake(stays + d) ?? Infinity) <= border.threat) d++;
        if (!d) continue;
        // No-Split: a deploy on a territory that already issues an order leaves with it.
        if (orderOf(t)) split = true;
        todo.push({ id: t, d, threat: border.threat });
        have += stays;
      }
      if (!todo.length || split) continue;
      const cost = todo.reduce((n, x) => n + x.d, 0);
      const worth = b.value + have / paybackTurns;
      if (cost > paybackTurns * b.value || cost > CONCEDE_FACTOR * worth || cost > ps.budget - reserve) continue;
      // The pools are checked for the members together: each may fit the free pool on its own
      // while together they overdraw it.
      if (!fitsTogether(todo)) continue;
      for (const x of todo) {
        deploy(x.id, x.d);
        garrisoned.add(x.id);
        heldBorders.add(x.id);
        locked.add(x.id);
        const stays = stayAt(x.id) + unitsAt(x.id);
        rationale.push(
          `Garrison ${label(x.id)} for bonus ${bonusName(b.id)} (+${b.value}), completed this turn: deploy ${x.d} so its ${stays} armies need ${toTake(stays)} to take, above the ~${x.threat} threat — held like a bonus held at the start, before any later capture, not left to the leftover.`,
        );
      }
    }
  };
  return { reconsider, garrisonCompleted };
}

type HoldsUpTo0 = ReturnType<typeof holdBasics>;
type HoldsUpTo1 = HoldsUpTo0 & ReturnType<typeof twoStepHolds>;
type HoldsUpTo2 = HoldsUpTo1 & ReturnType<typeof holdOrConcede>;
type HoldsUpTo3 = HoldsUpTo2 & ReturnType<typeof heldBonusUnits>;
type HoldsUpTo4 = HoldsUpTo3 & ReturnType<typeof floorTier>;
type HoldsUpTo5 = HoldsUpTo4 & ReturnType<typeof withdrawals>;
