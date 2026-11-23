// warapp_get_my_orders: my own orders this turn, read back from the live board — the orders the web client shows
// again in "Modify orders" — in the shape warapp_submit_turn takes, so a withdrawn turn (warapp_uncommit_turn) can
// be resubmitted exactly as it was, by hand-made orders too. Read-only. Where they live and what is verified:
// src/my-orders.ts (LatestGameInfo's first field, VERIFIED live 2026-11-22 for committed turns).
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseGameId } from '../client.js';
import { myOrdersOf, type MyOrder, type MyOrders } from '../my-orders.js';
import type { Game } from '../normalize.js';
import { bonusNamer, gameIdArg, namer, readAnnotations, respond, untrustedDescription, untrustedText } from './common.js';
import { lookupMeta } from './hints.js';
import { readLatestBoard, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { mapOf } from './map.js';
import { currentTurn, requireTurnPhase } from './turn.js';
import { accountUnknown } from './write-kit.js';

/** What a read of my orders gives: the orders (`null`: unknown) and, when the board could not be read, why. */
export interface MyOrdersRead {
  read: MyOrders | null;
  /** The live board could not be read (the reason). */
  failure?: string;
}

/** My orders this turn from the live board; never throws (a failed read is `failure`, the orders unknown). */
export async function readMyOrders(ctx: LiveContext, game: Game): Promise<MyOrdersRead> {
  try {
    const { info } = await readLatestBoard(ctx, game.id);
    return { read: myOrdersOf(info, game.players) };
  } catch (e) {
    return { read: null, failure: e instanceof Error ? e.message : String(e) };
  }
}

/** One line per order, for a person: territories, bonuses and players named (names are untrusted). */
export function shownOrders(orders: readonly MyOrder[], game: Game): string[] {
  const map = game.map ? mapOf(game) : undefined;
  const t = (id: number) => (map ? `${untrustedText(namer(map)(id).name)} (${id})` : `territory ${id}`);
  const b = (id: number) => (map ? `${untrustedText(bonusNamer(map)(id).name)} (${id})` : `bonus ${id}`);
  const p = (id: number) => {
    if (id === 0) return 'neutral';
    const seat = game.players.find((x) => x.id === id);
    return seat ? `${untrustedText(seat.name)} (${id})` : `player ${id}`;
  };
  return orders.map((o) => {
    if (o.kind === 'deploy') return `Deploy ${o.armies} on ${t(o.territory)}`;
    if (o.kind === 'discard') return `Discard card ${o.card}`;
    if (o.kind === 'move') {
      const opts = [o.mode, o.percent ? 'percent' : undefined, o.commander ? 'with commander' : undefined, o.attack_teammates ? 'attack teammates' : undefined]
        .filter((x): x is string => x !== undefined);
      return `Move ${o.armies}${o.percent ? '%' : ''} ${t(o.from)} → ${t(o.to)}${opts.length ? ` (${opts.join(', ')})` : ''}`;
    }
    const parts = [
      o.target !== undefined ? `on ${t(o.target)}` : undefined,
      o.player !== undefined ? `player ${p(o.player)}` : undefined,
      o.players ? `between ${p(o.players[0])} and ${p(o.players[1])}` : undefined,
      o.bonus !== undefined ? `on ${b(o.bonus)}` : undefined,
      o.from !== undefined && o.to !== undefined ? `${o.armies ?? 0} ${t(o.from)} → ${t(o.to)}${o.commander ? ' with commander' : ''}` : undefined,
      o.before !== undefined ? `above move ${o.before}` : undefined,
    ].filter((x): x is string => x !== undefined);
    return `Play ${o.cardType} card${parts.length ? ` ${parts.join(', ')}` : ''}`;
  });
}

const COMMITTED_NOTE =
  "Read from the live board: war.app's own copy of your committed orders (what the web client shows in \"Modify " +
  'orders"), verified live. Pass `orders` to warapp_submit_turn unchanged to resubmit them (after warapp_uncommit_turn), ' +
  'or edit them first. `cardType` and `shown` are for display only.';
const ENTERED_NOTE =
  'Your orders are not committed: these are the orders war.app holds as entered for you, which is UNVERIFIED live ' +
  '(only committed orders have been checked). Pass `orders` to warapp_submit_turn to commit them.';
const UNKNOWN_NOTE =
  'war.app sent no list of your orders for this turn, so they are unknown (null), never "none": nothing entered, ' +
  'or not sent. Check the web client before submitting replacements.';

export function registerMyOrdersTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_get_my_orders',
    {
      title: 'Read back my orders for this war.app turn',
      description: untrustedDescription(
        'Your own orders for the current turn of a war.app (Warzone) game, read back from war.app — the orders the ' +
          'web client shows again in "Modify orders": whether they are committed, and the deploys, moves (with ' +
          'their options), card plays (card GUID and targets: territory, player, bonus, Airlift from/to/armies, ' +
          'Order Delay `before`) and discards in exactly the shape warapp_submit_turn takes (ids; players by GameFeed ' +
          'id), plus `shown`, one readable line per order with names. Use it before warapp_uncommit_turn, or after, to ' +
          'resubmit a committed turn unchanged or with one order added — hand-made orders included. `orders` is null ' +
          'when war.app sent none or the board could not be read: unknown, never "none". Committed orders are verified ' +
          `live; entered but uncommitted ones are not. Refuses outside a turn phase. ${BRIDGE_NOTE} Read-only.`,
      ),
      _meta: lookupMeta(['my orders', 'my committed orders', 'read back my orders', 'resubmit my turn', 'modify orders', 'what did i order']),
      annotations: readAnnotations('Read back my war.app orders'),
      inputSchema: z.object({ game_id: gameIdArg }),
    },
    async ({ game_id }) => {
      const gameId = parseGameId(game_id);
      const game = await ctx.client.getGame(gameId);
      requireTurnPhase(game);
      const token = await ctx.myInviteToken().catch(() => undefined);
      if (token === undefined) throw accountUnknown(ctx, 'your orders cannot be read');
      const seat = game.players.find((p) => p.id === token);
      if (!seat) {
        throw new McpToolError(`The signed-in war.app account is not a player in game ${game.id}.`, {
          hint: 'Check the game id with warapp_my_games.',
        });
      }
      const { read, failure } = await readMyOrders(ctx, game);
      const warnings = failure ? [`The live board could not be read (${failure}): your orders are unknown.`] : [];
      return respond(undefined, ['compact'], () => ({
        game: { id: game.id, name: game.name === undefined ? null : untrustedText(game.name), turn: currentTurn(game) },
        committed: seat.hasCommittedOrders,
        orders: read?.orders ?? null,
        shown: read ? shownOrders(read.orders, game) : null,
        ...(read?.unread.length ? { unread: read.unread } : {}),
        note: !read ? UNKNOWN_NOTE : seat.hasCommittedOrders ? COMMITTED_NOTE : ENTERED_NOTE,
        ...(read?.unread.length
          ? {
              unreadNote:
                'Orders war.app holds that this server could not read back: they are not in `orders`, so resubmitting ' +
                '`orders` would drop them. Check the web client.',
            }
          : {}),
        ...(warnings.length ? { warnings } : {}),
      }));
    },
  );
}
