// Live-game tools over the web-client protocol (through the user's signed-in
// war.app tab): the current board, the player's territory picks, and — gated
// on the user's confirmation — submitting picks.
import { CONFIRM_INJECTION_RULE, defineWrite, McpToolError, registerWrite, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseGameId } from '../client.js';
import {
  FOG_LEVEL_NAMES,
  inGameId,
  OWNER_NEUTRAL,
  OWNER_PICKABLE,
  playersByInGameId,
  type LiveTerritory,
} from '../live.js';
import type { Game, GameMap, Player } from '../normalize.js';
import { Method, writeSendTerritoryPicksParams } from '../protocol/methods.js';
import { gameIdArg, readAnnotations, respond, untrustedDescription, viewArg } from './common.js';
import { lookupMeta, mintMeta, withToolConfig } from './hints.js';
import { loadLiveTerritories, loadPicks, type LiveContext } from './live-context.js';
import { mapOf } from './map.js';
import { resolvePlayer, resolveTerritory } from './resolve.js';

const VIEWS = ['compact', 'full'] as const;
/** Manual distribution lets a player list up to twice their territory limit. */
export const PICKS_PER_TERRITORY = 2;
const MAX_PICK_ARGS = 200;

const BRIDGE_NOTE =
  'Reads through your signed-in war.app tab (ContextMint Bridge), so it sees exactly what you see — fog included.';

const playerArg = z
  .union([z.string(), z.number()])
  .optional()
  .describe('You in this game: your war.app name (or part of it) or GameFeed player id. Omit to use the signed-in account.');

/** `player` when given; else the signed-in account (its invite token is its GameFeed id). */
async function resolveMe(ctx: LiveContext, players: readonly Player[], input: string | number | undefined): Promise<Player> {
  if (input === undefined || String(input).trim() === '') {
    const token = await ctx.myInviteToken();
    const me = token === undefined ? undefined : players.find((p) => p.id === token);
    if (me) return me;
  }
  return resolvePlayer(players, input);
}

/** A territory's owner as a person reads it. */
function ownerLabel(t: LiveTerritory, byInGame: ReadonlyMap<number, Player>): string {
  if (t.fogged) return 'fogged';
  if (t.owner === OWNER_NEUTRAL) return 'neutral';
  if (t.owner === OWNER_PICKABLE) return 'pickable';
  if (t.owner > 0) return byInGame.get(t.owner)?.name ?? `player ${t.owner}`;
  return 'unknown';
}

const nameIn = (map: GameMap) => {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  return (id: number) => names.get(id) ?? String(id);
};

const turnOf = (game: Game) => (game.numberOfTurns !== undefined && game.numberOfTurns >= 0 ? game.numberOfTurns : null);

/** The most territory picks the game's settings allow, when they say. */
export function maxPicks(game: Game): number | null {
  const limit = game.settings?.territoryLimit;
  return limit !== undefined && limit > 0 ? limit * PICKS_PER_TERRITORY : null;
}

function liveBoardView(game: Game, territories: LiveTerritory[], rung: string) {
  const map = mapOf(game);
  const name = nameIn(map);
  const byInGame = playersByInGameId(game.players);
  const stats = new Map<number, { territories: number; armies: number }>();
  for (const t of territories) {
    if (t.fogged || t.owner <= 0) continue;
    const s = stats.get(t.owner) ?? { territories: 0, armies: 0 };
    s.territories++;
    s.armies += t.armies ?? 0;
    stats.set(t.owner, s);
  }
  const header = {
    game: { id: game.id, name: game.name ?? null, state: game.state, turn: turnOf(game) },
    map: { id: map.id, name: map.name },
  };
  const players = game.players.map((p) => {
    let id: number | null = null;
    try {
      id = inGameId(p);
    } catch {
      // not a wrapped id
    }
    const s = id === null ? undefined : stats.get(id);
    const row: Record<string, unknown> = {
      id: p.id,
      name: p.name,
      visibleTerritories: s?.territories ?? 0,
      visibleArmies: s?.armies ?? 0,
    };
    if (rung === 'full') row.inGameId = id;
    return row;
  });
  const pickable = territories.filter((t) => !t.fogged && t.owner === OWNER_PICKABLE).length;
  if (rung === 'full') {
    return {
      ...header,
      players,
      territories: territories.map((t) => ({
        id: t.territoryId,
        name: name(t.territoryId),
        owner: ownerLabel(t, byInGame),
        ownerId: t.owner,
        armies: t.armies,
        fogged: t.fogged,
        fogLevel: FOG_LEVEL_NAMES[t.fogLevel] ?? t.fogLevel,
      })),
    };
  }
  const visible = territories.filter((t) => !t.fogged);
  return {
    ...header,
    players,
    territories: visible.map((t) => ({
      id: t.territoryId,
      name: name(t.territoryId),
      owner: ownerLabel(t, byInGame),
      armies: t.armies,
    })),
    counts: { territories: territories.length, visible: visible.length, fogged: territories.length - visible.length, pickable },
  };
}

export function registerLiveTools(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_get_live_board',
    {
      title: 'Get the live board of a war.app game',
      description: untrustedDescription(
        'The current board of a war.app (Warzone) game as the web client shows it: every territory by name with ' +
          'its owner (a player name, "neutral", or "pickable" while territories are being picked), its armies, ' +
          'and whether it is fogged; plus each player\'s visible territory and army totals. Works in the pick ' +
          `phase and mid-game, where GameFeed has no board. ${BRIDGE_NOTE} Read-only.`,
      ),
      _meta: lookupMeta(['warzone board', 'live board', 'who owns what', 'pickable territories']),
      annotations: readAnnotations('Get a war.app live board'),
      inputSchema: z.object({
        game_id: gameIdArg,
        view: viewArg(
          VIEWS,
          'compact (default) lists the territories you can see (owner by name, armies) with counts of fogged and ' +
            'pickable ones; "full" lists every territory with raw owner ids, fog flags and fog levels, and in-game player ids.',
        ),
      }),
    },
    async ({ game_id, view }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      const territories = await loadLiveTerritories(ctx, game);
      return respond(view, VIEWS, (rung) => liveBoardView(game, territories, rung));
    },
  );

  server.registerTool(
    'warapp_get_my_picks',
    {
      title: 'Get my territory picks in a war.app game',
      description: untrustedDescription(
        'The territory picks you have submitted for a war.app (Warzone) game in manual distribution, in priority ' +
          'order and by name, with how many the game allows (twice its territory limit). ' +
          `${BRIDGE_NOTE} Read-only; use warapp_submit_picks to change them.`,
      ),
      _meta: lookupMeta(['my picks', 'territory picks', 'what did i pick']),
      annotations: readAnnotations('Get my war.app picks'),
      inputSchema: z.object({ game_id: gameIdArg, player: playerArg }),
    },
    async ({ game_id, player }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      const me = await resolveMe(ctx, game.players, player);
      const picks = await loadPicks(ctx, game.id, inGameId(me));
      const name = nameIn(mapOf(game));
      return respond(undefined, ['compact'], () => ({
        game: { id: game.id, state: game.state },
        player: { id: me.id, name: me.name },
        picks: picks.map((id, i) => ({ priority: i + 1, id, name: name(id) })),
        count: picks.length,
        maxPicks: maxPicks(game),
      }));
    },
  );

  const submitSchema = z.object({
    game_id: gameIdArg,
    player: playerArg,
    territories: z
      .array(z.union([z.string(), z.number()]))
      .min(1)
      .max(MAX_PICK_ARGS)
      .describe('Your picks in priority order (first = most wanted): territory ids or names. Replaces any picks already submitted.'),
  });

  interface PicksState {
    gameId: number;
    playerId: number;
    picks: Array<{ id: number; name: string }>;
  }

  withToolConfig(
    server,
    {
      title: 'Submit territory picks in a war.app game',
      _meta: mintMeta('change', ['submit my picks', 'pick territories', 'choose starting territories']),
    },
    () =>
      registerWrite(
        server,
        defineWrite({
          name: 'warapp_submit_picks',
          description:
            'Submit your territory picks for a war.app (Warzone) game in manual distribution, in priority order — ' +
            'they replace any picks you submitted before. Every territory must be pickable on the live board and ' +
            'the list may hold at most twice the game\'s territory limit. After sending, the picks are read back and ' +
            `reported verified only if they match exactly. ${BRIDGE_NOTE} ${CONFIRM_INJECTION_RULE}`,
          annotations: toolAnnotations({
            title: 'Submit war.app picks',
            readOnly: false,
            destructive: true,
            idempotent: true,
            openWorld: true,
          }),
          inputSchema: submitSchema,
          async plan({ game_id, player, territories }) {
            const game = await ctx.client.getGame(parseGameId(game_id), { settings: true });
            const map = mapOf(game);
            const me = await resolveMe(ctx, game.players, player);
            const picks = territories.map((t) => resolveTerritory(map, t));
            const seen = new Set<number>();
            for (const t of picks) {
              if (seen.has(t.id)) throw new McpToolError(`${t.name} (${t.id}) is listed twice.`, { hint: 'List each territory once.' });
              seen.add(t.id);
            }
            const max = maxPicks(game);
            if (max !== null && picks.length > max) {
              throw new McpToolError(`This game allows at most ${max} picks (twice its territory limit); got ${picks.length}.`);
            }
            const board = await loadLiveTerritories(ctx, game);
            const owner = new Map(board.map((t) => [t.territoryId, t]));
            const unpickable = picks.filter((t) => {
              const s = owner.get(t.id);
              return !s || s.fogged || s.owner !== OWNER_PICKABLE;
            });
            if (unpickable.length) {
              throw new McpToolError(
                `Not pickable on the live board: ${unpickable.map((t) => `${t.name} (${t.id})`).join(', ')}.`,
                {
                  hint:
                    game.state === 'DistributingTerritories'
                      ? 'Pick only territories warapp_get_live_board lists as "pickable".'
                      : `Picks are only open while the game distributes territories (game state: ${game.state}).`,
                },
              );
            }
            const playerId = inGameId(me);
            const territoryIds = picks.map((t) => t.id);
            const named = picks.map((t) => ({ id: t.id, name: t.name }));
            return {
              gate: {
                action: 'warapp.submit_picks',
                summary: `Submit ${picks.length} territory pick${picks.length === 1 ? '' : 's'} for ${me.name} in game ${game.id}`,
                account: undefined,
                target: game.id,
                payload: { method: 'SendTerritoryPicks', gameId: game.id, playerId, territoryIds },
                willSend: { game: game.id, player: me.name, picksInPriorityOrder: named },
                preview: { note: 'Replaces any picks already submitted for this game.' },
              },
              state: { gameId: game.id, playerId, picks: named } satisfies PicksState,
            };
          },
          async execute({ gameId, playerId, picks }: PicksState) {
            const ids = picks.map((p) => p.id);
            await ctx.rpc.call('SendTerritoryPicks', Method.SendTerritoryPicks, (w) =>
              writeSendTerritoryPicksParams(w, gameId, ids),
            );
            const readBack = await loadPicks(ctx, gameId, playerId);
            const verified = readBack.length === ids.length && readBack.every((id, i) => id === ids[i]);
            return { sent: true, verified, game: gameId, picks, readBack };
          },
          render: (r) =>
            respond(undefined, ['compact'], () => ({
              ...r,
              ...(r.verified
                ? {}
                : { warning: 'war.app did not read back exactly these picks. Check warapp_get_my_picks before resubmitting.' }),
            })),
          batchable: false,
        }),
      ),
  );
}
