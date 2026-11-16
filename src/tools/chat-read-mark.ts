// warapp_mark_chat_read (#311): marks a game's chat read on war.app itself, RegisterChatView (43), which takes
// per channel the highest message id read (docs/WEB-PROTOCOL.md, "Marking a game's chat read"). It has no
// result payload, so the effect is read back from GetMyGames' unread-chat flags. Both read from the client
// bundle, UNVERIFIED live.
//
// A confirm-gated write like warapp_dismiss_notification: it changes only the account's own unread state on
// war.app (nothing reaches another player, nothing is posted in any chat: automated chat stays off, D2), but
// it does reach war.app, so it is gated. warapp_get_chat's and warapp_chat_inbox's `mark_seen` mark only this
// machine's cursor and stay read-only. The outcome is read back from game state, never from the reply; a send
// war.app did not answer is `unknown` and never resent.
import { CONFIRM_INJECTION_RULE, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CHAT_CHANNELS, chatViewMarks, type ChatChannel, type ChatViewMarks } from '../chat.js';
import { unreadChatOf, type RawMyGame, type UnreadChatFlags } from '../my-games.js';
import { Method, writeRegisterChatViewParams } from '../protocol/methods.js';
import { readChat } from './chat.js';
import { gameIdArg } from './common.js';
import { mintMeta } from './hints.js';
import { failureText, requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { fetchMyGames } from './my-games.js';
import { accountUnknown, defineGatedWrite, refuse, sendAndVerify } from './write-kit.js';

/** Every preview and result says so. */
export const CHAT_READ_UNVERIFIED =
  "war.app's chat read mark (RegisterChatView) and the game list's unread-chat flags it is read back from are read " +
  "from war.app's client code, UNVERIFIED live.";

/** The GameInfo flag each channel's unread state shows in. */
const FLAG_OF: Readonly<Record<ChatChannel, keyof UnreadChatFlags>> = {
  public: 'public',
  team: 'team',
  private: 'private',
  unknown: 'group',
};

/** The channels of `channels` the flags still show unread. */
const stillUnread = (flags: UnreadChatFlags, channels: readonly ChatChannel[]): ChatChannel[] =>
  channels.filter((c) => flags[FLAG_OF[c]]);

/** The game list, or why it could not be read (never throws). */
async function readList(ctx: LiveContext): Promise<RawMyGame[] | string> {
  try {
    return (await fetchMyGames(ctx)).games;
  } catch (e) {
    return failureText(e);
  }
}

interface MarkState {
  me: number;
  gameId: number;
  marks: ChatViewMarks;
}

export function registerMarkChatReadTool(server: McpServer, ctx: LiveContext): void {
  defineGatedWrite(
    server,
    {
      title: "Mark a war.app game's chat read",
      _meta: mintMeta('change', ['mark chat read', 'clear unread chat', 'mark messages read']),
    },
    {
      name: 'warapp_mark_chat_read',
      description:
        "Mark a war.app (Warzone) game's chat read on war.app itself (war.app's RegisterChatView), so the game stops " +
        'showing unread messages there: every channel, or one (`channel`), up to the newest message read now. It ' +
        'changes only your own unread state, reaches no other player and posts nothing. Needs the chat read through ' +
        'your war.app tab or linked session (GameFeed gives no message ids); refuses a chat with nothing to mark (also ' +
        "when war.app's web read returned no messages while GameFeed holds some: no message id to mark) or one " +
        "war.app's game list already shows read. Always as the signed-in account; the outcome is read back from your " +
        "game list's unread-chat flags (`read`, `unconfirmed` while a channel still shows unread, or `unknown` when " +
        "war.app did not answer — never resend blindly). warapp_get_chat's and warapp_chat_inbox's `mark_seen` mark " +
        `only this machine. ${CHAT_READ_UNVERIFIED} ${BRIDGE_NOTE} ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({
        title: "Mark a war.app game's chat read",
        readOnly: false,
        destructive: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: z.object({
        game_id: gameIdArg,
        channel: z
          .enum([...CHAT_CHANNELS, 'all'])
          .optional()
          .describe('The channel to mark read (default `all`); `unknown` is the game groups.'),
      }),
      async plan({ game_id, channel }) {
        const game = await ctx.client.getGame(game_id, { chat: true, map: false });
        // The gate binds the account read fresh (the write rules); its in-game id keys the private marks.
        const me = await ctx.myIdentity({ fresh: true }).catch(() => undefined);
        if (!me) throw accountUnknown(ctx.hosted);
        const read = await readChat(ctx, game, me);
        // A filled web read (#313) still carries the web messages' ids; GameFeed's added lines carry none and mark nothing.
        if (!read || read.source === 'gamefeed') {
          refuse(
            `The chat of game ${game.id} could be read only from GameFeed, which gives no message ids, so nothing was sent.`,
            'Make sure your war.app tab is open and signed in (reload or focus it if it is frozen), then retry.',
          );
        }
        // #313: the web read answered with no message at all while GameFeed holds some (a finished game's chat,
        // seen live). Every line is then GameFeed's, with no id; a retry reads the same, so it says why instead.
        if (read.feedFill?.web === 0) {
          refuse(
            `war.app's web read of game ${game.id} returned no messages (GameFeed holds ${read.feedFill.gamefeed}), so ` +
              'there is no message id to mark and nothing was sent.',
            "This is a limit of war.app's web read for this game, not of your tab; warapp_get_chat still shows GameFeed's messages.",
          );
        }
        const channels: ChatChannel[] = channel === undefined || channel === 'all' ? [...CHAT_CHANNELS] : [channel];
        const marks = chatViewMarks(read.lines, me.inGameId, channels);
        if (!marks) refuse(`No message on ${channels.join(', ')} in game ${game.id} to mark read, so nothing was sent.`, 'Nothing to do.');
        const list = await readList(ctx);
        const flags = typeof list === 'string' ? undefined : unreadChatOf(list, game.id);
        if (flags && !stillUnread(flags, marks.channels).length) {
          refuse(`Your game list already shows the chat of game ${game.id} read on war.app, so nothing was sent.`, 'Nothing to do.');
        }
        const upTo = {
          ...(marks.public !== undefined ? { public: marks.public } : {}),
          ...(marks.team !== undefined ? { team: marks.team } : {}),
          ...(marks.private.size ? { private: Object.fromEntries(marks.private) } : {}),
          ...(marks.groups.size ? { groups: Object.fromEntries(marks.groups) } : {}),
        };
        return {
          gate: {
            action: 'warapp.mark_chat_read',
            // By ids only: the messages and every name in them are other players' words.
            summary: `Mark the chat of war.app game ${game.id} read on ${marks.channels.join(', ')}`,
            account: writeAccount(me.token),
            target: String(game.id),
            payload: { method: 'RegisterChatView', gameId: game.id, upTo },
            willSend: { gameId: game.id, channels: marks.channels, upTo },
            preview: {
              warning:
                `This marks the chat of game ${game.id} read on war.app (${marks.channels.join(', ')}). It changes only ` +
                'your own unread state: nothing reaches another player and nothing is posted.',
              account: `war.app account ${me.token}`,
              gameId: game.id,
              channels: marks.channels,
              ...(flags ? {} : { listFlags: "unknown: your game list did not show this game's unread flags" }),
              unverified: CHAT_READ_UNVERIFIED,
            },
          },
          state: { me: me.token, gameId: game.id, marks } satisfies MarkState,
        };
      },
      async execute({ me, gameId, marks }: MarkState) {
        await requireApprovedAccount(ctx, writeAccount(me));
        const base = { gameId, channels: marks.channels, unverified: CHAT_READ_UNVERIFIED };
        const check = 'Check warapp_my_games or warapp_chat_inbox before doing anything else.';
        return sendAndVerify({
          send: async () => {
            await ctx.rpc.call('RegisterChatView', Method.RegisterChatView, (w) =>
              writeRegisterChatViewParams(w, {
                gameId,
                ...(marks.public !== undefined ? { publicMark: marks.public } : {}),
                ...(marks.team !== undefined ? { teamMark: marks.team } : {}),
                privateMarks: marks.private,
                groupMarks: marks.groups,
              }),
            );
          },
          unanswered: (failure) => ({
            status: 'unknown' as const,
            outcome: 'unknown' as const,
            ...base,
            warning: `war.app did not answer (${failure}): the chat may already be marked read. It is not resent. ${check}`,
          }),
          readBack: async () => (await fetchMyGames(ctx)).games,
          unreadable: (failure) => ({
            status: 'unconfirmed' as const,
            outcome: 'unconfirmed' as const,
            ...base,
            warning: `war.app took the read mark, but the game list could not be read back (${failure}). ${check}`,
          }),
          classify: (list) => {
            const flags = unreadChatOf(list, gameId);
            if (!flags) {
              return {
                status: 'unconfirmed' as const,
                outcome: 'unconfirmed' as const,
                ...base,
                warning: `war.app took the read mark, but the game list did not show this game's unread flags. ${check}`,
              };
            }
            const still = stillUnread(flags, marks.channels);
            if (!still.length) return { status: 'read' as const, outcome: 'confirmed' as const, ...base };
            return {
              status: 'unconfirmed' as const,
              outcome: 'unconfirmed' as const,
              ...base,
              stillUnread: still,
              warning:
                `war.app took the read mark, but your game list still shows unread messages on ${still.join(', ')} ` +
                `(a message may have come in since). ${check}`,
            };
          },
        });
      },
    },
  );
}
