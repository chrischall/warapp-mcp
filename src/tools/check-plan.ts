// The plan stress test as a tool: a list of orders (the shape warapp_plan_turn returns and
// warapp_submit_turn takes) is carried out on the live board against the single replies each
// opponent could make with its estimated deploy, and the replies that cost something are
// reported, worst first (src/analysis/stress.ts, on the turn resolver src/analysis/turn-sim.ts).
// Read-only on war.app, and it writes nothing: not the board cache either.
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { incomeFor, planEnemyEstimates, symmetricStart, trackGame, trackOpponents } from '../analysis/index.js';
import { stressPlan, type StressDodge, type StressExposure, type StressJoint, type StressReply } from '../analysis/stress.js';
import type { SimEvent, SimOrder } from '../analysis/turn-sim.js';
import { handOwners, opponentReinforcement } from './card-advice.js';
import { cardTypeByName, cardTypeName, normalizeGuid, readHand } from '../cards.js';
import { boardStateFromLive } from '../live.js';
import { carriesTeam } from '../teams.js';
import { assumedWarning, awardView, loadAward, openingThreat } from './award.js';
import { gameIdArg, graphOf, namer, readAnnotations, respond, untrustedDescription, untrustedText, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { loadLiveGame, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { mapOf } from './map.js';
import { resolveTerritory } from './resolve.js';
import {
  boardHistory,
  currentTurn,
  truceRelations,
  friendsOf,
  guardOffWarnings,
  modsWarning,
  plannerSettings,
  requirePlayingSeat,
  requireTurnPhase,
  turnOrdersArg,
} from './turn.js';

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
  'a deploy split over several stacks',
  'two opponents together other than on one of your territories, and two free-for-all opponents together at all unless you lead (see leader)',
  'under Multi-Attack, any chain of attacks but the one most damaging per stack',
  'cards, apart from your own Order Priority',
] as const;

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
          'whole deploy on a territory you attack, or every stack attacking at once; a stack you attack moving out ' +
          'first (a dodge: into its own territory, or a neutral or one of yours it can take — `dodges` lists each ' +
          'with the armies that got away and what your strike then hit); two opponents striking one of your ' +
          'territories together (teammates always; any two in a free-for-all when you lead — `jointFalls` gives the ' +
          'armies each such territory needs to hold); and, under Multi-Attack, each stack\'s most damaging chain ' +
          'of captures. Under Local Deployment each deploy is bounded by where its bonus armies may land. Each ' +
          'reply is tried with you moving first and with the opponent moving first unless `first_mover` says ' +
          'which. A reply that keeps alive a player your orders finish off is `eliminationsFailed`. Returns `safe` (true, ' +
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
          '`Cycle` move order (not NoLuckCycle, where play speed sets it) — pass it as `first_mover` to judge by it; both orders are still tried by default. ' +
          'In a free-for-all with a truce in force (the agreement ledger), its partner is still tried — `safe` is safe ' +
          'against a break too — each reply that attacks a territory a truce covers is marked `breaksTruce`, and ' +
          '`safeIfTruceHolds` is the verdict over the other replies (null when every reply is a break). ' +
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
            "everyone's; other card plays and discards are ignored. A move's options (mode, percent, commander, " +
            'attack_teammates) are carried out as war.app would.',
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
      const opening = openingThreat(award, game, graph, seen, turn);
      const settings = plannerSettings(game.settings);

      const deploys: { territoryId: number; armies: number }[] = [];
      const moves: SimOrder[] = [];
      /** Options the game would refuse (#165): the orders are still tried, and the warning says so. */
      const refused = new Set<string>();
      const s = game.settings;
      // A team shares one hand (#163): mine and my teammates' cards.
      const hand = readHand(info, handOwners(game, me));
      let orderPriority = false;
      const ignored: string[] = [];
      const friends = friendsOf(game.players, me);
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
          // As warapp_submit_turn does (#165): attacking teammates needs a teammate.
          if (o.attack_teammates && !friends.size) {
            const [from, to] = [resolveTerritory(map, o.from), resolveTerritory(map, o.to)];
            throw new McpToolError(
              `${untrustedText(from.name)} (${from.id}) → ${untrustedText(to.name)} (${to.id}) sets attack_teammates, but you have no teammates in this game.`,
              { hint: 'Leave attack_teammates out: outside a team game every territory not yours is attacked anyway.' },
            );
          }
          moves.push({
            from: resolveTerritory(map, o.from).id,
            to: resolveTerritory(map, o.to).id,
            armies: o.armies,
            ...(o.mode === 'attack-only' || o.mode === 'transfer-only' ? { mode: o.mode } : {}),
            ...(o.percent ? { byPercent: true } : {}),
            ...(o.commander ? { withCommander: true } : {}),
            ...(o.attack_teammates ? { attackTeammates: true } : {}),
          });
          if (o.mode === 'transfer-only' && s?.allowTransferOnly !== true) refused.add('Transfer Only (AllowTransferOnly is off)');
          if (o.mode === 'attack-only' && s?.allowAttackOnly !== true) refused.add('Attack Only (AllowAttackOnly is off)');
          if (o.percent && s?.allowPercentageAttacks !== true) refused.add('a percentage order (AllowPercentageAttacks is off)');
          if (o.commander && s?.commanders !== true) refused.add('a commander move (this game has no commanders)');
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
        // #226: my orders on that turn, when this server sent them, as warapp_plan_turn has them.
        ...(history.previous && turn !== null && history.boards.find((b) => b.turn === turn - 1)?.orders
          ? { previousOrders: history.boards.find((b) => b.turn === turn - 1)!.orders! }
          : {}),
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
          // #166: the opponent's opening simulated from the starts the award proved, as the prior.
          ...(opening ? { opening } : {}),
          // #164: exact income where the fog shows every owner, and an opponent's Reinforcement card.
          ...(game.settings?.fog !== undefined ? { fog: game.settings.fog } : {}),
          ...(opponentReinforcement(game.settings, hand) ? { reinforcement: opponentReinforcement(game.settings, hand)! } : {}),
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
        .map((id) => {
          const e = estimates.find((x) => x.playerId === id);
          return { id, deploy: enemy_deploy ?? e?.estimate ?? base, base: e?.base ?? base };
        });
      const teams = new Map<number, number>();
      for (const p of game.players) if (carriesTeam(p.team)) teams.set(p.id, p.team);
      const inView = new Set(board.territories.flatMap((t) => (t.owner.kind === 'player' && t.armies !== null ? [t.owner.playerId] : [])));
      // #180: in a free-for-all I lead when my income beats every estimate of an opponent in view
      // (two at least; enemy_deploy is a what-if, not the game's standing): then any two of them
      // may strike one territory of mine together.
      const rivals = opponents.filter((o) => inView.has(o.id));
      const estimateOf = (id: number) => estimates.find((x) => x.playerId === id)?.estimate ?? base;
      const leader = teams.size === 0 && rivals.length >= 2 && rivals.every((o) => income > estimateOf(o.id));

      // B2 T6: the truces in force (the ledger, as warapp_plan_turn reads it). Their partners stay among
      // the opponents tried, so `safe` still means safe against a break; `safeIfTruceHolds` leaves the
      // breaks out. Only in a free-for-all, as the planner honours them.
      // `income` is the board's, card armies out — the same figure warapp_plan_turn passes.
      const truces = (await truceRelations(ctx, { game, me, turn, graph, board: seen, boards: history.boards, myIncome: income, tracks }))?.relations ?? [];
      const binding =
        teams.size === 0
          ? truces.filter((r) => (r.state === 'active' || r.state === 'notice') && (r.endsTurn === undefined || turn === null || turn < r.endsTurn) && !friend(r.player))
          : [];

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
        ...(settings.localDeployments ? { localDeployments: true } : {}),
        leader,
        ...(binding.length ? { truces: binding.map((r) => ({ player: r.player, covered: r.coveredMine })) } : {}),
      });

      const name = namer(map);
      const playerName = new Map(game.players.map((p) => [p.id, p.name]));
      const who = (id: number) => ({ id, name: playerName.get(id) ?? String(id) });
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
              : r.kind === 'dodge'
                ? `deploys ${r.deploy} on territory ${r.deployTo} and moves it out first, ${r.armies} into territory ${r.to}`
                : r.kind === 'chain'
                  ? `deploys ${r.deploy} on territory ${r.deployTo} and attacks on through territories ${r.path!.slice(1).join(' → ')}`
                  : r.kind === 'joint'
                    ? `and player ${r.partner} strike territory ${r.to} together from territories ${r.from} and ${r.partnerDeployTo} (deploying ${r.deploy} and ${r.partnerDeploy})`
                    : `attacks with every stack at once (${r.attacks!.length} attacks), its ${r.deploy} on territory ${r.deployTo}`;
        const when =
          (needs(r) === 'you' ? ', and you move first' : needs(r) === 'opponent' ? `, and ${r.kind === 'joint' ? 'they move' : 'it moves'} first` : '') +
          (r.firstOpponent !== undefined ? `, player ${r.firstOpponent} before the other` : '');
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
              ...(r.eliminationsFailed.length ? [`player ${r.eliminationsFailed.join(', player ')} stays in the game`] : []),
            ];
        return `If player ${r.opponent} ${act}${when}: ${cost.join('; ')}.`;
      };
      const replyView = (r: StressReply) => ({
        text: sentence(r),
        opponent: who(r.opponent),
        kind: r.kind,
        deploy: r.deploy,
        deployTo: name(r.deployTo),
        ...(r.kind === 'attack' || r.kind === 'dodge' || r.kind === 'chain' ? { attack: { from: name(r.from!), to: name(r.to!), armies: r.armies } } : {}),
        // #180: a chain's every territory, and a joint strike's second opponent.
        ...(r.path ? { path: r.path.map(name) } : {}),
        ...(r.partner !== undefined
          ? {
              partner: who(r.partner),
              partnerDeploy: r.partnerDeploy,
              partnerDeployTo: name(r.partnerDeployTo!),
              ...(r.firstOpponent !== undefined ? { firstOpponent: who(r.firstOpponent) } : {}),
            }
          : {}),
        // Every stack attacked: only the attacks on what was lost are listed, with the count of all.
        ...(r.attacks && r.kind === 'all-attack'
          ? {
              attacks: r.attacks
                .filter((a) => r.lost.includes(a.to) || r.retaken.includes(a.to) || r.capturesFailed.includes(a.to))
                .slice(0, LIST_MAX)
                .map((a) => ({ from: name(a.from), to: name(a.to) })),
              attacksTried: r.attacks.length,
            }
          : {}),
        needsFirstMove: needs(r),
        // B2 T6: the reply breaks a truce (a partner attacks a territory of yours it covers).
        ...(r.breaksTruce ? { breaksTruce: true } : {}),
        lost: capped(r.lost),
        ...(r.lost.length > LIST_MAX ? { lostMore: r.lost.length - LIST_MAX } : {}),
        capturesFailed: capped(r.capturesFailed),
        retaken: capped(r.retaken),
        bonusesLost: r.bonusesLost.slice(0, LIST_MAX).map((b) => bonusOf(b.id)),
        incomeLost: r.incomeLost,
        commanderLost: r.commanderLost,
        eliminationsFailed: r.eliminationsFailed.map(who),
        armies: { you: r.myArmies, opponent: r.theirArmies },
      });
      /** #180: a dodge in a sentence, by id. */
      const dodgeText = (d: StressDodge): string => {
        const hit = d.strikes.length ? ` Your ${plural(d.strikes.length, 'strike', 'strikes')} on territory ${d.stack} then ${d.strikes.map((x) => x.result).join(', ')}.` : '';
        return d.took
          ? `Player ${d.opponent} can move its stack on territory ${d.stack} (with its ${d.deploy}) out first into territory ${d.exit} (${d.exitOwner}), ${d.escaped} getting away${d.commander ? ' with its commander' : ''}.${hit}`
          : `Player ${d.opponent} moving its stack on territory ${d.stack} out first into territory ${d.exit} (${d.exitOwner}) fails.${hit}`;
      };
      const dodgeView = (d: StressDodge) => ({
        text: dodgeText(d),
        opponent: who(d.opponent),
        stack: name(d.stack),
        exit: name(d.exit),
        exitOwner: d.exitOwner,
        deploy: d.deploy,
        sent: d.sent,
        took: d.took,
        escaped: d.escaped,
        commander: d.commander,
        strikes: d.strikes.map((x) => ({ from: name(x.from), result: x.result, sent: x.sent })),
        harmful: d.harmful,
      });
      /** #180: a territory two opponents take together, in a sentence. */
      const jointText = (j: StressJoint): string =>
        `Players ${j.opponents[0]} and ${j.opponents[1]} together take territory ${j.territory} (${j.armies} there) with ${j.attackers[0]} from ` +
        `territory ${j.from[0]} and ${j.attackers[1]} from territory ${j.from[1]}: it needs ${j.needs} to hold${
          j.bonusesLost.length ? `, or bonus${j.bonusesLost.length === 1 ? '' : 'es'} ${j.bonusesLost.map((b) => `${b.id} (${signed(b.value)})`).join(', ')} goes with it` : ''
        }.`;
      const jointView = (j: StressJoint) => ({
        text: jointText(j),
        territory: name(j.territory),
        armies: j.armies,
        needs: j.needs,
        opponents: j.opponents.map(who),
        from: j.from.map(name),
        attackers: j.attackers,
        bonusesLost: j.bonusesLost.map((b) => bonusOf(b.id)),
        incomeLost: j.incomeLost,
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
        opponent: who(e.opponent),
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
      // A percentage order's count is a percentage: short only when it sent nothing (#165).
      const short = report.baseline.log.filter(
        (e) => e.result === 'skipped' || (moves[e.index]?.byPercent ? e.sent === 0 : e.sent < e.ordered),
      );
      const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
      const blind = report.blindBorders.length
        ? ` ${report.blindBorders.length} of your territories border the fog and were not tested.`
        : '';
      const inexact = report.exact ? '' : ' Battles are not exact in this game (luck or weighted rounding): each was resolved at its expectation.';
      const ahead = report.exposedNextTurn.length
        ? ` Next turn: ${report.exposedNextTurn.length} ${plural(report.exposedNextTurn.length, 'territory is', 'territories are')} within reach of a stack two steps away if you add nothing (see exposedNextTurn). First: ${exposure(report.exposedNextTurn[0]!)}`
        : '';
      // #180: stacks you attack that can step out of the way first.
      const escapes = report.dodges.filter((d) => d.took && d.escaped > 0);
      const escapingStacks = new Set(escapes.map((d) => d.stack)).size;
      const dodged = escapingStacks
        ? ` ${escapingStacks} of the stacks you attack can move out first and get away (see dodges).`
        : '';
      // B2 T6: what the verdict is if every truce holds.
      const truceLine =
        report.safeIfTruceHolds === undefined
          ? ''
          : report.safe === false && report.safeIfTruceHolds === true
            ? ` Only a break of a truce costs you something: if every truce holds, nothing tried does (safeIfTruceHolds).`
            : report.safe === false && report.safeIfTruceHolds === null
              ? ' Every reply tried breaks a truce (safeIfTruceHolds is null).'
              : '';
      const summary =
        report.safe === null
          ? `Nothing could be tested this turn: no opposing stack in view touches you.${blind}${ahead}`
          : report.safe
            ? `None of the ${report.considered} ${plural(report.considered, 'reply', 'replies')} tried costs you a territory, a capture or a bonus.${blind}${inexact}${dodged}${ahead}`
            : `${report.harmful} of the ${report.considered} ${plural(report.considered, 'reply', 'replies')} tried ${plural(report.harmful, 'costs', 'cost')} you something. Worst: ${sentence(report.worst!)}${truceLine}${inexact}${dodged}${ahead}`;
      const deployed = deploys.reduce((n, d) => n + d.armies, 0);
      const warnings = [
        ...(award ? assumedWarning(award) : []),
        ...modsWarning(game.settings),
        // As plan/submit do (#165); a percentage order counts what it sent unanswered.
        ...guardOffWarnings(
          graph,
          map,
          board,
          me.id,
          friends,
          game.settings,
          deploys,
          moves.map((m, i) => ({
            from: m.from,
            to: m.to,
            armies: m.byPercent ? (report.baseline.log.find((e) => e.index === i)?.sent ?? 0) : m.armies,
          })),
        ),
        ...(refused.size
          ? [`These orders use ${[...refused].join(', ')}: war.app would refuse them in this game, and warapp_submit_turn does; the test ran them anyway.`]
          : []),
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
        // B2 T6: with a truce in force, the verdict over the replies that break none (absent with no truce).
        ...(report.safeIfTruceHolds !== undefined
          ? {
              safeIfTruceHolds: report.safeIfTruceHolds,
              truces: binding.map((r) => ({ player: who(r.player), ...(r.agreement ? { agreement: r.agreement } : {}), state: r.state, covered: r.coveredMine.length })),
            }
          : {}),
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
        // #180: in a free-for-all, whether you lead (any two opponents are then tried together).
        leader,
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
        // #180: each stack you attack moving out first (compact: those that get away), and
        // territories two opponents take together.
        dodges: (rung === 'full' ? report.dodges : escapes).slice(0, LIST_MAX).map(dodgeView),
        jointFalls: report.jointFalls.slice(0, LIST_MAX).map(jointView),
        ...(report.jointFalls.length > LIST_MAX ? { jointFallsMore: report.jointFalls.length - LIST_MAX } : {}),
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
