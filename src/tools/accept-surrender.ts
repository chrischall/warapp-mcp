// warapp_accept_surrender (#317): accept another player's pending surrender with the web client's
// AcceptSurrender (method 68), gated on the user's confirmation. The encoder is read from the client
// bundle and golden-pinned, UNVERIFIED live (docs/WEB-PROTOCOL.md "Accepting a surrender").
//
// A pending surrender lives only in the game details (src/surrender-pending.ts), so the plan reads
// them and refuses when no surrender is pending from that player or my acceptance is not owed; a
// finished game and a game I am not playing are refused first. The preview says what accepting does
// here: whose seat, whether its land turns neutral or goes to an AI, who borders that land (from the
// live board when it reads), whether it goes through now or others still owe theirs, whether it
// leaves only my side playing (a win), and in a free-for-all one advice line naming the neighbour
// that gains most (strategy note ffa-surrender-veto).
//
// The outcome is read back from game state — GameFeed (the seat SurrenderAccepted, handed to an AI,
// or the game over) and the game details (my id among those that accepted) — never from the reply,
// which carries no result, and nothing is ever resent.
import { CONFIRM_INJECTION_RULE, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { surrenderLand, winsOnAcceptance, type SurrenderLand } from '../analysis/accept-surrender.js';
import { parseGameId } from '../client.js';
import { inGameOf, playersByInGameId } from '../live.js';
import type { Game, Player } from '../normalize.js';
import { Method, writeAcceptSurrenderParams } from '../protocol/methods.js';
import { pendingSurrenders, seatPlaying, type DetailsSeat } from '../surrender-pending.js';
import { isTeamGame, teammatesOf } from '../teams.js';
import { gameIdArg, shownAccount, UNTRUSTED_PREVIEW_NOTE, untrustedText } from './common.js';
import { mintMeta } from './hints.js';
import { loadLiveTerritories, requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { mapOf } from './map.js';
import { resolvePlayer } from './resolve.js';
import { noBrowserNote } from './session.js';
import { readDetailsSeats } from './surrender-pending.js';
import { captureGameEvent, turnOfGame } from './decision-capture.js';
import { resolveTeamsFor } from './team-source.js';
import { defineGatedWrite, mySeat, refuse, requireMe, requirePlaying, sendAndVerify, worded } from './write-kit.js';

const PLAYING = 'Playing';
const FINISHED = 'Finished';
const DISTRIBUTING = 'DistributingTerritories';

/** The strategy note the free-for-all advice cites. */
export const FFA_SURRENDER_NOTE = 'ffa-surrender-veto';

/** The AcceptSurrender refusals, worded here from the codes' meaning (read from the bundle, UNVERIFIED live). */
const ACCEPT_ERRORS: Readonly<Record<number, string>> = {
  4: 'war.app says the game has ended: there is no surrender left to accept.',
  7: 'One of the two seats (yours or the surrendering player\'s) has left the game, so the acceptance was refused.',
  186: 'That player has taken its surrender back, so there is nothing to accept.',
  230: 'Your seat no longer takes part in the game, so war.app refused your acceptance.',
};

interface AcceptState {
  gameId: number;
  name: string;
  /** My GameFeed id. */
  me: number;
  /** The surrendering player's GameFeed id (`null`: no GameFeed player maps to its seat). */
  player: number | null;
  /** The surrendering player's in-game id (what AcceptSurrender names). */
  inGameId: number;
  /** Whether the surrendering seat was already an AI (or a human turned into one) at plan time: its read-back flag is then no evidence. */
  alreadyAI: boolean;
  /** #437: the turn being played at the preview, for the decision log's event. */
  turn?: number;
}

/** A seat named by both its ids, never one standing in for the other. */
interface SeatIds {
  /** GameFeed id; `null` when no GameFeed player maps to the seat. */
  player: number | null;
  inGameId: number;
}

const gameLabel = (game: Game): string => game.name ?? `game ${game.id}`;

/** The surrendering player the call names (or the one pending when none is named), refused when it has no pending surrender. */
function targetOf(game: Game, seats: readonly DetailsSeat[], meInGame: number | undefined, input: string | number | undefined) {
  const byInGame = playersByInGameId(game.players);
  const pending = pendingSurrenders(seats, meInGame, (id) => byInGame.get(id)?.id ?? null);
  const label = (p: (typeof pending)[number]) => {
    const pl = byInGame.get(p.inGameId);
    return pl ? `${untrustedText(pl.name)} (${pl.id})` : `in-game ${p.inGameId}`;
  };
  if (input === undefined || String(input).trim() === '') {
    if (!pending.length) {
      refuse(`No surrender is pending in game ${game.id}, so there is nothing to accept and nothing was sent.`, 'warapp_my_games and warapp_wait_for_turn report a pending surrender.');
    }
    if (pending.length > 1) {
      refuse(
        `More than one surrender is pending in game ${game.id}: ${pending.map(label).join(', ')}. Say which with \`player\`; nothing was sent.`,
        'Pass `player` as the surrendering player\'s name or id.',
      );
    }
    return pending[0]!;
  }
  const named = resolvePlayer(game.players, input);
  const id = inGameOf(named);
  const hit = pending.find((p) => p.inGameId === id);
  if (!hit) {
    refuse(
      `${untrustedText(named.name)} (${named.id}) has no surrender pending in game ${game.id}, so nothing was sent.`,
      pending.length ? `Pending: ${pending.map(label).join(', ')}.` : 'No surrender is pending in this game.',
    );
  }
  return hit;
}

/** The free-for-all advice line, or the win line; `undefined` in a team game that does not end. */
function adviceOf(opts: {
  wins: boolean | null;
  ffa: boolean;
  land: SurrenderLand | null;
  meInGame: number | undefined;
  /** A player named by id only: a write preview's sentences carry no names. */
  idOf: (inGame: number) => string;
  toAI: boolean | undefined;
  goesThroughNow: boolean;
  teamsKnown: boolean;
}): string | undefined {
  if (opts.wins === true) {
    return opts.goesThroughNow
      ? 'Accepting wins the game: once it goes through, no one off your side is left playing.'
      : 'Accepting wins the game once the others still owing their acceptance give it: no one off your side is left playing then.';
  }
  if (!opts.ffa) return undefined;
  const cite =
    `Strategy note ${FFA_SURRENDER_NOTE}: accept when the land helps you more than your rivals; refusing keeps the player in (it must move or be booted).` +
    (opts.teamsKnown ? '' : ' The teams could not be read, so a neighbour named here may be a teammate.');
  if (!opts.land) return `${cite} Who borders its land is unknown: the live board could not be read.`;
  const top = opts.land.neighbours[0];
  const ai = opts.toAI === true ? ' Its land goes to an AI, which keeps playing it, so it is not up for taking at once.' : '';
  if (!top) return `${cite} No player borders its land in view, so no neighbour gains it at once.${ai}`;
  const mine = opts.land.neighbours.find((n) => n.inGameId === opts.meInGame)?.bordering ?? 0;
  const fog = opts.land.hiddenNeighbours ? ` (${opts.land.hiddenNeighbours} territories beside it are hidden by fog)` : '';
  if (top.inGameId === opts.meInGame) {
    return `${cite} You border its land with the most territories (${top.bordering})${fog}, so of its neighbours you gain most from it.${ai}`;
  }
  return (
    `${cite} ${opts.idOf(top.inGameId)} borders its land with the most territories (${top.bordering}; you: ${mine})${fog}, ` +
    `so it gains most from it.${ai}`
  );
}

export function registerAcceptSurrenderTool(server: McpServer, ctx: LiveContext): void {
  defineGatedWrite(
    server,
    {
      title: "Accept a player's surrender in a war.app game",
      _meta: mintMeta('change', ['accept surrender', 'accept resignation warzone', 'let player surrender']),
    },
    {
      name: 'warapp_accept_surrender',
      description:
        "Accept another player's pending surrender in a war.app (Warzone) game as the signed-in account (where the " +
        "game's InstantSurrender setting asks the others to accept). Refused when no surrender is pending from that " +
        'player, when your acceptance is not owed (already given, or your seat cannot accept), in a finished game, ' +
        'and in a game you are not playing. `player` names the surrendering player (name or id); it may be omitted ' +
        'when one surrender is pending. The preview says what accepting does: whose seat, whether its land turns ' +
        'neutral or goes to an AI, which players border that land (live board), whether it goes through now or ' +
        'others still owe their acceptance, whether it leaves only your side playing (a win), and in a free-for-all ' +
        `one advice line naming the neighbour that gains most (strategy note ${FFA_SURRENDER_NOTE}). Accepting is the ` +
        "owner's decision. The outcome is read back from GameFeed and the game details (`accepted`, `pending` — others " +
        'still owe theirs —, `unconfirmed`, `unknown`). The encoding is read from the client bundle, UNVERIFIED live.' +
        `${noBrowserNote(ctx.hosted)} ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({
        title: "Accept a player's surrender in a war.app game",
        readOnly: false,
        destructive: true,
        idempotent: false,
        openWorld: true,
      }),
      inputSchema: z.object({
        game_id: gameIdArg,
        player: z
          .union([z.number(), z.string()])
          .optional()
          .describe('The surrendering player, by name or GameFeed id (optional when exactly one surrender is pending).'),
      }),
      async plan({ game_id, player }) {
        const gameId = parseGameId(game_id);
        const me = await requireMe(ctx);
        const feed = await ctx.client.getGame(gameId, { settings: true });
        if (feed.state === FINISHED) refuse(`Game ${gameId} is already over, so there is no surrender to accept.`, 'Check warapp_get_game.');
        if (feed.state !== PLAYING && feed.state !== DISTRIBUTING) {
          refuse(`Game ${gameId} has not started (game state: ${feed.state}), so there is no surrender to accept.`, 'Check warapp_get_game.');
        }
        const seat = mySeat(feed, me);
        requirePlaying(feed, seat);
        if (feed.endRules?.instantSurrender === true) {
          refuse(`Surrender is instant in game ${gameId}: it never waits for acceptance, so there is nothing to accept.`, 'Check warapp_get_game.');
        }
        const seats = await readDetailsSeats(ctx, gameId);
        if (!seats) {
          refuse(
            `Could not read game ${gameId}'s details, so whether a surrender is pending cannot be told and nothing was sent.`,
            'Make sure a war.app tab signed in to your account is open and paired (reload or focus it if it is frozen), then retry.',
          );
        }
        const meInGame = inGameOf(seat);
        const target = targetOf(feed, seats, meInGame, player);
        if (target.owedByMe !== true) {
          refuse(
            target.owedByMe === false
              ? `Your acceptance of that surrender is not owed in game ${gameId} (you already accepted it, or your seat cannot accept), so nothing was sent.`
              : `Your seat is not in game ${gameId}'s details, so whether your acceptance is owed cannot be told and nothing was sent.`,
            'Check warapp_my_games: it reports each pending surrender and whether it waits on you.',
          );
        }
        const { game, me: mine, known: teamsKnown } = await resolveTeamsFor(ctx, feed, seat);
        const byInGame = playersByInGameId(game.players);
        const surrendering = byInGame.get(target.inGameId);
        const idOf = (inGame: number) => {
          const p = byInGame.get(inGame);
          return p ? `player ${p.id}` : `in-game ${inGame}`;
        };
        const teammates = new Set(teammatesOf(game.players, mine).map((p) => p.id));
        const sideOf = (p: Player) => p.id === me || teammates.has(p.id);

        // Who must still accept, besides me: every other seat playing, neither an AI nor turned into one.
        const theirs = seats.find((s) => s.id === target.inGameId);
        const othersStillToAccept = seats
          .filter((s) => s.id !== target.inGameId && s.id !== meInGame && seatPlaying(s) && !s.ai && !s.turnedAI)
          .filter((s) => !(theirs?.acceptedBy ?? []).includes(s.id))
          .map((s): SeatIds => ({ player: byInGame.get(s.id)?.id ?? null, inGameId: s.id }));
        const goesThroughNow = othersStillToAccept.length === 0;

        // What the land becomes: an AI seat when the setting says so and the player is not already one.
        const toAISetting = game.endRules?.surrenderedTurnIntoAI;
        const alreadyAI = surrendering ? surrendering.isAI || surrendering.humanTurnedIntoAI : false;
        const toAI = toAISetting === undefined ? undefined : toAISetting && !alreadyAI;
        const remaining = game.players
          .filter((p) => p.state === PLAYING && p.id !== surrendering?.id)
          .map((p) => ({ id: p.id, ai: p.isAI || p.humanTurnedIntoAI, mine: sideOf(p) }));
        const raw = winsOnAcceptance(remaining, toAI, game.endRules?.aisSurrenderWhenOneHumanRemains);
        // A seat that may be my teammate makes "no rival left" unknowable, unless no one else is left at all.
        const wins = raw === true && !teamsKnown && remaining.some((s) => s.id !== me) ? null : raw;
        const ffa = !isTeamGame(game.players);

        // Who borders the land, from the live board when it reads.
        let land: SurrenderLand | null = null;
        try {
          const territories = await loadLiveTerritories(ctx, game);
          const map = mapOf(game);
          land = surrenderLand(territories, new Map(map.territories.map((t) => [t.id, t.connectedTo])), target.inGameId);
        } catch {
          land = null;
        }
        const advice = adviceOf({ wins, ffa, land, meInGame, idOf, toAI, goesThroughNow, teamsKnown });
        const who = `player ${target.player ?? `in-game ${target.inGameId}`}`;
        const summary = `Accept ${who}'s surrender in war.app game ${gameId}`;
        return {
          gate: {
            action: 'warapp.accept_surrender',
            summary,
            account: writeAccount(me),
            target: gameId,
            payload: { method: 'AcceptSurrender', gameId, playerId: target.inGameId, accept: true },
            willSend: { game: gameId, player: target.player, inGameId: target.inGameId, accept: true },
            preview: {
              warning:
                `This accepts ${who}'s surrender in game ${gameId}` +
                (goesThroughNow ? ': yours is the last acceptance owed, so it goes through.' : ': others still owe theirs, so it stays pending until they accept.'),
              account: shownAccount(seat.name, me),
              game: { id: gameId, name: game.name === undefined ? null : untrustedText(game.name), state: game.state },
              seat: {
                player: target.player,
                inGameId: target.inGameId,
                name: surrendering ? untrustedText(surrendering.name) : null,
              },
              landBecomes: toAI === undefined ? null : toAI ? 'AI' : 'neutral',
              land: land
                ? {
                    territoriesInView: land.territories.length,
                    borderedBy: land.neighbours.map((n) => {
                      const p = byInGame.get(n.inGameId);
                      return {
                        player: p?.id ?? null,
                        inGameId: n.inGameId,
                        name: p ? untrustedText(p.name) : null,
                        territoriesBordering: n.bordering,
                        ...(n.inGameId === meInGame ? { you: true } : p && teammates.has(p.id) ? { teammate: true } : {}),
                      };
                    }),
                    hiddenNeighbours: land.hiddenNeighbours,
                  }
                : null,
              othersStillToAccept,
              goesThroughNow,
              winsGame: wins,
              ...(advice ? { advice } : {}),
              unverified: 'AcceptSurrender is read from the client bundle and not yet verified live; the outcome is read back from game state.',
              untrusted: UNTRUSTED_PREVIEW_NOTE,
            },
          },
          state: { gameId, name: gameLabel(game), me, player: target.player, inGameId: target.inGameId, alreadyAI, turn: turnOfGame(game) } satisfies AcceptState,
        };
      },
      async execute({ gameId, name, me, player, inGameId, alreadyAI, turn }: AcceptState) {
        await requireApprovedAccount(ctx, writeAccount(me));
        const game = { id: gameId, name };
        const who = { player, inGameId };
        const result = await sendAndVerify({
          send: async () => {
            await ctx.rpc.call('AcceptSurrender', Method.AcceptSurrender, (w) =>
              writeAcceptSurrenderParams(w, { gameId, playerId: inGameId, accept: true }),
            );
          },
          refused: worded(ACCEPT_ERRORS),
          unanswered: (failure) => ({
            status: 'unknown' as const,
            outcome: 'unknown' as const,
            game,
            ...who,
            warning:
              `war.app did not confirm the acceptance (${failure}), so it may already have gone through. ` +
              'Check warapp_my_games or warapp_get_game before doing anything else.',
          }),
          readBack: async () => {
            const after = await ctx.client.getGame(gameId, { map: false });
            const seats = await readDetailsSeats(ctx, gameId);
            return { after, seats };
          },
          unreadable: (failure) => ({
            status: 'unconfirmed' as const,
            outcome: 'unconfirmed' as const,
            game,
            ...who,
            warning: `war.app took the request, but GameFeed could not be read back (${failure}). Check warapp_my_games.`,
          }),
          classify: ({ after, seats }) => {
            // By GameFeed id when known, else by the in-game id its GameFeed id wraps: never one against the other.
            const theirs = after.players.find((p) => (player !== null ? p.id === player : inGameOf(p) === inGameId));
            const state = { theirState: theirs?.state ?? null, gameState: after.state };
            // Turned into an AI counts only when it was not one already at plan time.
            const turnedAINow = !alreadyAI && theirs?.humanTurnedIntoAI === true;
            if (after.state === FINISHED || theirs?.state === 'SurrenderAccepted' || turnedAINow) {
              return { status: 'accepted' as const, outcome: 'confirmed' as const, game, ...who, ...state };
            }
            const detail = seats?.find((s) => s.id === inGameId);
            const meInGame = (() => {
              const p = after.players.find((x) => x.id === me);
              return p ? inGameOf(p) : undefined;
            })();
            if (detail && !seatPlaying(detail)) {
              return { status: 'accepted' as const, outcome: 'confirmed' as const, game, ...who, ...state };
            }
            if (detail?.surrendered && meInGame !== undefined && detail.acceptedBy.includes(meInGame)) {
              return {
                status: 'pending' as const,
                outcome: 'confirmed' as const,
                game,
                ...who,
                ...state,
                message: 'Your acceptance is recorded; the surrender stays pending until the others still owing theirs accept it.',
              };
            }
            return {
              status: 'unconfirmed' as const,
              outcome: 'unconfirmed' as const,
              game,
              ...who,
              ...state,
              warning:
                (detail && !detail.surrendered
                  ? 'The game details show the surrender no longer pending and the player still playing: it may have been taken back. '
                  : seats
                    ? 'war.app took the request, but the game details do not show your acceptance yet. '
                    : 'war.app took the request, but the game details could not be read back. ') +
                'Check warapp_my_games shortly; do not send it again blindly.',
            };
          },
        });
        // #437: my acceptance, once confirmed, into the decision log (by GameFeed id; a seat without one is not kept).
        if (result.outcome === 'confirmed' && player !== null && turn !== undefined) {
          await captureGameEvent(ctx, gameId, me, { turn, kind: 'surrender-accepted-by-me', player }, { create: true });
        }
        return result;
      },
    },
  );
}
