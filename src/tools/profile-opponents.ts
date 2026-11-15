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
  COUNTER_PLAY,
  estimateHabits,
  HABIT_DEFAULTS,
  HABIT_NAMES,
  habitsOf,
  labelsOf,
  PROFILE_MIN_CONFIDENCE,
  PROFILE_PRIOR_WEIGHT,
  type ObservedPrimitives,
} from '../analysis/opponent-profile.js';
import type { TurnBoard } from '../analysis/opponents.js';
import { boardStateFromLive } from '../live.js';
import { observeBoards, PROFILE_ENV, profileEnabled, readProfileTurns } from '../profile-store.js';
import { writeGameRecord } from '../replay.js';
import { writeBoardCache } from '../trend.js';
import { gameIdArg, graphOf, readAnnotations, respond, untrustedDescription, untrustedText, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveGame, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { mapOf } from './map.js';
import { observeSettings, profiledOpponents, recordProfile } from './profile-hook.js';
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
          'per opponent, by name, `seen` (turns observed — the only fact) and `habits`, each a count of how often it did ' +
          'something when it could: `reinforce` (an attack of yours on its territory met more armies than the board showed; ' +
          'measured only at 0% luck with straight rounding, from the orders warapp_submit_turn sent), `attack` (turns in ' +
          'contact it attacked you), `firstStrike` (it attacked within two turns of first contact), `stacking` (share of ' +
          'its visible growth on one territory), `retaliate` (it attacked you within two turns of your attack) and `retake` ' +
          '(it took back within two turns what you took). Each habit has a `value` shrunk toward a neutral default by ' +
          `${PROFILE_PRIOR_WEIGHT} opportunities, its \`n\`, \`confidence\` (n ÷ (n + ${PROFILE_PRIOR_WEIGHT})) and \`basis\` ` +
          `(\`this-game\` once its counts outweigh the default, else \`default\`); \`labels\` and \`counter\` lines appear only at confidence ${PROFILE_MIN_CONFIDENCE} or more. ` +
          'Treat a habit as a likelihood, never a certainty, and never quote a read to another player. The turns are kept ' +
          `per game by this tool, warapp_plan_turn, warapp_track_opponents, warapp_locate_opponents and warapp_get_relations (off with ${PROFILE_ENV}=off: ` +
          'then only the boards read now are counted and nothing is kept). Teammates are never profiled. Refuses outside a turn ' +
          `phase. ${BRIDGE_NOTE} Read-only on war.app; it caches the board it read. warapp_plan_turn does not use profiles.`,
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
      const { game, me } = await resolveTeamsFor(ctx, feed, seat);
      const { territories } = await loadLiveGame(ctx, game);
      const board = boardStateFromLive(territories, me, game.players);
      const turn = currentTurn(game);
      const history = await boardHistory(ctx, game, me, turn);
      const boards: TurnBoard[] = turn !== null ? [...history.boards, { turn, board }] : [];
      const on = profileEnabled(env);
      if (ctx.dataDir && turn !== null) {
        await writeBoardCache(ctx.dataDir, game.id, me.id, turn, board);
        await writeGameRecord(ctx.dataDir, game);
        await recordProfile(ctx.dataDir, env, game, me, boards);
      }
      const opponents = profiledOpponents(game, me);
      // The stored turns when kept (every turn ever observed), else only those the boards read now show.
      const stored = on && ctx.dataDir ? await readProfileTurns(ctx.dataDir, game.id, me.id, env) : new Map<number, ObservedPrimitives[]>();
      const fresh = observeBoards({ gameId: game.id, me: me.id, graph: graphOf(mapOf(game)), settings: observeSettings(game), opponents, boards });
      const turnsOf = (o: number): ObservedPrimitives[] => {
        const byTurn = new Map<number, ObservedPrimitives>();
        for (const t of stored.get(o) ?? []) byTurn.set(t.turn, t);
        for (const [t, m] of fresh) {
          const p = m.get(o);
          if (p) byTurn.set(t, { turn: t, primitives: p });
        }
        return [...byTurn.values()].sort((a, b) => a.turn - b.turn);
      };
      const players = new Map(game.players.map((p) => [p.id, p]));

      return respond(detail, VIEWS, (rung) => {
        const full = rung === 'full';
        return {
          game: { id: game.id, name: game.name === undefined ? null : untrustedText(game.name), turn },
          player: { id: me.id, name: untrustedText(me.name) },
          profile: on ? 'kept' : 'off',
          opponents: opponents.map((id) => {
            const p = players.get(id);
            const turns = turnsOf(id);
            const h = habitsOf(turns);
            const est = estimateHabits(h);
            const labels = labelsOf(est);
            return {
              player: { id, name: untrustedText(p?.name ?? String(id)) },
              ai: Boolean(p?.isAI || p?.humanTurnedIntoAI),
              seen: { turnsObserved: h.turns },
              habits: Object.fromEntries(HABIT_NAMES.map((n) => [n, est[n]])),
              ...(h.reinforceExtra.n ? { reinforceExtra: { mean: Math.round((h.reinforceExtra.sum / h.reinforceExtra.n) * 100) / 100, n: h.reinforceExtra.n } } : {}),
              labels,
              counter: labels.flatMap((l) => (COUNTER_PLAY[l] ? [COUNTER_PLAY[l]] : [])),
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
