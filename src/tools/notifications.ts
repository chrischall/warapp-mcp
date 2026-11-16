// warapp_get_notifications and warapp_dismiss_notification (#311): war.app's in-app notifications
// (the client's "In App Notifications" screen), read with GetInAppNotifications (317) and marked read
// with AcknowledgeInAppNotifications (319). Both read from the client bundle, UNVERIFIED live
// (docs/WEB-PROTOCOL.md, Notifications and read marks).
//
// The list is name-free beyond ids: a notification's title and data are war.app's text with other
// players' names in it, read only to classify the notification and find the game its link names.
// A game-ended notification folds the game's kept opponent profile (B2, `foldFinishedGame`) when one
// is kept unfolded — the one GameFeed read warapp_get_game's fold makes, and none otherwise.
//
// Dismissing marks read; it never deletes (318 is not used) and sends nothing to any player. Automated
// chat stays off (D2): this is not a send.
import { CONFIRM_INJECTION_RULE, toolAnnotations, type EnvSource } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { classifyNotification, readInAppNotifications, type Notification, type RawNotification } from '../notifications.js';
import { foldFinishedGame, hasUnfoldedProfile, profileEnabled } from '../profile-store.js';
import {
  Method,
  NOTIFICATION_ID,
  NOTIFICATIONS_PAGE_SIZE,
  writeAcknowledgeInAppNotificationsParams,
  writeGetInAppNotificationsParams,
} from '../protocol/methods.js';
import { readAnnotations, respond, untrustedDescription } from './common.js';
import { mintMeta } from './hints.js';
import { requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { defineGatedWrite, refuse, requireMe, sendAndVerify } from './write-kit.js';

/** Every answer says so: nothing here has been checked against a real reply. */
export const NOTIFICATIONS_UNVERIFIED =
  "Read from war.app's client code, UNVERIFIED live: the notification list, its fields and how a game-ended " +
  'notification is recognised have not been checked against a real reply yet.';

/** The most games one list call reads from GameFeed to fold a kept profile. */
export const FOLD_LOOKUPS = 5;
/** The most pages a dismissal reads to find its ids (and to read them back). */
export const MAX_FIND_PAGES = 5;
/** The most ids one dismissal takes. */
export const MAX_DISMISS_IDS = NOTIFICATIONS_PAGE_SIZE;

/** One page of the account's notifications, from `start`. */
async function listPage(ctx: LiveContext, start: number): Promise<{ items: RawNotification[]; total: number }> {
  const env = await ctx.rpc.call('GetInAppNotifications', Method.GetInAppNotifications, (w) => writeGetInAppNotificationsParams(w, start));
  return readInAppNotifications(await ctx.bundle(), env.body);
}

/** The notifications among `ids` the list holds, read page by page until all are found (at most MAX_FIND_PAGES). */
async function findNotifications(ctx: LiveContext, ids: readonly string[]): Promise<Map<string, RawNotification>> {
  const want = new Set(ids);
  const found = new Map<string, RawNotification>();
  for (let page = 0, start = 0; page < MAX_FIND_PAGES; page++) {
    const { items, total } = await listPage(ctx, start);
    for (const n of items) if (want.has(n.id)) found.set(n.id, n);
    start += items.length;
    if (found.size === want.size || items.length === 0 || start >= total) break;
  }
  return found;
}

/**
 * Fold the kept opponent profile of each game a game-ended notification names (B2): only where a
 * per-game file is kept unfolded, one GameFeed read (no map) per such game, at most FOLD_LOOKUPS.
 * Best effort: a failed read folds nothing and is never an error.
 */
async function foldEndedGames(ctx: LiveContext, env: EnvSource, notes: readonly Notification[]): Promise<Array<{ gameId: number; files: number }>> {
  const dir = ctx.dataDir;
  if (!dir || !profileEnabled(env)) return [];
  const games = [...new Set(notes.filter((n) => n.kind === 'game-ended' && n.gameId !== null).map((n) => n.gameId!))];
  const out: Array<{ gameId: number; files: number }> = [];
  let lookups = 0;
  for (const gameId of games) {
    if (lookups >= FOLD_LOOKUPS) break;
    if (!(await hasUnfoldedProfile(dir, gameId))) continue;
    lookups++;
    try {
      const game = await ctx.client.getGame(gameId, { map: false });
      const files = game.state === 'Finished' ? await foldFinishedGame(dir, game, env) : 0;
      if (files > 0) out.push({ gameId, files });
    } catch {
      // Best effort: the next read that shows the game finished folds it.
    }
  }
  return out;
}

const idArg = z.union([z.string(), z.number().int().nonnegative()]);

interface DismissState {
  me: number;
  ids: string[];
  alreadyRead: string[];
}

export function registerNotificationTools(server: McpServer, ctx: LiveContext, opts: { env?: EnvSource } = {}): void {
  const env = opts.env ?? process.env;

  server.registerTool(
    'warapp_get_notifications',
    {
      title: 'List my war.app notifications',
      description: untrustedDescription(
        "Your war.app (Warzone) in-app notifications (the client's notifications screen, war.app's " +
          'GetInAppNotifications), 30 per page, by id only: each with `id` (what warapp_dismiss_notification takes), ' +
          '`kind` (`game-ended`, or `other` with `type` when war.app names one), `gameId` (the game its link names, ' +
          'or null), `time` and `unread`. The title and body are never shown (they carry other players\' names). ' +
          '`total` is how many notifications war.app holds; pass `next` back as `start` for the next page; ' +
          '`unread_only` keeps the unread ones of the page. A game-ended notification folds the opponent profile kept ' +
          'for that game (`profilesFolded`). Chat is not here: warapp_chat_inbox reads it. ' +
          `${BRIDGE_NOTE} Read-only. ${NOTIFICATIONS_UNVERIFIED}`,
      ),
      _meta: mintMeta('whats-new', ['notifications', 'war.app notifications', 'my alerts', 'did a game end']),
      annotations: readAnnotations('List war.app notifications'),
      inputSchema: z.object({
        start: z.number().int().min(0).max(1_000_000).optional().describe('The paging offset (default 0, the newest page): `next` from the last answer.'),
        unread_only: z.boolean().optional().describe('Show only the unread notifications of the page (default false).'),
      }),
    },
    async ({ start, unread_only }) => {
      const from = start ?? 0;
      const { items, total } = await listPage(ctx, from);
      const all = items.map(classifyNotification);
      const notifications = unread_only ? all.filter((n) => n.unread) : all;
      const profilesFolded = await foldEndedGames(ctx, env, all);
      const next = from + items.length < total && items.length > 0 ? from + items.length : undefined;
      return respond(undefined, ['compact'], () => ({
        notifications,
        count: notifications.length,
        unread: all.filter((n) => n.unread).length,
        total,
        ...(next !== undefined ? { next } : {}),
        ...(profilesFolded.length ? { profilesFolded } : {}),
        unverified: NOTIFICATIONS_UNVERIFIED,
      }));
    },
  );

  defineGatedWrite(
    server,
    {
      title: 'Mark war.app notifications read',
      _meta: mintMeta('change', ['dismiss notification', 'mark notification read', 'clear my notifications']),
    },
    {
      name: 'warapp_dismiss_notification',
      description:
        'Mark one or several war.app (Warzone) in-app notifications read (war.app\'s AcknowledgeInAppNotifications), ' +
        'by the ids warapp_get_notifications lists. It never deletes a notification and sends nothing to any player. ' +
        'Refuses ids war.app does not list and ids already read. Always as the signed-in war.app account; the outcome ' +
        'is read back by listing again (`dismissed`, `unconfirmed` while one still reads unread, or `unknown` when ' +
        `war.app did not answer — never resend blindly). ${NOTIFICATIONS_UNVERIFIED} ${BRIDGE_NOTE} ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({
        title: 'Mark war.app notifications read',
        readOnly: false,
        destructive: false,
        idempotent: true,
        openWorld: true,
      }),
      inputSchema: z.object({
        ids: z
          .array(idArg)
          .min(1)
          .max(MAX_DISMISS_IDS)
          .describe('Notification ids from warapp_get_notifications (decimal text).'),
      }),
      async plan({ ids }) {
        const asked = [...new Set(ids.map((id) => String(id).trim()))];
        const bad = asked.filter((id) => !NOTIFICATION_ID.test(id));
        if (bad.length) {
          refuse(`Not a notification id: ${bad.slice(0, 5).join(', ')}. Nothing was sent.`, 'Use the ids warapp_get_notifications lists.');
        }
        const me = await requireMe(ctx);
        const found = await findNotifications(ctx, asked);
        const missing = asked.filter((id) => !found.has(id));
        if (missing.length) {
          refuse(
            `war.app does not list notification ${missing.join(', ')}, so nothing was sent.`,
            'List them again with warapp_get_notifications: it may already be deleted.',
          );
        }
        const unread = asked.filter((id) => found.get(id)!.unread);
        const alreadyRead = asked.filter((id) => !found.get(id)!.unread);
        if (!unread.length) {
          refuse(`Notification ${alreadyRead.join(', ')} is already read, so there is nothing to send.`, 'Check warapp_get_notifications.');
        }
        const shown = unread.map((id) => {
          const n = classifyNotification(found.get(id)!);
          return { id: n.id, kind: n.kind, gameId: n.gameId, time: n.time };
        });
        const label = unread.length === 1 ? `notification ${unread[0]}` : `${unread.length} notifications (${unread.join(', ')})`;
        return {
          gate: {
            action: 'warapp.dismiss_notification',
            // By id only: a notification's title and body are war.app's text with other players' names.
            summary: `Mark war.app ${label} read`,
            account: writeAccount(me),
            target: unread.join(','),
            payload: { method: 'AcknowledgeInAppNotifications', ids: unread },
            willSend: { ids: unread },
            preview: {
              warning: `This marks ${label} read on war.app. Nothing is deleted and nothing reaches another player.`,
              account: `war.app account ${me}`,
              notifications: shown,
              ...(alreadyRead.length ? { alreadyRead } : {}),
              unverified: NOTIFICATIONS_UNVERIFIED,
            },
          },
          state: { me, ids: unread, alreadyRead } satisfies DismissState,
        };
      },
      async execute({ me, ids, alreadyRead }: DismissState) {
        await requireApprovedAccount(ctx, writeAccount(me));
        const base = { ids, ...(alreadyRead.length ? { alreadyRead } : {}) };
        const check = 'Check warapp_get_notifications before doing anything else.';
        return sendAndVerify({
          send: async () => {
            await ctx.rpc.call('AcknowledgeInAppNotifications', Method.AcknowledgeInAppNotifications, (w) =>
              writeAcknowledgeInAppNotificationsParams(w, ids),
            );
          },
          unanswered: (failure) => ({
            status: 'unknown' as const,
            outcome: 'unknown' as const,
            ...base,
            warning: `war.app did not confirm (${failure}), so the notifications may already be marked read. ${check}`,
          }),
          readBack: () => findNotifications(ctx, ids),
          unreadable: (failure) => ({
            status: 'unconfirmed' as const,
            outcome: 'unconfirmed' as const,
            ...base,
            warning: `war.app accepted the request, but the list could not be read back (${failure}). ${check}`,
          }),
          classify: (after) => {
            // Gone from the list (deleted, or past the pages read) or read: either way no longer unread.
            const stillUnread = ids.filter((id) => after.get(id)?.unread === true);
            const dismissed = ids.filter((id) => !stillUnread.includes(id));
            if (!stillUnread.length) {
              return { status: 'dismissed' as const, outcome: 'confirmed' as const, ...base, dismissed };
            }
            return {
              status: 'unconfirmed' as const,
              outcome: 'unconfirmed' as const,
              ...base,
              dismissed,
              stillUnread,
              warning: `war.app accepted the request, but the list still shows ${stillUnread.join(', ')} unread. ${check}`,
            };
          },
        });
      },
    },
  );
}
