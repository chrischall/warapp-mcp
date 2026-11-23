// The Diplomacy 2 mod's alliances (mod 191) for the turn and diplomacy tools, and the read-only
// warapp_get_mod_alliances. Where the data lives and what the mod does: src/mod-alliances.ts. UNVERIFIED live.
//
// A game that does not run the mod (its GameFeed settings' mod ids, src/normalize.ts) costs nothing: no
// request, no change to any plan. In a game that does, one GameRefresh (details, no chat) per read.
// Never throws: a failed or unreadable read is `unreadable`, never "no alliance".

import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Game, Player } from '../normalize.js';
import { inGameOf, playersByInGameId } from '../live.js';
import { Method, writeGameRefreshParams } from '../protocol/methods.js';
import { readMyOrderList } from '../my-orders.js';
import {
  allianceMismatches,
  allyAttacksIn,
  breakAlerts,
  breaksInOrders,
  diplomacy2From,
  modPairs,
  myAllies,
  readModData,
  runsDiplomacy2,
  type AllyAttack,
  type Diplomacy2State,
} from '../mod-alliances.js';
import { currentTurn, gameIdArg, readAnnotations, respond, untrustedDescription, untrustedText } from './common.js';
import { lookupMeta } from './hints.js';
import { readLatestBoard, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, resolveMe } from './live.js';

/** How every result that carries mod alliances says where they come from. */
export const MOD_ALLIANCES_NOTE =
  "Diplomacy 2 (mod 191) alliances, read from the game details (the web client's GameRefresh: the mod's public " +
  'data and your own), UNVERIFIED live: the format is the mod\'s published source and the client bundle, not yet ' +
  'checked against a game with an alliance in it. The game skips every attack between allies (owners at the start ' +
  'of the turn), both ways; a break is an order in the breaker\'s own turn that applies at its end, so an ally can ' +
  'attack from the next turn and no one else sees a break coming. Proposals you sent are in the other player\'s ' +
  'private data and are not shown; the mod keeps no turn for an alliance, only its order (`id`).';

/** What one read of the mod's alliances gave. */
export type ModAlliancesRead =
  | { status: 'no-mod' }
  | { status: 'unreadable'; reason: string }
  | {
      status: 'read';
      state: Diplomacy2State;
      /** My in-game id (undefined: my seat has none). */
      me: number | undefined;
      /** My allies, by GameFeed id (an ally whose id cannot be mapped is left out and counted). */
      allies: number[];
      /** Allies whose in-game id maps to no GameFeed player. */
      unmapped: number;
      /** GameFeed id of an in-game id (`null`: not known). */
      feedOf: (inGame: number) => number | null;
    };

/** One GameRefresh for the details; `undefined` when unreadable. Throws on a failed request. */
async function fetchDiplomacy2(ctx: Pick<LiveContext, 'rpc' | 'bundle'>, gameId: number): Promise<Diplomacy2State | undefined> {
  const env = await ctx.rpc.call('GameRefresh', Method.GameRefresh, (w) =>
    writeGameRefreshParams(w, { gameId, chat: false, nonChat: true, lobby: false }),
  );
  const data = readModData(await ctx.bundle(), env.body);
  return data ? diplomacy2From(data) : undefined;
}

/**
 * Diplomacy 2's alliances in `game` as `me` sees them. `no-mod` (no request) when the game's settings do not
 * list the mod; `unreadable` when the request failed or the reply was not understood. Never throws.
 */
export async function readModAlliances(
  ctx: Pick<LiveContext, 'rpc' | 'bundle'>,
  game: Pick<Game, 'id' | 'players' | 'settings'>,
  me: Pick<Player, 'id' | 'feedId'>,
): Promise<ModAlliancesRead> {
  if (!runsDiplomacy2(game.settings?.modIds)) return { status: 'no-mod' };
  let state: Diplomacy2State | undefined;
  try {
    state = await fetchDiplomacy2(ctx, game.id);
  } catch (e) {
    return { status: 'unreadable', reason: e instanceof Error ? e.message : String(e) };
  }
  if (!state) return { status: 'unreadable', reason: 'the game details carried no Diplomacy 2 data this server understands' };
  const byInGame = playersByInGameId(game.players);
  const feedOf = (inGame: number): number | null => byInGame.get(inGame)?.id ?? null;
  const mine = inGameOf(me);
  const ids = mine === undefined ? [] : myAllies(state, mine);
  const allies = ids.map(feedOf).filter((x): x is number => x !== null);
  return { status: 'read', state, me: mine, allies, unmapped: ids.length - allies.length, feedOf };
}

/** The warnings a turn tool adds for a mod-191 game (none for `no-mod`). */
export function modAllianceWarnings(read: ModAlliancesRead): string[] {
  if (read.status === 'no-mod') return [];
  if (read.status === 'unreadable')
    return [
      `This game runs the Diplomacy 2 mod, but its alliances could not be read (${read.reason}): no alliance is honoured ` +
        'here. An attack on an ally is skipped by the game and its armies sit idle — check the mod\'s menu in the web client.',
    ];
  const out: string[] = [];
  if (read.unmapped) out.push(`${read.unmapped} Diplomacy 2 ${read.unmapped === 1 ? 'ally' : 'allies'} could not be matched to a player in this game: not honoured.`);
  const breaks = breakAlerts(read.state);
  if (breaks.length)
    out.push(
      `Notice: the Diplomacy 2 mod reports ${breaks.length === 1 ? 'a broken alliance' : `${breaks.length} broken alliances`} with you ` +
        `(${breaks.map((b) => untrustedText(b.message)).join('; ')}). That player is an ordinary opponent now.`,
    );
  return out;
}

/** Each ally attack named for a person, by territory and player id. */
export const allyAttackLine = (a: AllyAttack, name: (t: number) => string): string =>
  `move ${a.index + 1} attacks ${name(a.to)} from ${name(a.from)}, held by player ${a.ally} (a Diplomacy 2 ally)`;

/** The attacks of `moves` on my allies at the start of this turn (owners by GameFeed id on `ownerAt`). */
export function attacksOnAllies(
  read: ModAlliancesRead,
  moves: readonly { from: number; to: number; mode?: string }[],
  ownerAt: (territory: number) => number | undefined,
): AllyAttack[] {
  return read.status === 'read' ? allyAttacksIn(moves, new Set(read.allies), ownerAt) : [];
}

/**
 * The mod's alliances beside the ledger's agreements (warapp_get_relations, warapp_advise_diplomacy): `undefined` in a
 * game without the mod. `live`: the ledger's agreements active or in notice. `who`: a GameFeed id for the result.
 */
export function modRelationsView<P>(read: ModAlliancesRead, live: readonly { id: string; with: number }[], who: (id: number) => P) {
  if (read.status === 'no-mod') return undefined;
  if (read.status === 'unreadable') return { source: 'mod' as const, read: false, reason: read.reason, alliances: null, note: MOD_ALLIANCES_NOTE };
  const mine = read.me;
  const alliances = read.state.alliances
    .filter((a) => mine !== undefined && (a.proposer === mine || a.accepter === mine))
    .sort((x, y) => x.id - y.id)
    .flatMap((a) => {
      const other = read.feedOf(a.proposer === mine ? a.accepter : a.proposer);
      return other === null ? [] : [{ source: 'mod' as const, player: who(other), proposedBy: a.proposer === mine ? ('me' as const) : ('them' as const), id: a.id }];
    });
  const mismatches = allianceMismatches(read.allies, live).map((m) => ({
    player: who(m.player),
    kind: m.kind,
    ...(m.agreement ? { agreement: m.agreement } : {}),
    line:
      m.kind === 'mod-only'
        ? 'allied in the Diplomacy 2 mod with no agreement recorded: the game enforces it, but its terms (notice, until) are not in the ledger'
        : 'an agreement is active or in notice but the mod shows no alliance: the game does not enforce it — the player may have broken the alliance, or it was never made in the mod',
  }));
  const notices = breakAlerts(read.state).map((a) => ({ id: a.id, message: untrustedText(a.message) }));
  return {
    source: 'mod' as const,
    read: true,
    alliances,
    ...(read.state.proposalsToMe.length
      ? {
          proposalsToMe: read.state.proposalsToMe.flatMap((p) => {
            const from = read.feedOf(p.from);
            return from === null ? [] : [{ player: who(from), id: p.id }];
          }),
        }
      : {}),
    mismatches,
    // An ally's break shows only once it applied: the mod's alert to me, kept until the web client shows it.
    ...(notices.length ? { notices } : {}),
    note: MOD_ALLIANCES_NOTE,
  };
}

/** warapp_get_mod_alliances. */
export function registerModAlliancesTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_get_mod_alliances',
    {
      title: 'Read Diplomacy 2 mod alliances in a war.app game',
      description: untrustedDescription(
        'The alliances of the "Diplomacy 2" mod (mod 191) in a war.app (Warzone) game that runs it: each pair with its ' +
          '`state` — `allied` (the game skips every attack between them this turn), `breaking` (your own break order is ' +
          'entered this turn: it still holds this turn, and either side can attack from `endsTurn`) or `pending` (a ' +
          'proposal to you, not yet answered) — who `proposer` was, and `id`, the mod\'s counter (the order they were ' +
          'made in: the mod keeps no turn). Also `allies` (yours) and `alerts` (the mod\'s notices to you, such as a ' +
          'player who broke an alliance with you). UNVERIFIED live. Proposals you sent and an ally\'s break before it ' +
          'applies are not visible. Proposing, accepting, declining and breaking are manual only (the mod\'s menu in the ' +
          `web client): no tool sends them. A game without the mod is refused. ${BRIDGE_NOTE} Read-only.`,
      ),
      _meta: lookupMeta(['mod alliances', 'diplomacy 2', 'who is allied', 'alliance mod', 'my allies']),
      annotations: readAnnotations('Read Diplomacy 2 alliances'),
      inputSchema: z.object({ game_id: gameIdArg }),
    },
    async ({ game_id }) => {
      const game = await ctx.client.getGame(game_id, { settings: true, map: false });
      if (!runsDiplomacy2(game.settings?.modIds)) {
        throw new McpToolError(`Game ${game.id} does not run the Diplomacy 2 mod (mod 191).`, {
          hint: 'warapp_get_relations shows the agreements recorded with warapp_record_agreement.',
        });
      }
      const me = await resolveMe(ctx, game.players, undefined);
      const read = await readModAlliances(ctx, game, me);
      if (read.status !== 'read') {
        return respond(undefined, ['compact'], () => ({
          game: { id: game.id, name: game.name === undefined ? null : untrustedText(game.name), state: game.state },
          alliances: null,
          warnings: modAllianceWarnings(read),
          readNote: MOD_ALLIANCES_NOTE,
        }));
      }
      const turn = currentTurn(game);
      // My own break orders this turn (only while a turn is played: the orders live on the live board).
      let breaksByMe: number[] = [];
      const warnings = modAllianceWarnings(read);
      if (game.state === 'Playing' && turn !== null && read.me !== undefined) {
        try {
          const { info } = await readLatestBoard(ctx, game.id);
          breaksByMe = breaksInOrders(readMyOrderList(info) ?? []);
        } catch (e) {
          warnings.push(`Your orders could not be read (${e instanceof Error ? e.message : String(e)}): a break you entered this turn would not show as breaking.`);
        }
      }
      const who = (inGame: number) => {
        const feed = read.feedOf(inGame);
        const p = feed === null ? undefined : game.players.find((x) => x.id === feed);
        return { id: feed, inGameId: inGame, name: p ? untrustedText(p.name) : null };
      };
      return respond(undefined, ['compact'], () => ({
        game: { id: game.id, name: game.name === undefined ? null : untrustedText(game.name), state: game.state, turn },
        player: { id: me.id, name: untrustedText(me.name) },
        alliances: modPairs(read.state, read.me, turn, breaksByMe).map((p) => ({
          players: p.players.map(who),
          state: p.state,
          proposer: who(p.proposer),
          id: p.id,
          ...(p.endsTurn !== undefined ? { endsTurn: p.endsTurn } : {}),
        })),
        allies: read.allies.map((id) => {
          const p = game.players.find((x) => x.id === id);
          return { id, name: p ? untrustedText(p.name) : null };
        }),
        alerts: read.state.alerts.map((a) => ({ id: a.id, message: untrustedText(a.message) })),
        ...(warnings.length ? { warnings } : {}),
        modDiplomacy: 'manual only: propose, accept, decline and break in the mod\'s menu in the web client.',
        readNote: MOD_ALLIANCES_NOTE,
      }));
    },
  );
}
