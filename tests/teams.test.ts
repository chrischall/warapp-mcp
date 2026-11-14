// The one team test (C1, docs/PLAN-TEAMS.md): every tool asks src/teams.ts whether a player or a game
// carries a team and who is on mine, so a team value war.app may send (any value but -1) is read alike.
import { describe, expect, it } from 'vitest';
import { carriesTeam, isTeamGame, NO_TEAM, teammatesOf } from '../src/teams.js';
import { friendsOf } from '../src/tools/turn.js';
import { alliesOf } from '../src/analysis/plan/estimates.js';
import type { Player } from '../src/normalize.js';

const player = (id: number, team?: number): Player => ({
  id,
  name: `P${id}`,
  isAI: false,
  humanTurnedIntoAI: false,
  hasCommittedOrders: false,
  ...(team !== undefined ? { team } : {}),
});

describe('teams', () => {
  it('carriesTeam: absent, null and -1 are no team; any other value is one', () => {
    expect(carriesTeam(undefined)).toBe(false);
    expect(carriesTeam(null)).toBe(false);
    expect(carriesTeam(NO_TEAM)).toBe(false);
    expect(carriesTeam(0)).toBe(true);
    expect(carriesTeam(3)).toBe(true);
  });

  it('isTeamGame: any player carrying a team', () => {
    expect(isTeamGame([player(1), player(2, -1)])).toBe(false);
    expect(isTeamGame([player(1, -1), player(2, 0)])).toBe(true);
  });

  it('teammatesOf: the players on my team, never me, none when I carry no team', () => {
    const players = [player(1, 0), player(2, 0), player(3, 1), player(4, -1), player(5)];
    expect(teammatesOf(players, players[0]!).map((p) => p.id)).toEqual([2]);
    expect(teammatesOf(players, players[3]!)).toEqual([]);
    expect(teammatesOf(players, players[4]!)).toEqual([]);
    // Two no-team players are not teammates (-1 === -1 is no team).
    expect(teammatesOf([player(1, -1), player(2, -1)], player(1, -1))).toEqual([]);
  });

  it('friendsOf and alliesOf use the same test: a team value below -1 is still a team', () => {
    // war.app marks "no team" with -1 only; any other value is a team (the client's own test).
    const players = [player(11, -3), player(12, -3), player(13, 0)];
    expect([...friendsOf(players, players[0]!)]).toEqual([12]);
    expect([...alliesOf(11, players)]).toEqual([12]);
  });
});
