// Turn tools: plan a turn from the live board (read-only), and — gated on the
// user's confirmation — submit one. The plan's `orders` array is the exact
// input shape of warapp_submit_turn.
import { CONFIRM_INJECTION_RULE, defineWrite, McpToolError, registerWrite, toolAnnotations } from '@chrischall/mcp-utils';
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  CARD_BLOCKADE,
  CARD_ORDER_DELAY,
  CARD_ORDER_PRIORITY,
  holdsOrderPriority,
  advisedOrderPriority,
  CARD_REINFORCEMENT,
  cardRules,
  cardTypeByName,
  cardTypeName,
  chooseCardPlays,
  normalizeGuid,
  cardsToShed,
  readHand,
  reinforcementArmies,
  type Card,
  type CardRules,
} from '../cards.js';
import {
  chargeDeploys,
  deployPools,
  incomeFor,
  deployCheckUncertainties,
  overrideUncertainties,
  neighborsOf,
  planTurn,
  AHEAD_PRESSURE_FACTOR,
  PRESSURE_FACTOR,
  trackGame,
  trackOpponents,
  type TurnBoard,
  type PlanGoal,
  type PlannerSettings,
} from '../analysis/index.js';
import { parseGameId } from '../client.js';
import { boardStateFromLive, inGameId, type LiveTerritory } from '../live.js';
import { type Game, type GameMap, type GameSettings, type Player } from '../normalize.js';
import { Method, writeSendOrdersParams, type CardPlayKind, type TurnOrder } from '../protocol/methods.js';
import { SERVER_ERROR_MESSAGES, WarappServerError } from '../protocol/rpc.js';
import { gameIdArg, graphOf, readAnnotations, respond, untrustedDescription, viewArg } from './common.js';
import { lookupMeta, mintMeta, withToolConfig } from './hints.js';
import { loadLiveGame, type LiveContext } from './live-context.js';
import { BRIDGE_NOTE, playerArg, resolveMe } from './live.js';
import { mapOf } from './map.js';
import { resolveBonus, resolvePlayer, resolveTerritory } from './resolve.js';
import { boardFromHistory, CACHED_TURNS, readBoardHistory, writeBoardCache, type TrendSource } from '../trend.js';
import type { BoardState } from '../board.js';

const VIEWS = ['compact', 'full'] as const;
const GOALS = ['balanced', 'expand', 'complete-bonus', 'defend'] as const satisfies readonly PlanGoal[];
/** The only GameFeed state in which turns are played. */
export const TURN_PHASE_STATE = 'Playing';
const MAX_ORDERS = 500;
const MAX_FOCUS = 50;
const MAX_ENEMY_DEPLOY = 10_000;

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
  z.object({
    kind: z.literal('card'),
    card: z
      .string()
      .min(1)
      .max(64)
      .describe('Card to play from your hand: its id (GUID) or its type name, e.g. "Reinforcement".'),
    target: territoryRef
      .optional()
      .describe('Blockade only: your territory to blockade (id or name).'),
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
  if (s.bonusArmyPer !== undefined && s.bonusArmyPer > 0) out.bonusArmyPer = s.bonusArmyPer;
  if (s.minimumArmyBonus !== undefined) out.baseIncome = s.minimumArmyBonus;
  if (s.localDeployments) out.localDeployments = true;
  if (s.noSplit) out.noSplit = true;
  if (s.armyCap !== undefined && s.armyCap !== null && s.armyCap > 0) out.armyCap = s.armyCap;
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

/**
 * The signed-in account in this game. The bridge always acts as that account,
 * so an explicit `player` naming anyone else is refused, and so is a call when
 * the signed-in account cannot be determined (never trust `player` alone).
 */
export async function requireSignedInMe(
  ctx: LiveContext,
  game: Game,
  input: string | number | undefined,
): Promise<Player> {
  const token = await ctx.myInviteToken();
  if (token === undefined) {
    throw new McpToolError('Could not tell which war.app account is signed in, so no orders were prepared.', {
      hint:
        'Orders are sent as the account signed in to your war.app tab. Make sure a signed-in war.app tab is open ' +
        'and paired (ContextMint Bridge), focus or reload it, then retry.',
    });
  }
  const me = game.players.find((p) => p.id === token);
  if (!me) {
    throw new McpToolError(`The signed-in war.app account is not a player in game ${game.id}.`, {
      hint: 'Orders can only be submitted for the account signed in to your war.app tab.',
    });
  }
  if (input !== undefined && String(input).trim() !== '') {
    const named = resolvePlayer(game.players, input);
    if (named.id !== me.id) {
      throw new McpToolError(
        `Orders are always sent as the signed-in account (${me.name}), not ${named.name}.`,
        { hint: `Omit \`player\` (or name ${me.name}); to play as ${named.name}, sign in to war.app as them.` },
      );
    }
  }
  return me;
}

interface NamedOrder {
  kind: 'deploy' | 'move' | 'card' | 'discard';
  card?: { id: string; name: string; armies?: number };
  target?: { id: number; name: string };
  territory?: { id: number; name: string };
  from?: { id: number; name: string };
  to?: { id: number; name: string };
  armies?: number;
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
  /** The modelled income the deploys were checked against. */
  income: number;
}

/**
 * war.app's error 11 (deploys ≠ its income), with a hint naming the modelled
 * number. The live board carries no income figure — war.app's client computes it
 * from the standing — so its own number is the "armies per turn" the game shows.
 */
function incomeRefused(e: WarappServerError, income: number): McpToolError {
  return new McpToolError(e.message, {
    kind: 'unknown',
    cause: e,
    hint:
      `The modelled income was ${income}, and war.app counts differently this turn. Deploy exactly the "armies per ` +
      'turn" the game shows (the deploy panel); nothing was committed, so resend with that total.',
  });
}

const label = (t: { id: number; name: string }) => `${t.name} (${t.id})`;

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
  moves: Array<{ from: { id: number; name: string }; to: { id: number; name: string }; armies: number }>;
  /** Local Deployment: each held bonus's armies must be deployed inside that bonus. */
  localDeployments?: boolean;
  /** No-Split: each territory issues at most one attack or transfer. */
  noSplit?: boolean;
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
}): { warnings: string[] } {
  const warnings: string[] = [];
  const { map, board, myInGameId, income, deploys, moves } = args;
  const graph = graphOf(map);
  const standing = new Map(board.map((t) => [t.territoryId, t]));
  const mine = (id: number) => {
    const t = standing.get(id);
    return t !== undefined && !t.fogged && t.owner === myInGameId;
  };
  const notMine = [...deploys.map((d) => d.territory), ...moves.map((m) => m.from)].filter((t) => !mine(t.id));
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
            'best one (with all the armies you want to move) and drop the others.',
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
  if (args.localDeployments) {
    const held = new Set(board.filter((t) => mine(t.territoryId)).map((t) => t.territoryId));
    const pools = deployPools(graph, held, income);
    const use = chargeDeploys(pools, deployedOn);
    if (use.anywhereUsed > pools.anywhere) {
      const short = pools.bonuses
        .map((p) => ({ p, used: use.used.get(p.bonusId) ?? 0 }))
        .filter(({ p, used }) => used < p.value)
        .map(({ p, used }) => `${p.name} (bonus ${p.bonusId}): +${p.value} earned, only ${used} deployed inside it`);
      const problem =
        `Local Deployment: these orders deploy ${use.anywhereUsed} armies outside the held bonuses' own pools, but only ` +
        `${pools.anywhere} may go anywhere this turn (${use.anywhereUsed - pools.anywhere} too many). ${short.join('; ')}.`;
      if (args.poolsUncertain?.length) {
        warnings.push(
          `${problem} The modelled pools may be off (${args.poolsUncertain.join(' ')}), so they are not refused here: ` +
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
  const out = new Map<number, { from: { id: number; name: string }; armies: number }>();
  for (const m of moves) {
    const o = out.get(m.from.id) ?? { from: m.from, armies: 0 };
    o.armies += m.armies;
    out.set(m.from.id, o);
  }
  for (const { from, armies } of out.values()) {
    const max = (standing.get(from.id)?.armies ?? 0) + (deployedOn.get(from.id) ?? 0) - (args.guard ? 1 : 0);
    if (armies > max) {
      throw new McpToolError(
        `These orders send ${armies} armies from ${label(from)}, which can send at most ${max} this turn` +
          `${args.guard ? ' (one army stands guard)' : ''}.`,
        { hint: 'A territory sends at most its armies plus what is deployed there this turn.' },
      );
    }
  }
  return { warnings };
}

/** The card types warapp_submit_turn can play, by the encoder's name. */
const PLAYABLE: Readonly<Record<number, CardPlayKind>> = {
  [CARD_REINFORCEMENT]: 'Reinforcement',
  [CARD_ORDER_PRIORITY]: 'OrderPriority',
  [CARD_ORDER_DELAY]: 'OrderDelay',
  [CARD_BLOCKADE]: 'Blockade',
};

/** A card play resolved against the hand. */
export interface ResolvedCardPlay {
  card: Card;
  kind: CardPlayKind;
  target?: { id: number; name: string };
  /** Armies it adds to this turn's deploys (Reinforcement). */
  armies: number;
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
export function resolveDiscards(
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
export function resolveCardPlays(
  map: GameMap,
  hand: readonly Card[],
  rules: CardRules,
  inputs: ReadonlyArray<{ card: string; target?: string | number | undefined }>,
): ResolvedCardPlay[] {
  const used = new Set<string>();
  const out: ResolvedCardPlay[] = [];
  for (const input of inputs) {
    const card = findCard(hand, input.card, used, 'played twice');
    used.add(card.id);
    const kind = PLAYABLE[card.type];
    if (!kind) {
      throw new McpToolError(`Playing a ${card.name} card is not supported here yet.`, {
        hint: 'Play it in the game itself; this tool plays Reinforcement, Order Priority, Order Delay and Blockade cards.',
      });
    }
    const hasTarget = input.target !== undefined && String(input.target).trim() !== '';
    if (kind === 'Blockade' && !hasTarget) {
      throw new McpToolError('A Blockade needs a `target`: the territory of yours to blockade.', {
        hint: 'A Blockade turns your territory neutral with multiplied armies — it gives the territory away.',
      });
    }
    if (kind !== 'Blockade' && hasTarget) {
      throw new McpToolError(`A ${card.name} card takes no target.`, { hint: 'Only Blockade takes a `target`.' });
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
    const play: ResolvedCardPlay = { card, kind, armies };
    if (hasTarget) {
      const t = resolveTerritory(map, input.target!);
      play.target = { id: t.id, name: t.name };
    }
    out.push(play);
  }
  return out;
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

/** Earlier turns that, when all cached, make the GameFeed history read unnecessary. */
const TREND_TURNS = 2;

/** My earlier boards of a game and the previous turn's board, as {@link boardHistory} reads them. */
export interface BoardHistory {
  /** My views of turns before the one being played, oldest first (GameFeed history, else the cache). */
  boards: TurnBoard[];
  /** Turn − 1's board and where it came from, for the planner's threat trend. */
  previous?: { source: TrendSource; board: BoardState };
}

/**
 * My earlier boards of a game, best effort: for each of the last {@link CACHED_TURNS} turns
 * before `turn`, GameFeed's `GetHistory` standing when the feed sends one (unverified for
 * games in progress), else the board this server cached when it planned or tracked that turn.
 * Empty otherwise; never throws.
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
  const boards = [...byTurn].sort(([a], [b]) => a - b).map(([t, b]) => ({ turn: t, board: b.board }));
  const previous = byTurn.get(turn - 1);
  return { boards, ...(previous ? { previous } : {}) };
}

export function registerTurnTools(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_plan_turn',
    {
      title: 'Plan my turn in a war.app game',
      description: untrustedDescription(
        'Plan one turn for you in an in-progress war.app (Warzone) game from the live board, the map and the ' +
          "game's settings: your income, deploys and attacks/transfers by territory name and id, the expected " +
          'captures, completed bonuses and next income (when the plan concedes borders of a bonus it holds, also ' +
          '`nextIncomeIfConcededFall` — the next income if those borders fall — and `bonusesAtRisk`), warnings (threats, fog, luck) and the reasoning. Threat ' +
          'checks assume each enemy deploys `enemy_deploy` (default per opponent: base income plus the bonuses it visibly holds, capped by its largest stack next to you, or what it was observed to deploy since the previous turn when larger: territories visible both turns only, never more than it could earn). It reports ' +
          'your cards and whether you must play or discard (more whole cards than the hold limit), and plays ' +
          'Reinforcement cards (their armies are planned) and, when cards must go, Order Priority, else discards the ' +
          'lowest-value cards — never playing Blockade or Order Delay. Its ' +
          '`orders` array is exactly what warapp_submit_turn takes — review it with the user first. Every plan reads ' +
          'the game profile (`profile`: format 1v1/ffa/teams, phase opening/expansion/contact/late, standing ' +
          'ahead/even/behind/unknown by your income against the strongest opponent\'s estimate — under heavy fog, its tracked ' +
          'income when every opponent has one (`standingSource` "tracked"); `full` adds the ' +
          'settings and notes). With no `goal`, the profile picks it (`goalSource` "profile"): defend when behind on income in an FFA or team game, ' +
          'else balanced (behind on income in a 1v1 means strike: break their bonuses before expansion that completes nothing), tuned — in a 1v1 in contact breaking an enemy bonus counts like completing one and ' +
          'expansion that completes nothing ranks below holds and breaks; in an FFA with two or more opponents left ' +
          'no second front (a player threatening none of your bonuses is not attacked while a neutral of similar ' +
          'value exists; finishing one off still is); behind, attacks are sized at the minimum; behind on armies in a 1v1, no capture of ' +
          "a player's territory that loses more armies than it kills; in a 1v1, spare deploys build one strike stack on the border " +
          'facing the opponent, which attacks every adjacent enemy territory it can take (bonus breaks and retakes first) while ' +
          `keeping what holds it; ahead in a 1v1, fog ` +
          `pressure is allowed up to ${AHEAD_PRESSURE_FACTOR}× a typical neutral capture. An explicit \`goal\` overrides the ` +
          'profile (the rationale says so). Goals: "balanced" (default) — the profile\'s base — ' +
          'spends income where it earns most per army — holding borders that protect income, completing ' +
          'cheap bonuses, breaking enemy bonuses (also ones the opponent tracker infers behind the fog, "probable"; a break is sized to land, ' +
          'not to survive the counter-attack, and is worth their lost income plus what retaking costs them), counter-attacking a stack that ' +
          'shrank fighting you — with at least 30% on expansion (`full` lists the offensive options in `offence`); "expand" takes neutrals and never ' +
          'attacks players; "complete-bonus" also attacks players to finish bonuses; "defend" reinforces threatened ' +
          'borders worth holding before anything else. Under balanced/defend, an opponent whose every territory is ' +
          'visible and borders yours is attacked at once when, whatever way it splits its one estimated deploy to ' +
          'save territories, that still eliminates it or cuts it to one territory (or takes at least half); a ' +
          'pressure plan may leave some of its territories unattacked. One next to the fog is never called ' +
          'eliminated, but all its visible territories are attacked as pressure (each sized for its full deploy plus a margin) ' +
          `when each costs at most ${PRESSURE_FACTOR}× a typical neutral capture; one visible territory too costly blocks the pressure on all of them. ` +
          'This runs before any border facing it is ' +
          'conceded (holds worth paying for against other players are funded first). Hopeless borders are listed in `conceded` and get no ' +
          'deploys (unless every territory you hold is conceded); under balanced/defend their armies withdraw, and `cardAdvice` "order-priority" means play Order ' +
          'Priority so the withdrawal runs before the border falls (or, in a Commanders game, so a strike on an enemy commander resolves before attacks on yours); when you hold one, `orders` already plays it. ' +
          'A held bonus\'s border short of a sure hold by a near ' +
          'miss (at most 2 armies or 15%), or still holding against the expected attack, is funded with everything left ' +
          'instead (a warning says it may fall) and never withdrawn. A bonus whose new frontier would fall next turn is ' +
          'not completed under balanced/defend (a warning says so). A neutral no single stack can afford may be taken by ' +
          'several attacks in a fixed order (`multiSourceCaptures`; 0% luck only). Every capture pays for the borders it adds (those ' +
          'facing an enemy at what they need to hold), so closing a gap beats opening a front; `frontier` reports the borders left, those facing an enemy, ' +
          'what they need next turn to hold and the next income, and under balanced/defend expansion that adds enemy borders without completing a bonus ' +
          'stops when that need outgrows the income. Enemy stacks next to you that grew since the previous turn raise the threat by their ' +
          'growth; the previous board comes from the game history when war.app sends it, else from the board this ' +
          'server last planned on (`trendSource` says which, or null). Obeys the game\'s rules: every attack and ' +
          "threat is sized at the game's kill rates; every attack carries `winChance`, its exact probability of " +
          'capturing (kill rates, luck and rounding; 1 when certain), and `min_win_chance` below 1 sizes captures ' +
          'for that chance instead of a guarantee. An attack is topped up to its next efficient size (one more kill ' +
          'for sure) from armies that would sit idle when its target is a player\'s or it is not certain, and the ' +
          "reasoning names attacks whose extra armies add no kill. Under Local Deployment a held bonus's armies are deployed only " +
          'inside that bonus; under No-Split each territory issues at most one attack or transfer. ' +
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
              'income plus the bonuses it visibly holds in full, at most 75% of its largest stack next to you but ' +
              'never below the game\'s base income (at least 5); just that base income on an untouched opening ' +
              'board; when the previous turn\'s board is known, at least what that opponent was observed to deploy ' +
              '(the net change of its armies on territories visible both turns plus what its captures cost it; a fog reveal is not income, and it never exceeds its base plus every bonus it could hold) — income in the fog is unseen, so raise it if you know they earn more.',
          ),
        min_win_chance: z.coerce
          .number()
          .min(0.5)
          .max(1)
          .optional()
          .describe(
            'The least win chance each ordinary capture is sized for, 0.5–1. Default 1: the guaranteed sizing (the ' +
              'luck-free share alone takes it). Below 1, each capture gets the fewest armies whose exact win chance ' +
              '(game kill rates, luck, rounding) reaches it — cheaper, but it can fail. Attacks sized for a worst case ' +
              '(finishing a player off, fog pressure, commander strikes) stay guaranteed.',
          ),
        view: viewArg(
          VIEWS,
          'compact (default) gives the plan and orders (the profile as format, phase and standing); "full" adds each ' +
            'move\'s reason, the whole profile and the settings the plan assumed.',
        ),
      }),
    },
    async ({ game_id, player, goal, focus, reserve, enemy_deploy, min_win_chance, view }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      requireTurnPhase(game);
      const map = mapOf(game);
      const focusBonusIds = (focus ?? []).map((b) => resolveBonus(map, b).id);
      const turn = currentTurn(game);
      // The signed-in account, the live board and the board history are independent reads: in
      // parallel, not in series (#131). Accepted trade-offs of not serializing them: when the board
      // read fails, a history read already under way still reaches GameFeed after the tool has
      // returned (one wasted, harmless read; boardHistory never throws); and when the account and
      // board reads both fail, whichever fails first is the error reported (each is a true error).
      const meRead = resolveMe(ctx, game.players, player);
      const [me, { territories, info }, history] = await Promise.all([
        meRead,
        loadLiveGame(ctx, game),
        meRead.then((m) => boardHistory(ctx, game, m, turn)),
      ]);
      const graph = graphOf(map);
      const board = boardStateFromLive(territories, me, game.players);
      const settings = plannerSettings(game.settings);
      const rules = cardRules(game.settings);
      const hand = readHand(info, inGameId(me));
      const cards = chooseCardPlays(hand, rules);
      const income = incomeFor(graph, board, me.id, game.settings) + cards.extraArmies;
      const trend = history.previous;
      // The opponents over my board history: one observed over 2+ turns gets its tracked income;
      // one still playing with nothing in view gets a received lower bound and a warning (#94).
      const tracks =
        turn !== null
          ? trackOpponents(graph, [...history.boards, { turn, board }], me.id, settings, trackGame(game.players, game.settings, map))
          : undefined;
      // Players still in the game besides me (a break is worth less when the bonus's loss is shared).
      const opponents = game.players.filter((p) => p.id !== me.id && (p.state ?? 'Playing') === 'Playing').length;
      const plan = planTurn({
        graph,
        board,
        me: me.id,
        income,
        cardArmies: cards.extraArmies,
        settings,
        ...(trend ? { previousBoard: trend.board } : {}),
        ...(turn !== null ? { turn } : {}),
        game: {
          players: game.players.map((p) => ({
            id: p.id,
            ...(p.team !== undefined ? { team: p.team } : {}),
            ...(p.state !== undefined ? { state: p.state } : {}),
          })),
          turn,
          ...(game.settings?.fog !== undefined ? { fog: game.settings.fog } : {}),
          ...(game.settings?.commanders !== undefined ? { commanders: game.settings.commanders } : {}),
          cards: rules.inPlay.length > 0,
        },
        ...(tracks ? { tracks } : {}),
        options: {
          // No goal: the game profile picks it and tunes the plan (an explicit goal overrides it).
          adapt: true,
          ...(goal !== undefined ? { goal } : {}),
          focusBonusIds,
          ...(opponents > 0 ? { opponents } : {}),
          holdsOrderPriority: holdsOrderPriority(hand, cards),
          ...(reserve !== undefined ? { reserve } : {}),
          ...(enemy_deploy !== undefined ? { enemyDeploy: enemy_deploy } : {}),
          ...(min_win_chance !== undefined ? { minWinChance: min_win_chance } : {}),
        },
      });
      if (ctx.dataDir && turn !== null) await writeBoardCache(ctx.dataDir, game.id, me.id, turn, board);
      const name = namer(map);
      const warnings = [
        ...(me.hasCommittedOrders
          ? [
              'You have already committed orders this turn; warapp_submit_turn will refuse until you withdraw them ' +
                'with warapp_uncommit_turn (or modify orders in the game).',
            ]
          : []),
        ...cards.warnings,
        ...(cards.extraArmies > 0 ? [cardIncomeNote(income, cards.extraArmies)] : []),
        ...deployCheckUncertainties(game.settings).map((r) => `Income ${income} may be off: ${r}`),
        ...(tracks ?? []).flatMap((t) => t.warnings),
        ...plan.warnings,
      ];
      // The plan advises Order Priority (a withdrawal, a commander strike): play the one I
      // hold, so the orders as returned carry it rather than only the advice.
      const advised = plan.cardAdvice === 'order-priority' ? advisedOrderPriority(hand, cards) : undefined;
      const plays = advised ? [...cards.plays, advised] : cards.plays;
      const orders = [
        ...cards.discards.map((c) => ({ kind: 'discard' as const, card: c.id })),
        ...plays.map((c) => ({ kind: 'card' as const, card: c.id })),
        ...plan.deploys.map((d) => ({ kind: 'deploy' as const, territory: d.territoryId, armies: d.armies })),
        ...plan.moves.map((m) => ({ kind: 'move' as const, from: m.from, to: m.to, armies: m.armies })),
      ];

      return respond(view, VIEWS, (rung) => ({
        game: { id: game.id, name: game.name ?? null, turn: currentTurn(game) },
        player: { id: me.id, name: me.name },
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
              },
        income,
        enemyDeploy: plan.enemyDeploy,
        trendSource: trend?.source ?? null,
        conceded: plan.conceded.map(name),
        cardAdvice: plan.cardAdvice,
        multiSourceCaptures: plan.multiSourceCaptures.map(name),
        // #71: the frontier budget, one line on compact.
        frontier:
          rung === 'full'
            ? plan.frontier
            : `${plan.frontier.borders} borders (${plan.frontier.enemyBorders} facing an enemy): holding them next turn needs ${plan.frontier.holdCost}, next income ${plan.frontier.income}${
                plan.expected.nextIncomeIfConcededFall !== undefined &&
                plan.expected.nextIncomeIfConcededFall < plan.frontier.income
                  ? `, ${plan.expected.nextIncomeIfConcededFall} if the conceded borders fall`
                  : ''
              }`,
        // #72: the offensive options considered, full view only.
        ...(rung === 'full' ? { offence: plan.offence.map((o) => ({ ...o, target: name(o.target) })) } : {}),
        cards: {
          hand: hand.map(cardView),
          maxCardsHold: rules.maxCardsHold ?? null,
          playRequired: cards.required,
          plays: plays.map(cardView),
          discards: cards.discards.map(cardView),
          armiesFromCards: cards.extraArmies,
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
        warnings,
        rationale: plan.rationale,
        orders,
        ...(rung === 'full'
          ? {
              settings: {
                ...settings,
                allowTransferOnly: settings.allowTransferOnly ?? true,
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
    orders: turnOrdersArg.describe(
      'The turn\'s orders (card plays and discards, deploys and attacks/transfers), territories by id or name, cards by id or type ' +
        'name — e.g. the `orders` array warapp_plan_turn returns. Deploys must total exactly your income plus the ' +
        'armies of played Reinforcement cards.',
    ),
  });

  withToolConfig(
    server,
    {
      title: 'Submit my turn in a war.app game',
      _meta: mintMeta('change', ['submit my turn', 'commit orders', 'send my orders', 'end my turn']),
    },
    () =>
      registerWrite(
        server,
        defineWrite({
          name: 'warapp_submit_turn',
          description:
            'Commit your orders for the current turn of a war.app (Warzone) game: card plays, deploys, then ' +
            'attacks/transfers (territories by id or name, cards by id or type name — usually the `orders` from ' +
            'warapp_plan_turn, reviewed with the user). Plays Reinforcement, Order Priority, Order Delay and Blockade ' +
            '(with a `target` of yours) from your hand, and discards any card (`{ kind: "discard", card }`); refuses ' +
            'when your hand is over the hold limit and the orders do not play or discard enough cards. The ' +
            'orders reach the game and cannot be withdrawn here; when the turn resolves, other players see the results. ' +
            'Validated against the live board first: deploys on and moves from your own territories, moves to ' +
            'adjacent ones, no more armies than a territory has, deploys totalling exactly your income plus played ' +
            'Reinforcement armies (only a preview warning when a setting such as an army cap makes the modelled ' +
            'income uncertain); under Local Deployment, each held bonus\'s armies deployed inside that bonus; under ' +
            'No-Split, at most one attack or transfer per territory (warapp_plan_turn obeys these and the kill rates). ' +
            'Always sent as ' +
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
          async plan({ game_id, player, orders }) {
            const game = await ctx.client.getGame(parseGameId(game_id), { settings: true });
            requireTurnPhase(game);
            const me = await requireSignedInMe(ctx, game, player);
            if (me.hasCommittedOrders) {
              throw new McpToolError(`You have already committed orders for this turn of game ${game.id}.`, {
                hint:
                  'To change them, withdraw them first with warapp_uncommit_turn (confirm-gated), then submit again — ' +
                  'or use "Modify orders" in the game itself; this tool does not replace committed orders.',
              });
            }
            const turnNumber = currentTurn(game);
            if (turnNumber === null || game.numberOfTurns === undefined) {
              throw new McpToolError(`GameFeed did not say how many turns game ${game.id} has had, so the turn number is unknown.`, {
                hint: 'Retry in a moment; no orders were sent.',
              });
            }
            const map = mapOf(game);
            const deploys: Array<{ territory: { id: number; name: string }; armies: number }> = [];
            const moves: Array<{ from: { id: number; name: string }; to: { id: number; name: string }; armies: number }> = [];
            const cardInputs: Array<{ card: string; target?: string | number | undefined }> = [];
            const discardInputs: Array<{ card: string }> = [];
            for (const o of orders) {
              if (o.kind === 'card') {
                cardInputs.push({ card: o.card, target: o.target });
              } else if (o.kind === 'discard') {
                discardInputs.push({ card: o.card });
              } else if (o.kind === 'deploy') {
                const t = resolveTerritory(map, o.territory);
                deploys.push({ territory: { id: t.id, name: t.name }, armies: o.armies });
              } else {
                const f = resolveTerritory(map, o.from);
                const t = resolveTerritory(map, o.to);
                moves.push({ from: { id: f.id, name: f.name }, to: { id: t.id, name: t.name }, armies: o.armies });
              }
            }
            const { territories, info } = await loadLiveGame(ctx, game);
            const board = boardStateFromLive(territories, me, game.players);
            const playerId = inGameId(me);
            const rules = cardRules(game.settings);
            const hand = readHand(info, playerId);
            const plays = resolveCardPlays(map, hand, rules, cardInputs);
            const discards = resolveDiscards(hand, plays, discardInputs);
            // Every play and discard takes its card out of the hand; war.app refuses (error 51) while more
            // than MaxCardsHold remain (verified, #20).
            const shed = cardsToShed(hand, rules);
            if (plays.length + discards.length < shed) throw mustPlayCard(hand, rules, shed, plays.length + discards.length);
            for (const p of plays) {
              const t = p.target && territories.find((x) => x.territoryId === p.target!.id);
              if (p.target && (!t || t.fogged || t.owner !== playerId)) {
                throw new McpToolError(`${label(p.target)} is not yours at the start of this turn, so it cannot be blockaded.`, {
                  hint: 'A Blockade targets a territory you hold on the live board (warapp_get_live_board).',
                });
              }
            }
            const income =
              incomeFor(graphOf(map), board, me.id, game.settings) + plays.reduce((sum, p) => sum + p.armies, 0);
            const { warnings } = validateTurn({
              map,
              board: territories,
              myInGameId: playerId,
              income,
              guard: game.settings?.oneArmyStandsGuard ?? true,
              deploys,
              moves,
              localDeployments: game.settings?.localDeployments ?? false,
              noSplit: game.settings?.noSplit ?? false,
              unplayedReinforcements: hand.flatMap((c) => {
                if (c.type !== CARD_REINFORCEMENT || plays.some((p) => p.card.id === c.id)) return [];
                const armies = reinforcementArmies(c, rules);
                return armies === undefined ? [] : [{ id: c.id, armies }];
              }),
              incomeUncertain: deployCheckUncertainties(game.settings),
              poolsUncertain: overrideUncertainties(game.settings),
            });
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
              })),
              ...[...merged.values()].map((d) => ({ kind: 'deploy' as const, territoryId: d.territory.id, armies: d.armies })),
              ...moves.map((m) => ({ kind: 'move' as const, from: m.from.id, to: m.to.id, armies: m.armies })),
            ];
            const named: NamedOrder[] = [
              ...discards.map((c) => ({ kind: 'discard' as const, card: cardView(c) })),
              ...plays.map((p) => ({ kind: 'card' as const, card: cardView(p.card), ...(p.target ? { target: p.target } : {}) })),
              ...[...merged.values()].map((d) => ({ kind: 'deploy' as const, territory: d.territory, armies: d.armies })),
              ...moves.map((m) => ({ kind: 'move' as const, from: m.from, to: m.to, armies: m.armies })),
            ];
            return {
              gate: {
                action: 'warapp.submit_turn',
                summary: `Commit ${send.length} order${send.length === 1 ? '' : 's'} for ${me.name} in game ${game.id}, turn ${turnNumber}`,
                account: undefined,
                target: game.id,
                payload: { method: 'SendOrders', gameId: game.id, playerId, turnNumber, orders: send },
                willSend: { game: game.id, player: me.name, turn: turnNumber, income, orders: named },
                preview: {
                  note: 'These orders reach the game; once the turn resolves, other players see the results.',
                  ...(warnings.length ? { warnings } : {}),
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
              } satisfies TurnState,
            };
          },
          async execute(st: TurnState) {
            const base = { game: st.gameId, turn: st.turnNumber, orders: st.named };
            const check =
              'Check warapp_get_game (turn count, your committed flag) or warapp_get_live_board. Do not resend these ' +
              'orders blindly — a second commit for the same turn is not known to be safe.';
            try {
              // The reply's bool is war.app's "vacation ended" flag — never a success signal.
              await ctx.rpc.call('SendOrders', Method.SendOrders, (w) =>
                writeSendOrdersParams(w, st.gameId, st.playerId, st.orders, st.turnNumber),
              );
            } catch (e) {
              // war.app refused them (e.g. 11: deploys ≠ income; 208: the turn already advanced): nothing committed.
              if (e instanceof WarappServerError && e.code === 11) throw incomeRefused(e, st.income);
              if (e instanceof WarappServerError) throw e;
              return {
                status: 'unknown' as const,
                ...base,
                warning:
                  `war.app did not confirm these orders (${e instanceof Error ? e.message : String(e)}), so they may ` +
                  `already have been committed. ${check}`,
              };
            }
            let after: Game;
            try {
              after = await ctx.client.getGame(st.gameId);
            } catch (e) {
              return {
                status: 'unknown' as const,
                ...base,
                warning: `The orders were sent, but re-reading the game failed (${e instanceof Error ? e.message : String(e)}). ${check}`,
              };
            }
            if (after.numberOfTurns !== undefined && after.numberOfTurns > st.turnsBefore) {
              return { status: 'resolved' as const, ...base, detail: `The turn resolved: the game is now on turn ${after.numberOfTurns + 1}.` };
            }
            if (after.players.find((p) => p.id === st.feedPlayerId)?.hasCommittedOrders) {
              return { status: 'committed' as const, ...base, detail: 'Your orders are committed; the turn resolves when every player has committed.' };
            }
            return {
              status: 'unknown' as const,
              ...base,
              warning: `The orders were sent, but the game does not yet show them committed or the turn advanced. ${check}`,
            };
          },
          render: (r) => respond(undefined, ['compact'], () => r),
          batchable: false,
        }),
      ),
  );
}
