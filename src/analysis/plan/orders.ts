// The deploy book of a planning pass (#133): what every later phase deploys and moves through —
// the budget (`ps.budget`), the guard and #165's sentinels, deploy / undeploy, Local Deployment's
// pools and the room they leave, the income change of a capture (#70), and the protected value of
// a territory of mine (R2, #122, #128) judged against `ps.holdings`. Run once, right after the
// estimates: it sets the starting `avail`, pays the sentinels, and states both in the rationale.
import { bonusTerritories } from '../bonuses.js';
import { breachBehind, type Breach } from '../breach.js';
import { neighborsOf } from '../graph.js';
import { chargeDeploys, deployPools } from '../local-deploy.js';
import { territoryIncome } from '../player.js';
import { BREACH_WEIGHT, WASTELAND_FACTOR, type PlannedMove } from './shared.js';
import type { PlanCtx, PlanState } from './state.js';
import { byNum } from './util.js';
import { secondLineOf } from './guard-off.js';


/** #235: what losing a territory of mine cuts off from the rest of my holdings ({@link deployBook}'s `cutOff`). */
export interface Cut {
  /** The territories cut off. */
  ids: number[];
  /** My armies on them at the start of the turn. */
  armies: number;
  /** The income they make: the positive bonuses held in full inside them, plus their per-territory income. */
  income: number;
}

/** The deploy book: the helpers every phase deploys, moves and values territories through. */
export type DeployBook = ReturnType<typeof deployBook>;

/** Open the deploy book of one pass: sets `ps.budget`, `ps.holdings` and the starting `avail`. */
export function deployBook(ctx: PlanCtx, ps: PlanState) {
  const {
    g, territories: state, s, mine, mineSet, myCommanders, foe, guard, noSplit, armiesOf, incomeGain, label, income,
    reserve, econCostAt, paybackTurns, baseIncome, unitsAt, deployOf, untrustedAt,
  } = ctx;
  const { warnings, rationale, deployed, avail, coverKeep, captured, moves } = ps;
  // ---- mutable plan state ----
  ps.budget = income;
  // #165: with the guard off, a territory of mine next to a visible enemy at the start of the turn
  // keeps one army all the same (an empty territory falls to any single army) — never my commander's
  // (it is not empty), and not under No-Split (an order sends the whole stack).
  const sentinel = new Set(
    guard || noSplit
      ? []
      : mine.filter(
          (id) =>
            !myCommanders.has(id) &&
            neighborsOf(g, id).some((n) => {
              const o = state.get(n)?.owner;
              return o?.kind === 'player' && foe(o.playerId);
            }),
        ),
  );
  // #276: with the guard off, an interior member of a held bonus within two moves of a big enemy
  // stack keeps a garrison one army cannot take (plan/guard-off.ts): what stands there now, up to it;
  // `fillSecondLine` deploys the rest before the leftover.
  const secondLine = secondLineOf(ctx);
  const secondLineKept = new Map([...secondLine].map(([id, e]) => [id, Math.min(e.size, Math.max(0, armiesOf(id)))]));
  /**
   * Armies that stay on my `id` whatever its orders: the guard, or (#165) the army kept next to an
   * enemy, or (#276) a second-line garrison.
   */
  const guardAt = (id: number) => (guard || sentinel.has(id) ? 1 : (secondLineKept.get(id) ?? 0));
  // May start at −1 (a 0-army territory still owes its guard): deploys there pay for it first.
  for (const id of mine) avail.set(id, armiesOf(id) - guardAt(id));
  /** #179: what my `x` keeps to cover a finished-off player's exit, in `avail` terms (0 when none). */
  const coverOf = (x: number) => coverKeep.get(x) ?? 0;


  // ---- income change (#70): the one computation nextIncome, R3 and the negative-bonus rules use ----
  const heldNow = () => new Set([...mine, ...captured]);
  /** The income change of also capturing `ts`, on top of this turn's captures so far. */
  const gainWith = (ts: readonly number[]): number => {
    const now = heldNow();
    return incomeGain(new Set([...now, ...ts])) - incomeGain(now);
  };
  /** Under No-Split, the order `x` already issues (its only one); otherwise always `undefined`. */
  const orderOf = (x: number): PlannedMove | undefined => (noSplit ? moves.find((m) => m.from === x) : undefined);
  const describeOrder = (m: PlannedMove) =>
    m.kind === 'attack' ? `attacks ${label(m.to)}` : `transfers to ${label(m.to)}`;
  /** A No-Split warning: `x` already issues an order, so `what` is not planned. Never repeated. */
  const warnSplit = (x: number, what: string) => {
    const w = `No-Split: ${label(x)} already ${describeOrder(orderOf(x)!)}, so ${what} (one attack or transfer per territory).`;
    if (!warnings.includes(w)) warnings.push(w);
  };
  const deploy = (id: number, n: number) => {
    if (n <= 0) return;
    deployed.set(id, (deployed.get(id) ?? 0) + n);
    avail.set(id, avail.get(id)! + n);
    ps.budget -= n;
  };
  const undeploy = (id: number, n: number) => {
    const d = (deployed.get(id) ?? 0) - n;
    if (d > 0) deployed.set(id, d);
    else deployed.delete(id);
    avail.set(id, avail.get(id)! - n);
    ps.budget += n;
  };

  // ---- Local Deployment pools ----
  const pools = s.localDeployments ? deployPools(g, mineSet, income) : null;
  const local = pools !== null && pools.bonuses.length > 0;
  /** Armies that may still be deployed on `id` (pools respected; with Local Deployment off, the budget). */
  const roomAt = (id: number): number => {
    if (!local || ps.budget <= 0) return ps.budget;
    const fits = (n: number) => {
      const next = new Map(deployed);
      next.set(id, (next.get(id) ?? 0) + n);
      return chargeDeploys(pools, next).anywhereUsed <= pools.anywhere;
    };
    let lo = 0;
    let hi = ps.budget;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  /** Armies a capture may still deploy on `id`: its room, less the reserve. */
  const spareAt = (id: number) => Math.min(ps.budget - reserve, roomAt(id));
  // #165: a sentinel that starts the turn at 0 owes its army: paid from the income before any other
  // deploy, holds included (the reserve holds back captures only). When income is scarce one army
  // may go to a border later conceded ahead of a high-value hold: a cheap price, said in the rationale. One the income (or its pool) cannot pay stays at
  // 0, and the rationale does not claim it keeps one army.
  for (const id of [...sentinel].sort(byNum)) {
    const owed = -avail.get(id)!;
    if (owed > 0) deploy(id, Math.min(owed, roomAt(id)));
  }
  const sentinelHeld = [...sentinel].filter((id) => avail.get(id)! >= 0).sort(byNum);
  const paid = sentinelHeld.filter((id) => armiesOf(id) === 0);
  if (sentinelHeld.length)
    rationale.push(
      `One Army Must Stand Guard is off: every army may move, but an empty territory falls to any single army, so ${sentinelHeld.map(label).join(', ')} ${sentinelHeld.length === 1 ? 'keeps' : 'each keep'} one army (next to an enemy)${paid.length ? `; ${paid.map(label).join(', ')} ${paid.length === 1 ? 'starts at 0, so its army is' : 'start at 0, so their armies are'} deployed first, before any hold (one army each, spent even where a border is later conceded)` : ''}.`,
    );
  if (local) {
    rationale.push(
      `Local Deployment: ${pools.anywhere} of the ${income} income may be deployed anywhere; each held bonus's armies stay inside it.`,
    );
    for (const p of pools.bonuses)
      rationale.push(
        `Local Deployment: bonus ${p.name} (#${p.bonusId})'s +${p.value} may only be deployed on its territories (${p.territoryIds.map(label).join(', ')}).`,
      );
    if (pools.trimmed)
      warnings.push(
        `Local Deployment: the income of ${income} is less than the held bonuses are worth; ${pools.trimmed} pooled armies were dropped from the plan's pools.`,
      );
  }

  // ---- protected value ----
  // Judged against my holdings at the start of the turn until the capture passes
  // have run; then against those holdings plus this turn's captures (R2).
  ps.holdings = mineSet;
  /** #122: bonus `ts` is being built — its missing members all visible neutrals, finishing it economic (rule 4). */
  const building = (ts: readonly number[], value: number): boolean => {
    let cost = 0;
    let worst = 0;
    for (const x of ts) {
      if (ps.holdings.has(x)) continue;
      const st = state.get(x);
      if (st?.owner.kind !== 'neutral' || st.armies === null) return false;
      const c = econCostAt(x);
      cost += c;
      worst = Math.max(worst, c);
    }
    return cost <= paybackTurns * value && worst <= WASTELAND_FACTOR * value;
  };
  /**
   * #235: what losing my `t` cuts off from the rest of my holdings (`ps.holdings` without `t`): when
   * its neighbours of mine fall into two or more parts, every part but the largest (most territories,
   * then most armies, then lowest id) is cut off — its territories, the armies on them (my start-of-turn
   * armies), and the income they make: the positive bonuses held in full inside them, plus their
   * per-territory income. `null` when nothing is cut off.
   */
  const cutOff = (t: number): Cut | null => {
    if (cutCache.has(t)) return cutCache.get(t)!;
    const has = (x: number) => x !== t && ps.holdings.has(x);
    const parts: number[][] = [];
    const seen = new Set<number>();
    for (const start of neighborsOf(g, t).filter(has).sort(byNum)) {
      if (seen.has(start)) continue;
      const part: number[] = [];
      const queue = [start];
      seen.add(start);
      while (queue.length) {
        const x = queue.shift()!;
        part.push(x);
        for (const n of neighborsOf(g, x))
          if (has(n) && !seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
      }
      parts.push(part.sort(byNum));
    }
    let cut: Cut | null = null;
    if (parts.length >= 2) {
      const armies = (part: readonly number[]) => part.reduce((n, x) => n + (mineSet.has(x) ? armiesOf(x) : 0), 0);
      const main = [...parts].sort((a, b) => b.length - a.length || armies(b) - armies(a) || a[0]! - b[0]!)[0]!;
      const ids = parts.filter((p) => p !== main).flat().sort(byNum);
      const off = new Set(ids);
      let inc = 0;
      for (const b of g.map.bonuses) {
        const ts = bonusTerritories(g, b.id);
        if (b.value > 0 && ts.length && ts.every((x) => off.has(x))) inc += b.value;
      }
      // On the holdings the cut is taken from (#235 review 2): my start-of-turn count until the
      // captures are known, then with this turn's captures, which the cut-off part may include.
      const per = s.bonusArmyPer ?? 0;
      const n = ps.holdings.size;
      if (per > 0) inc += territoryIncome(n, baseIncome, per) - territoryIncome(n - ids.length, baseIncome, per);
      cut = { ids, armies: armies(ids), income: inc };
    }
    cutCache.set(t, cut);
    return cut;
  };
  const cutCache = new Map<number, Cut | null>();
  /** #275: my `x` faces a visible enemy or the fog (a territory whose owner the board does not show). */
  const front = (x: number) =>
    neighborsOf(g, x).some((n) => {
      const o = state.get(n)?.owner;
      return o === undefined || o.kind === 'unknown' || (o.kind === 'player' && foe(o.playerId));
    });
  /**
   * #275 (pattern 2): with the guard off, what a breach of my border `t` opens — the territories
   * within two steps behind it that only it shields ({@link breachBehind}), what losing it cuts off
   * left out (#235 counts that whole), and the income they make: the bonuses held in full with a
   * member among them (not `t`'s own), plus their per-territory income. `null` with the guard on,
   * or when it opens nothing that earns.
   */
  const breachAt = (t: number): (Breach & { worth: number }) | null => {
    if (guard) return null;
    if (breachCache.has(t)) return breachCache.get(t)!;
    // The stack that would come through: the largest visible foe stack beside `t` with its owner's
    // deploy — the untrusted figure when larger (#275 b), as the hold at `t` is sized. A territory
    // behind is hollow when none of mine beside it (itself included, `t` left out) holds as many: a
    // stack that can answer the breach is no hollow interior.
    const through = Math.max(
      0,
      ...neighborsOf(g, t).map((n) => {
        const st = state.get(n);
        const o = st?.owner;
        if (o?.kind !== 'player' || !foe(o.playerId) || st!.armies === null) return 0;
        return st!.armies + unitsAt(n) + Math.max(deployOf(o.playerId), untrustedAt(o.playerId, t));
      }),
    );
    const hollow = (x: number) =>
      [x, ...neighborsOf(g, x)].every((y) => y === t || !mineSet.has(y) || armiesOf(y) + unitsAt(y) < through);
    const b = through > 0 ? breachBehind(g, ps.holdings, front, t, new Set(cutOff(t)?.ids ?? []), hollow) : { ids: [], bonuses: [], income: 0 };
    let income = b.income;
    const per = s.bonusArmyPer ?? 0;
    const n = ps.holdings.size;
    if (per > 0 && b.ids.length) income += territoryIncome(n, baseIncome, per) - territoryIncome(n - b.ids.length, baseIncome, per);
    const out = income > 0 ? { ...b, income, worth: Math.round(BREACH_WEIGHT * income * 10) / 10 } : null;
    breachCache.set(t, out);
    return out;
  };
  const breachCache = new Map<number, (Breach & { worth: number }) | null>();
  const protectedValue = (t: number): number => {
    // Each bonus is visited once, so it counts once however many of its borders are threatened.
    // #235: plus the income of what losing it cuts off from the rest of my holdings.
    // #275: plus, with the guard off, BREACH_WEIGHT × what a breach of it opens behind it.
    let v = (cutOff(t)?.income ?? 0) + (breachAt(t)?.worth ?? 0);
    const mineWithout = (x: number) => x !== t && ps.holdings.has(x);
    for (const b of g.map.bonuses) {
      const ts = bonusTerritories(g, b.id);
      if (!ts.includes(t)) continue;
      // #128: a negative bonus I hold in full that contains T is lifted when T falls.
      if (b.value < 0) {
        if (ts.every((x) => ps.holdings.has(x))) v += b.value;
        continue;
      }
      if (b.value === 0) continue;
      if (ts.every((x) => ps.holdings.has(x))) {
        v += b.value;
        continue;
      }
      // An incomplete bonus I am working on (T is in it): lost access if T is my only way in.
      const access = (has: (x: number) => boolean) =>
        ts.some((x) => has(x) || neighborsOf(g, x).some(has));
      if (!access(mineWithout)) {
        v += b.value;
        continue;
      }
      // #122: a member of a bonus I am building carries its share of the bonus — value × the
      // members I hold ÷ its size — so a second member is not worth +0 when the first (my only
      // foothold) was worth the whole bonus. Being built: every missing member is a visible
      // neutral, and finishing it passes rule 4's economy tests (a bonus behind an enemy, the
      // fog or a wasteland is not being built).
      if (building(ts, b.value)) {
        const held = ts.filter((x) => ps.holdings.has(x) || x === t).length;
        v += Math.round(((b.value * held) / ts.length) * 10) / 10;
      }
    }
    // Per-territory income replaces the base only when larger, so losing T
    // costs an army only above it.
    const per = s.bonusArmyPer ?? 0;
    if (per > 0) v += territoryIncome(mine.length, baseIncome, per) - territoryIncome(mine.length - 1, baseIncome, per);
    // Floored at 0 only (#128): a negative bonus can outweigh the rest, never below nothing.
    return Math.max(0, v);
  };
  /** #235: the armies a hold of my `t` also saves, as worth: those on what losing it cuts off. */
  const stakeAt = (t: number) => cutOff(t)?.armies ?? 0;
  const valueCache = new Map<number, number>();
  const valueOf = (t: number) => {
    if (!valueCache.has(t)) valueCache.set(t, protectedValue(t));
    return valueCache.get(t)!;
  };
  return {
    sentinel,
    secondLine,
    secondLineKept,
    guardAt,
    coverOf,
    heldNow,
    gainWith,
    orderOf,
    describeOrder,
    warnSplit,
    deploy,
    undeploy,
    pools,
    local,
    roomAt,
    spareAt,
    building,
    protectedValue,
    valueCache,
    valueOf,
    cutOff,
    cutCache,
    breachAt,
    breachCache,
    stakeAt,
  };
}
