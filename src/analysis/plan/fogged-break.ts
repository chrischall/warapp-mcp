// #593 (items 2 and 5a): in a 1v1, an opponent's bonus behind the fog is a break candidate, and an opening
// strike on a bonus it is one territory short of is a denial, each sized for a partial deploy.
//
// `breakableBonuses` (plan/siege.ts) breaks a bonus only with every member in view, or when the tracker
// infers it (#72). On 16 finished 1v1s that left 184 of 187 opponent-turns holding a bonus beside mine
// unbroken: at least one member was fogged. Here, in a 1v1 only:
//   - probable: a positive bonus no member of which is shown with another owner (the "could hold" reading
//     of `couldHoldBonusPools`), at least one member fogged (owner or armies hidden), and a member in view
//     its, with its armies, beside my land;
//   - one short (turns OPENING_STRIKE_FIRST to OPENING_STRIKE_LAST only, item 5a): the same, except that
//     exactly one member is shown neutral — the opponent is about to complete it. Its worth is
//     ONE_SHORT_WEIGHT × the bonus.
// The planner (rule 4a) scores each like a break of a visible bonus and sizes its capture for the defenders
// plus a partial deploy (`partialDeploy`): the opponent's deploy estimate split over the territories of its
// in view beside my land. Pure.
import type { TerritoryState } from '../../board.js';
import { bonusTerritories } from '../bonuses.js';
import { neighborsOf, type MapGraph } from '../graph.js';
import { ownerShown, visibleState } from './shared.js';
import type { Breakable } from './siege.js';

/** A one-short denial (item 5a) is worth this share of the bonus: the opponent does not earn it yet. */
export const ONE_SHORT_WEIGHT = 0.5;
/** Item 5a's opening: the turns a one-short denial is tried on. */
export const OPENING_STRIKE_FIRST = 2;
export const OPENING_STRIKE_LAST = 4;

export interface FoggedBreak extends Breakable {
  /** Why it is probably held (always set: the planner's "probable" wording). */
  probable: string;
  /** Its members the opponent holds in view, armies shown, beside my land (the break's options). */
  members: number[];
  /** Its members the board does not show in full (owner or armies hidden). */
  fogged: number;
  /** Item 5a: the one member shown neutral (the bonus is one territory short of complete). */
  shortOf?: number;
}

/**
 * The opponent bonuses a 1v1 may break behind the fog, and (on the opening turns) the ones it is one
 * territory short of. `known`: the bonuses already breakable (visible, or the tracker's #72 inference),
 * which are left out. Sorted by bonus id.
 */
export function foggedBreakables(
  g: MapGraph,
  state: ReadonlyMap<number, TerritoryState>,
  foe: (p: number) => boolean,
  mine: ReadonlySet<number>,
  known: ReadonlySet<number>,
  turn: number | null,
): FoggedBreak[] {
  const opening = turn !== null && turn >= OPENING_STRIKE_FIRST && turn <= OPENING_STRIKE_LAST;
  const out: FoggedBreak[] = [];
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    if (b.value <= 0 || known.has(b.id)) continue;
    const ts = bonusTerritories(g, b.id);
    if (!ts.length) continue;
    const players = new Set<number>();
    const others: number[] = [];
    let fogged = 0;
    for (const t of ts) {
      const st = state.get(t);
      const shown = ownerShown(st);
      if (!shown) {
        fogged++;
        continue;
      }
      if (shown.owner.kind === 'player' && foe(shown.owner.playerId)) {
        players.add(shown.owner.playerId);
        if (!visibleState(st)) fogged++;
      } else others.push(t);
    }
    if (players.size !== 1) continue;
    const player = [...players][0]!;
    const members = ts
      .filter((t) => {
        const st = visibleState(state.get(t));
        return st?.owner.kind === 'player' && st.owner.playerId === player && neighborsOf(g, t).some((n) => mine.has(n));
      })
      .sort((x, y) => x - y);
    if (!members.length) continue;
    if (!others.length) {
      if (!fogged) continue;
      out.push({
        bonusId: b.id,
        value: b.value,
        player,
        probable: `a member in view is its and its ${fogged} fogged member${fogged > 1 ? 's' : ''} could all be its, #593`,
        members,
        fogged,
      });
      continue;
    }
    if (!opening || others.length !== 1 || state.get(others[0]!)?.owner.kind !== 'neutral') continue;
    out.push({
      bonusId: b.id,
      value: b.value,
      player,
      probable: `one territory short of complete, ${others[0]} still neutral, #593`,
      members,
      fogged,
      shortOf: others[0]!,
    });
  }
  return out;
}

/**
 * The deploy a #593 break is sized for: the opponent's deploy estimate on the target (`estimate`) split
 * over `fronts`, the territories of its in view beside my land (it cannot tell which one I strike, and one
 * deploy floats to one place), rounded up; with one such territory, the whole estimate.
 */
export function partialDeploy(estimate: number, fronts: number): number {
  return Math.ceil(Math.max(0, estimate) / Math.max(1, fronts));
}
