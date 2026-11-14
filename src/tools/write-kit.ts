// The write kit (#133): what every confirm-gated write shares — one refusal,
// one check that the signed-in account holds the seat being acted for, one
// send / classify / read-back, one outcome vocabulary, and one registration.
//
// Every write result carries `outcome`, from one vocabulary:
//   confirmed    — the effect was read back from game state.
//   accepted     — war.app accepted the request, and nothing more can be read back
//                  (a chat message; a surrender that now waits on the others).
//   unconfirmed  — war.app accepted the request, but the read-back failed or does not
//                  show the effect yet. Check before acting again.
//   unknown      — war.app did not answer, so the request may or may not have gone
//                  through. Never resend blindly.
//   not_applied  — the read-back shows the request did not take effect.
// A refusal from war.app (nothing changed) is an error, not a result.
//
// Each tool keeps its own `status` (and picks its `sent` / `verified`) beside it, since
// callers read them:
//   warapp_begin_turn     begun → confirmed; not_begun → not_applied; unconfirmed; unknown
//   warapp_join_game      joined → confirmed; unconfirmed; unknown
//   warapp_surrender      surrendered → confirmed; pending, still_playing → accepted;
//                         unchanged → unconfirmed; unknown
//   warapp_uncommit_turn  uncommitted → confirmed; unconfirmed; unknown
//   warapp_submit_turn    resolved, committed → confirmed; unknown after a send war.app
//                         accepted (read-back failed or shows nothing yet) → unconfirmed;
//                         unknown (no answer) → unknown
//   warapp_submit_picks   verified → confirmed; unconfirmed; unknown
//   warapp_send_chat      sent → accepted; unknown
//   warapp_link_session   linked → confirmed
import {
  defineWrite,
  McpToolError,
  registerWrite,
  type WriteDefinition,
} from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { Game, Player } from '../normalize.js';
import { WarappServerError } from '../protocol/rpc.js';
import { respond, untrustedText } from './common.js';
import { withToolConfig } from './hints.js';
import { failureText, type LiveContext } from './live-context.js';
import { resolvePlayer } from './resolve.js';

/** Refuse a write (or a read) before anything is sent. */
export function refuse(message: string, hint: string): never {
  throw new McpToolError(message, { kind: 'unknown', hint });
}

/** The hint when the signed-in account cannot be told: linking a session is suggested only locally. */
function signedInHint(hosted: boolean | undefined): string {
  return hosted
    ? 'Make sure a war.app tab signed in to your account is open and paired (reload or focus it if it is frozen), then retry.'
    : 'Make sure a war.app tab signed in to your account is open and paired (reload or focus it if it is frozen), or link ' +
        'a session with warapp_link_session, then retry.';
}

/** The one refusal when the signed-in account cannot be read; `consequence` ends the sentence. */
export function accountUnknown(hosted: boolean | undefined, consequence = 'nothing was sent'): McpToolError {
  return new McpToolError(`Could not tell which war.app account is signed in, so ${consequence}.`, {
    kind: 'unknown',
    hint: signedInHint(hosted),
  });
}

/**
 * The signed-in account's GameFeed id (its invite token), read fresh unless
 * `fresh: false`; refused when it cannot be read. Writes always act as that
 * account, so a write never goes ahead without it.
 */
export async function requireMe(
  ctx: Pick<LiveContext, 'myInviteToken' | 'hosted'>,
  opts: { fresh?: boolean; consequence?: string } = {},
): Promise<number> {
  const token = await ctx.myInviteToken({ fresh: opts.fresh ?? true });
  if (token === undefined) throw accountUnknown(ctx.hosted, opts.consequence);
  return token;
}

/** The seat of account `token` in `game`; refused when it holds none. */
export function mySeat(game: Game, token: number): Player {
  const seat = game.players.find((p) => p.id === token);
  if (!seat) {
    refuse(`The signed-in war.app account is not a player in game ${game.id}, so nothing was sent.`, 'Check the game id with warapp_my_games.');
  }
  return seat;
}

/** Refuse a seat that is no longer playing (eliminated, booted, surrendered, …). */
export function requirePlaying(game: Game, seat: Player): void {
  if (seat.state !== 'Playing') {
    refuse(`You are no longer playing in game ${game.id} (your state: ${seat.state ?? 'unknown'}).`, 'Check warapp_get_game.');
  }
}

/** Refuse an explicit `player` that is not the signed-in account `token`. */
function requireNamedIsMe(game: Game, token: number, input: string | number | undefined): void {
  if (input === undefined || String(input).trim() === '') return;
  const named = resolvePlayer(game.players, input);
  if (named.id !== token) {
    refuse(
      `${untrustedText(named.name)} is not the signed-in war.app account, so nothing was sent: writes always act as the signed-in account.`,
      'Omit `player` (it defaults to the signed-in account), or sign in to war.app as that player.',
    );
  }
}

/**
 * The signed-in account's seat in `game`, read fresh: refused when the account
 * cannot be read, when an explicit `player` names someone else, when it holds
 * no seat, and (unless `playing: false`) when the seat is no longer playing.
 */
export async function requireMySeat(
  ctx: Pick<LiveContext, 'myInviteToken' | 'hosted'>,
  game: Game,
  opts: { player?: string | number | undefined; playing?: boolean } = {},
): Promise<Player> {
  const token = await requireMe(ctx);
  requireNamedIsMe(game, token, opts.player);
  const seat = mySeat(game, token);
  if (opts.playing ?? true) requirePlaying(game, seat);
  return seat;
}

/**
 * One write's send and read-back; see {@link sendAndVerify}. Each outcome's
 * result type is its own (`U`nanswered, u`N`readable, `C`lassified).
 */
export interface SendAndVerify<A, U, N, C> {
  /** The request. A {@link WarappServerError} is war.app refusing it: nothing changed. */
  send: () => Promise<void>;
  /** A refusal: the error to throw instead (default: the refusal itself), or `'ignore'` to read back as if accepted. */
  refused?: (e: WarappServerError) => Error | 'ignore' | undefined;
  /** war.app did not answer (`failure`: what went wrong): the `unknown` result. Nothing is read back. */
  unanswered: (failure: string) => U;
  /** Read the effect back from game state. */
  readBack: () => Promise<A>;
  /** The read-back failed: an `unconfirmed` result (or the tool's equivalent). */
  unreadable: (failure: string, ignored: WarappServerError | undefined) => N;
  /** What was read back, classified. `ignored`: the refusal `refused` chose to ignore. */
  classify: (after: A, ignored: WarappServerError | undefined) => C | Promise<C>;
}

/**
 * Send a write, then read its effect back: a refusal from war.app throws
 * (nothing changed); no answer is `unanswered` (it may have gone through, so
 * nothing is read back and nothing is resent); otherwise the read-back is
 * classified, and a failed read-back is `unreadable`, never a success.
 */
export async function sendAndVerify<A, U, N, C>(spec: SendAndVerify<A, U, N, C>): Promise<U | N | C> {
  let ignored: WarappServerError | undefined;
  try {
    await spec.send();
  } catch (e) {
    if (!(e instanceof WarappServerError)) return spec.unanswered(failureText(e));
    const decided = spec.refused?.(e);
    if (decided !== 'ignore') throw decided ?? e;
    ignored = e;
  }
  let after: A;
  try {
    after = await spec.readBack();
  } catch (e) {
    return spec.unreadable(failureText(e), ignored);
  }
  return await spec.classify(after, ignored);
}

/** Rethrow a refusal in the client's own wording, when `wordings` has one for its code. */
export function worded(wordings: Readonly<Record<number, string>>): (e: WarappServerError) => Error | undefined {
  return (e) => {
    const wording = wordings[e.code];
    return wording ? new WarappServerError(e.code, `${wording} (war.app error ${e.code})`) : undefined;
  };
}

/**
 * Register a confirm-gated write (mcp-utils' `defineWrite` / `registerWrite`)
 * with its `title` and `_meta`, answered compact inside the untrusted envelope
 * and never batched, unless the definition says otherwise.
 */
export function defineGatedWrite<Schema extends z.ZodObject, State, Result>(
  server: McpServer,
  config: { title: string; _meta: Record<string, unknown> },
  def: WriteDefinition<Schema, State, Result>,
): void {
  withToolConfig(server, config, () =>
    registerWrite(
      server,
      defineWrite<Schema, State, Result>({
        render: (r) => respond(undefined, ['compact'], () => r),
        batchable: false,
        ...def,
      }),
    ),
  );
}
