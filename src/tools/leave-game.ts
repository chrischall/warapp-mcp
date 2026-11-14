// warapp_leave_game: give up the signed-in account's seat in a game that has not started
// (`WaitingForPlayers`) with the web client's DeclineGame (method 64) — the lobby's Decline
// button, gated on the user's confirmation (#217). The encoding is read from the client bundle's
// writer, verified live 2026-11-14 for an open-seat lobby (docs/WEB-PROTOCOL.md "DeclineGame"). The game is read from GameFeed
// first (refused once started, for a seat the account does not hold, and for mod games), and the
// leave is reported only once GameFeed (else GetMyGames) shows the account no longer seated —
// never from the reply, whose one bool says whether war.app removed the account's chat.
import { CONFIRM_INJECTION_RULE, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseGameId } from '../client.js';
import type { Game, Player } from '../normalize.js';
import { holdsSeat, playerStateName } from '../player-states.js';
import { Method, readDeclineGameReturn, writeDeclineGameParams } from '../protocol/methods.js';
import { WarappServerError } from '../protocol/rpc.js';
import { gameIdArg, shownAccount, UNTRUSTED_PREVIEW_NOTE, untrustedText } from './common.js';
import { mintMeta } from './hints.js';
import { requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { fetchMyGames } from './my-games.js';
import { defineGatedWrite, mySeat, refuse, requireMe, sendAndVerify } from './write-kit.js';

/** The only game state a seat can be left in: the lobby, still filling. */
const LOBBY = 'WaitingForPlayers';

/**
 * The DeclineGame refusals the client words (read from the bundle). It also swallows 17
 * (NotInGame), 4 and 7 (InvalidPlayerState) without a word; here 17 and 7 are read back from
 * game state like an accepted leave, and 4 — the game has begun, so the seat was kept — is worded.
 */
const LEAVE_ERRORS: Readonly<Record<number, string>> = {
  191: 'You cannot leave an open game you created; delete it in war.app instead.',
  88: 'This game has been deleted.',
};
/**
 * NotInGame and the codes the client swallows (4, 7): the seat may already be gone, so game
 * state decides rather than a guessed wording.
 */
const READ_BACK_ERRORS = new Set([17, 4, 7]);

interface LeaveState {
  gameId: number;
  name: string;
  /** The account the plan checked and the gate bound (its GameFeed id). */
  me: number;
}

/** The signed-in account's seat in lobby `game`, refused unless the account holds one there. */
function leavable(game: Game, token: number): Player {
  if (game.state !== LOBBY) {
    refuse(
      `Game ${game.id} is not a lobby (game state: ${game.state}): only a game still ${LOBBY} can be left, so nothing was sent.`,
      'A game that has started is surrendered with warapp_surrender, not left.',
    );
  }
  const seat = mySeat(game, token);
  if (!holdsSeat(seat.state)) {
    refuse(
      `You hold no seat in game ${game.id} (your state: ${seat.state ?? 'unknown'}), so there is nothing to leave.`,
      'An invitation is declined in war.app; check warapp_my_games.',
    );
  }
  // Unread settings are treated as possibly modded: the mod-hook flag is sent false, which a
  // mod game could refuse or mishandle.
  const mods = game.settings?.mods;
  if (mods === undefined || mods !== 0) {
    refuse(
      mods === undefined
        ? `Game ${game.id}'s settings could not be read, so whether it uses mods is unknown and nothing was sent.`
        : `Game ${game.id} uses mods, which can hook leaving the game in ways this tool cannot reproduce, so nothing was sent.`,
      'Leave it from war.app instead.',
    );
  }
  return seat;
}

/** GameFeed's answer for a game the account is no longer in (seen live after a leave, #217). */
const NOT_IN_GAME = /can only be used for games you are in/i;

/**
 * Whether game state shows account `me` (its GameFeed id) out of the game: GameFeed listing it
 * with no seat (declined) or not at all, else GetMyGames listing the game with its seat given up.
 * A game missing from GetMyGames proves nothing (the list is paged), and nothing read is `false`.
 */
async function confirmLeft(ctx: LiveContext, gameId: number, me: number): Promise<boolean> {
  try {
    const game = await ctx.client.getGame(gameId, { map: false });
    const seat = game.players.find((p) => p.id === me);
    return !seat || !holdsSeat(seat.state);
  } catch (e) {
    // Seen live (#217): once the seat is given up, GameFeed refuses the game outright ("This API
    // can only be used for games you are in, tournament games…") instead of listing me as gone.
    if (e instanceof Error && NOT_IN_GAME.test(e.message)) return true;
    // No GameFeed credentials or another failed read: try the web client's list.
  }
  try {
    const { me: inGame, games } = await fetchMyGames(ctx);
    const seat = games.find((g) => g.id === gameId)?.players.find((p) => p.id === inGame);
    return seat !== undefined && !holdsSeat(playerStateName(seat.stateCode));
  } catch {
    return false;
  }
}

export function registerLeaveGameTool(server: McpServer, ctx: LiveContext): void {
  defineGatedWrite(
    server,
    {
      title: 'Leave a war.app game that has not started',
      _meta: mintMeta('change', ['leave game', 'leave a lobby', 'back out of a game', 'quit a lobby']),
    },
    {
      name: 'warapp_leave_game',
      description:
        'Leave a war.app (Warzone) game that has not started — a lobby still WaitingForPlayers — giving up your ' +
        "seat (war.app's DeclineGame, the lobby's Decline button; verified live for a lobby joined through an open " +
        'seat). Refuses a game that has started (surrender it with warapp_surrender), a lobby you ' +
        'hold no seat in, and mod games. Always as the signed-in war.app account; reported `left` only once ' +
        'GameFeed (or your games list) no longer shows you seated — `unconfirmed` otherwise, or `unknown` when ' +
        `war.app did not answer (never resend blindly). ${BRIDGE_NOTE} ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({
        title: 'Leave a war.app lobby',
        readOnly: false,
        destructive: true,
        idempotent: false,
        openWorld: true,
      }),
      inputSchema: z.object({ game_id: gameIdArg }),
      async plan({ game_id }) {
        const game = await ctx.client.getGame(parseGameId(game_id), { settings: true, map: false });
        const token = await requireMe(ctx);
        const seat = leavable(game, token);
        const teamGame = game.players.some((p) => p.team !== undefined && p.team >= 0);
        return {
          gate: {
            action: 'warapp.leave_game',
            // By id only: the game and player names (other people's words) go, delimited, in labelled fields.
            summary: `Leave war.app game ${game.id}, which has not started, giving up your seat`,
            account: writeAccount(seat.id),
            target: game.id,
            payload: { method: 'DeclineGame', gameId: game.id },
            willSend: { game: game.id, player: untrustedText(seat.name) },
            preview: {
              warning:
                `This gives up your seat in game ${game.id}. You can only come back through an open seat that is ` +
                'still free, and war.app may remove the chat messages you sent to the game.' +
                (teamGame ? ' It is a team game: leaving can leave your teammates a player short.' : ''),
              account: shownAccount(seat.name, seat.id),
              game: {
                id: game.id,
                name: game.name === undefined ? null : untrustedText(game.name),
                state: game.state,
                players: game.players.filter((p) => holdsSeat(p.state)).length,
              },
              untrusted: UNTRUSTED_PREVIEW_NOTE,
            },
          },
          state: { gameId: game.id, name: game.name ?? `game ${game.id}`, me: seat.id } satisfies LeaveState,
        };
      },
      async execute({ gameId, name, me }: LeaveState) {
        await requireApprovedAccount(ctx, writeAccount(me));
        const game = { id: gameId, name };
        let chatRemoved: boolean | undefined;
        const extra = () => (chatRemoved ? { chatRemoved: true } : {});
        const check = 'Check warapp_my_games (or warapp_get_game) before doing anything else.';
        return sendAndVerify({
          send: async () => {
            const env = await ctx.rpc.call('DeclineGame', Method.DeclineGame, (w) => writeDeclineGameParams(w, gameId));
            try {
              chatRemoved = readDeclineGameReturn(env.body);
            } catch {
              // An unreadable reply bool is only the chat note: the leave is read back below.
            }
          },
          refused: (e) => {
            if (READ_BACK_ERRORS.has(e.code)) return 'ignore';
            const wording = LEAVE_ERRORS[e.code];
            return wording ? new WarappServerError(e.code, `${wording} (war.app error ${e.code})`) : undefined;
          },
          unanswered: (failure) => ({
            status: 'unknown' as const,
            outcome: 'unknown' as const,
            game,
            warning: `war.app did not confirm the leave (${failure}), so you may already have left. ${check}`,
          }),
          // Never throws: nothing read is "not shown".
          readBack: () => confirmLeft(ctx, gameId, me),
          unreadable: () => ({ status: 'unconfirmed' as const, outcome: 'unconfirmed' as const, game, warning: check }),
          classify: (left) =>
            left
              ? { status: 'left' as const, outcome: 'confirmed' as const, game, ...extra() }
              : {
                  status: 'unconfirmed' as const,
                  outcome: 'unconfirmed' as const,
                  game,
                  ...extra(),
                  warning:
                    'war.app accepted the request, but GameFeed still shows you seated (or could not be read, and ' +
                    `your games list does not show the seat given up), so the leave could not be confirmed. ${check}`,
                },
        });
      },
    },
  );
}
