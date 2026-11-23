// warapp_close_finished_game (#523): close out a finished game so the app's My Games stops listing it, gated on the
// user's confirmation. The client has no hide or remove call: when it shows a finished game's end-of-game window
// (Victory / Defeat, `EndGameWindowVM`) it sets my seat's SeenEndGameWindow and asks GetEndGameWindowData (85) — the
// only server call there, so the one that records the flag. The app's My Games is GetMyGames' Default list, which
// (read live 2026-11-23, read-only) holds finished games only while that flag is clear: of 37 finished games in the
// All list, the 18 unseen were all in Default and the 19 seen none. Parameters as UnCommit's (auth, int32 game id),
// from the bundle's writer; VERIFIED live 2026-11-23 (a finished game closed: confirmed by the games-list read-back; a second call refused it as already closed, nothing sent).
//
// It reaches no other player. Read back from GetMyGames (All): GameInfo field 20, `seenEndGame` (`closed`, confirmed);
// still clear or not listed is `unconfirmed`; no answer `unknown`, never resent.
import { CONFIRM_INJECTION_RULE, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseGameId } from '../client.js';
import { holdsSeat } from '../player-states.js';
import { Method, writeGetEndGameWindowDataParams } from '../protocol/methods.js';
import { gameIdArg, shownAccount } from './common.js';
import { mintMeta } from './hints.js';
import { requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { fetchMyGames } from './my-games.js';
import { defineGatedWrite, refuse, requireMe, sendAndVerify } from './write-kit.js';

interface CloseState {
  gameId: number;
  /** My GameFeed id, bound by the gate. */
  me: number;
}

/** The game's seen flag in my games list: `true` seen, `false` listed unseen, `undefined` not listed or unread. */
async function seenInList(ctx: LiveContext, gameId: number): Promise<boolean | undefined> {
  try {
    const g = (await fetchMyGames(ctx)).games.find((x) => x.id === gameId);
    return g ? g.seenEndGame === true : undefined;
  } catch {
    return undefined;
  }
}

export function registerCloseFinishedGameTool(server: McpServer, ctx: LiveContext): void {
  defineGatedWrite(
    server,
    {
      title: 'Close out a finished war.app game',
      _meta: mintMeta('change', ['close finished game', 'hide finished game', 'remove from my games', 'clear ended game', 'dismiss defeat screen']),
    },
    {
      name: 'warapp_close_finished_game',
      description:
        "Close out a finished war.app (Warzone) game of yours so the app's My Games stops listing it — what viewing its " +
        "Victory / Defeat window does: war.app's GetEndGameWindowData, which marks your seat SeenEndGameWindow (the app's " +
        'My Games lists a finished game only while that is clear). Reaches no other player and changes nothing in the ' +
        'game. Refuses a game not finished, one you did not play, and one already closed out. Reported `closed` only once ' +
        'your games list shows it seen; `unconfirmed` otherwise, `unknown` when war.app did not answer (never resend ' +
        `blindly). Verified live: closing a finished game was confirmed by the games-list read-back. ${BRIDGE_NOTE} ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({
        title: 'Close out a finished war.app game',
        readOnly: false,
        destructive: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: z.object({ game_id: gameIdArg }),
      async plan({ game_id }) {
        const game = await ctx.client.getGame(parseGameId(game_id), { map: false });
        const token = await requireMe(ctx);
        if (game.state !== 'Finished') {
          refuse(`Game ${game.id} is not finished (game state: ${game.state}), so there is nothing to close out and nothing was sent.`, 'Only a finished game leaves My Games this way.');
        }
        const seat = game.players.find((p) => p.id === token);
        if (!seat || !holdsSeat(seat.state)) {
          refuse(`You did not play game ${game.id} (no seat of yours there), so it is not in your games and nothing was sent.`, 'Check warapp_my_games.');
        }
        if ((await seenInList(ctx, game.id)) === true) {
          refuse(
            `Game ${game.id} is already closed out: your games list shows its end-of-game window seen, so the app's My Games no longer lists it. Nothing was sent.`,
            'If the app still shows it, refresh the app: its list is cached.',
          );
        }
        return {
          gate: {
            action: 'warapp.close_finished_game',
            summary: `Close out finished war.app game ${game.id} (mark its end-of-game window seen) so My Games stops listing it`,
            account: writeAccount(seat.id),
            target: game.id,
            payload: { method: 'GetEndGameWindowData', gameId: game.id },
            willSend: { game: game.id },
            preview: {
              note: 'Reaches no other player and changes nothing in the game; the game stays readable (warapp_get_game, its history).',
              account: shownAccount(seat.name, seat.id),
              game: { id: game.id, state: game.state, myState: seat.state ?? null },
              verification: 'Verified live (2026-11-23).',
            },
          },
          state: { gameId: game.id, me: seat.id } satisfies CloseState,
        };
      },
      async execute({ gameId, me }: CloseState) {
        await requireApprovedAccount(ctx, writeAccount(me));
        const game = { id: gameId };
        const check = 'Check warapp_my_games before doing anything else.';
        return sendAndVerify({
          send: async () => {
            await ctx.rpc.call('GetEndGameWindowData', Method.GetEndGameWindowData, (w) => writeGetEndGameWindowDataParams(w, gameId));
          },
          unanswered: (failure) => ({
            status: 'unknown' as const,
            outcome: 'unknown' as const,
            game,
            warning: `war.app did not answer (${failure}), so the game may already be closed out. ${check}`,
          }),
          readBack: () => seenInList(ctx, gameId),
          unreadable: () => ({ status: 'unconfirmed' as const, outcome: 'unconfirmed' as const, game, warning: check }),
          classify: (seen) =>
            seen === true
              ? { status: 'closed' as const, outcome: 'confirmed' as const, game }
              : {
                  status: 'unconfirmed' as const,
                  outcome: 'unconfirmed' as const,
                  game,
                  warning: `war.app accepted the request, but your games list ${seen === false ? 'still shows the end-of-game window unseen' : 'does not list the game'}. ${check}`,
                },
        });
      },
    },
  );
}
