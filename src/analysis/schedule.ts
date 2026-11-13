// Move scheduling within one turn (#127). Pure; no I/O.
//
// war.app runs both players' moves zigzag: the first mover's 1st order, the second mover's 1st
// and 2nd, the first mover's 2nd and 3rd, and so on. So where an order sits in my list decides
// what it meets: an early order runs before most of the opponent's, a late one after them.

/** Where a move belongs in the list, earliest first. */
export const MoveSlot = {
  /** The one order Order Priority puts ahead of the opponent's first. */
  Protected: 0,
  /** Withdrawals (they only run while the border is mine) and transfers into a border the enemy can break. */
  Early: 1,
  /** Attacks that capture even if the owner's whole deploy lands there first; contested neutrals whose survivors hold. */
  Sure: 2,
  /** Uncontested neutral captures and interior transfers: filler. */
  Filler: 3,
  /**
   * Attacks into a stack that can fight back, and contested neutrals taken at their exact cost:
   * last, so they meet what is left once the opponent's own attacks have run (a defender kills
   * 70% per army, an attacker 60%: the side that attacks second fights survivors).
   */
  Last: 4,
} as const;
export type MoveSlot = (typeof MoveSlot)[keyof typeof MoveSlot];

export interface SchedulableMove {
  from: number;
  to: number;
  kind: 'attack' | 'transfer';
}

/**
 * Whether move `j` must stay after move `i` (i listed before j in decision order):
 * - attacks on one target keep their order (softeners before the finisher);
 * - a move out of a territory another move went into earlier (a capture, a transfer) stays
 *   after it (its armies may be the ones moving on);
 * - a transfer into a territory captured this turn stays after the capture.
 */
function dependsOn(i: SchedulableMove, j: SchedulableMove): boolean {
  if (i.kind === 'attack' && j.kind === 'attack' && i.to === j.to) return true;
  if (j.from === i.to) return true;
  return i.kind === 'attack' && j.kind === 'transfer' && j.to === i.to;
}

/**
 * The moves in the order to send them: each in its slot (earliest first), within a slot the
 * higher `rankOf` first (ties keep decision order), never ahead of a move it depends on (see
 * {@link dependsOn}). Stable and deterministic.
 */
export function scheduleMoves<M extends SchedulableMove>(
  moves: readonly M[],
  slotOf: (m: M, index: number) => MoveSlot,
  rankOf: (m: M) => number = () => 0,
): M[] {
  const slot = moves.map((m, i) => slotOf(m, i));
  const rank = moves.map((m) => rankOf(m));
  const deps = moves.map((m, j) => moves.slice(0, j).flatMap((p, i) => (dependsOn(p, m) ? [i] : [])));
  const done = new Set<number>();
  const out: M[] = [];
  while (out.length < moves.length) {
    let pick = -1;
    for (let j = 0; j < moves.length; j++) {
      if (done.has(j) || !deps[j]!.every((i) => done.has(i))) continue;
      if (pick < 0 || slot[j]! < slot[pick]! || (slot[j] === slot[pick] && rank[j]! > rank[pick]!)) pick = j;
    }
    done.add(pick);
    out.push(moves[pick]!);
  }
  return out;
}

/** My place in a two-player turn: the first mover, the second, or not known. */
export type MoverPosition = 'first' | 'second' | 'unknown';

/**
 * How many of the opponent's orders run before my `k`-th (1-based) in a two-player turn. The
 * interleave is F S S F F S S …: the first mover's k-th runs after 2·floor(k/2) of the other's,
 * the second mover's after 2·ceil(k/2) − 1. (Once the opponent's list runs out, mine run in a row.)
 */
export function opponentOrdersBefore(k: number, mover: 'first' | 'second'): number {
  return mover === 'first' ? 2 * Math.floor(k / 2) : 2 * Math.ceil(k / 2) - 1;
}

/**
 * The first index (1-based) of mine that runs after all `n` of the opponent's orders: the
 * smallest even number ≥ n moving first, the smallest odd number ≥ n moving second, n + 1 when
 * not known (it must hold either way). Never below 1.
 */
export function indexAfterAll(n: number, mover: MoverPosition): number {
  if (mover === 'unknown') return n + 1;
  const parity = mover === 'first' ? 0 : 1;
  const k = n % 2 === parity ? n : n + 1;
  return Math.max(1, k);
}
