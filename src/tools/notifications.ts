// warapp_get_notifications, warapp_dismiss_notification and warapp_delete_notification (#311): war.app's
// in-app notifications (the client's "In App Notifications" screen), read with GetInAppNotifications (317),
// marked read with AcknowledgeInAppNotifications (319) and deleted with DeleteInAppNotification (318, the
// client's Delete button). All read from the client bundle, UNVERIFIED live (docs/WEB-PROTOCOL.md,
// Notifications and read marks).
//
// The list is name-free beyond ids: a notification's title and data are war.app's text with other
// players' names in it, read only to classify the notification and find the game its link names.
// A game-ended notification folds the game's kept opponent profile (B2, `foldFinishedGame`) when one
// is kept unfolded — the one GameFeed read warapp_get_game's fold makes, and none otherwise.
//
// Dismissing marks read and never deletes; deleting is its own tool, one 318 per id, error 699 read as
// already gone. Neither sends anything to any player. Automated chat stays off (D2): neither is a send.
import { CONFIRM_INJECTION_RULE, toolAnnotations, type EnvSource } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { classifyNotification, readInAppNotifications, type Notification, type RawNotification } from '../notifications.js';
import { foldFinishedGame, hasUnfoldedProfile, profileEnabled } from '../profile-store.js';
import {
  Method,
  NOTIFICATION_ID,
  NOTIFICATION_NOT_FOUND,
  NOTIFICATIONS_PAGE_SIZE,
  writeAcknowledgeInAppNotificationsParams,
  writeDeleteInAppNotificationParams,
  writeGetInAppNotificationsParams,
} from '../protocol/methods.js';
import { notSent, WarappServerError } from '../protocol/rpc.js';
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
/** The most ids one dismissal (or deletion) takes. */
export const MAX_DISMISS_IDS = NOTIFICATIONS_PAGE_SIZE;

/** One page of the account's notifications, from `start`. */
async function listPage(ctx: LiveContext, start: number): Promise<{ items: RawNotification[]; total: number }> {
  const env = await ctx.rpc.call('GetInAppNotifications', Method.GetInAppNotifications, (w) => writeGetInAppNotificationsParams(w, start));
  return readInAppNotifications(await ctx.bundle(), env.body);
}

/** What a search of the list found, and how much of the list it read. */
interface Found {
  found: Map<string, RawNotification>;
  /** Each found id's index in the list as read. */
  positions: Map<string, number>;
  /** How many notifications the pages read held (the list read from the top, to this index). */
  readTo: number;
  /** The list's length as war.app gave it on the last page read. */
  total: number;
  /** The pages read covered the whole list. */
  complete: boolean;
}

/** The notifications among `ids` the list holds, read page by page until all are found (at most MAX_FIND_PAGES). */
async function findNotifications(ctx: LiveContext, ids: readonly string[]): Promise<Found> {
  const want = new Set(ids);
  const found = new Map<string, RawNotification>();
  const positions = new Map<string, number>();
  let start = 0;
  let total = 0;
  let complete = false;
  for (let page = 0; page < MAX_FIND_PAGES; page++) {
    const listed = await listPage(ctx, start);
    total = listed.total;
    listed.items.forEach((n, i) => {
      if (want.has(n.id) && !found.has(n.id)) {
        found.set(n.id, n);
        positions.set(n.id, start + i);
      }
    });
    start += listed.items.length;
    if (listed.items.length === 0 || start >= total) {
      complete = true;
      break;
    }
    if (found.size === want.size) break;
  }
  return { found, positions, readTo: start, total, complete };
}

/**
 * An id the read-back did not find is seen gone only when the pages read cover the whole list, or
 * reach past where it stood when planned by as many notifications as the list has grown since (new
 * ones arrive at the top and push it down). Otherwise it is simply not seen: never confirmed.
 */
export function seenGone(after: Pick<Found, 'readTo' | 'total' | 'complete'>, position: number | undefined, totalBefore: number): boolean {
  if (after.complete) return true;
  if (position === undefined) return false;
  return after.readTo > position + Math.max(0, after.total - totalBefore);
}

/**
 * Fold the kept opponent profile of each game a game-ended notification names (B2): only where a
 * per-game file is kept unfolded, one GameFeed read (no map) per such game, at most FOLD_LOOKUPS.
 * Best effort: a failed read folds nothing and is never an error.
 */
async function foldEndedGames(ctx: LiveContext, env: EnvSource, notes: readonly Notification[]): Promise<Array<{ gameId: number; files: number }>> {
  // TODO(#312): a game-ended notification is one of the end-of-game pass's triggers. That pass does not
  // exist yet (batch 24 builds it); when it lands, call it here for each game-ended `gameId` (it is
  // idempotent through its per-game "processed" record), in place of or beside this profile fold.
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

interface DeleteState {
  me: number;
  ids: string[];
  /** Where each id stood in the list when planned, and the list's length then. */
  positions: Record<string, number>;
  totalBefore: number;
}

/** What the per-id sends of a deletion did, in order: the rest after a stop were never sent. */
interface DeleteSends {
  sent: string[];
  alreadyGone: string[];
  refused?: { id: string; code: number };
  unanswered?: string;
  /** The id whose request failed before it left (#272: nothing sent), after an earlier id changed something. */
  unsent?: string;
  notSent: string[];
}

/** Clean, validated notification ids, or a refusal naming the bad ones. */
function askedIds(ids: ReadonlyArray<string | number>): string[] {
  const asked = [...new Set(ids.map((id) => String(id).trim()))];
  const bad = asked.filter((id) => !NOTIFICATION_ID.test(id));
  if (bad.length) {
    refuse(`Not a notification id: ${bad.slice(0, 5).join(', ')}. Nothing was sent.`, 'Use the ids warapp_get_notifications lists.');
  }
  return asked;
}

interface DismissState {
  me: number;
  ids: string[];
  alreadyRead: string[];
  /** Where each id stood in the list when planned, and the list's length then. */
  positions: Record<string, number>;
  totalBefore: number;
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
          '`kind` (`game-ended` when the title is war.app\'s "Game … has ended." line, else `other`), `gameId` (the ' +
          'game its link names, or null), `time` and `unread`. The title and body are never shown (they carry other ' +
          "players' names). " +
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
        'by the ids warapp_get_notifications lists. It never deletes a notification (warapp_delete_notification does) ' +
        'and sends nothing to any player. ' +
        'Refuses ids war.app does not list and ids already read. Always as the signed-in war.app account; the outcome ' +
        'is read back by listing again (`dismissed`; `unconfirmed` while one still reads unread or was not seen in the ' +
        'pages read back; or `unknown` when ' +
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
        const asked = askedIds(ids);
        const me = await requireMe(ctx);
        const { found, positions, total } = await findNotifications(ctx, asked);
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
          state: {
            me,
            ids: unread,
            alreadyRead,
            positions: Object.fromEntries(unread.map((id) => [id, positions.get(id)!])),
            totalBefore: total,
          } satisfies DismissState,
        };
      },
      async execute({ me, ids, alreadyRead, positions, totalBefore }: DismissState) {
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
            // Read on the list, or seen gone from it (deleted): no longer unread. Not found where the pages
            // read could not tell: not seen, so never confirmed.
            const stillUnread = ids.filter((id) => after.found.get(id)?.unread === true);
            const dismissed = ids.filter((id) => after.found.get(id)?.unread === false);
            const missing = ids.filter((id) => !after.found.has(id));
            const gone = missing.filter((id) => seenGone(after, positions[id], totalBefore));
            const notSeen = missing.filter((id) => !gone.includes(id));
            const parts = {
              ...(dismissed.length ? { dismissed } : {}),
              ...(gone.length ? { gone } : {}),
            };
            if (!stillUnread.length && !notSeen.length) {
              return { status: 'dismissed' as const, outcome: 'confirmed' as const, ...base, ...parts };
            }
            const problems = [
              ...(stillUnread.length ? [`the list still shows ${stillUnread.join(', ')} unread`] : []),
              ...(notSeen.length
                ? [`${notSeen.join(', ')} ${notSeen.length === 1 ? 'was' : 'were'} not seen in the pages read (${after.readTo} of ${after.total})`]
                : []),
            ];
            return {
              status: 'unconfirmed' as const,
              outcome: 'unconfirmed' as const,
              ...base,
              ...parts,
              ...(stillUnread.length ? { stillUnread } : {}),
              ...(notSeen.length ? { notSeen } : {}),
              warning: `war.app accepted the request, but ${problems.join(', and ')}. ${check}`,
            };
          },
        });
      },
    },
  );

  defineGatedWrite(
    server,
    {
      title: 'Delete war.app notifications',
      _meta: mintMeta('change', ['delete notification', 'remove notification', 'clear old notifications']),
    },
    {
      name: 'warapp_delete_notification',
      description:
        "Delete one or several war.app (Warzone) in-app notifications (war.app's DeleteInAppNotification, the client's " +
        'Delete button), by the ids warapp_get_notifications lists, read or unread: one request per id, in order. A ' +
        'deleted notification is gone from war.app for good; it sends nothing to any player (to keep it and only clear ' +
        'its unread mark, use warapp_dismiss_notification). Refuses ids war.app does not list. Always as the signed-in ' +
        'war.app account; an id war.app no longer holds when sent (its error 699) counts as already gone (`alreadyGone`). ' +
        'The outcome is read back by listing again (`deleted`; `unconfirmed` while one is still listed, was not seen in ' +
        'the pages read back, or war.app refused one — the ids after a refusal are not sent; or `unknown` when war.app ' +
        `did not answer — never resend blindly). ${NOTIFICATIONS_UNVERIFIED} ${BRIDGE_NOTE} ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({
        title: 'Delete war.app notifications',
        readOnly: false,
        destructive: true,
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
        const asked = askedIds(ids);
        const me = await requireMe(ctx);
        const { found, positions, total } = await findNotifications(ctx, asked);
        const missing = asked.filter((id) => !found.has(id));
        if (missing.length) {
          refuse(
            `war.app does not list notification ${missing.join(', ')}, so nothing was sent.`,
            'List them again with warapp_get_notifications: it may already be deleted.',
          );
        }
        const shown = asked.map((id) => {
          const n = classifyNotification(found.get(id)!);
          return { id: n.id, kind: n.kind, gameId: n.gameId, time: n.time, unread: n.unread };
        });
        const label = asked.length === 1 ? `notification ${asked[0]}` : `${asked.length} notifications (${asked.join(', ')})`;
        return {
          gate: {
            action: 'warapp.delete_notification',
            // By id only: a notification's title and body are war.app's text with other players' names.
            summary: `Delete war.app ${label}`,
            account: writeAccount(me),
            target: asked.join(','),
            payload: { method: 'DeleteInAppNotification', ids: asked },
            willSend: { ids: asked },
            preview: {
              warning: `This deletes ${label} from your war.app notifications; it cannot be undone. Nothing reaches another player.`,
              account: `war.app account ${me}`,
              notifications: shown,
              unverified: NOTIFICATIONS_UNVERIFIED,
            },
          },
          state: {
            me,
            ids: asked,
            positions: Object.fromEntries(asked.map((id) => [id, positions.get(id)!])),
            totalBefore: total,
          } satisfies DeleteState,
        };
      },
      async execute({ me, ids, positions, totalBefore }: DeleteState) {
        await requireApprovedAccount(ctx, writeAccount(me));
        const check = 'Check warapp_get_notifications before doing anything else.';
        const sends: DeleteSends = { sent: [], alreadyGone: [], notSent: [] };
        const progress = () => ({
          ...(sends.alreadyGone.length ? { alreadyGone: sends.alreadyGone } : {}),
          ...(sends.refused ? { refused: sends.refused } : {}),
          ...(sends.notSent.length ? { notSent: sends.notSent } : {}),
        });
        return sendAndVerify({
          // One request per id, in order, never retried. A refusal (other than 699), no answer or a request that
          // could not be sent stops there: the ids after it are not sent. A refusal or an unsent request before
          // anything changed is an error; after, it is reported and the read-back judges what did change.
          send: async () => {
            for (const [i, id] of ids.entries()) {
              try {
                await ctx.rpc.call('DeleteInAppNotification', Method.DeleteInAppNotification, (w) => writeDeleteInAppNotificationParams(w, id));
                sends.sent.push(id);
              } catch (e) {
                if (e instanceof WarappServerError && e.code === NOTIFICATION_NOT_FOUND) {
                  sends.alreadyGone.push(id);
                  continue;
                }
                sends.notSent = ids.slice(i + 1);
                const changed = sends.sent.length + sends.alreadyGone.length > 0;
                if (changed && notSent(e)) {
                  // Never "nothing changed": earlier ids went. This one never left, so it is not sent either.
                  sends.unsent = id;
                  sends.notSent = ids.slice(i);
                  return;
                }
                if (e instanceof WarappServerError) {
                  if (!changed) throw e;
                  sends.refused = { id, code: e.code };
                  return;
                }
                sends.unanswered = id;
                throw e;
              }
            }
          },
          unanswered: (failure) => ({
            status: 'unknown' as const,
            outcome: 'unknown' as const,
            ids,
            ...(sends.sent.length ? { sent: sends.sent } : {}),
            ...(sends.unanswered ? { unanswered: sends.unanswered } : {}),
            ...progress(),
            warning:
              `war.app did not confirm (${failure}), so notification ${sends.unanswered ?? ids[0]} may already be deleted` +
              `${sends.notSent.length ? `; ${sends.notSent.join(', ')} ${sends.notSent.length === 1 ? 'was' : 'were'} not sent` : ''}. ${check}`,
          }),
          readBack: () => findNotifications(ctx, ids),
          unreadable: (failure) => ({
            status: 'unconfirmed' as const,
            outcome: 'unconfirmed' as const,
            ids,
            ...(sends.sent.length ? { sent: sends.sent } : {}),
            ...progress(),
            warning: `war.app accepted the request, but the list could not be read back (${failure}). ${check}`,
          }),
          classify: (after) => {
            // Each id sent (or already gone) is deleted only once seen gone; one still listed, or not found where
            // the pages read could not tell, is not confirmed.
            const tried = [...sends.sent, ...sends.alreadyGone];
            const stillListed = tried.filter((id) => after.found.has(id));
            const missing = tried.filter((id) => !after.found.has(id));
            const gone = missing.filter((id) => seenGone(after, positions[id], totalBefore));
            const notSeen = missing.filter((id) => !gone.includes(id));
            const deleted = gone.filter((id) => sends.sent.includes(id));
            const parts = { ids, ...(deleted.length ? { deleted } : {}), ...progress() };
            if (!stillListed.length && !notSeen.length && !sends.refused && !sends.unsent) {
              return { status: 'deleted' as const, outcome: 'confirmed' as const, ...parts };
            }
            const problems = [
              ...(sends.refused
                ? [`war.app refused ${sends.refused.id} (error ${sends.refused.code})${sends.notSent.length ? `, so ${sends.notSent.join(', ')} ${sends.notSent.length === 1 ? 'was' : 'were'} not sent` : ''}`]
                : []),
              ...(sends.unsent
                ? [sends.notSent.length > 1 ? `${sends.unsent} could not be sent, so ${sends.notSent.slice(1).join(', ')} ${sends.notSent.length === 2 ? 'was' : 'were'} not sent either` : `${sends.unsent} could not be sent`]
                : []),
              ...(stillListed.length ? [`the list still holds ${stillListed.join(', ')}`] : []),
              ...(notSeen.length
                ? [`${notSeen.join(', ')} ${notSeen.length === 1 ? 'was' : 'were'} not seen in the pages read (${after.readTo} of ${after.total})`]
                : []),
            ];
            return {
              status: 'unconfirmed' as const,
              outcome: 'unconfirmed' as const,
              ...parts,
              ...(stillListed.length ? { stillListed } : {}),
              ...(notSeen.length ? { notSeen } : {}),
              warning: `${problems.join(', and ')}. ${check}`,
            };
          },
        });
      },
    },
  );
}
