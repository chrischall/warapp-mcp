// The card clock: when each card can first be in a hand, from the game's card settings alone
// (pieces per card, starting pieces, guaranteed pieces per turn, pieces handed out per turn).
import { describe, expect, it } from 'vitest';
import { normalizeSettings } from '../../src/normalize.js';
import { cardClock } from '../../src/strategy/card-clock.js';
import { fixtureSettings } from '../analysis/helpers.js';

const card = (o: Record<string, unknown>) => ({ NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 0, Weight: 1, ...o });
const settings = (raw: Record<string, unknown>) => normalizeSettings(raw);

describe('cardClock', () => {
  it('is absent when no card is in play', () => {
    expect(cardClock(settings({ ReinforcementCard: 'none', BombCard: 'none' }))).toBeUndefined();
    expect(cardClock(undefined)).toBeUndefined();
  });

  it('a fixed hand-out: the minimums use up every piece, so the schedule is exact for everyone', () => {
    const clock = cardClock(
      settings({
        NumberOfCardsToReceiveEachTurn: 2,
        ReinforcementCard: card({ NumPieces: 4, MinimumPiecesPerTurn: 1, FixedArmies: 4 }),
        OrderDelayCard: card({ NumPieces: 5, InitialPieces: 1, MinimumPiecesPerTurn: 1 }),
        MaxCardsHold: 3,
        CardPlayingsFogged: false,
        CardsHoldingAndReceivingFogged: true,
      }),
    )!;
    expect(clock).toMatchObject({ piecesPerTurn: 2, randomPerTurn: 0, fixed: true, maxCardsHold: 3, handsHidden: true, playsHidden: false });
    // 4 pieces at 1 a turn: complete at the end of the 4th capturing turn, playable on turn 5.
    expect(clock.cards.find((c) => c.card === 'Reinforcement')).toMatchObject({
      pieces: 4,
      capturingTurns: { fastest: 4, guaranteed: 4 },
      firstPlayableTurn: { fastest: 5, guaranteed: 5 },
      // The first three cards come after 4, 8 and 12 capturing turns.
      cardsAfter: { fastest: [4, 8, 12], guaranteed: [4, 8, 12] },
      pieceValue: 1,
    });
    // One piece to start with: 4 more needed.
    expect(clock.cards.find((c) => c.card === 'Order Delay')).toMatchObject({
      initialPieces: 1,
      capturingTurns: { fastest: 4, guaranteed: 4 },
      firstPlayableTurn: { fastest: 5, guaranteed: 5 },
      cardsAfter: { fastest: [4, 9, 14], guaranteed: [4, 9, 14] },
    });
  });

  it('pieces drawn by weight: the fastest case gives a card every random piece, and only a minimum is guaranteed', () => {
    // The anonymized lobby fixture: 6 pieces a turn, 1 of them always Reinforcement.
    const clock = cardClock(fixtureSettings())!;
    expect(clock).toMatchObject({ piecesPerTurn: 6, randomPerTurn: 5, fixed: false });
    expect(clock.cards.map((c) => c.card)).toEqual(['Reinforcement', 'Blockade', 'Airlift', 'Diplomacy', 'Sanctions', 'Reconnaissance']);
    // Reinforcement: 5 pieces; all 6 pieces of a turn can be its own, 1 is certain.
    expect(clock.cards[0]).toMatchObject({ capturingTurns: { fastest: 1, guaranteed: 5 }, firstPlayableTurn: { fastest: 2, guaranteed: 6 } });
    // Blockade: 8 pieces, 4 to start with, no minimum: one lucky turn completes it, nothing guarantees it.
    expect(clock.cards[1]).toMatchObject({ capturingTurns: { fastest: 1, guaranteed: null }, firstPlayableTurn: { fastest: 2, guaranteed: null } });
    // Sanctions: 8 pieces from 0 at up to 5 random pieces a turn.
    expect(clock.cards.find((c) => c.card === 'Sanctions')).toMatchObject({ capturingTurns: { fastest: 2, guaranteed: null }, firstPlayableTurn: { fastest: 3, guaranteed: null } });
  });

  it('a card whose starting pieces already make one is playable on turn 1', () => {
    const clock = cardClock(settings({ NumberOfCardsToReceiveEachTurn: 1, BombCard: card({ NumPieces: 3, InitialPieces: 3, MinimumPiecesPerTurn: 1 }) }))!;
    expect(clock.cards[0]).toMatchObject({ card: 'Bomb', capturingTurns: { fastest: 0, guaranteed: 0 }, firstPlayableTurn: { fastest: 1, guaranteed: 1 } });
  });

  it('a card with no weight and no minimum never comes by itself', () => {
    const clock = cardClock(
      settings({
        NumberOfCardsToReceiveEachTurn: 1,
        AirliftCard: card({ NumPieces: 3, Weight: 0 }),
        GiftCard: card({ NumPieces: 2, MinimumPiecesPerTurn: 1 }),
      }),
    )!;
    expect(clock.cards.find((c) => c.card === 'Airlift')).toMatchObject({ capturingTurns: { fastest: null, guaranteed: null }, firstPlayableTurn: { fastest: null, guaranteed: null } });
  });

  it('raises the pieces per turn to the sum of the minimums, as the game does', () => {
    const clock = cardClock(
      settings({
        NumberOfCardsToReceiveEachTurn: 1,
        ReinforcementCard: card({ MinimumPiecesPerTurn: 1 }),
        SpyCard: card({ MinimumPiecesPerTurn: 2 }),
      }),
    )!;
    expect(clock).toMatchObject({ piecesPerTurn: 3, randomPerTurn: 0, fixed: true });
  });

  it('carries leftover pieces over: 5 pieces at 2 a turn come after 3, 5 and 8 capturing turns, not every 3', () => {
    const clock = cardClock(settings({ NumberOfCardsToReceiveEachTurn: 2, BombCard: card({ NumPieces: 5, MinimumPiecesPerTurn: 2 }) }))!;
    expect(clock.cards[0]!.cardsAfter).toEqual({ fastest: [3, 5, 8], guaranteed: [3, 5, 8] });
  });

  it('when only one card can be drawn at random, the random pieces are its own for certain', () => {
    const clock = cardClock(
      settings({
        NumberOfCardsToReceiveEachTurn: 3,
        ReinforcementCard: card({ NumPieces: 6, MinimumPiecesPerTurn: 1, Weight: 1 }),
        SpyCard: card({ NumPieces: 4, MinimumPiecesPerTurn: 1, Weight: 0 }),
      }),
    )!;
    // 1 guaranteed + the 1 random piece, which can only be a Reinforcement piece: 2 a turn.
    expect(clock).toMatchObject({ piecesPerTurn: 3, randomPerTurn: 1, fixed: true });
    expect(clock.cards.find((c) => c.card === 'Reinforcement')).toMatchObject({ capturingTurns: { fastest: 3, guaranteed: 3 } });
    expect(clock.cards.find((c) => c.card === 'Spy')).toMatchObject({ capturingTurns: { fastest: 4, guaranteed: 4 } });
  });

  it('does not call the hand-out fixed when the pieces per turn could not be read', () => {
    const clock = cardClock(settings({ ReinforcementCard: card({ MinimumPiecesPerTurn: 1 }) }))!;
    expect(clock).toMatchObject({ piecesPerTurn: 1, fixed: false, piecesPerTurnKnown: false });
  });

  it('counts per player, and says so: a team shares one hand', () => {
    expect(cardClock(fixtureSettings())!.perPlayer).toMatch(/team/);
  });

  it('gives no piece value when the Reinforcement card is not a fixed number of armies', () => {
    const clock = cardClock(settings({ NumberOfCardsToReceiveEachTurn: 1, ReinforcementCard: card({ MinimumPiecesPerTurn: 1 }) }))!;
    expect(clock.cards[0]!.pieceValue).toBeUndefined();
  });
});
