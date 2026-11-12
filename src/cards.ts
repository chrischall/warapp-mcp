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
 */
export function readHand(info: unknown, myInGameId: number): Card[] {
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
      if (owner !== undefined && owner !== myInGameId) return;
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
 * How much a card is worth keeping, for choosing a discard (lowest goes first). A
 * heuristic: Order Delay holds back my own attacks and the information cards are
 * cheap; Reinforcement (only kept when its armies are unknown) is the last resort.
 */
const KEEP_VALUE: Readonly<Record<number, number>> = {
  5: 0, // Order Delay
  2: 1, // Spy
  10: 2, // Reconnaissance
  11: 3, // Surveillance
  8: 4, // Diplomacy
  9: 5, // Sanctions
  7: 6, // Gift
  3: 7, // Emergency Blockade
  12: 8, // Blockade
  13: 9, // Bomb
  6: 10, // Airlift
  4: 11, // Order Priority
  1: 12, // Reinforcement
};
const keepValue = (c: Card): number => KEEP_VALUE[c.type] ?? 5;

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
 * The cards the planner plays: every Reinforcement card (it only adds armies). Over
 * the hold limit, with plays still short of what must leave the hand, one Order
 * Priority (my moves go first), then discards of the lowest-value cards. Order Delay
 * (it holds back my own attacks) and Blockade (it gives a territory away) are never
 * auto-played — discarding one costs nothing this turn.
 */
export function chooseCardPlays(hand: readonly Card[], rules: CardRules): CardChoice {
  const shed = cardsToShed(hand, rules);
  const plays: Card[] = [];
  const discards: Card[] = [];
  const warnings: string[] = [];
  let extraArmies = 0;
  for (const c of hand) {
    if (c.type !== CARD_REINFORCEMENT) continue;
    const armies = reinforcementArmies(c, rules);
    if (armies === undefined) {
      warnings.push(`Not playing Reinforcement card ${c.id}: the armies it adds are unknown.`);
      continue;
    }
    plays.push(c);
    extraArmies += armies;
  }
  if (plays.length < shed) {
    const op = hand.find((c) => c.type === CARD_ORDER_PRIORITY);
    if (op) plays.push(op);
  }
  if (plays.length < shed) {
    const used = new Set(plays.map((c) => c.id));
    const rest = hand.filter((c) => !used.has(c.id));
    // A stable sort: equal-value cards are discarded in hand order.
    const byValue = rest.map((c, i) => ({ c, i })).sort((a, b) => keepValue(a.c) - keepValue(b.c) || a.i - b.i);
    for (const { c } of byValue.slice(0, shed - plays.length)) discards.push(c);
    warnings.push(
      `You hold ${hand.length} cards (the limit is ${rules.maxCardsHold}), so ${shed} must be played or discarded this ` +
        `turn. Discarding ${discards.map((c) => c.name).join(', ')} — no play of ${discards.length === 1 ? 'it' : 'them'} ` +
        'is useful (Blockade gives a territory away, Order Delay holds back your own attacks). Swap in a card play if you prefer.',
    );
  }
  return { required: shed > 0, plays, discards, extraArmies, warnings };
}
