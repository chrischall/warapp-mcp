// warapp_surrender: surrender a game (or take back a pending surrender) with
// the web client's Surrender (method 67), gated on the user's confirmation.
// The game is read from GameFeed first, so finished games and games the
// signed-in account is not playing are refused before anything is sent, and
// the outcome is read back from GameFeed afterwards — never from the reply,
// which carries no result.
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
import type { Game, Player } from '../normalize.js';
import { Method, writeSurrenderParams } from '../protocol/methods.js';
import { WarappServerError } from '../protocol/rpc.js';
import { gameIdArg, respond, shownAccount, UNTRUSTED_PREVIEW_NOTE, untrustedText } from './common.js';
import { noBrowserNote, signedInHint } from './session.js';
import { mintMeta, withToolConfig } from './hints.js';
import { failureText, requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';

const PLAYING = 'Playing';
const SURRENDERED = 'SurrenderAccepted';
const FINISHED = 'Finished';
const DISTRIBUTING = 'DistributingTerritories';

/** The Surrender refusals war.app answers with (verified live, issue #30). */
const SURRENDER_ERRORS: Readonly<Record<number, string>> = {
  4: 'The game is over, so there is nothing to surrender.',
  7: 'You are no longer in the game.',
  230: 'You are no longer in the game.',
};

interface SurrenderState {
  gameId: number;
  name: string;
  me: number;
  undo: boolean;
}

function refuse(message: string, hint: string): never {
  throw new McpToolError(message, { kind: 'unknown', hint });
}

const gameLabel = (game: Game): string => game.name ?? `game ${game.id}`;

/** Players still in the game (a surrender in a game of more than two needs the others' acceptance). */
const activePlayers = (game: Game): Player[] => game.players.filter((p) => p.state === PLAYING);

/** The signed-in account's seat in `game`, refused when it cannot (or should not) be surrendered. */
function surrenderable(game: Game, me: number, undo: boolean): Player {
  if (game.state === FINISHED) {
    refuse(`Game ${game.id} is already over, so there is nothing to surrender.`, 'Check warapp_get_game.');
  }
  if (game.state !== PLAYING && game.state !== DISTRIBUTING) {
    refuse(
      `Game ${game.id} has not started (game state: ${game.state}), so there is nothing to surrender.`,
      'A lobby is left or declined in the game itself, not surrendered.',
    );
  }
  const seat = game.players.find((p) => p.id === me);
  if (!seat) {
    refuse(
      `You are not playing in game ${game.id}, so there is nothing to surrender.`,
      'Check the game id with warapp_my_games.',
    );
  }
  if (undo && seat.state === SURRENDERED) {
    refuse(
      `Your surrender in game ${game.id} was already accepted, so it cannot be taken back.`,
      'Check warapp_get_game.',
    );
  }
  if (seat.state !== PLAYING) {
    refuse(
      `You are no longer playing in game ${game.id} (your state: ${seat.state ?? 'unknown'}).`,
      'Check warapp_get_game.',
    );
  }
  // GameFeed exposes no pending-surrender flag, so this can only refuse the two-player
  // case (where a surrender ends the game at once); with more players `undo` is sent.
  if (undo && activePlayers(game).length <= 2) {
    refuse(
      `There is no pending surrender to take back in game ${game.id}: with two players a surrender ends the game at once.`,
      'Check warapp_get_game.',
    );
  }
  return seat;
}

export function registerSurrenderTool(server: McpServer, ctx: LiveContext): void {
  withToolConfig(
    server,
    {
      title: 'Surrender a war.app game',
      _meta: mintMeta('change', ['surrender game', 'resign warzone game', 'give up game']),
    },
    () =>
      registerWrite(
        server,
        defineWrite({
          name: 'warapp_surrender',
          description:
            'Surrender a war.app (Warzone) game as the signed-in account: you lose it and cannot rejoin. In a game ' +
            'of more than two players the surrender waits for the others to accept it (reported `pending`); ' +
            '`undo: true` takes back such a pending surrender. The game is read from GameFeed first (finished ' +
            'games and games you are not playing are refused) and the outcome is read back from GameFeed.' +
            `${noBrowserNote(ctx.hosted)} ${CONFIRM_INJECTION_RULE}`,
          annotations: toolAnnotations({
            title: 'Surrender a war.app game',
            readOnly: false,
            destructive: true,
            idempotent: false,
            openWorld: true,
          }),
          inputSchema: z.object({
            game_id: gameIdArg,
            undo: z
              .boolean()
              .optional()
              .describe('Take back your pending surrender instead of surrendering (default false).'),
          }),
          async plan({ game_id, undo }) {
            const gameId = parseGameId(game_id);
            const takeBack = undo ?? false;
            const me = await ctx.myInviteToken({ fresh: true });
            if (me === undefined) {
              refuse(
                'Could not tell which war.app account is signed in, so nothing was sent.',
                signedInHint(ctx.hosted),
              );
            }
            const game = await ctx.client.getGame(gameId, { map: false });
            const seat = surrenderable(game, me, takeBack);
            const name = gameLabel(game);
            const players = activePlayers(game).length;
            // The sentences name the game by id only: its name is its creator's words and
            // goes, delimited, in `game.name` (the preview sits beside the confirmToken).
            const summary = takeBack
              ? `Take back your pending surrender in war.app game ${gameId}`
              : `This ENDS your war.app game ${gameId} — you lose it and cannot rejoin`;
            return {
              gate: {
                action: takeBack ? 'warapp.take_back_surrender' : 'warapp.surrender',
                summary,
                account: writeAccount(me),
                target: gameId,
                payload: { method: 'Surrender', gameId, surrender: !takeBack },
                willSend: { game: gameId, surrender: !takeBack },
                preview: {
                  warning: takeBack
                    ? `This will take back your pending surrender in game ${gameId}.`
                    : `This ENDS your game ${gameId} — you lose it and cannot rejoin.`,
                  account: shownAccount(seat.name, me),
                  game: { id: gameId, name: game.name === undefined ? null : untrustedText(game.name), state: game.state, playersStillIn: players },
                  ...(takeBack || players <= 2
                    ? {}
                    : { note: 'With more than two players, the others must accept the surrender before it ends your game.' }),
                  untrusted: UNTRUSTED_PREVIEW_NOTE,
                },
              },
              state: { gameId, name, me, undo: takeBack } satisfies SurrenderState,
            };
          },
          async execute({ gameId, name, me, undo }: SurrenderState) {
            await requireApprovedAccount(ctx, writeAccount(me));
            const game = { id: gameId, name };
            try {
              await ctx.rpc.call('Surrender', Method.Surrender, (w) =>
                writeSurrenderParams(w, { gameId, surrender: !undo }),
              );
            } catch (e) {
              if (e instanceof WarappServerError) {
                const wording = SURRENDER_ERRORS[e.code];
                throw wording ? new WarappServerError(e.code, `${wording} (war.app error ${e.code})`) : e;
              }
              return {
                status: 'unknown' as const,
                game,
                warning:
                  `war.app did not confirm the ${undo ? 'take-back' : 'surrender'} ` +
                  `(${failureText(e)}), so it may already have gone through. ` +
                  'Check warapp_get_game to see your state in the game.',
              };
            }

            let after: Game;
            try {
              after = await ctx.client.getGame(gameId, { map: false });
            } catch (e) {
              return {
                status: 'unconfirmed' as const,
                game,
                warning:
                  `war.app accepted the request, but GameFeed could not be read back ` +
                  `(${e instanceof Error ? e.message : String(e)}). Check warapp_get_game.`,
              };
            }
            const seat = after.players.find((p) => p.id === me);
            const state = { yourState: seat?.state ?? null, gameState: after.state };
            if (seat?.state === SURRENDERED) return { status: 'surrendered' as const, game, ...state };
            if (undo) {
              // GameFeed shows no pending surrender, so "still playing" is all that can be read (#130).
              if (seat?.state === PLAYING) {
                return {
                  status: 'still_playing' as const,
                  game,
                  ...state,
                  message:
                    'You are still playing. GameFeed has no pending-surrender state, so whether a surrender was ' +
                    'pending (and is now taken back) cannot be read; if none was, nothing changed.',
                };
              }
            } else if (seat?.state === PLAYING && activePlayers(after).length > 2) {
              return {
                status: 'pending' as const,
                game,
                ...state,
                // GameFeed has no pending-surrender state: war.app accepted the request
                // and the seat is still Playing, which is what a pending surrender looks like.
                message:
                  'war.app accepted the surrender and you are still playing, so it should be pending: the other ' +
                  'players must accept it before it ends your game. (GameFeed shows no pending state, so this is ' +
                  'inferred, not read.)',
              };
            }
            return {
              status: 'unchanged' as const,
              game,
              ...state,
              warning:
                'war.app accepted the request, but GameFeed does not show your state changing yet. Check ' +
                'warapp_get_game shortly.',
            };
          },
          render: (r) => respond(undefined, ['compact'], () => r),
          batchable: false,
        }),
      ),
  );
}
