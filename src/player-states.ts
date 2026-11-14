// A player's state in a game, and the one test of whether it holds a seat.
//
// GameFeed names the state (`"Playing"`, `"Declined"`, …); the web client's
// records carry the GamePlayerState code. Both are named here, so the open-games
// list, the join read-back and the game profile all ask the same question (#133).

/** GamePlayerState: the web client's codes, named as GameFeed names them. */
export const PLAYER_STATE_NAMES: Readonly<Record<number, string>> = {
  1: 'Invited',
  2: 'Playing',
  3: 'Eliminated',
  4: 'Won',
  5: 'Declined',
  6: 'RemovedByHost',
  7: 'SurrenderAccepted',
  8: 'Booted',
  9: 'EndedByVote',
};

/** A GamePlayerState code's name; the code itself when it has none. */
export function playerStateName(code: number): string {
  return PLAYER_STATE_NAMES[code] ?? String(code);
}

/**
 * States of a player who does not hold a seat: an invitation not yet accepted, one declined, and a
 * removal by the host. Such a player never started the game. Every other state held a seat — the
 * finished ones (eliminated, surrendered, booted, …) included.
 */
const NOT_SEATED = new Set(['Invited', 'Declined', 'RemovedByHost']);

/** Whether a player in `state` (a GameFeed state name; absent reads as Playing) holds a seat. */
export function holdsSeat(state: string | undefined): boolean {
  return !NOT_SEATED.has(state ?? 'Playing');
}
