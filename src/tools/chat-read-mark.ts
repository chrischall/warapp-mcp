// warapp_mark_chat_read (#311): marks a game's chat read on war.app itself, RegisterChatView (43), which takes
// per channel the highest message id read (docs/WEB-PROTOCOL.md, "Marking a game's chat read"). It has no
// result payload, so the effect is read back from GetMyGames' unread-chat flags. Both read from the client
// bundle, UNVERIFIED live.
//
// `scope` (default "both") also writes this machine's seen mark (the chat cursor warapp_get_chat's and
// warapp_chat_inbox's `mark_seen` write) over the same messages read for the war.app mark, so one confirm clears
// both read states; "warapp" and "local" do one. When war.app's list already shows the game read, "both" still
// writes the local mark (the drift the inbox's `readState` shows) instead of refusing; read in both is a no-op,
// never an error. `game_ids` marks several games under one confirmation, with an outcome per game (a game with
// nothing to mark is `skipped` with the reason; a game war.app refuses is `refused`, the others still go).
//
// A confirm-gated write like warapp_dismiss_notification: it changes only the account's own unread state on
// war.app (nothing reaches another player, nothing is posted in any chat: automated chat stays off, D2), but
// it does reach war.app, so it is gated. warapp_get_chat's and warapp_chat_inbox's `mark_seen` mark only this
// machine's cursor and stay read-only. The outcome is read back from game state, never from the reply; a send
// war.app did not answer is `unknown` and never resent.
import { CONFIRM_INJECTION_RULE, McpToolError, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CHAT_CHANNELS, chatViewMarks, type ChatChannel, type ChatViewMarks } from '../chat.js';
import { parseGameId } from '../client.js';
import { CHANNEL_FLAG, unreadChatOf, type RawMyGame, type UnreadChatFlags } from '../my-games.js';
import { Method, writeRegisterChatViewParams } from '../protocol/methods.js';
import { chatUnread, markChatSeen, readChat, type ChatRead } from './chat.js';
import { gameIdArg } from './common.js';
import { mintMeta } from './hints.js';
import { failureText, requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { fetchMyGames } from './my-games.js';
import { accountUnknown, defineGatedWrite, refuse, sendAndVerify } from './write-kit.js';

/** The most games one call marks. */
export const MAX_MARK_GAMES = 20;

const SCOPES = ['both', 'warapp', 'local'] as const;
type Scope = (typeof SCOPES)[number];

/** Every preview and result says so. */
export const CHAT_READ_UNVERIFIED =
  "war.app's chat read mark (RegisterChatView) and the game list's unread-chat flags it is read back from are read " +
  "from war.app's client code, UNVERIFIED live.";

/** The channels of `channels` the flags still show unread. */
const stillUnread = (flags: UnreadChatFlags, channels: readonly ChatChannel[]): ChatChannel[] =>
  channels.filter((c) => flags[CHANNEL_FLAG[c]]);

/** The game list, or why it could not be read (never throws). */
async function readList(ctx: LiveContext): Promise<RawMyGame[] | string> {
  try {
    return (await fetchMyGames(ctx)).games;
  } catch (e) {
    return failureText(e);
  }
}

type Me = { token: number; inGameId: number };

/** What the war.app half of one game will do. */
type WarappPart = { kind: 'send'; marks: ChatViewMarks; flagsKnown: boolean } | { kind: 'already'; channels: ChatChannel[] } | { kind: 'not-asked' };
/** What the local half will do: write the mark over `read`, or nothing (already seen / not asked). */
type LocalPart = { kind: 'mark'; read: ChatRead } | { kind: 'seen' } | { kind: 'not-asked' };

interface GamePlan {
  gameId: number;
  channels: ChatChannel[];
  warapp: WarappPart;
  local: LocalPart;
}

interface MarkState {
  me: Me;
  scope: Scope;
  /** One game named by `game_id`: its result is the game's own (the shape before `game_ids`). */
  single: boolean;
  plans: GamePlan[];
  skipped: Array<{ gameId: number; reason: string }>;
}

/** The plan for one game; throws (refuse) when nothing can be done for it. */
async function planGame(
  ctx: LiveContext,
  id: number,
  me: Me,
  requested: ChatChannel[],
  scope: Scope,
  list: () => Promise<RawMyGame[] | string>,
): Promise<GamePlan> {
  const game = await ctx.client.getGame(id, { chat: true, map: false });
  const read = await readChat(ctx, game, me);
  let warapp: WarappPart = { kind: 'not-asked' };
  let channels = requested;
  if (scope !== 'local') {
    // A filled web read (#313) still carries the web messages' ids; GameFeed's added lines carry none and mark nothing.
    if (!read || read.source === 'gamefeed') {
      refuse(
        `The chat of game ${game.id} could be read only from GameFeed, which gives no message ids, so nothing was sent.`,
        'A message read from GameFeed carries no id, so war.app has nothing to mark for it. Read the game with ' +
          'warapp_get_chat: if its `source` is `web`, those messages can be marked; if it stays `gamefeed`, the web ' +
          'read failed or the signed-in account could not be read, and marking waits until it reads. `scope: "local"` ' +
          'marks this machine only.',
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
    const marks = chatViewMarks(read.lines, me.inGameId, requested);
    if (!marks) refuse(`No message on ${requested.join(', ')} in game ${game.id} to mark read, so nothing was sent.`, 'Nothing to do.');
    channels = marks.channels;
    const got = await list();
    const flags: UnreadChatFlags | undefined = typeof got === 'string' ? undefined : unreadChatOf(got, game.id);
    if (flags && !stillUnread(flags, marks.channels).length) {
      if (scope === 'warapp') {
        refuse(`Your game list already shows the chat of game ${game.id} read on war.app, so nothing was sent.`, 'Nothing to do.');
      }
      warapp = { kind: 'already', channels: marks.channels };
    } else {
      warapp = { kind: 'send', marks, flagsKnown: flags !== undefined };
    }
  }
  let local: LocalPart = { kind: 'not-asked' };
  if (scope !== 'warapp') {
    const on = read ? read.lines.filter((l) => requested.includes(l.channel)) : [];
    if (!read || !on.length) refuse(`No message on ${requested.join(', ')} in game ${game.id} to mark read, so nothing was written.`, 'Nothing to do.');
    const { fresh } = await chatUnread(ctx, game.id, me, read.lines);
    const anyNew = read.lines.some((l, i) => fresh[i] && requested.includes(l.channel));
    local = anyNew ? { kind: 'mark', read } : { kind: 'seen' };
  }
  return { gameId: game.id, channels, warapp, local };
}

const upToOf = (marks: ChatViewMarks) => ({
  ...(marks.public !== undefined ? { public: marks.public } : {}),
  ...(marks.team !== undefined ? { team: marks.team } : {}),
  ...(marks.private.size ? { private: Object.fromEntries(marks.private) } : {}),
  ...(marks.groups.size ? { groups: Object.fromEntries(marks.groups) } : {}),
});

/** One line of the preview per game, by ids only. */
function planLine(p: GamePlan): string {
  const w =
    p.warapp.kind === 'send'
      ? `mark read on war.app (${p.channels.join(', ')})`
      : p.warapp.kind === 'already'
        ? 'already read on war.app (nothing sent)'
        : null;
  const l = p.local.kind === 'mark' ? 'mark seen on this machine' : p.local.kind === 'seen' ? 'already seen on this machine' : null;
  return `game ${p.gameId}: ${[w, l].filter(Boolean).join('; ')}`;
}

/** Nothing would change: war.app already shows it read and this machine has seen it (or the half was not asked). */
const idle = (p: GamePlan) => p.warapp.kind !== 'send' && p.local.kind !== 'mark';

export function registerMarkChatReadTool(server: McpServer, ctx: LiveContext): void {
  defineGatedWrite(
    server,
    {
      title: "Mark a war.app game's chat read",
      _meta: mintMeta('change', ['mark chat read', 'clear unread chat', 'mark messages read', 'mark all chat read', 'mark seen']),
    },
    {
      name: 'warapp_mark_chat_read',
      description:
        "Mark war.app (Warzone) game chat read in one step: on war.app itself (war.app's RegisterChatView, so the game " +
        "stops showing unread messages there) and on this machine (the seen mark warapp_chat_inbox and warapp_get_chat " +
        'judge new messages by), up to the same newest messages — `scope` "both" (default), "warapp" or "local". Every ' +
        'channel, or one (`channel`). One game (`game_id`) or several (`game_ids`) under one confirmation, with an ' +
        'outcome per game. It changes only your own unread state, reaches no other player and posts nothing. The ' +
        'war.app mark needs the chat read through your war.app tab or linked session (GameFeed gives no message ids) ' +
        "and refuses a chat with nothing to mark (also when war.app's web read returned no messages while GameFeed " +
        "holds some). When war.app's game list already shows the chat read, \"both\" still marks this machine " +
        '(nothing sent to war.app); read in both is a no-op (`nothingToDo`), not an error. Always as the signed-in ' +
        "account; the war.app outcome is read back from your game list's unread-chat flags (`read`, `unconfirmed` " +
        "while a channel still shows unread, or `unknown` when war.app did not answer — never resend blindly). " +
        `${CHAT_READ_UNVERIFIED} ${BRIDGE_NOTE} ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({
        title: "Mark a war.app game's chat read",
        readOnly: false,
        destructive: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: z.object({
        game_id: gameIdArg.optional(),
        game_ids: z
          .array(gameIdArg)
          .min(1)
          .max(MAX_MARK_GAMES)
          .optional()
          .describe(`Several games to mark under one confirmation (at most ${MAX_MARK_GAMES}); instead of game_id.`),
        channel: z
          .enum([...CHAT_CHANNELS, 'all'])
          .optional()
          .describe('The channel to mark read (default `all`); `unknown` is the game groups.'),
        scope: z
          .enum(SCOPES)
          .optional()
          .describe('"both" (default): war.app and this machine; "warapp": war.app only; "local": this machine only.'),
      }),
      async plan({ game_id, game_ids, channel, scope: scopeArg }) {
        const scope: Scope = scopeArg ?? 'both';
        if ((game_id === undefined) === (game_ids === undefined)) {
          refuse('Name the game with `game_id`, or several with `game_ids` (not both).', 'Pass exactly one of game_id or game_ids.');
        }
        const single = game_ids === undefined;
        const ids = single ? [parseGameId(game_id)] : [...new Set(game_ids!.map((g) => parseGameId(g)))];
        // The gate binds the account read fresh (the write rules); its in-game id keys the private marks.
        const me = await ctx.myIdentity({ fresh: true }).catch(() => undefined);
        if (!me) throw accountUnknown(ctx);
        const requested: ChatChannel[] = channel === undefined || channel === 'all' ? [...CHAT_CHANNELS] : [channel];
        let listed: Promise<RawMyGame[] | string> | undefined;
        const list = () => (listed ??= readList(ctx));
        const plans: GamePlan[] = [];
        const skipped: Array<{ gameId: number; reason: string }> = [];
        for (const id of ids) {
          try {
            plans.push(await planGame(ctx, id, me, requested, scope, list));
          } catch (e) {
            if (single) throw e;
            skipped.push({ gameId: id, reason: e instanceof McpToolError ? e.message : failureText(e) });
          }
        }
        if (!plans.length) {
          refuse(`Nothing to mark in ${skipped.map((s) => `game ${s.gameId} (${s.reason})`).join('; ')}`, 'Nothing to do.');
        }
        const nothingToDo = plans.every(idle);
        const sends = plans.filter((p) => p.warapp.kind === 'send');
        const target = plans.map((p) => p.gameId).join(',');
        return {
          gate: {
            action: 'warapp.mark_chat_read',
            // By ids only: the messages and every name in them are other players' words.
            summary: `Mark the chat of war.app game(s) ${target} read (${scope})`,
            account: writeAccount(me.token),
            target,
            payload: {
              method: 'RegisterChatView',
              scope,
              games: plans.map((p) => ({
                gameId: p.gameId,
                warapp: p.warapp.kind === 'send' ? upToOf(p.warapp.marks) : p.warapp.kind,
                local: p.local.kind,
              })),
            },
            willSend: { games: sends.map((p) => ({ gameId: p.gameId, channels: p.channels })) },
            preview: {
              warning:
                `This marks the chat of game(s) ${target} read (${scope}). It changes only your own unread state: ` +
                'nothing reaches another player and nothing is posted.',
              account: `war.app account ${me.token}`,
              ...(single ? { gameId: plans[0]!.gameId, channels: plans[0]!.channels } : {}),
              scope,
              games: plans.map(planLine),
              ...(skipped.length ? { skipped } : {}),
              ...(nothingToDo
                ? { nothingToDo: true, note: 'Already read on war.app and seen on this machine: confirming changes nothing.' }
                : {}),
              ...(sends.some((p) => p.warapp.kind === 'send' && !p.warapp.flagsKnown)
                ? { listFlags: "unknown: your game list did not show some game's unread flags" }
                : {}),
              unverified: CHAT_READ_UNVERIFIED,
            },
          },
          state: { me: { token: me.token, inGameId: me.inGameId }, scope, single, plans, skipped } satisfies MarkState,
        };
      },
      async execute({ me, scope, single, plans, skipped }: MarkState) {
        await requireApprovedAccount(ctx, writeAccount(me.token));
        const results: Array<Record<string, unknown>> = [];
        for (const p of plans) {
          let warapp: Record<string, unknown>;
          try {
            warapp = await warappHalf(ctx, p);
          } catch (e) {
            // One game: the refusal is the call's error (nothing changed). Several: that game's outcome, the rest go on.
            if (single) throw e;
            results.push({ gameId: p.gameId, status: 'refused', outcome: 'not_applied', error: failureText(e), local: { status: 'not-written' } });
            continue;
          }
          results.push({ ...warapp, scope, ...(p.local.kind === 'not-asked' ? {} : { local: await localHalf(ctx, me, p) }) });
        }
        if (single) return results[0]!;
        return {
          scope,
          games: [...results, ...skipped.map((s) => ({ gameId: s.gameId, status: 'skipped', outcome: 'skipped', reason: s.reason }))],
          unverified: CHAT_READ_UNVERIFIED,
        };
      },
    },
  );
}

/** This machine's mark for one game, over the lines read in the plan (the messages the war.app mark covers). */
async function localHalf(ctx: LiveContext, me: Me, p: GamePlan): Promise<Record<string, unknown>> {
  if (p.local.kind !== 'mark') return { status: 'already-seen' };
  const { cursor } = await chatUnread(ctx, p.gameId, me, p.local.read.lines);
  const marked = await markChatSeen(ctx, p.gameId, me, p.local.read, cursor, p.channels);
  return marked ? { status: 'marked', channels: marked } : { status: 'not-written', warning: 'This machine keeps no chat marks (no data directory).' };
}

/** The war.app half of one game: sent and read back, already read, or not asked. */
async function warappHalf(ctx: LiveContext, p: GamePlan): Promise<Record<string, unknown>> {
  const gameId = p.gameId;
  if (p.warapp.kind === 'already') return { status: 'read', outcome: 'already-read', gameId, channels: p.channels };
  if (p.warapp.kind === 'not-asked') return { status: 'not-asked', outcome: 'not-asked', gameId, channels: p.channels };
  const marks = p.warapp.marks;
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
}
