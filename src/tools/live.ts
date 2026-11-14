// Live-game tools over the web-client protocol (through the user's signed-in
// war.app tab): the current board, the player's territory picks, and — gated
// on the user's confirmation — submitting picks.
import { CONFIRM_INJECTION_RULE, defineWrite, McpToolError, registerWrite, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { clientPickLimits } from '../analysis/picks.js';
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
import { pickingNeutrals, writePickable, writePickList } from '../pick-list.js';
import { Method, writeSendTerritoryPicksParams } from '../protocol/methods.js';
import {
  currentTurn,
  gameIdArg,
  readAnnotations,
  respond,
  shownAccount,
  turnsCompleted,
  UNTRUSTED_PREVIEW_NOTE,
  untrustedDescription,
  UNTRUSTED_LIST_MAX,
  untrustedList,
  untrustedText,
  viewArg,
} from './common.js';
import { lookupMeta, mintMeta, withToolConfig } from './hints.js';
import { loadLiveTerritories, loadPicks, requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { mapOf } from './map.js';
import { resolvePlayer, resolveTerritory } from './resolve.js';

const VIEWS = ['compact', 'full'] as const;
const MAX_PICK_ARGS = 200;

export const BRIDGE_NOTE =
  'Reads through your signed-in war.app tab (ContextMint Bridge), so it sees exactly what you see — fog included.';

export const playerArg = z
  .union([z.string(), z.number()])
  .optional()
  .describe('You in this game: your war.app name (or part of it) or GameFeed player id. Omit to use the signed-in account.');

/** `player` when given; else the signed-in account (its invite token is its GameFeed id). */
export async function resolveMe(
  ctx: LiveContext,
  players: readonly Player[],
  input: string | number | undefined,
  opts: { fresh?: boolean } = {},
): Promise<Player> {
  if (input === undefined || String(input).trim() === '') {
    const token = await ctx.myInviteToken(opts);
    const me = token === undefined ? undefined : players.find((p) => p.id === token);
    if (me) return me;
  }
  return resolvePlayer(players, input);
}

/**
 * A write through the bridge always acts as the signed-in account, whatever `player` says
 * (issue #7) — so refuse a different player, and refuse when the account is unknown.
 */
async function assertSignedInAccount(ctx: LiveContext, player: Player): Promise<void> {
  const token = await ctx.myInviteToken({ fresh: true });
  if (token === undefined) {
    throw new McpToolError('Could not tell which account is signed in to war.app, so nothing was sent.', {
      hint: 'Writes always act as the signed-in account. Make sure a signed-in war.app tab is open and paired, then retry.',
    });
  }
  if (player.id !== token) {
    throw new McpToolError(
      `${untrustedText(player.name)} is not the signed-in war.app account, so nothing was sent: writes always act as the signed-in account.`,
      { hint: 'Omit `player` (it defaults to the signed-in account), or sign in to war.app as that player.' },
    );
  }
}

/** A territory's owner as a person reads it. */
function ownerLabel(t: LiveTerritory, byInGame: ReadonlyMap<number, Player>): string {
  if (t.fogged) return 'fogged';
  if (t.owner === OWNER_NEUTRAL) return 'neutral';
  if (t.owner === OWNER_PICKABLE) return 'pickable';
  if (t.owner > 0) return byInGame.get(t.owner)?.name ?? `player ${t.owner}`;
  return 'unknown';
}

/** A unit owner's name, as {@link ownerLabel} names a territory's player owner. */
function playerLabel(id: number, byInGame: ReadonlyMap<number, Player>): string {
  return byInGame.get(id)?.name ?? `player ${id}`;
}

/** The commander(s) on a territory, by owner name; `undefined` when there is none. */
function commanderOn(t: LiveTerritory, byInGame: ReadonlyMap<number, Player>): string | undefined {
  const owners = (t.specialUnits ?? []).filter((u) => u.kind === 'commander').map((u) => playerLabel(u.owner, byInGame));
  return owners.length ? owners.join(', ') : undefined;
}

const nameIn = (map: GameMap) => {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  return (id: number) => names.get(id) ?? String(id);
};


/**
 * The most territory picks war.app's client lets a player list (players × territories per
 * player, #129), when the settings say; `pickable` (the live board's count) can lower it.
 */
export function maxPicks(game: Game, pickable?: number): number | null {
  return clientPickLimits({ territoryLimit: game.settings?.territoryLimit, players: game.players.length, pickable })?.max ?? null;
}

/** Which territories warapp_get_live_board lists, and which page of them (#130). */
export interface BoardSelection {
  /** Only these territory ids. */
  ids?: ReadonlySet<number>;
  /** Only territories with this owner (an in-game id, or OWNER_NEUTRAL / OWNER_PICKABLE). */
  owner?: number;
  offset?: number;
  limit?: number;
}

/** The selected territories of `list`, and the page block when paged. */
function select<T extends LiveTerritory>(list: readonly T[], sel: BoardSelection) {
  const matched = list.filter(
    (t) => (sel.ids === undefined || sel.ids.has(t.territoryId)) && (sel.owner === undefined || (!t.fogged && t.owner === sel.owner)),
  );
  if (sel.limit === undefined && sel.offset === undefined) return { shown: matched };
  const offset = sel.offset ?? 0;
  const limit = sel.limit ?? matched.length;
  const shown = matched.slice(offset, offset + limit);
  const next = offset + shown.length;
  return { shown, page: { offset, limit, matched: matched.length, nextOffset: next < matched.length ? next : null } };
}

function liveBoardView(game: Game, territories: LiveTerritory[], rung: string, sel: BoardSelection = {}) {
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
    game: { id: game.id, name: game.name ?? null, state: game.state, turn: currentTurn(game), turnsCompleted: turnsCompleted(game) },
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
    const { shown, page } = select(territories, sel);
    return {
      ...header,
      players,
      ...(page ? { page } : {}),
      territories: shown.map((t) => ({
        id: t.territoryId,
        name: name(t.territoryId),
        owner: ownerLabel(t, byInGame),
        ownerId: t.owner,
        armies: t.armies,
        fogged: t.fogged,
        fogLevel: FOG_LEVEL_NAMES[t.fogLevel] ?? t.fogLevel,
        specialUnits: (t.specialUnits ?? []).map((u) => ({
          kind: u.kind,
          ...(u.type ? { type: u.type } : {}),
          id: u.id,
          owner: playerLabel(u.owner, byInGame),
          ownerId: u.owner,
        })),
      })),
    };
  }
  const visible = territories.filter((t) => !t.fogged);
  const { shown, page } = select(visible, sel);
  return {
    ...header,
    players,
    ...(page ? { page } : {}),
    territories: shown.map((t) => {
      const commander = commanderOn(t, byInGame);
      return {
        id: t.territoryId,
        name: name(t.territoryId),
        owner: ownerLabel(t, byInGame),
        armies: t.armies,
        ...(commander ? { commander } : {}),
      };
    }),
    counts: { territories: territories.length, visible: visible.length, fogged: territories.length - visible.length, pickable },
  };
}

const FALLBACK_NOTE =
  "Decoded by a cached copy of war.app's client: the current version could not be looked up (a frozen or " +
  'signed-out tab?). Reload or focus a war.app tab; warapp_session_status shows the decoder.';

export function registerLiveTools(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_get_live_board',
    {
      title: 'Get the live board of a war.app game',
      description: untrustedDescription(
        'The current board of a war.app (Warzone) game as the web client shows it: every territory by name with ' +
          'its owner (a player name, "neutral", or "pickable" while territories are being picked), its armies, ' +
          'whether it is fogged and, in a Commanders game, whose commander stands on it (losing your commander ' +
          'eliminates you); plus each player\'s visible territory and army totals. Works in the pick ' +
          'phase and mid-game, where GameFeed has no board. On a large map, narrow it with `owner`, `territories` or ' +
          `\`limit\`/\`offset\` paging (the counts stay whole-board). ${BRIDGE_NOTE} Read-only.`,
      ),
      _meta: lookupMeta(['warzone board', 'live board', 'who owns what', 'pickable territories', 'where is my commander']),
      annotations: readAnnotations('Get a war.app live board'),
      inputSchema: z.object({
        game_id: gameIdArg,
        view: viewArg(
          VIEWS,
          'compact (default) lists the territories you can see (owner by name, armies, `commander` naming the owner of ' +
            'a commander standing there) with counts of fogged and pickable ones; "full" lists every territory with raw ' +
            'owner ids, fog flags and fog levels, its special units (commanders, bosses) with owners, and in-game player ids.',
        ),
        owner: z
          .union([z.string(), z.number()])
          .optional()
          .describe('Only territories owned by: "me", "neutral", "pickable", or a player (name or GameFeed id).'),
        territories: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .max(MAX_PICK_ARGS)
          .optional()
          .describe('Only these territories (ids or names).'),
        limit: z.coerce.number().int().min(1).max(5000).optional().describe('Page size; omit for every match.'),
        offset: z.coerce.number().int().min(0).optional().describe('Skip this many matches (from a previous `page.nextOffset`).'),
      }),
    },
    async ({ game_id, view, owner, territories: only, limit, offset }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      const sel: BoardSelection = {
        ...(limit !== undefined ? { limit } : {}),
        ...(offset !== undefined ? { offset } : {}),
      };
      if (only) sel.ids = new Set(only.map((t) => resolveTerritory(mapOf(game), t).id));
      if (owner !== undefined && String(owner).trim() !== '') {
        const o = String(owner).trim().toLowerCase();
        sel.owner =
          o === 'neutral'
            ? OWNER_NEUTRAL
            : o === 'pickable'
              ? OWNER_PICKABLE
              : inGameId(await resolveMe(ctx, game.players, o === 'me' ? undefined : owner));
      }
      const territories = await loadLiveTerritories(ctx, game);
      const decoder = ctx.decoderReport();
      return respond(view, VIEWS, (rung) => {
        const out = liveBoardView(game, territories, rung, sel);
        // What the decoding rests on (#148): always on full; on compact only when a stand-in decoded it.
        if (!decoder || (rung !== 'full' && !decoder.fallback)) return out;
        return {
          ...out,
          decoder:
            rung === 'full'
              ? decoder
              : { bundleVersion: decoder.bundleVersion, fallback: true, note: FALLBACK_NOTE },
        };
      });
    },
  );

  server.registerTool(
    'warapp_get_my_picks',
    {
      title: 'Get my territory picks in a war.app game',
      description: untrustedDescription(
        'The territory picks you have submitted for a war.app (Warzone) game in manual distribution, in priority ' +
          "order and by name, with the most war.app's client lets a player list (players × the territory limit). " +
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
      // Kept while territories are being distributed, so the award can be read from it later (#166):
      // only for the signed-in account (no `player` given), the one war.app answers for.
      if (ctx.dataDir && player === undefined && game.state === 'DistributingTerritories' && picks.length)
        await writePickList(ctx.dataDir, game.id, me.id, picks);
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
    /** The account the plan checked and the gate bound (its GameFeed id). */
    me: number;
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
            'they replace any picks you submitted before. Every territory must be pickable on the live board; a list ' +
            "longer than war.app's client allows (players × territories per player) or shorter than the territories " +
            'each player is granted is warned about in the preview. After sending, the picks are read back and ' +
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
            const me = await resolveMe(ctx, game.players, player, { fresh: true });
            await assertSignedInAccount(ctx, me);
            const picks = territories.map((t) => resolveTerritory(map, t));
            const seen = new Set<number>();
            for (const t of picks) {
              if (seen.has(t.id)) {
                throw new McpToolError(`${untrustedText(t.name)} (${t.id}) is listed twice.`, { hint: 'List each territory once.' });
              }
              seen.add(t.id);
            }
            const board = await loadLiveTerritories(ctx, game);
            const owner = new Map(board.map((t) => [t.territoryId, t]));
            const unpickable = picks.filter((t) => {
              const s = owner.get(t.id);
              return !s || s.fogged || s.owner !== OWNER_PICKABLE;
            });
            if (unpickable.length) {
              throw new McpToolError(
                `Not pickable on the live board: ${untrustedList(unpickable, UNTRUSTED_LIST_MAX, (t) => `${untrustedText(t.name)} (${t.id})`)}.`,
                {
                  hint:
                    game.state === 'DistributingTerritories'
                      ? 'Pick only territories warapp_get_live_board lists as "pickable".'
                      : `Picks are only open while the game distributes territories (game state: ${game.state}).`,
                },
              );
            }
            // The list's length is checked against the client's own bounds (#129) as a warning:
            // its picking UI stops at the maximum, and its validation rejects a list shorter
            // than the minimum, but neither is verified against the server.
            const pickable = board.filter((t) => !t.fogged && t.owner === OWNER_PICKABLE).map((t) => t.territoryId);
            const pickableCount = pickable.length;
            // Kept for the turns to come: where a player could have started (warapp_locate_opponents).
            // #201: with the picking board's neutrals, so a fogged one keeps its size later.
            if (ctx.dataDir) await writePickable(ctx.dataDir, game.id, me.id, pickable, pickingNeutrals(board));
            const bounds = clientPickLimits({
              territoryLimit: game.settings?.territoryLimit,
              players: game.players.length,
              pickable: pickableCount,
            });
            const lengthWarnings: string[] = [];
            if (bounds && picks.length > bounds.max)
              lengthWarnings.push(
                `war.app's client lets a player list at most ${bounds.max} picks here (${game.players.length} players × ${bounds.perPlayer} territories each); got ${picks.length}. The extra picks may be ignored.`,
              );
            if (bounds && picks.length < bounds.min)
              lengthWarnings.push(
                `war.app expects at least ${bounds.min} picks here (the territories each player is granted); got ${picks.length}, which it may reject.`,
              );
            const playerId = inGameId(me);
            const territoryIds = picks.map((t) => t.id);
            const named = picks.map((t) => ({ id: t.id, name: t.name }));
            return {
              gate: {
                action: 'warapp.submit_picks',
                // By id only: player and territory names are other people's words and go,
                // delimited, in labelled fields.
                summary: `Submit ${picks.length} territory pick${picks.length === 1 ? '' : 's'} for player ${me.id} in game ${game.id}`,
                account: writeAccount(me.id),
                target: game.id,
                payload: { method: 'SendTerritoryPicks', gameId: game.id, playerId, territoryIds },
                willSend: {
                  game: game.id,
                  player: untrustedText(me.name),
                  picksInPriorityOrder: named.map((t) => ({ id: t.id, name: untrustedText(t.name) })),
                },
                preview: {
                  account: shownAccount(me.name, me.id),
                  note: 'Replaces any picks already submitted for this game.',
                  untrusted: UNTRUSTED_PREVIEW_NOTE,
                  ...(lengthWarnings.length ? { warnings: lengthWarnings } : {}),
                },
              },
              state: { gameId: game.id, playerId, picks: named, me: me.id } satisfies PicksState,
            };
          },
          async execute({ gameId, playerId, picks, me }: PicksState) {
            await requireApprovedAccount(ctx, writeAccount(me));
            const ids = picks.map((p) => p.id);
            await ctx.rpc.call('SendTerritoryPicks', Method.SendTerritoryPicks, (w) =>
              writeSendTerritoryPicksParams(w, gameId, ids),
            );
            // The send went through: a failed read-back must not hide that (#130).
            let readBack: number[] | null;
            let readBackError: string | undefined;
            try {
              readBack = await loadPicks(ctx, gameId, playerId);
            } catch (e) {
              readBack = null;
              readBackError = e instanceof Error ? e.message : String(e);
            }
            const verified = readBack !== null && readBack.length === ids.length && readBack.every((id, i) => id === ids[i]);
            // What war.app holds is the list the award will use: kept to read the award from (#166).
            if (ctx.dataDir && readBack?.length) await writePickList(ctx.dataDir, gameId, me, readBack);
            return { sent: true, verified, game: gameId, picks, readBack, ...(readBackError ? { readBackError } : {}) };
          },
          render: (r) =>
            respond(undefined, ['compact'], () => ({
              ...r,
              ...(r.verified
                ? {}
                : {
                    warning:
                      r.readBack === null
                        ? 'war.app accepted the picks, but reading them back failed. Check warapp_get_my_picks before resubmitting.'
                        : 'war.app did not read back exactly these picks. Check warapp_get_my_picks before resubmitting.',
                  }),
            })),
          batchable: false,
        }),
      ),
  );
}
