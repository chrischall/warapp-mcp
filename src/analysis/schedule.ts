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
 * The moves in the order to send them: each in its slot (earliest first; ties keep decision
 * order), never ahead of a move it depends on (see {@link dependsOn}). Stable and deterministic.
 */
export function scheduleMoves<M extends SchedulableMove>(moves: readonly M[], slotOf: (m: M, index: number) => MoveSlot): M[] {
  const slot = moves.map((m, i) => slotOf(m, i));
  const deps = moves.map((m, j) => moves.slice(0, j).flatMap((p, i) => (dependsOn(p, m) ? [i] : [])));
  const done = new Set<number>();
  const out: M[] = [];
  while (out.length < moves.length) {
    let pick = -1;
    for (let j = 0; j < moves.length; j++) {
      if (done.has(j) || !deps[j]!.every((i) => done.has(i))) continue;
      if (pick < 0 || slot[j]! < slot[pick]!) pick = j;
    }
    done.add(pick);
    out.push(moves[pick]!);
  }
  return out;
}
