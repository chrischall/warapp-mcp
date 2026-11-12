import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WarappClient } from '../client.js';
import type { Game, GameSettings } from '../normalize.js';
import { gameIdArg, mapSummary, readAnnotations, respond, untrustedDescription, viewArg } from './common.js';
import { lookupMeta } from './hints.js';

const VIEWS = ['compact', 'full', 'raw'] as const;

function settingsDigest(s: GameSettings | undefined): Omit<GameSettings, 'raw'> | null {
  if (!s) return null;
  const { raw: _raw, ...digest } = s;
  return digest;
}

function compact(game: Game) {
  const out: Record<string, unknown> = {
    game: {
      id: game.id,
      name: game.name ?? null,
      state: game.state,
      turn: game.numberOfTurns !== undefined && game.numberOfTurns >= 0 ? game.numberOfTurns : null,
      created: game.created ?? null,
      lastTurnTime: game.lastTurnTime ?? null,
    },
    players: game.players.map((p) => {
      const row: Record<string, unknown> = { id: p.id, name: p.name, state: p.state ?? null, committed: p.hasCommittedOrders };
      if (p.isAI) row.ai = true;
      if (p.humanTurnedIntoAI) row.turnedIntoAI = true;
      return row;
    }),
    // Humans still to commit orders this turn (only meaningful while playing).
    waitingOn:
      game.state === 'Playing'
        ? game.players.filter((p) => p.state === 'Playing' && !p.isAI && !p.hasCommittedOrders).map((p) => p.name)
        : [],
    settings: settingsDigest(game.settings),
    map: game.map ? mapSummary(game.map) : null,
    boardAvailable: game.standing !== undefined,
  };
  if (game.history !== undefined) out.history = game.history;
  if (game.chat !== undefined) out.chat = game.chat;
  return out;
}

export function registerGameTool(server: McpServer, client: WarappClient): void {
  server.registerTool(
    'warapp_get_game',
    {
      title: 'Get a war.app (Warzone) game',
      description: untrustedDescription(
        'Look up one war.app (Warzone) multiplayer game by id: its state (lobby, distributing, playing, finished), ' +
          'current turn, the players and who has committed orders (who the game is waiting on), and a digest of ' +
          'its settings — fog, kill rates, luck, rounding, base income, army cap, enabled cards — plus which map it ' +
          'is on and whether the board is available for warapp_analyze_board. Optional game history and chat. ' +
          'For the map\'s bonuses and chokepoints use warapp_get_map. Read-only.',
      ),
      _meta: lookupMeta(['warzone game', 'war.app game', 'whose turn is it', 'game status']),
      annotations: readAnnotations('Get a war.app game'),
      inputSchema: z.object({
        game_id: gameIdArg,
        include_history: z
          .boolean()
          .optional()
          .describe('Also fetch past turns (GetHistory; war.app documents it for finished games). Default false.'),
        include_chat: z.boolean().optional().describe('Also fetch the game chat (GetChat). Default false.'),
        view: viewArg(
          VIEWS,
          'compact (default) keeps the game state and turn, players with committed flags, a settings digest and a map ' +
            'summary; "full" is every normalized field (all settings as sent, the board standing) with the map ' +
            'summarized; "raw" is the whole normalized game including the full map.',
        ),
      }),
    },
    async ({ game_id, include_history, include_chat, view }) => {
      const game = await client.getGame(game_id, {
        settings: true,
        ...(include_history ? { history: true } : {}),
        ...(include_chat ? { chat: true } : {}),
      });
      return respond(view, VIEWS, (rung) => {
        if (rung === 'compact') return compact(game);
        if (rung === 'full') return { game: { ...game, map: game.map ? mapSummary(game.map) : undefined } };
        return { game };
      });
    },
  );
}
