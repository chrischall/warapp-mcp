// A four-seat game for the team-source fallback (src/tools/team-source.ts): GameFeed sends no team
// unless asked, and GetMyGames lists Ann and Bob on team 4, Cy and Dee on team 5. Shared by the tests
// of every tool that decides teams. Every id and name here is made up.
import type { DecodedRequest, ReplyFrame } from '../src/protocol/codec.js';
import { Method } from '../src/protocol/methods.js';
import { lobbyFixture, type Harness } from './helpers.js';
import { writeLatestGameInfo, type SyntheticTerritory } from './protocol/live-bundle.js';
import { writeMyGamesReturn } from './protocol/my-games-bundle.js';

export const TEAM_GAME = 12345678;
// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
export const ANN = { feed: '3312345644', inGame: 123456 };
export const BOB = { feed: '7176543229', inGame: 765432 };
export const CY = { feed: '5522222211', inGame: 222222 };
export const DEE = { feed: '6633333322', inGame: 333333 };
export const SIGNED_IN_ANN = { 'https://war.app/InviteToken': `<p>Your invite token is ${ANN.feed}</p>` };

/** Four seats (or the first `seats`), with GameFeed's team on each only when `teams`. */
export function teamGame(opts: { teams?: boolean; seats?: number; turns?: number } = {}): Record<string, unknown> {
  const f = lobbyFixture();
  const base = { isAI: 'False', humanTurnedIntoAI: 'False', hasCommittedOrders: 'False', state: 'Playing' };
  const team = (t: string) => (opts.teams ? { team: t } : {});
  const players = [
    { ...base, id: ANN.feed, name: 'Ann', ...team('0') },
    { ...base, id: BOB.feed, name: 'Bob', ...team('0') },
    { ...base, id: CY.feed, name: 'Cy', ...team('1') },
    { ...base, id: DEE.feed, name: 'Dee', ...team('1') },
  ].slice(0, opts.seats ?? 4);
  const settings = { ...(f.settings as Record<string, unknown>), SanctionsCard: 'none' };
  return { ...f, id: String(TEAM_GAME), state: 'Playing', numberOfTurns: String(opts.turns ?? 2), players, settings };
}

// Ann holds 159 and 161; Bob, her teammate by the game list, holds 157 and 158 beside them.
export const TEAM_BOARD: SyntheticTerritory[] = [
  { id: 159, fogLevel: 1, owner: ANN.inGame, armies: 6 },
  { id: 161, fogLevel: 1, owner: ANN.inGame, armies: 3 },
  { id: 157, fogLevel: 2, owner: BOB.inGame, armies: 2 },
  { id: 158, fogLevel: 1, owner: BOB.inGame, armies: 7 },
  { id: 135, fogLevel: 4, owner: -1, armies: 0, fogged: true },
];

export const LIST_TEAMS = [
  { id: ANN.inGame, name: 'Ann', state: 2, committed: false, team: 4 },
  { id: BOB.inGame, name: 'Bob', state: 2, committed: false, team: 4 },
  { id: CY.inGame, name: 'Cy', state: 2, committed: false, team: 5 },
  { id: DEE.inGame, name: 'Dee', state: 2, committed: false, team: 5 },
];

type Reply = (req: DecodedRequest, n: number) => Partial<ReplyFrame>;

/** The game list holding the game with LIST_TEAMS. */
export const listedTeams: Reply = () => ({
  body: (w) => writeMyGamesReturn(w, [{ id: TEAM_GAME, name: 'synthetic', lastTurn: 2, state: 3, players: LIST_TEAMS }]),
});

/**
 * war.app: the live board (`board`), GetMyGames answered by `myGames` (or failing), and any other method
 * by `other` (else refused).
 */
export function teamServer(
  myGames: Reply | 'fail' = listedTeams,
  o: { board?: SyntheticTerritory[]; other?: (req: DecodedRequest, n: number) => Partial<ReplyFrame> | undefined } = {},
) {
  return (req: DecodedRequest, n: number): Partial<ReplyFrame> => {
    if (req.method === Method.GetLatestGameInfo) return { body: (w) => writeLatestGameInfo(w, o.board ?? TEAM_BOARD, [ANN.inGame, BOB.inGame]) };
    if (req.method === Method.GetMyGames) {
      if (myGames === 'fail') throw new Error('game list unavailable');
      return myGames(req, n);
    }
    const r = o.other?.(req, n);
    if (r) return r;
    throw new Error(`unexpected method ${req.method}`);
  };
}

/** How many GetMyGames requests the harness saw. */
export const listReads = (h: Harness) => h.exchanges.filter((e) => e.request.method === Method.GetMyGames).length;
