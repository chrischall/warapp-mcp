// Opponent profiling as a tool (docs/PLAN-PROFILES.md A3): what each opponent of a game in progress
// tends to do, counted from the boards this server saw and my own orders between them
// (src/analysis/opponent-profile.ts), kept per game by src/profile-store.ts. Read-only on war.app; it
// caches the board it read, like warapp_locate_opponents. Profiles INFORM ONLY (owner decision P1):
// the turn planner reads none of it.
//
import type { EnvSource } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  HABIT_DEFAULTS,
  HABIT_NAMES,
  POPULATION_MIN_OPPORTUNITIES,
  PROFILE_DECAY,
  PROFILE_MIN_CONFIDENCE,
  PROFILE_PRIOR_WEIGHT,
} from '../analysis/opponent-profile.js';
import type { TurnBoard } from '../analysis/opponents.js';
import { boardStateFromLive } from '../live.js';
import { PROFILE_ENV, profileState } from '../profile-store.js';
import { writeGameRecord } from '../replay.js';
import { writeBoardCache } from '../trend.js';
import { gameIdArg, readAnnotations, respond, untrustedDescription, untrustedText, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveGame, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { recordProfile } from './profile-hook.js';
import { counterOf, readOpponents } from './profile-reads.js';
import { resolveTeamsFor } from './team-source.js';
import { boardHistory, currentTurn, requireTurnPhase } from './turn.js';

const VIEWS = ['compact', 'full'] as const;

export function registerProfileOpponentsTool(server: McpServer, ctx: LiveContext, deps: { env?: EnvSource } = {}): void {
  const env = deps.env ?? process.env;
  server.registerTool(
    'warapp_profile_opponents',
    {
      title: 'Profile my opponents in a war.app game',
      description: untrustedDescription(
        'What each opponent of an in-progress war.app (Warzone) game tends to do, counted from what your boards showed: ' +
          'per opponent, by name, `seen` (turns observed and `gamesMet`, the earlier finished games of yours it was in — the only facts) and `habits`, each a count of how often it did ' +
          'something when it could: `reinforce` (an attack of yours on its territory met more armies than the board showed; ' +
          'measured only at 0% luck with straight rounding, from the orders warapp_submit_turn sent), `attack` (turns in ' +
          'contact it attacked you), `firstStrike` (it attacked within two turns of first contact), `stacking` (share of ' +
          'its visible growth on one territory), `retaliate` (it attacked you within two turns of your attack) and `retake` ' +
          '(it took back within two turns what you took). Each habit pools this game\'s counts with the player\'s counts from your ' +
          `earlier finished games (each earlier game fading by ${PROFILE_DECAY} per game met since) and shrinks them toward a prior by ${PROFILE_PRIOR_WEIGHT} opportunities: all players in this format, ` +
          `then all players, once that pool has ${POPULATION_MIN_OPPORTUNITIES} (an AI seat: the AI pool), else a neutral default. Each has its \`value\`, \`n\`, ` +
          `\`confidence\` (n ÷ (n + ${PROFILE_PRIOR_WEIGHT})) and \`basis\` (what weighed most: \`this-game\`, \`past-games\`, \`population\` or \`default\`); ` +
          `\`labels\` and \`counter\` lines appear only at confidence ${PROFILE_MIN_CONFIDENCE} or more. A finished game is folded into the cross-game record, ` +
          'name-free and keyed by a salted hash, on the first read that shows it finished (warapp_get_game, warapp_wait_for_turn). ' +
          'Treat a habit as a likelihood, never a certainty, and never quote a read to another player. The turns are kept ' +
          `per game by this tool, warapp_plan_turn, warapp_track_opponents, warapp_locate_opponents and warapp_get_relations (off with ${PROFILE_ENV}=off: ` +
          'then only the boards read now are counted and nothing is kept). Known teammates are never profiled. While a game of ' +
          'three or more seats has teams that could not be read, nothing is kept (`profile: not-kept`) and every other player is ' +
          'profiled from the boards read now with `mayBeTeammate: true`. Refuses outside a turn ' +
          `phase. ${BRIDGE_NOTE} Read-only on war.app; it caches the board it read. warapp_plan_turn reports a compact read of each opponent in contact as \`reads\` (and warapp_advise_diplomacy \`retaliate\` and \`attack\`, warapp_scout_player \`met\`) but does not use profiles in its plan.`,
      ),
      _meta: lookupMeta(['profile my opponent', 'what kind of player is my opponent', 'does my opponent reinforce', 'opponent habits', 'is my opponent aggressive']),
      annotations: readAnnotations('Profile war.app opponents'),
      inputSchema: z.object({
        game_id: gameIdArg,
        player: playerArg,
        detail: viewArg(VIEWS, 'compact (default) gives each opponent\'s habits, labels and counter-play; "full" adds the counts and what it did on each observed turn.'),
      }),
    },
    async ({ game_id, player, detail }) => {
      const feed = await ctx.client.getGame(game_id, { settings: true });
      requireTurnPhase(feed);
      const seat = await resolveMe(ctx, feed.players, player);
      const { game, me, known: teamsKnown } = await resolveTeamsFor(ctx, feed, seat);
      const { territories } = await loadLiveGame(ctx, game);
      const board = boardStateFromLive(territories, me, game.players);
      const turn = currentTurn(game);
      const history = await boardHistory(ctx, game, me, turn);
      const boards: TurnBoard[] = turn !== null ? [...history.boards, { turn, board }] : [];
      if (ctx.dataDir && turn !== null) {
        await writeBoardCache(ctx.dataDir, game.id, me.id, turn, board);
        await writeGameRecord(ctx.dataDir, game);
        await recordProfile(ctx.dataDir, env, game, me, boards, teamsKnown);
      }
      const { record, reads } = await readOpponents({ dataDir: ctx.dataDir, env, game, me, teamsKnown, boards });
      const players = new Map(game.players.map((p) => [p.id, p]));

      return respond(detail, VIEWS, (rung) => {
        const full = rung === 'full';
        return {
          game: { id: game.id, name: game.name === undefined ? null : untrustedText(game.name), turn },
          player: { id: me.id, name: untrustedText(me.name) },
          // Nothing is kept while the teams are unknown (any player may be my teammate): not-kept.
          profile: profileState(env, teamsKnown ? ctx.dataDir : undefined),
          // The cross-game record could not be parsed (never overwritten): estimates use this game alone.
          ...(record === 'unreadable' ? { pastGames: 'unreadable' as const } : {}),
          opponents: reads.map((r) => {
            const { id, turns, habits: h, estimates: est, labels } = r;
            const p = players.get(id);
            return {
              player: { id, name: untrustedText(p?.name ?? String(id)) },
              ai: r.ai,
              // The teams could not be read: any other player may be my teammate.
              ...(teamsKnown ? {} : { mayBeTeammate: true as const }),
              seen: { turnsObserved: h.turns, ...(r.gamesMet !== undefined ? { gamesMet: r.gamesMet } : {}) },
              habits: Object.fromEntries(HABIT_NAMES.map((n) => [n, est[n]])),
              ...(h.reinforceExtra.n ? { reinforceExtra: { mean: Math.round((h.reinforceExtra.sum / h.reinforceExtra.n) * 100) / 100, n: h.reinforceExtra.n } } : {}),
              labels,
              counter: counterOf(labels),
              ...(full
                ? {
                    counts: {
                      reinforce: h.reinforce,
                      attack: h.attack,
                      firstStrike: h.firstStrike,
                      stacking: { n: h.stacking.n, sum: Math.round(h.stacking.sum * 1000) / 1000 },
                      retaliate: h.retaliate,
                      retake: h.retake,
                    },
                    defaults: HABIT_DEFAULTS,
                    turns: turns.map((t) => ({ turn: t.turn, ...t.primitives })),
                  }
                : {}),
            };
          }),
        };
      });
    },
  );
}
