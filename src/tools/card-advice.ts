// The card advice warapp_plan_turn adds to a plan (#163): the game around the hand (team, fog,
// players), the team's hand, Order Delay's place, my Bomb and Emergency Blockade, the
// opponents' Bomb and Emergency Blockade when they can hold one, the cards in effect
// (Diplomacy, Sanctions), and (PLAN-TEAMS D2) where to play my Diplomacy, Sanctions, Airlift and
// Gift. Read-only; everything here is advice — of these only the advised Order Delay is added to the
// orders; my Bomb and Emergency Blockade and the D2 cards carry an `order` to pass to warapp_submit_turn.

import { adviseOrderDelay, CARD_BLOCKADE, CARD_ORDER_DELAY, CARD_REINFORCEMENT, isMyCard, readActiveCards, type Card, type CardChoice, type CardGame } from '../cards.js';
import { blockadeOffer, bombAdvice, bombExposure, wallOffer, wallThreats, type CardBoard } from '../analysis/card-threats.js';
import { bonusTerritories } from '../analysis/bonuses.js';
import { diplomacyOpponents, supportAdvice, type SupportView } from './card-support-advice.js';
import type { TruceCover } from '../analysis/card-support.js';
import type { ReinforcementClock, TurnPlan } from '../analysis/planner.js';
import { inGameId } from '../live.js';
import type { Game, GameSettings, Player } from '../normalize.js';
import { capturePieceValue, cardClock } from '../strategy/card-clock.js';
import { isTeamGame, teammatesOf as teamOf } from '../teams.js';

const CARD_BOMB = 13;
const CARD_EMERGENCY_BLOCKADE = 3;
const CARD_DIPLOMACY = 8;

/** The game around my hand, for the card policy; in a team game with `me`, my in-game id (V8). */
export function cardGame(game: Pick<Game, 'players' | 'settings'>, me?: Player): CardGame {
  const team = isTeamGame(game.players);
  let id: number | undefined;
  if (team && me) {
    try {
      id = inGameId(me);
    } catch {
      // No in-game id: every card counts as mine, as before.
    }
  }
  return {
    players: game.players.length,
    team,
    ...(game.settings?.fog !== undefined ? { fog: game.settings.fog } : {}),
    ...(id !== undefined ? { me: id } : {}),
  };
}

/** My teammates (never me), by GameFeed player. Empty outside a team game. */
const teammatesOf = (game: Pick<Game, 'players'>, me: Player): Player[] => teamOf(game.players, me);

/**
 * The in-game ids whose cards are my hand: mine, and in a team game my teammates' (a team shares
 * one hand; how war.app keys it is unverified, #163).
 */
export const handOwners = (game: Pick<Game, 'players'>, me: Player): number[] => [
  inGameId(me),
  ...teammatesOf(game, me).flatMap((p) => {
    try {
      return [inGameId(p)];
    } catch {
      return []; // not a GameFeed player id: no in-game id to read cards under
    }
  }),
];

/** In a team game: the hand and the limit are the team's (said once in the plan's warnings). */
export const TEAM_HAND =
  "This is a team game: the hand and the card limit are the team's, shared with your teammates. The hand shown " +
  "is every card under you and your teammates (war.app keeps each player's cards under that player's id), and war.app " +
  'refuses only the last of the team to commit while the team is over the limit: agree in team chat who sheds.';

/** A card setting's `MultiplyAmount` (Blockade, Emergency Blockade), when the game sets one. */
function multiplier(settings: GameSettings | undefined, key: string): number | undefined {
  const r = settings?.raw[key];
  if (typeof r !== 'object' || r === null) return undefined;
  const m = Number((r as Record<string, unknown>).MultiplyAmount);
  return Number.isFinite(m) && m > 0 ? m : undefined;
}

/**
 * Whether an opponent can hold `card` this turn: the card is in play and the card clock lets it
 * be in a hand by `turn` (unknown turn: yes).
 */
export function opponentCanHold(settings: GameSettings | undefined, card: string, turn: number | null): boolean {
  const entry = cardClock(settings)?.cards.find((c) => c.card === card);
  if (!entry) return false;
  const first = entry.firstPlayableTurn.fastest;
  return first !== null && (turn === null || turn >= first);
}

interface CardAdviceView extends SupportView {
  /**
   * `before` is 1-based among the plan's moves (its `orders` moves, in order); `order` is the card
   * order to pass to warapp_submit_turn as is (#186: that placement is UNVERIFIED live).
   * `insteadOfDiscard`: the card had to leave the hand, and is played here rather than discarded.
   */
  orderDelay?: {
    card: string;
    before: number;
    attacks: number[];
    order: { kind: 'card'; card: string; before: number };
    insteadOfDiscard?: true;
  };
  /** `order`, only with a target: the card order to pass to warapp_submit_turn (encoding UNVERIFIED live, V9). */
  bomb?: { target: number | null; kind: string | null; why: string; order?: { kind: 'card'; card: string; target: number } };
  emergencyBlockade?: {
    territory: number;
    givesUp: number;
    wall: number;
    player: number;
    reach: number;
    kills: number;
    /** #369: what the wall keeps the stack from next turn (my territories behind it, their bonuses, my commander). */
    protects: { territories: number[]; bonuses: { bonus: number; value: number }[]; income: number; commander: boolean };
    order: { kind: 'card'; card: string; target: number };
  };
  /**
   * #434: my Blockade on the one gate into held bonuses of mine the plan concedes (never on a member of one).
   * `order` to pass to warapp_submit_turn; never added to the orders.
   */
  blockade?: {
    territory: number;
    armies: number;
    wall: number;
    player: number;
    reach: number;
    /** The held bonuses behind it (every route from an enemy or the fog runs through it) and their income. */
    bonuses: number[];
    income: number;
    /** My territories behind it. */
    behind: number[];
    commander: boolean;
    order: { kind: 'card'; card: string; target: number };
  };
  active?: Array<{ card: string; players?: number[]; target?: number; playedBy?: number; expiresAfterTurn?: number; untilTurn?: number }>;
}

export interface CardAdviceInput {
  game: Pick<Game, 'players' | 'settings'>;
  me: Player;
  turn: number | null;
  info: unknown;
  hand: readonly Card[];
  choice: CardChoice;
  plan: Pick<TurnPlan, 'deploys' | 'moves' | 'moveSlots' | 'enemyDeploy' | 'conceded'> & Partial<Pick<TurnPlan, 'profile' | 'team'>>;
  board: CardBoard['board'];
  graph: CardBoard['graph'];
  settings: CardBoard['settings'];
  /** A territory's label for the warnings. */
  label: (id: number) => string;
  /** Territories of a truce partner the truce covers (active or in notice): never a Bomb target. */
  truceCovered?: ReadonlySet<number>;
  /** The truces in force (active or in notice): Diplomacy goes on a covered partner only when it adds protection. */
  truces?: readonly TruceCover[];
  /** PLAN-TEAMS D3: players a Diplomacy card in effect makes no foe in the plan (the decoder was sure of it). */
  enforced?: ReadonlySet<number>;
  /** PLAN-TEAMS D3: the plan's income already carries the Sanctions on me. */
  sanctionsApplied?: boolean;
}

/**
 * The card advice and warnings for a plan. Pure apart from reading the decoded board; the plan's
 * orders are never changed.
 */
export function adviseCards(input: CardAdviceInput): { view: CardAdviceView; warnings: string[] } {
  const { game, me, turn, hand, choice, plan, label } = input;
  const view: CardAdviceView = {};
  const warnings: string[] = [];
  // V8 (#310): in a team game a card read under a teammate's id is left to them, never advised to me.
  const own = hand.filter((c) => isMyCard(c, cardGame(game, me).me));
  const gone = new Set([...choice.plays, ...choice.discards].map((c) => c.id));
  const held = (type: number) => own.find((c) => c.type === type && !gone.has(c.id));
  const friends = new Set(teammatesOf(game, me).map((p) => p.id));
  // The cards in effect (unverified decoding), by GameFeed id: read once, for the Bomb's peace and the warnings below.
  const active = readActiveCards(input.info);
  const byInGame = new Map(game.players.flatMap((p) => {
    try {
      return [[inGameId(p), p] as const];
    } catch {
      return [];
    }
  }));
  const feed = (id: number | undefined) => (id === undefined ? undefined : byInGame.get(id)?.id);
  const activeView = active.map((a) => ({
    card: a.card,
    ...(a.players ? { players: a.players.map((p) => feed(p) ?? p) } : {}),
    ...(a.target !== undefined ? { target: feed(a.target) ?? a.target } : {}),
    ...(a.playedBy !== undefined ? { playedBy: feed(a.playedBy) ?? a.playedBy } : {}),
    ...(a.expiresAfterTurn !== undefined ? { expiresAfterTurn: a.expiresAfterTurn } : {}),
    ...(a.untilTurn !== undefined ? { untilTurn: a.untilTurn } : {}),
  }));
  // #452: the players at peace with me — a Diplomacy card in force (decoded, or the plan's T9 set) or a
  // binding truce — whose territories the Bomb advice passes over, as the Sanctions and Diplomacy advice do.
  const peace = new Set<number>([
    ...activeView.flatMap((a) => (a.card === 'Diplomacy' && a.players?.includes(me.id) ? a.players.filter((p) => p !== me.id) : [])),
    ...(input.enforced ?? []),
    ...(input.truces ?? []).map((t) => t.player),
  ]);
  const cb: CardBoard = {
    graph: input.graph,
    board: input.board,
    me: me.id,
    friends,
    ...(input.truceCovered?.size ? { noBomb: input.truceCovered } : {}),
    ...(peace.size ? { peace } : {}),
    deploys: plan.deploys,
    moves: plan.moves,
    enemyDeploy: plan.enemyDeploy,
    ...(input.settings ? { settings: input.settings } : {}),
  };
  const moveLabel = (k: number) => {
    const m = plan.moves[k - 1]!;
    return `${label(m.from)} → ${label(m.to)}`;
  };

  // Order Delay: above every order that is not urgent, when an attack the opponent can answer is planned.
  // #163: an Order Delay that must leave the hand is played where the plan can use it, not discarded.
  const keepDelay = { ...choice, discards: choice.discards.filter((c) => c.type !== CARD_ORDER_DELAY) };
  const delay = adviseOrderDelay(own, keepDelay, plan.moves, plan.moveSlots);
  if (delay) {
    const insteadOfDiscard = choice.discards.some((c) => c.id === delay.card.id);
    view.orderDelay = {
      card: delay.card.id,
      before: delay.before,
      attacks: delay.attacks,
      order: { kind: 'card', card: delay.card.id, before: delay.before },
      ...(insteadOfDiscard ? { insteadOfDiscard: true as const } : {}),
    };
    if (insteadOfDiscard) warnings.push('The Order Delay that had to leave the hand is played (below) instead of discarded.');
    warnings.push(
      `Play Order Delay above move ${delay.before}${delay.before <= plan.moves.length ? ` (${moveLabel(delay.before)})` : ''}: ` +
        `${delay.attacks.map(moveLabel).join(', ')} ${delay.attacks.length === 1 ? 'is an attack' : 'are attacks'} the opponent can answer first, ` +
        'and the orders after the card wait until the opponent has moved. The orders carry it (the card with `before`): ' +
        'war.app accepts a card placed among the moves (verified live); that the later moves then wait for the ' +
        "opponent's is read from the client, not yet seen in a replay. Drop it from the orders to keep the card.",
    );
  }

  const cards = game.settings?.cards ?? [];
  // My Bomb: a target where halving the stack changes the turn, else hold it.
  const bombCard = held(CARD_BOMB);
  if (bombCard) {
    const a = bombAdvice(cb);
    view.bomb = {
      target: a.target ?? null,
      kind: a.kind ?? null,
      why: a.why,
      ...(a.target !== undefined ? { order: { kind: 'card' as const, card: bombCard.id, target: a.target } } : {}),
    };
    warnings.push(
      a.target !== undefined
        ? `${a.why.replace(/^Bomb (\d+):/, (_, t) => `Bomb ${label(Number(t))}:`)} Advice only, not in the orders: pass \`cards.advice.bomb.order\` to warapp_submit_turn to play it (the encoding is read from the client, not yet verified live).`
        : a.why,
    );
  }
  // An opponent's Bomb: the borders that hold only while unbombed.
  if (cards.includes('Bomb') && opponentCanHold(game.settings, 'Bomb', turn)) {
    const exposed = bombExposure(cb);
    if (exposed.length) {
      warnings.push(
        `If an opponent plays a Bomb, ${exposed
          .map((e) => `${label(e.territory)}${e.commander ? ' (your commander)' : ''} (${e.armies} → ${e.bombed}) falls to player ${e.player}'s ~${e.reach}`)
          .join('; ')}: a bomb halves a stack after the deploys and before any move. Spread the stack over two territories, ` +
          'or deploy one step back and move up (the bomb lands before the move).',
      );
    }
  }
  const ebMultiplier = multiplier(game.settings, 'EmergencyBlockadeCard');
  if (cards.includes('EmergencyBlockade') || cards.includes('Emergency Blockade')) {
    // An opponent's Emergency Blockade: planned attacks that would die against the wall.
    if (ebMultiplier !== undefined && opponentCanHold(game.settings, 'Emergency Blockade', turn)) {
      for (const w of wallThreats(cb, ebMultiplier)) {
        warnings.push(
          `The attack on ${label(w.target)} (${w.attackers} armies) would die against an Emergency Blockade: player ${w.player} can turn it ` +
            `into a neutral of (its armies + its deploy) × ${ebMultiplier} ≈ ${w.wall} before the attacks.`,
        );
      }
    }
    // My Emergency Blockade: a conceded border where the wall kills more than I give up.
    const wallCard = held(CARD_EMERGENCY_BLOCKADE);
    if (wallCard) {
      const offer = ebMultiplier !== undefined ? wallOffer(cb, ebMultiplier, plan.conceded) : undefined;
      if (offer) {
        view.emergencyBlockade = { ...offer, order: { kind: 'card', card: wallCard.id, target: offer.territory } };
        const bonusName = (id: number) => input.graph.map.bonuses.find((b) => b.id === id)?.name ?? `${id}`;
        const p = offer.protects;
        const shields = p.territories.length
          ? ` It shields ${p.territories
              .map((t) => {
                const of = p.bonuses.filter((b) => bonusTerritories(input.graph, b.bonus).includes(t));
                return `${label(t)}${of.length ? ` (${of.map((b) => `bonus ${bonusName(b.bonus)}, +${b.value} a turn`).join('; ')})` : ''}`;
              })
              .join(', ')}${p.commander ? ', where your commander stands,' : ''} from player ${offer.player}'s ~${offer.reach}, which can reach ${p.territories.length === 1 ? 'it' : 'them'} next turn only through the wall.`
          : '';
        warnings.push(
          `Consider an Emergency Blockade on ${label(offer.territory)}: the plan concedes it, and its ${offer.givesUp} armies × ${ebMultiplier} make a ` +
            `wall of ${offer.wall} that player ${offer.player}'s ~${offer.reach} would lose ~${offer.kills} attacking — if it attacks.${shields} ` +
            `It gives up ${label(offer.territory)} and its ${offer.givesUp} armies for good (it turns neutral). Advice only, not in the orders: pass \`cards.advice.emergencyBlockade.order\` ` +
            'to warapp_submit_turn to play it (the encoding is read from the client, not yet verified live).',
        );
      } else if (ebMultiplier === undefined) {
        warnings.push('You hold an Emergency Blockade, but the game does not say its multiplier, so no wall is sized for it.');
      }
    }
  }

  // #434: my Blockade on the one gate into held bonuses the plan concedes — never on a member of one.
  const blockadeCard = held(CARD_BLOCKADE);
  if (blockadeCard) {
    const bkMultiplier = multiplier(game.settings, 'BlockadeCard');
    const offer = bkMultiplier !== undefined ? blockadeOffer(cb, bkMultiplier, plan.conceded) : undefined;
    if (offer) {
      view.blockade = {
        territory: offer.territory,
        armies: offer.armies,
        wall: offer.wall,
        player: offer.player,
        reach: offer.reach,
        bonuses: offer.opens.bonuses,
        income: offer.opens.income,
        behind: offer.opens.ids,
        commander: offer.commander,
        order: { kind: 'card', card: blockadeCard.id, target: offer.territory },
      };
      const bonusName = (id: number) => input.graph.map.bonuses.find((b) => b.id === id)?.name ?? `${id}`;
      const into = [
        ...offer.opens.bonuses.map((b) => `bonus ${bonusName(b)} (+${input.graph.map.bonuses.find((x) => x.id === b)?.value ?? 0} a turn)`),
        ...(offer.commander ? ['your commander'] : []),
      ].join(' and ');
      warnings.push(
        `Consider a Blockade on ${label(offer.territory)}: the plan concedes it, and it is the only way into ${into} — every route from an enemy or the fog runs through it. ` +
          `Its ${offer.armies} armies after the plan × ${bkMultiplier} make a wall of ${offer.wall} that player ${offer.player}'s ~${offer.reach} cannot take. ` +
          `The wall forms at the end of the turn, so it holds only if ${label(offer.territory)} is still yours then, and it gives the territory and its armies away for good (it turns neutral). ` +
          'Advice only, not in the orders: pass `cards.advice.blockade.order` to warapp_submit_turn to play it.',
      );
    } else if (bkMultiplier === undefined) {
      warnings.push('You hold a Blockade, but the game does not say its multiplier, so no wall is sized for it.');
    }
  }

  // The cards in effect (unverified decoding): Diplomacy protecting a player, Sanctions on me.
  if (active.length) {
    view.active = activeView;
    const owner = (t: number) => {
      const o = input.board.territories.find((x) => x.territoryId === t)?.owner;
      return o?.kind === 'player' ? o.playerId : undefined;
    };
    for (const a of view.active) {
      const until = a.untilTurn !== undefined ? ` (until turn ${a.untilTurn})` : '';
      if (a.card === 'Diplomacy' && a.players?.includes(me.id)) {
        const other = a.players.find((p) => p !== me.id);
        const hit = plan.moves.filter((m) => m.kind === 'attack' && other !== undefined && owner(m.to) === other);
        // #424: its last turn (gone by the next): say so, and chain it with a Diplomacy card in hand —
        // outside a 1v1, where the support advice chains it too (a 1v1 is advised no Diplomacy).
        const last = turn !== null && a.untilTurn === turn + 1;
        warnings.push(
          `Diplomacy is in effect between you and player ${other}${until}: neither can attack the other.` +
            (other !== undefined && input.enforced?.has(other)
              ? ' The plan honours it (T9): no hold against that player and no attack on it.'
              : hit.length
                ? ` The plan's attacks on ${hit.map((m) => label(m.to)).join(', ')} would do nothing — drop or redirect them.`
                : '') +
            (last
              ? ` This is its last turn: from turn ${a.untilTurn} it can attack you again — ${
                  held(CARD_DIPLOMACY) && diplomacyOpponents(game, me.id, friends) >= 2
                    ? 'chain it: play your Diplomacy card on it this turn (it starts the turn after it is played), or ready the borders it faces.'
                    : 'ready the borders it faces.'
                }`
              : ''),
        );
      }
      if (a.card === 'Sanctions' && a.target === me.id) {
        const pct = (game.settings?.raw.SanctionsCard as Record<string, unknown> | undefined)?.Percentage;
        const cut = typeof pct === 'number' ? ` by ${Math.round(pct * 100)}%` : '';
        if (!input.sanctionsApplied)
          warnings.push(
            `Sanctions are on you${until}: your income is cut${cut}, which the modelled income does not apply — deploy what the game shows ` +
              '(warapp_submit_turn takes a lower total when Sanctions are in the game).',
          );
      }
    }
    warnings.push('Active cards are read from the live board by an unverified decoder (#163): check them in the game.');
  }

  // PLAN-TEAMS D2: my Diplomacy, Sanctions, Airlift and Gift — advice only, each with its order.
  const atPeace = new Set(
    (view.active ?? []).flatMap((a) => (a.card === 'Diplomacy' && a.players?.includes(me.id) ? a.players.filter((p) => p !== me.id) : [])),
  );
  // #424: the cards in force whose last turn this is (gone by the next): chained, not passed over.
  const lastTurn = new Set(
    (view.active ?? []).flatMap((a) =>
      a.card === 'Diplomacy' && a.players?.includes(me.id) && turn !== null && a.untilTurn === turn + 1 ? a.players.filter((p) => p !== me.id) : [],
    ),
  );
  const support = supportAdvice({ game, me, plan, cards: own.filter((c) => !gone.has(c.id)), cb, atPeace, lastTurn, truces: input.truces ?? [] });
  Object.assign(view, support.view);
  warnings.push(...support.warnings);
  return { view, warnings };
}

/**
 * #127: the planner's `cardPieceValue` — what a turn with a capture earns in card pieces
 * (`capturePieceValue`), a progressive Reinforcement card valued at the one in my hand. Empty when the
 * game does not say (no Reinforcement card in play, or a progressive one and none in hand).
 */
export function cardPieceOption(settings: GameSettings | undefined, hand: readonly Card[]): { cardPieceValue?: number } {
  const inHand = hand.find((c) => c.type === CARD_REINFORCEMENT && c.armies !== undefined && c.armies > 0)?.armies;
  const v = capturePieceValue(settings, inHand);
  return v.armies !== null && v.armies > 0 ? { cardPieceValue: v.armies } : {};
}

/**
 * #164: an opponent's Reinforcement card for the threat model: the first turn one can be in a hand
 * (the card clock's fastest), the armies it adds (a fixed card's `FixedArmies`, else the
 * Reinforcement card in my hand as it is worth now) and the capturing turns each further card
 * takes. `undefined` when no Reinforcement card is in play or what it adds is unknown.
 */
export function opponentReinforcement(settings: GameSettings | undefined, hand: readonly Card[]): ReinforcementClock | undefined {
  const entry = cardClock(settings)?.cards.find((c) => c.card === 'Reinforcement');
  const first = entry?.firstPlayableTurn.fastest;
  if (!entry || first === null || first === undefined) return undefined;
  const raw = settings!.raw.ReinforcementCard;
  const fixed = typeof raw === 'object' && raw !== null ? Number((raw as Record<string, unknown>).FixedArmies) : NaN;
  const inHand = hand.find((c) => c.type === CARD_REINFORCEMENT && c.armies !== undefined && c.armies > 0)?.armies;
  const armies = Number.isFinite(fixed) && fixed > 0 ? Math.floor(fixed) : inHand;
  if (armies === undefined || armies <= 0) return undefined;
  const after = entry.cardsAfter.fastest;
  const turnsPerCard = after && after.length >= 2 ? Math.max(1, after[1]! - after[0]!) : null;
  return { firstTurn: first, armies, turnsPerCard };
}
