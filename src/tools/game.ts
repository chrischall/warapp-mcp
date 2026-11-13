import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WarappClient } from '../client.js';
import { leavers, type Game, type GameSettings } from '../normalize.js';
import { recordFinalResult } from '../outlook-log.js';
import { currentTurn, gameIdArg, mapSummary, readAnnotations, respond, turnsCompleted, untrustedDescription, viewArg } from './common.js';
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
      // #130: the turn being played, as every turn tool reports it; the completed count apart.
      turn: currentTurn(game),
      turnsCompleted: turnsCompleted(game),
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
    // #178: how the game ends and what a leaver's seat becomes.
    endRules: game.endRules ?? null,
    map: game.map ? mapSummary(game.map) : null,
    boardAvailable: game.standing !== undefined,
  };
  // #178: humans who have not committed, with the time left to each boot (lastTurnTime UNVERIFIED).
  const l = leavers(game, Date.now());
  if (l.players.length)
    out.leavers = {
      players: l.players.map(({ playerId, ...rest }) => ({ id: playerId, name: game.players.find((p) => p.id === playerId)?.name ?? null, ...rest })),
      unverified: l.unverified,
    };
  if (game.history !== undefined) out.history = game.history;
  if (game.chat !== undefined) out.chat = game.chat;
  return out;
}

/**
 * `dir` is the data directory: a finished game this server planned gets its final result in the
 * outlook log (#178).
 */
export function registerGameTool(server: McpServer, client: WarappClient, dir?: () => string): void {
  server.registerTool(
    'warapp_get_game',
    {
      title: 'Get a war.app (Warzone) game',
      description: untrustedDescription(
        'Look up one war.app (Warzone) multiplayer game by id: its state (lobby, distributing, playing, finished), ' +
          'the turn being played (`turn`; `turnsCompleted` counts the finished ones), the players and who has committed orders (who the game is waiting on), and a digest of ' +
          'its settings — fog, kill rates, luck, rounding, base income, army cap, enabled cards — plus which map it ' +
          'is on and whether the board is available for warapp_analyze_board; the end-of-game, boot and AI settings ' +
          '(`endRules`) and the humans who have not committed with the time left to each boot (`leavers`, from ' +
          'lastTurnTime, whose meaning is unverified). Optional game history and chat. ' +
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
      if (dir) await recordFinalResult(dir(), game);
      return respond(view, VIEWS, (rung) => {
        if (rung === 'compact') return compact(game);
        if (rung === 'full') return { game: { ...game, map: game.map ? mapSummary(game.map) : undefined } };
        return { game };
      });
    },
  );
}
