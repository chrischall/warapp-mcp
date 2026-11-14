// The card clock: when each card can first be in a hand, from the game's card settings alone.
// Pure and deterministic; no I/O.
//
// The rules are the wiki's (docs/STRATEGY.md links the pages): a player who captures at least one
// territory in a turn receives the game's "pieces per turn" at the end of it; each card's minimum
// is always part of that hand-out and the rest is drawn at random by card weight (a weight of 0
// is never drawn); a card is playable once all its pieces are held, so from the turn after its
// last piece arrives; and when the minimums add up to more than the pieces per turn the game
// raises the pieces per turn to match. When the minimums use up every piece (or only one card can
// be drawn at random), every player who captures each turn holds the same cards on the same turns.
// Pieces left over when a card completes count toward the next one.
//
// The clock is per player. A team shares one hand, and players report that each teammate who
// captures adds pieces (the wiki does not say), so a team's cards can come sooner than this.

import { cardTypeByName, cardTypeName } from '../cards.js';
import type { GameSettings } from '../normalize.js';
import { asInt } from '../scalars.js';

export interface CardClockEntry {
  card: string;
  /** Pieces that make one card, and how many every player starts with. */
  pieces: number;
  initialPieces: number;
  /** Pieces of this card every capturing turn is sure to bring. */
  minimumPerTurn: number;
  weight: number;
  /**
   * Turns with a capture needed for the first card: `fastest` when every randomly drawn piece is
   * this card's, `guaranteed` from its minimum alone. `null`: it never comes that way.
   */
  capturingTurns: { fastest: number | null; guaranteed: number | null };
  /** The first turn it can be played by a player who captures every turn from turn 1. */
  firstPlayableTurn: { fastest: number | null; guaranteed: number | null };
  /** Capturing turns needed for the first, second and third card (leftover pieces carry over). */
  cardsAfter: { fastest: number[] | null; guaranteed: number[] | null };
  /** Armies one piece is worth: a fixed Reinforcement card's armies over its pieces. */
  pieceValue?: number;
}

export interface CardClock {
  /** Pieces a capturing player receives each turn (at least the sum of the minimums). */
  piecesPerTurn: number;
  /** Of those, the pieces drawn at random by weight. */
  randomPerTurn: number;
  /** Whether the game's pieces per turn was read from the settings (else the minimums stand in). */
  piecesPerTurnKnown: boolean;
  /** No piece is left to chance: everyone who captures every turn holds the same cards. */
  fixed: boolean;
  /** What the counts are per: one player, with the caveat for teams. */
  perPlayer: string;
  /** Whole cards a player (or team) may hold before one must be played or discarded. */
  maxCardsHold: number | null;
  /** Whether opponents' hands, and their card plays, are hidden; `null` when the feed does not say. */
  handsHidden: boolean | null;
  playsHidden: boolean | null;
  cards: CardClockEntry[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const bool = (v: unknown): boolean | null => (v === true || v === 'true' || v === 'True' ? true : v === false || v === 'false' || v === 'False' ? false : null);
const perTurn = (need: number, rate: number): number | null => (need <= 0 ? 0 : rate > 0 ? Math.ceil(need / rate) : null);
/** Capturing turns for the first three cards at `rate` pieces a turn. */
const firstThree = (pieces: number, initial: number, rate: number): number[] | null =>
  rate > 0 ? [1, 2, 3].map((k) => Math.max(0, Math.ceil((k * pieces - initial) / rate))) : null;

export const CARD_CLOCK_PER_PLAYER =
  'Per player. A team shares one hand, and each teammate who captures is reported to add pieces (not on the wiki), so a team can hold a card sooner.';
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The game's card clock; `undefined` when no card is in play. */
export function cardClock(settings: GameSettings | undefined): CardClock | undefined {
  if (!settings || settings.cards.length === 0) return undefined;
  const raw = settings.raw;
  const read = settings.cards.flatMap((key) => {
    const r = raw[`${key}Card`];
    if (!isRec(r)) return [];
    const type = cardTypeByName(key);
    return [
      {
        card: type !== undefined ? cardTypeName(type) : key,
        pieces: Math.max(1, asInt(r.NumPieces) ?? 1),
        initialPieces: Math.max(0, asInt(r.InitialPieces) ?? 0),
        minimumPerTurn: Math.max(0, asInt(r.MinimumPiecesPerTurn) ?? 0),
        weight: Math.max(0, Number(r.Weight ?? 1) || 0),
        fixedArmies: asInt(r.FixedArmies),
      },
    ];
  });
  if (read.length === 0) return undefined;
  const minimums = read.reduce((n, c) => n + c.minimumPerTurn, 0);
  const stated = asInt(raw.NumberOfCardsToReceiveEachTurn);
  const piecesPerTurn = Math.max(stated ?? minimums, minimums);
  const randomPerTurn = piecesPerTurn - minimums;
  // When only one card can be drawn at random, every random piece is that card's for certain.
  const drawable = read.filter((c) => c.weight > 0);
  const cards = read.map(({ fixedArmies, ...c }): CardClockEntry => {
    const need = c.pieces - c.initialPieces;
    const fastestRate = c.minimumPerTurn + (c.weight > 0 ? randomPerTurn : 0);
    const guaranteedRate = c.minimumPerTurn + (c.weight > 0 && drawable.length === 1 ? randomPerTurn : 0);
    const turns = { fastest: perTurn(need, fastestRate), guaranteed: perTurn(need, guaranteedRate) };
    return {
      ...c,
      capturingTurns: turns,
      // Pieces arrive at the end of a turn, so the card is playable on the next one.
      firstPlayableTurn: { fastest: turns.fastest === null ? null : turns.fastest + 1, guaranteed: turns.guaranteed === null ? null : turns.guaranteed + 1 },
      cardsAfter: { fastest: firstThree(c.pieces, c.initialPieces, fastestRate), guaranteed: firstThree(c.pieces, c.initialPieces, guaranteedRate) },
      ...(c.card === 'Reinforcement' && fixedArmies !== undefined && fixedArmies > 0 ? { pieceValue: round2(fixedArmies / c.pieces) } : {}),
    };
  });
  return {
    piecesPerTurn,
    randomPerTurn,
    piecesPerTurnKnown: stated !== undefined,
    // Exact only when the setting was read and no piece is left to chance.
    fixed: stated !== undefined && (randomPerTurn === 0 || drawable.length === 1),
    perPlayer: CARD_CLOCK_PER_PLAYER,
    maxCardsHold: asInt(raw.MaxCardsHold) ?? null,
    handsHidden: bool(raw.CardsHoldingAndReceivingFogged ?? raw.CardHoldingsAndReceivesFogged),
    playsHidden: bool(raw.CardPlayingsFogged),
    cards,
  };
}

/** What one turn with a capture earns in card pieces, in armies (#127). */
export interface CapturePieceValue {
  /** Armies a capturing turn's pieces are worth; `null` when the game does not say (see `why`). */
  armies: number | null;
  /** Reinforcement pieces expected from one capturing turn: its minimum plus its weighted share of the random ones. */
  reinforcementPieces?: number;
  /** Armies one Reinforcement card adds, and the pieces it takes. */
  armiesPerCard?: number;
  pieces?: number;
  why: string;
}

/**
 * The armies one turn with a capture earns in card pieces (#127): the Reinforcement pieces it brings
 * — the card's minimum per turn plus its weighted share of the random pieces — times the armies a
 * Reinforcement card adds over the pieces it takes. Those armies are the game's `FixedArmies`; when
 * the card is not fixed (progressive), the armies of a Reinforcement card in my hand stand in
 * (`handArmies`: the card as it is worth now). The other cards have no army value here: `null` when
 * no Reinforcement card is in play or its armies are unknown, with the reason.
 */
export function capturePieceValue(settings: GameSettings | undefined, handArmies?: number): CapturePieceValue {
  const clock = cardClock(settings);
  if (!clock) return { armies: null, why: 'no card is in play' };
  const r = clock.cards.find((c) => c.card === 'Reinforcement');
  if (!r) return { armies: null, why: 'no Reinforcement card is in play, and the other cards have no army value here' };
  const drawWeight = clock.cards.reduce((n, c) => n + c.weight, 0);
  const pieces = r.minimumPerTurn + (r.weight > 0 && drawWeight > 0 ? (clock.randomPerTurn * r.weight) / drawWeight : 0);
  const reinforcementPieces = round2(pieces);
  const raw = settings!.raw.ReinforcementCard;
  const fixed = isRec(raw) ? asInt(raw.FixedArmies) : undefined;
  const per = fixed !== undefined && fixed > 0 ? fixed : handArmies !== undefined && handArmies > 0 ? handArmies : undefined;
  if (per === undefined)
    return {
      armies: null,
      reinforcementPieces,
      pieces: r.pieces,
      why: 'the Reinforcement card is not a fixed number of armies here, and no Reinforcement card in hand shows what one is worth now',
    };
  const armies = round2((pieces * per) / r.pieces);
  const source = fixed !== undefined && fixed > 0 ? `${per} armies a card` : `the Reinforcement card in hand (${per} armies)`;
  return {
    armies,
    reinforcementPieces,
    armiesPerCard: per,
    pieces: r.pieces,
    why: `a capturing turn brings ~${reinforcementPieces} Reinforcement pieces of the ${r.pieces} a card takes, at ${source}: ~${armies} armies (the other cards are not valued)`,
  };
}

/**
 * #205: the most armies cards can add to one player, for the outlook's upper bound on a fogged
 * opponent. Only a Reinforcement card adds armies to its holder; a Gift card lets another player
 * hand it territories (and their armies), so with one in play — or a card this table does not
 * know — there is no bound. The Reinforcement card must be fixed (`FixedArmies`; a `Mode` other
 * than fixed is progressive, unverified) and every random piece is counted as its own, so the
 * bound assumes a capture on every turn.
 */
export interface CardArmyCeiling {
  /** Armies one Reinforcement card adds; 0 when none is in play. */
  armiesPerCard: number;
  pieces: number;
  initialPieces: number;
  /** The most Reinforcement pieces one capturing turn can bring. */
  piecesPerTurn: number;
}

/** Cards that never add armies to their holder. */
const NO_ARMY_CARDS = new Set([
  'Spy',
  'Emergency Blockade',
  'Order Priority',
  'Order Delay',
  'Airlift',
  'Diplomacy',
  'Sanctions',
  'Reconnaissance',
  'Surveillance',
  'Blockade',
  'Bomb',
]);

const FIXED_MODES = new Set(['0', 'fixed']);

/** {@link CardArmyCeiling} from the game's card settings; `undefined` when cards are not bounded (or none is in play, or the cards a turn are not stated). */
export function cardArmyCeiling(settings: GameSettings | undefined): CardArmyCeiling | undefined {
  const clock = cardClock(settings);
  if (!clock) return undefined;
  const r = clock.cards.find((c) => c.card === 'Reinforcement');
  if (clock.cards.some((c) => c.card !== 'Reinforcement' && !NO_ARMY_CARDS.has(c.card))) return undefined;
  if (!r) return { armiesPerCard: 0, pieces: 1, initialPieces: 0, piecesPerTurn: 0 };
  // Without NumberOfCardsToReceiveEachTurn the random pieces a turn are unknown, so no ceiling.
  if (!clock.piecesPerTurnKnown) return undefined;
  const raw = settings!.raw.ReinforcementCard as Rec;
  const fixed = asInt(raw.FixedArmies);
  if (fixed === undefined || fixed <= 0) return undefined;
  if (raw.Mode !== undefined && !FIXED_MODES.has(String(raw.Mode).toLowerCase())) return undefined;
  return {
    armiesPerCard: fixed,
    pieces: r.pieces,
    initialPieces: r.initialPieces,
    piecesPerTurn: r.minimumPerTurn + (r.weight > 0 ? clock.randomPerTurn : 0),
  };
}

/** The most armies cards can have added by `turn` (pieces arrive at the end of a turn, so turn `t` plays those of turns 1 to t − 1). */
export function cardArmiesBy(c: CardArmyCeiling, turn: number): number {
  if (c.armiesPerCard <= 0) return 0;
  const pieces = c.initialPieces + c.piecesPerTurn * Math.max(0, turn - 1);
  return Math.floor(pieces / c.pieces) * c.armiesPerCard;
}
