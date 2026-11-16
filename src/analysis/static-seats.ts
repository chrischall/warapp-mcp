// #270: a player who is out of the game and whose seat no AI plays. Pure, no I/O.
//
// war.app keeps such a player's territories on the board (a surrender without
// SurrenderedPlayersTurnIntoAIs, a boot without BootedPlayersTurnIntoAIs, a vote to end), but
// nobody deploys there or orders anything from there: the armies stand still. Every analysis that
// reads a player as an opponent (the planner's estimates, threats, standing and strike stack, the
// stress test's replies, the tracker, the outlook) reads those territories as neutrals instead —
// static armies, priced like a wasteland — through `neutralizeSeats`. An AI that replaced a player
// (`humanTurnedIntoAI`, or the game's turn-into-AI setting for that ending) stays an opponent.

import type { BoardState } from '../board.js';
import { carriesTeam } from '../teams.js';

/** GameFeed states of a player who no longer plays the game (PLAYER_STATE_NAMES, src/player-states.ts). */
export const OUT_STATES: ReadonlySet<string> = new Set(['SurrenderAccepted', 'Booted', 'Eliminated', 'EndedByVote']);

/** What a seat's test reads of a player. */
export interface SeatPlayer {
  id: number;
  /** GameFeed state; absent reads as `Playing`. */
  state?: string;
  /** An AI now plays this human's seat. */
  humanTurnedIntoAI?: boolean;
  /** Its team; absent or -1 in a no-team game. */
  team?: number | null;
}

/** The end-of-game settings that turn a seat into an AI (`Game.endRules`). */
export interface SeatEndRules {
  surrenderedTurnIntoAI?: boolean;
  bootedTurnIntoAI?: boolean;
}

/**
 * Whether `p` is out and its seat static: an out state, no AI playing it (`humanTurnedIntoAI`), and
 * not a surrender or boot the game turns into an AI.
 */
export function isStaticSeat(p: SeatPlayer, endRules?: SeatEndRules): boolean {
  const state = p.state ?? 'Playing';
  if (!OUT_STATES.has(state) || p.humanTurnedIntoAI) return false;
  if (state === 'SurrenderAccepted' && endRules?.surrenderedTurnIntoAI === true) return false;
  if (state === 'Booted' && endRules?.bootedTurnIntoAI === true) return false;
  return true;
}

/**
 * The static seats among `players`, by id, with the state that put each out. Never `me`, nor a
 * teammate of mine: a teammate's land is not a neutral to attack (an order into it is a transfer
 * unless it sets attack_teammates), and the planner never targets it anyway.
 */
export function staticSeats(players: readonly SeatPlayer[] | undefined, endRules?: SeatEndRules, me?: number): Map<number, string> {
  const myTeam = players?.find((p) => p.id === me)?.team;
  const ally = (p: SeatPlayer) => p.id === me || (carriesTeam(myTeam) && p.team === myTeam);
  const out = new Map<number, string>();
  for (const p of players ?? []) if (!ally(p) && isStaticSeat(p, endRules)) out.set(p.id, p.state ?? 'Playing');
  return out;
}

/**
 * `board` with every territory a static seat holds read as neutral, its armies (and any special unit
 * standing there, which still defends) unchanged. The same object when nothing changes.
 */
export function neutralizeSeats(board: BoardState, seats: ReadonlySet<number> | ReadonlyMap<number, unknown>): BoardState {
  if (!seats.size) return board;
  const held = (t: BoardState['territories'][number]) => t.owner.kind === 'player' && seats.has(t.owner.playerId);
  if (!board.territories.some(held)) return board;
  return {
    ...board,
    territories: board.territories.map((t) => (held(t) ? { ...t, owner: { kind: 'neutral' as const } } : t)),
  };
}

/** Per static seat, the territories it holds on `board` (only seats holding some). */
export function seatTerritories(board: BoardState, seats: ReadonlyMap<number, unknown>): Map<number, number> {
  const n = new Map<number, number>();
  for (const t of board.territories)
    if (t.owner.kind === 'player' && seats.has(t.owner.playerId)) n.set(t.owner.playerId, (n.get(t.owner.playerId) ?? 0) + 1);
  return n;
}

/** The end rules a plan reads (`PlanGameContext.endRules`) from `Game.endRules`: only the fields set. */
export function seatEndRules(r: SeatEndRules & { aisSurrenderWhenOneHumanRemains?: boolean }): {
  aisSurrenderWhenOneHumanRemains?: boolean;
  surrenderedTurnIntoAI?: boolean;
  bootedTurnIntoAI?: boolean;
} {
  return {
    ...(r.aisSurrenderWhenOneHumanRemains !== undefined ? { aisSurrenderWhenOneHumanRemains: r.aisSurrenderWhenOneHumanRemains } : {}),
    ...(r.surrenderedTurnIntoAI !== undefined ? { surrenderedTurnIntoAI: r.surrenderedTurnIntoAI } : {}),
    ...(r.bootedTurnIntoAI !== undefined ? { bootedTurnIntoAI: r.bootedTurnIntoAI } : {}),
  };
}
