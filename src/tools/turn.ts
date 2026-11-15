// Turn tools: plan a turn from the live board (read-only), and — gated on the
// user's confirmation — submit one. The plan's `orders` array is the exact
// input shape of warapp_submit_turn.
import { CONFIRM_INJECTION_RULE, McpToolError, toolAnnotations, type EnvSource } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CARD_BLOCKADE,
  CARD_ORDER_DELAY,
  CARD_ORDER_PRIORITY,
  holdsOrderPriority,
  playsOrderPriority,
  advisedOrderPriority,
  CARD_REINFORCEMENT,
  cardRules,
  cardTypeByName,
  cardTypeName,
  chooseCardPlays,
  normalizeGuid,
  cardsToShed,
  handReadable,
  isMyCard,
  readHand,
  reinforcementArmies,
  type Card,
  type CardRules,
} from '../cards.js';
import {
  chargeDeploys,
  DEFAULT_OFFENSIVE_KILL_RATE,
  deployPools,
  expectedKills,
  specialUnitStrength,
  winChance,
  incomeFor,
  deployCheckUncertainties,
  overrideUncertainties,
  neighborsOf,
  planTurn,
  planEnemyEstimates,
  repulsedAttacks,
  borderGuess,
  guessSeed,
  AHEAD_PRESSURE_FACTOR,
  PRESSURE_FACTOR,
  symmetricStart,
  unevenStart,
  trackGame,
  trackOpponents,
  type MyOrders,
  type TurnBoard,
  type PlanGoal,
  type PlannerSettings,
  type PlanGameContext,
  type MapGraph,
  type OpponentTrack,
  type PlanRelation,
  type PlanInput,
} from '../analysis/index.js';
import { parseGameId } from '../client.js';
import { COMMANDER_STRENGTH, type CombatSettings, luckFraction, straightKills } from '../analysis/combat.js';
import { guardOffExposure } from '../analysis/guard-off.js';
import { boardStateFromLive, inGameId, playersByInGameId, type LiveTerritory } from '../live.js';
import { checkMoveOptions, MOVE_MODES, type MoveMode } from './order-options.js';
import type { Game, GameMap, GameSettings, Player } from '../normalize.js';
import {
  AttackTransferMode,
  Method,
  UNVERIFIED_CARD_PLAYS,
  writeSendOrdersParams,
  type CardPlayKind,
  type TurnOrder,
} from '../protocol/methods.js';
import { SERVER_ERROR_MESSAGES, type WarappServerError } from '../protocol/rpc.js';
import { assumedWarning, awardView, firstMoverFor, loadAward, openingThreat } from './award.js';
import { boardCardsInEffect, CARDS_IN_EFFECT_UNVERIFIED, sanctionMyIncome } from './card-effects.js';
import type { SureDiplomacy } from '../analysis/cards-in-effect.js';
import { adviseCards, cardGame, cardPieceOption, handOwners, opponentCanHold, opponentReinforcement, TEAM_HAND } from './card-advice.js';
import {
  currentTurn,
  gameIdArg,
  graphOf,
  namer,
  readAnnotations,
  respond,
  shownAccount,
  UNTRUSTED_PREVIEW_NOTE,
  untrustedDescription,
  untrustedText,
  viewArg,
} from './common.js';
import { lookupMeta, mintMeta } from './hints.js';
import { chatSummary } from './chat.js';
import { failureText, loadLiveGame, requireApprovedAccount, writeAccount, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { guessOrdersOf, guessView } from './guess-view.js';
import { guessSalt } from '../guess-salt.js';
import { mapOf } from './map.js';
import { defineGatedWrite, requireMySeat, sendAndVerify } from './write-kit.js';
import { resolveBonus, resolveTerritory } from './resolve.js';
import {
  checkCardFields,
  newCardPlaySeen,
  resolveCardTargets,
  type CardPlayContext,
  type CardPlayer,
  type CardTargetInput,
  type CardTargets,
} from './card-plays.js';
import {
  boardFromHistory,
  CACHED_TURNS,
  readBoardHistory,
  readCachedOrders,
  readExpectedIncome,
  writeBoardCache,
  writeOrdersCache,
  type TrendSource,
} from '../trend.js';
import { writeGameRecord } from '../replay.js';
import { gameOutlook } from '../analysis/outlook.js';
import { cardArmyCeiling } from '../strategy/card-clock.js';
import { sinceLastTurn, type SinceLast } from '../analysis/since-last.js';
import { recordOutlook } from '../outlook-log.js';
import { readPickRecord } from '../pick-list.js';
import type { BoardState } from '../board.js';
import { commitmentWarnings } from '../analysis/commitments.js';
import { planRelationsFrom, truceBreaksIn, type TacitTruce, type TruceBreak } from '../analysis/relations.js';
import { recordBrokenByMe } from './relations.js';
import { withTeammateOrders } from '../team-orders.js';
import { teamCardClaims, teamCardRoles, teamHandLeft } from '../team-cards.js';
import { isTeamGame, teammatesOf } from '../teams.js';
import { readLedger, recordTruceUsage } from '../relations-store.js';
import { resolveTeams, resolveTeamsFor } from './team-source.js';

const VIEWS = ['compact', 'full'] as const;
const GOALS = ['balanced', 'expand', 'complete-bonus', 'defend'] as const satisfies readonly PlanGoal[];
/** The only GameFeed state in which turns are played. */
const TURN_PHASE_STATE = 'Playing';
const MAX_ORDERS = 500;
const MAX_FOCUS = 50;
const MAX_ENEMY_DEPLOY = 10_000;
/** PLAN-TEAMS C3.3: what `team.sharedBonuses` means, on every plan that has it. */
const TEAM_SHARED_NOTE =
  'One owner per bonus: a bonus pays only the player holding all of it, so the plan never works toward one with a ' +
  "teammate's territory in it. `nearer` is whoever holds the most members ('even' when tied), read from the board at " +
  "the start of the turn; `others` counts the members neither of us holds, a teammate's territory in the fog among them " +
  '(team vision unverified). Advisory: ' +
  'agree in team chat which of you takes each.';

/** PLAN-TEAMS C3.5: what `team.support` means. */
const TEAM_SUPPORT_NOTE =
  "A teammate's border that falls to the threats in view (the plan's own threat model) given the orders they have " +
  "entered — their deploys there in, their orders out of it out, armies moved in left out — where your idle armies beside it " +
  '(what the plan leaves unused beyond what holds your own territory) would make it hold. Advisory: what a plain move ' +
  "onto a teammate's territory does is not yet verified live (V7), so it is never in `orders`, and the teammate's orders " +
  'come from the live board, also unverified (V5). The same idle armies may be counted by a joint capture too.';
/** PLAN-TEAMS C3.6: what `team.jointCaptures` means. */
const TEAM_JOINT_NOTE =
  "A target neither your teammate's entered attack nor yours takes alone, resolved on the turn simulator from those " +
  "attacks only (every other order of the turn left out): yours are the plan's own when it attacks it (`inPlan`), else " +
  'your idle armies beside it. `cases` gives both orders of the two attacks and whether it falls (and to whom), also if ' +
  "its owner first lands its whole deploy estimate there; under a cyclic move order `mustGoFirst` says whose attack must " +
  "run first ('either' when both orders take it). Advisory: never added to `orders`; agree it in team chat. The teammate's " +
  'orders come from the live board (unverified, V5).';
/** PLAN-TEAMS C3.7: what `cards.team` means. */
const TEAM_CARDS_NOTE =
  "Who plays each card of the team hand this turn: a teammate for a card they have already entered a play or discard " +
  "of (so the team never uses one card twice; the plan chooses from the rest), you for a card your orders play or " +
  'discard, nobody for a card held. Read from their entered orders on the live board (unverified, V5); how war.app keys ' +
  "a team's hand is unverified too (V8).";

const territoryRef = z.union([z.string(), z.number()]);
const playerRef = z.union([z.string().min(1).max(100), z.number()]);
const armiesArg = z.coerce.number().int().min(1);

/** One order of a turn: territories by id or name. */
const turnOrderArg = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('deploy'),
    territory: territoryRef.describe('Territory to deploy on: id or name.'),
    armies: armiesArg.describe('Armies to deploy there.'),
  }),
  z.object({
    kind: z.literal('move'),
    from: territoryRef.describe('Territory the armies leave: id or name.'),
    to: territoryRef.describe('Adjacent territory to attack or transfer into: id or name.'),
    armies: z.coerce
      .number()
      .int()
      .min(0)
      .describe('Armies to send (0 only with `commander`: the commander alone). With `percent`, the percentage 1–100.'),
    mode: z
      .enum(MOVE_MODES)
      .optional()
      .describe(
        'Default "attack-transfer": attacks or transfers by who holds the target when the order runs. "transfer-only" ' +
          '(game setting AllowTransferOnly): does nothing if the target is not yours then — a reinforcement that ' +
          'stays home when the target fell. "attack-only" (AllowAttackOnly): does nothing if the target is yours — e.g. a ' +
          'late order onto your own threatened territory that fires only if it fell.',
      ),
    percent: z
      .boolean()
      .optional()
      .describe(
        '(AllowPercentageAttacks) `armies` is a percentage of what `from` can move when the order runs, so what stays ' +
          'behind scales with the damage taken.',
      ),
    commander: z.boolean().optional().describe('(Commanders games) Take your commander on `from` along.'),
    attack_teammates: z
      .boolean()
      .optional()
      .describe("(Team games) Attack the target even if it is a teammate's, instead of transferring into it."),
  }),
  z.object({
    kind: z.literal('card'),
    card: z
      .string()
      .min(1)
      .max(64)
      .describe('Card to play from your hand: its id (GUID) or its type name, e.g. "Reinforcement".'),
    target: territoryRef
      .optional()
      .describe(
        'Blockade, Emergency Blockade: your territory to blockade. Bomb: a territory next to yours, not yours or a ' +
          "teammate's. Gift: your territory to give away. Reconnaissance: the territory to see. Id or name.",
      ),
    player: playerRef
      .optional()
      .describe(
        "Spy: the opponent to see (0 or \"neutral\": the neutral, when the game's Spy card allows it). Sanctions: the player whose " +
          'income it cuts. Gift: who receives `target`. Id or name.',
      ),
    players: z
      .array(playerRef)
      .length(2)
      .optional()
      .describe('Diplomacy: the two players who may not attack each other (usually you and one opponent). Ids or names.'),
    bonus: territoryRef.optional().describe('Surveillance: the bonus to see (id or name).'),
    from: territoryRef.optional().describe('Airlift: your territory the armies leave (id or name).'),
    to: territoryRef.optional().describe("Airlift: your or a teammate's territory they land on (id or name), anywhere on the map."),
    armies: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Airlift: armies to send (at most what stands on `from` after the deploys; 0 only with `commander`: the commander alone).'),
    commander: z
      .boolean()
      .optional()
      .describe('Airlift (Commanders games): take your commander on `from` too — only to a territory of your own.'),
    before: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        'Order Delay only: the move (1-based, counting the moves of this list in order) the card is written above, ' +
          'so that move and the ones after it wait for the opponents — e.g. `cards.advice.orderDelay.order` from ' +
          'warapp_plan_turn. UNVERIFIED live. Omit (or one past the last move) to write it after every move.',
      ),
  }),
  z.object({
    kind: z.literal('discard'),
    card: z
      .string()
      .min(1)
      .max(64)
      .describe('Card to discard from your hand (any type): its id (GUID) or its type name, e.g. "Order Delay".'),
  }),
]);

/** A whole turn's orders, as warapp_plan_turn returns them and warapp_submit_turn takes them. */
/** Orders for a turn; empty commits a turn with no orders (valid only when the income to deploy is 0). */
export const turnOrdersArg = z.array(turnOrderArg).max(MAX_ORDERS);

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
  if (s.bonusArmyPer !== undefined && s.bonusArmyPer > 0) out.bonusArmyPer = s.bonusArmyPer;
  if (s.minimumArmyBonus !== undefined) out.baseIncome = s.minimumArmyBonus;
  if (s.localDeployments) out.localDeployments = true;
  if (s.noSplit) out.noSplit = true;
  if (s.armyCap !== undefined && s.armyCap !== null && s.armyCap > 0) out.armyCap = s.armyCap;
  if (s.wastelands && s.wastelands.count > 0) out.wastelands = { ...s.wastelands };
  // AllowTransferOnly is deliberately not mapped: it toggles the per-order
  // "transfer only" mode, while every planned move is sent as AttackTransfer
  // (mode 3), which transfers between my own territories in any game. The
  // per-order options (#165) are the caller's to set on warapp_submit_turn.
  return out;
}

export { currentTurn, turnsCompleted } from './common.js';

/** My teammates' GameFeed ids (empty outside a team game; GameFeed's team field is unverified). */
export function friendsOf(players: readonly Player[], me: Player): Set<number> {
  return new Set(teammatesOf(players, me).map((p) => p.id));
}

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

/** Throw unless my seat is still `Playing` (#130): an eliminated, booted or surrendered seat has no turn. */
export function requirePlayingSeat(game: Game, me: Player): void {
  if (me.state === undefined || me.state === 'Playing') return;
  throw new McpToolError(`${untrustedText(me.name)} (${me.id}) is no longer playing in game ${game.id} (state: ${me.state}), so there is no turn to play.`, {
    hint: 'warapp_get_game shows each player\'s state.',
  });
}

/** What to say when cards are in play but my hand could not be read (#130). */
const UNREADABLE_HAND =
  'Your hand could not be read from the live board (no player entry for you), so the cards shown as none may be ' +
  'wrong: check the hand in the game — war.app refuses a commit while you hold more cards than the limit (error 51).';

interface NamedOrder {
  kind: 'deploy' | 'move' | 'card' | 'discard';
  card?: { id: string; name: string; armies?: number };
  target?: { id: number; name: string };
  /** A targeted card's player(s) (Spy, Sanctions, Gift; Diplomacy): GameFeed id and name. */
  player?: { id: number; name: string };
  players?: Array<{ id: number; name: string }>;
  /** Surveillance's bonus. */
  bonus?: { id: number; name: string };
  territory?: { id: number; name: string };
  from?: { id: number; name: string };
  to?: { id: number; name: string };
  armies?: number;
  /** An Order Delay written above this move (1-based, #186), only when placed among the moves. */
  before?: number;
  /** Move options (#165), only when set. */
  mode?: 'attack-only' | 'transfer-only';
  percent?: true;
  commander?: true;
  attackTeammates?: true;
}

/** A territory as a preview shows it: its map-maker name delimited. */
const shownPlace = (x: { id: number; name: string }) => ({ id: x.id, name: untrustedText(x.name) });

/** An order as the preview shows it: every territory name delimited. */
function shownOrder(o: NamedOrder): NamedOrder {
  const out: NamedOrder = { ...o };
  for (const k of ['target', 'territory', 'from', 'to', 'bonus', 'player'] as const) {
    const place = o[k];
    if (place) out[k] = shownPlace(place);
  }
  if (o.players) out.players = o.players.map(shownPlace);
  return out;
}

interface TurnState {
  gameId: number;
  /** My in-game id (the id orders carry). */
  playerId: number;
  /** My GameFeed id (to find me again in the re-read). */
  feedPlayerId: number;
  /** GameFeed `numberOfTurns` when the orders were prepared. */
  turnsBefore: number;
  turnNumber: number;
  orders: TurnOrder[];
  named: NamedOrder[];
  /** The income the deploys were checked against: modelled, or the caller's own `income`. */
  income: number;
  /** True when that income is the caller's `income` override, not the model. */
  incomeGiven?: boolean;
  /** How to read back an Order Delay placed among the moves (#186, unverified live), when one was. */
  orderDelayCheck?: string;
  /** How to read back a targeted card play (PLAN-TEAMS part D, unverified live, V9), when one was sent. */
  cardPlayCheck?: string;
  /** B2: the agreements these orders break (`break_agreement: true`), recorded broken-by-me once committed. */
  breaks?: string[];
}

/**
 * How to read back an Order Delay placed among the moves (#186) — a position no live commit has
 * used yet. Error 10 on the commit would mean it is not allowed there; accepted, the card leaves
 * the hand, and the turn's replay shows whether the moves after it ran after the opponents'.
 */
export function orderDelayCheck(at: readonly number[]): string {
  // Two cards above the same move are one position: name each once, in move order.
  const moves = [...new Set(at)].sort((a, b) => a - b);
  return (
    `The Order Delay${at.length > 1 ? 's were' : ' was'} placed above move${moves.length > 1 ? 's' : ''} ${moves.join(' and ')}, a position not yet verified live. war.app did not refuse it ` +
    'with error 10 (OrdersInIncorrectOrder). Once the turn resolves, check: the card is gone ' +
    "from your hand (warapp_plan_turn's `cards.hand`, or a played Order Delay in the turn's replay), and in the game's replay " +
    "of this turn your moves from that one on ran after the opponents' attacks instead of alternating with them. Report " +
    'what you see, so docs/WEB-PROTOCOL.md can mark the placement verified.'
  );
}

/** A targeted card play's targets as the preview and the result name them (names raw here; {@link shownOrder} delimits them). */
function namedTargets(t: CardTargets): Partial<NamedOrder> {
  const player = (p: CardPlayer) => ({ id: p.id, name: p.name });
  return {
    ...(t.territory ? { target: t.territory } : {}),
    ...(t.player ? { player: player(t.player) } : {}),
    ...(t.players ? { players: t.players.map(player) } : {}),
    ...(t.bonus ? { bonus: t.bonus } : {}),
    ...(t.from ? { from: t.from } : {}),
    ...(t.to ? { to: t.to } : {}),
    ...(t.armies !== undefined ? { armies: t.armies } : {}),
    ...(t.commander ? { commander: true as const } : {}),
  };
}

/** The preview's warning for a targeted card play (PLAN-TEAMS part D): its encoding is not verified live (V9). */
export function unverifiedCardWarning(cards: readonly string[]): string {
  return (
    `UNVERIFIED encoding: the ${cards.join(', ')} card play${cards.length > 1 ? 's are' : ' is'} written as the war.app client's ` +
    'own writer does (read from its code), but no commit carrying one has been sent yet. If war.app refuses the orders, nothing ' +
    'is committed: play the card in the game client instead and report the error.'
  );
}

/** How to read back a targeted card play (V9) once sent. */
export function cardPlayCheck(cards: readonly string[]): string {
  return (
    `The ${cards.join(', ')} card play${cards.length > 1 ? 's were' : ' was'} sent with an encoding not yet verified live, and war.app ` +
    "did not refuse it. Once the turn resolves, check that the card left your hand (warapp_plan_turn's `cards.hand`) and did what " +
    "it should in the turn's replay (a Gift's territory changed owner, an Airlift's armies moved, Diplomacy or Sanctions shows " +
    'among the cards in effect), and report what you see so docs/WEB-PROTOCOL.md can mark it verified.'
  );
}

/** war.app's error 10 on a turn with an Order Delay placed among the moves (#186): the position is refused. */
function orderDelayRefused(e: WarappServerError): McpToolError {
  return new McpToolError(
    `war.app refused the orders with error 10 (OrdersInIncorrectOrder): an Order Delay placed among the moves is not ` +
      `accepted there (${failureText(e)}). Nothing was committed.`,
    { hint: 'Resend without `before` on the Order Delay (it is then written after every move), or play the card in the game client.' },
  );
}

/**
 * war.app's error 11 (deploys ≠ its income), with a hint naming the modelled
 * number. The live board carries no income figure — war.app's client computes it
 * from the standing — so its own number is the "armies per turn" the game shows.
 */
function incomeRefused(e: WarappServerError, income: number, given = false): McpToolError {
  return new McpToolError(e.message, {
    kind: 'unknown',
    cause: e,
    hint:
      `The ${given ? 'income given was' : 'modelled income was'} ${income}, and war.app counts differently this turn. ` +
      'Nothing was committed: read the ' +
      '"armies per turn" the game shows (the deploy panel), deploy exactly that, and resend with it as `income` — ' +
      'the deploy-total check then uses that number instead of the model.',
  });
}

/** A territory in an error: its map-maker name delimited (errors are outside the untrusted envelope). */
const label = (t: { id: number; name: string }) => `${untrustedText(t.name)} (${t.id})`;

/** #165: with mods on, every plan says the rules it assumes may not hold. */
export function modsWarning(s: GameSettings | undefined): string[] {
  if (!s?.mods) return [];
  const what = s.mods > 0 ? `${s.mods} mod${s.mods === 1 ? '' : 's'}` : 'mods';
  return [
    `This game runs ${what}: a mod can change the rules (combat, income, orders, cards, special units), so the rules ` +
      'this plan assumes may not hold. Check the mods in the game settings.',
  ];
}

/**
 * #167: a commerce game pays gold and lets players buy armies and cities; the planner plans income as
 * armies only. Said whenever the feed's `Commerce` object carries settings (the shape a commerce
 * game sends is unverified: a plain game sends `{}`).
 */
export function commerceWarning(s: GameSettings | undefined): string[] {
  if (!s?.commerce) return [];
  return [
    'This looks like a commerce game (its Commerce settings are not empty): the plan models income as armies only — ' +
      'it does not model gold, buying armies or cities. Check what gold buys before following it.',
  ];
}

/**
 * #165: One Army Must Stand Guard off. My territories the orders leave at 0 beside an enemy or the
 * fog fall to any single army; an enemy territory at 0 beside me breaks its owner's bonus to a
 * one-army attack. Empty unless the guard is off.
 */
export function guardOffWarnings(
  graph: ReturnType<typeof graphOf>,
  map: GameMap,
  board: BoardState,
  me: number,
  friends: ReadonlySet<number>,
  settings: GameSettings | undefined,
  deploys: readonly { territoryId: number; armies: number }[],
  moves: readonly { from: number; to: number; armies: number }[],
): string[] {
  if (settings?.oneArmyStandsGuard !== false) return [];
  const r = guardOffExposure({ graph, board, me, friends, deploys, moves });
  const name = namer(map);
  const out: string[] = [];
  if (r.emptied.length) {
    out.push(
      `One Army Must Stand Guard is off: these orders leave ${r.emptied.map((id) => label(name(id))).join(', ')} at 0 armies ` +
        'beside an enemy or the fog, and any single army takes an empty territory. Keep an army there if it matters.',
    );
  }
  for (const b of r.breaks) {
    const bonus = map.bonuses.find((x) => x.id === b.bonusId);
    out.push(
      `One Army Must Stand Guard is off: ${label(name(b.territoryId))} stands at 0, so a one-army attack from ` +
        `${label(name(b.from))} takes it and breaks player ${b.playerId}'s bonus ${untrustedText(bonus?.name ?? String(b.bonusId))} ` +
        `(${b.bonusId}, +${b.value}). These orders do not attack it.`,
    );
  }
  return out;
}

/** plan_turn's note when its income counts Reinforcement plays: the deploys need the card orders (#85). */
function cardIncomeNote(income: number, cardArmies: number): string {
  return (
    `Income ${income} includes ${cardArmies} armies from the Reinforcement card play in \`orders\` (${income - cardArmies} ` +
    `from the board): submit the card order with the deploys, or deploy ${income - cardArmies} without it — ` +
    'warapp_submit_turn refuses any other total.'
  );
}

/**
 * When the surplus deployed is what unplayed Reinforcement cards would add, say so: the total
 * counts a card the orders do not play — warapp_plan_turn's income includes the armies of the
 * Reinforcement plays in its `orders`, so dropping those orders leaves the deploys too high (#85).
 */
function unplayedHint(surplus: number, unplayed: ReadonlyArray<{ id: string; armies: number }>): string {
  if (surplus <= 0 || !unplayed.length) return '';
  const all = unplayed.reduce((s, c) => s + c.armies, 0);
  const one = unplayed.find((c) => c.armies === surplus);
  const cards = one ? [one] : all === surplus ? unplayed : [];
  if (!cards.length) return '';
  const what = cards.map((c) => `Reinforcement card ${c.id} (${c.armies} armies)`).join(', ');
  return (
    ` The extra ${surplus} match the ${what}, which these orders have not played: add ` +
    `${cards.length === 1 ? 'its card order' : 'their card orders'} (as warapp_plan_turn's \`orders\` do) or deploy ${surplus} fewer.`
  );
}

/**
 * Validate resolved orders against the live board and income; throws a clear
 * refusal on the first problem. A deploy total that differs from the income is
 * refused only when the income model is certain: with `incomeUncertain` reasons
 * (see `deployCheckUncertainties`) it is returned as a warning instead, and war.app
 * itself has the last word (error 11). The Local Deployment check is likewise a
 * warning when `poolsUncertain` gives reasons (overridden bonuses, see
 * `overrideUncertainties`).
 */
export function validateTurn(args: {
  map: GameMap;
  board: readonly LiveTerritory[];
  myInGameId: number;
  income: number;
  guard: boolean;
  deploys: Array<{ territory: { id: number; name: string }; armies: number }>;
  /** `percent`: `armies` is a percentage of what can move when it runs (#165), never more than there is. */
  moves: Array<{ from: { id: number; name: string }; to: { id: number; name: string }; armies: number; percent?: boolean }>;
  /** Local Deployment: each held bonus's armies must be deployed inside that bonus. */
  localDeployments?: boolean;
  /** No-Split: each territory issues at most one attack or transfer. */
  noSplit?: boolean;
  /**
   * Multi-Attack: armies that move into a territory (a capture or a transfer) may move on from it
   * later in the same list (#130). A source not mine at the start of the turn is accepted when
   * an earlier move targets it. Each move out is checked, in list order, against the source's
   * armies, its deploys and every army moved in earlier in the list (so an attack, a transfer in
   * and another attack from one territory is fine) — an upper bound, since an attack's survivors
   * are fewer than the armies sent. Deploys still need a territory held at
   * the start of the turn: they land before any attack.
   */
  multiAttack?: boolean;
  /** Why the modelled income may be wrong; non-empty makes the deploy-total check a warning. */
  incomeUncertain?: readonly string[];
  /** Why the Local Deployment pools may be wrong (overridden bonuses); non-empty makes that check a warning. */
  poolsUncertain?: readonly string[];
  /**
   * Reinforcement cards in my hand these orders do not play, with their armies: a deploy total
   * that counts them (as warapp_plan_turn's income does when it plays them) is refused with a
   * hint naming the missing card play (#85).
   */
  unplayedReinforcements?: ReadonlyArray<{ id: string; armies: number }>;
  /**
   * Airlift card plays (PLAN-TEAMS part D): they run after the deploys and before the moves, so the
   * armies they send leave their source before its moves; landing, they cannot move again that turn.
   */
  airlifts?: ReadonlyArray<{ from: number; to: number; armies: number }>;
}): { warnings: string[] } {
  const warnings: string[] = [];
  const { map, board, myInGameId, income, deploys, moves } = args;
  const graph = graphOf(map);
  const standing = new Map(board.map((t) => [t.territoryId, t]));
  const mine = (id: number) => {
    const t = standing.get(id);
    return t !== undefined && !t.fogged && t.owner === myInGameId;
  };
  // Under Multi-Attack a territory not mine at the start may move on once a move earlier in the list went in.
  const chained = new Set<number>();
  if (args.multiAttack) {
    const reached = new Set<number>();
    const movedOut = new Set<number>();
    for (const m of moves) {
      if (!mine(m.from.id) && !movedOut.has(m.from.id) && reached.has(m.from.id)) chained.add(m.from.id);
      movedOut.add(m.from.id);
      reached.add(m.to.id);
    }
  }
  // Deploys land before any attack, so only a move's source may be a territory captured earlier in the list.
  const notMine = [
    ...deploys.map((d) => d.territory).filter((t) => !mine(t.id)),
    ...moves.map((m) => m.from).filter((t) => !mine(t.id) && !chained.has(t.id)),
  ];
  if (notMine.length) {
    const unique = [...new Map(notMine.map((t) => [t.id, t])).values()];
    throw new McpToolError(`These territories are not yours at the start of this turn: ${unique.map(label).join(', ')}.`, {
      hint: 'Deploy on, and move from, only territories you hold on the live board (warapp_get_live_board).',
    });
  }
  const pairs = new Set<string>();
  for (const m of moves) {
    if (!neighborsOf(graph, m.from.id).includes(m.to.id)) {
      throw new McpToolError(`${label(m.from)} does not border ${label(m.to)}.`, {
        hint: 'A move goes to an adjacent territory; reach further over several turns.',
      });
    }
    const key = `${m.from.id}>${m.to.id}`;
    if (pairs.has(key)) {
      throw new McpToolError(`The move ${label(m.from)} → ${label(m.to)} is listed twice.`, {
        hint: 'Combine them into one move with the total armies.',
      });
    }
    pairs.add(key);
  }
  if (args.noSplit) {
    const bySource = new Map<number, { from: { id: number; name: string }; to: Array<{ id: number; name: string }> }>();
    for (const m of moves) {
      const o = bySource.get(m.from.id) ?? { from: m.from, to: [] };
      o.to.push(m.to);
      bySource.set(m.from.id, o);
    }
    const split = [...bySource.values()].find((o) => o.to.length > 1);
    if (split) {
      throw new McpToolError(
        `No-Split: ${label(split.from)} issues ${split.to.length} attacks/transfers (to ${split.to.map(label).join(', ')}), ` +
          'but this game allows one per territory.',
        {
          hint:
            'This game uses No-Split: send at most one attack or transfer from each territory each turn; keep the ' +
            'best one and drop the others — it moves the whole stack.',
        },
      );
    }
  }
  const deployed = deploys.reduce((s, d) => s + d.armies, 0);
  if (deployed !== income && args.incomeUncertain?.length) {
    warnings.push(
      `These orders deploy ${deployed} armies, but the modelled income is ${income} this turn. The model may be off ` +
        `(${args.incomeUncertain.join(' ')}), so they are not refused here: check the "armies per turn" the game ` +
        'shows — war.app refuses any other total (error 11).',
    );
  } else if (deployed !== income) {
    throw new McpToolError(`These orders deploy ${deployed} armies, but your income is ${income} this turn.`, {
      hint: `Deploy exactly ${income} armies — war.app refuses any other total (error 11).${unplayedHint(
        deployed - income,
        args.unplayedReinforcements ?? [],
      )}`,
    });
  }
  const deployedOn = new Map<number, number>();
  for (const d of deploys) deployedOn.set(d.territory.id, (deployedOn.get(d.territory.id) ?? 0) + d.armies);
  // What can move from a territory when the moves start: its armies and deploys, less what it airlifts out.
  // Armies airlifted in cannot move again that turn (the wiki's Airlift Card), so they add nothing.
  const airlifted = new Map<number, number>();
  for (const a of args.airlifts ?? []) airlifted.set(a.from, (airlifted.get(a.from) ?? 0) - a.armies);
  const atMoves = (id: number) => (standing.get(id)?.armies ?? 0) + (deployedOn.get(id) ?? 0) + (airlifted.get(id) ?? 0);
  if (args.localDeployments) {
    const held = new Set(board.filter((t) => mine(t.territoryId)).map((t) => t.territoryId));
    const pools = deployPools(graph, held, income);
    const use = chargeDeploys(pools, deployedOn);
    if (use.anywhereUsed > pools.anywhere) {
      const short = pools.bonuses
        .map((p) => ({ p, used: use.used.get(p.bonusId) ?? 0 }))
        .filter(({ p, used }) => used < p.value);
      // The refusal names each bonus (delimited); the preview warning, which sits beside
      // the confirmToken, names bonuses by id only.
      const shortfall = (named: boolean) =>
        short
          .map(({ p, used }) => `${named ? `${untrustedText(p.name)} ` : ''}(bonus ${p.bonusId}): +${p.value} earned, only ${used} deployed inside it`)
          .join('; ');
      const overspend =
        `Local Deployment: these orders deploy ${use.anywhereUsed} armies outside the held bonuses' own pools, but only ` +
        `${pools.anywhere} may go anywhere this turn (${use.anywhereUsed - pools.anywhere} too many).`;
      const problem = `${overspend} ${shortfall(true)}.`;
      if (args.poolsUncertain?.length) {
        warnings.push(
          `${overspend} ${shortfall(false)}. The modelled pools may be off (${args.poolsUncertain.join(' ')}), so they are not refused here: ` +
            "check the game's deploy panel — war.app refuses deploys outside a bonus's own pool.",
        );
      } else {
        throw new McpToolError(problem, {
          hint:
            "This game uses Local Deployment: deploy each held bonus's armies on that bonus's own territories; only " +
            'the rest of your income (base income and card armies) may go anywhere.',
        });
      }
    }
  }
  // Walk the moves in order: each source's total sent so far against its armies, its deploys and,
  // under Multi-Attack, every army moved in earlier in the list (an attack, a transfer in, then
  // another attack is fine). Without Multi-Attack, armies moved in do not move on this turn.
  const sent = new Map<number, number>();
  const inflow = new Map<number, number>();
  let over: { from: { id: number; name: string }; armies: number; max: number } | undefined;
  for (const m of moves) {
    const start = chained.has(m.from.id) ? 0 : atMoves(m.from.id);
    const max = start + (inflow.get(m.from.id) ?? 0) - (args.guard ? 1 : 0);
    // A percentage order takes a share of what is left when it runs: it never over-sends, and what
    // it moves on is at most what the source could move (#165).
    const moved = m.percent ? Math.max(0, max - (sent.get(m.from.id) ?? 0)) : m.armies;
    if (!m.percent) {
      const armies = (sent.get(m.from.id) ?? 0) + m.armies;
      sent.set(m.from.id, armies);
      if (armies > max && !over) over = { from: m.from, armies, max };
    }
    if (args.multiAttack) inflow.set(m.to.id, (inflow.get(m.to.id) ?? 0) + moved);
  }
  if (over) {
    const { from, armies, max } = over;
    throw new McpToolError(
      `These orders send ${armies} armies from ${label(from)}, which can send at most ${max} this turn` +
        `${args.guard ? ' (one army stands guard)' : ''}` +
        `${airlifted.has(from.id) ? ', counting this turn\'s Airlift' : ''}` +
        `${inflow.has(from.id) ? '; that counts every army moved in earlier in the list, an upper bound: an attack\'s survivors are fewer' : ''}.`,
      { hint: 'A territory sends at most its armies plus what is deployed there this turn.' },
    );
  }
  // No-Split moves the whole stack (#124: the wiki, and a live turn that left every source at 0):
  // an order for fewer armies still sends them all, so say what will actually move. A source captured
  // earlier in the list (Multi-Attack) is left out: the armies standing there at the start were the
  // defenders', and what moves on is the capture's survivors, which this cannot size.
  if (args.noSplit) {
    for (const m of moves) {
      if (chained.has(m.from.id)) continue;
      const max = atMoves(m.from.id) - (args.guard ? 1 : 0);
      if (m.percent ? m.armies < 100 : m.armies < max)
        warnings.push(
          `No-Split: ${label(m.from)} → ${label(m.to)} sends ${m.percent ? `${m.armies}%` : m.armies}, but this game moves the whole stack: war.app ` +
            `sends all ${max} (its armies plus this turn's deploys there, less the guard), and nothing stays behind to hold ` +
            `${label(m.from)}. Size the order for the whole stack, or move nothing from it.`,
        );
    }
  }
  return { warnings };
}

/** One attack in the submit preview, sized against the defenders standing there now (#130). */
interface AttackSize {
  from: { id: number; name: string };
  to: { id: number; name: string };
  armies: number;
  /** Visible armies on the target at the start of the turn, a commander counted as {@link COMMANDER_STRENGTH}. */
  defenders: number;
  /**
   * The luck-free kills of this attack's own armies at the game's offensive kill rate — with
   * {@link combined} too, each leg sized alone beside its {@link facing}, never the legs as one stack.
   */
  expectedKills: number;
  /**
   * The exact chance of capturing them (kill rates, luck, rounding); deploys there this turn are not
   * counted. With {@link combined}, the chance that the attacks capture run in the order listed,
   * each against what the earlier ones leave (#250): exact at 0% luck under straight rounding, else
   * an approximation at the expectation (each failed attack kills its expected share; the attacks'
   * own chances taken as independent).
   */
  winChance: number;
  /** Set when several moves attack this target this turn: how many, and their armies together. */
  combined?: { attacks: number; armies: number };
  /** With {@link combined}: the defenders this attack meets once the earlier attacks on the target have run (#250). */
  facing?: number;
  /** With {@link combined}: an attack before the one that captures, which only wears the target down (#250). */
  softener?: true;
  /** The attack, or with {@link combined} the attacks in the order listed, cannot capture. */
  cannotCapture?: true;
  /** A percentage order (#165): its percentage; `armies` is then what it would send on the board as it stands. */
  percent?: number;
  /** My commander goes along (#165): sized as {@link COMMANDER_STRENGTH} more attackers, an approximation. */
  commander?: true;
}

/** A move as {@link attackSizes} reads it, with its options (#165). */
interface SizedMove {
  from: { id: number; name: string };
  to: { id: number; name: string };
  armies: number;
  mode?: MoveMode;
  /** `armies` is a percentage; {@link estimate} is what it would send now. */
  percent?: boolean;
  estimate?: number;
  commander?: boolean;
  attackTeammates?: boolean;
}

/**
 * Each move into a territory that is not mine and is visible, sized against what stands there
 * now: a transfer (to my own or a teammate's territory) and a fogged target are left out. Several
 * moves into one target (a multi-source capture, #17) are judged in the order listed, each against
 * what the earlier ones leave (#250), as the planner's `multiSourceCaptures` are built: a softener
 * that fails by design is not flagged when a later leg captures. Taken as one stack they could
 * read wrong either way: 6, 8 and 18 into 7 at 20% kill 1 + 2 + 4 = 7 in turn, but round(6.4) = 6
 * together.
 */
export function attackSizes(
  board: readonly LiveTerritory[],
  myInGameId: number,
  moves: ReadonlyArray<SizedMove>,
  settings: PlannerSettings,
  teammates: ReadonlySet<number> = new Set(),
): AttackSize[] {
  const standing = new Map(board.map((t) => [t.territoryId, t]));
  const off = settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  // A Transfer Only order never attacks; one that attacks teammates attacks a teammate's territory (#165).
  const attacks = moves.filter((m) => {
    const t = standing.get(m.to.id);
    return (
      m.mode !== 'transfer-only' &&
      t !== undefined &&
      !t.fogged &&
      t.owner !== myInGameId &&
      (m.attackTeammates === true || !teammates.has(t.owner))
    );
  });
  /** Its attackers as they fight: a percentage order's estimate, my commander as 7 more. */
  const power = (m: SizedMove) => (m.percent ? (m.estimate ?? 0) : m.armies) + (m.commander ? COMMANDER_STRENGTH : 0);
  const together = new Map<number, { attacks: number; armies: number }>();
  for (const m of attacks) {
    const g = together.get(m.to.id) ?? { attacks: 0, armies: 0 };
    g.attacks += 1;
    g.armies += power(m);
    together.set(m.to.id, g);
  }
  const combat = {
    ...(settings.offensiveKillRate !== undefined ? { offensiveKillRate: settings.offensiveKillRate } : {}),
    ...(settings.defensiveKillRate !== undefined ? { defensiveKillRate: settings.defensiveKillRate } : {}),
    ...(settings.luckModifier !== undefined ? { luck: settings.luckModifier } : {}),
    ...(settings.roundingMode !== undefined ? { rounding: settings.roundingMode } : {}),
  };
  const sequences = new Map<number, Sequence>();
  for (const id of together.keys()) {
    if (together.get(id)!.attacks < 2) continue;
    const t = standing.get(id)!;
    sequences.set(
      id,
      attackSequence(
        t.armies ?? 0,
        specialUnitStrength(t.specialUnits),
        attacks.filter((m) => m.to.id === id).map(power),
        combat,
      ),
    );
  }
  const seen = new Map<number, number>();
  return attacks.map((m) => {
    const t = standing.get(m.to.id)!;
    const group = together.get(m.to.id)!;
    const defenders = (t.armies ?? 0) + specialUnitStrength(t.specialUnits);
    const sequence = sequences.get(m.to.id);
    const at = seen.get(m.to.id) ?? 0;
    seen.set(m.to.id, at + 1);
    const chance = sequence ? sequence.chance : winChance(power(m), defenders, combat);
    return {
      from: m.from,
      to: m.to,
      armies: m.percent ? (m.estimate ?? 0) : m.armies,
      ...(m.percent ? { percent: m.armies } : {}),
      ...(m.commander ? { commander: true as const } : {}),
      defenders,
      expectedKills: Math.round(expectedKills(power(m), off) * 10) / 10,
      winChance: Math.round(chance * 1000) / 1000,
      ...(group.attacks > 1 ? { combined: { ...group } } : {}),
      ...(sequence ? { facing: sequence.facing[at]! } : {}),
      ...(sequence && sequence.captor !== undefined && at < sequence.captor ? { softener: true as const } : {}),
      ...(chance === 0 ? { cannotCapture: true as const } : {}),
    };
  });
}

/**
 * The submit preview's warning for attacks that cannot capture, or `undefined` when none: a lone
 * attack as before, and attacks on one target together, run in the order listed (#250) — only
 * when even the last of them fails against what the earlier ones leave.
 */
export function hopelessAttackWarning(
  attacks: readonly AttackSize[],
  label: (place: { id: number; name: string }) => string,
): string | undefined {
  const hopeless = attacks.filter((a) => a.cannotCapture);
  if (!hopeless.length) return undefined;
  const lone = hopeless.filter((a) => !a.combined);
  const parts: string[] = [];
  if (lone.length)
    parts.push(
      `${lone.map((a) => `${label(a.from)} → ${label(a.to)}`).join(', ')}: ${lone.length === 1 ? 'this attack' : 'these attacks'} ` +
        "cannot capture against the armies there now at this game's kill rates (see `attacks`).",
    );
  const targets = [...new Set(hopeless.filter((a) => a.combined).map((a) => a.to.id))];
  for (const id of targets) {
    const legs = hopeless.filter((a) => a.combined && a.to.id === id);
    const to = legs[0]!.to;
    parts.push(
      `${legs.map((a) => `${label(a.from)} (${a.armies})`).join(', then ')} → ${label(to)}: run in the order listed, each ` +
        `against what the earlier ones leave (the first ones only wear it down), these ${legs.length} attacks ` +
        `cannot capture the ${legs[0]!.defenders} there now at this game's kill rates (see \`attacks\`: \`facing\`).`,
    );
  }
  return parts.join(' ');
}

/** Attacks on one target run in the order listed (#250). */
interface Sequence {
  /** The chance that one of them captures (with luck, up to the likely captor only: an approximation). */
  chance: number;
  /** The defenders each attack meets (rounded at the expectation); 0 after the captor, a transfer then. */
  facing: number[];
  /** The first attack expected to capture (exact: the one that does; with luck, chance ≥ 0.5); absent when none is. */
  captor?: number;
}

/**
 * Attacks of `powers` armies into `armies` defenders (plus special units fighting as `units`)
 * run one after another: a failed attack kills its share — every defender's army before a
 * commander's strength, which falls only whole — and an attack that wipes out both sides leaves
 * one defender (`turn-sim`'s rule). Exact at 0% luck under straight rounding, as the planner's
 * combined captures (rule 3a) are; otherwise each failed attack kills its expected share and the
 * chance is 1 − Π(1 − each attack's chance against what it meets) over the attacks up to the first
 * one likely to capture (chance ≥ 0.5). The figure is an approximation, not a bound either way: the
 * attacks after the likely captor are left out (what they would meet were it to fail is unknown),
 * which errs low, while each later leg's chance is taken against the expected survivors of the
 * earlier legs — though those legs count only when they fail, and a failed attack kills less than
 * its expected share — which errs high. At the expectation the target is mine after the captor and
 * the later attacks are transfers (facing 0), as in an exact run.
 */
function attackSequence(armies: number, units: number, powers: readonly number[], combat: CombatSettings): Sequence {
  const off = combat.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const exact = luckFraction(combat.luck) === 0 && combat.rounding !== 'WeightedRandom';
  let left = armies;
  let strength = units;
  let miss = 1;
  let captor: number | undefined;
  const facing: number[] = [];
  for (const [i, a] of powers.entries()) {
    const meets = Math.round(left) + strength;
    facing.push(meets);
    const chance = winChance(a, meets, combat);
    miss *= 1 - chance;
    if (exact ? chance === 1 : chance >= 0.5) {
      captor = i;
      break;
    }
    const kills = exact ? straightKills(a, off) : expectedKills(a, off);
    if (kills >= left + strength) {
      // It killed them all yet failed, so both sides were wiped out: one defender stands again.
      left = 1;
      strength = 0;
    } else if (kills >= left) left = 0;
    else left -= kills;
  }
  // After the captor the target is mine (at the expectation, with luck): the later moves are transfers.
  while (facing.length < powers.length) facing.push(0);
  const chance = exact ? (captor !== undefined ? 1 : 0) : 1 - miss;
  return { chance, facing, ...(captor !== undefined ? { captor } : {}) };
}

/** The card types warapp_submit_turn can play, by the encoder's name. */
const PLAYABLE: Readonly<Record<number, CardPlayKind>> = {
  [CARD_REINFORCEMENT]: 'Reinforcement',
  [CARD_ORDER_PRIORITY]: 'OrderPriority',
  [CARD_ORDER_DELAY]: 'OrderDelay',
  [CARD_BLOCKADE]: 'Blockade',
  // PLAN-TEAMS part D: encoded from the bundle's writers, UNVERIFIED live (V9).
  2: 'Spy',
  6: 'Airlift',
  7: 'Gift',
  8: 'Diplomacy',
  9: 'Sanctions',
  10: 'Reconnaissance',
  11: 'Surveillance',
  // Bomb (GameOrderPlayCardBomb) and Emergency Blockade (GameOrderPlayCardAbandon): bundle writers, UNVERIFIED live (V9).
  13: 'Bomb',
  3: 'EmergencyBlockade',
};

/** A card order as the tool takes it: the card and its targets (`card-plays.ts`). */
type CardInput = CardTargetInput & { card: string; before?: number | undefined };

/** A card play resolved against the hand. */
interface ResolvedCardPlay {
  card: Card;
  kind: CardPlayKind;
  /** Its targets as given, resolved against the live board by {@link resolveCardTargets}. */
  input: CardTargetInput;
  /** Blockade's territory (the targeted cards' are in {@link targets}). */
  target?: { id: number; name: string };
  /** The targeted cards' resolved targets (PLAN-TEAMS part D). */
  targets?: CardTargets;
  /** Armies it adds to this turn's deploys (Reinforcement). */
  armies: number;
  /** Order Delay only (#186): the move (1-based) it is written above, as given. */
  before?: number;
}

const handHint = (hand: readonly Card[], ids: boolean) =>
  `Your hand: ${hand.length ? hand.map((c) => (ids ? `${c.name} (${c.id})` : c.name)).join(', ') : 'no cards'}.`;

/**
 * Find one card of my hand by GUID or type name, skipping cards already `used`
 * (played or discarded) when matching by type; refuses a card not held and, by
 * GUID, one already used (`twice` names the clash).
 */
function findCard(hand: readonly Card[], ref: string, used: ReadonlySet<string>, twice: string): Card {
  const guid = normalizeGuid(ref.trim());
  if (guid !== undefined) {
    const card = hand.find((c) => c.id === guid);
    if (!card) throw new McpToolError(`Card ${guid} is not in your hand.`, { hint: handHint(hand, true) });
    if (used.has(card.id)) {
      throw new McpToolError(`The ${card.name} card ${card.id} is ${twice}.`, {
        hint: 'Each card can be played or discarded once.',
      });
    }
    return card;
  }
  const type = cardTypeByName(ref);
  if (type === undefined) {
    throw new McpToolError(`No card type matches "${ref}".`, {
      hint: 'Name a card by its id (GUID) or its type, e.g. "Reinforcement" or "Order Priority".',
    });
  }
  const card = hand.find((c) => c.type === type && !used.has(c.id));
  if (!card) {
    throw new McpToolError(`You hold no ${cardTypeName(type)} card${hand.some((c) => c.type === type) ? ' left to use' : ''}.`, {
      hint: handHint(hand, false),
    });
  }
  return card;
}

/**
 * Resolve discards (by GUID or type name) against my hand, after the plays: any
 * card type may be discarded, but not one that is also played or discarded twice.
 */
function resolveDiscards(
  hand: readonly Card[],
  plays: readonly ResolvedCardPlay[],
  inputs: ReadonlyArray<{ card: string }>,
): Card[] {
  const used = new Set(plays.map((p) => p.card.id));
  const out: Card[] = [];
  for (const input of inputs) {
    const card = findCard(hand, input.card, used, 'used twice (played or discarded)');
    used.add(card.id);
    out.push(card);
  }
  return out;
}

/**
 * Resolve card plays (by GUID or type name) against my hand. Refuses a card not
 * held, the same card twice, a card this server cannot play, a Blockade with no
 * target, a target on any other card, and a Reinforcement whose armies are unknown.
 */
function resolveCardPlays(
  map: GameMap,
  hand: readonly Card[],
  rules: CardRules,
  inputs: readonly CardInput[],
): ResolvedCardPlay[] {
  const used = new Set<string>();
  const out: ResolvedCardPlay[] = [];
  for (const input of inputs) {
    const card = findCard(hand, input.card, used, 'played twice');
    used.add(card.id);
    const kind = PLAYABLE[card.type];
    if (!kind) {
      throw new McpToolError(`Playing a ${card.name} card is not supported here yet.`, {
        hint: 'Play it in the game itself; this tool plays only the built-in cards.',
      });
    }
    const { card: _card, before: _before, ...targets } = input;
    const hasTarget = input.target !== undefined && String(input.target).trim() !== '';
    if (kind === 'Blockade' && !hasTarget) {
      throw new McpToolError('A Blockade needs a `target`: the territory of yours to blockade.', {
        hint: 'A Blockade turns your territory neutral with multiplied armies — it gives the territory away.',
      });
    }
    checkCardFields(kind, card.name, targets);
    if (input.before !== undefined && kind !== 'OrderDelay') {
      throw new McpToolError(`Only an Order Delay takes \`before\`, not a ${card.name} card.`, {
        hint: '`before` places an Order Delay among the moves; other card plays run in their own phase.',
      });
    }
    let armies = 0;
    if (kind === 'Reinforcement') {
      const a = reinforcementArmies(card, rules);
      if (a === undefined) {
        throw new McpToolError(`The armies Reinforcement card ${card.id} adds are unknown, so the deploy total cannot be checked.`, {
          hint: 'Play it in the game itself.',
        });
      }
      armies = a;
    }
    const play: ResolvedCardPlay = { card, kind, input: targets, armies, ...(input.before !== undefined ? { before: input.before } : {}) };
    if (kind === 'Blockade') {
      const t = resolveTerritory(map, input.target!);
      play.target = { id: t.id, name: t.name };
    }
    out.push(play);
  }
  return out;
}

/**
 * The team's gathered hand is over the limit while mine is not (#163): a warning, not a refusal,
 * because how war.app keys a team's hand is unverified — a wrong guess must not block a valid turn.
 */
function teamHandOver(held: number, rules: CardRules, shed: number, given: number): string {
  return (
    `The team's hand as read (your cards and your teammates') holds ${held} cards; the limit is ${rules.maxCardsHold}, ` +
    `so ${shed} card${shed === 1 ? '' : 's'} may need to be played or discarded; these orders use ${given}. How war.app keys ` +
    "a team's hand is not yet verified, so this is not refused: check the hand in the game — war.app refuses the commit " +
    '(error 51) if the team is over the limit.'
  );
}

/** Cards these orders use that were read only under a teammate's id (V8, #163): a warning, never a refusal. */
export function teammateCardWarning(cards: readonly Card[]): string {
  return (
    `${cards.map((c) => `${c.name} ${c.id}`).join(', ')} ${cards.length === 1 ? 'was' : 'were'} read under a teammate, not under you. ` +
    "A team shares one hand, but whether you can play or discard a card held under a teammate is not yet verified: war.app " +
    'refusing it (e.g. error 50, CardInstanceUnavailable) means only that teammate can.'
  );
}

/** The required-play refusal (war.app's error 51, `MustUseCard`), raised before anything is sent. */
function mustPlayCard(hand: readonly Card[], rules: CardRules, shed: number, given: number): McpToolError {
  return new McpToolError(
    `${SERVER_ERROR_MESSAGES[51]} (You hold ${hand.length}; the limit is ${rules.maxCardsHold}, so ${shed} card${
      shed === 1 ? '' : 's'
    } must be played or discarded; these orders use ${given}.)`,
    {
      hint: `Add card plays or discards, e.g. { "kind": "discard", "card": "${hand[0]?.name ?? 'Order Delay'}" } (warapp_plan_turn suggests which). ${handHint(
        hand,
        true,
      )}`,
    },
  );
}

const cardView = (c: Card) => ({ id: c.id, name: c.name, ...(c.armies !== undefined ? { armies: c.armies } : {}) });

/** The deploys and moves of a sent turn, as opponent tracking reads my orders (#119); card plays left out. */
export function myOrdersOf(orders: readonly TurnOrder[]): MyOrders {
  return {
    deploys: orders.flatMap((o) => (o.kind === 'deploy' ? [{ territoryId: o.territoryId, armies: o.armies }] : [])),
    // Left out (#165): a percentage order's count is a percentage, not armies, and a Transfer Only
    // or Attack Only order may not happen at all (it runs only if the target's owner suits it).
    moves: orders.flatMap((o) =>
      o.kind === 'move' && !o.byPercent && (o.mode === undefined || o.mode === AttackTransferMode.AttackTransfer)
        ? [{ from: o.from, to: o.to, armies: o.armies }]
        : [],
    ),
    sent: orders.flatMap((o) =>
      o.kind === 'move' ? [{ from: o.from, to: o.to, ...(o.mode === AttackTransferMode.Transfer ? { transferOnly: true as const } : {}) }] : [],
    ),
  };
}

/** Earlier turns that, when all cached, make the GameFeed history read unnecessary. */
const TREND_TURNS = 2;

/** My earlier boards of a game and the previous turn's board, as {@link boardHistory} reads them. */
export interface BoardHistory {
  /** My views of turns before the one being played, oldest first (the cache, else GameFeed history). */
  boards: TurnBoard[];
  /** Turn − 1's board and where it came from, for the planner's threat trend. */
  previous?: { source: TrendSource; board: BoardState };
}

/**
 * My earlier boards of a game, best effort: for each of the last {@link CACHED_TURNS} turns
 * before `turn`, the board this server cached when it planned or tracked that turn (a verified
 * live board), else GameFeed's `GetHistory` standing when the feed sends one (unverified for
 * games in progress). History is read only for turns the cache lacks, and not at all when the
 * last {@link TREND_TURNS} turns are cached. Each carries the deploys and moves
 * `warapp_submit_turn` sent that turn, when it sent them (#119). Empty otherwise; never throws.
 */
export async function boardHistory(ctx: LiveContext, game: Game, me: Player, turn: number | null): Promise<BoardHistory> {
  if (turn === null || turn < 2) return { boards: [] };
  const byTurn = new Map<number, { source: TrendSource; board: BoardState }>();
  if (ctx.dataDir)
    for (const b of await readBoardHistory(ctx.dataDir, game.id, me.id, turn))
      if (b.turn >= turn - CACHED_TURNS) byTurn.set(b.turn, { source: 'cache', board: b.board });
  // The cached boards are the live boards this server planned on (verified); GameFeed's history
  // standing for a game in progress is unverified. So history only fills turns the cache lacks,
  // and is not fetched at all when the last {@link TREND_TURNS} turns are cached: the threat trend
  // and tracked incomes (#94) need two earlier turns, not just the previous one (#131).
  const recent = Array.from({ length: Math.min(TREND_TURNS, turn - 1) }, (_, i) => turn - 1 - i);
  if (!recent.every((k) => byTurn.has(k))) {
    try {
      const withHistory = await ctx.client.getGame(game.id, { history: true });
      // Turn k is played on the board after k − 1 completed turns.
      for (let k = Math.max(1, turn - CACHED_TURNS); k < turn; k++) {
        if (byTurn.has(k)) continue;
        const board = boardFromHistory(withHistory.history, k - 1, game.players);
        if (board) byTurn.set(k, { source: 'history', board });
      }
    } catch {
      // History is optional: the cache stands.
    }
  }
  // The orders this server sent on those turns (#119): measurements of what an opponent deployed.
  const orders = ctx.dataDir ? await readCachedOrders(ctx.dataDir, game.id, me.id) : new Map<number, MyOrders>();
  const boards = [...byTurn]
    .sort(([a], [b]) => a - b)
    .map(([t, b]): TurnBoard => {
      const o = orders.get(t);
      return { turn: t, board: b.board, ...(o ? { orders: o } : {}) };
    });
  const previous = byTurn.get(turn - 1);
  return { boards, ...(previous ? { previous } : {}) };
}

/**
 * The "since last turn" view (#194): one line comparing this turn's income with the next income
 * the previous turn's plan expected, and naming the bonuses broken and territories lost since the
 * previous board. `full` adds the figures and the lists by id and name beside the line.
 */
function sinceLastView(
  s: SinceLast,
  previousTurn: number,
  hasBoard: boolean,
  map: GameMap,
  players: readonly Player[],
  rung: string,
) {
  const name = namer(map);
  const bonus = (id: number) => map.bonuses.find((b) => b.id === id)?.name ?? String(id);
  const player = (id: number) => ({ id, name: players.find((p) => p.id === id)?.name ?? String(id) });
  const when = `when turn ${previousTurn} was planned`;
  const head =
    s.expected === null
      ? `Income ${s.income}; turn ${previousTurn} was not planned here.`
      : s.income < s.expected
        ? `Income ${s.income}, ${s.expected - s.income} below the ${s.expected} expected ${when}.`
        : s.income > s.expected
          ? `Income ${s.income}, ${s.income - s.expected} above the ${s.expected} expected ${when}.`
          : `Income ${s.income}, as expected ${when}.`;
  const broken = s.bonusesBroken ?? [];
  const lost = s.territoriesLost ?? [];
  const parts = [
    ...(broken.length
      ? [`${broken.length === 1 ? 'bonus' : 'bonuses'} broken — ${broken.map((b) => `${bonus(b.bonusId)} (+${b.value})`).join(', ')}`]
      : []),
    ...(lost.length
      ? [
          `lost ${lost
            .map((t) => `${name(t.territoryId).name} (#${t.territoryId})${t.to !== null ? ` to ${player(t.to).name}` : ''}`)
            .join(', ')}`,
        ]
      : []),
  ];
  const line = `${head} ${
    hasBoard ? `Since turn ${previousTurn}: ${parts.length ? parts.join('; ') : 'nothing lost'}.` : `No board of turn ${previousTurn} to compare.`
  }`;
  if (rung !== 'full') return line;
  return {
    income: s.income,
    expected: s.expected,
    expectedTurn: s.expectedTurn,
    shortfall: s.shortfall,
    ...(hasBoard
      ? {
          bonusesBroken: broken.map((b) => ({ id: b.bonusId, name: bonus(b.bonusId), value: b.value })),
          territoriesLost: lost.map((t) => ({ ...name(t.territoryId), to: t.to !== null ? player(t.to) : null })),
        }
      : {}),
    line,
  };
}

/** The agreements `breaks` names and the orders that break each, in a sentence (ids only). */
function breaksText(breaks: readonly TruceBreak[], moves: readonly { from: { id: number }; to: { id: number } }[]): string {
  const one = (b: TruceBreak) =>
    `agreement ${b.agreement} with player ${b.with} (${b.state === 'notice' ? 'in notice, still binding' : 'active'}): ` +
    b.moves.map((m) => `move ${m.index + 1} (${moves[m.index]!.from.id} → ${m.to}) attacks a territory it covers`).join(', ');
  return `These orders break ${breaks.length === 1 ? 'a truce' : `${breaks.length} truces`} — ${breaks.map(one).join('; ')}`;
}

/**
 * B4 (warapp_plan_turn): the commitments my chat messages made (the ledger's, warapp_send_chat) that the
 * plan's `moves` would break this turn. The planner never reads them, so the plan is unchanged; this only
 * says so. Empty with no data directory or ledger.
 */
async function promiseWarnings(
  ctx: LiveContext,
  a: { game: Game; me: Player; turn: number; graph: MapGraph; board: BoardState; moves: readonly { from: number; to: number; kind?: string }[] },
): Promise<string[]> {
  if (!ctx.dataDir) return [];
  const ledger = await readLedger(ctx.dataDir, a.game.id, a.me.id);
  if (!ledger?.commitments?.length) return [];
  return commitmentWarnings({
    commitments: ledger.commitments,
    agreements: ledger.agreements,
    graph: a.graph,
    board: a.board,
    me: a.me.id,
    turn: a.turn,
    moves: a.moves.map((m) => ({ from: m.from, to: m.to, ...(m.kind === 'transfer' ? { transferOnly: true } : {}) })),
  }).map(
    (w) =>
      `The plan does not read your chat promises: ${w.text}. Change those moves before warapp_submit_turn, or ask the ` +
      'owner and tell the player before breaking it — never silently.',
  );
}

/**
 * B2: the truces in force in `game` for `me` this turn — the agreement ledger (warapp_record_agreement)
 * resolved against my board history (`boards`, then `board` as this turn's) into the planner's relations,
 * and the tacit truces (reported, never planned on). `undefined` with no turn. Shared by
 * warapp_plan_turn and warapp_check_plan, so both read the same truces.
 */
export async function truceRelations(
  ctx: LiveContext,
  a: {
    game: Game;
    me: Player;
    turn: number | null;
    graph: MapGraph;
    board: BoardState;
    boards: readonly TurnBoard[];
    /** My income this turn, card armies out. */
    myIncome: number;
    tracks: readonly OpponentTrack[] | undefined;
    /** PLAN-TEAMS D3: the Diplomacy cards with me the decoder is sure of (`boardCardsInEffect`). */
    diplomacy?: readonly SureDiplomacy[];
  },
): Promise<{ relations: PlanRelation[]; tacit: TacitTruce[] } | undefined> {
  const { game, me, turn, graph, tracks } = a;
  if (turn === null) return undefined;
  const ledger = ctx.dataDir ? await readLedger(ctx.dataDir, game.id, me.id) : undefined;
  return planRelationsFrom({
    agreements: ledger?.agreements ?? [],
    graph,
    board: a.board,
    boards: [...a.boards, { turn, board: a.board }],
    me: me.id,
    turn,
    players: game.players.map((p) => ({
      id: p.id,
      ...(p.isAI ? { isAI: true } : {}),
      ...(p.humanTurnedIntoAI ? { humanTurnedIntoAI: true } : {}),
      ...(p.state !== undefined ? { state: p.state } : {}),
      ...(p.team !== undefined ? { team: p.team } : {}),
    })),
    incomes: {
      mine: a.myIncome,
      opponents: new Map(
        game.players
          .filter((p) => p.id !== me.id && (p.state ?? 'Playing') === 'Playing')
          .map((p) => {
            const t = tracks?.find((x) => x.playerId === p.id);
            return [p.id, t && t.firstSeen !== null ? (t.income ?? t.visibleIncome) : null] as const;
          }),
      ),
    },
    ...(a.diplomacy?.length ? { diplomacy: a.diplomacy } : {}),
  });
}


/** The arguments of a live plan (warapp_plan_turn's, by their planner names). */
export interface LivePlanArgs {
  goal?: PlanGoal;
  focusBonusIds?: number[];
  reserve?: number;
  enemyDeploy?: number;
  minWinChance?: number;
  firstMover?: 'me' | 'opponent';
}

/**
 * Everything warapp_plan_turn reads around the live board before it plans, and the planner input it
 * builds: shared with warapp_advise_diplomacy (B3), so a deal is priced on exactly the plan the turn
 * tool would make. Writes only what warapp_plan_turn's reads write (the award of picks on turn 1),
 * and not that with `award: false` — the award changes the plan only in a two-player game, so a
 * free-for-all caller skips it and writes nothing.
 */
export async function livePlanSetup(
  ctx: LiveContext,
  a: {
    game: Game;
    map: GameMap;
    me: Player;
    turn: number | null;
    territories: LiveTerritory[];
    info: unknown;
    history: BoardHistory;
    args?: LivePlanArgs;
    /** Read (and on turn 1 write) the award of picks; default true. */
    award?: boolean;
  },
) {
  const { game, map, me, turn, territories, info, history } = a;
  const { goal, focusBonusIds = [], reserve, enemyDeploy: enemy_deploy, minWinChance: min_win_chance, firstMover: first_mover } = a.args ?? {};
  const graph = graphOf(map);
  // The board as war.app shows it: what is tracked and cached. The plan is made on the board
  // the award of picks completes (#166): in a two-player game, the opponent's starts my own
  // pick list proves, where they are still fogged.
  const seen = withTeammateOrders(boardStateFromLive(territories, me, game.players), info, me, game.players);
  const award = a.award === false ? undefined : await loadAward(ctx.dataDir, game, me, seen, turn);
  const board = award?.board ?? seen;
  const opening = openingThreat(award, game, graph, seen, turn);
  // #127: who moves first — first_mover, else a turn kept for this game alternated, else the award.
  const mover = await firstMoverFor(ctx.dataDir, game, me, turn, first_mover, award);
  const settings = plannerSettings(game.settings);
  const rules = cardRules(game.settings);
  // A team shares one hand (#163): mine and my teammates' cards.
  const owners = handOwners(game, me);
  const hand = readHand(info, owners);
  const handUnknown = rules.inPlay.length > 0 && !handReadable(info, owners);
  const inGame = cardGame(game, me);
  // PLAN-TEAMS C3.7: a card my teammate has entered a play or discard of is theirs this turn, so my plan
  // chooses from the rest (their orders: V5; the team hand's keying: V8 — both unverified live).
  const { left: myHand, claimed: teamClaimed } = teamHandLeft(
    hand,
    inGame.team ? teamCardClaims(seen.teammateOrders, new Set(teammatesOf(game.players, me).map((p) => p.id))) : [],
  );
  // V8: of what is left, a card read under a teammate's id is not mine to play (unverified): chooseCardPlays
  // and the card advice play, discard and advise only my own, so no card is both claimed and advised to me.
  const cards = chooseCardPlays(myHand, rules, inGame);
  const myCards = myHand.filter((c) => isMyCard(c, inGame.me));
  // The board's income, card armies out: what the truces' trust reads (as warapp_check_plan passes it).
  const boardIncome = incomeFor(graph, board, me.id, game.settings);
  // PLAN-TEAMS D3: the cards in effect the decoder is sure of — Sanctions on me cut this turn's income,
  // a Diplomacy card with a player makes it no foe this turn (T9).
  const effect = boardCardsInEffect(game, me, turn, info);
  const sanction = sanctionMyIncome(boardIncome, effect, { localDeployments: settings.localDeployments === true });
  const income = sanction.income + cards.extraArmies;
  const trend = history.previous;
  const previousOrders = turn !== null ? history.boards.find((b) => b.turn === turn - 1)?.orders : undefined;
  // The opponents over my board history: one observed over 2+ turns gets its tracked income;
  // one still playing with nothing in view gets a received lower bound and a warning (#94).
  const tracks =
    turn !== null
      ? trackOpponents(graph, [...history.boards, { turn, board: seen }], me.id, settings, trackGame(game.players, game.settings, map))
      : undefined;
  // #240: territories my cached orders show failed attacks on, their owner reinforcing them each
  // time, on two or more of the last three turns: a further attack is sized for its owner's deploy.
  const repulsed = turn !== null ? repulsedAttacks(graph, [...history.boards, { turn, board: seen }], me.id, settings) : [];
  // #178: won, lost, even or stuck, from my boards over the last turns (a basis, not a verdict).
  // #201: the planner reads it too — a decided game shortens its payback horizon.
  const cardArmies = cardArmyCeiling(game.settings);
  const outlookInput = {
    graph,
    me: me.id,
    boards: [...history.boards, ...(turn !== null ? [{ turn, board: seen }] : [])],
    settings,
    game: trackGame(game.players, game.settings, map),
    cards: rules.inPlay.length > 0,
    // #205: what the card clock lets cards add, so a fogged card game can still be bounded.
    ...(cardArmies ? { cardArmies } : {}),
  };
  // The plan reads the outlook (#201: winning or losing only); #218 then feeds the outlook the
  // plan's main front, so its front forecast and the plan's front outlook are one computation.
  const outlook = gameOutlook(outlookInput);
  const picking = ctx.dataDir ? await readPickRecord(ctx.dataDir, game.id, me.id) : undefined;
  // Players still in the game besides me (a break is worth less when the bonus's loss is shared).
  const opponents = game.players.filter((p) => p.id !== me.id && (p.state ?? 'Playing') === 'Playing').length;
  const gameContext: PlanGameContext = {
    players: game.players.map((p) => ({
      id: p.id,
      ...(p.team !== undefined ? { team: p.team } : {}),
      ...(p.state !== undefined ? { state: p.state } : {}),
      ...(p.isAI ? { isAI: true } : {}),
      ...(p.humanTurnedIntoAI ? { humanTurnedIntoAI: true } : {}),
    })),
    ...(game.endRules?.aisSurrenderWhenOneHumanRemains !== undefined
      ? { endRules: { aisSurrenderWhenOneHumanRemains: game.endRules.aisSurrenderWhenOneHumanRemains } }
      : {}),
    turn,
    ...(game.settings?.fog !== undefined ? { fog: game.settings.fog } : {}),
    ...(game.settings?.commanders !== undefined ? { commanders: game.settings.commanders } : {}),
    // PLAN-TEAMS C3.6: a joint capture under a cyclic order says whose attack must run first.
    ...(isTeamGame(game.players) && game.settings?.moveOrder !== undefined ? { moveOrder: game.settings.moveOrder } : {}),
    cards: rules.inPlay.length > 0,
    // #119: a 1v1 that started even gets the fog prior (an opponent in the fog earns at least my income).
    symmetricStart: symmetricStart(game.settings),
    // #235: why not, when it was not (the plan says so in a free-for-all).
    ...(unevenStart(game.settings) ? { unevenStart: unevenStart(game.settings)! } : {}),
    // #166: the opponent's opening simulated from the starts the award proved, as the prior.
    ...(opening ? { opening } : {}),
    // #164: an opponent's Reinforcement card, from the turn the card clock says one can be in hand.
    ...(opponentReinforcement(game.settings, hand) ? { reinforcement: opponentReinforcement(game.settings, hand)! } : {}),
  };
  // B2: the truces in force, from the agreement ledger (warapp_record_agreement) and my board
  // history, and the tacit truces (reported, never planned on).
  const truces = await truceRelations(ctx, {
    game, me, turn, graph, board: seen, boards: history.boards, myIncome: boardIncome, tracks, diplomacy: effect.diplomacy,
  });
  const input: PlanInput = {
    graph,
    board,
    me: me.id,
    income,
    cardArmies: cards.extraArmies,
    ...(truces?.relations.length ? { relations: truces.relations } : {}),
    settings,
    ...(trend ? { previousBoard: trend.board } : {}),
    // #226: my orders on that turn, when this server sent them: a failed attack's kills count back.
    ...(trend && previousOrders ? { previousOrders } : {}),
    ...(repulsed.length ? { repulsed } : {}),
    ...(turn !== null ? { turn } : {}),
    game: gameContext,
    ...(tracks ? { tracks } : {}),
    options: {
      // No goal: the game profile picks it and tunes the plan (an explicit goal overrides it).
      adapt: true,
      outlook: { state: outlook.state, turns: outlook.turns },
      // #201: the picking board's neutrals, so a fogged one keeps its size (wastelands).
      ...(picking?.neutrals ? { rememberedNeutrals: new Map(picking.neutrals) } : {}),
      ...(goal !== undefined ? { goal } : {}),
      focusBonusIds,
      ...(opponents > 0 ? { opponents } : {}),
      holdsOrderPriority: holdsOrderPriority(myCards, cards),
      ...(playsOrderPriority(cards) ? { orderPriorityForced: true } : {}),
      ...(reserve !== undefined ? { reserve } : {}),
      ...(enemy_deploy !== undefined ? { enemyDeploy: enemy_deploy } : {}),
      ...(min_win_chance !== undefined ? { minWinChance: min_win_chance } : {}),
      // #127/#179: who moves first (firstMoverFor: first_mover, else the remembered turn, else the award).
      ...(mover.firstMover !== undefined ? { movesFirst: mover.firstMover === 'me' } : {}),
      // #215 review: from the award (unverified), the schedule and card advice use it, holds do not.
      ...(mover.firstMover !== undefined && !mover.verified ? { movesFirstUnverified: true } : {}),
      ...(opponentCanHold(game.settings, 'Order Priority', turn) ? { opponentsMayHoldOrderPriority: true } : {}),
      // #163: an opponent may hold a Bomb by now: holds are sized as if halved, two stacks over one.
      ...(opponentCanHold(game.settings, 'Bomb', turn) ? { opponentsMayHoldBomb: true } : {}),
      // #127: what a capture's card pieces are worth, for a plan that would capture nothing.
      ...cardPieceOption(game.settings, hand),
    },
  };
  return {
    graph, seen, award, board, opening, mover, settings, rules, owners, hand, myHand, myCards, teamClaimed, handUnknown, inGame, cards,
    boardIncome, income, trend, previousOrders, tracks, outlookInput, outlook, picking, opponents, gameContext, truces, input,
    effect, sanction,
  };
}

export function registerTurnTools(server: McpServer, ctx: LiveContext, opts: { env?: EnvSource } = {}): void {
  /**
   * B2: after `warapp_submit_turn` with `break_agreement`, mark the agreements its orders broke
   * broken-by-me — only once the orders are confirmed committed (`committed`); otherwise say how to
   * record it by hand. Never throws.
   */
  const recordBreaks = async (st: TurnState, committed: boolean) => {
    const ids = st.breaks ?? [];
    const notRecorded = (why: string) => ids.map((agreement) => ({ agreement, ledger: 'not-recorded' as const, why }));
    if (!committed)
      return notRecorded(
        'the orders are not confirmed committed: once warapp_get_game shows them in, record it with warapp_record_agreement (status broken-by-me)',
      );
    if (!ctx.dataDir) return notRecorded('this server keeps no data directory');
    try {
      const { game } = await resolveTeams(ctx, await ctx.client.getGame(st.gameId, { settings: true }));
      const me = game.players.find((p) => p.id === st.feedPlayerId);
      if (!me) return notRecorded('you are no longer listed in the game');
      return await recordBrokenByMe({ dir: ctx.dataDir, env: opts.env, game, me, map: mapOf(game), agreements: ids, turn: st.turnNumber });
    } catch (e) {
      return notRecorded(`re-reading the game failed (${failureText(e)}): record it with warapp_record_agreement (status broken-by-me)`);
    }
  };
  server.registerTool(
    'warapp_plan_turn',
    {
      title: 'Plan my turn in a war.app game',
      description: untrustedDescription(
        'Plan one turn for you in an in-progress war.app (Warzone) game from the live board, the map and the ' +
          "game's settings: your income, deploys and attacks/transfers by territory name and id (each attack with " +
          '`winChance`, its exact capture probability), the expected captures, completed bonuses and next income ' +
          '(with `nextIncomeIfConcededFall` and `bonusesAtRisk` when the plan concedes borders of a bonus you hold), ' +
          'the borders given up (`conceded`), the `frontier` budget, your cards (plays and discards when you must), ' +
          'warnings and the reasoning. Its `orders` array is exactly what warapp_submit_turn takes — review it with ' +
          'the user first. Every plan reads the game profile (`profile`: format 1v1/ffa/teams, phase, standing ' +
          'ahead/even/behind/unknown on income) and returns the `outlook` (winning/losing/even/stalemate from ' +
          'armies + 3 × income held over 3 turns of boards, with its `basis`; thresholds unmeasured, so advice, not a verdict; ' +
          'an opponent is bounded above by all it can have received (its start, or an even share of the map; each turn\'s most it could earn; ' +
          'a fixed Reinforcement card by the card clock) — a scenario\'s starts, a Gift card or a progressive Reinforcement card leave it unbounded, and then `winning` is never read; ' +
          'once winning or losing, payback tests count the turns the game has left instead of 10). With no `goal` the profile picks and tunes it (`goalSource` ' +
          '"profile"): defend when behind outside a 1v1, else balanced — in an FFA with two or more opponents, no ' +
          'second front; in a 1v1, one strike stack facing the opponent; ahead in a 1v1, fog pressure ' +
          `up to ${AHEAD_PRESSURE_FACTOR}× a typical neutral capture. Goals: "balanced" (default) — income per army ` +
          'across holds, bonuses and breaking enemy bonuses, at least 30% on expansion; "expand" — neutrals only; ' +
          '"complete-bonus" — also attacks players to finish bonuses; "defend" — threatened borders worth holding ' +
          'first. An opponent next to the fog may be pressured: each of its visible territories attacked, sized for ' +
          `its full deploy plus a margin, at most ${PRESSURE_FACTOR}× a typical neutral capture each — one visible ` +
          'territory too costly blocks the pressure on all of them. Threats assume each enemy deploys `enemy_deploy` (default per opponent: ' +
          'base income plus its visible bonuses, or its observed deploy when larger — its tracked income, carried across turns, once ' +
          'warapp_track_opponents has 2+ turns of it — and in an even-start 1v1 at least your income when it borders the fog; ' +
          'exact where the fog shows every owner (No, Light, Dense fog); plus its Reinforcement card from the turn the card clock says it can hold one; ' +
          'a neighbour whose armies the fog hides counts its unaccounted armies (at most two turns of its income), and a large stack that left view counts where it can reach, with a warning a turn ahead where it can stand beside a border next turn; ' +
          'growth beside the fog beyond twice what it was expected to deploy reads as a move out of the fog, not a deploy). Obeys the kill rates, luck, rounding, Local ' +
          'Deployment, No-Split (one order per territory, with its whole stack) and commanders; plays Reinforcement (in a team ' +
          "game only when cards must be shed, and only cards read under you: the hand is the team's), and Order Priority only when the plan advises it (a " +
          'withdrawal worth a card, a commander strike) or it is the card that must go (over the hold limit the cards worth ' +
          'least in this game leave first; the timing cards are kept longest); never Blockade, Order Delay, Bomb or Emergency ' +
          'Blockade — `cards.advice` says where those pay (Order Delay above the calm orders, a Bomb target or hold it, an ' +
          "Emergency Blockade wall; Diplomacy on the opponent pressing you hardest when two or more do, Sanctions on the leader, an Airlift onto a " +
          "border of yours or a teammate's that falls without it, a Gift that completes a teammate's bonus — each with an `order` to pass to " +
          "warapp_submit_turn, never added to the orders), and the warnings flag an opponent's Bomb or Emergency Blockade and the cards in effect. Moves are listed in the " +
          "order to send them (both players' orders interleave). The full rule list is in the planner's header and the warapp-mcp skill. " +
          'When this server kept your pick list (warapp_submit_picks or warapp_get_my_picks during distribution), ' +
          '`award` says what the award of picks showed: the territories of your list that are another player\'s ' +
          'start for certain (in a two-player game they are planned as the opponent\'s while still fogged, with the ' +
          'starting armies on turn 1), whether you were awarded first or second and who moves first this turn under ' +
          "a `Cycle` move order, and with commanders the opponent's first award when the award pins it. " +
          '`sinceLastTurn` is one line: this turn\'s income (cards aside) against the next income the previous ' +
          "turn's plan expected (kept per game, from a plan without `goal` or `enemy_deploy`: a what-if plan keeps no figure), " +
          'and the bonuses broken and territories lost since the previous board. ' +
          'In a free-for-all, `relations` reports each truce recorded with warapp_record_agreement as the plan treated it ' +
          '(no covered territory of the partner attacked while it is active or in notice; a covered border facing only ' +
          'the partner held against its stacks with no deploy, except your commander\'s, a valuable border, or while trust ' +
          'is watch; a border cap kept), `advice` says `give-notice` when the endgame or the partner outgrowing you made ' +
          'the trust watch, a truce the board shows broken is planned as an ordinary opponent, and `tacit` lists quiet ' +
          'borders with no agreement (a report, never a truce). The plan never reads what your chat promised ' +
          "(warapp_send_chat's `commitments`): a warning says when its moves would break one still in force. " +
          "In a team game a bonus with a teammate's territory in it is never planned toward (one owner per bonus), and " +
          '`team.sharedBonuses` lists each bonus you and a teammate both hold members of and who is `nearer` to holding it. ' +
          "With a teammate's entered orders on the live board (unverified live): an otherwise equal capture on the opponent they " +
          'attack goes first; `team.support` (their border your idle armies would make hold) and `team.jointCaptures` (a target ' +
          'neither takes alone) are advice, never in `orders`; `cards.team` says who plays each card, leaving theirs to them. ' +
          '`firstMover` is who the plan takes to move first this turn (null when unknown) and its `source`: ' +
          '"explicit" (`first_mover`), "award", or "remembered" — a turn this server kept, alternated (two players, ' +
          'cyclic order). ' +
          'When one opponent touches two or more of your borders and no fixed split of the deploys there holds them all, ' +
          '`guess` is a randomized split, weighted by what each border is worth, against an opponent who would read a fixed ' +
          'one, and `guessOrders` the plan\'s `orders` with that split — optional (the user chooses; `orders` stay the ' +
          "plan's), and a model: one opponent, one deploy, its visible stacks. " +
          `Refuses outside a turn phase. ${BRIDGE_NOTE} Read-only on war.app; it never submits orders.`,
      ),
      _meta: lookupMeta(['plan my turn', 'warzone turn plan', 'what should i deploy', 'suggest my orders']),
      annotations: readAnnotations('Plan a war.app turn'),
      inputSchema: z.object({
        game_id: gameIdArg,
        player: playerArg,
        goal: z
          .enum(GOALS)
          .optional()
          .describe(
            'Omit to let the game profile pick (defend when behind on income outside a 1v1, else balanced, tuned to the format). ' +
              'balanced (default): best income per army across holds, bonuses and breaking enemy bonuses; expand: take ' +
              'neutrals only; complete-bonus: also attack players to finish bonuses; defend: hold threatened borders first. ' +
              'A goal given here overrides the profile.',
          ),
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
        enemy_deploy: z.coerce
          .number()
          .int()
          .min(0)
          .max(MAX_ENEMY_DEPLOY)
          .optional()
          .describe(
            'Armies every enemy is assumed to deploy next turn when judging threats. Default, per opponent: base ' +
              'income plus every bonus it visibly holds, whatever its stack next to you (never below the base income), ' +
              'or what it was observed to deploy when larger, carried across turns (growth beside the fog beyond twice ' +
              'what it was expected to deploy reads as a move out of the fog, not a deploy). In an even-start 1v1 an opponent ' +
              'bordering the fog is assumed to earn at least your income. Income in the fog is unseen, so raise it if ' +
              'you know they earn more.',
          ),
        min_win_chance: z.coerce
          .number()
          .min(0.5)
          .max(1)
          .optional()
          .describe(
            'The least win chance each ordinary capture is sized for, 0.5–1. Default: 1 (certain: every roll and ' +
              'rounding takes it) with no luck, 0.95 with luck on. Below 1, each capture gets the fewest armies whose ' +
              'exact win chance (game kill rates, luck, rounding) reaches it — cheaper, but it can fail — and the ' +
              'captures a bonus still needs reach it together. Attacks sized for a worst case (finishing a player off, ' +
              'fog pressure, commander strikes) stay certain.',
          ),
        first_mover: z
          .enum(['me', 'opponent'])
          .optional()
          .describe(
            'Who moves first this turn, when you know (as warapp_check_plan takes it; Cycle and No-Luck Cycle move ' +
              'orders swap the first mover every turn: whoever moved second last turn moves first now). Give the ' +
              "cycle's order, not one an Order Priority or Order Delay card changed. When you move " +
              "first, your first order already runs before the opponent's, so Order Priority is not advised (unless the " +
              'opponent may hold one too and the order ends a player). In a ' +
              'two-player game under a cyclic order it is remembered and later turns default to it, alternated; ' +
              'omitted, the default is that, else the award of picks, else unknown (`firstMover` says which).',
          ),
        view: viewArg(
          VIEWS,
          'compact (default) gives the plan and orders (the profile as format, phase and standing); "full" adds each ' +
            'move\'s reason, the whole profile and the settings the plan assumed.',
        ),
      }),
    },
    async ({ game_id, player, goal, focus, reserve, enemy_deploy, min_win_chance, first_mover, view }) => {
      // The chat comes in the same GameFeed read: the fallback for the unread counts (part A1).
      const feed = await ctx.client.getGame(game_id, { settings: true, chat: true });
      requireTurnPhase(feed);
      const map = mapOf(feed);
      const focusBonusIds = (focus ?? []).map((b) => resolveBonus(map, b).id);
      const turn = currentTurn(feed);
      // My seat is checked before the board is read (#130): an eliminated or booted seat has no turn,
      // so nothing is read for it. Then the live board and the board history are independent reads:
      // in parallel, not in series (#131). History needed my seat anyway, so the board waiting for it
      // adds no step to the slowest chain (account, then history). Accepted trade-off of not
      // serializing them: when the board read fails, a history read already under way still reaches
      // GameFeed after the tool has returned (one wasted, harmless read; boardHistory never throws).
      const seat = await resolveMe(ctx, feed.players, player);
      requirePlayingSeat(feed, seat);
      // The teams: GameFeed's, else the game list's (asked once per game, kept).
      const { game, me, source: teamSource } = await resolveTeamsFor(ctx, feed, seat);
      const [{ territories, info }, history, chat] = await Promise.all([
        loadLiveGame(ctx, game),
        boardHistory(ctx, game, me, turn),
        // Unread chat per channel (counts only), so the agent reads chat before it submits.
        chatSummary(ctx, game),
      ]);
      const setup = await livePlanSetup(ctx, {
        game, map, me, turn, territories, info, history,
        args: {
          ...(goal !== undefined ? { goal } : {}),
          focusBonusIds,
          ...(reserve !== undefined ? { reserve } : {}),
          ...(enemy_deploy !== undefined ? { enemyDeploy: enemy_deploy } : {}),
          ...(min_win_chance !== undefined ? { minWinChance: min_win_chance } : {}),
          ...(first_mover !== undefined ? { firstMover: first_mover } : {}),
        },
      });
      const { graph, seen, award, board, mover, rules, hand, myHand, myCards, teamClaimed, handUnknown, inGame, cards, income, trend, previousOrders, tracks } = setup;
      const { settings, outlookInput, gameContext, truces, effect, sanction } = setup;
      let { outlook } = setup;
      const plan = planTurn(setup.input);
      // #228: and the plan's profile standing, so an `even` outlook beside `behind` says why they differ.
      // Neither changes whether the turn reads winning or losing (the state the plan acted on): losing
      // on the estimate reads the front on my boards' incomes, never the plan's (#228 review); only a
      // stalemate may follow the plan's front, which the planner ignores.
      if (turn !== null && (plan.front || plan.profile.standing === 'ahead' || plan.profile.standing === 'behind'))
        outlook = gameOutlook({
          ...outlookInput,
          ...(plan.front
            ? { front: { turn, from: plan.front.from, at: plan.front.at, myIncome: plan.front.myIncome, theirIncome: plan.front.theirIncome } }
            : {}),
          standing: plan.profile.standing,
        });
      // #194: since last turn — this turn's income (cards aside) against the next income the previous
      // turn's plan expected, and what was lost since the previous board. Read before this turn's write.
      const expectedNow =
        ctx.dataDir && turn !== null && turn >= 2 ? await readExpectedIncome(ctx.dataDir, game.id, me.id, turn - 1) : undefined;
      const since =
        turn !== null && turn >= 2 && (trend || expectedNow !== undefined)
          ? sinceLastTurn({
              graph,
              previous: trend?.board,
              current: seen,
              me: me.id,
              income: income - cards.extraArmies,
              expected: expectedNow,
              expectedTurn: turn - 1,
            })
          : undefined;
      // A what-if plan (an explicit goal or enemy_deploy) keeps the board but not its expected income:
      // next turn's "since last turn" compares with the plan the profile chose, not the last one asked for.
      const whatIf = goal !== undefined || enemy_deploy !== undefined;
      if (ctx.dataDir && turn !== null)
        await writeBoardCache(ctx.dataDir, game.id, me.id, turn, seen, whatIf ? undefined : plan.expected.nextIncome);
      if (ctx.dataDir && turn !== null) await writeGameRecord(ctx.dataDir, game);
      if (ctx.dataDir && turn !== null) await recordOutlook(ctx.dataDir, game.id, me.id, outlook);
      // B2: what each honoured truce freed this turn and what a break would have cost (T6), for "has it
      // been useful in play?" (not a what-if plan).
      const used = (plan.relations ?? []).filter((r) => r.honoured && r.agreement !== undefined);
      if (ctx.dataDir && turn !== null && !whatIf && used.length)
        await recordTruceUsage(
          ctx.dataDir,
          game.id,
          me.id,
          turn,
          used.map((r) => ({
            agreementId: r.agreement!,
            armiesFreed: r.armiesFreed,
            lossIfBroken: r.lossIfBroken ? r.lossIfBroken.armies : null,
            incomeLostIfBroken: r.lossIfBroken ? r.lossIfBroken.bonusValue : null,
          })),
        );
      const name = namer(map);
      /** Another player by id, its name delimited as untrusted text. */
      const playerRef = (id: number) => {
        const p = game.players.find((x) => x.id === id);
        return { id, name: p ? untrustedText(p.name) : null };
      };
      // #163: Order Delay's place, my Bomb and Emergency Blockade, the opponents' when they can hold one,
      // and the cards in effect; D2: my Diplomacy, Sanctions, Airlift and Gift. Advice only: the orders
      // below are the plan's (and the advised Order Delay).
      // D3: a relation that is only a Diplomacy card is no truce to the card advice (it reads the card itself).
      const inForce = (truces?.relations ?? []).filter((r) => (r.state === 'active' || r.state === 'notice') && !r.card);
      const advice = rules.inPlay.length
        ? adviseCards({
            game, me, turn, info, hand: myHand, choice: cards, plan, board, graph, settings, label: (id) => `${name(id).name} (#${id})`,
            truceCovered: new Set(inForce.flatMap((r) => r.coveredTheirs)),
            truces: inForce.map((r) => ({ player: r.player, state: r.state as 'active' | 'notice', coveredMine: r.coveredMine, ...(r.endsTurn !== undefined ? { endsTurn: r.endsTurn } : {}) })),
            ...(effect.diplomacy.length ? { enforced: new Set(effect.diplomacy.map((d) => d.player)) } : {}),
            ...(sanction.applied ? { sanctionsApplied: true } : {}),
          })
        : { view: {}, warnings: [] };
      // B4: the planner does not read what my chat messages promised (words change no estimate), so a
      // plan that breaks a commitment still in force says so here; warapp_submit_turn warns again.
      const promised = turn !== null ? await promiseWarnings(ctx, { game, me, turn, graph, board: seen, moves: plan.moves }) : [];
      const warnings = [
        ...(me.hasCommittedOrders
          ? [
              'You have already committed orders this turn; warapp_submit_turn will refuse until you withdraw them ' +
                'with warapp_uncommit_turn (or modify orders in the game).',
            ]
          : []),
        ...(award ? assumedWarning(award) : []),
        ...mover.warnings,
        ...(handUnknown ? [UNREADABLE_HAND] : []),
        ...(inGame.team && rules.inPlay.length ? [TEAM_HAND] : []),
        ...teamClaimed.map(
          (c) =>
            `${c.card.name} (${c.card.id}): player ${c.player} has already entered a ${c.kind} of it, so this plan leaves it to them ` +
            '(PLAN-TEAMS C3.7: read from their entered orders, unverified live).',
        ),
        ...cards.warnings,
        ...advice.warnings,
        ...(cards.extraArmies > 0 ? [cardIncomeNote(income, cards.extraArmies)] : []),
        ...sanction.warnings,
        ...effect.unsure,
        ...deployCheckUncertainties(game.settings, { sanctionsApplied: sanction.applied }).map((r) => `Income ${income} may be off: ${r}`),
        ...(tracks ?? []).flatMap((t) => t.warnings),
        ...plan.warnings,
        ...promised,
        ...modsWarning(game.settings),
        ...commerceWarning(game.settings),
        ...guardOffWarnings(graph, map, board, me.id, friendsOf(game.players, me), game.settings, plan.deploys, plan.moves),
      ];
      // The plan advises Order Priority (a withdrawal, a commander strike): play the one I
      // hold, so the orders as returned carry it rather than only the advice.
      const advised = plan.cardAdvice === 'order-priority' ? advisedOrderPriority(myCards, cards) : undefined;
      const plays = advised ? [...cards.plays, advised] : cards.plays;
      // #163: an Order Delay that had to go is played where the plan advises it, not discarded.
      const playedDelay = advice.view.orderDelay?.card;
      const orders = [
        ...cards.discards.filter((c) => c.id !== playedDelay).map((c) => ({ kind: 'discard' as const, card: c.id })),
        ...plays.map((c) => ({ kind: 'card' as const, card: c.id })),
        ...plan.deploys.map((d) => ({ kind: 'deploy' as const, territory: d.territoryId, armies: d.armies })),
        ...plan.moves.map((m) => ({ kind: 'move' as const, from: m.from, to: m.to, armies: m.armies })),
        // #186: the advised Order Delay, placed above its move (war.app accepted the placement live;
        // whether the later moves wait for the opponent's is not yet seen in a replay).
        ...(advice.view.orderDelay ? [advice.view.orderDelay.order] : []),
      ];
      // The border guess (docs/STRATEGY.md "Guessing at a border"): a randomized split of the deploys
      // the plan spends on one opponent's borders, when no fixed split holds them all. Optional: the
      // plan's own orders stay as they are; guessOrders carries the draw.
      const { estimates } = planEnemyEstimates({
        graph,
        board,
        me: me.id,
        income: income - cards.extraArmies,
        settings,
        ...(trend ? { previousBoard: trend.board } : {}),
        ...(trend && previousOrders ? { previousOrders } : {}),
        ...(tracks ? { tracks } : {}),
        game: gameContext,
        turn,
      });
      const guessed = borderGuess({
        graph,
        board,
        me: me.id,
        settings,
        plan,
        estimates,
        ...(enemy_deploy !== undefined ? { enemyDeploy: enemy_deploy } : {}),
        ...(gameContext.players ? { players: gameContext.players } : {}),
        seed: guessSeed(game.id, turn, await guessSalt(ctx.dataDir)),
      });
      const guess = guessed.kind === 'guess' ? guessed : undefined;
      const guessOrders = guess ? guessOrdersOf(orders, guess) : undefined;

      return respond(view, VIEWS, (rung) => ({
        game: { id: game.id, name: game.name ?? null, turn: currentTurn(game) },
        player: { id: me.id, name: me.name },
        // Part A1: messages not yet marked seen (warapp_get_chat reads them); absent when no chat can be read.
        ...(chat ? { chat } : {}),
        goal: plan.goal,
        goalSource: goal !== undefined ? 'explicit' : 'profile',
        profile:
          rung === 'full'
            ? plan.profile
            : {
                format: plan.profile.format,
                phase: plan.profile.phase,
                standing: plan.profile.standing,
                ...(plan.profile.standingSource === 'tracked' ? { standingSource: 'tracked' as const } : {}),
                ...(plan.profile.endsWith !== null ? { endsWith: plan.profile.endsWith } : {}),
              },
        // #178: the outlook and its basis; full adds each turn judged.
        outlook: rung === 'full' ? outlook : { state: outlook.state, basis: outlook.basis },
        income,
        enemyDeploy: plan.enemyDeploy,
        // #127: who moves first this turn and how it is known; null when unknown.
        firstMover: mover.view,
        // #166: what the award of picks showed (absent when no pick list is kept for this game).
        ...(award ? { award: awardView(award, game, turn, name) } : {}),
        trendSource: trend?.source ?? null,
        // #194: since last turn, when the previous turn's board or plan is known.
        ...(since && turn !== null
          ? { sinceLastTurn: sinceLastView(since, turn - 1, trend !== undefined, map, game.players, rung) }
          : {}),
        conceded: plan.conceded.map(name),
        // #163: Order Delay when it is the only card advised (it is then in cards.advice.orderDelay too).
        cardAdvice: plan.cardAdvice ?? (advice.view.orderDelay ? ('order-delay' as const) : null),
        multiSourceCaptures: plan.multiSourceCaptures.map(name),
        // #71: the frontier budget, one line on compact.
        frontier:
          rung === 'full'
            ? plan.frontier
            : `${plan.frontier.borders} borders (${plan.frontier.enemyBorders} facing an enemy): holding them next turn needs ${plan.frontier.holdCost}, next income ${plan.expected.nextIncome}${
                plan.expected.nextIncomeIfConcededFall !== undefined &&
                plan.expected.nextIncomeIfConcededFall < plan.expected.nextIncome
                  ? `, ${plan.expected.nextIncomeIfConcededFall} if the conceded borders fall`
                  : ''
              }${
                // #128: the figure the frontier is judged against, when it leaves out more (contested bonuses).
                plan.frontier.income < (plan.expected.nextIncomeIfConcededFall ?? plan.expected.nextIncome)
                  ? `; the plan counts on ${plan.frontier.income}`
                  : ''
              }`,
        // #72: the offensive options considered, full view only.
        ...(rung === 'full' ? { offence: plan.offence.map((o) => ({ ...o, target: name(o.target) })) } : {}),
        // #167: each attack on a player judged by its exchange, full view only.
        ...(rung === 'full' && plan.exchanges
          ? { exchanges: plan.exchanges.map((e) => ({ ...e, from: name(e.from), to: name(e.to) })) }
          : {}),
        // #179: turns to eliminate each visible opponent, full view only.
        ...(rung === 'full' && plan.eta ? { eta: plan.eta } : {}),
        // #179: where an opponent down to a few territories can go this turn, full view only.
        ...(rung === 'full' && plan.exits
          ? {
              exits: plan.exits.map((e) => ({
                player: e.player,
                stacks: e.stacks.map((x) => ({
                  territory: name(x.territory),
                  movable: x.movable,
                  own: x.own.map(name),
                  neutrals: x.neutrals.map(name),
                  mine: x.mine.map(name),
                })),
              })),
            }
          : {}),
        cards: {
          hand: hand.map(cardView),
          ...(handUnknown ? { handReadable: false } : {}),
          maxCardsHold: rules.maxCardsHold ?? null,
          playRequired: cards.required,
          plays: plays.map(cardView),
          discards: cards.discards.map(cardView),
          armiesFromCards: cards.extraArmies,
          ...(Object.keys(advice.view).length ? { advice: advice.view } : {}),
          // PLAN-TEAMS C3.7: in a team game, who plays each card of the team hand this turn.
          ...(inGame.team && hand.length
            ? {
                team: {
                  roles: teamCardRoles(hand, teamClaimed, {
                    plays: [
                      ...plays,
                      ...(advice.view.orderDelay && orders.some((o) => o.kind === 'card' && o.card === advice.view.orderDelay!.card)
                        ? myHand.filter((c) => c.id === advice.view.orderDelay!.card)
                        : []),
                    ],
                    discards: cards.discards,
                  }).map((r) => ({ ...r, by: r.by === null || r.by === 'me' ? r.by : playerRef(r.by) })),
                  note: TEAM_CARDS_NOTE,
                },
              }
            : {}),
        },
        deploys: plan.deploys.map((d) => ({ territory: name(d.territoryId), armies: d.armies })),
        moves: plan.moves.map((m) => ({
          from: name(m.from),
          to: name(m.to),
          armies: m.armies,
          kind: m.kind,
          ...(m.winChance !== undefined ? { winChance: Math.round(m.winChance * 1000) / 1000 } : {}),
          ...(rung === 'full' ? { reason: m.reason } : {}),
        })),
        expected: {
          captures: plan.expected.captures.map(name),
          bonusesCompleted: plan.expected.bonusesCompleted.map((id) => {
            const b = map.bonuses.find((x) => x.id === id)!;
            return { id, name: b.name, value: b.value };
          }),
          nextIncome: plan.expected.nextIncome,
          // #109: present only when the plan's concessions put income at risk.
          ...(plan.expected.nextIncomeIfConcededFall !== undefined
            ? {
                nextIncomeIfConcededFall: plan.expected.nextIncomeIfConcededFall,
                bonusesAtRisk: (plan.expected.bonusesAtRisk ?? []).map((b) => ({
                  id: b.bonusId,
                  name: b.name,
                  value: b.value,
                  conceded: b.conceded.map(name),
                })),
              }
            : {}),
        },
        // B2: each truce as the plan treated it, the advice about them, and the tacit truces.
        ...(plan.relations
          ? {
              relations: plan.relations.map((r) => ({
                ...r,
                player: playerRef(r.player),
                relaxed: r.relaxed.map(name),
                fullHold: r.fullHold.map((f) => ({ territory: name(f.territory), why: f.why })),
                ...(r.capMoved ? { capMoved: r.capMoved.map((m) => ({ from: name(m.from), to: name(m.to), armies: m.armies })) } : {}),
                ...(r.breach ? { breach: { ...r.breach, territories: r.breach.territories.map(name) } } : {}),
                lossIfBroken: r.lossIfBroken
                  ? {
                      ...r.lossIfBroken,
                      from: name(r.lossIfBroken.from),
                      to: name(r.lossIfBroken.to),
                      territories: r.lossIfBroken.territories.map(name),
                      bonuses: r.lossIfBroken.bonuses.map((b) => ({ id: b.id, name: map.bonuses.find((x) => x.id === b.id)?.name ?? String(b.id), value: b.value })),
                    }
                  : null,
              })),
            }
          : {}),
        ...(plan.advice ? { advice: plan.advice.map((a) => ({ ...a, player: playerRef(a.player) })) } : {}),
        // PLAN-TEAMS D3: the cards in effect the plan relied on (an unverified decoder, so `verified: false`).
        ...(effect.diplomacy.length || sanction.applied
          ? {
              cardsInEffect: {
                ...(effect.diplomacy.length ? { diplomacy: effect.diplomacy.map((d) => ({ player: playerRef(d.player), untilTurn: d.untilTurn })) } : {}),
                ...(sanction.applied
                  ? { sanctionsOnMe: effect.sanctionsOnMe.map((x) => ({ percentage: x.percentage, untilTurn: x.untilTurn })), incomeBefore: setup.boardIncome, incomeAfter: sanction.income }
                  : {}),
                verified: false,
                note: CARDS_IN_EFFECT_UNVERIFIED,
              },
            }
          : {}),
        // Where the teams came from (GameFeed, else the game list), in a team game only.
        ...(teamSource !== 'none' ? { teamSource } : {}),
        // PLAN-TEAMS C3.3: the bonuses I share with a teammate, advisory.
        ...(plan.team
          ? {
              team: {
                sharedBonuses: plan.team.sharedBonuses.map((b) => ({
                  bonus: { id: b.bonusId, name: map.bonuses.find((x) => x.id === b.bonusId)?.name ?? String(b.bonusId), value: b.value },
                  mine: b.mine.map(name),
                  teammates: b.teammates.map((m) => ({ player: playerRef(m.player), territories: m.territories.map(name) })),
                  others: b.others.length,
                  nearer: b.nearer === null ? 'even' : b.nearer === me.id ? 'me' : playerRef(b.nearer),
                })),
                note: TEAM_SHARED_NOTE,
                // C3.5: a teammate's border my idle armies would make hold (advisory, V7).
                ...(plan.team.support
                  ? {
                      support: {
                        borders: plan.team.support.map((x) => ({
                          territory: name(x.territory),
                          teammate: playerRef(x.teammate),
                          armies: x.armies,
                          threat: x.threat,
                          player: playerRef(x.player),
                          need: x.need,
                          from: x.from.map((f) => ({ territory: name(f.territory), armies: f.armies })),
                        })),
                        note: TEAM_SUPPORT_NOTE,
                      },
                    }
                  : {}),
                // C3.6: a target my teammate and I take only together (advisory).
                ...(plan.team.jointCaptures
                  ? {
                      jointCaptures: {
                        targets: plan.team.jointCaptures.map((j) => {
                          const who = (id: number) => (id === me.id ? ('me' as const) : playerRef(id));
                          return {
                            target: name(j.target),
                            owner: playerRef(j.owner),
                            teammate: j.teammate.map((x) => ({ player: playerRef(x.player), from: name(x.from), armies: x.armies, ...(x.percent ? { percent: true } : {}) })),
                            mine: j.mine.map((x) => ({ from: name(x.from), armies: x.armies })),
                            inPlan: j.inPlan,
                            cases: j.cases.map((c) => ({
                              first: who(c.first),
                              captured: c.captured,
                              by: c.by === null ? null : who(c.by),
                              capturedIfReinforced: c.capturedIfReinforced,
                            })),
                            ...(j.mustGoFirst !== undefined ? { mustGoFirst: j.mustGoFirst === null ? 'either' : who(j.mustGoFirst) } : {}),
                            exact: j.exact,
                          };
                        }),
                        note: TEAM_JOINT_NOTE,
                      },
                    }
                  : {}),
              },
            }
          : {}),
        ...(truces?.tacit.length
          ? { tacit: truces.tacit.map((t) => ({ player: playerRef(t.player), quietTurns: t.quietTurns, border: t.border.map(name) })) }
          : {}),
        warnings,
        rationale: plan.rationale,
        orders,
        // The border guess, only when there is one; why there is none, full view only.
        ...(guess
          ? {
              guess: guessView(guess, rung, name, game.players.find((p) => p.id === guess.opponent)?.name ?? null),
              guessOrders,
            }
          : rung === 'full' && guessed.kind === 'skipped'
            ? { guessSkipped: { reason: guessed.reason, message: guessed.message } }
            : {}),
        ...(rung === 'full'
          ? {
              settings: {
                ...settings,
                // #257: the planner's switch under its own name, and beside it the game's own
                // per-order options as GameFeed states them (null when it does not).
                idleTransfers: settings.idleTransfers ?? true,
                allowTransferOnly: game.settings?.allowTransferOnly ?? null,
                allowAttackOnly: game.settings?.allowAttackOnly ?? null,
                localDeployments: settings.localDeployments ?? false,
                noSplit: settings.noSplit ?? false,
              },
            }
          : {}),
      }));
    },
  );
  const submitSchema = z.object({
    game_id: gameIdArg,
    player: playerArg,
    income: z.coerce
      .number()
      .int()
      .min(0)
      .max(MAX_ENEMY_DEPLOY)
      .optional()
      .describe(
        'Only after war.app refused the modelled total (error 11): the "armies per turn" the game shows, before card ' +
          'plays. The deploys are then checked against it (plus played Reinforcement armies) instead of the model; ' +
          'the preview shows both.',
      ),
    orders: turnOrdersArg.describe(
      'The turn\'s orders (card plays and discards, deploys and attacks/transfers), territories by id or name, cards by id or type ' +
        'name — e.g. the `orders` array warapp_plan_turn returns. Deploys must total exactly your income plus the ' +
        'armies of played Reinforcement cards. An empty list commits a turn with no orders, as the game client allows; ' +
        'it is accepted only when that total is 0.',
    ),
    break_agreement: z
      .boolean()
      .optional()
      .describe(
        'Only when an order attacks a territory an active or in-notice truce covers (warapp_get_relations): true breaks ' +
          'it on purpose — the preview names the agreement, and once the orders are committed the ledger records it ' +
          'broken-by-me (the partner\'s player record too). Without it such orders are refused. Ask the owner first.',
      ),
  });

  defineGatedWrite(
    server,
    {
      title: 'Submit my turn in a war.app game',
      _meta: mintMeta('change', ['submit my turn', 'commit orders', 'send my orders', 'end my turn']),
    },
    {
      name: 'warapp_submit_turn',
      description:
        'Commit your orders for the current turn of a war.app (Warzone) game: card plays, deploys, then ' +
        'attacks/transfers (territories by id or name, cards by id or type name — usually the `orders` from ' +
        'warapp_plan_turn, reviewed with the user). Plays Reinforcement, Order Priority, Order Delay and Blockade ' +
        '(with a `target` of yours; an Order Delay goes after every move unless it has `before`: a move number to ' +
        'place it above, unverified live) from your hand, and the targeted cards — Spy (`player`), Reconnaissance ' +
        '(`target`), Surveillance (`bonus`), Airlift (`from` yours, `to` yours or a teammate\'s, `armies`, optional ' +
        '`commander`), Gift (`target` yours, `player`), Diplomacy (`players`: two), Sanctions (`player`), Bomb (`target` ' +
        "next to yours, not yours or a teammate's) and Emergency Blockade (`target` yours, never your commander's), encoded " +
        'as the client does but not yet verified live, each refused where war.app would refuse it (a commander is never ' +
        'gifted or airlifted to a teammate, no Spy or Sanctions on yourself or a teammate, no Diplomacy between ' +
        'teammates); discards any card (`{ kind: "discard", card }`); refuses ' +
        'when your hand is over the hold limit and the orders do not play or discard enough cards. The ' +
        'orders reach the game and cannot be withdrawn here; when the turn resolves, other players see the results. ' +
        'Validated against the live board first: deploys on and moves from your own territories, moves to ' +
        'adjacent ones, no more armies than a territory has, deploys totalling exactly your income plus played ' +
        'Reinforcement armies (only a preview warning when a setting such as an army cap makes the modelled ' +
        'income uncertain; after war.app\'s error 11, resend with the game\'s own number as `income`); under Local Deployment, each held bonus\'s armies deployed inside that bonus; under ' +
        'No-Split, at most one attack or transfer per territory (and a warning when one sends less than the whole ' +
        'stack, which war.app moves anyway); under Multi-Attack, a move (not a deploy) may go on from a ' +
        'territory an earlier move in the list captures (warapp_plan_turn obeys these and the kill rates). ' +
        'A move may carry options, each refused unless the game allows it: `mode` "transfer-only" (AllowTransferOnly) ' +
        'or "attack-only" (AllowAttackOnly), `percent` (AllowPercentageAttacks: `armies` is a percentage of what can ' +
        'move when it runs), `commander` (take your commander along; `armies` 0 sends it alone) and ' +
        '`attack_teammates` (team games); these are encoded as the client does but not yet verified live. ' +
        'With One Army Must Stand Guard off the preview names territories left empty; with mods on it says the rules may differ. ' +
        'The preview sizes each attack against the armies standing there now (`attacks`: expected kills, win chance; ' +
        'several attacks on one target in the order listed, each against what the earlier ones leave) ' +
        'and warns about one that cannot capture. An order that attacks a territory an active or in-notice truce ' +
        'covers (the agreement ledger) is refused unless `break_agreement` is true; then the preview names the agreement ' +
        'and, once the orders are committed, the ledger records it broken-by-me. Always sent as ' +
        'the signed-in war.app account; refuses if you have already committed this turn. Success is confirmed from ' +
        `game state (turn advanced, or your orders marked committed). ${BRIDGE_NOTE} ${CONFIRM_INJECTION_RULE}`,
      annotations: toolAnnotations({
        title: 'Submit a war.app turn',
        readOnly: false,
        destructive: true,
        idempotent: false,
        openWorld: true,
      }),
      inputSchema: submitSchema,
      async plan({ game_id, player, orders, income: givenIncome, break_agreement }) {
        const feed = await ctx.client.getGame(parseGameId(game_id), { settings: true });
        requireTurnPhase(feed);
        // The bridge always acts as the signed-in account: an explicit `player` naming anyone
        // else is refused, and so is a call when that account cannot be read (never trust `player` alone).
        const seat = await requireMySeat(ctx, feed, { player, playing: false });
        requirePlayingSeat(feed, seat);
        if (seat.hasCommittedOrders) {
          throw new McpToolError(`You have already committed orders for this turn of game ${feed.id}.`, {
            hint:
              'To change them, withdraw them first with warapp_uncommit_turn (confirm-gated), then submit again — ' +
              'or use "Modify orders" in the game itself; this tool does not replace committed orders.',
          });
        }
        // The teams (the teammate set): GameFeed's, else the game list's (asked once per game, kept).
        const { game, me } = await resolveTeamsFor(ctx, feed, seat);
        const turnNumber = currentTurn(game);
        if (turnNumber === null || game.numberOfTurns === undefined) {
          throw new McpToolError(`GameFeed did not say how many turns game ${game.id} has had, so the turn number is unknown.`, {
            hint: 'Retry in a moment; no orders were sent.',
          });
        }
        const map = mapOf(game);
        const deploys: Array<{ territory: { id: number; name: string }; armies: number }> = [];
        const moves: Array<{
          from: { id: number; name: string };
          to: { id: number; name: string };
          armies: number;
          mode?: MoveMode;
          percent?: boolean;
          commander?: boolean;
          attackTeammates?: boolean;
        }> = [];
        const cardInputs: CardInput[] = [];
        const discardInputs: Array<{ card: string }> = [];
        for (const o of orders) {
          if (o.kind === 'card') {
            const { kind: _kind, ...card } = o;
            cardInputs.push(card);
          } else if (o.kind === 'discard') {
            discardInputs.push({ card: o.card });
          } else if (o.kind === 'deploy') {
            const t = resolveTerritory(map, o.territory);
            deploys.push({ territory: { id: t.id, name: t.name }, armies: o.armies });
          } else {
            const f = resolveTerritory(map, o.from);
            const t = resolveTerritory(map, o.to);
            moves.push({
              from: { id: f.id, name: f.name },
              to: { id: t.id, name: t.name },
              armies: o.armies,
              ...(o.mode !== undefined && o.mode !== 'attack-transfer' ? { mode: o.mode } : {}),
              ...(o.percent ? { percent: true } : {}),
              ...(o.commander ? { commander: true } : {}),
              ...(o.attack_teammates ? { attackTeammates: true } : {}),
            });
          }
        }
        const { territories, info } = await loadLiveGame(ctx, game);
        const board = withTeammateOrders(boardStateFromLive(territories, me, game.players), info, me, game.players);
        const playerId = inGameId(me);
        const rules = cardRules(game.settings);
        // A team shares one hand (#163): cards under my teammates may be played or discarded too. But how
        // war.app keys a team's hand is unverified, so the hard refusal (error 51) counts only my own cards,
        // as before, and the team's gathered count is a warning until a live team board verifies it.
        const owners = handOwners(game, me);
        const myHand = readHand(info, playerId);
        const hand = owners.length > 1 ? readHand(info, owners) : myHand;
        const handUnknown = rules.inPlay.length > 0 && !handReadable(info, playerId);
        const plays = resolveCardPlays(map, hand, rules, cardInputs);
        // #186: an Order Delay's `before` names a move of this list (1-based); one past the last is the default.
        for (const p of plays) {
          if (p.before !== undefined && p.before > moves.length + 1) {
            throw new McpToolError(
              `Order Delay \`before\` ${p.before} is past this turn's ${moves.length} move${moves.length === 1 ? '' : 's'}.`,
              { hint: `Give a move number 1–${moves.length + 1} (${moves.length + 1}, or no \`before\`, writes it after every move).` },
            );
          }
        }
        /** The move (1-based) an Order Delay is placed above, when it is placed among the moves. */
        const placedAt = (p: ResolvedCardPlay) => (p.before !== undefined && p.before <= moves.length ? p.before : undefined);
        const discards = resolveDiscards(hand, plays, discardInputs);
        // Every play and discard takes its card out of the hand; war.app refuses (error 51) while more
        // than MaxCardsHold remain (verified, #20).
        const used = plays.length + discards.length;
        const shed = cardsToShed(myHand, rules);
        if (used < shed) throw mustPlayCard(myHand, rules, shed, used);
        const teamShed = owners.length > 1 ? cardsToShed(hand, rules) : 0;
        for (const p of plays) {
          const t = p.target && territories.find((x) => x.territoryId === p.target!.id);
          if (p.target && (!t || t.fogged || t.owner !== playerId)) {
            throw new McpToolError(`${label(p.target)} is not yours at the start of this turn, so it cannot be blockaded.`, {
              hint: 'A Blockade targets a territory you hold on the live board (warapp_get_live_board).',
            });
          }
          // A Blockade turns the territory neutral: my commander there would be lost with it (#163).
          if (t?.specialUnits?.some((u) => u.kind === 'commander' && u.owner === playerId)) {
            throw new McpToolError(`${label(p.target!)} holds your commander, so it cannot be blockaded.`, {
              hint: 'A Blockade makes the territory neutral and your commander on it would be lost (a commander must stay on your land). Move the commander out first, or blockade another territory.',
            });
          }
        }
        // A move into a teammate's territory is a transfer (GameFeed's team field is unverified). The live
        // board keys owners by in-game id; a teammate without a GameFeed player id (an AI seat) owns nothing by one.
        const teammates = new Set([...playersByInGameId(teammatesOf(game.players, me)).keys()]);
        const deployedOn = new Map<number, number>();
        for (const d of deploys) deployedOn.set(d.territory.id, (deployedOn.get(d.territory.id) ?? 0) + d.armies);
        // PLAN-TEAMS part D: the targeted cards, refused where war.app's validator (the bundle's) would refuse them.
        const cardContext: CardPlayContext = {
          map,
          board: territories,
          me,
          myInGameId: playerId,
          players: game.players,
          teammates: friendsOf(game.players, me),
          settings: game.settings,
          rules,
          deployedOn,
          movesFrom: new Set(moves.map((m) => m.from.id)),
          seen: newCardPlaySeen(),
        };
        for (const p of plays) {
          if (UNVERIFIED_CARD_PLAYS.has(p.kind)) p.targets = resolveCardTargets(p.kind, p.card.name, p.input, cardContext);
        }
        // An Emergency Blockade (phase 37) turns its territory neutral before an Airlift (phase 43) runs.
        for (const p of plays) {
          const a = p.kind === 'Airlift' ? p.targets : undefined;
          const hit = a && [a.from, a.to].find((t) => t && cardContext.seen.blockaded.has(t.id));
          if (hit) {
            throw new McpToolError(`${label(hit)} is blockaded before the Airlift runs, so the Airlift ${hit === a.from ? 'from' : 'to'} it cannot happen.`, {
              hint: 'The Emergency Blockade turns the territory neutral first: airlift elsewhere, or blockade another territory.',
            });
          }
        }
        if (cardContext.seen.commanderAirlifted && moves.some((m) => m.commander)) {
          throw new McpToolError('Your commander is both airlifted and taken along on a move.', {
            hint: 'The Airlift runs before the moves; take the commander in one order only.',
          });
        }
        // #165: each move's options, refused unless the game allows them.
        const options = checkMoveOptions({ moves, board: territories, myInGameId: playerId, settings: game.settings, teammates, deployedOn });
        const modelled = incomeFor(graphOf(map), board, me.id, game.settings);
        const cardArmies = plays.reduce((sum, p) => sum + p.armies, 0);
        // #130: war.app's own number, given after an error 11, replaces the model for the check.
        const income = (givenIncome ?? modelled) + cardArmies;
        const overridden =
          givenIncome !== undefined && givenIncome !== modelled
            ? `income ${givenIncome} given (the game's armies per turn), modelled ${modelled}`
            : undefined;
        // B2: an order that attacks a territory an active or in-notice truce covers is refused unless the
        // caller breaks the agreement on purpose (the plan never orders a surprise break, T7).
        const ledger = ctx.dataDir ? await readLedger(ctx.dataDir, game.id, me.id) : undefined;
        const breaks = ctx.dataDir
          ? truceBreaksIn({
              agreements: ledger?.agreements ?? [],
              graph: graphOf(map),
              board,
              me: me.id,
              turn: turnNumber,
              players: game.players.map((p) => ({
                id: p.id,
                isAI: p.isAI,
                humanTurnedIntoAI: p.humanTurnedIntoAI,
                ...(p.state !== undefined ? { state: p.state } : {}),
                ...(p.team !== undefined ? { team: p.team } : {}),
              })),
              moves: moves.map((m) => ({ from: m.from.id, to: m.to.id, ...(m.mode !== undefined ? { mode: m.mode } : {}) })),
            })
          : [];
        if (breaks.length && break_agreement !== true) {
          throw new McpToolError(`${breaksText(breaks, moves)}: nothing was sent.`, {
            hint:
              'Drop those orders, or give notice (warapp_record_agreement status notice-by-me) and wait until it runs. ' +
              'If the partner broke it first, record broken-by-them with warapp_record_agreement. To break it on purpose ' +
              '(ask the owner first), resend with break_agreement: true — the ledger then records it broken-by-me.',
          });
        }
        const { warnings } = validateTurn({
          map,
          board: territories,
          myInGameId: playerId,
          income,
          guard: game.settings?.oneArmyStandsGuard ?? true,
          deploys,
          moves,
          airlifts: plays.flatMap((p) =>
            p.kind === 'Airlift' && p.targets?.from && p.targets.to && p.targets.armies !== undefined
              ? [{ from: p.targets.from.id, to: p.targets.to.id, armies: p.targets.armies }]
              : [],
          ),
          localDeployments: game.settings?.localDeployments ?? false,
          noSplit: game.settings?.noSplit ?? false,
          multiAttack: game.settings?.multiAttack ?? false,
          unplayedReinforcements: hand.flatMap((c) => {
            if (c.type !== CARD_REINFORCEMENT || plays.some((p) => p.card.id === c.id)) return [];
            const armies = reinforcementArmies(c, rules);
            return armies === undefined ? [] : [{ id: c.id, armies }];
          }),
          incomeUncertain: givenIncome !== undefined ? [] : deployCheckUncertainties(game.settings),
          poolsUncertain: [
            ...overrideUncertainties(game.settings),
            ...(overridden ? [`The ${overridden}, so the bonus pools may differ too.`] : []),
          ],
        });
        if (overridden) warnings.unshift(`Deploys checked against the ${overridden}.`);
        if (breaks.length)
          warnings.unshift(
            `${breaksText(breaks, moves)}. break_agreement is true: once these orders are committed the ledger records ` +
              `${breaks.length === 1 ? 'it' : 'them'} broken-by-me, and the partner's player record says so. That is final: ` +
              'withdrawing the orders afterwards (warapp_uncommit_turn) does not undo it.',
          );
        // B4: what my chat messages promised (warapp_send_chat's commitments): a warning, never a refusal.
        const promises = commitmentWarnings({
          commitments: ledger?.commitments ?? [],
          agreements: ledger?.agreements ?? [],
          graph: graphOf(map),
          board,
          me: me.id,
          turn: turnNumber,
          moves: moves.map((m) => ({ from: m.from.id, to: m.to.id, ...(m.mode === 'transfer-only' ? { transferOnly: true } : {}) })),
        });
        for (const p of promises)
          warnings.push(
            p.unchecked
              ? `Your chat ${p.text}. Find out whose it is before committing these orders: if it is that player's, keep the ` +
                  'promise (change them), or ask the owner and tell the player before breaking it — never silently.'
              : `Your chat ${p.text}. Keep the promise (change these orders), or ask the owner and tell the player before ` +
                  'breaking it — never silently.',
          );
        warnings.push(...options.warnings);
        warnings.push(
          ...modsWarning(game.settings),
          ...guardOffWarnings(
            graphOf(map),
            map,
            board,
            me.id,
            friendsOf(game.players, me),
            game.settings,
            deploys.map((d) => ({ territoryId: d.territory.id, armies: d.armies })),
            moves.map((m, i) => ({ from: m.from.id, to: m.to.id, armies: m.percent ? (options.estimates.get(i) ?? 0) : m.armies })),
          ),
        );
        if (handUnknown) warnings.push(UNREADABLE_HAND);
        for (const p of plays) warnings.push(...(p.targets?.warnings ?? []));
        const unverifiedPlays = [...new Set(plays.filter((p) => UNVERIFIED_CARD_PLAYS.has(p.kind)).map((p) => p.card.name))];
        if (unverifiedPlays.length) warnings.push(unverifiedCardWarning(unverifiedPlays));
        if (used < teamShed) warnings.push(teamHandOver(hand.length, rules, teamShed, used));
        // V8: a card read only under a teammate's id may be theirs to play; war.app has the last word.
        const theirs = [...plays.map((p) => p.card), ...discards].filter((c) => !isMyCard(c, playerId));
        if (theirs.length) warnings.push(teammateCardWarning(theirs));
        const placedDelays = plays.filter((p) => placedAt(p) !== undefined);
        for (const p of placedDelays) {
          const m = moves[placedAt(p)! - 1]!;
          warnings.push(
            `Order Delay is written above move ${placedAt(p)} (${label(m.from)} → ${label(m.to)}), so that move and the ones ` +
              "after it wait until the opponents' attacks have run. UNVERIFIED live: no commit has yet placed the card among " +
              "the moves. war.app refusing it with error 10 (OrdersInIncorrectOrder) means it is not allowed there — resend " +
              'without `before`.',
          );
        }
        if (plays.some((p) => p.kind === 'OrderDelay' && placedAt(p) === undefined)) {
          // Phase 50, after every move, is the only live-verified position for the card.
          warnings.push(
            "Order Delay is written after every move (its only verified position), so it delays none of this turn's " +
              'orders: playing it only spends the card, as a discard would. Give it `before` (a move number) to place it ' +
              'among the moves (unverified live).',
          );
        }
        const attacks = attackSizes(
          territories,
          playerId,
          moves.map((m, i) => ({ ...m, ...(options.estimates.has(i) ? { estimate: options.estimates.get(i)! } : {}) })),
          plannerSettings(game.settings),
          teammates,
        );
        const hopeless = hopelessAttackWarning(attacks, label);
        if (hopeless) warnings.push(hopeless);
        // Deploys first (as the client sends them), merged per territory.
        const merged = new Map<number, { territory: { id: number; name: string }; armies: number }>();
        for (const d of deploys) {
          const m = merged.get(d.territory.id);
          if (m) m.armies += d.armies;
          else merged.set(d.territory.id, { ...d });
        }
        const send: TurnOrder[] = [
          ...discards.map((c) => ({ kind: 'discard' as const, cardId: c.id })),
          ...plays.map((p) => ({
            kind: 'card' as const,
            card: p.kind,
            cardId: p.card.id,
            ...(p.target ? { target: p.target.id } : {}),
            ...(p.targets ? p.targets.fields : {}),
            ...(placedAt(p) !== undefined ? { beforeMove: placedAt(p)! - 1 } : {}),
          })),
          ...[...merged.values()].map((d) => ({ kind: 'deploy' as const, territoryId: d.territory.id, armies: d.armies })),
          ...moves.map((m, i) => {
            const commander = options.commanders.get(i);
            return {
              kind: 'move' as const,
              from: m.from.id,
              to: m.to.id,
              armies: m.armies,
              ...(m.mode === 'attack-only' ? { mode: AttackTransferMode.Attack } : m.mode === 'transfer-only' ? { mode: AttackTransferMode.Transfer } : {}),
              ...(m.percent ? { byPercent: true } : {}),
              ...(m.attackTeammates ? { attackTeammates: true } : {}),
              ...(commander ? { commander } : {}),
            };
          }),
        ];
        const named: NamedOrder[] = [
          ...discards.map((c) => ({ kind: 'discard' as const, card: cardView(c) })),
          ...plays.map((p) => ({
            kind: 'card' as const,
            card: cardView(p.card),
            ...(p.target ? { target: p.target } : {}),
            ...(p.targets ? namedTargets(p.targets) : {}),
            ...(placedAt(p) !== undefined ? { before: placedAt(p)! } : {}),
          })),
          ...[...merged.values()].map((d) => ({ kind: 'deploy' as const, territory: d.territory, armies: d.armies })),
          ...moves.map((m) => ({
            kind: 'move' as const,
            from: m.from,
            to: m.to,
            armies: m.armies,
            ...(m.mode === 'attack-only' || m.mode === 'transfer-only' ? { mode: m.mode } : {}),
            ...(m.percent ? { percent: true as const } : {}),
            ...(m.commander ? { commander: true as const } : {}),
            ...(m.attackTeammates ? { attackTeammates: true as const } : {}),
          })),
        ];
        return {
          gate: {
            action: 'warapp.submit_turn',
            // By id only: player and territory names are other people's words and go,
            // delimited, in the labelled fields of `willSend`.
            summary: `Commit ${send.length} order${send.length === 1 ? '' : 's'} for player ${me.id} in game ${game.id}, turn ${turnNumber}`,
            account: writeAccount(me.id),
            target: game.id,
            payload: { method: 'SendOrders', gameId: game.id, playerId, turnNumber, orders: send },
            willSend: { game: game.id, player: untrustedText(me.name), turn: turnNumber, income, orders: named.map(shownOrder) },
            preview: {
              account: shownAccount(me.name, me.id),
              note: 'These orders reach the game; once the turn resolves, other players see the results.',
              ...(attacks.length ? { attacks: attacks.map((a) => ({ ...a, from: shownPlace(a.from), to: shownPlace(a.to) })) } : {}),
              ...(warnings.length ? { warnings } : {}),
              untrusted: UNTRUSTED_PREVIEW_NOTE,
            },
          },
          state: {
            gameId: game.id,
            playerId,
            feedPlayerId: me.id,
            turnsBefore: game.numberOfTurns,
            turnNumber,
            orders: send,
            named,
            income,
            ...(givenIncome !== undefined ? { incomeGiven: true } : {}),
            ...(placedDelays.length ? { orderDelayCheck: orderDelayCheck(placedDelays.map((p) => placedAt(p)!)) } : {}),
            ...(unverifiedPlays.length ? { cardPlayCheck: cardPlayCheck(unverifiedPlays) } : {}),
            ...(breaks.length ? { breaks: breaks.map((b) => b.agreement) } : {}),
          } satisfies TurnState,
        };
      },
      async execute(st: TurnState) {
        await requireApprovedAccount(ctx, writeAccount(st.feedPlayerId));
        const base = {
          game: st.gameId,
          turn: st.turnNumber,
          orders: st.named,
          ...(st.orderDelayCheck ? { orderDelayCheck: st.orderDelayCheck } : {}),
          ...(st.cardPlayCheck ? { cardPlayCheck: st.cardPlayCheck } : {}),
        };
        const check =
          `Check warapp_get_game: a \`turn\` above ${st.turnNumber} means this turn resolved; still ${st.turnNumber} with ` +
          'your `committed` true means the orders are in. Do not resend these orders blindly — a second commit for ' +
          'the same turn is not known to be safe, and once the turn has resolved they would commit to the next one.';
        const unconfirmed = (warning: string) => ({ status: 'unknown' as const, outcome: 'unconfirmed' as const, ...base, warning });
        const result = await sendAndVerify({
          send: async () => {
            // The reply's bool is war.app's "vacation ended" flag — never a success signal.
            await ctx.rpc.call('SendOrders', Method.SendOrders, (w) =>
              writeSendOrdersParams(w, st.gameId, st.playerId, st.orders, st.turnNumber),
            );
            // Sent: keep my deploys and moves for opponent tracking (#119). Best effort, never throws.
            if (ctx.dataDir) await writeOrdersCache(ctx.dataDir, st.gameId, st.feedPlayerId, st.turnNumber, myOrdersOf(st.orders));
          },
          // war.app refused them (e.g. 11: deploys ≠ income; 208: the turn already advanced): nothing committed.
          refused: (e) => {
            if (e.code === 11) return incomeRefused(e, st.income, st.incomeGiven);
            if (e.code === 10 && st.orderDelayCheck) return orderDelayRefused(e);
            return undefined;
          },
          unanswered: (failure) => ({
            status: 'unknown' as const,
            outcome: 'unknown' as const,
            ...base,
            warning: `war.app did not confirm these orders (${failure}), so they may already have been committed. ${check}`,
          }),
          readBack: () => ctx.client.getGame(st.gameId, { map: false }),
          unreadable: (failure) => unconfirmed(`The orders were sent, but re-reading the game failed (${failure}). ${check}`),
          classify: (after) => {
            if (after.numberOfTurns !== undefined && after.numberOfTurns > st.turnsBefore) {
              return {
                status: 'resolved' as const,
                outcome: 'confirmed' as const,
                ...base,
                detail: `The turn resolved: the game is now on turn ${after.numberOfTurns + 1}.`,
              };
            }
            if (after.players.find((p) => p.id === st.feedPlayerId)?.hasCommittedOrders) {
              return {
                status: 'committed' as const,
                outcome: 'confirmed' as const,
                ...base,
                detail: 'Your orders are committed; the turn resolves when every player has committed.',
              };
            }
            return unconfirmed(`The orders were sent, but the game does not yet show them committed or the turn advanced. ${check}`);
          },
        });
        if (!st.breaks?.length) return result;
        return { ...result, agreementsBroken: await recordBreaks(st, result.outcome === 'confirmed') };

      },
    },
  );
}
