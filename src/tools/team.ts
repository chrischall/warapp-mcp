// warapp_get_team (C1, docs/PLAN-TEAMS.md): my team in a team game — who is on it, human or AI, committed or
// not, each teammate's visible income and the orders or picks they have entered, the team's shared hand and
// unread team chat. Read-only.
//
// UNVERIFIED live: GameFeed's player `team` (V1; without it the team comes from GetMyGames' GameInfoPlayer,
// read from the bundle), the teammate orders in LatestGameInfo (V5), GetTerritoryPicks with a teammate's id
// (V6) and how a team's hand is keyed (#163, V8). Every read here is tolerant: what cannot be read is
// unknown (`null`), never an error — except a game that is not a team game, which is refused.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { visibleIncomeFor } from '../analysis/plan/shared.js';
import { cardRules, handReadable, readHand } from '../cards.js';
import { parseGameId } from '../client.js';
import { boardStateFromLive, inGameOf } from '../live.js';
import type { Player } from '../normalize.js';
import { withTeammateOrders, type TeammateOrders, type TeamOrders } from '../team-orders.js';
import { carriesTeam, teammatesOf } from '../teams.js';
import { handOwners } from './card-advice.js';
import { chatUnread, readChat, type ChatMe } from './chat.js';
import { gameIdArg, graphOf, namer, readAnnotations, respond, untrustedDescription, untrustedText } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveGame, loadPicks, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { mapOf } from './map.js';
import { resolveTeams } from './team-source.js';
import { currentTurn } from './turn.js';
import { accountUnknown } from './write-kit.js';

const NOTES = [
  "GameFeed's player team is UNVERIFIED (V1); when it sends none, the team comes from GetMyGames (from the client bundle).",
  "Teammate orders and picks come from the live board's TeammateOrders (client bundle, UNVERIFIED live, V5): `null` " +
    'means unknown — none entered, or war.app did not send them — never "nothing entered".',
  "While distributing, a teammate's picks not in the board are asked with GetTerritoryPicks and the teammate's id " +
    '(UNVERIFIED, V6); a refusal reads as unknown.',
  "The team's hand is every card under me and my teammates; how war.app keys a team's hand is UNVERIFIED (#163).",
];

const DISTRIBUTING = 'DistributingTerritories';
const BOARD_STATES = new Set(['Playing', DISTRIBUTING]);

/** A teammate's pick list while distributing (C1/C2): where it was read from, and the ids in priority order. */
export interface TeammatePicks {
  source: 'teammate-orders' | 'territory-picks';
  territories: number[];
}

/**
 * A teammate's pick list: the live board's TeammateOrders entry first (V5), else GetTerritoryPicks with the
 * teammate's in-game id (V6). `null` is unknown — an AI seat, or a read war.app refused. Never throws.
 */
export async function readTeammatePicks(
  ctx: LiveContext,
  gameId: number,
  mate: Player,
  entry: TeammateOrders | undefined,
): Promise<TeammatePicks | null> {
  if (entry?.picks) return { source: 'teammate-orders', territories: entry.picks };
  const inGame = inGameOf(mate);
  if (inGame === undefined) return null;
  try {
    return { source: 'territory-picks', territories: await loadPicks(ctx, gameId, inGame) };
  } catch {
    return null; // refused or unreadable (V6): unknown
  }
}

export function registerTeamTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_get_team',
    {
      title: 'Read my team in a war.app team game',
      description: untrustedDescription(
        'Your team in a war.app (Warzone) team game: your team id (and whether GameFeed or your game list gave it), ' +
          'each teammate (GameFeed id, name, human or ai, state, whether they have committed this turn, their visible ' +
          'income on the live board, the orders they have entered this turn — deploys, moves, card plays — or, while ' +
          'picking, their picks), the opponents by team, the team\'s shared hand ({ inPlay: false } in a game without cards), and unread team chat (a count, no text). ' +
          'A field that cannot be read is null: unknown, never "none". Teammate orders, picks and the team hand are read ' +
          `from the client's own structures and are UNVERIFIED live. Refuses outside a team game. ${BRIDGE_NOTE} Read-only.`,
      ),
      _meta: lookupMeta(['my team', 'teammates', 'team game', 'teammate orders', 'teammate picks', 'team hand']),
      annotations: readAnnotations('Read my war.app team'),
      inputSchema: z.object({ game_id: gameIdArg }),
    },
    async ({ game_id }) => {
      const gameId = parseGameId(game_id);
      const identity = await ctx.myIdentity().catch(() => undefined);
      if (!identity) throw accountUnknown(ctx, 'your team cannot be read');
      const read = await ctx.client.getGame(gameId, { settings: true, chat: true });
      const { game, source } = await resolveTeams(ctx, read);
      const me = game.players.find((p) => p.id === identity.token);
      if (!me) {
        throw new McpToolError(`The signed-in war.app account is not a player in game ${game.id}.`, {
          hint: 'Check the game id with warapp_my_games.',
        });
      }
      if (source === 'none' || !carriesTeam(me.team)) {
        throw new McpToolError(`Game ${game.id} is not a team game, or your team there is unknown.`, {
          hint:
            "GameFeed's team field is unverified and your game list did not name a team either. Outside a team game " +
            'every other player is an opponent: warapp_track_opponents reads them.',
        });
      }
      const team = me.team;
      const mates = teammatesOf(game.players, me);
      const map = mapOf(game);
      const name = namer(map);

      const warnings: string[] = [];
      let board: ReturnType<typeof boardStateFromLive> | undefined;
      let info: unknown;
      if (BOARD_STATES.has(game.state)) {
        try {
          const live = await loadLiveGame(ctx, game);
          info = live.info;
          board = withTeammateOrders(boardStateFromLive(live.territories, me, game.players), info, me, game.players);
        } catch (e) {
          warnings.push(`The live board could not be read (${(e as Error).message}): incomes, orders, picks and the hand are unknown.`);
        }
      }
      const rules = cardRules(game.settings);

      const ordersView = (o: TeamOrders) => ({
        deploys: o.deploys.map((d) => ({ territory: name(d.territoryId), armies: d.armies })),
        moves: o.moves.map((m) => ({
          from: name(m.from),
          to: name(m.to),
          armies: m.armies,
          mode: m.mode,
          ...(m.percent ? { percent: true } : {}),
          ...(m.attackTeammates ? { attackTeammates: true } : {}),
          ...(m.commander ? { commander: true } : {}),
        })),
        cards: o.cards.map((c) => ({ ...(c.cardId ? { card: c.cardId } : {}), type: c.name })),
        ...(o.discards.length ? { discards: o.discards.map((d) => (d.cardId ? { card: d.cardId } : {})) } : {}),
        ...(o.unread.length ? { unread: o.unread } : {}),
      });

      const teammates: Array<Record<string, unknown>> = [];
      for (const p of mates) {
        const inGame = inGameOf(p);
        const entry: TeammateOrders | undefined = board?.teammateOrders?.find((e) => e.playerId === p.id);
        let picks: { source: string; territories: Array<{ id: number; name: string }> } | null = null;
        if (game.state === DISTRIBUTING && board) {
          const read = await readTeammatePicks(ctx, game.id, p, entry);
          picks = read && { source: read.source, territories: read.territories.map(name) };
        }
        teammates.push({
          id: p.id,
          name: untrustedText(p.name),
          kind: p.isAI || p.humanTurnedIntoAI ? 'ai' : 'human',
          state: p.state ?? null,
          committed: p.hasCommittedOrders,
          visibleIncome: board && inGame !== undefined ? visibleIncomeFor(graphOf(map), board, p.id, game.settings) : null,
          orders: entry?.orders ? ordersView(entry.orders) : null,
          picks,
        });
      }

      const owners = handOwners(game, me);
      // No card in play is known from the settings, board or not; `null` is a hand that could not be read.
      const hand =
        game.settings && !rules.inPlay.length
          ? { inPlay: false as const }
          : info === undefined || !rules.inPlay.length
          ? null
          : {
              readable: handReadable(info, owners),
              cards: readHand(info, owners).map((c) => ({ id: c.id, name: c.name, ...(c.armies !== undefined ? { armies: c.armies } : {}) })),
              ...(rules.maxCardsHold !== undefined ? { limit: rules.maxCardsHold } : {}),
            };

      const chatMeOf: ChatMe = identity;
      let chat: { unreadTeam: number | null; source: string | null; note?: string } = { unreadTeam: null, source: null };
      try {
        const lines = await readChat(ctx, game, chatMeOf);
        if (lines) {
          const { unread } = await chatUnread(ctx, game.id, chatMeOf, lines.lines);
          chat =
            lines.source === 'web'
              ? { unreadTeam: unread.team, source: 'web' }
              : { unreadTeam: null, source: 'gamefeed', note: 'GameFeed names no channel: read team chat with warapp_get_chat.' };
        }
      } catch {
        // unknown
      }

      return respond(undefined, ['compact'], () => ({
        game: { id: game.id, state: game.state, turn: currentTurn(game) },
        team: { id: team, source },
        me: { id: me.id, name: untrustedText(me.name) },
        teammates,
        opponents: game.players
          .filter((p) => p.id !== me.id && p.team !== team)
          .map((p) => ({ id: p.id, name: untrustedText(p.name), team: carriesTeam(p.team) ? p.team : null })),
        hand,
        chat,
        notes: NOTES,
        ...(warnings.length ? { warnings } : {}),
      }));
    },
  );
}
