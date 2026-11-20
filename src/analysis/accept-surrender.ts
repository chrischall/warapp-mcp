// What accepting another player's surrender does (#317), pure: who borders its land, who is left
// once it goes through, and the one advice line warapp_accept_surrender's preview gives.
//
// The land is what the live board shows the surrendering player holding (fogged territories are
// not counted: under fog it may hold more). #417: how much it holds behind the fog is unknown — the
// standing carries no per-player count — so the preview says so plainly, with the board's hidden
// territories as the bound (`hiddenLand`, `hiddenOnBoard`, `hiddenLandLine`). A neighbour's weight is the number of ITS territories
// that border that land: the player with the most stands to gain most once the land is up for
// taking (strategy note `ffa-surrender-veto`).

import type { LiveTerritory } from '../live.js';

/** One player bordering the surrendering player's land. */
export interface LandNeighbour {
  /** The owner's in-game id. */
  inGameId: number;
  /** How many of its territories border the land. */
  bordering: number;
}

/** The surrendering player's land on the live board and who borders it. */
export interface SurrenderLand {
  /** Territory ids it holds in view, ascending. */
  territories: number[];
  /** Neighbours by territories bordering, most first (ties on ascending in-game id). */
  neighbours: LandNeighbour[];
  /** Territories next to its land whose owner the fog hides. */
  hiddenNeighbours: number;
  /**
   * #417: the map's territories whose owner the board does not show (fogged, or not on it at all): its
   * hidden land is at most this many.
   */
  hiddenOnBoard: number;
  /**
   * #417: how many of its territories the fog hides — 0 when the board hides none, else `null`: the live
   * board's standing carries no per-player territory count (only each territory's owner, hidden under fog).
   */
  hiddenLand: number | null;
}

/** {@link SurrenderLand} for in-game player `who`, from the live board and the map's adjacency. */
export function surrenderLand(
  territories: readonly LiveTerritory[],
  adjacency: ReadonlyMap<number, readonly number[]>,
  who: number,
): SurrenderLand {
  const byId = new Map(territories.map((t) => [t.territoryId, t]));
  const land = territories.filter((t) => !t.fogged && t.owner === who).map((t) => t.territoryId).sort((a, b) => a - b);
  const landSet = new Set(land);
  const borderingOf = new Map<number, Set<number>>();
  const hidden = new Set<number>();
  for (const id of land) {
    for (const n of adjacency.get(id) ?? []) {
      if (landSet.has(n)) continue;
      const t = byId.get(n);
      if (!t || t.fogged || t.owner < 0) {
        hidden.add(n);
        continue;
      }
      if (t.owner === 0) continue;
      const set = borderingOf.get(t.owner) ?? new Set<number>();
      set.add(n);
      borderingOf.set(t.owner, set);
    }
  }
  const neighbours = [...borderingOf].map(([inGameId, set]) => ({ inGameId, bordering: set.size }));
  neighbours.sort((a, b) => b.bordering - a.bordering || a.inGameId - b.inGameId);
  // #417: every territory of the map whose owner the board does not show.
  const ids = new Set([...adjacency.keys(), ...territories.map((t) => t.territoryId)]);
  let hiddenOnBoard = 0;
  for (const id of ids) {
    const t = byId.get(id);
    if (!t || t.fogged || t.owner < 0) hiddenOnBoard++;
  }
  return { territories: land, neighbours, hiddenNeighbours: hidden.size, hiddenOnBoard, hiddenLand: hiddenOnBoard === 0 ? 0 : null };
}

/** #417: the preview's plain line on the surrendering player's land the fog hides. */
export function hiddenLandLine(land: SurrenderLand): string {
  const inView = `${land.territories.length} in view ${land.territories.length === 1 ? 'is' : 'are'}`;
  if (land.hiddenLand === 0) return `The fog hides none of the board: its land is the ${inView.replace(/ (is|are)$/, '')}.`;
  return (
    `How many of its territories the fog hides is unknown: the live board gives no per-player count, and ${land.hiddenOnBoard} ` +
    `territories on the board are hidden, so its hidden land is anywhere from 0 to that. Only the ${inView} counted here.`
  );
}

/** A seat still playing, as the after-acceptance count needs it. */
export interface StillPlaying {
  id: number;
  /** An AI seat (or a human turned into one). */
  ai: boolean;
  /** On my team (or me). */
  mine: boolean;
}

/**
 * Whether accepting, once it goes through, leaves only my side playing: `true` when no seat off my
 * team is left; `false` when one is; `null` when it hangs on a setting not read (whether the land goes
 * to an AI that keeps playing). `remaining` are the seats still playing other than the surrendering one;
 * `toAI` whether its seat is handed to an AI (`undefined`: unread); `aisSurrender` the game's
 * AIsSurrenderWhenOneHumanRemains.
 */
export function winsOnAcceptance(
  remaining: readonly StillPlaying[],
  toAI: boolean | undefined,
  aisSurrender: boolean | undefined,
): boolean | null {
  const judge = (handedToAI: boolean): boolean => {
    const seats = handedToAI ? [...remaining, { id: -1, ai: true, mine: false }] : remaining;
    const rivals = seats.filter((s) => !s.mine);
    if (!rivals.length) return true;
    // The AIs give up once one human is left: when every rival is an AI and I am the only human.
    const humans = seats.filter((s) => !s.ai);
    return aisSurrender === true && rivals.every((s) => s.ai) && humans.length === 1 && humans[0]!.mine;
  };
  if (toAI !== undefined) return judge(toAI);
  const a = judge(false);
  return a === judge(true) ? a : null;
}
