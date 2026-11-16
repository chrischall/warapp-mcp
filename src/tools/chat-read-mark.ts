// Marking a game's chat read on war.app (#311): what `mark_seen: true` sends beside the local cursor, for
// warapp_get_chat and warapp_chat_inbox. RegisterChatView (43) takes, per channel, the highest message id
// read (docs/WEB-PROTOCOL.md, "Marking a game's chat read"); it has no result payload, so the effect is
// read back from GetMyGames' unread-chat flags. Both are read from the client bundle, UNVERIFIED live.
//
// Not confirm-gated, like warapp_record_agreement: a read mark changes only the account's own unread state
// on war.app — nothing reaches another player, nothing is sent in any chat (automated chat stays off, D2) —
// and it is asked for explicitly with `mark_seen: true`. It is still a write, so it follows the write rules:
// the outcome is read back from game state, never from the reply; a failure is never retried; and nothing
// about it ever fails the read it rides on.
import type { ChatChannel, ChatLine } from '../chat.js';
import { chatViewMarks } from '../chat.js';
import type { RawMyGame, UnreadChatFlags } from '../my-games.js';
import { unreadChatOf } from '../my-games.js';
import { Method, writeRegisterChatViewParams } from '../protocol/methods.js';
import { notSent, WarappServerError } from '../protocol/rpc.js';
import type { ChatMe, ChatSource } from './chat.js';
import { failureText, type LiveContext } from './live-context.js';
import { fetchMyGames } from './my-games.js';

/** How a war.app read mark went (the house `outcome` words). */
export type ReadOnWarappOutcome = 'confirmed' | 'unconfirmed' | 'unknown' | 'not_applied';

/** What `mark_seen` did on war.app itself. */
export interface ReadOnWarapp {
  outcome: ReadOnWarappOutcome;
  /** The channels the mark covered (`unknown` = the game groups); empty when nothing was sent. */
  channels: ChatChannel[];
  why?: string;
}

/** Said once beside every `readOnWarapp`. */
export const READ_ON_WARAPP_NOTE =
  "`readOnWarapp` is war.app's own read mark (RegisterChatView), sent after the mark on this machine and read back " +
  "from your game list's unread-chat flags: `confirmed` when they show the channels read, `unconfirmed` when they do " +
  'not (or could not be read), `unknown` when war.app did not answer (never resent), `not_applied` when nothing was ' +
  "sent. It reaches no other player. Read from war.app's client code, UNVERIFIED live.";

/** The GameInfo flag each channel's unread state shows in. */
const FLAG_OF: Readonly<Record<ChatChannel, keyof UnreadChatFlags>> = {
  public: 'public',
  team: 'team',
  private: 'private',
  unknown: 'group',
};

const notApplied = (why: string): ReadOnWarapp => ({ outcome: 'not_applied', channels: [], why });

/**
 * Send the read mark for `read`'s messages on `channels` (one RegisterChatView, never retried): `{ sent }` with
 * the channels it covered, or the final result when nothing went out or war.app did not answer. Never throws.
 * `flags` (the game list's, when the caller has it): a mark whose channels war.app already shows read is skipped.
 */
export async function sendReadMark(
  ctx: LiveContext,
  gameId: number,
  me: ChatMe,
  read: { source: ChatSource; lines: readonly ChatLine[] },
  channels: readonly ChatChannel[],
  flags?: UnreadChatFlags,
): Promise<{ sent: ChatChannel[] } | ReadOnWarapp> {
  if (!me) return notApplied('The signed-in account could not be read, so war.app was not asked to mark anything read.');
  if (read.source !== 'web') {
    return notApplied('The chat was read from GameFeed, which gives no message ids, so war.app was not asked to mark it read.');
  }
  const marks = chatViewMarks(read.lines, me.inGameId, channels);
  if (!marks) return notApplied('No message on those channels to mark read on war.app.');
  if (flags && marks.channels.every((c) => !flags[FLAG_OF[c]])) {
    return notApplied('Your game list already shows this chat read on war.app: nothing was sent.');
  }
  try {
    await ctx.rpc.call('RegisterChatView', Method.RegisterChatView, (w) =>
      writeRegisterChatViewParams(w, {
        gameId,
        ...(marks.public !== undefined ? { publicMark: marks.public } : {}),
        ...(marks.team !== undefined ? { teamMark: marks.team } : {}),
        privateMarks: marks.private,
        groupMarks: marks.groups,
      }),
    );
  } catch (e) {
    if (notSent(e)) return notApplied(`The read mark was not sent (${failureText(e)}), so nothing changed on war.app.`);
    if (e instanceof WarappServerError) return notApplied(`war.app refused the read mark (${e.message}), so nothing changed there.`);
    return {
      outcome: 'unknown',
      channels: marks.channels,
      why: `war.app did not answer the read mark (${failureText(e)}): it may have gone through. It is not resent.`,
    };
  }
  return { sent: marks.channels };
}

/** The game list for a read-back, or the failure's text. Never throws. */
export async function readBackList(ctx: LiveContext): Promise<RawMyGame[] | string> {
  try {
    return (await fetchMyGames(ctx)).games;
  } catch (e) {
    return failureText(e);
  }
}

/** A sent mark judged against the game list read after it (`list`: the games, or why they could not be read). */
export function judgeReadMark(list: RawMyGame[] | string, gameId: number, channels: ChatChannel[]): ReadOnWarapp {
  if (typeof list === 'string') {
    return { outcome: 'unconfirmed', channels, why: `war.app took the read mark, but the game list could not be read back (${list}).` };
  }
  const flags = unreadChatOf(list, gameId);
  if (!flags) {
    return { outcome: 'unconfirmed', channels, why: 'war.app took the read mark, but the game list did not show this game\'s unread flags.' };
  }
  const still = channels.filter((c) => flags[FLAG_OF[c]]);
  if (!still.length) return { outcome: 'confirmed', channels };
  return {
    outcome: 'unconfirmed',
    channels,
    why: `war.app took the read mark, but your game list still shows unread messages on ${still.join(', ')} (a message may have come in since).`,
  };
}

/** One game's mark from send to read-back (warapp_get_chat). Never throws. */
export async function markReadOnWarapp(
  ctx: LiveContext,
  gameId: number,
  me: ChatMe,
  read: { source: ChatSource; lines: readonly ChatLine[] },
  channels: readonly ChatChannel[],
): Promise<ReadOnWarapp> {
  const step = await sendReadMark(ctx, gameId, me, read, channels);
  if (!('sent' in step)) return step;
  return judgeReadMark(await readBackList(ctx), gameId, step.sent);
}
