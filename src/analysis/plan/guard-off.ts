// #276: what the planner does only with One Army Must Stand Guard off (never with it on, never under
// No-Split, where an order sends the whole stack). Every army may move, so any territory can stand at
// 0, and a stack that breaks a border can split into single armies that each take an empty territory.
//   (1) A second line (`secondLineOf`, read by the deploy book; `fillSecondLine` before the leftover):
//       an interior member of a bonus I hold in full (every neighbour mine or a teammate's, never my
//       commander's territory) within two moves of a visible enemy stack of at least
//       SECOND_LINE_STACK_INCOMES × my income keeps a garrison one army cannot take
//       (`garrisonSize`: one at the usual kill rates). What stands there is kept (rule 6 moves only the
//       rest); one short of it gets the rest deployed from what the holds and captures leave, before
//       the leftover's comfort margins; one the income cannot reach is named in a warning. #275's
//       breach cost (a hollow interior priced) is a separate rule; this one only keeps the garrison.
//   (2) A raid one step deeper (`guardOffRaids`): an enemy territory in view at 0 (no special unit),
//       not beside me, whose owner holds a positive bonus it is in, behind a territory beside me that
//       stands at 0 (a player's or neutral, no special unit): RAID_ARMIES take the near one — nothing
//       defends it, so none are lost — one to stay as its garrison and one to take the far one next
//       turn, when #165's one-army break fires if it still stands at 0. The planner plans no
//       Multi-Attack chain, so the far one is never attacked this turn.
//   (3) A free retake (`guardOffRaids`): an enemy territory beside me at 0 (no special unit) that the
//       previous board showed mine — its stack took it and moved on — is taken back with one army.
// Both (2) and (3) run right after #165's breaks (after the holds, before any other capture, every
// goal), funded as those are: from the neighbour with the most to spare beyond what holds it once the
// target falls, else deployed on a neighbour not conceded; never one lowering income, a truce's
// covered territory or one my attacks failed on (#240). Sized for the board as it stands: if the
// owner deploys there first, the raid or the retake is lost.
import type { BoardState } from '../../board.js';
import { armiesToTake, type KillRates } from '../combat.js';
import { neighborsOf } from '../graph.js';
import type { DeployBook } from './orders.js';
import type { Holds } from './holds.js';
import type { PlanCtx, PlanState } from './state.js';
import type { Targets } from './targets.js';
import { byNum } from './util.js';

/** #276: a stack of at least this many times my income within two moves calls for a second line. */
export const SECOND_LINE_STACK_INCOMES = 1;
/** #276: the armies a raid one step deeper sends: one stays on the near territory, one goes on next turn. */
export const RAID_ARMIES = 2;
/** The most a second-line garrison is ever sized at (a kill rate letting one army take more is not a game). */
const MAX_GARRISON = 3;

/** #276: the fewest defenders one attacking army cannot take, luck-free (1 at 60/70). */
export function garrisonSize(rates: KillRates): number {
  for (let d = 1; d <= MAX_GARRISON; d++) {
    const take = armiesToTake(d, rates);
    if (take === null || take > 1) return d;
  }
  return MAX_GARRISON;
}

/** One territory of the second line: the armies it keeps, and why. */
export interface SecondLineEntry {
  /** The garrison one army cannot take. */
  size: number;
  /** The biggest enemy stack within two moves. */
  stack: { id: number; armies: number; player: number };
  /** The held bonus it completes (the most valuable). */
  bonusId: number;
}

/**
 * #276 (1): the interior members of my held bonuses within two moves of an enemy stack of at least
 * {@link SECOND_LINE_STACK_INCOMES} × my income, with the garrison each keeps. Empty with the guard
 * on, under No-Split, or with no such stack. Pure.
 */
export function secondLineOf(pc: PlanCtx): Map<number, SecondLineEntry> {
  const { g, territories: state, mine, mineSet, myCommanders, foe, allies, guard, noSplit, armiesOf, unitsAt, income, toTake } = pc;
  const out = new Map<number, SecondLineEntry>();
  if (guard || noSplit) return out;
  const bar = Math.max(1, SECOND_LINE_STACK_INCOMES * income);
  const stacks = [...state.values()]
    .filter((t) => t.owner.kind === 'player' && foe(t.owner.playerId) && t.armies !== null)
    .map((t) => ({ id: t.territoryId, armies: armiesOf(t.territoryId) + unitsAt(t.territoryId), player: (t.owner as { playerId: number }).playerId }))
    .filter((x) => x.armies >= bar);
  if (!stacks.length) return out;
  const friendly = (id: number) => {
    const o = state.get(id)?.owner;
    return mineSet.has(id) || (o?.kind === 'player' && allies.has(o.playerId));
  };
  const held = [...g.bonusById.values()]
    .filter((b) => b.value > 0 && b.territoryIds.length > 0 && b.territoryIds.every((x) => mineSet.has(x)))
    .sort((a, b) => b.value - a.value || a.id - b.id);
  let size: number | null = null;
  for (let d = 1; d <= MAX_GARRISON && size === null; d++) {
    const take = toTake(d);
    if (take === null || take > 1) size = d;
  }
  const garrison = size ?? MAX_GARRISON;
  for (const id of [...mine].sort(byNum)) {
    if (myCommanders.has(id)) continue;
    const bonus = held.find((b) => b.territoryIds.includes(id));
    if (!bonus) continue;
    const near = neighborsOf(g, id);
    if (!near.every(friendly)) continue;
    const within = new Set([...near, ...near.flatMap((n) => neighborsOf(g, n))]);
    const stack = stacks
      .filter((s) => within.has(s.id))
      .sort((a, b) => b.armies - a.armies || a.id - b.id)[0];
    if (stack) out.set(id, { size: garrison, stack, bonusId: bonus.id });
  }
  return out;
}

/**
 * #276 (1): pay the second line's shortfall (the garrison less what stands there) from what the
 * holds and captures left, before the leftover deploy; say what it keeps, and warn on what the
 * income cannot reach.
 */
export function fillSecondLine(pc: PlanCtx, ps: PlanState, book: DeployBook): void {
  const { label, bonusName, reserve } = pc;
  const { rationale, warnings, avail } = ps;
  const { secondLine, secondLineKept, deploy, roomAt } = book;
  if (!secondLine.size) return;
  const paid: number[] = [];
  const short: number[] = [];
  for (const [id, e] of [...secondLine].sort((a, b) => a[0] - b[0])) {
    const owed = e.size - secondLineKept.get(id)!;
    if (owed <= 0) continue;
    const k = Math.min(owed, Math.max(0, ps.budget - reserve), roomAt(id));
    if (k > 0) {
      deploy(id, k);
      // The deployed armies join the garrison: they stay, as the guard would.
      avail.set(id, avail.get(id)! - k);
      secondLineKept.set(id, secondLineKept.get(id)! + k);
      paid.push(id);
    }
    if (k < owed) short.push(id);
  }
  const kept = [...secondLine.keys()].filter((id) => secondLineKept.get(id)! > 0).sort(byNum);
  const bonuses = [...new Set([...secondLine.values()].map((e) => e.bonusId))].sort(byNum);
  const big = [...secondLine.values()].sort((a, b) => b.stack.armies - a.stack.armies || a.stack.id - b.stack.id)[0]!.stack;
  if (kept.length)
    rationale.push(
      `Second line (#276): One Army Must Stand Guard is off, and player ${big.player}'s ${big.armies} on ${label(big.id)} can reach the interior of ${bonuses.map(bonusName).join(', ')} within two moves and split into single armies there, so ${kept
        .map((id) => `${label(id)} keeps ${secondLineKept.get(id)!}`)
        .join(', ')} (one army cannot take ${kept.length === 1 ? 'it' : 'them'})${paid.length ? `; deployed on ${paid.map(label).join(', ')}, which stood short` : ''}.`,
    );
  if (short.length)
    warnings.push(
      `Second line (#276): ${short.map(label).join(', ')} ${short.length === 1 ? 'stands' : 'stand'} below the garrison one army cannot take, inside a held bonus within two moves of player ${big.player}'s ${big.armies}, and this turn's deploy cannot reach ${short.length === 1 ? 'it' : 'them'}: a single raider past the border takes ${short.length === 1 ? 'it' : 'them'}.`,
    );
}

/** #276 (2), (3): raids one step deeper and free retakes, after #165's breaks. */
export function guardOffRaids(
  pc: PlanCtx,
  ps: PlanState,
  book: DeployBook,
  hd: Holds,
  tgt: Targets,
  previousBoard: BoardState | undefined,
): void {
  const { g, me, territories: state, reserve, label, bonusName, mineSet, unitsAt, uncounted, guard, chanceOf, noSplit, foe } = pc;
  const { rationale, avail, spared, captured, moves, survivorsAt, captureOrder, captureUndo } = ps;
  const { coverOf, gainWith, deploy, roomAt } = book;
  const { conceded, keepFor, twoStepKeep } = hd;
  const { targets, repulsed } = tgt;
  if (guard || noSplit) return;
  const enemyOf = (id: number) => {
    const o = state.get(id)?.owner;
    return o?.kind === 'player' && foe(o.playerId) ? o.playerId : undefined;
  };
  /** In view at 0 with no special unit: one army takes it, losing none. */
  const empty = (id: number) => {
    const t = state.get(id);
    return !!t && t.armies === 0 && !t.specialUnits?.length && (t.owner.kind === 'neutral' || enemyOf(id) !== undefined);
  };
  /** Free to take now: not taken this turn, nothing the plan keeps off, never one lowering income. */
  const takeable = (n: number) =>
    !captured.has(n) && !spared.has(n) && !uncounted(n) && unitsAt(n) === 0 && gainWith([n]) >= 0 && !pc.truce.noTarget(n) && !repulsed.has(n);
  /** One attack of `armies` on `n` from the neighbour with the most to spare, else deployed. */
  const attack = (n: number, armies: number, reason: string, head: string): boolean => {
    const near = neighborsOf(g, n).filter((x) => mineSet.has(x));
    const spareOf = (x: number) =>
      Math.max(0, avail.get(x)! - Math.max(keepFor(x, (y) => y === n), twoStepKeep(x, (y) => y === n), coverOf(x)));
    let src = near
      .map((x) => ({ x, spare: spareOf(x) }))
      .filter((o) => o.spare >= armies)
      .sort((a, b) => b.spare - a.spare || a.x - b.x)[0]?.x;
    let bought = 0;
    if (src === undefined && ps.budget - reserve >= armies) {
      src = near
        .filter((x) => !conceded.has(x) && avail.get(x)! >= 0 && roomAt(x) >= armies)
        .sort((a, b) => avail.get(b)! - avail.get(a)! || a - b)[0];
      if (src !== undefined) {
        deploy(src, armies);
        bought = armies;
      }
    }
    if (src === undefined) return false;
    const from = src;
    avail.set(from, avail.get(from)! - armies);
    captured.add(n);
    survivorsAt.set(n, armies);
    captureOrder.push(n);
    captureUndo.set(n, () => avail.set(from, avail.get(from)! + armies));
    if (!targets.has(n)) targets.set(n, { id: n, cost: armies, enemy: enemyOf(n) !== undefined, sources: near });
    moves.push({ from, to: n, armies, kind: 'attack', reason, winChance: chanceOf(armies, 0) });
    rationale.push(`${head} from ${label(from)} with ${armies}${bought ? ` (deploy ${bought} there)` : ''}: ${reason}.`);
    return true;
  };

  // (3) Free retakes: an enemy territory beside me at 0 that was mine on the previous board.
  if (previousBoard) {
    const before = new Map(previousBoard.territories.map((t) => [t.territoryId, t]));
    const retakes = [...state.values()]
      .map((t) => t.territoryId)
      .filter((id) => {
        const was = before.get(id)?.owner;
        return (
          was?.kind === 'player' &&
          was.playerId === me &&
          enemyOf(id) !== undefined &&
          empty(id) &&
          neighborsOf(g, id).some((x) => mineSet.has(x))
        );
      })
      .sort(byNum);
    for (const n of retakes) {
      if (!takeable(n)) continue;
      const reason = `One Army Must Stand Guard is off and player ${enemyOf(n)!}'s stack left ${label(n)}, taken from me, at 0: one army takes it back unless it deploys there first (#276)`;
      attack(n, 1, reason, `Retake ${label(n)}`);
    }
  }

  // (2) Raids one step deeper: an empty enemy territory not beside me whose loss breaks its owner's
  // bonus, behind an empty territory beside me.
  const breaksOf = (id: number) => {
    const owner = enemyOf(id);
    if (owner === undefined) return undefined;
    return [...g.bonusById.values()]
      .filter(
        (b) =>
          b.value > 0 &&
          b.territoryIds.includes(id) &&
          b.territoryIds.every((x) => {
            const o = state.get(x)?.owner;
            return o?.kind === 'player' && o.playerId === owner;
          }),
      )
      .sort((a, b) => b.value - a.value || a.id - b.id)[0];
  };
  const deep = [...state.values()]
    .map((t) => t.territoryId)
    .filter((id) => empty(id) && enemyOf(id) !== undefined && !captured.has(id) && !neighborsOf(g, id).some((x) => mineSet.has(x)))
    .map((id) => ({ id, bonus: breaksOf(id) }))
    .filter((x): x is { id: number; bonus: NonNullable<ReturnType<typeof breaksOf>> } => x.bonus !== undefined)
    .sort((a, b) => b.bonus.value - a.bonus.value || a.id - b.id);
  for (const far of deep) {
    if (pc.truce.noTarget(far.id)) continue;
    const step = neighborsOf(g, far.id)
      .filter((n) => empty(n) && neighborsOf(g, n).some((x) => mineSet.has(x)) && takeable(n))
      .sort(byNum)[0];
    if (step === undefined) continue;
    const reason = `a raid: One Army Must Stand Guard is off and ${label(step)} stands at 0, behind it ${label(far.id)} too, and taking ${label(far.id)} breaks player ${enemyOf(far.id)!}'s bonus ${bonusName(far.bonus.id)} (+${far.bonus.value}); one army stays on ${label(step)}, one takes ${label(far.id)} next turn if it still stands at 0 (#276)`;
    attack(step, RAID_ARMIES, reason, `Raid ${label(step)}`);
  }
}
