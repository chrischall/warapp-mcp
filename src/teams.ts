// Teams: the one test of "is this a team?" shared by the open-games list, joining and the
// game profile. war.app marks "no team" with -1 (verified from the client bundle, see
// docs/WEB-PROTOCOL.md "Open games"): any other team value makes it a team game.

/** The team value of a player or seat in a no-team game. */
export const NO_TEAM = -1;

/** Whether a player or seat carries a team (absent and {@link NO_TEAM} do not). */
export const carriesTeam = (team: number | null | undefined): team is number =>
  team !== undefined && team !== null && team !== NO_TEAM;
