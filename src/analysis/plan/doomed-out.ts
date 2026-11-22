// #431: a doomed conceded stack attacks out or merges instead of standing. Rule 1b withdraws a conceded
// border's movable armies toward a border that holds; with no neighbour of mine that is not conceded they
// stayed ("… has nowhere to withdraw to: its N movable armies stay"), even when the expected attack (#59)
// takes the stack. Then they die where they stand, killing only the defensive share of the attacker. In a
// finished 3-player FFA (45684504) pocket stacks of ~1,000-1,800 were lost that way, most beside a
// territory they could have taken.
//
// So, after #272's free steps and before rule 1c and rule 1b: a conceded border of mine with no such
// neighbour, not my commander's, not kept by rule 1c, whose stack the expected attack takes, weighs its
// options by the exchange model (src/analysis/exchange.ts), each by the armies of mine still standing
// after the turn plus the enemy armies killed (a neutral's dead are no gain):
//   - stand: nothing of mine survives; the attacker loses the defensive share of the stack (at most the
//     expected attack);
//   - attack out with the whole movable stack into a neighbour it captures against the owner's estimated
//     deploy there (`classifyExchange`'s `estimated` case; never a truce's covered territory, one with a
//     special unit, a dropped member or one lowering income; a #240 repulsed one only at its sure size): the survivors live on;
//   - merge into a neighbouring conceded stack of mine that has nowhere to withdraw to either and that,
//     merged, holds against its own expected attack (a truce cap respected): every army lives on.
// The best option is taken when it beats standing (a merge first on a tie, then the larger capture). The
// unmovable rest (a covered exit's cover) stands either way. Not done: an attack that does not capture (its
// survivors come home to the doomed stack), and whether the territory a capture lands on is itself doomed.
import { classifyExchange } from '../exchange.js';
import { neighborsOf } from '../graph.js';
import { straightKills } from '../combat.js';
import type { Captures } from './captures.js';
import { keptByCompletion } from './conceded-out.js';
import type { Holds } from './holds.js';
import type { PlannedMove } from './shared.js';
import type { DeployBook } from './orders.js';
import { capRoom } from './relations.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Targets } from './targets.js';
import type { Threats } from './threats.js';
import { byNum } from './util.js';

const MERGES = 'merges a doomed conceded stack into one that holds (#431)';
const ATTACKS = 'a doomed conceded stack attacks out rather than stand (#431)';
/** A #431 order: like a withdrawal, it runs only while its border is mine (Order Priority protects it). */
export const isDoomedOut = (m: PlannedMove) => m.reason === MERGES || m.reason === ATTACKS;

type Option =
  | { kind: 'merge'; to: number; value: number }
  | { kind: 'attack'; to: number; value: number; losses: number; kills: number; deploy: number; enemy: boolean };

export function doomedConcededOut(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  hd: Holds,
  tgt: Targets,
  caps: Captures,
  threats: Pick<Threats, 'expectedAt' | 'reinforcementAt'>,
): void {
  const { g, foe, territories: state, label, mineSet, unitsAt, uncounted, defenceAt, toTake, chanceOf, costAt, myCommanders, noSplit, rates, deployOf } = pc;
  const { avail, captured, spared, rationale, warnings, moves, locked, incoming, survivorsAt, captureOrder, captureUndo } = ps;
  const { conceded, stayAt } = hd;
  const { coverOf, gainWith, orderOf } = book;
  const { targets } = tgt;
  const { expectedAt, reinforcementAt } = threats;
  if (!conceded.size) return;
  const def = rates.defensiveKillRate;
  /**
   * Rule 1b's test: no neighbour of mine that is not conceded, which a withdrawal could go to. Rule 1c
   * runs after this pass and keeps a conceded border whose bonus this turn's captures complete: rule 1b
   * then withdraws into it as usual, so such a neighbour counts as one to withdraw to.
   */
  const nowhere = (x: number) =>
    !neighborsOf(g, x).some((c) => mineSet.has(c) && (!conceded.has(c) || keptByCompletion(pc, ps, c)));
  /** What stands on my `x` against the expected attack, and whether that attack takes it. */
  const doom = (x: number, more = 0) => {
    const stack = stayAt(x) + unitsAt(x) + more;
    const take = toTake(stack);
    const expected = expectedAt(x);
    return { stack, take, expected, doomed: take !== null && expected > 0 && take <= expected };
  };
  for (const x of [...conceded].sort(byNum)) {
    if (!mineSet.has(x) || myCommanders.has(x) || keptByCompletion(pc, ps, x) || !nowhere(x)) continue;
    // No-Split (#124): a covered exit sends nothing, and a territory with an order sends no other.
    if (noSplit && (coverOf(x) > 0 || orderOf(x))) continue;
    const n = (avail.get(x) ?? 0) - (noSplit ? 0 : coverOf(x));
    if (n <= 0) continue;
    const d = doom(x);
    if (!d.doomed) continue;
    const killsBy = (armies: number) => Math.min(d.expected, straightKills(Math.max(0, armies), def));
    // The rest that cannot move stands and dies in every option, killing its share.
    const rest = killsBy(d.stack - n);
    const stand = killsBy(d.stack);
    const options: Option[] = [];
    for (const t of neighborsOf(g, x)) {
      if (mineSet.has(t)) {
        // A merge: into another pocket stack (it keeps its armies too) that then holds.
        if (!conceded.has(t) || !nowhere(t) || capRoom(pc, ps, t) < n) continue;
        if (doom(t, n).doomed) continue;
        options.push({ kind: 'merge', to: t, value: n + rest });
        continue;
      }
      if (captured.has(t) || spared.has(t) || pc.truce.noTarget(t) || tgt.droppedMembers.has(t)) continue;
      const st = state.get(t);
      if (!st || st.armies === null || uncounted(t) || unitsAt(t) > 0) continue;
      const owner = st.owner;
      const enemy = owner.kind === 'player';
      if (owner.kind === 'player' ? !foe(owner.playerId) : owner.kind !== 'neutral') continue;
      if (gainWith([t]) < 0) continue;
      const deploy = enemy ? reinforcementAt(t) : 0;
      const income = owner.kind === 'player' ? Math.max(deploy, deployOf(owner.playerId)) : 0;
      const ex = classifyExchange({ attackers: n, defenders: defenceAt(t), deploy, income, rates });
      const e = ex.cases[1]!;
      // The planner's own sizing (luck, win chance) must agree that the whole stack takes it.
      const cost = costAt(t, defenceAt(t) + deploy);
      // A #240 repulsed territory is attacked at its sure size or not at all.
      if (!e.captures || cost === null || Math.max(cost, tgt.repulsed.get(t)?.cost ?? 0) > n) continue;
      options.push({ kind: 'attack', to: t, value: n - e.losses + (enemy ? e.kills : 0) + rest, losses: e.losses, kills: e.kills, deploy, enemy });
    }
    options.sort((a, b) => b.value - a.value || Number(b.kind === 'merge') - Number(a.kind === 'merge') || a.to - b.to);
    const best = options[0];
    if (!best || best.value <= stand) continue;
    const head = `${label(x)} is doomed (#431): conceded, nowhere to withdraw to, and its ${d.stack} need ${d.take} to take against the expected ~${d.expected} attack.`;
    avail.set(x, avail.get(x)! - n);
    locked.add(x);
    // Like a withdrawal (rule 1b) or rule 4e's attack out, the order only runs while the border is mine.
    warnings.push(
      `The ${best.kind === 'merge' ? 'merge' : 'attack'} out of ${label(x)} only executes if ${label(x)} is still mine when the order runs; play Order Priority so it goes first.`,
    );
    ps.cardAdvice = 'order-priority';
    if (best.kind === 'merge') {
      locked.add(best.to);
      incoming.set(best.to, (incoming.get(best.to) ?? 0) + n);
      // Like a withdrawal it only runs while the border is still mine: it goes first.
      moves.unshift({ from: x, to: best.to, armies: n, kind: 'transfer', reason: MERGES });
      rationale.push(
        `${head} Merge its ${n} into ${label(best.to)}, which then holds (${doom(best.to).stack} need ${doom(best.to).take} to take against ~${expectedAt(best.to)}), rather than stand and kill ~${stand}.`,
      );
      continue;
    }
    const t = best.to;
    captured.add(t);
    survivorsAt.set(t, n - straightKills(defenceAt(t), def));
    captureOrder.push(t);
    captureUndo.set(t, () => avail.set(x, avail.get(x)! + n));
    if (!targets.has(t)) targets.set(t, { id: t, cost: costAt(t) ?? n, enemy: best.enemy, sources: [x] });
    if (best.deploy > 0) caps.worstCase.set(t, defenceAt(t) + best.deploy);
    moves.push({ from: x, to: t, armies: n, kind: 'attack', reason: ATTACKS, winChance: chanceOf(n, defenceAt(t)) });
    rationale.push(
      `${head} Attack ${label(t)} with ${noSplit ? 'its whole stack' : `all ${n}`}: it holds ${defenceAt(t)}${best.deploy ? ` (+${best.deploy} if its owner deploys there first)` : ''}, so ~${n - best.losses} survive${best.enemy ? ` and ~${best.kills} of the enemy die` : ''}, against ~${stand} killed and none left by standing.`,
    );
  }
}
