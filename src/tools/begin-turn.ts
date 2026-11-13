// warapp_begin_turn: press Begin in a game whose first turn is a speed race
// (MoveOrder "No-luck cycle"), with the web client's BeginFirstTurn (method 78),
// gated on the user's confirmation. war.app withholds the board until Begin is
// pressed, and pressing it starts the player's first-turn timer — so the agent
// should call this only when it is ready to plan and submit straight away.
// The game is read from GameFeed first and the live board checked (a board
// already visible means Begin was pressed); the outcome is read back from the
// live board, never from the reply.
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
import { readLatestGameInfo, standingFromInfo, type LiveTerritory } from '../live.js';
import type { Game } from '../normalize.js';
import { Method, writeBeginFirstTurnParams, writeGetLatestGameInfoParams } from '../protocol/methods.js';
import { WarappServerError } from '../protocol/rpc.js';
import { gameIdArg, respond } from './common.js';
import { mintMeta, withToolConfig } from './hints.js';
import { failureText, SPEED_FIRST_TURN_MOVE_ORDER, type LiveContext } from './live-context.js';

const PLAYING = 'Playing';
const DISTRIBUTING = 'DistributingTerritories';

/**
 * The BeginFirstTurn error the web client ignores (it refreshes as on success);
 * read from the bundle, its meaning is not verified.
 */
const IGNORED_ERROR = 4;

interface BeginState {
  gameId: number;
  name: string;
  picking: boolean;
}

function refuse(message: string, hint: string): never {
  throw new McpToolError(message, { kind: 'unknown', hint });
}

const gameLabel = (game: Game): string => game.name ?? `game ${game.id}`;

/** Refuse a game that is not waiting for this account's Begin (judged from GameFeed). */
function beginnable(game: Game, me: number): void {
  if (game.state === 'Finished') {
    refuse(`Game ${game.id} is already over, so there is no first turn to begin.`, 'Check warapp_get_game.');
  }
  if (game.state !== PLAYING && game.state !== DISTRIBUTING) {
    refuse(
      `Game ${game.id} has not started yet (game state: ${game.state}), so there is no first turn to begin.`,
      'A lobby starts when its seats fill; check warapp_get_game.',
    );
  }
  if ((game.numberOfTurns ?? 0) > 0) {
    refuse(
      `Game ${game.id} is past its first turn (turn ${(game.numberOfTurns ?? 0) + 1}), so there is nothing to begin.`,
      'Plan the turn with warapp_plan_turn.',
    );
  }
  const order = game.settings?.moveOrder;
  if (order !== undefined && order !== SPEED_FIRST_TURN_MOVE_ORDER) {
    refuse(
      `Game ${game.id} does not race its first turn (move order: ${order}), so it has no Begin button.`,
      'Only games with the "No-luck cycle" move order need Begin. Read the board with warapp_get_live_board.',
    );
  }
  const seat = game.players.find((p) => p.id === me);
  if (!seat) {
    refuse(`You are not playing in game ${game.id}, so there is nothing to begin.`, 'Check the game id with warapp_my_games.');
  }
  if (seat.state !== PLAYING) {
    refuse(
      `You are no longer playing in game ${game.id} (your state: ${seat.state ?? 'unknown'}).`,
      'Check warapp_get_game.',
    );
  }
}

/** The live board, or undefined while war.app withholds it. */
async function liveBoard(ctx: LiveContext, gameId: number): Promise<LiveTerritory[] | undefined> {
  const env = await ctx.rpc.call('GetLatestGameInfo', Method.GetLatestGameInfo, (w) =>
    writeGetLatestGameInfoParams(w, gameId),
  );
  return standingFromInfo(readLatestGameInfo(await ctx.bundle(), env.body)) ?? undefined;
}

export function registerBeginTurnTool(server: McpServer, ctx: LiveContext): void {
  withToolConfig(
    server,
    {
      title: 'Begin the first turn of a war.app speed game',
      _meta: mintMeta('change', ['begin first turn', 'press begin', 'start my first turn']),
    },
    () =>
      registerWrite(
        server,
        defineWrite({
          name: 'warapp_begin_turn',
          description:
            'Press Begin in a war.app (Warzone) game whose first turn is a speed race (move order "No-luck ' +
            'cycle": whoever commits their first orders fastest moves first). war.app hides the board until ' +
            'Begin is pressed, and pressing it STARTS YOUR TURN TIMER — call this only when ready to plan and ' +
            'submit at once (warapp_plan_turn, then warapp_submit_turn; in manual distribution, the picks). ' +
            'Refuses games past their first turn, games without the speed first turn, games you are not ' +
            'playing, and games whose board is already visible; reads the board back to report `begun`. ' +
            `The BeginFirstTurn encoding is read from the war.app client, not yet verified live. ${CONFIRM_INJECTION_RULE}`,
          annotations: toolAnnotations({
            title: 'Begin the first turn of a war.app speed game',
            readOnly: false,
            destructive: true,
            idempotent: false,
            openWorld: true,
          }),
          inputSchema: z.object({ game_id: gameIdArg }),
          async plan({ game_id }) {
            const gameId = parseGameId(game_id);
            const me = await ctx.myInviteToken();
            if (me === undefined) {
              refuse(
                'Could not tell which war.app account is signed in, so nothing was sent.',
                'Open a war.app tab signed in to your account (or link a session with warapp_link_session), then retry.',
              );
            }
            const game = await ctx.client.getGame(gameId, { settings: true });
            beginnable(game, me);
            if (await liveBoard(ctx, gameId)) {
              refuse(
                `Your first turn in game ${gameId} has already begun: the board is visible.`,
                'Plan and submit now with warapp_plan_turn and warapp_submit_turn — the turn timer is running.',
              );
            }
            const name = gameLabel(game);
            const picking = game.state === DISTRIBUTING;
            const warning = picking
              ? `Begin STARTS YOUR PICK TIMER in ${name}: the players who pick fastest get their picks in a conflict. ` +
                'Choose and submit your picks straight after.'
              : `Begin STARTS YOUR FIRST-TURN TIMER in ${name}: the players who commit fastest move first. ` +
                'Plan and submit straight after (warapp_plan_turn, then warapp_submit_turn).';
            return {
              gate: {
                action: 'warapp.begin_first_turn',
                summary: `Press Begin in ${name} (war.app game ${gameId}) — this starts your turn timer`,
                account: undefined,
                target: gameId,
                payload: { method: 'BeginFirstTurn', gameId },
                willSend: { game: gameId },
                preview: {
                  warning,
                  game: { id: gameId, name, state: game.state, turn: 1 },
                  untrusted: 'The game name is written by its creator.',
                },
              },
              state: { gameId, name, picking } satisfies BeginState,
            };
          },
          async execute({ gameId, name, picking }: BeginState) {
            const game = { id: gameId, name };
            let ignored = false;
            try {
              await ctx.rpc.call('BeginFirstTurn', Method.BeginFirstTurn, (w) => writeBeginFirstTurnParams(w, gameId));
            } catch (e) {
              if (e instanceof WarappServerError) {
                if (e.code !== IGNORED_ERROR) throw e;
                // The web client ignores this error and refreshes as on success: read the board back,
                // and judge from it alone (#130).
                ignored = true;
              } else {
                return {
                  status: 'unknown' as const,
                  game,
                  warning:
                    `war.app did not confirm Begin (${failureText(e)}), so it may ` +
                    'already have gone through and your timer may be running. Check warapp_get_live_board; do not ' +
                    'press Begin again blindly.',
                };
              }
            }

            let territories: LiveTerritory[] | undefined;
            try {
              territories = await liveBoard(ctx, gameId);
            } catch {
              territories = undefined;
            }
            if (!territories && ignored) {
              return {
                status: 'not_begun' as const,
                game,
                warning:
                  `war.app answered Begin with error ${IGNORED_ERROR} (the web client ignores it; its meaning is not ` +
                  'verified) and the board is still hidden, so Begin did not take effect as far as can be read. ' +
                  'Check warapp_get_live_board before pressing Begin again.',
              };
            }
            if (!territories) {
              return {
                status: 'unconfirmed' as const,
                game,
                warning:
                  'war.app accepted Begin, but the board could not be read back yet. Check warapp_get_live_board ' +
                  'shortly — your timer is probably running.',
              };
            }
            return {
              status: 'begun' as const,
              game,
              territoriesVisible: territories.length,
              next: picking
                ? 'Your pick timer is running: choose and submit your picks now (warapp_submit_picks).'
                : 'Your turn timer is running: plan and submit now (warapp_plan_turn, then warapp_submit_turn).',
            };
          },
          render: (r) => respond(undefined, ['compact'], () => r),
          batchable: false,
        }),
      ),
  );
}
