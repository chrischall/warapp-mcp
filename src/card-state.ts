// My card state for a person: the whole cards I hold (by type, with how many) and the pieces toward the next
// card of each type, read from the current GameStanding's `PlayerCards` (docs/WEB-PROTOCOL.md "A team's hand":
// `PlayerID`, `Pieces`, `WholeCards` by GUID, per player, keyed by the in-game id). Shown by warapp_get_game and
// warapp_begin_turn.
//
// The whole cards are `readHand`'s (VERIFIED live, #20, #310). The pieces are UNVERIFIED live: `Pieces` is a
// dict card type → count, and the decoder keeps field names minified, so it is found by shape — the one field of
// the player's PlayerCards that is a list of `[card type, count]` pairs (a type id, or a record whose one integer
// is the type id). Several ids (a team) sum the pieces, as the client's merged team hand does. Pure; never throws.

import { cardTypeByName, cardTypeName, readHand, type Card } from './cards.js';
import { currentStanding } from './live.js';
import type { GameSettings } from './normalize.js';
import { fields, isObj } from './protocol/decoded.js';
import { cardClock } from './strategy/card-clock.js';

/** One card type I hold. */
export interface HeldCards {
  type: number;
  name: string;
  count: number;
  /** A Reinforcement card's armies, when the instances say (the largest). */
  armies?: number;
}

/** Pieces toward my next card of one type. */
export interface CardPieces {
  type: number;
  name: string;
  pieces: number;
  /** Pieces one whole card needs (the game's settings); `null` when they do not say. */
  of: number | null;
}

export interface CardState {
  /** Whole cards held, by type (ascending type id). */
  held: HeldCards[];
  /** Whole cards held in all. */
  total: number;
  /** Most whole cards the hand may hold before one must be played or discarded; `null` when unknown. */
  maxCardsHold: number | null;
  /** Pieces toward the next card of each type in play; `null` when they could not be read. */
  pieces: CardPieces[] | null;
  note: string;
}

const MAX_DEPTH = 32;
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const GUID_RE = /^[0-9a-f-]{32,38}$/i;

/** The card type a dict key names: an integer, or a record whose one integer field is it. */
function typeKey(k: unknown): number | undefined {
  if (isInt(k)) return k;
  if (isObj(k)) {
    const ints = fields(k).filter(isInt);
    return ints.length === 1 ? ints[0] : undefined;
  }
  return undefined;
}

/** A `[card type, count]` dict: every item a pair of a type key and an integer count. */
function piecesDict(v: unknown): Map<number, number> | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
  const out = new Map<number, number>();
  for (const item of v) {
    if (!Array.isArray(item) || item.length !== 2) return undefined;
    const [k, n] = item as [unknown, unknown];
    if (typeof k === 'string' && GUID_RE.test(k)) return undefined;
    const type = typeKey(k);
    if (type === undefined || !isInt(n) || n < 0) return undefined;
    out.set(type, (out.get(type) ?? 0) + n);
  }
  return out;
}

/**
 * The pieces under the given in-game ids, summed by card type: `undefined` when no PlayerCards entry of theirs
 * shows a pieces dict. An entry whose lists are all empty but for its whole cards reads as no pieces.
 */
export function readPieces(info: unknown, ids: number | readonly number[]): Map<number, number> | undefined {
  const owners = new Set(typeof ids === 'number' ? [ids] : ids);
  const total = new Map<number, number>();
  let found = false;
  const playerCards = (v: unknown): void => {
    if (!isObj(v)) return;
    const values = fields(v);
    const dict = values.map(piecesDict).find((d) => d !== undefined);
    if (dict) {
      found = true;
      for (const [t, n] of dict) total.set(t, (total.get(t) ?? 0) + n);
      return;
    }
    // Pieces empty: every list is empty, or a list of whole cards (GUID keys), and at least two lists stand.
    const lists = values.filter(Array.isArray);
    if (lists.length >= 2 && lists.filter((l) => l.length === 0).length >= 1) found = true;
  };
  const walk = (v: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (Array.isArray(item) && item.length === 2 && isInt(item[0]) && owners.has(item[0]) && isObj(item[1]) && /PlayerCards$/.test(String(item[1].$type))) {
          playerCards(item[1]);
        } else walk(item, depth + 1);
      }
      return;
    }
    if (!isObj(v)) return;
    for (const [k, f] of Object.entries(v)) if (k !== '$type') walk(f, depth + 1);
  };
  const standing = currentStanding(info);
  if (standing) walk(standing, 0);
  return found ? total : undefined;
}

/** Whole cards grouped by type. */
export function heldCards(hand: readonly Card[]): HeldCards[] {
  const by = new Map<number, HeldCards>();
  for (const c of hand) {
    const h = by.get(c.type) ?? { type: c.type, name: c.name, count: 0 };
    h.count += 1;
    if (c.armies !== undefined) h.armies = Math.max(h.armies ?? 0, c.armies);
    by.set(c.type, h);
  }
  return [...by.values()].sort((a, b) => a.type - b.type);
}

/** How many whole cards of `name` (`Airlift`, …) the hand holds. */
export const countOf = (state: Pick<CardState, 'held'>, name: string): number => state.held.find((h) => h.name === name)?.count ?? 0;

/**
 * My card state from a decoded LatestGameInfo: the whole cards held under `ids` (a team's merged hand when
 * several) and the pieces toward the next card of each type in play (`settings`), `undefined` when no card is
 * in play.
 */
export function cardState(info: unknown, ids: number | readonly number[], settings: GameSettings | undefined): CardState | undefined {
  const clock = cardClock(settings);
  if (!clock) return undefined;
  const hand = readHand(info, ids);
  const held = heldCards(hand);
  const read = readPieces(info, ids);
  const pieces = read
    ? clock.cards.flatMap((c) => {
        const type = cardTypeByName(c.card);
        return type === undefined ? [] : [{ type, name: cardTypeName(type), pieces: read.get(type) ?? 0, of: c.pieces }];
      })
    : null;
  return {
    held,
    total: hand.length,
    maxCardsHold: clock.maxCardsHold,
    pieces,
    note:
      'Whole cards are read from the live board (verified). ' +
      (pieces
        ? 'Pieces are read from it too, by their shape: UNVERIFIED live — check one against the web client before relying on it.'
        : 'Pieces could not be read from the live board (their encoding is unverified), so none are shown.'),
  };
}
