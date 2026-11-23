// Scale (mega games, ~100 players): which opponents a tool estimates one by one, and a summary of the rest.
// A game with more than LARGE_GAME_OPPONENTS opponents still playing is "large": its per-opponent estimates,
// rows and lists keep only the players near me — in view (fog shows their land) or holding land within
// NEAR_STEPS steps of mine — and the others are counted. Every other game is unchanged (no scope at all).
// Pure and deterministic.

import type { BoardState } from '../board.js';
import { neighborsOf, type MapGraph } from './graph.js';

/** More opponents still playing than this makes a game large (a 1v1, a team game or an ordinary free-for-all never is). */
export const LARGE_GAME_OPPONENTS = 16;
/** A player holding land this many steps from mine, or fewer, is near. */
export const NEAR_STEPS = 2;

/**
 * The players (never `me`) near my land on `board`: each holding a territory within `steps` steps of one of
 * mine, and, under fog (some territory's owner hidden), each whose land is in view anywhere (a card's vision,
 * say). Without fog every owner is in view, so only the steps count.
 */
export function nearPlayers(g: MapGraph, board: BoardState, me: number, steps = NEAR_STEPS): Set<number> {
  const owner = new Map<number, number>();
  let fogged = false;
  for (const t of board.territories) {
    if (t.owner.kind === 'player') owner.set(t.territoryId, t.owner.playerId);
    else if (t.owner.kind === 'unknown') fogged = true;
  }
  const out = new Set<number>();
  let frontier = [...owner].filter(([, p]) => p === me).map(([t]) => t);
  const seen = new Set(frontier);
  for (let d = 0; d < steps && frontier.length; d++) {
    const next: number[] = [];
    for (const t of frontier)
      for (const n of neighborsOf(g, t)) {
        if (seen.has(n)) continue;
        seen.add(n);
        next.push(n);
        const p = owner.get(n);
        if (p !== undefined && p !== me) out.add(p);
      }
    frontier = next;
  }
  if (fogged) for (const p of owner.values()) if (p !== me) out.add(p);
  return out;
}

/** Which opponents a large game's tools estimate one by one ({@link opponentScope}). */
export interface OpponentScope {
  /** More than {@link LARGE_GAME_OPPONENTS} opponents: only `near` ones get their own rows. */
  large: boolean;
  /** The opponents given their own rows (every one when not large), ascending. */
  near: number[];
  /** The rest, ascending (empty when not large). */
  far: number[];
}

/** The scope over `opponents` (teammates and me already left out): every one unless the game is large. */
export function opponentScope(g: MapGraph, board: BoardState, me: number, opponents: readonly number[]): OpponentScope {
  const ids = [...new Set(opponents)].filter((p) => p !== me).sort((a, b) => a - b);
  if (ids.length <= LARGE_GAME_OPPONENTS) return { large: false, near: ids, far: [] };
  const near = nearPlayers(g, board, me);
  return { large: true, near: ids.filter((p) => near.has(p)), far: ids.filter((p) => !near.has(p)) };
}

/** The far opponents in one line of figures: how many, their summed deploy estimate and the biggest. */
export interface FarSummary {
  count: number;
  /** The far opponents' deploy estimates summed (those without one left out); null when none has one. */
  estimatedDeploy: number | null;
  /** The far opponent with the largest estimate (lowest id on a tie); null when none has one. */
  biggest: { player: number; deploy: number } | null;
  note: string;
}

export const FAR_NOTE =
  `A large game (more than ${LARGE_GAME_OPPONENTS} opponents): only the opponents in view or holding land within ` +
  `${NEAR_STEPS} steps of yours are estimated one by one; the rest are summed here. Their estimates are priors (the fog ` +
  'hides them), so the sum is a scale, not a threat: none of them can reach your land this turn.';

export function farSummary(far: readonly number[], estimateOf: (player: number) => number | undefined): FarSummary {
  let sum: number | null = null;
  let biggest: FarSummary['biggest'] = null;
  for (const p of far) {
    const e = estimateOf(p);
    if (e === undefined) continue;
    sum = (sum ?? 0) + e;
    if (!biggest || e > biggest.deploy) biggest = { player: p, deploy: e };
  }
  return { count: far.length, estimatedDeploy: sum, biggest, note: FAR_NOTE };
}
