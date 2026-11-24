import type { EnvSource } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { WarappClient } from '../client.js';
import { leavers, type Game, type GameSettings } from '../normalize.js';
import { recordFinalResult } from '../outlook-log.js';
import { historyReport } from '../trend.js';
import { currentTurn, gameIdArg, mapSummary, readAnnotations, respond, turnsCompleted, untrustedDescription, viewArg } from './common.js';
import type { CardStateRead } from './card-state-view.js';
import { lookupMeta } from './hints.js';
import { lossReport } from './how-lost.js';
import { endOfGame, finishedAccount, type EndOfGameResult } from './end-of-game.js';
import { foldFinished, type FinishedFold } from './profile-hook.js';

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
  // Only where a boot setting exists: without AutoBoot or DirectBoot nobody is close to a boot, and
  // the list would repeat `waitingOn`.
  const l = leavers(game, Date.now());
  const booted = l.players.filter((p) => p.autoBootInMinutes !== undefined || p.directBootInMinutes !== undefined);
  if (booted.length)
    out.leavers = {
      players: booted.map(({ playerId, ...rest }) => ({ id: playerId, name: game.players.find((p) => p.id === playerId)?.name ?? null, ...rest })),
      unverified: l.unverified,
    };
  // The raw history stays out of compact: it is every board and order of every turn (3.6 MB for a 29-turn game on a
  // 2,000-territory map; a longer one overflows a hosted reply). Compact reports `historyRead`; view "full" carries it.
  if (game.chat !== undefined) out.chat = game.chat;
  return out;
}

/**
 * `dir` is the data directory: a finished game this server planned gets its final result in the
 * outlook log (#178), and its opponent profile is folded into the cross-game stores (B2,
 * docs/PLAN-PROFILES.md; off with `WARAPP_PLAYER_PROFILE=off` in `env`): the per-game file kept while it
 * was played, else, once, its cached boards (#264's backfill), reported as `profileFold`. A finished game
 * the cached account did not win says how (`howLost`, #274, src/tools/how-lost.ts), as does (#283) a game
 * still playing once that account's seat is out. A finished game of mine gets its end-of-game pass once
 * (`endOfGame`, #312, src/tools/end-of-game.ts): the account is the board cache's, else `identity` (the
 * signed-in account).
 */
export function registerGameTool(
  server: McpServer,
  client: WarappClient,
  dir?: () => string,
  env?: EnvSource,
  identity?: () => Promise<number | undefined>,
  /** My card state from the live board (src/tools/card-state-view.ts); absent: not read. */
  cards?: (game: Game) => Promise<CardStateRead>,
): void {
  server.registerTool(
    'warapp_get_game',
    {
      title: 'Get a war.app (Warzone) game',
      description: untrustedDescription(
        'Look up one war.app (Warzone) multiplayer game by id: its state (lobby, distributing, playing, finished), ' +
          'the turn being played (`turn`; `turnsCompleted` counts the finished ones), the players and who has committed orders (who the game is waiting on), and a digest of ' +
          'its settings — fog, kill rates, luck, rounding, base income, army cap, enabled cards — plus which map it ' +
          'is on and whether the board is available for warapp_analyze_board; the end-of-game, boot and AI settings ' +
          '(`endRules`) and the humans who have not committed with the time left to each boot (`leavers`, when the game boots; from ' +
          'lastTurnTime, whose meaning is unverified). Optional game history and chat. ' +
          'A game I lost says how (`howLost`), once finished or, while the others play on, once my seat is out (eliminated, ' +
          'booted or surrendered): a surrender or boot by my state, with the last turn played here and the last logged outlook ' +
          '(its state, my income and armies against the strongest opponent\'s in view, with its tracked income, frontier read ' +
          'and calibrated income range when logged, and the strongest on income when another opponent); an elimination from the boards ' +
          'this server cached while it played — the turn (certain only when it is the newest completed turn), my commander\'s territory ' +
          'that fell with what it held, the attackers that needed and who bordered it (at a commander walk\'s destination, ' +
          'which may instead have fallen before the walk ran), or else my last territories (inferred, never seen). ' +
          'A finished game is folded once into the opponent profiles (`profileFold`; from the turns kept while it was played, ' +
          'else from the boards cached then — a backfill; no other request), as warapp_profile_opponents reads them. ' +
          'A finished game of mine also gets its end-of-game pass once (`endOfGame`: its history read once — one more ' +
          'request — and kept name-free for later games: the outcome, my picks, every player\'s income and bonuses by turn, ' +
          'what stood where my attacks failed, and every player\'s end-of-game screen (`endOfGame.stats`: armies produced, lost ' +
          'and killed, highest income, cards, and the All Graphs series — armies, territories, income, deployed and luck per ' +
          'turn; shown on every later read) — then folded into the opponent profiles, the map\'s record and the lessons ' +
          '(`endOfGame.processed`); a failed read is recorded and not retried, except by a call with ' +
          '`include_history`, which re-runs it from that read and adds the stats to a game processed before them ' +
          '(`backfilled`). To take a finished game off the app\'s My Games use warapp_close_finished_game. ' +
          'While the game is played or picked with a card in play, `cards` is my hand from the live board (one more ' +
          'request): `held` (each card type with `count`), `total`, `maxCardsHold`, and `pieces` (per card in play, the ' +
          'pieces toward the next one and `of` how many make one; read by shape, UNVERIFIED live; `null` when unread) — a ' +
          'failed read is `cardsUnread`, never an error. For the map\'s bonuses and chokepoints use warapp_get_map. Read-only.',
      ),
      _meta: lookupMeta(['warzone game', 'war.app game', 'whose turn is it', 'game status']),
      annotations: readAnnotations('Get a war.app game'),
      inputSchema: z.object({
        game_id: gameIdArg,
        include_history: z
          .boolean()
          .optional()
          .describe(
            'Also fetch past turns (GetHistory; war.app documents it for finished games). The result then says ' +
              'whether the history read (`historyRead`: boards, first and last turn, layout) or why not ' +
              '(`historyUnreadable`: reason and the reply\'s top-level key names); the raw turns themselves only in ' +
              'view "full" or "raw" (they can run to megabytes). Default false.',
          ),
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
      let fold: FinishedFold | undefined;
      let lost: Record<string, unknown> | undefined;
      let end: EndOfGameResult | undefined;
      if (dir) {
        await recordFinalResult(dir(), game);
        // #274: a game I lost says how, from the boards cached while it was played.
        lost = await lossReport(dir(), game);
        // The first read that shows the game finished folds its opponent profile, or backfills it from
        // the cached boards once (#264; best effort, no request).
        if (game.state === 'Finished') fold = await foldFinished(dir(), env ?? process.env, game);
        // #312: once per finished game of mine, its history read once and kept name-free; an explicit
        // `include_history` re-runs a failed pass from this read.
        if (game.state === 'Finished') {
          const me = await finishedAccount(dir(), env ?? process.env, game.id, identity);
          end = await endOfGame({ client, dataDir: dir(), env: env ?? process.env }, game.id, me, game, include_history ? { history: game, retry: true } : {});
        }
      }
      const cardRead = cards ? await cards(game) : {};
      const folded = {
        ...cardRead,
        ...(fold && fold.status !== 'off' ? { profileFold: fold } : {}),
        ...(lost ? { howLost: lost } : {}),
        ...(end && end.status !== 'off' ? { endOfGame: end } : {}),
      };
      // #302: with the history asked for, whether it read, and if not why (key names and counts only).
      const report = include_history ? historyReport(game) : undefined;
      const historyRead = report ? ('read' in report ? { historyRead: report.read } : { historyUnreadable: report.unreadable }) : {};
      return respond(view, VIEWS, (rung) => {
        if (rung === 'compact') return { ...compact(game), ...folded, ...historyRead };
        if (rung === 'full') return { game: { ...game, map: game.map ? mapSummary(game.map) : undefined }, ...folded, ...historyRead };
        return { game };
      });
    },
  );
}
