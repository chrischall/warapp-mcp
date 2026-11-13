// warapp_uncommit_turn: withdraw the signed-in account's committed orders for
// the current turn with the web client's UnCommit (method 80) — the client's
// "Modify orders" — gated on the user's confirmation. The game is read from
// GameFeed first (refused outside a turn phase, for a game the account is not
// playing, or when nothing is committed), and the outcome is read back from
// GameFeed afterwards: UnCommit's reply carries no result.
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
import { Method, writeUnCommitParams } from '../protocol/methods.js';
import { WarappServerError } from '../protocol/rpc.js';
import { gameIdArg, respond, shownAccount, UNTRUSTED_PREVIEW_NOTE, untrustedText } from './common.js';
import { signedInHint } from './session.js';
import { mintMeta, withToolConfig } from './hints.js';
import { failureText, requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { currentTurn, requireTurnPhase } from './turn.js';

const PLAYING = 'Playing';

/** The UnCommit refusals the client handles, in its own terms (read from the bundle). */
const UNCOMMIT_ERRORS: Readonly<Record<number, string>> = {
  99: 'The other players committed their orders first, so the turn is resolving with yours; they could not be withdrawn.',
  4: 'The game is over, so there are no orders to withdraw.',
  7: 'You are no longer in the game, so your orders could not be withdrawn.',
  230: 'You are no longer in the game, so your orders could not be withdrawn.',
};

interface UncommitState {
  gameId: number;
  name: string;
  me: number;
  turnsBefore: number | null;
  turn: number | null;
}

function refuse(message: string, hint: string): never {
  throw new McpToolError(message, { kind: 'unknown', hint });
}

/** The signed-in account's seat in `game`, refused unless it has orders committed this turn. */
function uncommittable(game: Game, token: number): Player {
  requireTurnPhase(game);
  const seat = game.players.find((p) => p.id === token);
  if (!seat) {
    refuse(`The signed-in war.app account is not a player in game ${game.id}.`, 'Check the game id with warapp_my_games.');
  }
  if (seat.state !== PLAYING) {
    refuse(
      `You are no longer playing in game ${game.id} (your state: ${seat.state ?? 'unknown'}).`,
      'Check warapp_get_game.',
    );
  }
  if (!seat.hasCommittedOrders) {
    refuse(
      `Your orders for this turn of game ${game.id} are not committed, so there is nothing to withdraw.`,
      'Submit orders with warapp_submit_turn; check warapp_get_game for your committed flag.',
    );
  }
  return seat;
}

export function registerUncommitTool(server: McpServer, ctx: LiveContext): void {
  withToolConfig(
    server,
    {
      title: 'Withdraw my committed orders in a war.app game',
      _meta: mintMeta('change', ['uncommit my turn', 'modify my orders', 'withdraw my orders', 'undo my commit']),
    },
    () =>
      registerWrite(
        server,
        defineWrite({
          name: 'warapp_uncommit_turn',
          description:
            'Withdraw your committed orders for the current turn of a war.app (Warzone) game (war.app\'s UnCommit, ' +
            'the client\'s "Modify orders"), so a corrected turn can be submitted with warapp_submit_turn before the ' +
            'turn resolves. Refuses outside a turn phase, for a game you are not playing, or when your orders are not ' +
            'committed. The game then waits on you again, so recommit before the boot timer runs out. Always as the ' +
            'signed-in war.app account; the outcome is read back from GameFeed (`uncommitted`, `unconfirmed`, or ' +
            `\`unknown\` when war.app did not answer — never resend blindly). ${BRIDGE_NOTE} ${CONFIRM_INJECTION_RULE}`,
          annotations: toolAnnotations({
            title: 'Withdraw committed war.app orders',
            readOnly: false,
            destructive: true,
            idempotent: false,
            openWorld: true,
          }),
          inputSchema: z.object({ game_id: gameIdArg }),
          async plan({ game_id }) {
            const game = await ctx.client.getGame(parseGameId(game_id));
            requireTurnPhase(game);
            const token = await ctx.myInviteToken({ fresh: true });
            if (token === undefined) {
              refuse(
                'Could not tell which war.app account is signed in, so nothing was sent.',
                signedInHint(ctx.hosted),
              );
            }
            const seat = uncommittable(game, token);
            const name = game.name ?? `game ${game.id}`;
            const turn = currentTurn(game);
            const turnLabel = turn === null ? 'this turn' : `turn ${turn}`;
            return {
              gate: {
                action: 'warapp.uncommit_turn',
                // By id only: the game and player names (other people's words) go, delimited,
                // in labelled fields.
                summary: `Withdraw your committed orders for ${turnLabel} of war.app game ${game.id}`,
                account: writeAccount(seat.id),
                target: game.id,
                payload: { method: 'UnCommit', gameId: game.id },
                willSend: { game: game.id, player: untrustedText(seat.name), turn },
                preview: {
                  warning:
                    `This withdraws your committed orders for ${turnLabel} of game ${game.id}. The game then waits on you ` +
                    'again: submit corrected orders with warapp_submit_turn before the boot timer runs out, or you ' +
                    'may be booted.',
                  account: shownAccount(seat.name, seat.id),
                  game: { id: game.id, name: game.name === undefined ? null : untrustedText(game.name), turn },
                  untrusted: UNTRUSTED_PREVIEW_NOTE,
                },
              },
              state: {
                gameId: game.id,
                name,
                me: seat.id,
                turnsBefore: game.numberOfTurns ?? null,
                turn,
              } satisfies UncommitState,
            };
          },
          async execute({ gameId, name, me, turnsBefore, turn }: UncommitState) {
            await requireApprovedAccount(ctx, writeAccount(me));
            const base = { game: { id: gameId, name }, turn };
            const check = 'Check warapp_get_game (your committed flag, the turn count) before doing anything else.';
            try {
              await ctx.rpc.call('UnCommit', Method.UnCommit, (w) => writeUnCommitParams(w, gameId));
            } catch (e) {
              if (e instanceof WarappServerError) {
                const wording = UNCOMMIT_ERRORS[e.code];
                throw wording ? new WarappServerError(e.code, `${wording} (war.app error ${e.code})`) : e;
              }
              return {
                status: 'unknown' as const,
                ...base,
                warning:
                  `war.app did not confirm the withdrawal (${failureText(e)}), so it may ` +
                  `already have gone through. ${check}`,
              };
            }

            let after: Game;
            try {
              after = await ctx.client.getGame(gameId);
            } catch (e) {
              return {
                status: 'unconfirmed' as const,
                ...base,
                warning:
                  `war.app accepted the request, but GameFeed could not be read back ` +
                  `(${e instanceof Error ? e.message : String(e)}). ${check}`,
              };
            }
            // A resolved turn also clears everyone's committed flag, so without both turn
            // counts "not committed" cannot be told apart from "already played".
            if (turnsBefore === null || after.numberOfTurns === undefined) {
              return {
                status: 'unconfirmed' as const,
                ...base,
                warning:
                  "war.app accepted the request, but GameFeed gave no turn count, so a withdrawal cannot be told " +
                  'apart from a turn that already resolved. Check warapp_get_game and the live board.',
              };
            }
            if (after.numberOfTurns > turnsBefore) {
              return {
                status: 'unconfirmed' as const,
                ...base,
                warning:
                  `The turn already resolved (the game is now on turn ${after.numberOfTurns + 1}), so the orders ` +
                  'were most likely played as committed. Check warapp_get_game and the live board.',
              };
            }
            const seat = after.players.find((p) => p.id === me);
            if (seat && !seat.hasCommittedOrders) {
              return {
                status: 'uncommitted' as const,
                ...base,
                detail:
                  'Your orders are withdrawn and the game is waiting on you again: submit corrected orders with ' +
                  'warapp_submit_turn (e.g. from warapp_plan_turn) before the boot timer runs out.',
              };
            }
            return {
              status: 'unconfirmed' as const,
              ...base,
              warning:
                'war.app accepted the request, but GameFeed still shows your orders committed. ' +
                'Check warapp_get_game shortly before submitting again.',
            };
          },
          render: (r) => respond(undefined, ['compact'], () => r),
          batchable: false,
        }),
      ),
  );
}
