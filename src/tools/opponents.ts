// Opponent tracking tool (docs/PLAN-STRATEGY.md S3): what my board history says about each
// opponent — observed deploys turn by turn, an income estimate, the armies that must be in
// the fog and the bonuses that could explain an income gap. Read-only on war.app; it caches
// the board it read, like warapp_plan_turn, so the history grows on either tool.
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { INFER_REACH, MAX_LISTED_COMBINATIONS, TRACKED_MIN_TURNS, trackGame, trackOpponents, type ObservedTurn } from '../analysis/index.js';
import { boardStateFromLive } from '../live.js';
import type { GameMap } from '../normalize.js';
import { CACHED_TURNS, writeBoardCache } from '../trend.js';
import { gameIdArg, graphOf, readAnnotations, respond, untrustedDescription, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveGame, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { mapOf } from './map.js';
import { boardHistory, currentTurn, plannerSettings, requireTurnPhase } from './turn.js';

const VIEWS = ['compact', 'full'] as const;

const namer = (map: GameMap) => {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  return (id: number) => ({ id, name: names.get(id) ?? String(id) });
};

export function registerOpponentsTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_track_opponents',
    {
      title: 'Track my opponents in a war.app game',
      description: untrustedDescription(
        'Track each opponent of an in-progress war.app (Warzone) game over your own board history (the boards ' +
          `warapp_plan_turn and this tool have read, the last ${CACHED_TURNS} turns, or the game history when war.app sends it): ` +
          'per opponent, by name, its observed deploy each turn (the net change of its armies on territories visible ' +
          'both turns plus what its captures cost; a stack that only came out of the fog is not income, and no turn ' +
          'exceeds what it could earn), its income estimate (each observed deploy is a lower bound under fog, so: the ' +
          'largest of its last three observed turns, or its visible army growth plus losses per turn (stacks out of the fog left out) when more, capped ' +
          'at what it could earn and at least its base income plus the bonuses it visibly holds; it never decays: an ' +
          'earlier figure is carried until a bonus it visibly held is visibly broken; orders you sent through warapp_submit_turn count as measurements; with the method used ' +
          'and the observed range; a turn whose armies could read two ways — a stack walking in from the fog or a deploy, ' +
          'a capture reinforced on its visible attacker or a stack out of the fog, my emptied territory taken — gives its ' +
          'low–high range), its unexplainedArmies (income earned since first seen minus its visible army change, losses ' +
          'and likely combat deaths: in the fog, spent there, or a misread) and inferred bonuses (the ' +
          'combinations of bonuses it could hold whose values best explain the gap between that income and what it ' +
          `visibly earns, only those within ${INFER_REACH} hops of its territories that it could have paid for, nearest first — ` +
          `as candidates, none listed when more than ${MAX_LISTED_COMBINATIONS} fit). Once an opponent has ${TRACKED_MIN_TURNS}+ ` +
          "observed turns, warapp_plan_turn uses this income in place of the single-turn observed figure. Every opponent " +
          'still playing is listed, even with no territory in view (visible, turnsUnseen); one with nothing in view gets ' +
          'earnedAtLeast (its starting armies plus the base income every turn so far: a lower bound on armies received, ' +
          'not held) and a warning when that beats your largest stack or your total visible armies. Notes say how ' +
          'confident each figure is (turns used, missing turns, caps, fog reveals). Only consecutive turns are ' +
          `compared. Refuses outside a turn phase. ${BRIDGE_NOTE} Read-only on war.app; it caches the board it read.`,
      ),
      _meta: lookupMeta(['track opponents', 'enemy income', 'what is my opponent earning', 'hidden bonuses']),
      annotations: readAnnotations('Track war.app opponents'),
      inputSchema: z.object({
        game_id: gameIdArg,
        player: playerArg,
        view: viewArg(
          VIEWS,
          'compact (default) gives each opponent\'s per-turn deploys (with a low–high range when ambiguous), income, unexplained armies, inferred bonuses and notes; "full" adds the territories each turn counted, captured (and which captures came out of the fog, were reinforced, or were mine emptied), grew next to the fog, and skipped as fog reveals, and its army change, losses and likely combat deaths.',
        ),
      }),
    },
    async ({ game_id, player, view }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      requireTurnPhase(game);
      const map = mapOf(game);
      const me = await resolveMe(ctx, game.players, player);
      const { territories } = await loadLiveGame(ctx, game);
      const graph = graphOf(map);
      const board = boardStateFromLive(territories, me, game.players);
      const settings = plannerSettings(game.settings);
      const turn = currentTurn(game);
      const history = await boardHistory(ctx, game, me, turn);
      const boards = turn !== null ? [...history.boards, { turn, board }] : [{ turn: 0, board }];
      const tracks = trackOpponents(graph, boards, me.id, settings, trackGame(game.players, game.settings, map));
      if (ctx.dataDir && turn !== null) await writeBoardCache(ctx.dataDir, game.id, me.id, turn, board);
      const name = namer(map);
      const players = new Map(game.players.map((p) => [p.id, p.name]));
      const bonusOf = (id: number) => {
        const b = map.bonuses.find((x) => x.id === id);
        return { id, name: b?.name ?? String(id), value: b?.value ?? 0 };
      };

      return respond(view, VIEWS, (rung) => {
        const turnView = (x: ObservedTurn) => ({
          turn: x.from,
          deploy: x.observed,
          ...(x.raw !== x.observed ? { uncapped: x.raw, cap: x.cap } : {}),
          visibleIncome: x.visibleIncome,
          // #119: what my own orders that turn measured (defenders my failed attacks killed, …).
          ...(x.measured ? { measured: x.measured } : {}),
          ...(x.broken.length ? { brokenBonuses: x.broken.map(bonusOf) } : {}),
          // #123: an ambiguous turn reads between these (fog moves vs deploys, my emptied stacks).
          ...(x.low !== x.high ? { range: { low: x.low, high: x.high } } : {}),
          ...(rung === 'full'
            ? {
                counted: x.counted.map(name),
                captured: x.captured.map(name),
                fromFog: x.fromFog.map(name),
                ...(x.reinforced.length ? { reinforced: x.reinforced.map(name) } : {}),
                ...(x.grewFromFog.length ? { grewFromFog: x.grewFromFog.map(name) } : {}),
                ...(x.emptied.length ? { emptied: x.emptied.map(name) } : {}),
                reveals: x.reveals.map(name),
                armyChange: x.net,
                losses: x.losses,
                earned: x.earned,
                ...(x.combat ? { combat: x.combat } : {}),
              }
            : {}),
        });
        return {
          game: { id: game.id, name: game.name ?? null, turn },
          player: { id: me.id, name: me.name },
          turns: boards.map((b) => b.turn).sort((a, b) => a - b),
          // #94: every opponent out of sight whose received armies beat my largest stack or my total.
          warnings: tracks.flatMap((t) => t.warnings),
          opponents: tracks.map((t) => ({
            player: { id: t.playerId, name: players.get(t.playerId) ?? String(t.playerId) },
            firstSeen: t.firstSeen,
            visible: t.visible,
            turnsUnseen: t.turnsUnseen,
            turnsUnseenAtLeast: t.turnsUnseenAtLeast,
            earnedAtLeast: t.earnedAtLeast,
            warnings: t.warnings,
            observed: t.turns.map(turnView),
            income: {
              estimate: t.income,
              visible: t.visibleIncome,
              base: t.base,
              visibleBonuses: t.bonusIncome,
              turns: t.incomeTurns,
              // #99: which term set the estimate, and the spread of what it was observed to deploy.
              method: t.incomeMethod,
              ...(t.incomeLowered ? { lowered: t.incomeLowered } : {}),
              observedRange: t.observedRange,
              usedByPlanner: t.income !== null && t.turns.length >= TRACKED_MIN_TURNS,
            },
            unexplainedArmies: t.unexplained,
            inferredBonuses: t.inferred
              ? {
                  gap: t.inferred.gap,
                  exact: t.inferred.exact,
                  candidates: t.inferred.candidates.map((c) => ({ bonuses: c.bonusIds.map(bonusOf), total: c.total, hops: c.hops })),
                  ...(t.inferred.more ? { more: t.inferred.more } : {}),
                  ...(t.inferred.implausible ? { implausible: t.inferred.implausible } : {}),
                }
              : null,
            notes: t.notes,
          })),
        };
      });
    },
  );
}
