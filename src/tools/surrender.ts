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
import { leavers, type Game, type Player } from '../normalize.js';
import { readOutlookLog } from '../outlook-log.js';
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
  /** #178: the others must accept the surrender (from the setting, else the player count). */
  acceptanceNeeded: boolean;
}

/** #178: opponents close to a boot are listed when the nearest boot is this close (a day). */
const LEAVER_WINDOW_MINUTES = 24 * 60;

/**
 * #178: whether the others must accept a surrender — from `InstantSurrender` when it reads, else
 * from the player count (more than two players still in), as before the setting was read.
 */
function acceptanceOf(game: Game, players: number): { needed: boolean; from: 'setting' | 'player count'; note: string } {
  const instant = game.endRules?.instantSurrender;
  if (instant === true)
    return { needed: false, from: 'setting', note: 'Surrender is instant in this game: it takes effect at once, without the others accepting it.' };
  if (instant === false)
    return {
      needed: true,
      from: 'setting',
      note:
        'Surrender is not instant in this game: the others must accept it before it ends your game, and until then ' +
        'it can be taken back (undo).' +
        (players <= 2 ? ' UNVERIFIED: whether a two-player game really waits for the opponent to accept.' : ''),
    };
  const raw = game.endRules?.instantSurrenderRaw;
  return {
    needed: players > 2,
    from: 'player count',
    note:
      `The InstantSurrender setting could not be read${raw !== undefined ? ` (${JSON.stringify(raw)})` : ' (not sent)'}, so this goes by the player count: ` +
      (players > 2 ? 'with more than two players, the others must accept the surrender.' : 'with two players, a surrender ends the game at once.'),
  };
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
  // GameFeed exposes no pending-surrender flag, so this can only refuse where a surrender is never
  // pending: an instant surrender (#178: from the setting), else the two-player case.
  if (undo && !acceptanceOf(game, activePlayers(game).length).needed) {
    refuse(
      game.endRules?.instantSurrender === true
        ? `There is no pending surrender to take back in game ${game.id}: surrender is instant in this game, so it is never pending.`
        : `There is no pending surrender to take back in game ${game.id}: with two players a surrender ends the game at once.`,
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
            'Surrender a war.app (Warzone) game as the signed-in account: you lose it and cannot rejoin. When the ' +
            "game's InstantSurrender setting asks for acceptance (unread: with more than two players) the surrender " +
            'waits for the others to accept it (reported `pending`); `undo: true` takes back such a pending ' +
            'surrender. The preview shows what bears on the decision: the outlook warapp_plan_turn last logged and ' +
            'its basis, AI opponents, whether acceptance is needed, what your land becomes (AI or neutral) and ' +
            'opponents close to a boot. The game is read from GameFeed first (finished games and games you are not ' +
            'playing are refused) and the outcome is read back from GameFeed.' +
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
            const acceptance = acceptanceOf(game, players);
            // #178: what bears on the decision — the outlook warapp_plan_turn last logged, the AI
            // opponents, what my land becomes, and opponents close to a boot.
            const log = ctx.dataDir ? await readOutlookLog(ctx.dataDir, gameId, me) : undefined;
            const outlook = log?.latest
              ? { turn: log.latest.turn, state: log.latest.state, heldTurns: log.latest.heldTurns, basis: log.latest.basis }
              : { state: null, note: 'No outlook logged for this game: warapp_plan_turn records one each turn it plans.' };
            const aiOpponents = game.players
              .filter((p) => p.id !== me && p.state === PLAYING && (p.isAI || p.humanTurnedIntoAI))
              .map((p) => ({ id: p.id, name: untrustedText(p.name) }));
            const surrenderedToAI = game.endRules?.surrenderedTurnIntoAI;
            const soon = leavers(game, Date.now(), { withinMinutes: LEAVER_WINDOW_MINUTES });
            const nameOf = (id: number) => untrustedText(game.players.find((p) => p.id === id)?.name ?? '');
            const leaving = soon.players
              .filter((l) => l.playerId !== me)
              .map(({ playerId, ...rest }) => ({ id: playerId, name: nameOf(playerId), ...rest }));
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
                  ...(takeBack ? {} : { acceptance }),
                  ...(takeBack || !acceptance.needed
                    ? {}
                    : { note: 'The others must accept the surrender before it ends your game.' }),
                  outlook,
                  aiOpponents,
                  yourLandBecomes: surrenderedToAI === undefined ? null : surrenderedToAI ? 'AI' : 'neutral',
                  ...(leaving.length ? { leavers: { players: leaving, unverified: soon.unverified } } : {}),
                  untrusted: UNTRUSTED_PREVIEW_NOTE,
                },
              },
              state: { gameId, name, me, undo: takeBack, acceptanceNeeded: acceptance.needed } satisfies SurrenderState,
            };
          },
          async execute({ gameId, name, me, undo, acceptanceNeeded }: SurrenderState) {
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
            } else if (seat?.state === PLAYING && acceptanceNeeded) {
              return {
                status: 'pending' as const,
                game,
                ...state,
                // GameFeed has no pending-surrender state: war.app accepted the request
                // and the seat is still Playing, which is what a pending surrender looks like.
                message:
                  'war.app accepted the surrender and you are still playing, so it should be pending: the other ' +
                  'players must accept it before it ends your game (the game asks for acceptance). (GameFeed shows no pending state, so this is ' +
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
