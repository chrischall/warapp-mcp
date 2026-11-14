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
import { incomeFor } from '../analysis/plan/shared.js';
import { cardRules, handReadable, readHand } from '../cards.js';
import { parseGameId } from '../client.js';
import { boardStateFromLive, playersByInGameId } from '../live.js';
import { myGamesTeams } from '../my-games.js';
import type { Game, Player } from '../normalize.js';
import { readTeammateOrders, type RawTeammateOrders, type TeamOrders } from '../team-orders.js';
import { carriesTeam, isTeamGame, teammatesOf } from '../teams.js';
import { handOwners } from './card-advice.js';
import { chatUnread, readChat, type ChatMe } from './chat.js';
import { gameIdArg, graphOf, namer, readAnnotations, respond, untrustedDescription, untrustedText } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveGame, loadPicks, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { mapOf } from './map.js';
import { fetchMyGames } from './my-games.js';
import { currentTurn } from './turn.js';
import { accountUnknown } from './write-kit.js';

/** Where the game's teams were read from. */
export type TeamSource = 'gamefeed' | 'my-games';

/**
 * The game with each player's team: GameFeed's when it sends any (V1, UNVERIFIED), else GetMyGames'
 * GameInfoPlayer team for the players it can match by in-game id. `source` is `null` when neither gives a
 * team. Never throws: a GetMyGames failure leaves the game as GameFeed sent it.
 */
export async function gameWithTeams(ctx: LiveContext, game: Game): Promise<{ game: Game; source: TeamSource | null }> {
  if (isTeamGame(game.players)) return { game, source: 'gamefeed' };
  let teams: Map<number, number>;
  try {
    teams = myGamesTeams((await fetchMyGames(ctx)).games, game.id);
  } catch {
    return { game, source: null };
  }
  if (!teams.size) return { game, source: null };
  const byInGame = playersByInGameId(game.players);
  const teamOf = new Map<number, number>();
  for (const [inGame, team] of teams) {
    const p = byInGame.get(inGame);
    if (p) teamOf.set(p.id, team);
  }
  const players = game.players.map((p) => (teamOf.has(p.id) ? { ...p, team: teamOf.get(p.id)! } : p));
  return isTeamGame(players) ? { game: { ...game, players }, source: 'my-games' } : { game, source: null };
}

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

/** A teammate's in-game id; `undefined` for a seat without a GameFeed player id (an AI). */
function inGameOf(p: Player): number | undefined {
  return [...playersByInGameId([p]).keys()][0];
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
          'picking, their picks), the opponents by team, the team\'s shared hand, and unread team chat (a count, no text). ' +
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
      if (!identity) throw accountUnknown(ctx.hosted, 'your team cannot be read');
      const read = await ctx.client.getGame(gameId, { settings: true, chat: true });
      const { game, source } = await gameWithTeams(ctx, read);
      const me = game.players.find((p) => p.id === identity.token);
      if (!me) {
        throw new McpToolError(`The signed-in war.app account is not a player in game ${game.id}.`, {
          hint: 'Check the game id with warapp_my_games.',
        });
      }
      if (!source || !carriesTeam(me.team)) {
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
          board = boardStateFromLive(live.territories, me, game.players);
        } catch (e) {
          warnings.push(`The live board could not be read (${(e as Error).message}): incomes, orders, picks and the hand are unknown.`);
        }
      }
      const entered = info === undefined ? undefined : readTeammateOrders(info);
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
        const entry: RawTeammateOrders | undefined = inGame === undefined ? undefined : entered?.get(inGame);
        let picks: { source: string; territories: Array<{ id: number; name: string }> } | null = null;
        if (game.state === DISTRIBUTING && board) {
          if (entry?.picks) picks = { source: 'teammate-orders', territories: entry.picks.map(name) };
          else if (inGame !== undefined) {
            try {
              picks = { source: 'territory-picks', territories: (await loadPicks(ctx, game.id, inGame)).map(name) };
            } catch {
              picks = null; // refused or unreadable (V6): unknown
            }
          }
        }
        teammates.push({
          id: p.id,
          name: untrustedText(p.name),
          kind: p.isAI || p.humanTurnedIntoAI ? 'ai' : 'human',
          state: p.state ?? null,
          committed: p.hasCommittedOrders,
          visibleIncome: board && inGame !== undefined ? incomeFor(graphOf(map), board, p.id, game.settings) : null,
          orders: entry?.orders ? ordersView(entry.orders) : null,
          picks,
        });
      }

      const owners = handOwners(game, me);
      const hand =
        info === undefined || !rules.inPlay.length
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
