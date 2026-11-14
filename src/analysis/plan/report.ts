// The report of a planning pass (#133): once every order is planned, what the plan expects (the
// captures, the bonuses completed and their joint chance, #126; the income at risk, #109), the
// frontier budget (rule 4d, #71), the two-step holds still cited (#172), the absorptions claimed
// (#201), the gambled and shared borders (#69, #167, #201), the offence report (#72), the warnings
// that follow the deploys, the "Not attacking" line (#167), and the plan itself: the offence list,
// #172's final check of each territory in between, the retaliation warning (#201), the exchanges
// (#167) and the turns to eliminate each opponent (#179). planPass runs them where they ran before:
// the expected outcome and the offence report after Order Priority for a strike, the plan last,
// after the move order (plan/move-order.ts).
import { bonusTerritories } from '../bonuses.js';
import { classifyExchange, type ExchangeCase } from '../exchange.js';
import { neighborsOf } from '../graph.js';
import {
  bonusesAtRisk,
  captureCost,
  CITE_OPEN,
  CITE_RE,
  ETA_HORIZON,
  NOT_ATTACKING_REASONS,
  SECOND_FRONT_LEAD,
  SLOT_NAMES,
  type BonusAtRisk,
  type EliminateEta,
  type ExchangeView,
  type FrontierBudget,
  type OffenceEntry,
  type OpponentExits,
  type PlannedMove,
  type TurnPlan,
  type TwoStepPass,
} from './shared.js';
import type { MoveSlot } from '../schedule.js';
import type { Captures } from './captures.js';
import { lateArrivals, type Holds } from './holds.js';
import type { DeployBook } from './orders.js';
import type { PlanCtx, PlanState } from './state.js';
import type { LeadBlock, Targets } from './targets.js';
import type { Threats } from './threats.js';
import { byNum, pct } from './util.js';

/** #212: why a neighbour of mine could not attack a lead step, as the skip line says it. */
const BLOCKED: Record<LeadBlock, string> = {
  commander: 'holds my commander: nothing leaves it (rule 1k)',
  order: 'already issues an order',
  locked: 'keeps its armies where they are this turn',
};


/** What the plan expects once every order is in, as the report and the plan read it. */
export interface Expected {
  completed: number[];
  nextIncome: number;
  atRisk: BonusAtRisk[];
  ifFall: number;
  reportRisk: boolean;
  frontier: FrontierBudget;
}

/** The expected outcome, the frontier, the two-step holds and the gambled and shared borders. */
export function reportExpected(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  caps: Captures,
): Expected {
  const {
    g, foe, deployOf, territories: state, label, bonusName, mine, mineSet, incomeAfter, unitsAt, completedBy, guard,
    toTake, noSplit,
  } = pc;
  const { warnings, rationale, absorbLines, captured, moves, survivorsAt } = ps;
  const { heldNow } = book;
  const { borders } = threats;
  const { conceded, heldAgainst, keptIncome, stayAt, twoStepBound, twoStepCited, twoStepHold, twoStepNote } = hd;
  const { frontierOf, startHold } = tgt;
  const { notCompleted, stopped, stoppedLine } = caps;
  // ---- expected ----
  const after = heldNow();
  const completed = completedBy(after);
  // #126: a completion lands only if every capture it needs does — its chance is their product.
  for (const id of completed) {
    const taken = bonusTerritories(g, id).filter((x) => captured.has(x));
    // Each member's capture is its last attack (a combined capture's softeners fail by design).
    const chances = taken.map((x) => moves.filter((m) => m.kind === 'attack' && m.to === x).at(-1)?.winChance ?? 1);
    const joint = chances.reduce((a, b) => a * b, 1);
    if (joint < 1)
      rationale.push(
        `Bonus ${bonusName(id)} (+${g.bonusById.get(id)!.value}) completes with a ${pct(joint)} chance: the product of its ${taken.length} capture${taken.length === 1 ? "'s" : "s'"} win chances this turn.`,
      );
  }
  // A bonus refused in one pass but completed by a later one is not reported as refused.
  for (const id of [...notCompleted.keys()].sort(byNum)) {
    if (completed.includes(id)) continue;
    warnings.push(notCompleted.get(id)!.warning);
    rationale.push(notCompleted.get(id)!.why);
  }

  // Issue #109: the income the plan's concessions put at risk. `nextIncome` counts every
  // territory the plan keeps (conceded borders included); a second figure drops the conceded
  // borders, by the same income rule, and names the bonuses they break.
  const nextIncome = incomeAfter(after);
  const atRisk = bonusesAtRisk(g, after, conceded);
  const ifFall = incomeAfter(new Set([...after].filter((t) => !conceded.has(t))));
  const reportRisk = atRisk.length > 0 || ifFall !== nextIncome;
  if (ifFall < nextIncome) {
    const what = atRisk.length
      ? `bonus ${atRisk.map((b) => `${bonusName(b.bonusId)} (+${b.value})`).join(', ')}`
      : [...conceded].sort(byNum).map(label).join(', ');
    warnings.push(
      `This plan concedes ${what}: next income ${nextIncome} if they hold, ${ifFall} if the conceded borders fall.`,
    );
  }
  const nextIncomeText = ifFall < nextIncome ? `${nextIncome}, ${ifFall} if the conceded borders fall` : `${nextIncome}`;

  // Rule 4d's frontier budget (#71): the frontier this plan leaves against the next income.
  const frontier: FrontierBudget = {
    ...frontierOf(after, (x) => (mineSet.has(x) ? stayAt(x) : (survivorsAt.get(x) ?? 0))),
    income: keptIncome(after),
  };
  const startCost = startHold();
  const outgrown = frontier.holdCost > frontier.income && frontier.holdCost > startCost;
  // A capture stopped by one pass but taken by a later one (the next income grew in between) is
  // in the orders: nothing may still say it was not taken.
  const notTaken = stopped.filter((x) => !captured.has(x.t));
  const takenAfterAll = stopped.filter((x) => captured.has(x.t)).map((x) => stoppedLine(x.t));
  if (takenAfterAll.length) {
    const kept = rationale.filter((r) => !takenAfterAll.some((line) => r.startsWith(line)));
    rationale.splice(0, rationale.length, ...kept);
  }
  if (outgrown || notTaken.length) {
    const stop = notTaken.length
      ? ` Expansion that adds enemy borders without completing a bonus is stopped: ${notTaken.map((x) => `${label(x.t)} (the frontier would need ${x.holdCost}, next income ${x.income})`).join(', ')} not taken.`
      : '';
    warnings.push(
      outgrown
        ? `Frontier grows faster than income: holding its ${frontier.enemyBorders} enemy-facing borders next turn needs ${frontier.holdCost} at the expected deploy, more than ${
            frontier.income < nextIncome
              ? `the ${frontier.income} of next income the plan counts on (${nextIncome} if every border holds: the bonuses it concedes or still contests are left out)`
              : `the next income of ${frontier.income}`
          } (${startCost} at the start of the turn).${stop}`
        : `Frontier grows faster than income.${stop}`,
    );
  }
  // #172: each two-step hold an order cited, or that shrank or ruled out an order (a pressure
  // attack's size, a softener, a finisher, a top-up), is stated once, with the stay the plan ends
  // on (an order's own note would read the stay mid-plan) — if it still applies at the end. One
  // that no longer does (a later capture took the territory in between, or the stay fell so far
  // that holding is hopeless) is not stated, and the orders' citations of it are dropped.
  const stillHeld = new Set<number>();
  for (const t of [...new Set([...twoStepBound, ...twoStepCited.keys()])].sort(byNum)) {
    // The stay the plan ends on, rule 6's arrivals included, decides whether the hold still applies.
    const h = twoStepHold(t, undefined, true);
    if (!h) continue;
    stillHeld.add(t);
    rationale.push(`Hold ${label(t)} against a stack two steps away (${twoStepNote(t, h)}).`);
  }
  for (let i = rationale.length - 1; i >= 0; i--) {
    const line = rationale[i]!;
    if (!line.includes(CITE_OPEN)) continue;
    const text = line.replace(CITE_RE, (_m, t: string, clause: string, fallback: string) =>
      stillHeld.has(Number(t)) ? clause : fallback,
    );
    if (text.trim()) rationale[i] = text;
    else rationale.splice(i, 1);
  }
  // #201: an absorption is claimed only where an attack on that player is made.
  for (const [p, line] of absorbLines) {
    const owned = (t: number) => {
      const o = state.get(t)?.owner;
      return o?.kind === 'player' && o.playerId === p;
    };
    if (moves.some((m) => m.kind === 'attack' && owned(m.to))) continue;
    const i = rationale.indexOf(line);
    if (i >= 0) rationale.splice(i, 1);
  }
  if (frontier.enemyBorders)
    rationale.push(
      `Frontier after this plan: ${frontier.borders} borders, ${frontier.enemyBorders} facing an enemy, needing ${frontier.holdCost} next turn to hold at the expected deploy (next income ${nextIncomeText}); every capture's score paid for the borders it adds.`,
    );

  // #201, behind: the borders sized for the expected attack, per player — what that gambles.
  {
    // Read from `borders`, the sizing the plan used (re-judged after captures), never from a
    // hypothetical re-judge: the expected attack is the border's `threat`, the worst case its `worst`.
    const gambled = new Map<number, { player: number; worst: number; expected: number; growth: number }>();
    for (const b of borders.values())
      if (b.worst !== undefined) gambled.set(b.id, { player: b.player, worst: b.worst, expected: b.threat, growth: b.growth });
    const byPlayer = new Map<number, number[]>();
    for (const [id, x] of gambled) if (mineSet.has(id) && !conceded.has(id)) byPlayer.set(x.player, [...(byPlayer.get(x.player) ?? []), id]);
    for (const [p, ids] of [...byPlayer].sort((a, b) => a[0] - b[0])) {
      // Gambled: holds against the expected attack as the plan leaves it, not against the worst case.
      // One short of even the expected attack is no gamble (its threat warning says so).
      const takeAt = (id: number) => toTake(stayAt(id) + unitsAt(id)) ?? Infinity;
      const gamble = ids.sort(byNum).filter((id) => takeAt(id) > gambled.get(id)!.expected && takeAt(id) <= gambled.get(id)!.worst);
      const allHold = ids.every((id) => takeAt(id) > gambled.get(id)!.worst);
      if (!gamble.length && !allHold) continue;
      warnings.push(
        `Behind (#201): the borders facing player ${p} are sized for its expected attack (its movable armies next to each plus its whole ~${deployOf(p)} deploy, #59), not the worst case its growth per turn projects, and the armies saved go to the captures. ${
          gamble.length
            ? `Gambled: ${gamble
                .map((id) => {
                  const x = gambled.get(id)!;
                  return `${label(id)} (it holds against the expected ~${x.expected}, not the worst-case ~${x.worst} at its growth of ~${x.growth} a turn)`;
                })
                .join(', ')} — each falls if player ${p} keeps growing at that rate and attacks it.`
            : 'Each still holds against the worst case as the plan leaves it.'
        }`,
      );
    }
  }
  // Issue #69, second point: several borders facing one opponent are each sized for its whole
  // deploy. That is each border's worst case — the opponent picks where to land after I
  // commit — so a sure hold of all of them needs every one sized for it; no army is counted
  // twice on one border (movable + max(deploy, growth)).
  for (const [p, ids] of [...heldAgainst].sort((a, b) => a[0] - b[0])) {
    const held = [...ids].filter((id) => !conceded.has(id)).sort(byNum);
    if (held.length < 2) continue;
    rationale.push(
      `Each of the ${held.length} borders held against player ${p} (${held.map(label).join(', ')}) is sized for its full ~${deployOf(p)} deploy: it chooses where to land after seeing my orders, so any one of them can face all of it, and a share each would leave whichever it picks short. Each border's threat counts its stacks next to that border once plus one deploy, never the deploy twice.`,
    );
  }

  // #167: cover odds. One deploy lands on one territory: against a player that faces two or more of
  // my kept borders, those that hold against its stacks alone but not with its whole deploy on them
  // are a gamble on where it lands — say which, and the chance each survives if it picks at random.
  // A split deploy takes every border whose shortfall it funds alongside another's: those get 0%.
  {
    const facingBy = new Map<number, { x: number; movable: number }[]>();
    for (const x of mine) {
      if (conceded.has(x)) continue;
      const by = new Map<number, number>();
      for (const n of neighborsOf(g, x)) {
        const st = state.get(n);
        if (captured.has(n) || st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
        by.set(st.owner.playerId, (by.get(st.owner.playerId) ?? 0) + Math.max(0, st.armies - guard) + unitsAt(n));
      }
      for (const [q, movable] of by) facingBy.set(q, [...(facingBy.get(q) ?? []), { x, movable }]);
    }
    for (const [q, list] of [...facingBy].sort((a, b) => a[0] - b[0])) {
      if (list.length < 2) continue;
      const d = deployOf(q);
      const short = list.flatMap(({ x, movable }) => {
        const take = toTake(stayAt(x) + unitsAt(x));
        return take !== null && take > movable && take <= movable + d ? [{ x, gap: take - movable }] : [];
      });
      if (!short.length) continue;
      const n = list.length;
      // A deploy can be split: a border whose shortfall the deploy funds together with another
      // border's is no coin flip — the split takes both. How many it takes at once: the smallest
      // shortfalls first, while the deploy covers them.
      const splits = short.filter(({ x, gap }) => short.some((o) => o.x !== x && gap + o.gap <= d));
      const gaps = short.map(({ gap }) => gap).sort((a, b) => a - b);
      let k = 0;
      for (let left = d; k < gaps.length && gaps[k]! <= left; k++) left -= gaps[k]!;
      const flips = short.filter((s) => !splits.includes(s));
      const parts: string[] = [];
      // #201: the split takes k at once. Each of those holds with chance 0% only when there are
      // k of them or fewer; with more, it picks k of them and each holds with (m − k) ÷ m.
      if (splits.length) {
        const m = splits.length;
        const named = `(${splits.map(({ x, gap }) => `${label(x)} short ${gap}`).join(', ')})`;
        parts.push(
          m <= k
            ? `its ~${d} deploy, split, can take ${k} of the ${n} borders facing it at once ${named}: each of those holds with chance 0%.`
            : `its ~${d} deploy, split, can take ${k} of the ${n} borders facing it at once ${named}: if it picks ${k} of those ${m} at random, each holds with chance ${Math.round(((m - k) / m) * 100)}%, and all of them with 0%.`,
        );
      }
      if (flips.length)
        parts.push(
          `${splits.length ? 'Besides, its' : 'its'} one ~${d} deploy can land on one of the ${n} borders facing it; ${flips.length} hold${flips.length === 1 ? 's' : ''} against its stacks alone but not with that deploy on ${flips.length === 1 ? 'it' : 'them'} (${flips.map(({ x }) => label(x)).join(', ')}) — a gamble on where it lands: if it picks among the ${n} at random, ${
            flips.length === 1
              ? `it holds with chance ${Math.round(((n - 1) / n) * 100)}%`
              : `each holds with chance ${Math.round(((n - 1) / n) * 100)}%${splits.length ? '' : `, and all of them with ${Math.round(((n - flips.length) / n) * 100)}%`}`
          }.`,
        );
      rationale.push(`Cover odds against player ${q} (#167): ${parts.join(' ')}`);
    }
  }

  if (noSplit && moves.length && guard)
    warnings.push(
      'No-Split is on: each order sends its territory\'s whole stack less the one army that stands guard; whether war.app leaves that army behind under No-Split is unverified (a live turn with the guard off left every source at 0).',
    );

  return { completed, nextIncome, atRisk, ifFall, reportRisk, frontier };
}

/** The offence report (#72), the warnings that follow the deploys, and the "Not attacking" line (#167). */
export function reportOffence(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  holdLocked: ReadonlySet<number>,
  leadSpareFor: (x: number, n: number) => number,
) {
  const {
    g, foe, profile, auto, goal, territories: state, label, mine, mineSet, unitsAt, uncounted, uncountedKind,
    defenceAt, costAt, toTake, noSplit, leadLever, ffaLeader, leadText, myCommanders,
  } = pc;
  const { warnings, rationale, deployed, avail, spared, unabsorbed, captured, moves } = ps;
  const { gainWith, orderOf, pools, coverOf } = book;
  // As the deploy book reads it (Local Deployment).
  const local = pools !== null && pools.bonuses.length > 0;
  const { reinforcementAt, forceAt, borders, borderAt } = threats;
  const { conceded, stood, keepFor, stayAt, threatWarnings, twoStepKeep } = hd;
  const { offenceSkip, badTrades, leadTry } = tgt;

  // ---- offence report (#72) ----
  for (const [t, { lost, killed }] of [...badTrades].sort((a, b) => a[0] - b[0]))
    if (!captured.has(t))
      rationale.push(
        `Not attacking ${label(t)}: the combined capture loses ${lost} armies for the ${killed} it kills, a trade below even while behind on armies.`,
      );
  /** What the final orders send at `t` (a top-up of idle armies can raise a capture's size). */
  const sentAt = (t: number) => moves.reduce((n, m) => (m.kind === 'attack' && m.to === t ? n + m.armies : n), 0);
  /**
   * #215: a border of mine that holds only with the armies withdrawn into it, which land after the
   * opponent's first attack when it moves first (unless I am known to move first, {@link lateArrivals}):
   * the extra deploy that would hold it whoever moves first, the threat and the player; `null` when
   * it holds either way, falls either way, or is conceded. `atStart` is the threat warned of before
   * the deploys (its worst case, #201), judged once this turn's captures are done (#212).
   */
  const firstOnlyAt = (id: number, atStart: number): { late: number; own: number; d: number; threat: number; player: number } | null => {
    if (!mineSet.has(id) || conceded.has(id)) return null;
    const late = lateArrivals(pc, ps, id);
    const after = borderAt(id, (x) => captured.has(x));
    if (late <= 0 || !after) return null;
    const threat = Math.min(atStart, after.worst ?? after.threat);
    const own = stayAt(id) - late + unitsAt(id);
    if ((toTake(own + late) ?? Infinity) <= threat || (toTake(own) ?? Infinity) > threat) return null;
    let d = 0;
    while ((toTake(own + d) ?? Infinity) <= threat) d++;
    return { late, own: own - unitsAt(id), d, threat, player: after.player };
  };
  // A border warned about before the deploys may have been deployed to since: say what the
  // plan leaves there, so the warning does not contradict the hold, floor or spread lines.
  for (let i = 0; i < warnings.length; i++) {
    const hit = [...threatWarnings].find(([, w]) => w.text === warnings[i]);
    if (!hit) continue;
    const [id, { threat: atStart }] = hit;
    const n = deployed.get(id) ?? 0;
    if (n <= 0) continue;
    const have = stayAt(id);
    const take = toTake(have + unitsAt(id));
    // #212: judged against the threat once this turn's captures are done (a captured stack beside
    // it cannot attack), as the hold and lead-step lines size it — else a border the plan just
    // sized is called short against a stack it takes this turn.
    const after = borderAt(id, (x) => captured.has(x));
    const threat = after ? Math.min(atStart, after.worst ?? after.threat) : 0;
    // #215: one that holds only with the armies withdrawn into it says so (the warning below).
    const firstOnly = firstOnlyAt(id, atStart) !== null;
    // The opponents' territories beside it that this turn's attacks take.
    const takenNear = neighborsOf(g, id)
      .filter((x) => captured.has(x) && state.get(x)?.owner.kind === 'player')
      .sort(byNum);
    const lower = threat < atStart && takenNear.length > 0;
    const once = lower ? `once ${takenNear.map(label).join(' and ')} ${takenNear.length === 1 ? 'is' : 'are'} taken` : '';
    warnings[i] += ` Before this turn's deploys: the plan deploys ${n} there, leaving ${have} armies (${take ?? 'none can'} to take${
      !after
        ? `; nothing can reach it${once ? ` ${once}` : ''}: it holds`
        : take !== null && take > threat
          ? `, more than the ${threat} that can ${lower ? `still reach it ${once}` : 'reach it'}: it holds${firstOnly ? ' only if I move first' : ''}`
          : `; ${lower ? `even ${once}, ` : ''}the ${threat} that can reach it still could`
    }).`;
  }
  // #215: every border that holds only if I move first, and what would hold it either way (the
  // leftover sizes such a hold when it can, plan/leftover.ts: one named here it could not afford).
  for (const id of [...borders.keys()].sort(byNum)) {
    const b = borders.get(id)!;
    const f = firstOnlyAt(id, b.worst ?? b.threat);
    if (!f) continue;
    warnings.push(
      `${label(id)} holds only if I move first: ${f.late} of its armies are withdrawn into it this turn, and ${
        pc.opts.movesFirst === false ? `player ${f.player} moves first, so its attack` : `if player ${f.player} moves first its attack`
      } (~${f.threat}) lands before them. Its own ${f.own} need ${toTake(f.own + unitsAt(id))} to take; ${f.d} more deployed there would hold it whoever moves first, more than the plan had left to deploy there.`,
    );
  }
  // #201: the FFA leader's borders held against two or more opponents attacking together.
  if (ffaLeader)
    for (const id of [...borders.keys()].sort(byNum)) {
      if (conceded.has(id) || !mineSet.has(id)) continue;
      const f = forceAt(id, (n) => captured.has(n), { trend: true, allPlayers: true });
      if (!f?.split || f.split.players.length < 2) continue;
      rationale.push(
        `I lead this free-for-all (#201): ${label(id)} is held against players ${f.split.players.join(' and ')} attacking together (${f.split.attacks.join(' then ')}, up to ${f.split.takes} armies), not each alone: the others may combine against the leader.`,
      );
    }
  // #128: a border that holds against each opponent alone but not against two of them attacking
  // it in the same turn (FFA players do not coordinate, so this is a warning, not a hold).
  for (const id of [...borders.keys()].sort(byNum)) {
    if (conceded.has(id) || !mineSet.has(id)) continue;
    const alone = borderAt(id, (n) => captured.has(n));
    const pile = forceAt(id, (n) => captured.has(n), { trend: true, allPlayers: true, pileOn: true });
    if (!alone || !pile?.split || pile.split.players.length < 2) continue;
    const have = stayAt(id) + unitsAt(id);
    const take = toTake(have);
    if (take === null || take <= alone.threat || have > pile.split.takes) continue;
    warnings.push(
      `${label(id)} holds against each opponent alone, but players ${pile.split.players.join(' and ')} attacking it in the same turn (${pile.split.attacks.join(' then ')}) could take up to ${pile.split.takes} armies, and ${have} stay there.`,
    );
  }
  // ---- #167: every enemy territory next to mine left alone names why ----
  // One rationale line lists each visible enemy territory next to a territory I held at the start
  // that no order attacks, with the first reason that applies: a special unit there, a reason the
  // offence report already gave (rule 0p.2's second front among them), a capture that lowers income,
  // its size against the most any neighbour of mine can spare once it holds its border (#215: a conceded
  // one, its garrison not standing, offers what it can still send once its orders leave), or that it is
  // no target of the plan's (rule 2: a player's territory is attacked to break a bonus, counter-attack,
  // finish a player off, strike, or as rule 4e's fallback; adapting in an FFA, the lead strikes).
  {
    /** #215: a conceded border whose garrison does not stand (rule 1b): it keeps nothing back (my commander's never is: rule 1k). */
    const givenUp = (x: number) => conceded.has(x) && !stood.has(x);
    const spareNow = (x: number, n: number) => {
      if (!mineSet.has(x) || myCommanders.has(x) || orderOf(x)) return 0;
      // #215: a conceded border (its garrison not standing) holds nothing: what it can still send
      // once its orders leave (an attack out, rule 1b's withdrawal) is free — every army on it but
      // what the guard-off cover keeps there (coverOf), so it is below what stays on it.
      if (givenUp(x)) return Math.max(0, avail.get(x)! - coverOf(x));
      if (holdLocked.has(x)) return 0;
      const gone = (m: number) => m === n;
      return Math.max(0, avail.get(x)! - Math.max(keepFor(x, gone), twoStepKeep(x, gone)));
    };
    const attacked = new Set(moves.filter((m) => m.kind === 'attack').map((m) => m.to));
    const left = [...new Set(mine.flatMap((x) => neighborsOf(g, x)))].sort(byNum).filter((n) => {
      const st = state.get(n);
      return !mineSet.has(n) && !attacked.has(n) && st?.owner.kind === 'player' && foe(st.owner.playerId) && st.armies !== null;
    });
    const reasonFor = (n: number): string => {
      const st = state.get(n)!;
      const p = (st.owner as { playerId: number }).playerId;
      if (uncounted(n)) return `it holds ${uncountedKind(n)}, whose strength the board does not carry`;
      if (unitsAt(n) > 0) return `an enemy commander stands there: only a commander strike (rule 1s) attacks it, sized for its owner's whole deploy`;
      if (spared.has(n) && unabsorbed.has(p))
        return `absorbing player ${p} would not bring my income to the FFA leader's: the armies are better spent against the leader (#201)`;
      if (spared.has(n)) return `player ${p} is a buffer in this FFA: finishing it off costs more frontier than it pays (#179)`;
      const skip = offenceSkip.get(n);
      if (skip) return skip;
      if (gainWith([n]) < 0) return 'taking it would lower my income (it completes a negative bonus)';
      const need = costAt(n);
      const extra = reinforcementAt(n);
      const sure = extra > 0 ? costAt(n, defenceAt(n) + extra) : need;
      // #203: why its bonus's step failed, as measured when that pass tried it (later deploys,
      // counted in the spares below, could not fund it then). #212: said whichever line follows,
      // so a step tried and refused never reads as standing armies alone.
      const tried = leadTry.get(n);
      const deployText =
        tried === undefined
          ? ''
          : tried.kind === 'r3'
            ? `; its bonus's step was refused: what survives the attack would not hold it next turn (R3)`
            : tried.kind === 'trade'
              ? `; its bonus's step was refused: a trade below even (~${tried.lost} lost for ${tried.killed} killed)`
              : tried.kind === 'frontier'
                ? `; its bonus's step was stopped by rule 4d's frontier budget: it adds a border facing an enemy`
                : tried.from === undefined
                  ? `; when its bonus's step was tried, no neighbour of mine was free to attack it${
                      tried.blocked?.length
                        ? ` (${tried.blocked
                            .map(({ from, why }) => `${label(from)} ${BLOCKED[why]}`)
                            .join('; ')})`
                        : ''
                    }`
                  : tried.hold !== undefined
                    ? `; when its bonus's step was tried, ${label(tried.from)} holds its border, and with the step gone its hold needed ${tried.hold} more than it had; this turn's deploy could add at most ${tried.reach} there${local ? ' (Local Deployment)' : ''}: ${Math.max(0, tried.reach - tried.hold)} left for the attack`
                    : `; when its bonus's step was tried, ${label(tried.from)} could spare ${tried.spare} for it and ${
                        tried.reach === 0
                          ? 'none of this turn\'s deploy could still reach it'
                          : `this turn's deploy could add at most ${tried.reach} there${local ? ' (Local Deployment)' : ''}: ${tried.spare + tried.reach} in all`
                      }`;
      const best = neighborsOf(g, n)
        .filter((x) => mineSet.has(x))
        .map((x) => ({ x, spare: spareNow(x, n) }))
        .sort((a, b) => b.spare - a.spare || a.x - b.x)[0]!;
      if (need === null) return 'no attack can take it at these kill rates';
      if (best.spare < need)
        return `taking it needs ${need}${sure !== null && sure > need ? ` (${sure} if player ${p} deploys its ~${extra} there first)` : ''}, and ${
          givenUp(best.x)
            ? `the most a neighbour of mine has left for it is ${best.spare} (${label(best.x)}, conceded: ${
                orderOf(best.x)
                  ? `No-Split sends its whole stack on its other order`
                  : 'what it can still send once its other orders leave'
              })`
            : `the most a neighbour of mine can spare once it holds its border is ${best.spare}${best.spare > 0 ? ` (${label(best.x)})` : ''}`
        }${deployText}`;
      if (goal !== 'balanced') {
        // Rule 4e's fallback (and a lead) can still take a player's territory under another goal.
        const others = [...attacked].filter((t) => t !== n && state.get(t)?.owner.kind === 'player').sort(byNum);
        return others.length
          ? `under goal ${goal} the plan attacks a player's territory only where a rule calls for it (here ${others.map(label).join(', ')}), and none calls for this one`
          : `goal ${goal} attacks no player's territory${goal === 'complete-bonus' ? ' outside the bonus it completes' : ''}`;
      }
      const ffaLead = auto && profile.format === 'ffa' && profile.opponents >= 2;
      if (ffaLead && leadLever && !noSplit && sure !== null && sure > need) {
        // The lead strikes ran: this one was not sized for sure (defenders plus its owner's deploy).
        const lead = neighborsOf(g, n)
          .filter((x) => mineSet.has(x))
          .map((x) => ({ x, spare: leadSpareFor(x, n) }))
          .sort((a, b) => b.spare - a.spare || a.x - b.x)[0]!;
        if (lead.spare < sure)
          return `a lead strike (my army lead is ${leadText()}, over ${SECOND_FRONT_LEAD}×) needs ${sure} — sized for its ${defenceAt(n)} defenders plus player ${p}'s ~${extra} deploy — and the most a neighbour of mine can spare for it is ${lead.spare}${lead.spare > 0 ? ` (${label(lead.x)})` : ''}${deployText}`;
      }
      return `${label(best.x)} could spare ${best.spare} for it, but it breaks no bonus and is no counter-attack, finishing blow or strike — the only reasons the plan attacks a player's territory (rule 2), besides rule 4e's fallback when nothing else is captured${
        !ffaLead
          ? ''
          : !leadLever
            ? ` (a lead strike takes one only with an army lead over ${SECOND_FRONT_LEAD}×; mine is ${leadText()})`
            : noSplit
              ? ` (no lead strike under No-Split: an order carries the whole stack)`
              : ''
      }`;
    };
    // Capped (#130 trimmed the response before): the first NOT_ATTACKING_REASONS by id with their
    // reasons, the rest named.
    const told = left.slice(0, NOT_ATTACKING_REASONS);
    const rest = left.slice(NOT_ATTACKING_REASONS);
    if (left.length)
      rationale.push(
        `Not attacking ${left.length === 1 ? 'the enemy territory' : `${left.length} enemy territories`} next to mine: ${told
          .map((n) => `${label(n)} (player ${(state.get(n)!.owner as { playerId: number }).playerId}, ${state.get(n)!.armies} armies): ${reasonFor(n)}`)
          .join('; ')}${rest.length ? `; and ${rest.length} more: ${rest.map(label).join(', ')}` : ''}.`,
      );
  }
  return { sentAt };
}

/** The plan: the offence list, #172's final check, the retaliation warning, the exchanges and the ETAs. */
export function finishPlan(
  pc: PlanCtx,
  ps: PlanState,
  pass: TwoStepPass,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  expected: Expected,
  sentAt: (t: number) => number,
  slotOf: (m: PlannedMove) => MoveSlot,
  facesEnemy: (t: number) => boolean,
  exits: OpponentExits[],
): TurnPlan {
  const {
    g, s, income, foe, profile, goal, enemyDeploy, deployOf, territories: state, label, mine, armiesOf, unitsAt,
    defenceAt, guard, rates, toTake,
  } = pc;
  const { warnings, rationale, deployed, captured, combined, moves } = ps;
  const { reinforcementAt, borders, ownedBy, ownerOf, fogEdge } = threats;
  const { conceded, stayAt } = hd;
  const { offence, offenceSkip } = tgt;
  const { completed, nextIncome, atRisk, ifFall, reportRisk, frontier } = expected;
  const offenceList = [...offence.values()].map(({ bonusId, ...o }): OffenceEntry => {
    // A strike attack's cost is what the final orders send (a top-up can raise it).
    // The strike stack's own entry is final as built.
    if (o.kind === 'strike') return o;
    if (o.kind === 'strike-attack') return o.taken && captured.has(o.target) ? { ...o, cost: sentAt(o.target) || o.cost } : o;
    // A bonus broken this turn is a break made, whichever member fell and whatever path took it.
    const via = captured.has(o.target)
      ? o.target
      : bonusId !== undefined
        ? bonusTerritories(g, bonusId).filter((x) => captured.has(x)).sort(byNum)[0]
        : undefined;
    if (via !== undefined)
      return {
        ...o,
        target: via,
        cost: sentAt(via) || o.cost,
        taken: true,
        why: via === o.target ? o.why : `already broken by the capture of ${label(via)}: ${o.why}`,
      };
    return {
      ...o,
      taken: false,
      why: `not made — ${offenceSkip.get(o.target) ?? 'other uses of the income scored higher per army, or it could not be afforded'}: ${o.why}`,
    };
  });

  // #172: how each territory in between that a two-step hold judged ends — kept (not conceded)
  // and holding its own border with what the final orders leave there (its armies, deploys and
  // every transfer in, less every order out) — for settledPass to check the pass against.
  for (const v of pass.viaSeen.keys()) {
    const b = borders.get(v);
    const ends = moves.reduce((n, m) => n - (m.from === v ? m.armies : 0) + (m.kind === 'transfer' && m.to === v ? m.armies : 0), armiesOf(v) + (deployed.get(v) ?? 0));
    pass.viaFinal.set(v, !conceded.has(v) && b !== undefined && (toTake(ends + unitsAt(v)) ?? Infinity) > b.threat);
  }

  // ---- #201: a break without an elimination invites retaliation (FFA) ----
  // In an FFA a player whose bonus I break and leave standing aims what it has left at me; in a
  // 1v1 it does anyway, so no warning there.
  if (profile.format === 'ffa' && profile.opponents >= 2) {
    for (const [p, ts] of [...ownedBy].sort((a, b) => a[0] - b[0])) {
      if (!foe(p)) continue;
      const broken = g.map.bonuses
        .filter((b) => b.value > 0)
        .filter((b) => {
          const members = bonusTerritories(g, b.id);
          return members.length > 0 && members.every((t) => ownerOf(t) === p) && members.some((t) => captured.has(t));
        })
        .sort((a, b) => a.id - b.id);
      if (!broken.length) continue;
      const left = ts.filter((t) => !captured.has(t));
      if (!left.length && !fogEdge(p).length) continue;
      const armies = left.reduce((n, t) => n + armiesOf(t), 0);
      const value = broken.reduce((n, b) => n + b.value, 0);
      warnings.push(
        `Breaking player ${p}'s bonus${broken.length === 1 ? '' : 'es'} ${broken.map((b) => `${b.name} (+${b.value})`).join(', ')} without eliminating it invites retaliation (#201): it keeps ${left.length} territor${left.length === 1 ? 'y' : 'ies'} in view (${armies} armies)${fogEdge(p).length ? ' and more in the fog' : ''} and a ~${deployOf(p)} deploy, and loses +${value} a turn to me — in a free-for-all what it has left is likeliest aimed at whoever broke it.`,
      );
    }
  }

  // ---- #167: the exchange of each attack on a player ----
  const exchanges: ExchangeView[] = moves.flatMap((m): ExchangeView[] => {
    const st = state.get(m.to);
    if (m.kind !== 'attack' || st?.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) return [];
    const p = st.owner.playerId;
    const deploy = reinforcementAt(m.to);
    // Its stack can hit my source: what stays there against its movable armies plus its deploy.
    const take = toTake(stayAt(m.from) + unitsAt(m.from));
    const threatensSource = take !== null && take <= Math.max(0, st.armies - guard) + unitsAt(m.to) + deployOf(p);
    const x = classifyExchange({
      attackers: m.armies,
      defenders: defenceAt(m.to),
      deploy,
      income: Math.max(deploy, deployOf(p)),
      threatensSource,
      rates,
    });
    return [{ from: m.from, to: m.to, armies: m.armies, player: p, ...x }];
  });
  if (exchanges.length)
    rationale.push(
      `Exchange of attacks on players (#167): ${exchanges
        .map((e) => {
          const [now, est, whole] = e.cases as [ExchangeCase, ExchangeCase, ExchangeCase];
          const at = (c: ExchangeCase) => `${c.captures ? 'takes' : `${c.net >= 0 ? '+' : ''}${c.net}`} against ${c.defenders}`;
          return `${label(e.to)} from ${label(e.from)} with ${e.armies}: ${e.label} (${at(now)}, ${at(est)} after the estimated deploy, ${at(whole)} after the whole income)`;
        })
        .join('; ')}.`,
    );

  // ---- #179: turns to eliminate each visible opponent ----
  const eliminateEta: Record<number, EliminateEta> = {};
  {
    const dist = new Map<number, number>(mine.map((t) => [t, 0] as const));
    const queue = [...mine];
    for (let i = 0; i < queue.length; i++) {
      const x = queue[i]!;
      for (const n of neighborsOf(g, x))
        if (!dist.has(n)) {
          dist.set(n, dist.get(x)! + 1);
          queue.push(n);
        }
    }
    const movable = mine.reduce((n, x) => n + Math.max(0, armiesOf(x) - guard), 0);
    for (const [p, ts] of [...ownedBy].sort((a, b) => a[0] - b[0])) {
      const distance = Math.max(...ts.map((t) => dist.get(t) ?? Infinity));
      const base = ts.reduce((n, t) => n + (captureCost(defenceAt(t), s) ?? Infinity), 0);
      if (!Number.isFinite(distance) || !Number.isFinite(base)) continue;
      const need = (k: number) => base + (k * deployOf(p) > 0 ? (captureCost(k * deployOf(p), s) ?? Infinity) : 0);
      let turns: number | null = null;
      for (let k = Math.max(1, distance); k <= ETA_HORIZON && turns === null; k++) if (need(k) <= movable + income * k) turns = k;
      const armies = need(turns ?? Math.max(1, distance));
      eliminateEta[p] = { turns, atLeast: fogEdge(p).length > 0, distance, armies: Number.isFinite(armies) ? armies : null };
    }
  }

  return {
    goal,
    profile,
    // Deploys interleave like moves, and the order they land in shows the opponent my income and
    // the move order: next to a visible enemy first, in the back after (ascending id within each).
    deploys: [...deployed]
      .filter(([, n]) => n > 0)
      .sort((a, b) => Number(facesEnemy(b[0])) - Number(facesEnemy(a[0])) || a[0] - b[0])
      .map(([territoryId, armies]) => ({ territoryId, armies })),
    moves,
    expected: {
      captures: [...captured].sort(byNum),
      bonusesCompleted: completed,
      nextIncome,
      ...(reportRisk ? { nextIncomeIfConcededFall: ifFall, bonusesAtRisk: atRisk } : {}),
    },
    warnings,
    rationale,
    enemyDeploy,
    conceded: [...conceded].sort(byNum),
    cardAdvice: ps.cardAdvice,
    multiSourceCaptures: [...combined].sort(byNum),
    frontier,
    offence: offenceList,
    moveSlots: moves.map((m) => SLOT_NAMES[slotOf(m)]!),
    ...(exchanges.length ? { exchanges } : {}),
    ...(Object.keys(eliminateEta).length ? { eta: { eliminate: eliminateEta } } : {}),
    ...(exits.length ? { exits } : {}),
  };
}
