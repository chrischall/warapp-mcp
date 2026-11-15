// Pick advisor tool (docs/PLAN-PICKS.md, K2): rank the pickable territories of a
// manual-distribution game from the map, the settings and the live board.
// Read-only — the owner submits the list with warapp_submit_picks.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { clientPickLimits, planPicks, type CoverageReport, type PickGroup, type PickSettings } from '../analysis/picks.js';
import { DEFAULT_TERRITORY_LIMIT } from '../analysis/opponents.js';
import { OWNER_PICKABLE } from '../live.js';
import type { Game, GameSettings } from '../normalize.js';
import { bonusNamer, gameIdArg, graphOf, namer, readAnnotations, respond, untrustedDescription, untrustedText, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveGame, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, resolveMe } from './live.js';
import { isTeamGame, teammatesOf } from '../teams.js';
import { teammateOrdersOf } from '../team-orders.js';
import { readTeammatePicks, type TeammatePicks } from './team.js';
import { pickingNeutrals } from '../pick-list.js';
import { mapOf } from './map.js';
import { keepPickable } from './where.js';
import { resolveTeams } from './team-source.js';

const VIEWS = ['compact', 'full'] as const;
/** The only GameFeed state in which territories are picked. */
export const PICK_PHASE_STATE = 'DistributingTerritories';
/** TerritoryLimit assumed when the settings do not say (war.app's usual default; shared with the outlook). */
export { DEFAULT_TERRITORY_LIMIT };

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
function requirePickPhase(game: Game): void {
  if (game.state === PICK_PHASE_STATE) return;
  throw new McpToolError(`Game ${game.id} is not in the picking stage (game state: ${game.state}).`, {
    hint:
      game.state === 'Playing'
        ? 'Picks are over: plan the turn with warapp_plan_turn.'
        : 'Picks are planned only while a manual-distribution game distributes territories.',
  });
}

/**
 * My playing teammates in a team game (C2); none, with a warning, when my seat cannot be told — then
 * every other player is treated as an opponent (the worst case). Never throws.
 */
async function teamOf(ctx: LiveContext, game: Game, warnings: string[]): Promise<Game['players']> {
  try {
    const me = await resolveMe(ctx, game.players, undefined);
    return teammatesOf(game.players, me).filter((p) => (p.state ?? 'Playing') === 'Playing');
  } catch {
    warnings.push("Could not tell which seat is yours in this team game: every other player is treated as an opponent.");
    return [];
  }
}

/** What the coordination block says about where a teammate's list comes from (C2). */
const TEAM_LIST_NOTES = [
  "A teammate's list is read from the live board's TeammateOrders (client bundle, UNVERIFIED live, V5), else from " +
    "GetTerritoryPicks with the teammate's id (UNVERIFIED, V6); a list that cannot be read is unknown, and the plan is then " +
    'the one made without it.',
  "The award order of a team game is UNVERIFIED: the mirrored list is laid out for a reversing order, and `splits` names " +
    'the bonuses a repeating order would split between you. Agree a list in team chat before relying on it.',
];

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
          'In a team game only the players off your team are threats, `team` names your teammates, and the list is judged by both award ' +
          "orders that fit (`award.orders`; a team game's is unverified). When a teammate's pick list can be read (unverified), each " +
          "teammate carries `picks`, and `team.coordination` reports the overlap with your list, the bonuses their top picks into " +
          '(a bonus pays one holder, so yours there are not credited), and a `mirrored` alternative (the same top picks in both ' +
          'lists, with its own submitPicks) beside the split list that `submitPicks` gives — which leaves their top picks to them ' +
          'and is shortened only when disjoint from their list. ' +
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
      const feed = await ctx.client.getGame(game_id, { settings: true });
      requirePickPhase(feed);
      const { territories, info } = await loadLiveGame(ctx, feed);
      const pickable = territories.filter((t) => !t.fogged && t.owner === OWNER_PICKABLE).map((t) => t.territoryId);
      if (!pickable.length) {
        throw new McpToolError(`The live board of game ${feed.id} has no pickable territories.`, {
          hint: 'Check warapp_get_live_board: picks may already be closed, or this game distributes territories automatically.',
        });
      }
      const neutralArmies = new Map(pickingNeutrals(territories));
      // Kept for the turns to come: where a player could have started (warapp_locate_opponents), and
      // (#201) the neutrals' sizes, which the fog may hide later (wastelands).
      await keepPickable(ctx, feed, pickable, [...neutralArmies]);
      // The teams, after the refusals: GameFeed's, else the game list's (asked once per game, kept).
      const { game, source: teamSource } = await resolveTeams(ctx, feed);
      const map = mapOf(game);
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
      // A team game (C2): only the players off my team are opponents. My seat is looked up only here.
      const team = isTeamGame(game.players) ? await teamOf(ctx, game, warnings) : undefined;
      // My teammates' lists (C2, coordination): the teammate orders first, then GetTerritoryPicks.
      const mateLists: Array<TeammatePicks | null> = [];
      if (team?.length) {
        const entries = teammateOrdersOf(info, game.players);
        for (const mate of team)
          mateLists.push(await readTeammatePicks(ctx, game.id, mate, entries?.find((e) => e.playerId === mate.id)));
      }
      const lists = mateLists.map((l) => l?.territories ?? []);
      const plan = planPicks({
        graph: graphOf(map),
        pickable,
        settings,
        players,
        territoryLimit,
        maxPicks,
        neutralArmies,
        spread: spread === true,
        ...(team ? { team: { teammates: team.length, ...(lists.some((l) => l.length) ? { lists } : {}) } } : {}),
      });
      const name = namer(map);
      const bonusName = bonusNamer(map);
      const coord = plan.team;
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
        ...(team
          ? {
              team: {
                teammates: team.map((p, i) => {
                  const read = mateLists[i];
                  return {
                    id: p.id,
                    name: untrustedText(p.name),
                    picks: read ? { source: read.source, territories: read.territories.map(name) } : null,
                  };
                }),
                opponents: Math.max(0, players - 1 - team.length),
                source: teamSource,
                ...(coord
                  ? {
                      coordination: {
                        theirTop: coord.tops.map((t) => t.map(name)),
                        overlap: coord.overlap.map((o) => ({
                          territory: name(o.territoryId),
                          mine: o.mine,
                          theirs: o.theirs,
                          teammate: team[o.teammate]?.id ?? null,
                        })),
                        sharedBonuses: coord.sharedBonuses.map((b) => ({
                          bonus: bonusName(b.bonusId),
                          mine: b.mine.map(name),
                          theirs: b.theirs.map(name),
                        })),
                        ...(coord.shortened ? { shortened: coord.shortened } : {}),
                        mirrored: coord.mirrored
                          ? {
                              territories: coord.mirrored.top.map(name),
                              hands: coord.mirrored.hands.map((h) => h.map(name)),
                              splits: coord.mirrored.splits.map((x) => ({
                                order: x.order,
                                bonuses: x.bonuses.map((b) => ({ ...bonusName(b.bonusId), territories: b.picks.map(name) })),
                              })),
                              submitPicks: { game_id: game.id, territories: coord.mirrored.submitPicks },
                            }
                          : null,
                        notes: TEAM_LIST_NOTES,
                      },
                    }
                  : {}),
              },
            }
          : {}),
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
              ...(plan.award.orders ? { orders: plan.award.orders } : {}),
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
