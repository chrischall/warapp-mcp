// Teams: the one test of "is this a team?" shared by the open-games list, joining and the
// game profile. war.app marks "no team" with -1 (verified from the client bundle, see
// docs/WEB-PROTOCOL.md "Open games"): any other team value makes it a team game.

/** The team value of a player or seat in a no-team game. */
export const NO_TEAM = -1;

/** Whether a player or seat carries a team (absent and {@link NO_TEAM} do not). */
export const carriesTeam = (team: number | null | undefined): team is number =>
  team !== undefined && team !== null && team !== NO_TEAM;

/** Whether any player of the game carries a team: the game is a team game. */
export const isTeamGame = (players: readonly { team?: number | null }[]): boolean => players.some((p) => carriesTeam(p.team));

/**
 * The players on `me`'s team, never `me` itself (matched by id), in the list's order; none when `me` carries
 * no team. Players are whatever the caller holds (GameFeed players at the tool boundary, keyed by GameFeed id).
 */
export function teammatesOf<P extends { id: number; team?: number | null }>(players: readonly P[], me: { id: number; team?: number | null }): P[] {
  const team = me.team;
  if (!carriesTeam(team)) return [];
  return players.filter((p) => p.id !== me.id && p.team === team);
}
