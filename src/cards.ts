// Cards: the type table, my hand read from the live board, the game's card
// rules from GameFeed settings, and which cards the planner plays.
//
// VERIFIED 2026-11-12 (docs/PLAN-CARDS-PUSH.md): the hand is a dict GUID →
// card instance (`warlight.shared.ReinforcementCardInstance { guid, type,
// armies }`, `warlight.shared.NoParameterCardInstance { guid, type }`) under the
// player entry keyed by the in-game id. Field names are minified, so instances
// are found by type name and their fields by kind and read order, and the
// reader stays loose: an unexpected shape yields fewer cards, never an error.

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
 * My hand from a decoded LatestGameInfo: every card instance under the player
 * entry keyed by `myInGameId` (or under no player key at all). Empty when the
 * board carries no cards; never throws.
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
  walk(info, undefined, undefined, 0);
  return out;
}

/** The game's card rules, from GameFeed settings. */
export interface CardRules {
  /** At this many cards held, war.app requires a play (error 51). */
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

/** Whether the hand is at the hold limit, so war.app requires a card play. */
export const playRequired = (hand: readonly Card[], rules: CardRules): boolean =>
  rules.maxCardsHold !== undefined && rules.maxCardsHold > 0 && hand.length >= rules.maxCardsHold;

export interface CardChoice {
  required: boolean;
  plays: Card[];
  /** Armies the Reinforcement plays add to this turn's deploys. */
  extraArmies: number;
  warnings: string[];
}

/**
 * The cards the planner plays: every Reinforcement card (it only adds armies);
 * at the hold limit with none of those, Order Priority, else Order Delay.
 * Blockade is never auto-played (it gives a territory away).
 */
export function chooseCardPlays(hand: readonly Card[], rules: CardRules): CardChoice {
  const required = playRequired(hand, rules);
  const plays: Card[] = [];
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
  if (required && plays.length === 0) {
    const pick = hand.find((c) => c.type === CARD_ORDER_PRIORITY) ?? hand.find((c) => c.type === CARD_ORDER_DELAY);
    if (pick) plays.push(pick);
    else {
      warnings.push(
        `You hold ${hand.length} cards (the limit is ${rules.maxCardsHold}), so you must play a card this turn, ` +
          'but none can be played automatically (Blockade gives a territory away). Add a card play to the orders.',
      );
    }
  }
  return { required, plays, extraArmies, warnings };
}
