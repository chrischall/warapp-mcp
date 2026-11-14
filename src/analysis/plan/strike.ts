// The strikes of a planning pass (#133): finishing off or pressuring an opponent (rule 1e, #45),
// striking an enemy commander (rule 1s, #61) and the borders those relieve, a guard-off break
// (#165), the 1v1 strike stack (rule 0p.3c, #72, #102, #120) and the FFA lead strikes (#167).
// planPass runs them where they ran before: the commander strikes and finishing off right after
// the capture passes are defined, the strike stack's choice before the leftover deploy and its
// attacks after it, the lead strikes after No-Split's whole-stack orders.
import { forecastBorder } from '../exchange.js';
import { COMMANDER_STRENGTH, straightKills } from '../combat.js';
import { neighborsOf } from '../graph.js';
import { guardOffExposure } from '../guard-off.js';
import {
  captureCost,
  CONCEDE_FACTOR,
  guaranteedFallsReaching,
  MIN_ENEMY_DEPLOY,
  SECOND_FRONT_LEAD,
  visibleState,
  type PlanInput,
  type PlannedMove,
} from './shared.js';
import type { Captures } from './captures.js';
import type { Holds } from './holds.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Breakable, Targets } from './targets.js';
import type { Threats } from './threats.js';
import { byNum, pct } from './util.js';


/** The strike stack rule 0p.3c built this turn (#72), and the leftover it got. */
export interface StrikeStack {
  id: number;
  player: number;
  income: number;
  source: string;
  deployed: number;
}

export type Strikes = ReturnType<typeof strikesPhase>;

/**
 * The strikes that run before triage, in the order planPass ran them: rule 1e's finishing off is
 * defined, the commander strikes (rule 1s) are made, then finishing off and pressure (rule 1e),
 * the strikes not made are warned about, the relieved borders re-judged and triaged, and the
 * guard-off breaks (#165) made.
 */
export function strikesPhase(pc: PlanCtx, ps: PlanState, book: DeployBook, threats: Threats, hd: Holds, tgt: Targets, cap: Captures) {
  const { finishOff } = finishOffHelper(pc, ps, book, threats, hd, tgt, cap);
  const { struck, unstruck } = commanderStrikes(pc, ps, book, threats, hd, tgt, cap);
  finishOffPass(pc, ps, book, threats, tgt, cap, finishOff, struck);
  relieveCaptured(pc, ps, threats, hd, unstruck);
  guardOffBreaks(pc, ps, book, hd, tgt);
  return { struck };
}

/** Rule 1e (#45): finishing off an opponent, defined before the commander strikes; run by finishOffPass. */
export function finishOffHelper(pc: PlanCtx, ps: PlanState, book: DeployBook, threats: Threats, hd: Holds, tgt: Targets, cap: Captures) {
  const {
    g, s, opts, income, foe, profile, marginFor, deployOf, paybackTurns, label, mine, mineSet, incomeGain, armiesOf,
    unitsAt, defenceAt, guard, bombOn, rates, noSplit, myCommanders,
  } = pc;
  const {
    warnings, rationale, deployed, avail, coverKeep, spared, captured, combined, moves, incoming, survivorsAt,
    captureOrder, staged,
  } = ps;
  const { guardAt, deploy, roomAt, valueOf } = book;
  const { ownedBy, ownerOf, fogAnywhere, deployReaching, holdArmies, bombSized, borderAt } = threats;
  const { stayAt } = hd;
  const { targets, frontierDelta } = tgt;
  const { notCompleted, worstCase, finishedOff, tryCapture } = cap;
  // ---- 1e. finish off an opponent (#45) ----
  // Before any border is conceded: for each visible opponent whose every territory is
  // visible (none borders the fog) and borders mine — any such opponent, however strong,
  // fewest territories first — search the attack sizes on its territories against its best
  // response (its deploy estimate is one budget, spread to save as many as it can; see
  // `guaranteedFalls`). Kept when every territory falls (elimination), or when the falls it
  // cannot prevent leave it one territory or take at least half, no attacking border faces
  // a territory left unattacked, and every hold worth paying for against those is funded.
  // The opponents in view (ownedBy, fogEdge, inReach, the weak ones) are read with the threats
  // (plan/threats.ts, visibleOpponents): the holds ask who took a border from a weak opponent.
  /** The most defenders `armies` attackers take for certain (`captureCost` at chance 1). */
  const takesUpTo = (armies: number) => {
    let y = 0;
    while ((captureCost(y + 1, s) ?? Infinity) <= armies) y++;
    return y;
  };
  /** Everything a finish-off attempt may change, to restore it. */
  const checkpoint = (ts: readonly number[]) => ({
    budget: ps.budget,
    deployed: new Map(deployed),
    avail: new Map(avail),
    incoming: new Map(incoming),
    captured: new Set(captured),
    combined: new Set(combined),
    survivorsAt: new Map(survivorsAt),
    worstCase: new Map(worstCase),
    targets: new Map(ts.map((t) => [t, targets.get(t)] as const)),
    notCompleted: new Map(notCompleted),
    staged: new Map(staged),
    captureOrder: captureOrder.length,
    moves: moves.length,
    rationale: rationale.length,
    warnings: warnings.length,
  });
  const restore = (c: ReturnType<typeof checkpoint>) => {
    ps.budget = c.budget;
    deployed.clear();
    for (const [k, v] of c.deployed) deployed.set(k, v);
    for (const [k, v] of c.avail) avail.set(k, v);
    incoming.clear();
    for (const [k, v] of c.incoming) incoming.set(k, v);
    captured.clear();
    for (const t of c.captured) captured.add(t);
    combined.clear();
    for (const t of c.combined) combined.add(t);
    survivorsAt.clear();
    for (const [k, v] of c.survivorsAt) survivorsAt.set(k, v);
    worstCase.clear();
    for (const [k, v] of c.worstCase) worstCase.set(k, v);
    for (const [t, tg] of c.targets) {
      if (tg) targets.set(t, tg);
      else targets.delete(t);
    }
    notCompleted.clear();
    for (const [k, v] of c.notCompleted) notCompleted.set(k, v);
    staged.clear();
    for (const [k, v] of c.staged) staged.set(k, v);
    captureOrder.length = c.captureOrder;
    moves.length = c.moves;
    rationale.length = c.rationale;
    warnings.length = c.warnings;
  };
  /** One sizing of the attacks: per target, the share of the deploy it is sized for, or SKIP. */
  const SKIP = -1;
  interface Attempt {
    sizes: number[];
    attacked: number[];
    /** Deploys player `p` must place on each attacked target to save it. */
    saveCost: number[];
    falls: number;
    all: boolean;
    armies: number;
    deploys: number;
    /** Success before the hold checks: eliminates, or leaves it one territory, or takes half. */
    enough: boolean;
    freed: boolean;
    unfunded: boolean;
    left: number[];
  }
  /**
   * Positive when `a` beats `b`: an elimination, then more sure falls, then fewer attacking
   * armies, then a dearer cheapest save (the opponent must commit more to save any one), then
   * fewer deploys. A tie keeps the first found (shares are tried from the full deploy down,
   * lowest territory id first), so the plan is deterministic.
   */
  const better = (a: Attempt, b: Attempt) =>
    Number(a.all) - Number(b.all) ||
    a.falls - b.falls ||
    b.armies - a.armies ||
    Math.min(...a.saveCost) - Math.min(...b.saveCost) ||
    b.deploys - a.deploys;
  /**
   * Plan the captures of player `p`'s territories against its best response. Committed
   * (true) when it eliminates `p`, or cuts it to one territory or takes at least half of it
   * with no attacking border facing what is left unattacked and every hold worth paying for
   * against that funded; otherwise rolled back. `probe`: always rolled back, true when an
   * elimination is affordable.
   */
  const finishOff = (p: number, probe: boolean, fogged: readonly number[] = []): boolean => {
    const ts = ownedBy.get(p)!;
    /** Next to the fog (#60): only taking every visible territory for sure counts, as pressure. */
    const pressure = fogged.length > 0;
    /** Its estimated deploy; under pressure, sized for with a margin over it (#60). */
    const estimateP = deployOf(p);
    const marginP = pressure ? marginFor(estimateP) : 0;
    const deployP = estimateP + marginP;
    const deployText = marginP ? `~${estimateP} deploy plus a margin of ${marginP}` : `~${deployP} deploy`;
    /**
     * #179: what it may deploy on `t` — under Local Deployment its bonus pools pay only into their
     * own territories (`deployReaching`), so a territory outside them faces less; else all of it.
     */
    const reachOn = new Map(ts.map((t) => [t, Math.min(deployP, deployReaching(p, [t]) + marginP)] as const));
    const reachText = (t: number) =>
      reachOn.get(t)! < deployP ? `the ~${reachOn.get(t)!} of its deploy that can reach it (Local Deployment)` : `its full ${deployText}`;
    const start = checkpoint(ts);
    if (ts.some((t) => captureCost(defenceAt(t), s) === null)) return false;
    /**
     * Reserve the holds for an attempt that leaves `stay` unattacked. Holds against other
     * players (and against `stay`) worth paying for (rule 1a's CONCEDE_FACTOR test) come
     * first. A source keeps what holds it there. On a border that attacks nothing, each such
     * hold — best worth per army first, and only if it fits what is left — is deployed there
     * while the captures are sized, so neither the captures nor a Local Deployment pool can
     * spend that room; one that does not fit is left to triage.
     */
    const reserve = (stay: ReadonlySet<number>, cover = false) => {
      const tried = ts.filter((t) => !stay.has(t));
      const sources = new Set(tried.flatMap((t) => neighborsOf(g, t).filter((n) => mineSet.has(n))));
      const keepAt = new Map<number, number>();
      const elsewhere: { x: number; cost: number; worth: number }[] = [];
      /** A hold's cost on my `x` against the threats left once `gone` fall, or null when not worth paying. */
      const holdCostAt = (x: number, gone: (n: number) => boolean) => {
        const rest = borderAt(x, gone);
        if (!rest) return null;
        // Armies that must stay: the hold less what my special units there fight as.
        const need = Math.max(0, holdArmies(rest.threat) - unitsAt(x));
        const cost = Math.max(0, need - armiesOf(x));
        const worth = valueOf(x) + armiesOf(x) / paybackTurns;
        // My commander's border is always worth holding (rule 1k).
        return cost > CONCEDE_FACTOR * worth && !myCommanders.has(x) ? null : { need, cost, worth };
      };
      for (const x of mine) {
        const h = holdCostAt(x, (n) => ownerOf(n) === p && !stay.has(n));
        if (!h) continue;
        const { need, cost, worth } = h;
        if (sources.has(x)) {
          // No-Split (#124): nothing is kept back, the whole stack moves; a source that must hold
          // against what is left issues no order instead (tryCapture asks `mustHold`).
          if (noSplit) continue;
          const keep = Math.max(0, need - guardAt(x));
          keepAt.set(x, keep);
          avail.set(x, avail.get(x)! - keep);
        } else if (cost > 0) elsewhere.push({ x, cost, worth });
      }
      /** The holds reserved, by border. */
      const funded = new Map<number, number>();
      elsewhere.sort((a, b) => b.worth / b.cost - a.worth / a.cost || a.cost - b.cost || a.x - b.x);
      for (const h of elsewhere) {
        if (h.cost > roomAt(h.x)) continue;
        deploy(h.x, h.cost);
        funded.set(h.x, h.cost);
      }
      // #179: cover its exits onto my land. Unless I move first, its stacks may attack before my
      // attacks land, so each of my territories next to it holds against its stacks there plus the
      // deploy that can reach them: a source keeps that (and what the attack would lose defending,
      // so the attack still goes out whole), a border that attacks nothing is deployed to. These
      // stay after the commit (the territory is locked), unlike the holds above.
      const covers = new Set<number>();
      /** What each covered territory keeps, in `avail` terms. */
      const coverAt = new Map<number, number>();
      let uncoverable = false;
      if (cover)
        for (const x of mine) {
          const adj = ts.filter((t) => neighborsOf(g, x).includes(t));
          if (!adj.length) continue;
          const threat = deployReaching(p, adj) + adj.reduce((n, t) => n + Math.max(0, armiesOf(t) - guard) + unitsAt(t), 0);
          // #163: held as if a Bomb halved it first, as every other hold is.
          const need = Math.max(0, holdArmies(bombSized(x, threat)) - unitsAt(x));
          covers.add(x);
          coverAt.set(x, Math.max(0, need - guardAt(x)));
          if (sources.has(x)) {
            if (noSplit) {
              uncoverable = true;
              break;
            }
            const keep = Math.max(need - guardAt(x), straightKills(threat, rates.offensiveKillRate));
            // It keeps the loss buffer too through the later passes, not only the hold.
            coverAt.set(x, keep);
            const extra = keep - (keepAt.get(x) ?? 0);
            if (extra > 0) {
              keepAt.set(x, keep);
              avail.set(x, avail.get(x)! - extra);
            }
          } else {
            const cost = Math.max(0, need - armiesOf(x)) - (funded.get(x) ?? 0);
            if (cost > roomAt(x)) {
              uncoverable = true;
              break;
            }
            if (cost > 0) {
              deploy(x, cost);
              funded.set(x, (funded.get(x) ?? 0) + cost);
            }
          }
        }
      const reserved = checkpoint(ts);
      const fullReason = (t: number) => `takes player ${p}'s territory, sized for ${reachText(t)} landing there`;
      /** Size and plan the attacks for `sizes` (from `reserved`), and judge the result. */
      const attempt = (sizes: number[]): Attempt => {
        tried.forEach((t, i) => {
          const e = sizes[i]!;
          if (e === SKIP) return;
          worstCase.set(t, defenceAt(t) + e);
          targets.set(t, {
            id: t,
            cost: captureCost(defenceAt(t) + e, s)!,
            enemy: true,
            sources: neighborsOf(g, t).filter((n) => mineSet.has(n)),
          });
        });
        const order = tried
          .map((t, i) => ({ t, e: sizes[i]! }))
          .filter((x) => x.e !== SKIP)
          .sort((a, b) => targets.get(a.t)!.cost - targets.get(b.t)!.cost || a.t - b.t);
        // No-Split (#124): a source must hold only against what stays; each target sized for the
        // full deploy is taken for sure, so it threatens nothing once attacked.
        const sure = new Set(order.filter((x) => x.e >= reachOn.get(x.t)!).map((x) => x.t));
        ps.assumeGone = (n) => sure.has(n);
        const attacked = order
          .filter(({ t, e }) =>
            tryCapture(
              t,
              e >= reachOn.get(t)! ? fullReason(t) : `presses player ${p}: sized for ${e} of its ~${reachOn.get(t)!} deploy landing there`,
            ),
          )
          .map((x) => x.t)
          .sort(byNum);
        ps.assumeGone = () => false;
        const ours = moves.slice(reserved.moves).filter((m) => m.kind === 'attack');
        // #179: a covered territory that attacks nothing gets the deploys its kept hold still lacks.
        let uncovered = false;
        for (const x of [...covers].sort(byNum)) {
          const short = -avail.get(x)!;
          if (short <= 0 || ours.some((m) => m.from === x)) continue;
          if (short > roomAt(x)) uncovered = true;
          else deploy(x, short);
        }
        const saveCost = attacked.map((t) => {
          const at = ours.filter((m) => m.to === t);
          const finisher = at[at.length - 1]!;
          const kills = at
            .slice(0, -1)
            .reduce((n, m) => n + straightKills(m.armies, rates.offensiveKillRate), 0);
          return Math.max(0, kills + takesUpTo(finisher.armies) - defenceAt(t) + 1);
        });
        const falls = guaranteedFallsReaching(
          saveCost,
          attacked.map((t) => reachOn.get(t)!),
          deployP,
        );
        const all = falls === ts.length;
        const left = ts.filter((t) => !attacked.includes(t));
        const attackers = new Set(ours.map((m) => m.from));
        const freed = [...attackers].every((x) => !neighborsOf(g, x).some((n) => left.includes(n)));
        // What stays unattacked: a border that attacks nothing but faces it must still have its
        // hold funded, or the captures cost a border worth holding.
        const unfunded = ours.length
          ? mine.some((x) => {
              if (attackers.has(x) || !neighborsOf(g, x).some((n) => left.includes(n))) return false;
              const h = holdCostAt(x, (n) => captured.has(n));
              return h !== null && h.cost > (funded.get(x) ?? 0);
            })
          : false;
        return {
          sizes,
          attacked,
          saveCost,
          falls,
          all,
          armies: ours.reduce((n, m) => n + m.armies, 0),
          deploys: reserved.budget - ps.budget,
          enough: falls > 0 && !uncovered && (all || ts.length - falls <= 1 || falls * 2 >= ts.length),
          freed,
          unfunded,
          left,
        };
      };
      // Every sizing, each target sized for 0..its full deploy share (or not attacked): exact
      // while there are few; otherwise evenly spaced shares, always including the full one.
      const LIMIT = 1024;
      let levels = deployP + 2;
      while (levels > 1 && levels ** tried.length > LIMIT) levels--;
      /** Each target's sizings: its reachable deploy (#179) evenly spaced down to 0, or not attacked. */
      const sharesOf = tried.map((t) => {
        const r = reachOn.get(t)!;
        const spaced = Array.from({ length: Math.max(1, levels - 1) }, (_, i) =>
          Math.round(r - (i * r) / Math.max(1, levels - 2)),
        );
        return levels >= 2 ? [...new Set(spaced), SKIP] : [r];
      });
      /** Every sizing tried; the state is left as reserved. */
      const search = () => {
        let best: Attempt | null = null;
        let bestUnfunded: Attempt | null = null;
        let canEliminate = false;
        if (uncoverable) return { best, bestUnfunded, canEliminate };
        const sizes = tried.map(() => 0);
        const visit = (i: number) => {
          if (i === tried.length) {
            const a = attempt([...sizes]);
            restore(reserved);
            if (a.all) canEliminate = true;
            if (!a.enough || !a.freed || (pressure && !a.all)) return;
            if (a.unfunded) {
              if (!bestUnfunded || better(a, bestUnfunded) > 0) bestUnfunded = a;
            } else if (!best || better(a, best) > 0) best = a;
            return;
          }
          for (const e of sharesOf[i]!) {
            sizes[i] = e;
            visit(i + 1);
          }
        };
        if (tried.length) visit(0);
        return { best: best as Attempt | null, bestUnfunded: bestUnfunded as Attempt | null, canEliminate };
      };
      /** Plan `chosen`, then release the reservations: the triage (or the greedy step) deploys the holds. */
      const commit = (chosen: Attempt) => {
        attempt(chosen.sizes);
        // #179: a covered exit keeps its hold: every later keep honours it.
        for (const [x, k] of coverAt) coverKeep.set(x, Math.max(coverKeep.get(x) ?? 0, k));
        for (const [x, k] of keepAt) avail.set(x, avail.get(x)! + k);
        for (const [x, k] of funded) {
          if (covers.has(x)) continue;
          const d = deployed.get(x)! - k;
          if (d) deployed.set(x, d);
          else deployed.delete(x);
          avail.set(x, avail.get(x)! - k);
          ps.budget += k;
        }
      };
      return { search, commit, covers };
    };
    const found = reserve(new Set()).search();
    restore(start);
    if (probe) return found.canEliminate;
    let chosen = found.best;
    let stay: ReadonlySet<number> = new Set();
    /** #179: the elimination covers its exits onto my land (not known to move first). */
    let cover = false;
    if (chosen?.all && !pressure && opts.movesFirst !== true) {
      const c = reserve(new Set(), true).search();
      restore(start);
      if (c.best?.all) {
        chosen = c.best;
        cover = true;
      }
    }
    // A better attempt that left a hold facing what it left unattacked unfunded: once more,
    // with those holds reserved first and those territories left alone.
    const retry = found.bestUnfunded;
    if (!cover && retry && (!chosen || better(retry, chosen) > 0)) {
      const again = reserve(new Set(retry.left)).search();
      restore(start);
      if (again.best && (!chosen || better(again.best, chosen) > 0)) {
        chosen = again.best;
        stay = new Set(retry.left);
      }
    }
    if (!chosen) return false;
    const coverBefore = new Map(coverKeep);
    const committed = reserve(stay, cover);
    committed.commit(chosen);
    // #179: in an FFA, price the elimination before it stands: the players its land would make me
    // border, and the frontier cost before and after (each border's hold need next turn, the
    // victim's threat gone). A buffer whose removal costs more than a turn of my income, and more
    // than the income its land adds pays back in PAYBACK_TURNS turns, is left standing.
    if (chosen.all && !pressure && profile.format === 'ffa' && profile.opponents >= 2) {
      const next = [...new Set(ts.flatMap((t) => neighborsOf(g, t)))].sort(byNum);
      const exposed = next.filter((n) => {
        const o = ownerOf(n);
        return o !== undefined && o !== p && foe(o) && !neighborsOf(g, n).some((x) => mineSet.has(x));
      });
      if (exposed.length) {
        const after = new Set([...mineSet, ...ts]);
        const delta = frontierDelta(mineSet, ts, (x) => (mineSet.has(x) ? stayAt(x) : (survivorsAt.get(x) ?? 0))).armies;
        const gain = Math.max(0, incomeGain(after));
        const limit = Math.max(paybackTurns * gain, income);
        const who = [...new Set(exposed.map((n) => ownerOf(n)!))].sort(byNum);
        const exposure = `taking ${ts.map(label).join(', ')} makes me border ${who
          .map((q) => `player ${q}'s ${exposed.filter((n) => ownerOf(n) === q).map(label).join(', ')}`)
          .join(' and ')}`;
        const shown = Math.round(delta);
        const cost = `the frontier's hold cost changes by ${shown >= 0 ? '+' : ''}${shown} armies (its own threat gone)`;
        if (delta > limit) {
          restore(start);
          coverKeep.clear();
          for (const [k, v] of coverBefore) coverKeep.set(k, v);
          for (const t of ts) spared.add(t);
          rationale.push(
            `Not finishing off player ${p} (#179): it is a buffer: ${exposure}, and ${cost}, more than a turn of my income (${income}) and more than the +${gain} its land adds pays back in ${paybackTurns} turns.`,
          );
          return false;
        }
        rationale.push(`Elimination price (#179): ${exposure}; ${cost}, within ${limit} (a turn of my income, or ${paybackTurns} turns of the +${gain} its land adds).`);
      }
    }
    const { attacked, falls, left } = chosen;
    const local = attacked.filter((t) => reachOn.get(t)! < deployP);
    /** How each attack is sized: for the full deploy, or (Local Deployment, #179) what can reach it. */
    const sizedFor = local.length ? `the part of its ${deployText} that can reach it (Local Deployment)` : `its full ${deployText}`;
    if (local.length)
      rationale.push(
        `Local Deployment (#179): player ${p}'s bonus pools pay only into their own territories, so ${local.map((t) => `${label(t)} can be reinforced with ~${reachOn.get(t)!}`).join(', ')} at most, and ${local.length === 1 ? 'its attack is' : 'their attacks are'} sized for that.`,
      );
    // The territories left unattacked stay ordinary (non-worst-case) targets.
    for (const t of left) {
      worstCase.delete(t);
      const tg = start.targets.get(t);
      if (tg) targets.set(t, tg);
      else targets.delete(t);
    }
    const names = attacked.map(label).join(', ');
    const rest = left.length
      ? `; ${left.map(label).join(', ')} stay${left.length === 1 ? 's' : ''} unattacked, and no attacking border faces ${left.length === 1 ? 'it' : 'them'}`
      : '';
    if (chosen.all && pressure) {
      const edge = fogged.map(label).join(', ');
      rationale.push(
        `Pressure player ${p}: take all ${ts.length} of its visible territories (${names}) this turn, each sized for ${sizedFor} landing there; it may hold more in the fog (next to ${edge}), so this is not an elimination.`,
      );
      warnings.push(
        `Pressuring player ${p} assumes it deploys at most ~${deployP} (its ~${estimateP} estimate ${marginP ? `plus a margin of ${marginP}` : 'with no margin: behind, attacks are sized at the minimum'}); more income than that (unseen bonuses, cards) could still save a territory.`,
        `player ${p} may hold more territories in the fog (next to ${edge}): taking its ${ts.length} visible territories is pressure, not an elimination.`,
      );
      return true;
    }
    if (chosen.all) {
      finishedOff.add(p);
      rationale.push(
        `Finish off player ${p}: attack all ${ts.length} of its territories (${names}) this turn, each sized for ${sizedFor} landing there, so it is eliminated ${fogAnywhere ? 'if it holds nothing in the fog, ' : ''}even if it reinforces; the borders facing it need no holding${cover ? ' once my attacks land' : ''}.`,
      );
      if (cover && committed.covers.size)
        rationale.push(
          `Cover player ${p}'s exits (#179): I am not known to move first, so its stacks may attack before my attacks land; ${[...committed.covers].sort(byNum).map(label).join(', ')} keep${committed.covers.size === 1 ? 's' : ''} what holds against its stacks next to ${committed.covers.size === 1 ? 'it' : 'them'} plus its deploy${bombOn ? ', as if halved by a Bomb first' : ''}, so it cannot break out onto my land.`,
        );
      warnings.push(
        `Eliminating player ${p} assumes it deploys at most ~${deployP} (its estimate); more income than that (unseen bonuses, cards) could still save one of its territories.`,
      );
      if (fogAnywhere)
        warnings.push(
          `player ${p} could still hold territories in the fog that border none of its visible ones: taking all ${ts.length} visible ones may not eliminate it.`,
        );
      return true;
    }
    const kept = ts.length - falls;
    const outcome = kept <= 1 ? 'cutting it to one territory' : `taking ${falls} of its ${ts.length}`;
    if (falls === attacked.length)
      rationale.push(
        `Pressure player ${p}: take ${falls} of its ${ts.length} territories (${names}) this turn, each sized for ${sizedFor} landing there, ${outcome}${rest}.`,
      );
    else {
      const saved = attacked.length - falls;
      rationale.push(
        `Pressure player ${p}: attack ${attacked.length === ts.length ? 'all' : attacked.length} ${attacked.length === ts.length ? `${ts.length} of its` : `of its ${ts.length}`} territories (${names}) this turn: its ~${deployP} deploy can save at most ${saved} of them, so at least ${falls} fall${falls === 1 ? 's' : ''}, ${outcome}${rest}.`,
      );
      warnings.push(
        `player ${p} chooses which of ${names} to save (up to ${saved}): what it deploys there survives my attack, next to the borders that attacked it.`,
      );
    }
    warnings.push(
      `Pressuring player ${p} assumes it deploys at most ~${deployP} (its estimate); more income than that (unseen bonuses, cards) could still save a territory.`,
    );
    return true;
  };
  return { finishOff };
}

/** Rule 1s (#61): strike each visible enemy commander next to me, before anything else spends the income. */
export function commanderStrikes(pc: PlanCtx, ps: PlanState, book: DeployBook, threats: Threats, hd: Holds, tgt: Targets, cap: Captures) {
  const {
    g, s, foe, profile, reserve, deployOf, territories: state, label, mineSet, armiesOf, unitsAt, uncounted, defenceAt,
    noSplit, myCommanders,
  } = pc;
  const { warnings, rationale, deployed, avail, captured } = ps;
  const { orderOf, describeOrder, local, roomAt, spareAt } = book;
  const { ownedBy, ownerOf, deployReaching, holdArmies, borderAt } = threats;
  const { stayAt, keepFor } = hd;
  const { targets } = tgt;
  const { mustHold, strikes, worstCase, tryCapture } = cap;
  // ---- 1s. strike an enemy commander (#61) ----
  // Killing a player's commander eliminates it, so a visible enemy commander next to a
  // territory I held at the start of the turn is attacked before anything else spends the
  // income (finishing off, pressure, holds, expansion), under every goal, sized for its
  // armies, the commander's COMMANDER_STRENGTH and its owner's full deploy estimate landing
  // there. Nothing is conceded yet, so a thin border next to it may strike. The owner's other
  // stacks still threaten this turn (attacks interleave). My commander's hold is reserved
  // first; each source keeps what holds it (`keepFor`; nothing when it cannot hold anyway,
  // unless it is my commander's).
  /** Players whose commander is struck this turn: finishing them off is moot. */
  const struck = new Set<number>();
  /** Strikes not made, warned about only when nothing else (finishing off) takes the territory. */
  const unstruck: { t: number; text: string }[] = [];
  for (const t of [...state.keys()].sort(byNum)) {
    const st = state.get(t)!;
    if (mineSet.has(t) || captured.has(t) || st.armies === null || st.owner.kind !== 'player' || !foe(st.owner.playerId) || uncounted(t)) continue;
    // B2 (T1): never a truce's covered territory.
    if (pc.truce.noTarget(t)) continue;
    if (!(st.specialUnits ?? []).some((u) => u.kind === 'commander' && foe(u.playerId))) continue;
    const adjacent = neighborsOf(g, t).filter((n) => mineSet.has(n));
    if (!adjacent.length) continue;
    const p = st.owner.playerId;
    // #179: under Local Deployment only what can reach the commander's territory (its pools pay elsewhere).
    const deployP = deployReaching(p, [t]);
    const pooled = deployP < deployOf(p);
    const defenders = defenceAt(t) + deployP;
    const cost = captureCost(defenders, s);
    const at = `Player ${p}'s commander on ${label(t)}`;
    const sizing = `its ${armiesOf(t)} armies + the commander's ${COMMANDER_STRENGTH} + ${pooled ? `the ~${deployP} deploy that can reach it (Local Deployment)` : `its owner's full ~${deployP} deploy`}`;
    if (cost === null) continue;
    // Only the struck territory stops threatening (once taken). war.app interleaves both
    // players' attacks, so the owner's other stacks still attack this turn: elimination
    // changes next turn's picture, not this one's.
    const gone = (x: number) => x === t;
    // My commander's must-hold reserve is funded first (rule 1k): what its territory needs
    // against every threat but the struck one; when that does not fit, all that may be
    // deployed there (rule 1k deploys it all there anyway). It is held as a deploy on my
    // commander's territory while the strike is tried, so under Local Deployment it is charged
    // to the pools that can reach it (`roomAt`/`spareAt` see it), not just taken off the budget.
    const held = new Map<number, number>();
    const hold = (on: boolean) => {
      for (const [c, n] of held) {
        const d = (deployed.get(c) ?? 0) + (on ? n : -n);
        if (d > 0) deployed.set(c, d);
        else deployed.delete(c);
        ps.budget += on ? -n : n;
      }
    };
    for (const c of [...myCommanders].sort(byNum)) {
      const b = borderAt(c, (x) => captured.has(x) || gone(x));
      const n = b ? Math.min(roomAt(c), Math.max(0, holdArmies(b.threat) - unitsAt(c) - stayAt(c))) : 0;
      if (n <= 0) continue;
      held.set(c, n);
      deployed.set(c, (deployed.get(c) ?? 0) + n);
      ps.budget -= n;
    }
    hold(false);
    const reserved = [...held.values()].reduce((a, n) => a + n, 0);
    // A source that issues no order yet (No-Split: it may already strike another commander)
    // may strike. Strikes run before triage and every other pass, so no source is conceded or
    // locked yet: those cannot hold a strike back.
    const blocked = (x: number) => orderOf(x) !== undefined;
    const order = adjacent
      .filter((x) => !blocked(x))
      .map((x) => ({ x, keep: keepFor(x, gone, ps.budget - reserved - reserve) }))
      .sort((a, b) => avail.get(b.x)! - b.keep - (avail.get(a.x)! - a.keep) || a.x - b.x);
    const prev = targets.get(t);
    targets.set(t, { id: t, cost, enemy: true, sources: adjacent });
    worstCase.set(t, defenders);
    strikes.add(t);
    const reason = `kills player ${p}'s commander, which eliminates it (sized for ${sizing})`;
    // Every source's most, with no keep and no reserve: what the strike could ever be sent.
    const most = new Map(order.map(({ x }) => [x, Math.max(0, avail.get(x)!) + Math.max(0, spareAt(x))]));
    hold(true);
    const done = order.some(({ x, keep }) => tryCapture(t, reason, { from: x, keep }));
    /** What may still be deployed on each source with the reserve held back (pools included). */
    const roomLeft = new Map(order.map(({ x }) => [x, Math.max(0, spareAt(x))]));
    hold(false);
    if (done) {
      struck.add(p);
      // #179: a commander kill turns its owner's land neutral where it stands: nothing comes to
      // me directly, and whoever borders it collects. Priced in an FFA, never gated.
      if (profile.format === 'ffa' && profile.opponents >= 2) {
        const land = (ownedBy.get(p) ?? []).filter((x) => x !== t);
        const by = new Map<number, number[]>();
        for (const x of land)
          for (const n of neighborsOf(g, x)) {
            const o = ownerOf(n);
            if (o === undefined || o === p || !foe(o)) continue;
            if (!(by.get(o) ?? []).includes(x)) by.set(o, [...(by.get(o) ?? []), x]);
          }
        const collectors = [...by].sort((a, b) => a[0] - b[0]).map(([q, xs]) => `player ${q} borders ${[...xs].sort(byNum).map(label).join(', ')}`);
        if (land.length)
          rationale.push(
            `Commander kill (#179): player ${p}'s land turns neutral where it stands; ${collectors.length ? collectors.join(', ') : 'no other player in view borders it'}, so ${collectors.length ? 'they may collect it' : 'it is mine to take'} (struck all the same: it removes a player).`,
          );
      }
      warnings.push(
        `Killing player ${p}'s commander on ${label(t)} assumes it deploys at most ~${deployP} (its estimate); more than that (unseen bonuses, cards) could save it.`,
      );
      continue;
    }
    strikes.delete(t);
    worstCase.delete(t);
    if (prev) targets.set(t, prev);
    else targets.delete(t);
    // Say what actually held it back, so a manual strike can be judged; said only if finishing
    // off does not take it. A keep is named only for a source that could send enough without
    // it and the reserve; the reserve only when it binds (a source could send enough, keep
    // kept, but for it, or dropping that keep alone would not do). With no source able to
    // send enough at all, the strike is unaffordable.
    const could = order.filter(({ x }) => most.get(x)! >= cost);
    /** What `x` could send with no keep but the reserve held back (a guard owed is paid first). */
    const unkept = (x: number) => Math.max(0, avail.get(x)! + roomLeft.get(x)!);
    const limits = [
      ...adjacent.filter(blocked).map((x) => `No-Split: ${label(x)} already ${describeOrder(orderOf(x)!)}`),
      // The reserve only where it binds: a source could send enough, keep kept, but for it; or
      // dropping the keep alone would not do either (both stand in the way).
      ...(reserved && could.some(({ x, keep }) => most.get(x)! - keep >= cost || unkept(x) < cost)
        ? [`${reserved} of the income is held back for my commander's territory`]
        : []),
      ...could
        .filter(({ keep }) => !noSplit && keep > 0)
        .map(({ x, keep }) => `${label(x)} keeps ${keep} to hold ${myCommanders.has(x) ? 'my commander' : 'its other borders'}`),
      // No-Split (#124): the whole stack would go, so a source that must hold sends nothing.
      ...could.flatMap(({ x }) => {
        const h = mustHold(x, t, most.get(x)!);
        return h ? [`No-Split: ${label(x)} must hold its border and would send its whole stack`] : [];
      }),
      ...(order.length && !could.length
        ? [`unaffordable: at most ${Math.max(...most.values())} attackers from any one territory (every movable army and every deploy)`]
        : []),
    ];
    // Nothing above binds, yet no source could: name what each could actually send (under
    // Local Deployment, its pool room is what stops it).
    if (!limits.length)
      for (const { x } of could)
        limits.push(
          `${label(x)} can send at most ${unkept(x)}${local ? ` (Local Deployment: only ${roomLeft.get(x)} may be deployed there)` : ''}`,
        );
    unstruck.push({
      t,
      text: `${at} is in reach, but killing it needs ${cost} attackers (${sizing}), more than my territories next to it can send this turn${limits.length ? ` (${limits.join('; ')})` : ''}: not attacked.`,
    });
  }
  return { struck, unstruck };
}

/** Rule 1e (#45, #60, #201): finish off or pressure each opponent in reach, fewest territories first. */
export function finishOffPass(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  tgt: Targets,
  cap: Captures,
  finishOff: (p: number, probe: boolean, fogged?: readonly number[]) => boolean,
  struck: ReadonlySet<number>,
) {
  const {
    g, me, s, income, profile, auto, pressureFactor, marginFor, guarded, deployOf, label, mineSet, armiesOf, uncounted,
    noSplit,
  } = pc;
  const { warnings, rationale, locked, spared, unabsorbed, absorbLines } = ps;
  const { orderOf } = book;
  const { ownedBy, fogEdge, inReach } = threats;
  const { movableFor } = cap;
  const { targets } = tgt;
  if (guarded) {
    const candidates = [...ownedBy.keys()]
      .filter((p) => inReach(p) && !struck.has(p) && !ownedBy.get(p)!.some(uncounted))
      .sort(
        (a, b) =>
          ownedBy.get(a)!.length - ownedBy.get(b)!.length ||
          ownedBy.get(a)!.reduce((n, t) => n + armiesOf(t), 0) - ownedBy.get(b)!.reduce((n, t) => n + armiesOf(t), 0) ||
          a - b,
      );
    // A typical expansion capture: the median cost of the visible neutrals next to me.
    const neutralCosts = [...targets.values()].filter((tg) => !tg.enemy).map((tg) => tg.cost).sort(byNum);
    const expansionCost = neutralCosts.length ? neutralCosts[(neutralCosts.length - 1) >> 1]! : null;
    /**
     * Each of `p`'s visible territories, sized for its full deploy plus the pressure margin,
     * costs at most PRESSURE_FACTOR typical expansions (AHEAD_PRESSURE_FACTOR ahead in a 1v1 under
     * the profile, rule 0p.3; with no visible neutral next to me,
     * nothing to compare with: no limit). All or nothing.
     */
    /**
     * #201 (adapting, an FFA with two or more opponents, a leader on strength that is not me):
     * finishing off or pressing a player smaller than me, not the leader, absorbs its income — worth
     * it only when its income added to mine matches the leader's; else the armies are better spent
     * with the others against the leader. A rationale line says which.
     */
    const absorbs = (p: number): boolean => {
      const r = profile.ranking;
      if (!auto || profile.format !== 'ffa' || profile.opponents < 2 || !r || r.commonThreat === null || p === r.commonThreat) return true;
      const row = (q: number) => r.players.find((x) => x.playerId === q);
      const mineRow = row(me);
      const theirs = row(p);
      const lead = row(r.commonThreat);
      if (!mineRow || !theirs || !lead || theirs.strength >= mineRow.strength) return true;
      const with_ = income + theirs.income;
      if (with_ >= lead.income) {
        // Said once, and kept only when an attack on player `p` is made (checked once the orders are final).
        if (!absorbLines.has(p)) {
          const line = `Absorb player ${p} (#201): its ~${theirs.income} income brings mine from ${income} to ${with_}, matching leader player ${lead.playerId}'s ~${lead.income}.`;
          absorbLines.set(p, line);
          rationale.push(line);
        }
        return true;
      }
      unabsorbed.add(p);
      for (const t of ownedBy.get(p) ?? []) spared.add(t);
      rationale.push(
        `Not finishing off player ${p} (#201): player ${lead.playerId} leads the free-for-all on ~${lead.income} income; absorbing player ${p}'s ~${theirs.income} brings mine from ${income} to ${with_}, short of it — the others are better spent against the leader.`,
      );
      return false;
    };
    const pressureAffordable = (p: number): { t: number; from: number; cost: number }[] | null => {
      const d = deployOf(p);
      if (expansionCost === null) return [];
      // #120: a capture over the limit displaces no expansion when the armies already on one source
      // beyond what holds it pay for all of it (no deploys): it is waived, each source paying once
      // (never under No-Split, where it takes that source's one order).
      const idle = new Map<number, number>();
      const waived: { t: number; from: number; cost: number }[] = [];
      for (const t of [...ownedBy.get(p)!].sort(byNum)) {
        const cost = captureCost(armiesOf(t) + d + marginFor(d), s) ?? Infinity;
        if (cost <= pressureFactor * expansionCost) continue;
        // Under No-Split the source's one order is what the capture displaces: no waiver.
        if (noSplit) return null;
        const from = neighborsOf(g, t)
          .filter((x) => mineSet.has(x) && !locked.has(x) && !orderOf(x))
          .map((x) => ({ x, left: idle.get(x) ?? Math.max(0, movableFor(x, t)) }))
          .filter(({ left }) => left >= cost)
          .sort((a, b) => b.left - a.left || a.x - b.x)[0];
        if (!from) return null;
        idle.set(from.x, from.left - cost);
        waived.push({ t, from: from.x, cost });
      }
      return waived;
    };
    // #201: a smaller player holding a unit the board gives no strength for cannot be finished off
    // (no finishing-off candidate), but absorbing it is judged the same way: its counted territories are
    // spared when that would not catch the leader.
    for (const p of [...ownedBy.keys()].sort(byNum))
      if (inReach(p) && !struck.has(p) && ownedBy.get(p)!.some(uncounted)) absorbs(p);
    for (const p of candidates) {
      if (!absorbs(p)) continue;
      const edge = fogEdge(p);
      if (edge.length) {
        // Fog is a reason not to claim elimination, not to skip a cheap capture (#60).
        const waived = pressureAffordable(p);
        if (waived && finishOff(p, false, edge)) {
          if (waived.length)
            rationale.push(
              `Pressure on player ${p} is not priced against expansion (${pressureFactor}× a typical neutral capture, ${pressureFactor * expansionCost!}): ${waived
                .map((w) => `${label(w.t)} (${w.cost}) is paid from idle armies on ${label(w.from)}`)
                .join(', ')}, so it displaces no expansion.`,
            );
          continue;
        }
        if (finishOff(p, true))
          warnings.push(
            `player ${p} may hold more territories in the fog (next to ${edge.map(label).join(', ')}): finishing it off is not attempted, though its ${ownedBy.get(p)!.length} visible territories could all be taken this turn.`,
          );
        continue;
      }
      finishOff(p, false);
    }
  }
}

/** The strikes not made, the borders the strikes and finishing off relieve, and triage on what is left. */
export function relieveCaptured(pc: PlanCtx, ps: PlanState, threats: Threats, hd: Holds, unstruck: readonly { t: number; text: string }[]) {
  const { g, label, myCommanders } = pc;
  const { warnings, rationale, captured } = ps;
  const { borders, borderAt } = threats;
  const { assessThreats, triage } = hd;
  for (const { t, text } of unstruck) if (!captured.has(t)) warnings.push(text);
  // The borders those captures (a strike, finishing off) relieve: re-judged without the
  // territories taken. A struck player's other stacks still threaten: attacks interleave, so
  // its elimination changes next turn, not this one.
  const fallen = (n: number) => captured.has(n);
  if (captured.size)
    for (const id of [...borders.keys()]) {
      if (!neighborsOf(g, id).some(fallen)) continue;
      const b = borderAt(id, fallen);
      if (b) borders.set(id, b);
      else borders.delete(id);
    }
  assessThreats();
  triage();

  if (myCommanders.size)
    rationale.push(
      `My commander stays on ${[...myCommanders].map(label).join(', ')}: planned moves carry armies only, never the commander.`,
    );
}

/** #165: with the guard off, one army breaks a bonus on an empty enemy territory next to mine. */
export function guardOffBreaks(pc: PlanCtx, ps: PlanState, book: DeployBook, hd: Holds, tgt: Targets) {
  const { g, board, me, allies, reserve, label, bonusName, mineSet, unitsAt, uncounted, guard, chanceOf, noSplit } = pc;
  const { rationale, avail, spared, captured, moves, survivorsAt, captureOrder, captureUndo } = ps;
  const { coverOf, gainWith, deploy, roomAt } = book;
  const { conceded, keepFor, twoStepKeep } = hd;
  const { targets } = tgt;
  // ---- #165: guard off — an empty enemy territory that breaks a bonus ----
  // With One Army Must Stand Guard off, an enemy territory next to mine standing at 0 armies (no
  // special unit) falls to one army; when its owner holds a positive bonus it is in, that one army
  // breaks the bonus. Every goal, after the holds and before any other capture: one army from the
  // neighbour with the most to spare beyond what holds it once the target falls (a conceded border's
  // armies are lost anyway), else one deployed on a neighbour that is not conceded. Never one that
  // lowers income, nor under No-Split (an order sends the whole stack). It is sized for the board as
  // it stands: if the owner deploys there first, the one army is lost.
  if (!guard && !noSplit) {
    const empties = guardOffExposure({ graph: g, board, me, friends: allies, deploys: [], moves: [] }).breaks;
    for (const e of empties) {
      const n = e.territoryId;
      if (captured.has(n) || spared.has(n) || uncounted(n) || unitsAt(n) > 0 || gainWith([n]) < 0) continue;
      // B2 (T1): never a truce's covered territory.
      if (pc.truce.noTarget(n)) continue;
      const near = neighborsOf(g, n).filter((x) => mineSet.has(x));
      const spareOf = (x: number) =>
        Math.max(0, avail.get(x)! - Math.max(keepFor(x, (y) => y === n), twoStepKeep(x, (y) => y === n), coverOf(x)));
      let src = near.map((x) => ({ x, spare: spareOf(x) })).filter((o) => o.spare >= 1).sort((a, b) => b.spare - a.spare || a.x - b.x)[0]?.x;
      let bought = 0;
      if (src === undefined && ps.budget - reserve >= 1) {
        src = near.filter((x) => !conceded.has(x) && avail.get(x)! >= 0 && roomAt(x) >= 1).sort((a, b) => avail.get(b)! - avail.get(a)! || a - b)[0];
        if (src !== undefined) {
          deploy(src, 1);
          bought = 1;
        }
      }
      if (src === undefined) continue;
      const from = src;
      avail.set(from, avail.get(from)! - 1);
      captured.add(n);
      survivorsAt.set(n, 1);
      captureOrder.push(n);
      captureUndo.set(n, () => avail.set(from, avail.get(from)! + 1));
      if (!targets.has(n)) targets.set(n, { id: n, cost: 1, enemy: true, sources: near });
      const reason = `One Army Must Stand Guard is off and ${label(n)} stands at 0: an attack breaks player ${e.playerId}'s bonus ${bonusName(e.bonusId)} (+${e.value}) unless it deploys there first`;
      moves.push({ from, to: n, armies: 1, kind: 'attack', reason, winChance: chanceOf(1, 0) });
      rationale.push(`Attack ${label(n)} from ${label(from)} with 1${bought ? ' (deploy 1 there)' : ''}: ${reason}.`);
    }
  }
}

/** Rule 0p.3c (#72, #120, #201): the 1v1 strike stack's border, chosen before the leftover deploy. */
export function chooseStrikeStack(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  open: (id: number) => boolean,
  stays: (id: number) => number,
) {
  const {
    g, income, profile, auto, goal, estimates, deployOf, incomeOfPlayer, paybackTurns, territories: state, label, mine,
    armiesOf, unitsAt, defenceAt, completedBy, inFocus, guard, rates, costAt, noSplit,
  } = pc;
  const { rationale, captured, combined, staged } = ps;
  const { guardAt, heldNow, gainWith, orderOf, roomAt } = book;
  const { reinforcementAt, holdArmies, threatAt, facing } = threats;
  // Concentrate (#72, adapting in a 1v1 facing the opponent): the spare deploys go to one strike stack
  // on the border facing the strongest opponent (the highest income estimate, tracked when its
  // track is trusted), the stack that keeps the most there, rather than to comfort margins.
  // A 1v1 rule: in an FFA or a team game the comfort margins keep the leftover (several fronts).
  // Chosen even when holds and captures leave no leftover (#102): the stack is still spent.
  let stack: { id: number; player: number; income: number; source: string } | undefined;
  /**
   * No-Split (#124): `x`'s one order when it is a small expansion a strike may take over — a single
   * attack on a neutral that completes no bonus this turn, stages none and is not focused.
   */
  const smallExpansion = (x: number): PlannedMove | undefined => {
    const m = orderOf(x);
    if (!m || m.kind !== 'attack' || !captured.has(m.to) || combined.has(m.to)) return undefined;
    if (state.get(m.to)?.owner.kind !== 'neutral' || staged.has(m.to) || inFocus(m.to)) return undefined;
    const now = heldNow();
    const before = completedBy(new Set([...now].filter((y) => y !== m.to)));
    return completedBy(now).some((id) => !before.includes(id)) ? undefined : m;
  };
  /** The stack on `x` a strike could send: what stays, plus a small expansion's armies (No-Split). */
  const stackAt = (x: number) => stays(x) + (smallExpansion(x)?.armies ?? 0);
  if (auto && profile.format === '1v1' && goal !== 'defend' && facing.size) {
    const player = [...facing]
      .map((p) => ({ p, e: estimates.get(p) }))
      .sort((a, b) => (b.e?.estimate ?? 0) - (a.e?.estimate ?? 0) || a.p - b.p)[0]!;
    /** The opponent's territories next to `x` a strike could aim at. */
    const aims = (x: number) =>
      neighborsOf(g, x).filter((n) => {
        const st = state.get(n);
        return !captured.has(n) && st?.owner.kind === 'player' && st.owner.playerId === player.p && st.armies !== null;
      });
    const fronts = mine
      .filter(
        (x) =>
          open(x) &&
          // No-Split: a territory whose one order is not a small expansion has nothing left to strike with.
          (!orderOf(x) || smallExpansion(x) !== undefined) &&
          aims(x).length > 0,
      )
      .sort((a, b) => stackAt(b) - stackAt(a) || a - b);
    /**
     * #120: the best strike `x` could make this turn with every leftover army on it — an adjacent
     * target sized for its defenders plus what its owner may deploy there first (rule 3) — and the
     * armies it would have to spare, after what holds `x` once that target falls. `null` when none
     * fits.
     */
    const bestStrike = (x: number) => {
      const room = Math.max(0, Math.min(ps.budget, roomAt(x)));
      let best: { n: number; cost: number; extra: number; spare: number; can: number } | null = null;
      for (const n of aims(x)) {
        const extra = reinforcementAt(n);
        const cost = costAt(n, defenceAt(n) + extra);
        if (cost === null || gainWith([n]) < 0) continue;
        const threat = Math.max(threatAt(x, (y) => captured.has(y) || y === n)?.threat ?? 0, deployOf(player.p));
        const hold = Math.max(0, holdArmies(threat) - unitsAt(x));
        const can = stackAt(x) + room - guardAt(x);
        const spare = Math.min(can - cost, stackAt(x) + room - cost - hold);
        if (spare < 0) continue;
        if (!best || spare > best.spare || (spare === best.spare && n < best.n)) best = { n, cost, extra, spare, can };
      }
      return best;
    };
    // Rule 0p.3c (#120): the stack goes where it can strike — the border with the most to spare
    // after its best strike — and only with no border able to strike, to the one holding the most
    // armies (live, 180 armies fed the front facing the opponent's biggest stack while a strike on
    // a 1-army territory elsewhere was affordable every turn).
    const able = noSplit ? [] : fronts.flatMap((x) => {
      const b = bestStrike(x);
      return b ? [{ x, ...b }] : [];
    });
    able.sort((a, b) => b.spare - a.spare || stackAt(b.x) - stackAt(a.x) || a.x - b.x);
    const pick = able[0];
    // #201: with no border able to strike this turn, the multi-turn forecast (`forecastBorder`):
    // the border whose stack, with the leftover and then the income every turn, breaks the
    // opponent's biggest stack beside it soonest (its owner deploying there every turn too); ties,
    // and none breaking within the horizon, keep the border holding the most armies.
    const forecastPick = (() => {
      if (pick || noSplit || fronts.length < 2) return undefined;
      const rows = fronts.flatMap((x) => {
        const at = aims(x).sort((a, b) => armiesOf(b) + unitsAt(b) - (armiesOf(a) + unitsAt(a)) || a - b)[0]!;
        const theirs = armiesOf(at) + unitsAt(at);
        const f = forecastBorder({
          mine: stackAt(x) + Math.max(0, Math.min(ps.budget, roomAt(x))),
          theirs,
          myIncome: income,
          theirIncome: incomeOfPlayer(player.p),
          turns: paybackTurns,
          settings: { offensiveKillRate: rates.offensiveKillRate, defensiveKillRate: rates.defensiveKillRate, oneArmyStandsGuard: guard === 1 },
        });
        return f.outcome === 'breaks' && f.turn !== null ? [{ x, at, theirs, turn: f.turn }] : [];
      });
      rows.sort((a, b) => a.turn - b.turn || stackAt(b.x) - stackAt(a.x) || a.x - b.x);
      const best = rows[0];
      if (!best) return undefined;
      const most = fronts[0]!;
      const other = rows.find((r) => r.x === most);
      if (best.x === most || (other && other.turn === best.turn)) return undefined;
      rationale.push(
        `Strike stack on ${label(best.x)} (#201): no border can strike this turn; pressing every turn with the income, ${label(best.x)} breaks player ${player.p}'s ${best.theirs} on ${label(best.at)} on turn ${best.turn} (the multi-turn forecast), sooner than ${label(most)}, which holds more armies but ${other ? `breaks its front only on turn ${other.turn}` : `breaks nothing within ${paybackTurns} turns`}.`,
      );
      return best.x;
    })();
    const id = pick?.x ?? forecastPick ?? fronts[0];
    if (pick) {
      const most = fronts[0]!;
      rationale.push(
        `Strike stack on ${label(pick.x)}: ${label(pick.x)} can take ${label(pick.n)} this turn (${pick.cost} of the ${pick.can} it could send with the leftover, sized for its ${defenceAt(pick.n)} defenders plus the ~${pick.extra} player ${player.p} may deploy there first; ${pick.spare} to spare once it holds)${
          most !== pick.x
            ? `, rather than ${label(most)}, which holds more armies but ${able.some((a) => a.x === most) ? `has less to spare after its best strike` : 'can take nothing next to it so sized'}`
            : ''
        }.`,
      );
    }
    if (id !== undefined)
      stack = {
        id,
        player: player.p,
        income: player.e?.estimate ?? MIN_ENEMY_DEPLOY,
        source: player.e?.source === 'tracked' ? 'tracked' : player.e?.source === 'observed' ? 'observed' : 'estimated',
      };
  }
  return { stack, smallExpansion };
}

/** #102: spend the strike stack on the enemy territories next to it, once the leftover deploy is in. */
export function spendStrikeStack(
  pc: PlanCtx,
  ps: PlanState,
  input: PlanInput,
  book: DeployBook,
  threats: Threats,
  tgt: Targets,
  cap: Captures,
  strikeStack: StrikeStack | undefined,
  poolDeployed: ReadonlyMap<number, number>,
  holdLocked: Set<number>,
  smallExpansion: (x: number) => PlannedMove | undefined,
) {
  const {
    g, me, foe, deployOf, territories: state, label, bonusName, mineSet, unitsAt, uncounted, defenceAt, bonusTs,
    completedBy, rates, chanceOf, costAt, noSplit, myCommanders,
  } = pc;
  const {
    warnings, rationale, avail, locked, captured, combined, moves, incoming, survivorsAt, captureOrder, captureUndo,
  } = ps;
  const { guardAt, coverOf, heldNow, gainWith, orderOf, valueOf } = book;
  const { reinforcementAt, holdArmies, threatAt } = threats;
  const { breakable, offence, skipOffence } = tgt;
  const { mustHold, strikes, worstCase } = cap;
  // ---- spend the strike stack (#102) ----
  // Once rule 0p.3c builds a strike stack, it attacks every adjacent enemy territory it can take
  // at the plan's win chance (the ordinary capture sizing; rule 4c re-checked as its captures
  // accumulate), breaking or retaking a bonus first (re-ranked after each capture: a bonus breaks
  // once), then by bonus value, then cheapest, then id — while what stays on it holds against the threat
  // left after those attacks (rule 1's arithmetic: the captured territories no longer threaten
  // it). It grows (deploy, no attack) only when nothing in reach is worth taking.
  if (strikeStack) {
    const S = strikeStack.id;
    if (strikeStack.deployed === 0)
      rationale.push(
        `No leftover reaches the strike stack ${label(S)} this turn (holds, captures or Local Deployment pools took the income): it is spent with the armies already on it.`,
      );
    const prev = new Map((input.previousBoard?.territories ?? []).map((t) => [t.territoryId, t]));
    /** Bonuses I held in full on the previous board and no longer do: lost, and retakable. */
    const lost = new Set(
      g.map.bonuses
        .filter((b) => {
          const ts = bonusTs.get(b.id) ?? [];
          if (b.value <= 0 || !ts.length || ts.every((t) => mineSet.has(t))) return false;
          return ts.every((t) => {
            const was = visibleState(prev.get(t));
            return was?.owner.kind === 'player' && was.owner.playerId === me;
          });
        })
        .map((b) => b.id),
    );
    interface StrikeTarget {
      id: number;
      cost: number;
      chance: number;
      breaks: Breakable[];
      retakes: number[];
    }
    const candidates: StrikeTarget[] = [];
    for (const n of neighborsOf(g, S)) {
      const st = state.get(n);
      if (captured.has(n) || st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null || uncounted(n)) continue;
      // B2 (T1): never a truce's covered territory.
      if (pc.truce.noTarget(n)) continue;
      const cost = costAt(n);
      // Never a capture that lowers income (rule 4c): it completes a negative bonus. Re-checked
      // below against the strike's own captures, which can complete one only together.
      if (cost === null || gainWith([n]) < 0) continue;
      const owner = st.owner.playerId;
      candidates.push({
        id: n,
        cost,
        chance: chanceOf(cost, defenceAt(n)),
        breaks: breakable.filter((b) => b.player === owner && bonusTs.get(b.bonusId)!.includes(n)),
        retakes: [...lost].filter((id) => bonusTs.get(id)!.includes(n)).sort(byNum),
      });
    }
    /** Captures planned from the stack so far, in order. */
    const plannedHere = new Set<number>();
    /** The opponent bonuses `c` breaks: only the first member of each to fall this turn breaks it. */
    const breaksOf = (c: StrikeTarget) =>
      c.breaks.filter((b) => !bonusTs.get(b.bonusId)!.some((t) => t !== c.id && captured.has(t)));
    const strikeValue = (c: StrikeTarget) =>
      Math.max(0, ...breaksOf(c).map((b) => b.value), ...c.retakes.map((id) => g.bonusById.get(id)!.value));
    /** What taking `c` does, against the captures planned so far (a retake completes only with every member held). */
    const effectOf = (c: StrikeTarget): string | null => {
      const held = heldNow();
      held.add(c.id);
      const effects = [
        ...breaksOf(c).map(
          (b) => `breaks ${b.probable ? 'probable ' : ''}enemy bonus ${bonusName(b.bonusId)} (+${b.value} from player ${b.player})`,
        ),
        ...c.retakes.map(
          (id) =>
            `${bonusTs.get(id)!.every((t) => held.has(t)) ? 'retakes' : 'toward retaking'} bonus ${bonusName(id)} (+${g.bonusById.get(id)!.value}), which I held last turn`,
        ),
      ];
      return effects.length ? effects.join('; ') : null;
    };
    const rank = () =>
      [...candidates].sort(
        (a, b) =>
          Number(breaksOf(b).length + b.retakes.length > 0) - Number(breaksOf(a).length + a.retakes.length > 0) ||
          strikeValue(b) - strikeValue(a) ||
          a.cost - b.cost ||
          a.id - b.id,
      );
    /** What may never leave the stack this turn: a Local Deployment pool's deploys (#103). */
    const pinned = poolDeployed.get(S) ?? 0;
    /**
     * The threat on the stack once `gone` (and this turn's other captures) fall, and the armies that
     * hold it. Never below the opponent's deploy alone: orders interleave, so it may land its deploy
     * on a target before my attack resolves, and that territory then still borders the stack.
     */
    const holdAfter = (gone: ReadonlySet<number>) => {
      const th = threatAt(S, (x) => captured.has(x) || gone.has(x));
      const threat = Math.max(th?.threat ?? 0, deployOf(strikeStack!.player));
      return { threat, need: Math.max(0, holdArmies(threat) - unitsAt(S)) };
    };
    const taken: { c: StrikeTarget; effect: string | null; value: number; armies: number; chance: number }[] = [];
    const refused = new Map<number, string>();
    let sent = 0;
    /**
     * No-Split (#124): the stack's one order goes to the strike on `t`, not to the small expansion
     * `m` it already made: that capture is taken back, and its armies rejoin the stack.
     */
    const dropExpansion = (m: PlannedMove, t: number) => {
      const undo = captureUndo.get(m.to);
      if (undo) undo();
      else avail.set(S, avail.get(S)! + m.armies);
      captured.delete(m.to);
      survivorsAt.delete(m.to);
      moves.splice(moves.indexOf(m), 1);
      const head = `Attack ${label(m.to)} from ${label(S)} with `;
      for (let i = rationale.length - 1; i >= 0; i--) if (rationale[i]!.startsWith(head)) rationale.splice(i, 1);
      rationale.push(
        `No-Split: ${label(S)}'s one order goes to the strike on ${label(t)}, not the expansion into ${label(m.to)} (it completes no bonus): the whole stack strikes.`,
      );
      skipOffence(m.to, `No-Split: ${label(S)}'s one order goes to the strike on ${label(t)}`);
    };
    for (let again = true; again; ) {
      again = false;
      for (const c of rank()) {
        if (plannedHere.has(c.id)) continue;
        if (gainWith([c.id]) < 0) {
          const held = heldNow();
          held.add(c.id);
          const negs = completedBy(held)
            .filter((id) => g.bonusById.get(id)!.value < 0 && bonusTs.get(id)!.includes(c.id))
            .map((id) => `negative bonus ${bonusName(id)} (${g.bonusById.get(id)!.value})`);
          refused.set(c.id, `with this turn's other captures it lowers next income: it completes ${negs.join(', ')} (rule 4c)`);
          continue;
        }
        const expansion = noSplit && !taken.length ? smallExpansion(S) : undefined;
        if (noSplit && ((orderOf(S) && !expansion) || taken.length)) {
          refused.set(c.id, `No-Split: ${label(S)} issues one order this turn`);
          continue;
        }
        if (noSplit) {
          // The whole stack goes (#124): nothing stays to hold S but the guard, so it strikes only
          // when it need not hold (it protects nothing, or the strike leaves no visible threat to it).
          const whole = avail.get(S)! + (expansion?.armies ?? 0);
          if (pinned > 0) {
            refused.set(c.id, `No-Split: the ${pinned} Local Deployment armies defending ${label(S)} would leave with the whole stack`);
            continue;
          }
          if (c.cost > whole) {
            refused.set(c.id, `it needs ${c.cost}, more than the ${Math.max(0, whole)} the stack can send`);
            continue;
          }
          const h = mustHold(S, c.id, whole);
          if (h) {
            refused.set(
              c.id,
              `No-Split: the whole stack would go, leaving ${h.stays} against the ~${h.threat} threat, and ${label(S)} must hold (${h.value > 0 ? `protects +${h.value}` : 'my commander stands there'})`,
            );
            continue;
          }
          if (expansion) dropExpansion(expansion, c.id);
          const armies = avail.get(S)!;
          plannedHere.add(c.id);
          refused.delete(c.id);
          taken.push({ c, effect: effectOf(c), value: strikeValue(c), armies, chance: chanceOf(armies, defenceAt(c.id)) });
          avail.set(S, 0);
          sent += armies;
          captured.add(c.id);
          survivorsAt.set(c.id, armies - straightKills(defenceAt(c.id), rates.defensiveKillRate));
          captureOrder.push(c.id);
          again = true;
          break;
        }
        const gone = new Set([...plannedHere, c.id]);
        const { threat, need } = holdAfter(gone);
        // #179: what covers a finished-off player's exit stays too.
        const movable = avail.get(S)! - Math.max(pinned, coverOf(S));
        const stay = avail.get(S)! + guardAt(S) + (incoming.get(S) ?? 0) - c.cost;
        if (c.cost > movable) {
          refused.set(c.id, `it needs ${c.cost}, more than the ${Math.max(0, movable)} the stack can send`);
          continue;
        }
        if (stay < need) {
          refused.set(
            c.id,
            `it would leave the stack ${stay}, below the ${need} that hold it against the ~${threat} threat after the attacks`,
          );
          continue;
        }
        const effect = effectOf(c);
        const value = strikeValue(c);
        plannedHere.add(c.id);
        refused.delete(c.id);
        taken.push({ c, effect, value, armies: c.cost, chance: c.chance });
        avail.set(S, avail.get(S)! - c.cost);
        sent += c.cost;
        captured.add(c.id);
        survivorsAt.set(c.id, c.cost - straightKills(defenceAt(c.id), rates.defensiveKillRate));
        captureOrder.push(c.id);
        again = true;
        break;
      }
    }
    // #120: each attack is then sized for its defenders plus what their owner may deploy there
    // first, in the order taken, while the stack still covers it and keeps its hold after every
    // attack. One the stack cannot cover keeps its size (its warning gives the reinforced odds).
    const reinforced = new Map<number, number>();
    if (!noSplit) {
      const { need } = holdAfter(new Set());
      const room = () => Math.min(avail.get(S)! - Math.max(pinned, coverOf(S)), avail.get(S)! + guardAt(S) + (incoming.get(S) ?? 0) - need);
      // The stack's earlier attacks on a player (a break or counter-attack from it) first.
      for (const m of moves) {
        if (m.from !== S || m.kind !== 'attack' || combined.has(m.to) || worstCase.has(m.to) || strikes.has(m.to)) continue;
        const extra = reinforcementAt(m.to);
        const full = extra > 0 ? costAt(m.to, defenceAt(m.to) + extra) : null;
        if (full === null || full <= m.armies || full - m.armies > room()) continue;
        const add = full - m.armies;
        const before = m.armies;
        avail.set(S, avail.get(S)! - add);
        m.armies = full;
        m.winChance = chanceOf(full, defenceAt(m.to));
        if (survivorsAt.has(m.to)) survivorsAt.set(m.to, survivorsAt.get(m.to)! + add);
        worstCase.set(m.to, defenceAt(m.to) + extra);
        const w = warnings.indexOf(`Attack on enemy ${label(m.to)} assumes its owner does not reinforce it first.`);
        if (w >= 0) warnings.splice(w, 1);
        rationale.push(
          `Size the attack on ${label(m.to)} from the strike stack ${label(S)} up from ${before} to ${full}: ${full} take it even if player ${strikeStack.player} deploys its ~${extra} there first, and the stack still holds.`,
        );
      }
      for (const x of taken) {
        const extra = reinforcementAt(x.c.id);
        const full = extra > 0 ? costAt(x.c.id, defenceAt(x.c.id) + extra) : null;
        if (full === null || full <= x.armies) continue;
        const add = full - x.armies;
        if (add > room()) continue;
        avail.set(S, avail.get(S)! - add);
        sent += add;
        x.armies = full;
        x.chance = chanceOf(full, defenceAt(x.c.id));
        survivorsAt.set(x.c.id, survivorsAt.get(x.c.id)! + add);
        worstCase.set(x.c.id, defenceAt(x.c.id) + extra);
        reinforced.set(x.c.id, extra);
      }
    }
    // What stays on the stack is its hold: an efficient-size top-up (S2) never draws on it, and
    // the transfer step never moves it (its captures can leave it interior; it may have got no deploys).
    if (taken.length) {
      holdLocked.add(S);
      locked.add(S);
    }
    const { threat: finalThreat, need: finalNeed } = holdAfter(new Set());
    const stays = avail.get(S)! + guardAt(S) + (incoming.get(S) ?? 0);
    for (const { c, effect, value, armies, chance } of taken) {
      const reason = `the strike stack ${effect ?? 'takes an adjacent enemy territory'}`;
      moves.push({ from: S, to: c.id, armies, kind: 'attack', reason, winChance: chance });
      const extra = reinforced.get(c.id);
      if (extra === undefined) warnings.push(`Attack on enemy ${label(c.id)} assumes its owner does not reinforce it first.`);
      const keeps = noSplit
        ? `No-Split sends the whole stack (${c.cost} would take it), and ${label(S)} need not hold: ${
            valueOf(S) > 0 || myCommanders.has(S) ? 'no visible threat to it is left' : 'it protects nothing'
          }`
        : `the stack keeps ${stays}, enough to hold against the ~${finalThreat} threat after the attacks (needs ${finalNeed})`;
      const sized =
        extra === undefined
          ? ''
          : ` — sized for its ${defenceAt(c.id)} defenders plus the ~${extra} player ${strikeStack.player} may deploy there first (${c.cost} would take it as it stands)`;
      rationale.push(
        `Attack ${label(c.id)} from the strike stack ${label(S)} with ${armies} (win chance ${pct(chance)}${sized}): ${
          effect ?? 'it can take this adjacent enemy territory'
        }; ${keeps}.`,
      );
      offence.set(`strike:${c.id}`, {
        target: c.id,
        kind: 'strike-attack',
        cost: armies,
        value,
        taken: true,
        why: `from the strike stack ${label(S)} with ${armies} (win chance ${pct(chance)}): ${effect ?? 'takes an adjacent enemy territory'}`,
      });
    }
    for (const c of rank()) {
      if (plannedHere.has(c.id)) continue;
      const effect = effectOf(c);
      offence.set(`strike:${c.id}`, {
        target: c.id,
        kind: 'strike-attack',
        cost: c.cost,
        value: strikeValue(c),
        taken: false,
        why: `not made from the strike stack ${label(S)} — ${refused.get(c.id) ?? 'not worth it'}${effect ? `: ${effect}` : ''}`,
      });
    }
    const builds = `the spare deploys build one strike stack facing player ${strikeStack.player}, the strongest opponent (~${strikeStack.income} income, ${strikeStack.source})`;
    if (!taken.length) {
      const held = candidates.length
        ? candidates.map((c) => `${label(c.id)}: ${refused.get(c.id) ?? 'not worth it'}`).join('; ')
        : 'no visible enemy territory next to it can be taken';
      rationale.push(`Grow the strike stack ${label(S)}: nothing next to it is worth taking this turn (${held}).`);
    }
    if (strikeStack.deployed > 0 || taken.length)
      offence.set(`strike:${S}`, {
        target: S,
        kind: 'strike',
        cost: strikeStack.deployed,
        value: strikeStack.income,
        taken: taken.length > 0,
        why: taken.length
          ? `${builds}; it attacks ${taken.map(({ c }) => label(c.id)).join(', ')} this turn (${sent} armies sent)`
          : `${builds}; it grows: nothing next to it is worth taking this turn`,
      });
  }
}

/** #167: adapting in an FFA with a clear army lead, idle stacks take the weak enemy territories beside them. */
export function leadStrikes(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  cap: Captures,
  holdLocked: ReadonlySet<number>,
  strikeStack: StrikeStack | undefined,
) {
  const {
    g, foe, profile, auto, balanced, territories: state, label, bonusName, mine, mineSet, unitsAt, uncounted, defenceAt,
    bonusTs, rates, chanceOf, costAt, noSplit, armyLead, leadLever, leadText, myCommanders,
  } = pc;
  const { rationale, avail, spared, captured, moves, survivorsAt, captureOrder, captureUndo } = ps;
  const { gainWith } = book;
  const { reinforcementAt } = threats;
  const { conceded, keepFor, twoStepKeep } = hd;
  const { breakable, targets } = tgt;
  const { worstCase } = cap;
  // ---- #167: lead strikes ----
  // Adapting in a free-for-all with two or more opponents, under `balanced`, when my visible armies
  // are more than SECOND_FRONT_LEAD × the largest opponent's in view: rule 0p.2 is off, and every
  // enemy territory next to mine (no special unit on it, never one whose capture lowers income) is
  // attacked from the territory of mine beside it with the most to spare — armies beyond what holds
  // it once the target falls (rule 1's arithmetic, #172's two-step keep too; never a hold, a conceded
  // border, my commander's territory or the strike stack; no deploys: the leftover has spent the
  // income, and a positive bonus's enemy member was already a step in the bonus passes, #203) — when
  // that covers an attack sized for its defenders plus what its owner may deploy there first (rule
  // 3's #120 sizing, so it lands for sure). Breaks first, then a step into a positive bonus, then
  // cheapest, then id. Not under No-Split (an order carries the whole stack).
  /** A lead strike's source: armies on `x` beyond what holds it once `n` falls (also named by the "Not attacking" line). */
  const leadSpareFor = (x: number, n: number) => {
    if (!mineSet.has(x) || holdLocked.has(x) || conceded.has(x) || myCommanders.has(x) || x === strikeStack?.id) return 0;
    const gone = (m: number) => m === n;
    return Math.max(0, avail.get(x)! - Math.max(keepFor(x, gone), twoStepKeep(x, gone)));
  };
  if (auto && balanced && profile.format === 'ffa' && profile.opponents >= 2) {
    if (leadLever)
      rationale.push(
        `FFA army lead: my ${armyLead.my} armies in view are ${Number.isFinite(armyLead.ratio) ? `${leadText()} player ${armyLead.rival}'s ${armyLead.theirs}, the most of any opponent` : `against no opposing army in view`} (more than ${SECOND_FRONT_LEAD}×): no second-front rule — idle stacks beside weak enemy territories attack them, a lever, not a risk.`,
      );
    if (leadLever && !noSplit) {
      const candidates = [...new Set(mine.flatMap((x) => neighborsOf(g, x)))]
        .filter((n) => {
          const st = state.get(n);
          return (
            !mineSet.has(n) &&
            !captured.has(n) &&
            // #179: a buffer left standing is taken by no pass this turn.
            !spared.has(n) &&
            st?.owner.kind === 'player' &&
            foe(st.owner.playerId) &&
            // B2 (T1): never a truce's covered territory.
            !pc.truce.noTarget(n) &&
            st.armies !== null &&
            !uncounted(n) &&
            unitsAt(n) === 0
          );
        })
        .map((n) => {
          const p = (state.get(n)!.owner as { playerId: number }).playerId;
          const d = defenceAt(n);
          const extra = reinforcementAt(n);
          const breaks = breakable.find((b) => b.player === p && bonusTs.get(b.bonusId)!.includes(n));
          const step = g.map.bonuses.find((b) => b.value > 0 && bonusTs.get(b.id)!.includes(n) && !breaks);
          return { n, p, d, extra, cost: costAt(n, d + extra), breaks, step };
        })
        .filter((c) => c.cost !== null)
        .sort(
          (a, b) =>
            Number(!a.breaks) - Number(!b.breaks) || Number(!a.step) - Number(!b.step) || a.cost! - b.cost! || a.n - b.n,
        );
      for (const c of candidates) {
        if (captured.has(c.n) || gainWith([c.n]) < 0) continue;
        const cost = c.cost!;
        const src = neighborsOf(g, c.n)
          .filter((x) => mineSet.has(x))
          .map((x) => ({ x, spare: leadSpareFor(x, c.n) }))
          .filter((o) => o.spare >= cost)
          .sort((a, b) => b.spare - a.spare || a.x - b.x)[0];
        if (!src) continue;
        avail.set(src.x, avail.get(src.x)! - cost);
        captured.add(c.n);
        worstCase.set(c.n, c.d + c.extra);
        survivorsAt.set(c.n, cost - straightKills(c.d + c.extra, rates.defensiveKillRate));
        captureOrder.push(c.n);
        captureUndo.set(c.n, () => avail.set(src.x, avail.get(src.x)! + cost));
        if (!targets.has(c.n)) targets.set(c.n, { id: c.n, cost, enemy: true, sources: neighborsOf(g, c.n).filter((x) => mineSet.has(x)) });
        const effect = c.breaks
          ? `breaks ${c.breaks.probable ? 'probable ' : ''}enemy bonus ${bonusName(c.breaks.bonusId)} (+${c.breaks.value} from player ${c.p})`
          : c.step
            ? `a step into bonus ${bonusName(c.step.id)} (+${c.step.value})`
            : `takes a territory of player ${c.p}`;
        const reason = `army lead: ${effect}, sure even if player ${c.p} deploys its ~${c.extra} there first (${c.d} + ${c.extra} defenders), with armies ${label(src.x)} does not need to hold`;
        moves.push({ from: src.x, to: c.n, armies: cost, kind: 'attack', reason, winChance: chanceOf(cost, c.d) });
        rationale.push(`Attack ${label(c.n)} from ${label(src.x)} with ${cost}: ${reason}.`);
      }
    }
  }
  return { leadSpareFor };
}
