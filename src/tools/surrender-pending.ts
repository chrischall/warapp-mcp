// Reading the surrenders pending in a game (#317), for warapp_my_games, warapp_wait_for_turn and
// warapp_plan_turn. A pending surrender lives only in the game details (src/surrender-pending.ts):
// one GameRefresh (40) asked for the details and not the chat. UNVERIFIED live.
//
// Never throws: a failed or unreadable read is `null` (unknown), never an empty list — an empty list
// is a game whose details were read and showed no surrender pending.

import type { Game, Player } from '../normalize.js';
import { inGameOf } from '../live.js';
import { Method, writeGameRefreshParams } from '../protocol/methods.js';
import { pendingSurrenders, readGameDetailsSeats, type PendingSurrender } from '../surrender-pending.js';
import { untrustedText } from './common.js';
import type { LiveContext } from './live-context.js';

/** Where the read comes from, for a result's note. */
export const SURRENDER_PENDING_NOTE =
  "Read from the game details (the web client's GameRefresh), UNVERIFIED live: a list is what the details showed " +
  '(empty: no surrender pending); null means they could not be read, not that none is pending. A lobby, a finished ' +
  'game and a game you no longer play in are empty without a read (#327): no surrender there can wait on you. owedByMe true: the ' +
  'player is waiting for you to accept its surrender. Accepting is the owner\'s decision (it hands that player\'s land ' +
  'on and can end the game).';

/** Game states in which a surrender can be pending. */
const IN_PLAY: ReadonlySet<string> = new Set(['Playing', 'DistributingTerritories']);

/**
 * Whether a pending surrender can matter to me in a game: it is being played or picked and my seat is
 * still playing. Elsewhere no read is made, and the answer is an empty list (#327: a lobby or a finished
 * game has no surrender pending, and a game I am out of owes none from me — nothing failed to read).
 */
export function surrenderMayBePending(state: string, mySeatState: string | undefined): boolean {
  return IN_PLAY.has(state) && mySeatState === 'Playing';
}

/**
 * Read the game details' seats: one GameRefresh for the details only. `undefined` when the reply is
 * unreadable; a failed request (a timeout, a call not sent, a refusal) throws, so a caller that reads
 * many times can stop asking (warapp_wait_for_turn: a frozen tab stalls every call until it times out).
 */
export async function fetchDetailsSeats(ctx: Pick<LiveContext, 'rpc' | 'bundle'>, gameId: number) {
  const env = await ctx.rpc.call('GameRefresh', Method.GameRefresh, (w) =>
    writeGameRefreshParams(w, { gameId, chat: false, nonChat: true, lobby: false }),
  );
  return readGameDetailsSeats(await ctx.bundle(), env.body);
}

/** {@link fetchDetailsSeats} that never throws: any failure is `undefined` (unknown). */
export async function readDetailsSeats(ctx: Pick<LiveContext, 'rpc' | 'bundle'>, gameId: number) {
  try {
    return await fetchDetailsSeats(ctx, gameId);
  } catch {
    return undefined;
  }
}

/** One pending surrender as a result reports it: the player's GameFeed id, its name (untrusted) and whether I owe it. */
export interface PendingSurrenderView extends PendingSurrender {
  name: string | null;
}

/**
 * The surrenders pending in a GameFeed game (`me`: my GameFeed seat), each with the player's GameFeed id
 * and name; `null` when the details could not be read or my seat is unknown, and an empty list, read from
 * nothing, when no surrender can matter to me there (the game not being played or picked, or my seat out:
 * {@link surrenderMayBePending}, #327).
 */
export async function readPendingSurrenders(
  ctx: Pick<LiveContext, 'rpc' | 'bundle'>,
  game: Pick<Game, 'id' | 'state' | 'players'>,
  me: Pick<Player, 'id' | 'feedId' | 'state'> | undefined,
  read: (gameId: number) => ReturnType<typeof readDetailsSeats> = (id) => readDetailsSeats(ctx, id),
): Promise<PendingSurrenderView[] | null> {
  if (!me) return null;
  if (!surrenderMayBePending(game.state, me.state)) return [];
  const seats = await read(game.id);
  if (!seats) return null;
  const byInGame = new Map<number, Player>();
  for (const p of game.players) {
    const id = inGameOf(p);
    if (id !== undefined) byInGame.set(id, p);
  }
  return pendingSurrenders(seats, inGameOf(me), (id) => byInGame.get(id)?.id ?? null).map((p) => {
    const player = byInGame.get(p.inGameId);
    return { ...p, name: player ? untrustedText(player.name) : null };
  });
}

/** The line a result leads with when a surrender waits on my acceptance; undefined when none does. */
export function surrenderOwedLine(pending: readonly PendingSurrenderView[] | null): string | undefined {
  const owed = (pending ?? []).filter((p) => p.owedByMe === true);
  if (!owed.length) return undefined;
  const who = owed.map((p) => `${p.name ?? 'a player'} (${p.player ?? `in-game ${p.inGameId}`})`).join(', ');
  return (
    `A surrender is waiting for you to accept it: ${who} asked to surrender, and the game details show your ` +
    'acceptance still owed (read from the client bundle, UNVERIFIED live). Accepting is the owner\'s decision: ' +
    'ask before accepting, unless accepting simply wins the game.'
  );
}
