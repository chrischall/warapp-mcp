// Pick advisor tool (docs/PLAN-PICKS.md, K2): rank the pickable territories of a
// manual-distribution game from the map, the settings and the live board.
// Read-only — the owner submits the list with warapp_submit_picks.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { clientPickLimits, planPicks, type CoverageReport, type PickGroup, type PickSettings } from '../analysis/picks.js';
import { OWNER_PICKABLE } from '../live.js';
import type { Game, GameMap, GameSettings } from '../normalize.js';
import { gameIdArg, graphOf, readAnnotations, respond, untrustedDescription, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveTerritories, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE } from './live.js';
import { pickingNeutrals } from '../pick-list.js';
import { mapOf } from './map.js';
import { keepPickable } from './where.js';

const VIEWS = ['compact', 'full'] as const;
/** The only GameFeed state in which territories are picked. */
export const PICK_PHASE_STATE = 'DistributingTerritories';
/** TerritoryLimit assumed when the settings do not say (war.app's usual default). */
export const DEFAULT_TERRITORY_LIMIT = 3;

/** The pick scorer's view of the game settings. */
export function pickSettings(s: GameSettings | undefined): PickSettings {
  if (!s) return {};
  const keys = [
    'offensiveKillRate',
    'defensiveKillRate',
    'luckModifier',
    'roundingMode',
    'oneArmyStandsGuard',
    'minimumArmyBonus',
    'bonusArmyPer',
    'localDeployments',
    'initialPlayerArmiesPerTerritory',
    'initialNonDistributionArmies',
    'initialNeutralsInDistribution',
    'commanders',
    'noSplit',
  ] as const satisfies ReadonlyArray<keyof PickSettings>;
  const out: Record<string, unknown> = {};
  for (const k of keys) if (s[k] !== undefined) out[k] = s[k];
  return out as PickSettings;
}

/** Throw unless territories are being picked. */
export function requirePickPhase(game: Game): void {
  if (game.state === PICK_PHASE_STATE) return;
  throw new McpToolError(`Game ${game.id} is not in the picking stage (game state: ${game.state}).`, {
    hint:
      game.state === 'Playing'
        ? 'Picks are over: plan the turn with warapp_plan_turn.'
        : 'Picks are planned only while a manual-distribution game distributes territories.',
  });
}

const namer = (map: GameMap) => {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  return (id: number) => ({ id, name: names.get(id) ?? String(id) });
};

export function registerPickTools(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_plan_picks',
    {
      title: 'Plan my territory picks in a war.app game',
      description: untrustedDescription(
        'Rank the pickable territories of a war.app (Warzone) game in manual distribution, from the map, the ' +
          "game's settings (starting armies, neutral sizes, kill rates, base income) and the live board's " +
          'pickable territories: a list in priority order by name and id, split into a primary group ' +
          '(the territory limit: what you are granted if nobody takes them first; one compact cluster, a 1v1 included, ' +
          'with maxHops between its two farthest picks) and a disjoint fallback group ' +
          '(granted in order when another player picked first; in a two-player game with 2 to 4 picks each, every fallback pick ' +
          'answers the loss that grants it: its own opening, less half the opponent\'s from the picks then lost), each pick with its ' +
          'score and reasons (bonus, value, turns to complete, first-turn bonus, entry points and which are a double border, ' +
          'which other pickable territories can reach the bonus in time, contested), the bonuses each group completes with their ' +
          '`threats` (the pickable territories outside the group that can reach each by the turn after it completes), ' +
          '`twoOrderCaptures` (neutrals its opening takes with two attacks because one cannot be paid for), ' +
          'the award (how many sets the round-by-round award order can grant from the list, and the worst of them with the ' +
          'other players\' starts it implies), ' +
          'warnings (assumed settings) and the reasoning. The primary group carries its `coverage`: the share of reasonable bonuses ' +
          '(positive, with a pickable territory, no wasteland, value per army at least the median) a pick can stand next to within 2 moves, ' +
          'and the ones it cannot, by name. In a two-player game without spread it may also return an `alternative`: a coverage-first list ' +
          '(a pair, then the picks that most widen that reach) with its score, coverage and its own `submitPicks`, present only when it covers more. ' +
          'Prefer the compact primary by default; offer the alternative on a small board, when knowing where the opponent is and keeping a ' +
          'way into every region matter more than the fastest start — the user chooses per game. ' +
          'Its `submitPicks` is exactly what warapp_submit_picks ' +
          'takes — review it with the user first. Refuses outside the picking stage or when nothing is pickable. ' +
          `${BRIDGE_NOTE} Read-only on war.app; it never submits picks.`,
      ),
      _meta: lookupMeta(['plan my picks', 'which territories to pick', 'suggest picks', 'warzone picks']),
      annotations: readAnnotations('Plan war.app picks'),
      inputSchema: z.object({
        game_id: gameIdArg,
        view: viewArg(
          VIEWS,
          'compact (default) gives the ranked picks with reasons, the groups and submitPicks; "full" adds the settings the plan assumed.',
        ),
        spread: z
          .boolean()
          .optional()
          .describe(
            'In a 1v1, spread the primary across bonuses against a counter-pick instead of one compact cluster ' +
              '(default false); usually worse on large maps. Ignored with three or more players.',
          ),
      }),
    },
    async ({ game_id, view, spread }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      requirePickPhase(game);
      const map = mapOf(game);
      const territories = await loadLiveTerritories(ctx, game);
      const pickable = territories.filter((t) => !t.fogged && t.owner === OWNER_PICKABLE).map((t) => t.territoryId);
      if (!pickable.length) {
        throw new McpToolError(`The live board of game ${game.id} has no pickable territories.`, {
          hint: 'Check warapp_get_live_board: picks may already be closed, or this game distributes territories automatically.',
        });
      }
      const neutralArmies = new Map(pickingNeutrals(territories));
      // Kept for the turns to come: where a player could have started (warapp_locate_opponents), and
      // (#201) the neutrals' sizes, which the fog may hide later (wastelands).
      await keepPickable(ctx, game, pickable, [...neutralArmies]);
      const warnings: string[] = [];
      let territoryLimit = game.settings?.territoryLimit;
      if (territoryLimit === undefined || territoryLimit <= 0) {
        territoryLimit = DEFAULT_TERRITORY_LIMIT;
        warnings.push(`Territory limit missing from settings; assumed ${DEFAULT_TERRITORY_LIMIT}.`);
      }
      // The list is as long as war.app's client allows (players × territories per player, #129),
      // never shorter than the primary.
      const maxPicks = Math.max(
        territoryLimit,
        clientPickLimits({ territoryLimit, players: game.players.length, pickable: pickable.length })?.max ?? 0,
      );
      const active = game.players.filter((p) => (p.state ?? 'Playing') === 'Playing').length;
      const players = Math.max(2, active || game.players.length);
      const settings = pickSettings(game.settings);
      const plan = planPicks({
        graph: graphOf(map),
        pickable,
        settings,
        players,
        territoryLimit,
        maxPicks,
        neutralArmies,
        spread: spread === true,
      });
      const name = namer(map);
      const groupView = (g: PickGroup) => ({
        territories: g.territoryIds.map(name),
        score: g.score,
        maxHops: g.maxHops,
        bonuses: g.bonuses.map((b) => ({
          id: b.bonusId,
          name: b.name,
          value: b.value,
          turn: b.turn,
          threats: b.threats.map(name),
        })),
        twoOrderCaptures: g.twoOrderCaptures.map((c) => ({
          turn: c.turn,
          territory: name(c.territoryId),
          orders: c.orders.map((o) => ({ from: name(o.from), armies: o.armies })),
        })),
      });

      const coverageView = (c: CoverageReport) => ({
        share: c.share,
        covered: c.covered,
        reasonable: c.reasonable,
        uncovered: c.uncovered.map((b) => ({ id: b.bonusId, name: b.name })),
      });
      const alt = plan.alternative;

      return respond(view, VIEWS, (rung) => ({
        game: { id: game.id, name: game.name ?? null, state: game.state },
        players,
        territoryLimit,
        maxPicks,
        picks: plan.picks.map((p, i) => ({
          priority: i + 1,
          territory: name(p.territoryId),
          group: p.group,
          score: p.score,
          reasons: p.reasons,
        })),
        groups: {
          primary: { ...groupView(plan.groups.primary), coverage: coverageView(plan.coverage) },
          fallback: groupView(plan.groups.fallback),
        },
        award: plan.award
          ? {
              outcomes: plan.award.outcomes,
              worst: {
                territories: plan.award.worst.territoryIds.map(name),
                score: plan.award.worst.score,
                opponentStarts: plan.award.worst.opponentStarts.map(name),
              },
              reordered: plan.award.reordered,
            }
          : null,
        warnings: [...warnings, ...plan.warnings],
        rationale: plan.rationale,
        submitPicks: { game_id: game.id, territories: plan.picks.map((p) => p.territoryId) },
        ...(alt
          ? {
              alternative: {
                ...groupView(alt.group),
                coverage: coverageView(alt.coverage),
                fallback: alt.fallback.map(name),
                submitPicks: { game_id: game.id, territories: alt.submitPicks },
              },
            }
          : {}),
        ...(rung === 'full' ? { settings } : {}),
      }));
    },
  );
}
