// Turn tools: plan a turn from the live board (read-only). The plan's `orders`
// array is the exact input shape of the turn-submission tool.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { incomeFor, planTurn, type PlanGoal, type PlannerSettings } from '../analysis/index.js';
import { boardStateFromLive } from '../live.js';
import { type Game, type GameMap, type GameSettings } from '../normalize.js';
import { gameIdArg, graphOf, readAnnotations, respond, untrustedDescription, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveTerritories, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { mapOf } from './map.js';
import { resolveBonus } from './resolve.js';

const VIEWS = ['compact', 'full'] as const;
const GOALS = ['expand', 'complete-bonus', 'defend'] as const satisfies readonly PlanGoal[];
/** The only GameFeed state in which turns are played. */
export const TURN_PHASE_STATE = 'Playing';
const MAX_ORDERS = 500;
const MAX_FOCUS = 50;

const territoryRef = z.union([z.string(), z.number()]);
const armiesArg = z.coerce.number().int().min(1);

/** One order of a turn: territories by id or name. */
export const turnOrderArg = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('deploy'),
    territory: territoryRef.describe('Territory to deploy on: id or name.'),
    armies: armiesArg.describe('Armies to deploy there.'),
  }),
  z.object({
    kind: z.literal('move'),
    from: territoryRef.describe('Territory the armies leave: id or name.'),
    to: territoryRef.describe('Adjacent territory to attack or transfer into: id or name.'),
    armies: armiesArg.describe('Armies to send.'),
  }),
]);

/** A whole turn's orders, as warapp_plan_turn returns them and warapp_submit_turn takes them. */
export const turnOrdersArg = z.array(turnOrderArg).min(1).max(MAX_ORDERS);
export type TurnOrderInput = z.infer<typeof turnOrderArg>;

/** The planner's view of the game settings. */
export function plannerSettings(s: GameSettings | undefined): PlannerSettings {
  if (!s) return {};
  const out: PlannerSettings = {};
  if (s.offensiveKillRate !== undefined) out.offensiveKillRate = s.offensiveKillRate;
  if (s.defensiveKillRate !== undefined) out.defensiveKillRate = s.defensiveKillRate;
  if (s.luckModifier !== undefined) out.luckModifier = s.luckModifier;
  if (s.roundingMode !== undefined) out.roundingMode = s.roundingMode;
  if (s.oneArmyStandsGuard !== undefined) out.oneArmyStandsGuard = s.oneArmyStandsGuard;
  if (s.multiAttack !== undefined) out.multiAttack = s.multiAttack;
  // AllowTransferOnly is deliberately not mapped: it toggles the per-order
  // "transfer only" mode, while every planned move is sent as AttackTransfer
  // (mode 3), which transfers between my own territories in any game.
  return out;
}

/** The turn being played: GameFeed's completed turns + 1; `null` when the feed does not say. */
export const currentTurn = (game: Game): number | null =>
  game.numberOfTurns !== undefined && game.numberOfTurns >= 0 ? game.numberOfTurns + 1 : null;

/** Throw unless the game is in a turn phase. */
export function requireTurnPhase(game: Game): void {
  if (game.state === TURN_PHASE_STATE) return;
  throw new McpToolError(`Game ${game.id} is not in a turn phase (game state: ${game.state}).`, {
    hint:
      game.state === 'DistributingTerritories'
        ? 'Territories are still being picked: use warapp_get_live_board and warapp_submit_picks.'
        : 'Turns are planned only while the game is being played.',
  });
}

const namer = (map: GameMap) => {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  return (id: number) => ({ id, name: names.get(id) ?? String(id) });
};

export function registerTurnTools(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_plan_turn',
    {
      title: 'Plan my turn in a war.app game',
      description: untrustedDescription(
        'Plan one turn for you in an in-progress war.app (Warzone) game from the live board, the map and the ' +
          "game's settings: your income, deploys and attacks/transfers by territory name and id, the expected " +
          'captures, completed bonuses and next income, warnings (threats, fog, luck) and the reasoning. Its ' +
          '`orders` array is exactly what warapp_submit_turn takes — review it with the user first. Goal "expand" ' +
          '(default) takes neutrals; "complete-bonus" also attacks players to finish bonuses; "defend" first ' +
          `reinforces threatened borders. Refuses outside a turn phase. ${BRIDGE_NOTE} Read-only; it never submits orders.`,
      ),
      _meta: lookupMeta(['plan my turn', 'warzone turn plan', 'what should i deploy', 'suggest my orders']),
      annotations: readAnnotations('Plan a war.app turn'),
      inputSchema: z.object({
        game_id: gameIdArg,
        player: playerArg,
        goal: z
          .enum(GOALS)
          .optional()
          .describe('expand (default): take neutrals; complete-bonus: also attack players to finish bonuses; defend: hold threatened borders first.'),
        focus: z
          .array(z.union([z.string(), z.number()]))
          .max(MAX_FOCUS)
          .optional()
          .describe('Bonuses to work on first (ids or names), even when the planner would call them uneconomic.'),
        reserve: z.coerce
          .number()
          .int()
          .min(0)
          .optional()
          .describe('Armies of income held out of captures (they are still deployed, on the most exposed border).'),
        view: viewArg(
          VIEWS,
          'compact (default) gives the plan and orders; "full" adds each move\'s reason and the settings the plan assumed.',
        ),
      }),
    },
    async ({ game_id, player, goal, focus, reserve, view }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      requireTurnPhase(game);
      const map = mapOf(game);
      const focusBonusIds = (focus ?? []).map((b) => resolveBonus(map, b).id);
      const me = await resolveMe(ctx, game.players, player);
      const territories = await loadLiveTerritories(ctx, game);
      const graph = graphOf(map);
      const board = boardStateFromLive(territories, me, game.players);
      const settings = plannerSettings(game.settings);
      const income = incomeFor(graph, board, me.id, game.settings);
      const chosen: PlanGoal = goal ?? 'expand';
      const plan = planTurn({
        graph,
        board,
        me: me.id,
        income,
        settings,
        options: { goal: chosen, focusBonusIds, ...(reserve !== undefined ? { reserve } : {}) },
      });
      const name = namer(map);
      const warnings = me.hasCommittedOrders
        ? [
            'You have already committed orders this turn; warapp_submit_turn will refuse — modify orders in the game instead.',
            ...plan.warnings,
          ]
        : plan.warnings;
      const orders = [
        ...plan.deploys.map((d) => ({ kind: 'deploy' as const, territory: d.territoryId, armies: d.armies })),
        ...plan.moves.map((m) => ({ kind: 'move' as const, from: m.from, to: m.to, armies: m.armies })),
      ];

      return respond(view, VIEWS, (rung) => ({
        game: { id: game.id, name: game.name ?? null, turn: currentTurn(game) },
        player: { id: me.id, name: me.name },
        goal: chosen,
        income,
        deploys: plan.deploys.map((d) => ({ territory: name(d.territoryId), armies: d.armies })),
        moves: plan.moves.map((m) => ({
          from: name(m.from),
          to: name(m.to),
          armies: m.armies,
          kind: m.kind,
          ...(rung === 'full' ? { reason: m.reason } : {}),
        })),
        expected: {
          captures: plan.expected.captures.map(name),
          bonusesCompleted: plan.expected.bonusesCompleted.map((id) => {
            const b = map.bonuses.find((x) => x.id === id)!;
            return { id, name: b.name, value: b.value };
          }),
          nextIncome: plan.expected.nextIncome,
        },
        warnings,
        rationale: plan.rationale,
        orders,
        ...(rung === 'full' ? { settings: { ...settings, allowTransferOnly: settings.allowTransferOnly ?? true } } : {}),
      }));
    },
  );
}
