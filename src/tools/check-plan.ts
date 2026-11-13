// The plan stress test as a tool: a list of orders (the shape warapp_plan_turn returns and
// warapp_submit_turn takes) is carried out on the live board against the single replies each
// opponent could make with its estimated deploy, and the replies that cost something are
// reported, worst first (src/analysis/stress.ts, on the turn resolver src/analysis/turn-sim.ts).
// Read-only on war.app, and it writes nothing: not the board cache either.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { incomeFor, planEnemyEstimates, symmetricStart, trackGame, trackOpponents } from '../analysis/index.js';
import { stressPlan, type StressExposure, type StressReply } from '../analysis/stress.js';
import type { SimEvent } from '../analysis/turn-sim.js';
import { cardTypeByName, cardTypeName, normalizeGuid, readHand } from '../cards.js';
import { boardStateFromLive, inGameId } from '../live.js';
import type { GameMap } from '../normalize.js';
import { carriesTeam } from '../teams.js';
import { assumedWarning, awardView, loadAward } from './award.js';
import { gameIdArg, graphOf, readAnnotations, respond, untrustedDescription, untrustedText, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveGame, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { mapOf } from './map.js';
import { resolveTerritory } from './resolve.js';
import { boardHistory, currentTurn, plannerSettings, requirePlayingSeat, requireTurnPhase, turnOrdersArg } from './turn.js';

const VIEWS = ['compact', 'full'] as const;
const MAX_ENEMY_DEPLOY = 10_000;
/** Replies listed beside the worst one on the compact view; the full view lists the stress test's own maximum. */
const COMPACT_OTHERS = 2;
/** The most territories or bonuses any one list names; the rest are a count. */
const LIST_MAX = 10;
const ORDER_PRIORITY = cardTypeByName('Order Priority');

/** What the stress test does not try, said with every answer so "safe" is never read as more. */
export const CHECK_PLAN_NOT_COVERED = [
  'stacks hidden by fog, armies included (see blindBorders), and opponents with nothing in view (see unseenOpponents)',
  'an opponent that deploys more than the estimate (raise enemy_deploy to test it)',
  'a deploy split over several stacks, or two opponents acting together',
  'a chain of attacks through several territories under Multi-Attack',
  'cards, apart from your own Order Priority',
] as const;

const namer = (map: GameMap) => {
  const names = new Map(map.territories.map((t) => [t.id, t.name]));
  return (id: number) => ({ id, name: names.get(id) ?? String(id) });
};

export function registerCheckPlanTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_check_plan',
    {
      title: 'Stress-test a planned turn in a war.app game',
      description: untrustedDescription(
        'Stress-test a list of orders for your turn in an in-progress war.app (Warzone) game before you submit it: ' +
          'the orders (the `orders` array warapp_plan_turn returns, or your own edit of it) are carried out on the ' +
          'live board, turn rules included (deploys first, then attacks and transfers interleaved in the zigzag move ' +
          'order; each order an attack or a transfer by who holds its target when it runs; kill rates, the guard ' +
          'army, each army moving once, commanders), against the replies each opponent could make with ONE deploy: ' +
          'its whole estimated deploy on one stack and an attack on a territory you hold or are about to take, its ' +
          'whole deploy on a territory you attack, or every stack attacking at once. Each reply is tried with you ' +
          'moving first and with the opponent moving first unless `first_mover` says which. Returns `safe` (true, ' +
          'false, or null when no reply could be tried), a one-line `summary`, the `worst` reply and ' +
          '`otherReplies` that cost you something (territories `lost`, captures that fail or are `retaken`, ' +
          'bonuses and income lost, your commander), everything `atRisk` to some single reply (only one of them ' +
          'happens: one deploy, one place), what your orders do unanswered (`plan`: captures, attacks that fail, ' +
          'orders that send fewer armies than ordered or none), `blindBorders`: your territories next to the ' +
          'fog, where nothing could be tested, and `exposedNextTurn`: territories no enemy stack touches today ' +
          'that one could take next turn by first taking the territory in between (yours or neutral), each with ' +
          'the armies it would need to hold, if you add nothing next turn. Decide on the fields (`safe`, ' +
          '`worst`, `exposedNextTurn`), not on the wording of `summary`, which may change. Exact with no luck and ' +
          'straight rounding; otherwise battles are resolved at their expectation and `exact` is false. It does not ' +
          `try: ${CHECK_PLAN_NOT_COVERED.join('; ')}. When this server kept your pick list, \`award\` says what the ` +
          "award of picks showed (as in warapp_plan_turn): the opponent's proven starts stand on the board the " +
          'orders are tried on even while fogged, and `award.firstMover` is who moves first this turn under a ' +
          'cyclic move order — pass it as `first_mover` to judge by it; both orders are still tried by default. ' +
          `Refuses outside a turn phase. ${BRIDGE_NOTE} Read-only on ` +
          'war.app; it never submits orders.',
      ),
      _meta: lookupMeta(['check my plan', 'stress test my orders', 'what can my opponent do to this turn', 'is this plan safe']),
      annotations: readAnnotations('Stress-test a war.app turn'),
      inputSchema: z.object({
        game_id: gameIdArg,
        player: playerArg,
        orders: turnOrdersArg.describe(
          'The orders to test, in the order you would submit them: deploys and moves by territory id or name (the ' +
            '`orders` array warapp_plan_turn returns). An Order Priority card play makes your first order run before ' +
            "everyone's; other card plays and discards are ignored.",
        ),
        enemy_deploy: z.coerce
          .number()
          .int()
          .min(0)
          .max(MAX_ENEMY_DEPLOY)
          .optional()
          .describe(
            'Armies every opponent is assumed to deploy this turn. Default, per opponent: the estimate ' +
              'warapp_plan_turn uses (base income plus the bonuses it visibly holds, or its observed or tracked ' +
              'income when larger; in a 1v1 that started even, an opponent bordering the fog at least your own income). ' +
              'Income in the fog is unseen, so raise it to test a stronger opponent.',
          ),
        first_mover: z
          .enum(['me', 'opponent'])
          .optional()
          .describe(
            'Who moves first this turn, when you know (under cyclic move order it alternates every turn). Omit to ' +
              'try both.',
          ),
        view: viewArg(
          VIEWS,
          `compact (default) gives the verdict, the worst reply and up to ${COMPACT_OTHERS} more; "full" adds every ` +
            'reply listed, each order\'s result unanswered and the rules assumed.',
        ),
      }),
    },
    async ({ game_id, player, orders, enemy_deploy, first_mover, view }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      requireTurnPhase(game);
      const map = mapOf(game);
      const me = await resolveMe(ctx, game.players, player);
      requirePlayingSeat(game, me);
      const turn = currentTurn(game);
      const [{ territories, info }, history] = await Promise.all([loadLiveGame(ctx, game), boardHistory(ctx, game, me, turn)]);
      const graph = graphOf(map);
      // As warapp_plan_turn does (#166): the opponent's starts the award of picks proves stand on
      // the board the orders are tried on; the history and tracks stay what war.app showed.
      const seen = boardStateFromLive(territories, me, game.players);
      const award = await loadAward(ctx.dataDir, game, me, seen, turn);
      const board = award?.board ?? seen;
      const settings = plannerSettings(game.settings);

      const deploys: { territoryId: number; armies: number }[] = [];
      const moves: { from: number; to: number; armies: number }[] = [];
      const hand = readHand(info, inGameId(me));
      let orderPriority = false;
      const ignored: string[] = [];
      const mine = new Set(board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me.id ? [t.territoryId] : [])));
      for (const o of orders) {
        if (o.kind === 'deploy') {
          const t = resolveTerritory(map, o.territory);
          if (!mine.has(t.id)) {
            throw new McpToolError(`${untrustedText(t.name)} (${t.id}) is not yours on the live board, so nothing can be deployed there.`, {
              hint: 'Deploy only on territories you hold; warapp_get_live_board lists them.',
            });
          }
          deploys.push({ territoryId: t.id, armies: o.armies });
        } else if (o.kind === 'move') {
          moves.push({ from: resolveTerritory(map, o.from).id, to: resolveTerritory(map, o.to).id, armies: o.armies });
        } else if (o.kind === 'card') {
          // By GUID it is looked up in my hand; by type name the name is enough (this is a what-if).
          const guid = normalizeGuid(o.card.trim());
          const type = guid !== undefined ? hand.find((c) => c.id === guid)?.type : cardTypeByName(o.card);
          if (type !== undefined && type === ORDER_PRIORITY) orderPriority = true;
          else if (type === undefined || cardTypeName(type) !== 'Reinforcement') ignored.push('a card play other than Order Priority or Reinforcement');
        }
      }

      // The same per-opponent estimates warapp_plan_turn works from.
      const tracks =
        turn !== null
          ? trackOpponents(graph, [...history.boards, { turn, board: seen }], me.id, settings, trackGame(game.players, game.settings, map))
          : undefined;
      const income = incomeFor(graph, board, me.id, game.settings);
      const { estimates } = planEnemyEstimates({
        graph,
        board,
        me: me.id,
        income,
        settings,
        ...(history.previous ? { previousBoard: history.previous.board } : {}),
        ...(tracks ? { tracks } : {}),
        // The fog prior in a 1v1 that started even (#119) and the turn (#128), as warapp_plan_turn has them.
        game: {
          players: game.players.map((p) => ({
            id: p.id,
            ...(p.team !== undefined ? { team: p.team } : {}),
            ...(p.state !== undefined ? { state: p.state } : {}),
          })),
          turn,
          symmetricStart: symmetricStart(game.settings, map),
        },
        turn,
      });
      const myTeam = carriesTeam(me.team) ? me.team : undefined;
      const teamOf = new Map(game.players.map((p) => [p.id, p.team]));
      const friend = (id: number) => id === me.id || (myTeam !== undefined && teamOf.get(id) === myTeam);
      // Whoever holds a stack on the board can use it, whatever GameFeed says of the player (a booted
      // seat may be an AI): every owner in view, then every other player still in the game.
      const onBoard = new Set(board.territories.flatMap((t) => (t.owner.kind === 'player' ? [t.owner.playerId] : [])));
      const stillIn = game.players.filter((p) => (p.state ?? 'Playing') === 'Playing').map((p) => p.id);
      const base = settings.baseIncome ?? 0;
      const opponents = [...new Set([...onBoard, ...stillIn])]
        .filter((id) => !friend(id))
        .sort((a, b) => a - b)
        .map((id) => ({ id, deploy: enemy_deploy ?? estimates.find((e) => e.playerId === id)?.estimate ?? base }));
      const teams = new Map<number, number>();
      for (const p of game.players) if (carriesTeam(p.team)) teams.set(p.id, p.team);

      const report = stressPlan({
        graph,
        board,
        me: me.id,
        deploys,
        moves,
        opponents,
        settings,
        ...(teams.size ? { teams } : {}),
        ...(first_mover !== undefined ? { firstMover: first_mover } : {}),
        orderPriority,
      });

      const name = namer(map);
      const playerName = new Map(game.players.map((p) => [p.id, p.name]));
      const inView = new Set(board.territories.flatMap((t) => (t.owner.kind === 'player' && t.armies !== null ? [t.owner.playerId] : [])));
      const bonusOf = (id: number) => {
        const b = map.bonuses.find((x) => x.id === id);
        return { id, name: b?.name ?? String(id), value: b?.value ?? 0 };
      };
      const needs = (r: StressReply): 'you' | 'opponent' | 'either' =>
        r.firstMover === undefined ? 'either' : r.firstMover === 'me' ? 'you' : 'opponent';
      const signed = (n: number) => `${n >= 0 ? '+' : ''}${n}`;
      /** Ids in a sentence, the first few and then a count. */
      const some = (ids: readonly number[]) => `${ids.slice(0, LIST_MAX).join(', ')}${ids.length > LIST_MAX ? ` and ${ids.length - LIST_MAX} more` : ''}`;
      const capped = (ids: readonly number[]) => ids.slice(0, LIST_MAX).map(name);
      /** One reply in a sentence, by id (the names are in the fields beside it). */
      const sentence = (r: StressReply): string => {
        const act =
          r.kind === 'reinforce'
            ? `deploys ${r.deploy} on territory ${r.deployTo} and holds`
            : r.kind === 'attack'
              ? `deploys ${r.deploy} on territory ${r.deployTo} and attacks territory ${r.to} with ${r.armies}`
              : `attacks with every stack at once (${r.attacks!.length} attacks), its ${r.deploy} on territory ${r.deployTo}`;
        const when = needs(r) === 'you' ? ', and you move first' : needs(r) === 'opponent' ? ', and it moves first' : '';
        // With my commander gone everything is: the rest is not listed.
        const cost = r.commanderLost
          ? ['you lose your commander and the game']
          : [
              ...(r.lost.length ? [`you lose territor${r.lost.length === 1 ? 'y' : 'ies'} ${some(r.lost)}`] : []),
              ...(r.bonusesLost.length
                ? [`bonus${r.bonusesLost.length === 1 ? '' : 'es'} ${r.bonusesLost.slice(0, LIST_MAX).map((b) => `${b.id} (${signed(b.value)})`).join(', ')}`]
                : []),
              ...(r.capturesFailed.length ? [`your capture of ${some(r.capturesFailed)} fails`] : []),
              ...(r.retaken.length ? [`${some(r.retaken)} is taken straight back`] : []),
            ];
        return `If player ${r.opponent} ${act}${when}: ${cost.join('; ')}.`;
      };
      const replyView = (r: StressReply) => ({
        text: sentence(r),
        opponent: { id: r.opponent, name: playerName.get(r.opponent) ?? String(r.opponent) },
        kind: r.kind,
        deploy: r.deploy,
        deployTo: name(r.deployTo),
        ...(r.kind === 'attack' ? { attack: { from: name(r.from!), to: name(r.to!), armies: r.armies } } : {}),
        // Every stack attacked: only the attacks on what was lost are listed, with the count of all.
        ...(r.attacks
          ? {
              attacks: r.attacks
                .filter((a) => r.lost.includes(a.to) || r.retaken.includes(a.to) || r.capturesFailed.includes(a.to))
                .slice(0, LIST_MAX)
                .map((a) => ({ from: name(a.from), to: name(a.to) })),
              attacksTried: r.attacks.length,
            }
          : {}),
        needsFirstMove: needs(r),
        lost: capped(r.lost),
        ...(r.lost.length > LIST_MAX ? { lostMore: r.lost.length - LIST_MAX } : {}),
        capturesFailed: capped(r.capturesFailed),
        retaken: capped(r.retaken),
        bonusesLost: r.bonusesLost.slice(0, LIST_MAX).map((b) => bonusOf(b.id)),
        incomeLost: r.incomeLost,
        commanderLost: r.commanderLost,
        armies: { you: r.myArmies, opponent: r.theirArmies },
      });
      /** One exposure in a sentence, by id. */
      const exposure = (e: StressExposure): string =>
        `Next turn player ${e.opponent} can reach territory ${e.territory} (${e.armies} there) with ${e.attackers} from territory ${e.from} ` +
        `by taking territory ${e.via} this turn: it needs ${e.needs} to hold${
          e.bonusesLost.length ? `, or bonus${e.bonusesLost.length === 1 ? '' : 'es'} ${e.bonusesLost.map((b) => `${b.id} (${signed(b.value)})`).join(', ')} goes with it` : ''
        }.`;
      const exposureView = (e: StressExposure) => ({
        text: exposure(e),
        territory: name(e.territory),
        armies: e.armies,
        needs: e.needs,
        attackers: e.attackers,
        from: name(e.from),
        via: name(e.via),
        opponent: { id: e.opponent, name: playerName.get(e.opponent) ?? String(e.opponent) },
        bonusesLost: e.bonusesLost.map((b) => bonusOf(b.id)),
        incomeLost: e.incomeLost,
      });
      const orderView = (e: SimEvent) => ({
        order: e.index + 1,
        from: name(e.from),
        to: name(e.to),
        ordered: e.ordered,
        sent: e.sent,
        result: e.result,
        ...(e.reason ? { reason: e.reason } : {}),
      });
      const short = report.baseline.log.filter((e) => e.result === 'skipped' || e.sent < e.ordered);
      const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
      const blind = report.blindBorders.length
        ? ` ${report.blindBorders.length} of your territories border the fog and were not tested.`
        : '';
      const inexact = report.exact ? '' : ' Battles are not exact in this game (luck or weighted rounding): each was resolved at its expectation.';
      const ahead = report.exposedNextTurn.length
        ? ` Next turn: ${report.exposedNextTurn.length} ${plural(report.exposedNextTurn.length, 'territory is', 'territories are')} within reach of a stack two steps away if you add nothing (see exposedNextTurn). First: ${exposure(report.exposedNextTurn[0]!)}`
        : '';
      const summary =
        report.safe === null
          ? `Nothing could be tested this turn: no opposing stack in view touches you.${blind}${ahead}`
          : report.safe
            ? `None of the ${report.considered} ${plural(report.considered, 'reply', 'replies')} tried costs you a territory, a capture or a bonus.${blind}${inexact}${ahead}`
            : `${report.harmful} of the ${report.considered} ${plural(report.considered, 'reply', 'replies')} tried ${plural(report.harmful, 'costs', 'cost')} you something. Worst: ${sentence(report.worst!)}${inexact}${ahead}`;
      const deployed = deploys.reduce((n, d) => n + d.armies, 0);
      const warnings = [
        ...(award ? assumedWarning(award) : []),
        ...(deployed !== income
          ? [
              `The orders deploy ${deployed} and your income is ${income}: the test used the orders as given (a Reinforcement card adds to the income; otherwise war.app refuses a wrong total).`,
            ]
          : []),
      ];
      const atRiskList = <T>(rows: readonly T[]) => rows.slice(0, LIST_MAX);

      return respond(view, VIEWS, (rung) => ({
        game: { id: game.id, name: game.name ?? null, turn },
        player: { id: me.id, name: me.name },
        safe: report.safe,
        summary,
        exact: report.exact,
        firstMover: first_mover ?? 'unknown',
        // #166: what the award of picks showed, the move order it implies included (absent with no pick list kept).
        ...(award ? { award: awardView(award, game, turn, name) } : {}),
        orderPriority,
        income,
        deployed,
        warnings,
        // Only an opponent with a stack in view can be given a reply; the others are named apart.
        enemyDeploy: opponents
          .filter((o) => inView.has(o.id))
          .map((o) => ({
            player: { id: o.id, name: playerName.get(o.id) ?? String(o.id) },
            deploy: o.deploy,
            source: enemy_deploy !== undefined ? 'enemy_deploy' : 'estimate',
          })),
        unseenOpponents: opponents.filter((o) => !inView.has(o.id)).map((o) => ({ id: o.id, name: playerName.get(o.id) ?? String(o.id) })),
        plan: {
          captures: report.baseline.captured.map(name),
          failedAttacks: report.baseline.failed.map(name),
          // Orders that sent fewer armies than ordered, or none: a typo, or armies that are not there.
          shortOrders: short.map(orderView),
          ...(rung === 'full' ? { orders: report.baseline.log.map(orderView), bonusesHeld: report.baseline.heldBonuses.map(bonusOf) } : {}),
        },
        worst: report.worst ? replyView(report.worst) : null,
        // The next most damaging replies (the worst one is above, not repeated here).
        otherReplies: report.replies.slice(1, rung === 'full' ? report.replies.length : 1 + COMPACT_OTHERS).map(replyView),
        harmful: report.harmful,
        considered: report.considered,
        atRisk: {
          commander: report.atRisk.commander,
          territories: atRiskList(report.atRisk.territories).map((t) => ({ territory: name(t.id), replies: t.replies })),
          ...(report.atRisk.territories.length > LIST_MAX ? { territoriesMore: report.atRisk.territories.length - LIST_MAX } : {}),
          captures: atRiskList(report.atRisk.captures).map((t) => ({ territory: name(t.id), replies: t.replies })),
          ...(report.atRisk.captures.length > LIST_MAX ? { capturesMore: report.atRisk.captures.length - LIST_MAX } : {}),
          bonuses: atRiskList(report.atRisk.bonuses).map((b) => ({ ...bonusOf(b.id), replies: b.replies })),
          ...(report.atRisk.bonuses.length > LIST_MAX ? { bonusesMore: report.atRisk.bonuses.length - LIST_MAX } : {}),
        },
        blindBorders: report.blindBorders.map(name),
        // One turn ahead (#156): what the orders leave within reach of a stack two steps away.
        exposedNextTurn: report.exposedNextTurn.slice(0, LIST_MAX).map(exposureView),
        ...(report.exposedNextTurn.length > LIST_MAX ? { exposedMore: report.exposedNextTurn.length - LIST_MAX } : {}),
        notCovered: [...CHECK_PLAN_NOT_COVERED, ...new Set(ignored)],
        ...(rung === 'full' ? { assumptions: report.assumptions } : {}),
      }));
    },
  );
}
