// The plan stress test as a tool: a list of orders (the shape warapp_plan_turn returns and
// warapp_submit_turn takes) is carried out on the live board against the single replies each
// opponent could make with its estimated deploy, and the replies that cost something are
// reported, worst first (src/analysis/stress.ts, on the turn resolver src/analysis/turn-sim.ts).
// Read-only on war.app, and it writes nothing but its verdict to the decision log (#437): not the board cache.
import { bonusDelayWarning } from '../analysis/bonus-delay.js';
import { gameBaseIncome } from '../analysis/player.js';
import { McpToolError } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { stressPlan, type StressDodge, type StressExposure, type StressJoint, type StressReply } from '../analysis/stress.js';
import { neutralizeSeats, seatTerritories, staticSeats } from '../analysis/static-seats.js';
import type { SimEvent, SimOrder } from '../analysis/turn-sim.js';
import { profileFormatOf } from '../analysis/opponent-profile.js';
import { handOwners } from './card-advice.js';
import { fogPaceFor, mapMatchOf } from './past-games.js';
import { sanctionMyIncome } from './card-effects.js';
import { cardTypeByName, cardTypeName, normalizeGuid, readHand, type Card } from '../cards.js';
import { claimedCardUses, claimedCardWarning, teamCardClaims, teamHandLeft, unclaimedFirst } from '../team-cards.js';
import { boardStateFromLive } from '../live.js';
import { withTeammateOrders } from '../team-orders.js';
import { assumedWarning, awardView, loadAward, openingThreat } from './award.js';
import { readLedger } from '../relations-store.js';
import { resolveIntel } from '../analysis/intel.js';
import { allyAttackLine, attacksOnAllies, modAllianceWarnings } from './mod-alliances.js';
import { avoidPlayersArg, avoidTerritoriesArg, gameIdArg, graphOf, knownIncomeArg, namer, readAnnotations, respond, untrustedDescription, untrustedText, viewArg } from './common.js';
import { lookupMeta } from './hints.js';
import { HEADROOM_COMPACT, headroomView, readTripwires, safeHeadroom, teamsOf, tripwireWarnings, untrustedDeploy } from './survival.js';
import { loadLiveGame, standInLine, standInOf, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { mapOf } from './map.js';
import { resolvePlayer, resolveTerritory } from './resolve.js';
import {
  BELOW_PLAN_BASIS,
  boardHistory,
  bordersBelowPlan,
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
import { resolveTeamsFor } from './team-source.js';
import { stressOpponents } from './stress-opponents.js';
import { sanctionPercentage } from '../analysis/cards-in-effect.js';
import { CARD_SANCTIONS, sanctionsPlayed } from './sanctions-played.js';
import type { CommanderAirlift, CommanderSafety } from '../analysis/commander-safety.js';
import { COMMANDER_SIZING, commanderCheckOn, defaultFoggedCount, foggedAttackersArg, foggedCommanderOn, foggedCommanderText, myLargestStack } from './commander-check.js';
import { DEFAULT_FOGGED_ATTACKERS, foggedStack } from '../analysis/commander-fog.js';
import { captureCheck, checkPlanLog } from './decision-capture.js';
import type { CardPlayKind } from '../protocol/methods.js';
import { farSummary, opponentScope } from '../analysis/scale.js';
import { territoryCapOverruns } from '../analysis/plan/relations.js';

const VIEWS = ['compact', 'full'] as const;
const MAX_ENEMY_DEPLOY = 10_000;
/** Replies listed beside the worst one on the compact view; the full view lists the stress test's own maximum. */
const COMPACT_OTHERS = 2;
/** The most territories or bonuses any one list names; the rest are a count. */
const LIST_MAX = 10;
const ORDER_PRIORITY = cardTypeByName('Order Priority');
const BOMB = cardTypeByName('Bomb');
const EMERGENCY_BLOCKADE = cardTypeByName('Emergency Blockade');
const BLOCKADE = cardTypeByName('Blockade');

/** A wall card's `MultiplyAmount` from the settings (`EmergencyBlockadeCard`, `BlockadeCard`), when the game sets one. */
function wallMultiplier(raw: Record<string, unknown> | undefined, key: string): number | undefined {
  const r = raw?.[key];
  if (typeof r !== 'object' || r === null) return undefined;
  const m = Number((r as Record<string, unknown>).MultiplyAmount);
  return Number.isFinite(m) && m > 0 ? m : undefined;
}
/** Card plays that change the board this test does not simulate, each with what the test does instead. */
const UNSIMULATED_CARDS = new Map<number | undefined, (on: string) => string>([
]);

/** #274: the card plays the commander check reads (an Airlift simulated, the others named on its territory). */
const COMMANDER_CARD_KINDS = new Map<number | undefined, CardPlayKind>([
  [cardTypeByName('Airlift'), 'Airlift'],
  [cardTypeByName('Blockade'), 'Blockade'],
  [cardTypeByName('Emergency Blockade'), 'EmergencyBlockade'],
  [cardTypeByName('Gift'), 'Gift'],
]);

/** What the stress test does not try, said with every answer so "safe" is never read as more. */
export const CHECK_PLAN_NOT_COVERED = [
  'stacks hidden by fog, armies included (see blindBorders), and opponents with nothing in view (see unseenOpponents)',
  'an opponent that deploys more than the estimate (raise enemy_deploy to test it)',
  'a deploy split over several stacks',
  'two opponents together other than on one of your territories, and two free-for-all opponents together at all unless you lead (see leader)',
  'under Multi-Attack, any chain of attacks but the one most damaging per stack',
  'cards, apart from your own Order Priority, Airlifts, Bombs, Emergency Blockades and Blockades',
] as const;

export function registerCheckPlanTool(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_check_plan',
    {
      title: 'Stress-test a planned turn in a war.app game',
      description: untrustedDescription(
        'Stress-test a list of orders for your turn in an in-progress war.app (Warzone) game before you submit it ' +
          '(in a game of more than 16 opponents, `unseenOpponents` lists only those near your land — `unseenOpponentsMore` ' +
          'counts the rest — and `scale` sums the opponents not in view or within 2 steps of your land): ' +
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
          '`worst`, `exposedNextTurn`), not on the wording of `summary`, which may change. With your commander on the ' +
          'board, `commander` says where it stands after the orders, the armies there and `needs`: the armies its ' +
          'territory needs to survive every reply tried, by the check warapp_submit_turn refuses on (each reply at the larger ' +
          'of the estimate and your income, enemy_deploy only raising it, both move orders, your Airlifts counted); when a ' +
          'reply kills it, the summary starts with it. `commander.fogged` tests it against `fogged_attackers` (default as warapp_plan_turn: 2 in a Commanders free-for-all of eight or more players under fog, else off) ' +
          'unknown opponents the fog may hide within two moves of where it ends, striking together (each a start of the ' +
          "game's starting armies, else your largest stack, plus a deploy of your income; luck-free): `safe`, `needs`, where " +
          'they may come from; the summary names it when it can fall, and it never changes `safe`. Exact with no luck and ' +
          'straight rounding; otherwise battles are resolved at their expectation and `exact` is false. It does not ' +
          `try: ${CHECK_PLAN_NOT_COVERED.join('; ')}. When this server kept your pick list, \`award\` says what the ` +
          "award of picks showed (as in warapp_plan_turn): the opponent's proven starts stand on the board the " +
          'orders are tried on even while fogged, and `award.firstMover` is who moves first this turn under a ' +
          '`Cycle` move order (not NoLuckCycle, where play speed sets it) — pass it as `first_mover` to judge by it; both orders are still tried by default. ' +
          '`headroom` lists, weakest first, each border of yours with the smallest single deploy by a neighbouring opponent that ' +
          'takes it after these orders, and what falls with it (the bonuses it breaks, the territories behind it and their bonus ' +
          'income). An opponent whose estimate one observation broke (see warapp_plan_turn) is tried at the larger of what it ' +
          'implied and your own income (`enemyDeploy` source `untrusted`), said in the first warning. Each `enemyDeploy` entry ' +
          "shows the Reinforcement card the clock says it may hold apart as `cardBonus` (in `deploy` unless `assume_enemy_cards` is " +
          '"none"; a progressive card\'s source in `cardBonusBasis`, as warapp_plan_turn has it) and, under Sanctions, `sanctionApplied` (its income before and after the cut).' +
          'A Sanctions card in the orders is projected onto next turn in `sanctionsPlayed` (`nextIncome`: yours from this turn\'s ' +
          'income when the game\'s percentage is negative and you play it on yourself, an opponent\'s estimate when positive), and ' +
          'a card on the wrong side for its sign is a warning (warapp_submit_turn refuses it). ' +
          '`belowPlan` compares these orders with the default plan made now on the same board (warapp_plan_turn with no ' +
          'options, the award of picks read as it reads it), or with its border guess when the deploys given are the ' +
          "guess's (`belowPlanAgainst`: plan or guess): each border they leave below what that plan leaves standing there, " +
          'with `planLeaves`, `left` and `short`, the largest shortfall first (empty: none). `planLeaves` carries the ' +
          "plan's surplus, so a border named may still hold (see `headroom`); orders warapp_plan_turn made with options " +
          'differ from the default plan by design. ' +
          'In a free-for-all with a truce in force (the agreement ledger), its partner is still tried — `safe` is safe ' +
          'against a break too — each reply that attacks a territory a truce covers is marked `breaksTruce`, and ' +
          '`safeIfTruceHolds` is the verdict over the other replies (null when every reply is a break); a partner-approved ' +
          'truce exception on this turn opens its territories (no break) and is listed under `relations`. ' +
          'In a game running the Diplomacy 2 mod, an ally is such a truce too, and a warning names any order that attacks ' +
          'a territory an ally holds (the game skips it; its armies sit idle). ' +
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
            "everyone's; an Airlift (`from`, `to`, `armies`) is carried out at its phase — after every deploy, before every " +
            'move: its source loses the armies, its destination gains them, and they cannot move again that turn — so ' +
            'every reply is tried against the board it leaves; other card plays and discards are ignored by the test ' +
            '(a Bomb is carried out at its phase too — after every deploy, its target keeps half its armies, rounded down; an ' +
            'Emergency Blockade before the moves and a Blockade after them turn their territory neutral at its armies × the ' +
            "game's multiplier; a wall whose multiplier the settings do not give is named " +
            'in `warnings` as not simulated; in a team game, a card your teammate has ' +
            "already entered is warned of). A move's options (mode, percent, commander, " +
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
              'income when larger; in a 1v1 that started even, an opponent bordering the fog at least your own income; while an ' +
              'observation has made its estimate untrusted, the larger of what it implied and your own income). ' +
              'Income in the fog is unseen, so raise it to test a stronger opponent.',
          ),
        known_income: knownIncomeArg,
        fogged_attackers: foggedAttackersArg.describe(
          `With your commander on the board: how many unknown opponents the fog may hide within two moves of where it ends ` +
            `strike it together (default ${DEFAULT_FOGGED_ATTACKERS} in a free-for-all of eight or more players under fog, as warapp_plan_turn; else 0, which skips the test). Each is taken as a player's start ` +
            "(the game's starting armies, else your largest stack) plus a deploy of your income. Reported as `commander.fogged`; " +
            'never changes `safe`.',
        ),
        avoid_territories: avoidTerritoriesArg,
        avoid_players: avoidPlayersArg,
        first_mover: z
          .enum(['me', 'opponent'])
          .optional()
          .describe(
            'Who moves first this turn, when you know (under cyclic move order it alternates every turn). Omit to ' +
              'try both.',
          ),
        assume_enemy_cards: z
          .enum(['none', 'clock'])
          .optional()
          .describe(
            '"clock" (default): each opponent the Reinforcement card clock says may hold a card (one due, none of its plays ' +
              'seen since) deploys that card on top of its estimate; "none": the replies are sized without it. Each ' +
              "`enemyDeploy` entry shows the card apart as `cardBonus`, so run both to see which risks rest on a guessed card.",
          ),
        view: viewArg(
          VIEWS,
          `compact (default) gives the verdict, the worst reply and up to ${COMPACT_OTHERS} more; "full" adds every ` +
            'reply listed, each order\'s result unanswered and the rules assumed.',
        ),
      }),
    },
    async ({ game_id, player, orders, enemy_deploy, known_income, fogged_attackers, avoid_territories, avoid_players, first_mover, assume_enemy_cards, view }) => {
      const feed = await ctx.client.getGame(game_id, { settings: true });
      requireTurnPhase(feed);
      const map = mapOf(feed);
      const seat = await resolveMe(ctx, feed.players, player);
      requirePlayingSeat(feed, seat);
      // The teams: GameFeed's, else the game list's (asked once per game, kept).
      const { game, me, source: teamSource, known: teamsKnown } = await resolveTeamsFor(ctx, feed, seat);
      const turn = currentTurn(game);
      // #386: the avoid targets and stated incomes warapp_record_intel kept, as warapp_plan_turn applies them.
      const intel = resolveIntel(ctx.dataDir ? (await readLedger(ctx.dataDir, game.id, me.id))?.intel : undefined, turn, {
        ...(known_income !== undefined ? { knownIncome: known_income } : {}),
        ...(avoid_territories !== undefined ? { avoidTerritories: avoid_territories } : {}),
        ...(avoid_players !== undefined ? { avoidPlayers: avoid_players } : {}),
      });
      const [{ territories, info }, history] = await Promise.all([loadLiveGame(ctx, game), boardHistory(ctx, game, me, turn)]);
      const graph = graphOf(map);
      // As warapp_plan_turn does (#166): the opponent's starts the award of picks proves stand on
      // the board the orders are tried on; the history and tracks stay what war.app showed.
      const seen = withTeammateOrders(boardStateFromLive(territories, me, game.players), info, me, game.players);
      const award = await loadAward(ctx.dataDir, game, me, seen, turn, { decisionLog: ctx.decisionLog });
      // #270: a player out of the game whose seat no AI plays deploys and attacks nothing: its
      // territories are neutrals here (static armies), and it is tried as no opponent.
      const seats = staticSeats(game.players, game.endRules, me.id);
      const board = neutralizeSeats(award?.board ?? seen, seats);
      const opening = openingThreat(award, game, graph, seen, turn);
      const settings = plannerSettings(game.settings);
      // #419: the past winners' pace, as warapp_plan_turn reads it (thin evidence's upper bound).
      const mapPace = await fogPaceFor(ctx.dataDir, undefined, game.settings?.mapId ?? map.id, mapMatchOf(profileFormatOf(game.players), game.settings), turn === null ? null : turn - 1);

      const deploys: { territoryId: number; armies: number }[] = [];
      const moves: SimOrder[] = [];
      /** Options the game would refuse (#165): the orders are still tried, and the warning says so. */
      const refused = new Set<string>();
      const s = game.settings;
      // A team shares one hand (#163): mine and my teammates' cards.
      const hand = readHand(info, handOwners(game, me));
      // G3: the cards my teammates' entered orders already play or discard (V5, unverified live), warned of as
      // warapp_submit_turn does; a card named by its type is taken as one nobody entered when there is one.
      const { claimed } = teamHandLeft(hand, teamCardClaims(seen.teammateOrders, friendsOf(game.players, me)));
      const uses: { card: Card; kind: 'play' | 'discard' }[] = [];
      const useCard = (ref: string, kind: 'play' | 'discard') => {
        const guid = normalizeGuid(ref.trim());
        const type = guid === undefined ? cardTypeByName(ref) : undefined;
        const card = unclaimedFirst(hand, claimed).find(
          (c) => (guid !== undefined ? c.id === guid : c.type === type) && !uses.some((u) => u.card.id === c.id),
        );
        if (card) uses.push({ card, kind });
      };
      let orderPriority = false;
      const sanctionsTargets: number[] = [];
      const airlifts: CommanderAirlift[] = [];
      /** My Bombs' targets: carried out at their phase (30) by the stress test. */
      const bombs: number[] = [];
      /** My Emergency Blockades (phase 37) and Blockades (phase 60): carried out by the stress test with the game's multiplier. */
      const abandons: { target: number; multiplier: number }[] = [];
      const blockades: { target: number; multiplier: number }[] = [];
      const cardTargets: { kind: CardPlayKind; territory: number }[] = [];
      const ignored: string[] = [];
      const unsimulatedCards: string[] = [];
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
        } else if (o.kind === 'discard') {
          useCard(o.card, 'discard');
        } else if (o.kind === 'card') {
          useCard(o.card, 'play');
          // By GUID it is looked up in my hand; by type name the name is enough (this is a what-if).
          const guid = normalizeGuid(o.card.trim());
          const type = guid !== undefined ? hand.find((c) => c.id === guid)?.type : cardTypeByName(o.card);
          // Owner request 2026-11-24: a Sanctions play's income change is projected on next turn (below).
          if (type === CARD_SANCTIONS && o.player !== undefined) {
            try {
              sanctionsTargets.push(resolvePlayer(game.players, o.player).id);
            } catch {
              // A player not in the game: warapp_submit_turn refuses it; nothing is projected.
            }
          }
          const unsimulated = type !== undefined ? UNSIMULATED_CARDS.get(type) : undefined;
          if (unsimulated) {
            let on = '';
            try {
              if (o.target !== undefined) on = ` on ${resolveTerritory(map, o.target).id}`;
            } catch {
              // A target not on the map: warapp_submit_turn refuses it; the warning names no territory.
            }
            unsimulatedCards.push(unsimulated(on));
          }
          // #274: the commander check simulates my Airlifts, and names a Blockade or Gift of the commander's
          // territory, as warapp_submit_turn does.
          const kindOf = type !== undefined ? COMMANDER_CARD_KINDS.get(type) : undefined;
          try {
            if (kindOf === 'Airlift' && o.from !== undefined && o.to !== undefined)
              airlifts.push({
                from: resolveTerritory(map, o.from).id,
                to: resolveTerritory(map, o.to).id,
                armies: o.armies ?? 0,
                ...(o.commander ? { commander: true } : {}),
              });
            else if (kindOf && kindOf !== 'Airlift' && o.target !== undefined) cardTargets.push({ kind: kindOf, territory: resolveTerritory(map, o.target).id });
          } catch {
            // A territory not on the map: warapp_submit_turn refuses it; the check goes without it.
          }
          if (type !== undefined && type === ORDER_PRIORITY) orderPriority = true;
          else if (type === BOMB) {
            try {
              if (o.target !== undefined) bombs.push(resolveTerritory(map, o.target).id);
            } catch {
              // A target not on the map: warapp_submit_turn refuses it; the test goes without it.
            }
          } else if (type === EMERGENCY_BLOCKADE || type === BLOCKADE) {
            const key = type === BLOCKADE ? 'BlockadeCard' : 'EmergencyBlockadeCard';
            const multiplier = wallMultiplier(game.settings?.raw, key);
            const name = type === BLOCKADE ? 'Blockade' : 'Emergency Blockade';
            try {
              const target = o.target !== undefined ? resolveTerritory(map, o.target).id : undefined;
              if (target !== undefined && multiplier !== undefined) (type === BLOCKADE ? blockades : abandons).push({ target, multiplier });
              else if (target !== undefined)
                unsimulatedCards.push(`The ${name} on ${target} is not simulated: the game's settings give no multiplier for it.`);
            } catch {
              // A target not on the map: warapp_submit_turn refuses it; the test goes without it.
            }
          } else if (kindOf === 'Airlift') {
            // Owner request 2026-11-24: the stress test carries the Airlift out at its phase (below).
          } else if (type === undefined || cardTypeName(type) !== 'Reinforcement') ignored.push('a card play other than Order Priority, Reinforcement, Airlift, Bomb or a Blockade');
        }
      }

      // The same per-opponent estimates warapp_plan_turn works from (stress-opponents.ts); an opponent's
      // Reinforcement card the clock adds is on top unless `assume_enemy_cards` is "none".
      const assumeCards = assume_enemy_cards ?? 'clock';
      const so = stressOpponents({
        graph,
        map,
        game,
        me,
        board,
        seen,
        boards: history.boards,
        ...(history.previous ? { previous: history.previous.board } : {}),
        turn,
        settings,
        hand,
        info,
        ...(opening ? { opening } : {}),
        ...(mapPace ? { mapPace } : {}),
        ...(enemy_deploy !== undefined ? { enemyDeploy: enemy_deploy } : {}),
        assumeCards,
        // #444: the stated incomes scale the other opponents' prior, as warapp_plan_turn has them.
        ...(intel.knownIncome?.length ? { known: intel.knownIncome } : {}),
      });
      const { tracks, income, effect, friend, teams, inView, leader, estimates } = so;
      // #275 (b): an opponent whose estimate an observation broke is tried at the larger of what tripped it
      // and my own income (never below its estimate). Read only: warapp_plan_turn keeps the marks.
      const tripTeams = teamsOf(game.players);
      const trip = await readTripwires({
        dataDir: ctx.dataDir,
        gameId: game.id,
        me: me.id,
        turn,
        graph,
        boards: turn !== null ? [...history.boards, { turn, board: seen }] : [],
        settings,
        ...(tripTeams ? { teams: tripTeams } : {}),
        estimates,
        ...(effect.diplomacy.length ? { peace: effect.diplomacy.map((d) => d.player) } : {}),
        ...(teamsKnown ? {} : { teamsKnown: false }),
        gameSettings: game.settings,
        map,
        staticSeats: staticSeats(game.players, game.endRules, me.id),
      });
      const untrustedOf = new Map(trip.tripwires.map((w) => [w.player, untrustedDeploy(w, income)]));
      // #368: an income the caller knows replaces the estimate (a Reinforcement card the clock adds on top),
      // before an untrusted mark; enemy_deploy, a what-if for everyone, wins over both. The commander check
      // below keeps the submit's sizing, so it never calls safe what warapp_submit_turn refuses.
      const knownOf = new Map((enemy_deploy === undefined ? (intel.knownIncome ?? []) : []).map((k) => [k.player, k.income]));
      const opponents = so.opponents.map((o) => {
        const known = knownOf.get(o.id);
        if (known !== undefined) return { ...o, deploy: known + (assumeCards === 'none' ? 0 : (o.card ?? 0)) };
        const untrusted = untrustedOf.get(o.id);
        return enemy_deploy !== undefined || untrusted === undefined ? o : { ...o, deploy: Math.max(untrusted, o.deploy) };
      });

      // B2 T6: the truces in force (the ledger, as warapp_plan_turn reads it). Their partners stay among
      // the opponents tried, so `safe` still means safe against a break; `safeIfTruceHolds` leaves the
      // breaks out. Only in a free-for-all, as the planner honours them: a team game is left out here,
      // and a game with two players still playing (a 1v1, or an FFA down to two) ends every agreement
      // in the ledger (`agreementState`: two-left), so what binds is always one the planner's 'ffa' honours.
      // `income` is the board's, card armies out — the same figure warapp_plan_turn passes.
      // PLAN-TEAMS D3: a Diplomacy card in effect that the decoder is sure of is a truce here in any format
      // (T9: the game enforces it). Its player stays among the opponents too: the decoder is unverified.
      // T9 too: a Diplomacy 2 mod alliance (read only in a game that runs the mod) is a truce the game enforces.
      const resolvedTruces = await truceRelations(ctx, { game, me, turn, graph, board: seen, boards: history.boards, myIncome: income, tracks, diplomacy: effect.diplomacy });
      const truces = resolvedTruces?.relations ?? [];
      const modRead = resolvedTruces?.mod;
      const binding = truces.filter(
        (r) =>
          !friend(r.player) &&
          (r.enforced
            ? r.enforcedUntil === undefined || turn === null || turn < r.enforcedUntil
            : teams.size === 0 && (r.state === 'active' || r.state === 'notice') && (r.endsTurn === undefined || turn === null || turn < r.endsTurn)),
      );
      // D3: the deploy total is checked against my income under the Sanctions on me.
      // #332: a commerce game's gold, read from the standing, already carries any Sanctions (war.app pays it).
      const sanction =
        so.commerce?.source === 'standing'
          ? { income, warnings: [] as string[], applied: false }
          : sanctionMyIncome(income, effect, { localDeployments: settings.localDeployments === true });

      const played = sanctionsPlayed(sanctionsTargets, {
        settings: game.settings,
        me: me.id,
        friends,
        myIncome: sanction.income,
        estimateOf: (p) => so.estimates.find((e) => e.playerId === p)?.estimate,
      });

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
        ...(airlifts.length ? { airlifts } : {}),
        ...(bombs.length ? { bombs } : {}),
        ...(abandons.length ? { abandons } : {}),
        ...(blockades.length ? { blockades } : {}),
        ...(settings.localDeployments ? { localDeployments: true, baseIncome: gameBaseIncome(settings) } : {}),
        ...(settings.localDeployments && (settings.bonusArmyPer ?? 0) > 0 ? { perTerritoryIncome: true } : {}),
        leader,
        ...(binding.length ? { truces: binding.map((r) => ({ player: r.player, covered: r.coveredMine })) } : {}),
      });
      // #274: my commander, by the check warapp_submit_turn refuses on (commander-check.ts): the same
      // opponents, each reply at the larger of its estimate and my income (enemy_deploy only raises it,
      // and so does an untrusted opponent's figure, #275),
      // both move orders whatever first_mover says, my Airlifts simulated.
      const checked = commanderCheckOn({
        graph,
        me: me.id,
        settings,
        so,
        income,
        deploys,
        moves,
        orderPriority,
        ...(enemy_deploy !== undefined ? { floor: enemy_deploy } : {}),
        // #275: an untrusted opponent at the figure its tripwire gave it, as the stress test tries it
        // (enemy_deploy aside, the floor stays: never below what warapp_submit_turn tries).
        ...(untrustedOf.size ? { untrusted: untrustedOf } : {}),
        airlifts,
        cardTargets,
      });
      const guard = checked?.safety;
      // #437: the decision log keeps this check's verdict for the turn (the latest run wins). Writes only the
      // log, never the board cache. A what-if (enemy_deploy or known_income given) is marked so.
      if (turn !== null)
        await captureCheck(ctx, game.id, me.id, turn, checkPlanLog(report, { whatIf: enemy_deploy !== undefined || known_income !== undefined }));

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
        ...(e.breaksTruce ? { breaksTruce: true } : {}),
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
      // #376: an exposure only a truce break reaches is counted apart, after the real ones.
      const reachable = report.exposedNextTurn.filter((x) => !x.breaksTruce);
      const ifBroken = report.exposedNextTurn.length - reachable.length;
      const brokenLine = ifBroken ? ` ${ifBroken} more only if a truce breaks.` : '';
      const ahead = reachable.length
        ? ` Next turn: ${reachable.length} ${plural(reachable.length, 'territory is', 'territories are')} within reach of a stack two steps away if you add nothing (see exposedNextTurn). First: ${exposure(reachable[0]!)}${brokenLine}`
        : ifBroken
          ? ` Next turn: ${ifBroken} ${plural(ifBroken, 'territory is', 'territories are')} within reach of a stack two steps away only if a truce breaks (see exposedNextTurn).`
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
      // The count and `needs` come from one run (the commander check's), so the line never pairs a count
      // the full run found with armies the targeted run says hold.
      const commanderLine = guard ? commanderText(guard, guard.killers) : undefined;
      // Part 5 (mega game): my commander against unknown opponents in the fog striking it together (report only).
      const fogged = guard
        ? foggedCommanderOn({
            graph,
            board,
            me: me.id,
            settings,
            deploys,
            moves,
            count: fogged_attackers ?? defaultFoggedCount(game),
            stack: foggedStack(game.settings?.initialPlayerArmiesPerTerritory, myLargestStack(board, me.id)),
            deploy: income,
          })
        : undefined;
      const summary =
        (guard && (guard.killers > 0 || guard.lostUnanswered) && commanderLine ? `${commanderLine} ` : '') +
        (fogged && !fogged.safe ? `${foggedCommanderText(fogged)} ` : '') +
        (report.safe === null
          ? `Nothing could be tested this turn: no opposing stack in view touches you.${blind}${ahead}`
          : report.safe
            ? `None of the ${report.considered} ${plural(report.considered, 'reply', 'replies')} tried costs you a territory, a capture or a bonus.${blind}${inexact}${dodged}${ahead}`
            : `${report.harmful} of the ${report.considered} ${plural(report.considered, 'reply', 'replies')} tried ${plural(report.harmful, 'costs', 'cost')} you something. Worst: ${sentence(report.worst!)}${truceLine}${inexact}${dodged}${ahead}`);
      const deployed = deploys.reduce((n, d) => n + d.armies, 0);
      // #275 (a): the smallest single deploy that takes each border of mine after these orders.
      const headroom = safeHeadroom({
        graph,
        board,
        me: me.id,
        deploys,
        moves,
        settings,
        ...(teams.size ? { teams } : {}),
        ...(first_mover !== undefined ? { firstMover: first_mover } : {}),
        orderPriority,
      });
      // #275 pattern 3: each border these orders leave below what the default plan leaves there (one plan per call).
      const belowPlan = await bordersBelowPlan(ctx, { game, map, me, turn, territories, info, history, teamsKnown, given: { deploys, moves } });
      // #375: an order into a territory to avoid, or one an avoided player holds.
      const avoidT = new Set((intel.avoidTerritories ?? []).map((t) => resolveTerritory(map, t).id));
      const avoidP = new Set(intel.avoidPlayers ?? []);
      const ownerOf = (id: number) => {
        const o = board.territories.find((t) => t.territoryId === id)?.owner;
        return o?.kind === 'player' ? o.playerId : undefined;
      };
      // A Diplomacy 2 ally's territory (owner at the start of the turn): the game skips the attack, its armies sit idle.
      const allyHits = modRead ? attacksOnAllies(modRead, moves, ownerOf) : [];
      const avoidedHits = [...new Set(moves.map((m) => m.to))].filter(
        (to) => !mine.has(to) && (avoidT.has(to) || avoidP.has(ownerOf(to) ?? Number.NaN)),
      );
      // A territory cap I promised a truce partner, which these orders go over (armies moved off are taken to leave).
      const capOver = territoryCapOverruns(binding, {
        mine,
        armiesOf: (t) => board.territories.find((x) => x.territoryId === t)?.armies ?? 0,
        deploys,
        moves,
      });
      const warnings = [
        // The owner, 2026-11-17: while an older build stands in for a client this server cannot read, say so first.
        ...[standInLine(standInOf(ctx))].filter((w): w is string => w !== undefined),
        ...intel.warnings,
        ...capOver.map(
          (c) =>
            `These orders leave ${c.armies} on ${name(c.territory).name} (#${c.territory}), above the cap of ${c.max} you agreed with player ${c.player}${c.agreement ? ` (agreement ${c.agreement})` : ''}: deploy or move less there, or record the cap lifted (caps_remove) once the partner agrees.`,
        ),
        ...(avoidedHits.length
          ? [`These orders attack ${avoidedHits.map((t) => name(t)).join(', ')}, which you asked to avoid (avoid_territories / avoid_players).`]
          : []),
        ...(allyHits.length
          ? [
              `These orders attack a Diplomacy 2 ally — ${allyHits.map((a) => allyAttackLine(a, (t) => name(t).name)).join('; ')}: ` +
                'the game skips each such attack and its armies sit idle this turn (warapp_submit_turn refuses it unless attack_ally is true).',
            ]
          : []),
        ...(modRead ? modAllianceWarnings(modRead) : []),
        // #275 (b): an untrusted estimate is the first thing said (not under an explicit enemy_deploy).
        ...(enemy_deploy === undefined ? tripwireWarnings(trip.tripwires, (w) => untrustedOf.get(w.player) ?? untrustedDeploy(w, income), (p) => estimates.find((x) => x.playerId === p)?.estimate) : []),
        ...(award ? assumedWarning(award) : []),
        // #270: the static seats whose territories the test read as neutrals.
        ...[...seatTerritories(award?.board ?? seen, seats)]
          .sort((a, b) => a[0] - b[0])
          .map(
            ([p, n]) =>
              `Player ${p} is out (${seats.get(p)}) and no AI plays its seat: its ${n} territor${n === 1 ? 'y was' : 'ies were'} tried as neutrals, and it makes no reply.`,
          ),
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
        ...sanction.warnings,
        ...played.warnings,
        // #505: orders that delay the nearest bonus say by how many turns (advice only).
        ...[bonusDelayWarning(belowPlan?.bonusDelay)].filter((w): w is string => w !== undefined),
        ...effect.unsure,
        ...[claimedCardWarning(claimedCardUses(uses, claimed))].filter((w): w is string => w !== undefined),
        ...unsimulatedCards,
        // #332: in a commerce game a smaller deploy saves gold, so only a larger one is worth a line.
        ...(deployed !== sanction.income && !(so.commerce && deployed < sanction.income)
          ? [
              `The orders deploy ${deployed} and your income is ${sanction.income}: the test used the orders as given (a Reinforcement card adds to the income; otherwise war.app refuses a wrong total).`,
            ]
          : []),
      ];
      const atRiskList = <T>(rows: readonly T[]) => rows.slice(0, LIST_MAX);

      // Scale: a large game (more than LARGE_GAME_OPPONENTS opponents) lists only the opponents near my land and
      // sums the rest in `scale`; every other game is unchanged.
      const scope = opponentScope(graph, seen, me.id, opponents.map((o) => o.id));
      const inScope = (p: number) => !scope.large || scope.near.includes(p);
      return respond(view, VIEWS, (rung) => ({
        ...(scope.large
          ? {
              scale: {
                opponents: scope.near.length + scope.far.length,
                near: scope.near.length,
                far: farSummary(scope.far, (p) => opponents.find((o) => o.id === p)?.deploy),
              },
            }
          : {}),
        game: { id: game.id, name: game.name ?? null, turn },
        player: { id: me.id, name: me.name },
        safe: report.safe,
        // B2 T6: with a truce in force, the verdict over the replies that break none (absent with no truce).
        ...(report.safeIfTruceHolds !== undefined
          ? {
              safeIfTruceHolds: report.safeIfTruceHolds,
              truces: binding.map((r) => ({
                player: who(r.player),
                ...(r.agreement ? { agreement: r.agreement } : {}),
                ...(r.card ? { card: r.card } : {}),
                ...(r.enforced ? { enforced: true, ...(r.enforcedUntil !== undefined ? { enforcedUntil: r.enforcedUntil } : {}), verified: false } : {}),
                state: r.state,
                covered: r.coveredMine.length,
              })),
            }
          : {}),
        summary,
        // Partner-approved truce exceptions on this turn: normal targets (mine), or open to the partner (theirs).
        ...(binding.some((r) => r.exceptions?.length)
          ? {
              relations: binding
                .filter((r) => r.exceptions?.length)
                .map((r) => ({
                  player: who(r.player),
                  ...(r.agreement ? { agreement: r.agreement } : {}),
                  exceptions: r.exceptions!.map((e) => ({ direction: e.direction, territories: e.territories.map(name) })),
                })),
            }
          : {}),
        exact: report.exact,
        // Where the teams came from (GameFeed, else the game list), in a team game only.
        ...(teamSource !== 'none' ? { teamSource } : {}),
        firstMover: first_mover ?? 'unknown',
        // #166: what the award of picks showed, the move order it implies included (absent with no pick list kept).
        ...(award ? { award: awardView(award, game, turn, name) } : {}),
        orderPriority,
        // #277: what I may deploy this turn, after any Sanctions on me (as warapp_plan_turn reports it).
        income: sanction.income,
        // Owner request 2026-11-24: the Sanctions these orders play, with the income they change next turn.
        ...(played.entries.length ? { sanctionsPlayed: played.entries } : {}),
        deployed,
        warnings,
        // #386: the intel warapp_record_intel kept and what this check did with it (absent when none is kept).
        ...(intel.report ? { intel: intel.report } : {}),
        // Only an opponent with a stack in view can be given a reply; the others are named apart.
        enemyDeploy: opponents
          .filter((o) => inView.has(o.id))
          .map((o) => ({
            player: { id: o.id, name: playerName.get(o.id) ?? String(o.id) },
            deploy: o.deploy,
            source: enemy_deploy !== undefined ? 'enemy_deploy' : knownOf.has(o.id) ? 'known_income' : untrustedOf.has(o.id) ? 'untrusted' : 'estimate',
            // The Reinforcement card the clock says it may hold, apart: in `deploy` under assume_enemy_cards "clock" only.
            ...(o.cardBonus !== undefined && enemy_deploy === undefined
              ? { cardBonus: o.cardBonus, ...(o.cardBonusBasis !== undefined ? { cardBonusBasis: o.cardBonusBasis } : {}) }
              : {}),
            // Sanctions on it: its estimate's income before and after the cut (the card left out).
            ...(o.sanctioned?.applied && o.sanctioned.after !== undefined
              ? { sanctionApplied: { player: o.id, percentage: sanctionPercentage(o.sanctioned.percentages), before: o.sanctioned.before, after: o.sanctioned.after } }
              : {}),
          })),
        // Whether the replies carry the card the clock adds (default "clock").
        assumeEnemyCards: assumeCards,
        // #180: in a free-for-all, whether you lead (any two opponents are then tried together).
        leader,
        unseenOpponents: opponents.filter((o) => !inView.has(o.id) && inScope(o.id)).map((o) => ({ id: o.id, name: playerName.get(o.id) ?? String(o.id) })),
        ...(scope.large ? { unseenOpponentsMore: opponents.filter((o) => !inView.has(o.id) && !inScope(o.id)).length } : {}),
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
        // #274: my commander (only when it is on the board): where it ends up, the armies there and what holds it.
        ...(guard
          ? {
              commander: {
                text: commanderLine!,
                territory: name(guard.territory),
                armies: guard.armies,
                needs: guard.needs,
                replies: guard.killers,
                distance: guard.distance,
                // The deploy the worst reply was sized at: as warapp_submit_turn sizes it.
                replyDeploy: checked!.replyDeploy,
                sizing: COMMANDER_SIZING,
                // A Blockade or Gift of its territory, which the check does not simulate (the submit refuses it).
                ...(checked!.cards ? { cards: checked!.cards } : {}),
                // Part 5: against unknown opponents the fog may hide within two moves, striking together.
                ...(fogged
                  ? {
                      fogged: {
                        text: foggedCommanderText(fogged),
                        safe: fogged.safe,
                        needs: fogged.needs,
                        armies: fogged.armies,
                        attackers: fogged.attackers,
                        from: fogged.from.map((f) => ({ territory: name(f.territory), ...(f.via !== undefined ? { via: name(f.via) } : {}), armies: f.armies })),
                        stack: fogged.stack,
                        deploy: fogged.deploy,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        jointFalls: report.jointFalls.slice(0, LIST_MAX).map(jointView),
        ...(report.jointFalls.length > LIST_MAX ? { jointFallsMore: report.jointFalls.length - LIST_MAX } : {}),
        // #275 (a): each border's headroom, the weakest first (compact: the first few).
        headroom: headroomView(headroom, map, income, rung === 'full', !teamsKnown, (p) => estimates.find((e) => e.playerId === p)?.estimate),
        ...(rung !== 'full' && headroom.length > HEADROOM_COMPACT ? { headroomMore: headroom.length - HEADROOM_COMPACT } : {}),
        // #275 pattern 3: absent when the default plan could not be made.
        ...(belowPlan
          ? {
              belowPlan: belowPlan.rows
                .slice(0, LIST_MAX)
                .map((r) => ({ territory: name(r.territory), planLeaves: r.planLeaves, left: r.left, short: r.short })),
              ...(belowPlan.rows.length > LIST_MAX ? { belowPlanMore: belowPlan.rows.length - LIST_MAX } : {}),
              belowPlanAgainst: belowPlan.against,
              ...(belowPlan.bonusDelay
                ? {
                    bonusDelay: {
                      bonus: belowPlan.bonusDelay.bonus,
                      bonusId: belowPlan.bonusDelay.bonusId,
                      dropped: belowPlan.bonusDelay.dropped.map((t) => name(t)),
                      plannedTurn: belowPlan.bonusDelay.plannedTurn,
                      givenTurn: belowPlan.bonusDelay.givenTurn,
                    },
                  }
                : {}),
              ...(rung === 'full' ? { belowPlanBasis: BELOW_PLAN_BASIS } : {}),
            }
          : {}),
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

/** #274: my commander in one sentence, by id: how many replies kill it and the armies that hold. */
export function commanderText(c: CommanderSafety, replies: number): string {
  const where = `Your commander on territory ${c.territory}`;
  if (c.lostUnanswered) return `${where} is lost to your own orders, with nobody answering.`;
  if (replies === 0) return `${where} survives every reply tried (${c.armies} armies there after your orders).`;
  const hold =
    c.needs === null
      ? 'no number of armies there holds it against all of them'
      : `it needs ${c.needs} armies there (${c.armies} after your orders) to survive every one`;
  return `${where} falls to ${replies} of the replies tried (${COMMANDER_SIZING}, as warapp_submit_turn sizes them): ${hold}.`;
}
