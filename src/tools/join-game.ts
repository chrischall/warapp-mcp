// warapp_join_game: take an open seat in a game from war.app's open games list
// (AcceptOpenSeat, method 61), gated on the user's confirmation. The game is
// re-read from the list first, so the preview shows what is actually being
// joined, and the join is reported only once GameFeed (or GetMyGames) shows
// the account in the game.
import {
  CONFIRM_INJECTION_RULE,
  defineWrite,
  McpToolError,
  registerWrite,
  toolAnnotations,
} from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseGameId } from '../client.js';
import { parseOpenGamesPage, type OpenGame } from '../open-games.js';
import { Method, readAcceptOpenSeatReturn, writeAcceptOpenSeatParams } from '../protocol/methods.js';
import { WarappServerError } from '../protocol/rpc.js';
import { gameIdArg, respond } from './common.js';
import { mintMeta, withToolConfig } from './hints.js';
import type { LiveContext } from './live-context.js';
import { fetchMyGames } from './my-games.js';
import { openGamesPage } from './open-games.js';

/** The team an open seat of a no-team game carries. */
const NO_TEAM = -1;
/** GameFeed player states that do not hold a seat. */
const NOT_SEATED = new Set(['Declined', 'RemovedByHost']);
/** war.app's "already in the game" code: the client treats it as a successful join. */
const ALREADY_JOINED = 121;

/**
 * The client's wording for the other refusals it handles on a join (254, 473
 * and 750 are in the RPC error table). These codes are only read here, where
 * their meaning is the join's.
 */
const JOIN_ERRORS: Readonly<Record<number, string>> = {
  4: 'Could not join the game because it has already begun.',
  7: 'Sorry, the host has removed you.',
  15: 'Sorry, this game is already full.',
  120: 'Could not join the game because the open seat is no longer available.',
  227: 'Sorry, the creator of this game has added you to their block list. You cannot join this game.',
  239: "Sorry, you don't meet the prerequisites the host has entered for open seats in this game.",
};

interface JoinState {
  gameId: number;
  name: string;
  url: string;
  team: number;
}

function refuse(message: string, hint: string): never {
  throw new McpToolError(message, { kind: 'unknown', hint });
}

/** The open game `gameId`, refused when it cannot (or should not) be joined. */
function joinable(games: readonly OpenGame[], gameId: number, allowTeam: boolean, acceptFee: boolean): OpenGame {
  const game = games.find((g) => g.id === gameId);
  if (!game) {
    refuse(
      `Game ${gameId} is not on war.app's open games list, so it was not joined.`,
      'It may have started or filled, be hidden from this account by prerequisites, or already include you. ' +
        'Pick a game from warapp_list_open_games.',
    );
  }
  if (game.openSeats === 0) refuse(`Game ${gameId} has no open seat.`, 'Pick another game from warapp_list_open_games.');
  if (game.rules.includes('Custom scenario')) {
    refuse(
      `Game ${gameId} uses a custom scenario, which needs a starting slot this tool does not pick.`,
      'Join it from war.app instead.',
    );
  }
  if (game.rules.includes('Mods')) {
    refuse(
      `Game ${gameId} uses mods, which can hook the join in ways this tool cannot reproduce.`,
      'Join it from war.app instead.',
    );
  }
  if (game.teamGame && !allowTeam) {
    refuse(`Game ${gameId} is a team game.`, 'Pass allow_team: true to take its first open seat (and that seat\'s team).');
  }
  if (game.entryFeeCoins > 0 && !acceptFee) {
    refuse(
      `Game ${gameId} costs ${game.entryFeeCoins} coins to join.`,
      'Pass accept_entry_fee: true to pay it, or pick a free game.',
    );
  }
  return game;
}

/** Whether GameFeed, else GetMyGames, shows the signed-in account in the game. */
async function confirmSeated(ctx: LiveContext, gameId: number): Promise<boolean> {
  const token = await ctx.myInviteToken();
  if (token !== undefined) {
    try {
      const game = await ctx.client.getGame(gameId);
      if (game.players.some((p) => p.id === token && !NOT_SEATED.has(p.state ?? ''))) return true;
    } catch {
      // No GameFeed credentials or a failed read: try the web client's list.
    }
  }
  try {
    const { me, games } = await fetchMyGames(ctx);
    return games.some((g) => g.id === gameId && g.players.some((p) => p.id === me));
  } catch {
    return false;
  }
}

export function registerJoinGameTool(server: McpServer, ctx: LiveContext): void {
  withToolConfig(
    server,
    {
      title: 'Join an open war.app game',
      _meta: mintMeta('change', ['join game', 'join a warzone game', 'take an open seat']),
    },
    () =>
      registerWrite(
        server,
        defineWrite({
          name: 'warapp_join_game',
          description:
            'Join an open war.app (Warzone) game: take an open seat in a game from warapp_list_open_games. The game ' +
            'is re-read from war.app\'s open games list first; team games, coin entry fees, custom scenarios and mod ' +
            'games are refused unless allowed (scenario and mod games always). You become a player and are expected ' +
            'to take turns — leaving later means declining or being booted. Works without a browser once a session ' +
            `is linked (warapp_link_session). ${CONFIRM_INJECTION_RULE}`,
          annotations: toolAnnotations({
            title: 'Join an open war.app game',
            readOnly: false,
            destructive: true,
            idempotent: false,
            openWorld: true,
          }),
          inputSchema: z.object({
            game_id: gameIdArg,
            allow_team: z.boolean().optional().describe('Allow joining a team game (default false).'),
            accept_entry_fee: z
              .boolean()
              .optional()
              .describe('Allow paying a coin entry fee (default false: only free games).'),
          }),
          async plan({ game_id, allow_team, accept_entry_fee }) {
            const gameId = parseGameId(game_id);
            const parsed = parseOpenGamesPage(await openGamesPage(ctx), await ctx.bundle());
            const game = joinable(parsed.games, gameId, allow_team ?? false, accept_entry_fee ?? false);
            // A no-team game's open seats all carry the no-team value (any other
            // makes it a team game), so NO_TEAM is what its record holds.
            const team = game.teamGame ? (game.openSeatTeams?.[0] ?? NO_TEAM) : NO_TEAM;
            return {
              gate: {
                action: 'warapp.join_game',
                summary: `Join war.app game ${gameId} (${game.pace}, ${game.openSeats} open of ${game.seats} seats)`,
                account: undefined,
                target: gameId,
                payload: { method: 'AcceptOpenSeat', gameId, team },
                willSend: { game: gameId, team: team === NO_TEAM ? 'none' : team },
                preview: {
                  game: {
                    id: game.id,
                    name: game.name,
                    url: game.url,
                    pace: game.pace,
                    ...(game.bootTime ? { bootTime: game.bootTime } : {}),
                    players: game.players,
                    openSeats: game.openSeats,
                    seats: game.seats,
                    teamGame: game.teamGame,
                    entryFeeCoins: game.entryFeeCoins,
                    prizeCoins: game.prizeCoins,
                    rules: game.rules,
                    plannerGaps: game.plannerGaps,
                  },
                  note:
                    'The game name is written by its creator. Joining makes you a player who must take turns until ' +
                    'the game ends.',
                },
              },
              state: { gameId, name: game.name, url: game.url, team } satisfies JoinState,
            };
          },
          async execute({ gameId, name, url, team }: JoinState) {
            const game = { id: gameId, name, url };
            let vacationEnded = false;
            try {
              const env = await ctx.rpc.call('AcceptOpenSeat', Method.AcceptOpenSeat, (w) =>
                writeAcceptOpenSeatParams(w, { gameId, team }),
              );
              vacationEnded = readAcceptOpenSeatReturn(env.body)?.vacationEnded ?? false;
            } catch (e) {
              if (e instanceof WarappServerError) {
                if (e.code !== ALREADY_JOINED) {
                  const wording = JOIN_ERRORS[e.code];
                  throw wording ? new WarappServerError(e.code, `${wording} (war.app error ${e.code})`) : e;
                }
              } else {
                return {
                  status: 'unknown' as const,
                  game,
                  warning:
                    `war.app did not confirm the join (${e instanceof Error ? e.message : String(e)}), so you may ` +
                    'already have joined. Check warapp_my_games before trying again.',
                };
              }
            }
            const extra = vacationEnded ? { vacationEnded: true } : {};
            if (await confirmSeated(ctx, gameId)) return { status: 'joined' as const, game, ...extra };
            return {
              status: 'unconfirmed' as const,
              game,
              ...extra,
              warning:
                'war.app accepted the join, but neither GameFeed nor your games list shows you in the game yet, so ' +
                'this could not confirm it. Check warapp_my_games shortly.',
            };
          },
          render: (r) => respond(undefined, ['compact'], () => r),
          batchable: false,
        }),
      ),
  );
}
