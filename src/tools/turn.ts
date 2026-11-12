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
  CARD_REINFORCEMENT,
  cardRules,
  cardTypeByName,
  cardTypeName,
  chooseCardPlays,
  normalizeGuid,
  playRequired,
  readHand,
  reinforcementArmies,
  type Card,
  type CardRules,
} from '../cards.js';
import { incomeFor, neighborsOf, planTurn, type PlanGoal, type PlannerSettings } from '../analysis/index.js';
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
import { boardFromHistory, readBoardCache, writeBoardCache, type TrendSource } from '../trend.js';
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
  kind: 'deploy' | 'move' | 'card';
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
}

const label = (t: { id: number; name: string }) => `${t.name} (${t.id})`;

/** Validate resolved orders against the live board and income; throws a clear refusal on the first problem. */
export function validateTurn(args: {
  map: GameMap;
  board: readonly LiveTerritory[];
  myInGameId: number;
  income: number;
  guard: boolean;
  deploys: Array<{ territory: { id: number; name: string }; armies: number }>;
  moves: Array<{ from: { id: number; name: string }; to: { id: number; name: string }; armies: number }>;
}): void {
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
  const deployed = deploys.reduce((s, d) => s + d.armies, 0);
  if (deployed !== income) {
    throw new McpToolError(`These orders deploy ${deployed} armies, but your income is ${income} this turn.`, {
      hint: `Deploy exactly ${income} armies — war.app refuses any other total (error 11).`,
    });
  }
  const deployedOn = new Map<number, number>();
  for (const d of deploys) deployedOn.set(d.territory.id, (deployedOn.get(d.territory.id) ?? 0) + d.armies);
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
    const guid = normalizeGuid(input.card.trim());
    let card: Card | undefined;
    if (guid !== undefined) {
      card = hand.find((c) => c.id === guid);
      if (!card) {
        throw new McpToolError(`Card ${guid} is not in your hand.`, {
          hint: `Your hand: ${hand.length ? hand.map((c) => `${c.name} (${c.id})`).join(', ') : 'no cards'}.`,
        });
      }
      if (used.has(card.id)) {
        throw new McpToolError(`The ${card.name} card ${card.id} is played twice.`, { hint: 'Each card can be played once.' });
      }
    } else {
      const type = cardTypeByName(input.card);
      if (type === undefined) {
        throw new McpToolError(`No card type matches "${input.card}".`, {
          hint: 'Name a card by its id (GUID) or its type, e.g. "Reinforcement" or "Order Priority".',
        });
      }
      card = hand.find((c) => c.type === type && !used.has(c.id));
      if (!card) {
        throw new McpToolError(`You hold no ${cardTypeName(type)} card${hand.some((c) => c.type === type) ? ' left to play' : ''}.`, {
          hint: `Your hand: ${hand.length ? hand.map((c) => c.name).join(', ') : 'no cards'}.`,
        });
      }
    }
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
function mustPlayCard(hand: readonly Card[], rules: CardRules): McpToolError {
  return new McpToolError(`${SERVER_ERROR_MESSAGES[51]} (You hold ${hand.length}; the limit is ${rules.maxCardsHold}.)`, {
    hint: `Add a card play to the orders, e.g. { "kind": "card", "card": "${hand[0]?.name ?? 'Reinforcement'}" }. Your hand: ${hand
      .map((c) => `${c.name} (${c.id})`)
      .join(', ')}.`,
  });
}

const cardView = (c: Card) => ({ id: c.id, name: c.name, ...(c.armies !== undefined ? { armies: c.armies } : {}) });

/**
 * My view of the board one turn ago, for the planner's threat trend, best effort:
 * GameFeed's `GetHistory` standing for the previous turn if the feed sends one
 * (unverified for games in progress), else this server's cached board when it
 * was planned on exactly the previous turn. `undefined` otherwise; never throws.
 */
async function previousBoard(
  ctx: LiveContext,
  game: Game,
  me: Player,
  turn: number | null,
): Promise<{ source: TrendSource; board: BoardState } | undefined> {
  if (turn === null || turn < 2) return undefined;
  try {
    const withHistory = await ctx.client.getGame(game.id, { history: true });
    // `turn` is being played, so turn − 1 are done and the previous board is the one after turn − 2.
    const board = boardFromHistory(withHistory.history, turn - 2, game.players);
    if (board) return { source: 'history', board };
  } catch {
    // History is optional: fall through to the cache.
  }
  if (!ctx.dataDir) return undefined;
  const board = await readBoardCache(ctx.dataDir, game.id, me.id, turn - 1);
  return board ? { source: 'cache', board } : undefined;
}

export function registerTurnTools(server: McpServer, ctx: LiveContext): void {
  server.registerTool(
    'warapp_plan_turn',
    {
      title: 'Plan my turn in a war.app game',
      description: untrustedDescription(
        'Plan one turn for you in an in-progress war.app (Warzone) game from the live board, the map and the ' +
          "game's settings: your income, deploys and attacks/transfers by territory name and id, the expected " +
          'captures, completed bonuses and next income, warnings (threats, fog, luck) and the reasoning. Threat ' +
          'checks assume each enemy deploys `enemy_deploy` (default per opponent: base income plus the bonuses it visibly holds, capped by its largest stack next to you). It reports ' +
          'your cards and whether you must play one (hand at the hold limit), and plays Reinforcement cards (their ' +
          'armies are planned) and, when a play is required, Order Priority or Order Delay — never Blockade. Its ' +
          '`orders` array is exactly what warapp_submit_turn takes — review it with the user first. Goals: "balanced" ' +
          '(default) spends income where it earns most per army — holding borders that protect income, completing ' +
          'cheap bonuses, breaking enemy bonuses — with at least 30% on expansion; "expand" takes neutrals and never ' +
          'attacks players; "complete-bonus" also attacks players to finish bonuses; "defend" reinforces threatened ' +
          'borders worth holding before anything else. Hopeless borders are listed in `conceded` and get no ' +
          'deploys (unless every territory you hold is conceded); under balanced/defend their armies withdraw, and `cardAdvice` "order-priority" means play Order ' +
          'Priority so the withdrawal runs before the border falls. Enemy stacks next to you that grew since the previous turn raise the threat by their ' +
          'growth; the previous board comes from the game history when war.app sends it, else from the board this ' +
          'server last planned on (`trendSource` says which, or null). ' +
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
            'balanced (default): best income per army across holds, bonuses and breaking enemy bonuses; expand: take ' +
              'neutrals only; complete-bonus: also attack players to finish bonuses; defend: hold threatened borders first.',
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
              'income plus the bonuses it visibly holds in full, at least 5 and at most 75% of its largest stack ' +
              'next to you (5 each on an untouched opening board) — income in the fog is unseen, so raise it if ' +
              'you know they earn more.',
          ),
        view: viewArg(
          VIEWS,
          'compact (default) gives the plan and orders; "full" adds each move\'s reason and the settings the plan assumed.',
        ),
      }),
    },
    async ({ game_id, player, goal, focus, reserve, enemy_deploy, view }) => {
      const game = await ctx.client.getGame(game_id, { settings: true });
      requireTurnPhase(game);
      const map = mapOf(game);
      const focusBonusIds = (focus ?? []).map((b) => resolveBonus(map, b).id);
      const me = await resolveMe(ctx, game.players, player);
      const { territories, info } = await loadLiveGame(ctx, game);
      const graph = graphOf(map);
      const board = boardStateFromLive(territories, me, game.players);
      const settings = plannerSettings(game.settings);
      const rules = cardRules(game.settings);
      const hand = readHand(info, inGameId(me));
      const cards = chooseCardPlays(hand, rules);
      const income = incomeFor(graph, board, me.id, game.settings) + cards.extraArmies;
      const chosen: PlanGoal = goal ?? 'balanced';
      const turn = currentTurn(game);
      const trend = await previousBoard(ctx, game, me, turn);
      // Players still in the game besides me (a break is worth less when the bonus's loss is shared).
      const opponents = game.players.filter((p) => p.id !== me.id && (p.state ?? 'Playing') === 'Playing').length;
      const plan = planTurn({
        graph,
        board,
        me: me.id,
        income,
        settings,
        ...(trend ? { previousBoard: trend.board } : {}),
        options: {
          goal: chosen,
          focusBonusIds,
          ...(opponents > 0 ? { opponents } : {}),
          ...(reserve !== undefined ? { reserve } : {}),
          ...(enemy_deploy !== undefined ? { enemyDeploy: enemy_deploy } : {}),
        },
      });
      if (ctx.dataDir && turn !== null) await writeBoardCache(ctx.dataDir, game.id, me.id, turn, board);
      const name = namer(map);
      const warnings = [
        ...(me.hasCommittedOrders
          ? ['You have already committed orders this turn; warapp_submit_turn will refuse — modify orders in the game instead.']
          : []),
        ...cards.warnings,
        ...plan.warnings,
      ];
      const orders = [
        ...cards.plays.map((c) => ({ kind: 'card' as const, card: c.id })),
        ...plan.deploys.map((d) => ({ kind: 'deploy' as const, territory: d.territoryId, armies: d.armies })),
        ...plan.moves.map((m) => ({ kind: 'move' as const, from: m.from, to: m.to, armies: m.armies })),
      ];

      return respond(view, VIEWS, (rung) => ({
        game: { id: game.id, name: game.name ?? null, turn: currentTurn(game) },
        player: { id: me.id, name: me.name },
        goal: chosen,
        income,
        enemyDeploy: plan.enemyDeploy,
        trendSource: trend?.source ?? null,
        conceded: plan.conceded.map(name),
        cardAdvice: plan.cardAdvice,
        cards: {
          hand: hand.map(cardView),
          maxCardsHold: rules.maxCardsHold ?? null,
          playRequired: cards.required,
          plays: cards.plays.map(cardView),
          armiesFromCards: cards.extraArmies,
        },
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
  const submitSchema = z.object({
    game_id: gameIdArg,
    player: playerArg,
    orders: turnOrdersArg.describe(
      'The turn\'s orders (card plays, deploys and attacks/transfers), territories by id or name, cards by id or type ' +
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
            '(with a `target` of yours) from your hand; refuses with no card play when your hand is at the hold limit. The ' +
            'orders reach the game and cannot be withdrawn here; when the turn resolves, other players see the results. ' +
            'Validated against the live board first: deploys on and moves from your own territories, moves to ' +
            'adjacent ones, no more armies than a territory has, deploys totalling exactly your income plus played ' +
            'Reinforcement armies. Always sent as ' +
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
                hint: 'To change them, use "Modify orders" in the game itself; this tool does not replace committed orders.',
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
            for (const o of orders) {
              if (o.kind === 'card') {
                cardInputs.push({ card: o.card, target: o.target });
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
            if (plays.length === 0 && playRequired(hand, rules)) throw mustPlayCard(hand, rules);
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
            validateTurn({
              map,
              board: territories,
              myInGameId: playerId,
              income,
              guard: game.settings?.oneArmyStandsGuard ?? true,
              deploys,
              moves,
            });
            // Deploys first (as the client sends them), merged per territory.
            const merged = new Map<number, { territory: { id: number; name: string }; armies: number }>();
            for (const d of deploys) {
              const m = merged.get(d.territory.id);
              if (m) m.armies += d.armies;
              else merged.set(d.territory.id, { ...d });
            }
            const send: TurnOrder[] = [
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
