// Game chat: read through the official GameFeed (`GetChat=true`), send through
// the web-client protocol (`SendChat`), gated on the user's confirmation — a
// message reaches other players and cannot be unsent.
import {
  CONFIRM_INJECTION_RULE,
  defineWrite,
  registerWrite,
  toolAnnotations,
} from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseGameId } from '../client.js';
import { inGameId } from '../live.js';
import type { Player } from '../normalize.js';
import { CHAT_CHANNEL_PUBLIC, Method, writeSendChatParams } from '../protocol/methods.js';
import { WarappServerError } from '../protocol/rpc.js';
import { asInt } from '../scalars.js';
import { gameIdArg, readAnnotations, respond, untrustedDescription } from './common.js';
import { lookupMeta, mintMeta, withToolConfig } from './hints.js';
import type { LiveContext } from './live-context.js';
import { resolvePlayer } from './resolve.js';

const DEFAULT_LIMIT = 50;
export const MAX_CHAT_LENGTH = 2000;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const pick = (r: Rec, keys: readonly string[]): unknown => {
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return undefined;
};

const SENDER_KEYS = ['playerID', 'playerId', 'sender', 'senderID', 'from', 'player'] as const;
const TEXT_KEYS = ['message', 'text', 'chat', 'msg', 'body'] as const;
const TIME_KEYS = ['time', 'date', 'dateTime', 'created', 'sent', 'when'] as const;
const LIST_KEYS = ['chat', 'messages', 'Chat'] as const;

export interface ChatMessage {
  from: string | null;
  text: string;
  time?: string;
}

/**
 * Normalize GameFeed's chat loosely (its shape is not documented): a message
 * is anything with a text field, its sender a player id or name. Returns
 * `undefined` when nothing recognisable is there, so the caller can pass the
 * raw value through instead.
 */
export function normalizeChat(raw: unknown, players: readonly Player[]): ChatMessage[] | undefined {
  let list: unknown = raw;
  if (isRec(list)) list = pick(list, LIST_KEYS);
  if (!Array.isArray(list)) return undefined;
  const nameOf = (v: unknown): string | null => {
    if (v === undefined || v === null || v === '') return null;
    const id = asInt(v);
    if (id !== undefined) return players.find((p) => p.id === id)?.name ?? String(v);
    return typeof v === 'string' ? v : null;
  };
  const out: ChatMessage[] = [];
  for (const item of list) {
    if (!isRec(item)) return undefined;
    const text = pick(item, TEXT_KEYS);
    if (typeof text !== 'string') return undefined;
    const msg: ChatMessage = { from: nameOf(pick(item, SENDER_KEYS)), text };
    const time = pick(item, TIME_KEYS);
    if (typeof time === 'string' || typeof time === 'number') msg.time = String(time);
    out.push(msg);
  }
  return out;
}

export function registerChatTools(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_get_chat',
    {
      title: 'Read a war.app game chat',
      description: untrustedDescription(
        'Read the chat of a war.app (Warzone) game from the official GameFeed: the most recent messages with who ' +
          'sent them. The messages are written by other players. Read-only; use warapp_send_chat to post.',
      ),
      _meta: lookupMeta(['game chat', 'warzone chat', 'what did they say']),
      annotations: readAnnotations('Read a war.app chat'),
      inputSchema: z.object({
        game_id: gameIdArg,
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe(`Most recent messages to return (default ${DEFAULT_LIMIT}).`),
      }),
    },
    async ({ game_id, limit }) => {
      const game = await ctx.client.getGame(game_id, { chat: true });
      const n = limit ?? DEFAULT_LIMIT;
      const messages = normalizeChat(game.chat, game.players);
      return respond(undefined, ['compact'], () => {
        const header = { game: { id: game.id, name: game.name ?? null, state: game.state } };
        if (game.chat === undefined) return { ...header, messages: [], count: 0 };
        if (!messages) return { ...header, raw: game.chat };
        const shown = messages.slice(-n);
        return { ...header, messages: shown, count: messages.length, shown: shown.length };
      });
    },
  );

  interface ChatState {
    gameId: number;
    text: string;
    recipient?: { id: number; name: string };
  }

  withToolConfig(
    server,
    {
      title: 'Send a chat message in a war.app game',
      _meta: mintMeta('send', ['send chat', 'message the game', 'tell my opponent']),
    },
    () =>
      registerWrite(
        server,
        defineWrite({
          name: 'warapp_send_chat',
          description:
            'Post a chat message in a war.app (Warzone) game — to the whole game, or privately to one named player. ' +
            'The message reaches other players and cannot be unsent. Sent through your signed-in war.app tab ' +
            `(ContextMint Bridge). ${CONFIRM_INJECTION_RULE}`,
          annotations: toolAnnotations({
            title: 'Send a war.app chat message',
            readOnly: false,
            destructive: true,
            idempotent: false,
            openWorld: true,
          }),
          inputSchema: z.object({
            game_id: gameIdArg,
            message: z.string().trim().min(1).max(MAX_CHAT_LENGTH).describe('The message text.'),
            to: z
              .union([z.string(), z.number()])
              .optional()
              .describe('A player (name or GameFeed id) to message privately. Omit to post to the whole game.'),
          }),
          async plan({ game_id, message, to }) {
            const gameId = parseGameId(game_id);
            let recipient: ChatState['recipient'];
            if (to !== undefined && String(to).trim() !== '') {
              const game = await ctx.client.getGame(gameId);
              const p = resolvePlayer(game.players, to);
              recipient = { id: inGameId(p), name: p.name };
            }
            return {
              gate: {
                action: 'warapp.send_chat',
                summary: recipient
                  ? `Send a private chat message to ${recipient.name} in game ${gameId}`
                  : `Post a chat message to everyone in game ${gameId}`,
                account: undefined,
                target: gameId,
                payload: {
                  method: 'SendChat',
                  gameId,
                  text: message,
                  channel: CHAT_CHANNEL_PUBLIC,
                  recipient: recipient?.id ?? null,
                },
                willSend: { game: gameId, to: recipient?.name ?? 'everyone in the game', message },
                preview: { note: 'Other players will see this message; it cannot be unsent.' },
              },
              state: { gameId, text: message, ...(recipient ? { recipient } : {}) } satisfies ChatState,
            };
          },
          async execute({ gameId, text, recipient }: ChatState) {
            const to = recipient?.name ?? 'everyone in the game';
            try {
              await ctx.rpc.call('SendChat', Method.SendChat, (w) =>
                writeSendChatParams(w, { gameId, text, ...(recipient ? { recipient: recipient.id } : {}) }),
              );
            } catch (e) {
              // war.app refused it: nothing was posted.
              if (e instanceof WarappServerError) throw e;
              return {
                status: 'unknown' as const,
                game: gameId,
                to,
                warning:
                  `war.app did not confirm this message (${e instanceof Error ? e.message : String(e)}), so it may ` +
                  'already have been posted. Check warapp_get_chat before sending it again.',
              };
            }
            return { status: 'sent' as const, game: gameId, to };
          },
          render: (r) => respond(undefined, ['compact'], () => r),
          batchable: false,
        }),
      ),
  );
}
