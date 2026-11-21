// The 1v1 strike stack (rule 0p.3c, #72): which border to build it on (chooseStrikeStack) and its attacks after the leftover (spendStrikeStack) (split from strike.ts, which re-exports it).
import { forecastBorder } from '../exchange.js';
import { straightKills } from '../combat.js';
import { neighborsOf } from '../graph.js';
import {



  MIN_ENEMY_DEPLOY,

  visibleState,
  type PlanInput,
  type PlannedMove,
} from './shared.js';
import type { Captures } from './captures.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Breakable, Targets } from './targets.js';
import type { Threats } from './threats.js';
import { byNum, pct } from './util.js';
import { stackFacing, type StrikeStack } from './strike.js';
import { STRIKE_SHARE, stockpileOf } from './stockpile.js';

/** Rule 0p.3c (#72, #120, #201, #421): the strike stack's border (a 1v1, a siege or a stockpile), chosen before the leftover deploy. */
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
  // A 1v1 rule: in an FFA or a team game the comfort margins keep the leftover (several fronts), unless a stockpile (#421, below).
  // Chosen even when holds and captures leave no leftover (#102): the stack is still spent.
  let stack: Omit<StrikeStack, 'deployed'> | undefined;
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
  // #382: a siege builds the stack facing its target in any format (its attacks held until the trigger:
  // the target's other territories are no targets then, so the stack only grows or breaks).
  const siege = pc.siege && facing.has(pc.siege.target) ? pc.siege : undefined;
  // #421: outside a 1v1, a stockpile on a flat income — my armies in view at least STOCKPILE_TURNS
  // turns of income while it has not grown — builds the stack facing the opponent beside me whose
  // armies in view mine outnumber STOCKPILE_LEAD× or more (the fewest first, then id). Visible armies
  // only, never an income estimate: the pile is spent where it dominates. Not under No-Split (an order
  // carries the whole stack), and never on my commander's territory.
  const stockpile = stockpileOf({
    territories: state, mineSet: pc.mineSet, unitsAt, foe: pc.foe, income, ...(pc.incomeTrend ? { incomeTrend: pc.incomeTrend } : {}),
    auto, goal, noSplit, format: profile.format, siege: siege !== undefined, facing,
  });
  if ((auto && profile.format === '1v1' && goal !== 'defend' && facing.size) || siege || stockpile) {
    const player = siege
      ? { p: siege.target, e: estimates.get(siege.target) }
      : stockpile
        ? { p: stockpile.p, e: estimates.get(stockpile.p) }
        : [...facing]
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
          // #421: a stockpile's stack never stands on my commander's territory.
          !(stockpile && pc.myCommanders.has(x)) &&
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
    if (id !== undefined && stockpile)
      rationale.push(
        `Stockpile (#421): ${stockpile.line}, so the spare deploys build one strike stack on ${label(id)} facing it, spent on what it can take every turn, rather than comfort margins.`,
      );
    if (id !== undefined)
      stack = {
        id,
        player: player.p,
        income: player.e?.estimate ?? MIN_ENEMY_DEPLOY,
        source: player.e?.source === 'tracked' ? 'tracked' : player.e?.source === 'observed' ? 'observed' : 'estimated',
        ...(stockpile ? { facing: stockpile.why } : {}),
      };
  }
  // #421 (owner decision, 2026-11-20): the share the estimates phase held out of captures.
  if (pc.strikeShare > 0)
    rationale.push(
      stack
        ? `Strike share (#421): ${pc.strikeShare} of my flat ${income} income (${STRIKE_SHARE * 100}%) was held out of captures for the strike stack on ${label(stack.id)}, ahead of comfort margins; holds took their exact need first.`
        : `Strike share (#421): ${pc.strikeShare} of my flat ${income} income (${STRIKE_SHARE * 100}%) was held out of captures for a strike stack, but no border could carry one this turn: it goes to the leftover as usual.`,
    );
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
      /** Its plain capture cost, which ranks it (#240 review: evidence never demotes a target that fits). */
      cost: number;
      /** What the strike sends: the cost, or a repulsed territory's sure size (#240). */
      size: number;
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
      // #240: a territory my attacks failed on repeatedly is sized for its owner's deploy (#240
      // review: and ranked on its plain cost, like any other).
      const cost = costAt(n);
      const size = tgt.costFor(n);
      // Never a capture that lowers income (rule 4c): it completes a negative bonus. Re-checked
      // below against the strike's own captures, which can complete one only together.
      if (cost === null || size === null || gainWith([n]) < 0) continue;
      const owner = st.owner.playerId;
      candidates.push({
        id: n,
        cost,
        size,
        chance: chanceOf(size, defenceAt(n)),
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
          if (c.size > whole) {
            refused.set(c.id, `it needs ${c.size}, more than the ${Math.max(0, whole)} the stack can send`);
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
        const stay = avail.get(S)! + guardAt(S) + (incoming.get(S) ?? 0) - c.size;
        if (c.size > movable) {
          refused.set(c.id, `it needs ${c.size}, more than the ${Math.max(0, movable)} the stack can send`);
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
        taken.push({ c, effect, value, armies: c.size, chance: c.chance });
        avail.set(S, avail.get(S)! - c.size);
        sent += c.size;
        captured.add(c.id);
        survivorsAt.set(c.id, c.size - straightKills(defenceAt(c.id), rates.defensiveKillRate));
        captureOrder.push(c.id);
        again = true;
        break;
      }
    }
    // #120: each attack is then sized for its defenders plus what their owner may deploy there
    // first, in the order taken, while the stack still covers it and keeps its hold after every
    // attack. One the stack cannot cover keeps its size (its warning gives the reinforced odds).
    const reinforced = new Map<number, number>();
    // #240 review: a repulsed territory was costed at that size when the stack took it (and No-Split
    // sends at least as much): it is sized for its owner's deploy already, and says so.
    for (const x of taken) {
      const rep = tgt.repulsed.get(x.c.id);
      // #272 review: one sized below its owner's deploy estimate is no worst case (#120 below may still size it up).
      if (!rep?.sure || x.armies < rep.cost) continue;
      worstCase.set(x.c.id, rep.defenders + rep.extra);
      reinforced.set(x.c.id, rep.extra);
    }
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
        ? `No-Split sends the whole stack (${c.size} would take it), and ${label(S)} need not hold: ${
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
        cost: c.size,
        value: strikeValue(c),
        taken: false,
        why: `not made from the strike stack ${label(S)} — ${refused.get(c.id) ?? 'not worth it'}${effect ? `: ${effect}` : ''}`,
      });
    }
    const builds = `the spare deploys build one strike stack facing player ${strikeStack.player}, ${stackFacing(pc, strikeStack)} (~${strikeStack.income} income, ${strikeStack.source})`;
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

