// Cards: the type table, my hand read from the live board, the game's card
// rules from GameFeed settings, and which cards the planner plays.
//
// VERIFIED 2026-11-12 (docs/PLAN-CARDS-PUSH.md): the hand is a dict GUID →
// card instance (`warlight.shared.ReinforcementCardInstance { guid, type,
// armies }`, `warlight.shared.NoParameterCardInstance { guid, type }`) under the
// player entry keyed by the in-game id. Field names are minified, so instances
// are found by type name and their fields by kind and read order, and the
// reader stays loose: an unexpected shape yields fewer cards, never an error.

import { currentStanding } from './live.js';
import type { GameSettings } from './normalize.js';
import { asInt } from './scalars.js';

/** Card type ids (the client's registry). */
export const CARD_TYPES: Readonly<Record<number, string>> = {
  1: 'Reinforcement',
  2: 'Spy',
  3: 'Emergency Blockade',
  4: 'Order Priority',
  5: 'Order Delay',
  6: 'Airlift',
  7: 'Gift',
  8: 'Diplomacy',
  9: 'Sanctions',
  10: 'Reconnaissance',
  11: 'Surveillance',
  12: 'Blockade',
  13: 'Bomb',
};

export const CARD_REINFORCEMENT = 1;
export const CARD_ORDER_PRIORITY = 4;
export const CARD_ORDER_DELAY = 5;
export const CARD_BLOCKADE = 12;

/** A card type's display name; `Card <id>` for an unknown id. */
export const cardTypeName = (type: number): string => CARD_TYPES[type] ?? `Card ${type}`;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '').replace(/card$/, '');
const BY_NAME = new Map(Object.entries(CARD_TYPES).map(([id, name]) => [squash(name), Number(id)]));

/** A card type id from its name (any case, spaces optional, a trailing "card" ignored). */
export function cardTypeByName(name: string): number | undefined {
  return BY_NAME.get(squash(name));
}

/** One card in a hand. */
export interface Card {
  /** The card instance GUID: 32 lowercase hex digits. */
  id: string;
  type: number;
  name: string;
  /** Armies a Reinforcement card adds, when the instance says. */
  armies?: number;
}

const GUID_RE = /^[0-9a-f]{32}$/;
/** A GUID as 32 lowercase hex digits (dashes and braces dropped), or `undefined`. */
export function normalizeGuid(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const hex = v.replace(/[-{}]/g, '').toLowerCase();
  return GUID_RE.test(hex) ? hex : undefined;
}

type Obj = Record<string, unknown> & { $type?: unknown };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const CARD_INSTANCE = /CardInstance$/;
const MAX_DEPTH = 32;

function cardOf(o: Obj, key: unknown): Card | undefined {
  const values = Object.entries(o)
    .filter(([k]) => k !== '$type')
    .map(([, v]) => v);
  const id = values.map(normalizeGuid).find((g) => g !== undefined) ?? normalizeGuid(key);
  const ints = values.filter((v): v is number => typeof v === 'number' && Number.isInteger(v));
  // The card-instance base reader sets `Gb` (the card type) last among the integer fields; a
  // ReinforcementCardInstance prepends `tc` (its armies) in its subclass. So the TYPE is the last
  // integer and the Reinforcement armies are the first — never read the type from `ints[0]`, which
  // is `tc` for a Reinforcement card and collides with Order Delay's type id (5).
  const type = ints[ints.length - 1];
  if (id === undefined || type === undefined) return undefined;
  const card: Card = { id, type, name: cardTypeName(type) };
  if (type === CARD_REINFORCEMENT && ints.length >= 2) card.armies = ints[0];
  return card;
}

/**
 * My hand from a decoded LatestGameInfo: every card instance in its CURRENT
 * GameStanding (`currentStanding`, the same object the board is read from) under
 * the player entry keyed by `myInGameId` (or under no player key at all).
 *
 * VERIFIED 2026-11-12 (#20): only the current standing is the hand. The pending
 * orders, the last GameTurn (its receive/play-card orders) and the previous
 * standing still carry instances already played — playing one is refused with
 * error 50 `CardInstanceUnavailable` — so they are never walked. Empty when there
 * is no standing or it carries no cards; never throws.
 *
 * A team shares one hand and one card limit (the wiki's Team Games). Given several in-game
 * ids (mine and my teammates'), the hand is every card under any of them, each GUID once.
 * UNVERIFIED live (#163): how war.app keys a team's hand — under each player, under one, or
 * repeated under all — has not been seen on a team board.
 */
export function readHand(info: unknown, myInGameId: number | readonly number[]): Card[] {
  const owners = new Set(typeof myInGameId === 'number' ? [myInGameId] : myInGameId);
  const out: Card[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, owner: number | undefined, key: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (Array.isArray(item) && item.length === 2 && (typeof item[0] === 'number' || typeof item[0] === 'string')) {
          walk(item[1], typeof item[0] === 'number' ? item[0] : owner, item[0], depth + 1);
        } else {
          walk(item, owner, undefined, depth + 1);
        }
      }
      return;
    }
    if (!isObj(v)) return;
    if (typeof v.$type === 'string' && CARD_INSTANCE.test(v.$type)) {
      if (owner !== undefined && !owners.has(owner)) return;
      const card = cardOf(v, key);
      if (card && !seen.has(card.id)) {
        seen.add(card.id);
        out.push(card);
      }
      return;
    }
    for (const [k, f] of Object.entries(v)) if (k !== '$type') walk(f, owner, undefined, depth + 1);
  };
  const standing = currentStanding(info);
  if (standing) walk(standing, undefined, undefined, 0);
  return out;
}

/**
 * Whether my hand can be read at all: the current standing carries a player entry keyed by
 * `myInGameId` (a `[id, value]` pair). Without one, {@link readHand}'s empty hand means "unknown",
 * not "no cards" (#130). Unverified live: assumes war.app sends every player's entry, as the
 * synthetic shape does. Given several ids (a team's hand, as {@link readHand} takes them), an
 * entry under any of them will do.
 */
export function handReadable(info: unknown, myInGameId: number | readonly number[]): boolean {
  const owners = new Set(typeof myInGameId === 'number' ? [myInGameId] : myInGameId);
  let found = false;
  const walk = (v: unknown, depth: number): void => {
    if (found || depth > MAX_DEPTH) return;
    if (Array.isArray(v)) {
      if (v.length === 2 && typeof v[0] === 'number' && owners.has(v[0]) && v[1] !== null && typeof v[1] === 'object') {
        found = true;
        return;
      }
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    for (const [k, f] of Object.entries(v)) if (k !== '$type') walk(f, depth + 1);
  };
  const standing = currentStanding(info);
  if (standing) walk(standing, 0);
  return found;
}

/** The game's card rules, from GameFeed settings. */
export interface CardRules {
  /** Holding more whole cards than this, war.app requires a play or discard (error 51). */
  maxCardsHold?: number;
  cardsPerTurn?: number;
  /** Armies a Reinforcement card adds (`ReinforcementCard.FixedArmies`). */
  reinforcementArmies?: number;
  /** Card names in play (a card set to "none" is not). */
  inPlay: string[];
}

export function cardRules(settings: GameSettings | undefined): CardRules {
  const rules: CardRules = { inPlay: [] };
  if (!settings) return rules;
  const raw = settings.raw;
  const max = asInt(raw.MaxCardsHold);
  if (max !== undefined) rules.maxCardsHold = max;
  const per = asInt(raw.NumberOfCardsToReceiveEachTurn);
  if (per !== undefined) rules.cardsPerTurn = per;
  const r = raw.ReinforcementCard;
  if (isObj(r)) {
    const armies = asInt(r.FixedArmies);
    if (armies !== undefined) rules.reinforcementArmies = armies;
  }
  for (const name of settings.cards) {
    const type = cardTypeByName(name);
    rules.inPlay.push(type !== undefined ? cardTypeName(type) : name);
  }
  return rules;
}

/** Armies a Reinforcement card adds: its own count, else the game's setting. */
export function reinforcementArmies(card: Card, rules: CardRules): number | undefined {
  return card.armies ?? rules.reinforcementArmies;
}

/**
 * How many cards must leave the hand this turn (played or discarded) for war.app to
 * accept the orders: the whole cards held beyond `maxCardsHold`; 0 without a known limit.
 *
 * VERIFIED 2026-11-12 (#20): live, a turn with no card play was accepted at 4/4 whole
 * cards and refused (error 51) at 5/4; the client bundle's `GameValidateOrders` removes
 * every played or discarded instance from a copy of the hand and refuses while what is
 * left is still `> MaxCardsHold`. So the limit is strictly "over", and each card over it
 * needs its own play or discard. Counts only the real hand (see `readHand`).
 */
export const cardsToShed = (hand: readonly Card[], rules: CardRules): number =>
  rules.maxCardsHold !== undefined && rules.maxCardsHold > 0 ? Math.max(0, hand.length - rules.maxCardsHold) : 0;

/** Whether war.app requires a card play or discard this turn (error 51 otherwise): the hand is over the limit. */
export const playRequired = (hand: readonly Card[], rules: CardRules): boolean => cardsToShed(hand, rules) > 0;

/**
 * How much a card is worth keeping, for choosing a discard (lowest goes first). A heuristic
 * (#163): every ranking read keeps the timing and combat cards longest — Order Delay (an unplayed
 * one is a threat in itself), Order Priority, Emergency Blockade, Bomb and Airlift — and the
 * information cards go first. Order Priority sits below Order Delay because one that must go is
 * played, not thrown away. Reinforcement is kept only when its armies are unknown (or, in a team
 * game, when it is not auto-played) and is the last resort. {@link keepValue} adjusts it per game.
 */
const KEEP_VALUE: Readonly<Record<number, number>> = {
  2: 1, // Spy
  10: 2, // Reconnaissance
  11: 3, // Surveillance
  7: 4, // Gift
  8: 5, // Diplomacy
  9: 6, // Sanctions
  12: 7, // Blockade
  6: 8, // Airlift
  13: 9, // Bomb
  3: 10, // Emergency Blockade
  4: 11, // Order Priority
  5: 12, // Order Delay
  1: 13, // Reinforcement
};
const INFORMATION_CARDS = new Set([2, 10, 11]);
const ONE_V_ONE_CHEAP = new Set([7, 8]); // Gift, Diplomacy

/** The game around a hand, for the card policy (#163). Every field optional: unknown is "not". */
export interface CardGame {
  /** Players in the game (seats, eliminated included or not: only "two" matters). */
  players?: number;
  /** A team game: the team shares one hand and one card limit. */
  team?: boolean;
  /** GameFeed's `Fog` setting (`NoFog`, `Foggy`, …). */
  fog?: string;
}

/**
 * A card's keep value in this game: the information cards (Spy, Reconnaissance, Surveillance)
 * are worth nothing without fog; Gift and Diplomacy are worth little in a 1v1 (there is no third
 * player to buy off or to set against the opponent), below the information cards.
 */
export function keepValue(c: Card, game: CardGame = {}): number {
  if (game.fog === 'NoFog' && INFORMATION_CARDS.has(c.type)) return -2;
  if (game.players === 2 && !game.team && ONE_V_ONE_CHEAP.has(c.type)) return 0;
  return KEEP_VALUE[c.type] ?? 5;
}

export interface CardChoice {
  /** The hand is over the hold limit, so cards must be played or discarded. */
  required: boolean;
  plays: Card[];
  /** Cards to discard (lowest value first) to get under the hold limit when no play is useful. */
  discards: Card[];
  /** Armies the Reinforcement plays add to this turn's deploys. */
  extraArmies: number;
  warnings: string[];
}

/**
 * The cards the planner plays. Outside a team game, every Reinforcement card (it only adds
 * armies) — said to be a default, since holding one is a choice. In a team game (#163) the team
 * shares one hand, so a Reinforcement is played only when cards must be shed (one per card over
 * the limit, before any discard). Over the hold limit, with plays still short of what must leave
 * the hand, the lowest-value cards in this game ({@link keepValue}) leave it: discarded, except an
 * Order Priority, which is played (my first order goes first; one at most, a second is
 * discarded). Order Delay, Blockade and the targeted cards are never auto-played.
 */
export function chooseCardPlays(hand: readonly Card[], rules: CardRules, game: CardGame = {}): CardChoice {
  const shed = cardsToShed(hand, rules);
  const plays: Card[] = [];
  const discards: Card[] = [];
  const warnings: string[] = [];
  let extraArmies = 0;
  let heldForTeam = 0;
  for (const c of hand) {
    if (c.type !== CARD_REINFORCEMENT) continue;
    const armies = reinforcementArmies(c, rules);
    if (armies === undefined) {
      warnings.push(`Not playing Reinforcement card ${c.id}: the armies it adds are unknown.`);
      continue;
    }
    if (game.team && plays.length >= shed) {
      heldForTeam++;
      continue;
    }
    plays.push(c);
    extraArmies += armies;
  }
  if (heldForTeam) {
    warnings.push(
      `Holding ${heldForTeam === 1 ? 'a Reinforcement card' : `${heldForTeam} Reinforcement cards`}: in a team game the team shares one hand, ` +
        'so a teammate may need it more. Play it yourself (warapp_submit_turn) if the team agrees.',
    );
  }
  const defaults = plays.length - Math.min(plays.length, shed);
  if (!game.team && defaults > 0) {
    warnings.push(
      `Playing ${defaults === 1 ? 'the Reinforcement card' : `${defaults} Reinforcement cards`} by default (+${extraArmies} armies this turn): ` +
        'holding one is a choice — with no enemy in sight, or so the opponent undercounts your income — and the card keeps.',
    );
  }
  if (plays.length < shed) {
    const used = new Set(plays.map((c) => c.id));
    const rest = hand.filter((c) => !used.has(c.id));
    // A stable sort: equal-value cards go in hand order. The lowest-value cards leave the hand; an
    // Order Priority that must go anyway is played rather than discarded.
    const byValue = rest
      .map((c, i) => ({ c, i }))
      .sort((a, b) => keepValue(a.c, game) - keepValue(b.c, game) || a.i - b.i);
    // At most one Order Priority is played: a second adds nothing over the first, and whether
    // war.app takes two plays of it in one turn is unverified, so the rest are discarded.
    const playOne = (c: Card): boolean => c.type === CARD_ORDER_PRIORITY && !plays.some((p) => p.type === CARD_ORDER_PRIORITY);
    for (const { c } of byValue.slice(0, shed - plays.length)) (playOne(c) ? plays : discards).push(c);
  }
  const forced = plays.filter((c) => c.type === CARD_ORDER_PRIORITY);
  if (forced.length) {
    warnings.push(
      `You hold ${hand.length} cards (the limit is ${rules.maxCardsHold}), so ${shed} must be played or discarded this ` +
        `turn. Playing Order Priority because it is the card that must go (a play costs nothing a discard would keep), ` +
        'whatever the plan advises for it.',
    );
  }
  if (discards.length) {
    warnings.push(
      `You hold ${hand.length} cards (the limit is ${rules.maxCardsHold}), so ${shed} must be played or discarded this ` +
        `turn. Discarding ${discards.map((c) => c.name).join(', ')}, the cards worth least in this game (the timing and ` +
        'combat cards — Order Delay, Order Priority, Emergency Blockade, Bomb, Airlift — are kept longest). Swap in a card play if you prefer.',
    );
  }
  return { required: shed > 0, plays, discards, extraArmies, warnings };
}

/** Whether the chosen plays spend an Order Priority card anyway (the hand is over the limit and it must go). */
export function playsOrderPriority(choice: CardChoice): boolean {
  return choice.plays.some((c) => c.type === CARD_ORDER_PRIORITY);
}

/**
 * Whether I can play an Order Priority card this turn: one is in my hand and the chosen
 * card plays do not discard it (the planner advises it for a commander strike, #61).
 */
export function holdsOrderPriority(hand: readonly Card[], choice: CardChoice): boolean {
  const discarded = new Set(choice.discards.map((c) => c.id));
  return hand.some((c) => c.type === CARD_ORDER_PRIORITY && !discarded.has(c.id));
}

/**
 * The Order Priority card to add to the chosen plays when the plan advises one (a withdrawal
 * or a commander strike), so the orders carry it: one in my hand the choice neither discards
 * nor already plays. `undefined` when the choice already plays one, or none is left to play.
 */
export function advisedOrderPriority(hand: readonly Card[], choice: CardChoice): Card | undefined {
  if (choice.plays.some((c) => c.type === CARD_ORDER_PRIORITY)) return undefined;
  const discarded = new Set(choice.discards.map((c) => c.id));
  return hand.find((c) => c.type === CARD_ORDER_PRIORITY && !discarded.has(c.id));
}

/** Where to play an Order Delay this turn (#163). */
export interface OrderDelayAdvice {
  card: Card;
  /** The move (1-based, in the plan's order) the card goes above. */
  before: number;
  /** The attacks (1-based) the opponent can answer first: the reason the card is advised. */
  attacks: number[];
}

/** A move as the card advice reads it. */
interface AdviceMove {
  from: number;
  to: number;
  kind: 'attack' | 'transfer';
}

/**
 * The Order Delay to play, and where: when the schedule (#127) puts an attack last because the
 * opponent can answer it first (`moveSlots` `last`) and I hold an Order Delay the choice neither
 * plays nor discards, the card goes above every order that is not urgent — after the protected
 * and early orders (withdrawals, transfers into a threatened border), before the rest — as the
 * sources and the developer's own bot play it. `undefined` otherwise. The planner never plays it:
 * warapp_submit_turn writes the card after every move (its only live-verified position), where it
 * delays nothing, so the advice is for the game client.
 */
export function adviseOrderDelay(
  hand: readonly Card[],
  choice: CardChoice,
  moves: readonly AdviceMove[],
  moveSlots: readonly string[] | undefined,
): OrderDelayAdvice | undefined {
  if (!moveSlots) return undefined;
  const gone = new Set([...choice.plays, ...choice.discards].map((c) => c.id));
  const card = hand.find((c) => c.type === CARD_ORDER_DELAY && !gone.has(c.id));
  if (!card) return undefined;
  const attacks = moves.flatMap((m, i) => (m.kind === 'attack' && moveSlots[i] === 'last' ? [i + 1] : []));
  if (!attacks.length) return undefined;
  const firstCalm = moveSlots.findIndex((s) => s !== 'protected' && s !== 'early');
  const before = firstCalm < 0 ? moves.length + 1 : firstCalm + 1;
  return { card, before, attacks };
}

/** A card in effect on the board (#163): Diplomacy, Sanctions and the like, while they last. */
export interface ActiveCard {
  /** The card's display name (`Diplomacy`, `Sanctions`, `Emergency Blockade`, …). */
  card: string;
  /** Diplomacy: the two players (in-game ids) who cannot attack each other. */
  players?: [number, number];
  /** Sanctions: the player (in-game id) whose income it cuts. */
  target?: number;
  /** Who played it (in-game id). */
  playedBy?: number;
  /** The raw `ExpiresAfterTurn` field. */
  expiresAfterTurn?: number;
  /**
   * The turn the card is gone by, as the client shows it ("Expires turn N", "you cannot attack this
   * player until turn N"): the bundle's ActiveCard returns `ExpiresAfterTurn` for a card whose expire
   * behaviour is BeginningOfNextTurn (Spy, Reconnaissance, Surveillance) and `ExpiresAfterTurn + 1`
   * for EndOfTurn (every other built-in card: Diplomacy, Sanctions, Emergency Blockade, …).
   */
  untilTurn?: number;
}

/** Card types whose ActiveCard expires at the beginning of the next turn (the bundle's `CardGame*` overrides). */
const EXPIRES_AT_NEXT_TURN = new Set([2, 10, 11]); // Spy, Reconnaissance, Surveillance

/** The client's play-order class suffixes (`GameOrderPlayCard<X>`) that are not the card's name. */
const ORDER_CARD: Readonly<Record<string, string>> = { Abandon: 'Emergency Blockade' };
const PLAY_ORDER = /GameOrderPlayCard([A-Za-z]+)$/;
const ACTIVE_CARD = /\.ActiveCard$/;

const intsOf = (o: Obj): number[] =>
  Object.entries(o)
    .filter(([k, v]) => k !== '$type' && typeof v === 'number' && Number.isInteger(v))
    .map(([, v]) => v as number);

function activeCardOf(o: Obj): ActiveCard | undefined {
  const order = Object.values(o).find((v): v is Obj => isObj(v) && typeof v.$type === 'string' && PLAY_ORDER.test(v.$type));
  if (!order) return undefined;
  const kind = PLAY_ORDER.exec(order.$type as string)![1]!;
  const type = cardTypeByName(kind);
  const card = ORDER_CARD[kind] ?? (type !== undefined ? cardTypeName(type) : kind);
  const ints = intsOf(order);
  const out: ActiveCard = { card };
  // The order's own fields are read before the base's card GUID and player: Diplomacy's two
  // players, Sanctions' target, then the player who played it (the last integer).
  if (kind === 'Diplomacy' && ints.length >= 3) out.players = [ints[0]!, ints[1]!];
  if (kind === 'Sanctions' && ints.length >= 2) out.target = ints[0]!;
  if (ints.length) out.playedBy = ints[ints.length - 1]!;
  const expires = intsOf(o)[0];
  if (expires !== undefined) {
    out.expiresAfterTurn = expires;
    out.untilTurn = type !== undefined && EXPIRES_AT_NEXT_TURN.has(type) ? expires : expires + 1;
  }
  return out;
}

/**
 * The cards in effect, from a decoded LatestGameInfo's CURRENT GameStanding (its `ActiveCards`:
 * each a `warlight.shared.ActiveCard { Card, ExpiresAfterTurn }`, the card being the play order
 * that started it). Fields are minified, so they are found by type name and read order (read from
 * the client bundle). Loose: an unexpected shape yields fewer entries, never an error.
 *
 * UNVERIFIED live (#163): the reader follows the client bundle's ActiveCard and play-order
 * readers, but no live board carrying an active card has been decoded yet, and whether a fogged
 * player sees the cards played on others (card plays can be fogged) is not known.
 */
export function readActiveCards(info: unknown): ActiveCard[] {
  const out: ActiveCard[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    if (!isObj(v)) return;
    if (typeof v.$type === 'string' && ACTIVE_CARD.test(v.$type)) {
      const card = activeCardOf(v);
      if (card) out.push(card);
      return;
    }
    for (const [k, f] of Object.entries(v)) if (k !== '$type') walk(f, depth + 1);
  };
  const standing = currentStanding(info);
  if (standing) walk(standing, 0);
  return out;
}
