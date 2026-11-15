// Rule 4h, the army cap prices idle armies (#253): war.app pays min(income, round(cap × income) −
// my armies on the board), so when my armies after this turn plus next income exceed the cap, every
// army above it costs an army of next income. A capture whose expected losses are below that cost
// is free: it is taken from idle armies first (the deploys still left, before the leftover's margins,
// make up a shortfall: deployed or not, they count against the cap), every hold respected. Rule 4e's
// army-cap fallback (#104) runs only when the plan captures nothing; this rule runs whatever else the
// plan captures (live, a plan that completed a bonus elsewhere parked 54 armies beside two enemy
// territories holding 0 and 1). planPass runs it after rules 4e and 4g.
import { straightKills } from '../combat.js';
import { neighborsOf } from '../graph.js';
import { armyCapIncome, type ArmyCapIncome } from '../player.js';
import type { Captures } from './captures.js';
import type { Holds } from './holds.js';
import type { DeployBook } from './orders.js';
import { standStillKit, type Cand } from './stand-still.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Targets } from './targets.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';

/** A player's territory is a candidate only while it holds at most this many armies ("0 or 1"). */
export const CAP_SPEND_ENEMY_MAX = 1;

/** The army cap's arithmetic for next turn, after the plan as it stands. */
interface NextCap {
  /** My armies after this turn: on the board now, plus this turn's income, less what the captures lose. */
  armies: number;
  /** Next turn's income before the cap (this turn's, plus the plan's gains; card armies out). */
  next: ArmyCapIncome;
  /** Next income the cap would take: `next.uncapped − next.received`. */
  eaten: number;
}

/** "my ~A armies after this turn reach the army cap next turn (C× income N = L): ~E of next turn's income N would be lost". */
function capText(c: NextCap): string {
  return `my ~${c.armies} armies after this turn reach the army cap next turn (${c.next.cap}× income ${c.next.uncapped} = ${c.next.limit}): ~${c.eaten} of next turn's income ${c.next.uncapped} would be lost`;
}

export function spendUnderCap(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  threats: Threats,
  hd: Holds,
  tgt: Targets,
  caps: Captures,
): void {
  const { g, s, goal, foe, income, cardArmies, earnedIncome, territories: state, label, mine, mineSet, armiesOf, unitsAt, uncounted, rates, incomeGain } = pc;
  const { warnings, rationale, captured, spared, moves, avail } = ps;
  const { gainWith, heldNow } = book;
  const { conceded } = hd;
  const { targets } = tgt;
  const { defendersSeen } = caps;
  const cap = pc.incomeCap?.cap ?? s.armyCap ?? null;
  if (goal === 'complete-bonus' || cap === null || !(cap > 0)) return;
  const start = pc.incomeCap?.armies ?? mine.reduce((n, id) => n + armiesOf(id), 0);
  /** Next income before the cap, card armies out. */
  const baseIncome = Math.max(0, earnedIncome - cardArmies);
  /** What the plan's attacks are expected to lose (the defenders' kills on the armies sent). */
  const lostInPlan = () => {
    let lost = 0;
    for (const t of captured) {
      const sent = moves.filter((m) => m.kind === 'attack' && m.to === t).reduce((n, m) => n + m.armies, 0);
      lost += Math.min(sent, straightKills(defendersSeen(t), rates.defensiveKillRate));
    }
    return lost;
  };
  const nextCap = (): NextCap => {
    const armies = Math.max(0, start + income - lostInPlan());
    const next = armyCapIncome(Math.max(0, baseIncome + incomeGain(heldNow())), cap, armies)!;
    return { armies, next, eaten: next.uncapped - next.received };
  };
  const first = nextCap();
  if (first.eaten <= 0) return;

  /** The expected loss of a capture of `t`: the defenders' kills on its attackers. */
  const lossAt = (t: number) => straightKills(defendersSeen(t), rates.defensiveKillRate);
  // Candidates: the neutral targets (rule 2's: next to a territory I held at the start), and every
  // visible player's territory next to mine holding at most CAP_SPEND_ENEMY_MAX armies (no commander,
  // no truce, no teammate; `expand` attacks no player) — none lowering income.
  const added: number[] = [];
  const cands: number[] = [];
  for (const t of [...g.territoryById.keys()].sort(byNum)) {
    if (mineSet.has(t) || captured.has(t) || spared.has(t) || pc.truce.noTarget(t)) continue;
    const st = state.get(t);
    if (!st || st.armies === null || uncounted(t) || unitsAt(t) > 0) continue;
    const tg = targets.get(t);
    if (st.owner.kind === 'player') {
      if (goal === 'expand' || !foe(st.owner.playerId) || st.armies > CAP_SPEND_ENEMY_MAX) continue;
      if (!tg) {
        const sources = neighborsOf(g, t).filter((n) => mineSet.has(n));
        const cost = pc.costAt(t);
        if (!sources.length || cost === null) continue;
        targets.set(t, { id: t, cost, enemy: true, sources });
        added.push(t);
      }
    } else if (!tg || tg.enemy) continue;
    if (gainWith([t]) < 0) continue;
    cands.push(t);
  }
  cands.sort(
    (a, b) =>
      lossAt(a) - lossAt(b) ||
      Number(!targets.get(a)!.enemy) - Number(!targets.get(b)!.enemy) ||
      gainWith([b]) - gainWith([a]) ||
      targets.get(a)!.cost - targets.get(b)!.cost ||
      a - b,
  );
  const kit = standStillKit(pc, ps, book, threats, hd, tgt, caps);
  const refused: string[] = [];
  /** A candidate not taken, and why (a clause after its name); the offence report repeats it (ps.capRefused). */
  const refuse = (t: number, why: string) => {
    refused.push(`${label(t)} ${why}`);
    ps.capRefused.set(t, why);
  };
  const taken: number[] = [];
  ps.evenTradesOnly = true;
  try {
    for (const [i, t] of cands.entries()) {
      const now = nextCap();
      if (now.eaten <= 0) break;
      const loss = lossAt(t);
      if (loss >= now.eaten) {
        // Ranked by loss, and the stake only falls: every later candidate loses as much. One clause for all.
        const rest = cands.slice(i + 1);
        const tail = `more than the ~${now.eaten} of next income the army cap would take`;
        ps.capRefused.set(t, `loses ~${loss}, ${tail}`);
        for (const x of rest) ps.capRefused.set(x, `loses ~${lossAt(x)}, ${tail}`);
        refused.push(
          rest.length
            ? `${label(t)} and ${rest.length} more ${rest.length === 1 ? 'candidate' : 'candidates'} lose ~${loss} or more, ${tail}`
            : `${label(t)} loses ~${loss}, ${tail}`,
        );
        break;
      }
      const reach = kit.reachOf(t);
      const cand: Cand = { ...reach, t, cost: targets.get(t)!.cost };
      if (reach.from === undefined) {
        refuse(t, kit.failText(cand, undefined));
        continue;
      }
      if (conceded.has(reach.from)) {
        refuse(t, `could be taken only from conceded ${label(reach.from)}, whose armies stay or withdraw`);
        continue;
      }
      const before = ps.budget;
      const reason = `the army cap: ${capText(now)}, and this capture loses ~${loss} (#253, rule 4h)`;
      const undo = kit.attempt(cand, reason);
      if (!undo) {
        const r = ps.refusal;
        refuse(t, kit.failText(cand, r));
        continue;
      }
      // Every source keeps what holds its border (deploys still free may top one up).
      const short = kit.holdLeftShort(t);
      if (short) {
        undo();
        refuse(t, `is not taken: attacking it would leave ${label(short.from)} unable to hold its border (${kit.holdText(short)})`);
        continue;
      }
      // Its survivors stay on the board (above the cap they cost nothing either): named, not priced.
      const exposed = kit.exposure(t);
      taken.push(t);
      const paid = before - ps.budget;
      rationale.push(
        `Take ${label(t)} for the army cap (rule 4h, #253): ${capText(now)}; it loses ~${loss}${
          exposed ? ` (and its ${exposed.survivors} may fall next turn)` : ''
        }, below that, ${paid > 0 ? `paid from idle armies and ${paid} of the deploys left` : 'paid from idle armies'}.`,
      );
    }
  } finally {
    ps.evenTradesOnly = false;
  }
  for (const t of added) if (!captured.has(t)) targets.delete(t);
  if (refused.length) rationale.push(`Army cap (rule 4h, #253), not taken: ${refused.join('; ')}.`);
  const after = nextCap();
  if (after.eaten > 0) {
    const idle = mine
      .map((x) => ({ x, n: avail.get(x) ?? 0 }))
      .filter((e) => e.n > 0)
      .sort((a, b) => b.n - a.n || a.x - b.x)[0];
    warnings.push(
      `Army cap: ${capText(after)} unless armies are spent${idle ? ` (the largest idle stack is ${idle.n} on ${label(idle.x)})` : ''}${
        taken.length ? `; the plan already spends idle armies on ${taken.map(label).join(', ')}` : ''
      }.`,
    );
  }
}
