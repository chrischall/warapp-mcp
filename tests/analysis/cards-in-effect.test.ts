import { describe, expect, it } from 'vitest';
import { cardsInEffect, sanctionedIncome, type EffectPlayer } from '../../src/analysis/cards-in-effect.js';
import type { ActiveCard } from '../../src/cards.js';
import type { GameSettings } from '../../src/normalize.js';

// PLAN-TEAMS D3: the cards in effect the planner may rely on. In-game ids 11/22/33, GameFeed ids 1011/1022/1033.
const ME = 1011;
const FOE = 1022;
const MATE = 1033;
const players = (over: Partial<Record<number, Partial<EffectPlayer>>> = {}): Map<number, EffectPlayer> =>
  new Map([
    [11, { id: ME, ...over[11] }],
    [22, { id: FOE, ...over[22] }],
    [33, { id: MATE, ...over[33] }],
  ]);
const settings = (raw: Record<string, unknown> = {}): GameSettings => ({
  cards: ['Diplomacy', 'Sanctions'],
  raw: { DiplomacyCard: { Duration: 2 }, SanctionsCard: { Duration: 1, Percentage: 0.5 }, ...raw },
});
const diplomacy = (a: number, b: number, untilTurn: number | undefined, playedBy = b): ActiveCard => ({
  card: 'Diplomacy',
  players: [a, b],
  playedBy,
  ...(untilTurn !== undefined ? { expiresAfterTurn: untilTurn - 1, untilTurn } : {}),
});
const sanctions = (target: number, untilTurn: number): ActiveCard => ({ card: 'Sanctions', target, playedBy: 22, expiresAfterTurn: untilTurn - 1, untilTurn });
const run = (active: ActiveCard[], over: { turn?: number | null; settings?: GameSettings; players?: Map<number, EffectPlayer> } = {}) =>
  cardsInEffect({
    active,
    players: over.players ?? players(),
    me: ME,
    turn: over.turn === undefined ? 5 : over.turn,
    settings: over.settings ?? settings(),
  });

describe('cardsInEffect: Diplomacy (PLAN-TEAMS D3, T9)', () => {
  it('is sure of a Diplomacy between me and an opponent, in effect this turn, within its duration', () => {
    const r = run([diplomacy(11, 22, 7)]);
    expect(r.diplomacy).toEqual([{ player: FOE, untilTurn: 7 }]);
    expect(r.unsure).toEqual([]);
  });

  it('reads the pair in either order and keeps the longest of two cards on one player', () => {
    expect(run([diplomacy(22, 11, 6), diplomacy(11, 22, 7)]).diplomacy).toEqual([{ player: FOE, untilTurn: 7 }]);
  });

  it('ignores a Diplomacy between two other players (it does not bind me)', () => {
    const r = run([diplomacy(22, 33, 7)]);
    expect(r.diplomacy).toEqual([]);
    expect(r.unsure).toEqual([]);
  });

  it('is not sure without the turn, the expiry, the card in the settings, or its duration', () => {
    for (const [why, r] of [
      ['turn', run([diplomacy(11, 22, 7)], { turn: null })],
      ['expiry', run([diplomacy(11, 22, undefined)])],
      ['not in play', run([diplomacy(11, 22, 7)], { settings: { cards: ['Sanctions'], raw: {} } })],
      ['duration', run([diplomacy(11, 22, 7)], { settings: settings({ DiplomacyCard: { NumPieces: 1 } }) })],
    ] as const) {
      expect(r.diplomacy, why).toEqual([]);
      expect(r.unsure.join('\n'), why).toMatch(/Diplomacy with player 1022/);
    }
  });

  it('is not sure of an expiry the card could not have (past, or beyond its duration)', () => {
    expect(run([diplomacy(11, 22, 5)]).unsure.join('\n')).toMatch(/already over/);
    // Duration 2 on turn 5: a card in effect lasts until turn 7 at most.
    expect(run([diplomacy(11, 22, 8)]).unsure.join('\n')).toMatch(/longer than the game's Diplomacy duration/);
  });

  it('is not sure of a player it cannot place, a teammate, or one no longer playing', () => {
    expect(run([diplomacy(11, 44, 7)]).unsure.join('\n')).toMatch(/not a player of this game/);
    const team = players({ 11: { team: 1 }, 33: { team: 1 } });
    expect(run([diplomacy(11, 33, 7)], { players: team }).unsure.join('\n')).toMatch(/teammate/);
    expect(run([diplomacy(11, 22, 7)], { players: players({ 22: { state: 'Eliminated' } }) }).diplomacy).toEqual([]);
    expect(run([diplomacy(11, 11, 7)]).diplomacy).toEqual([]);
  });
});

describe('cardsInEffect: Sanctions (PLAN-TEAMS D3)', () => {
  it('is sure of Sanctions on me in effect this turn, with the percentage the settings give', () => {
    const r = run([sanctions(11, 6)]);
    expect(r.sanctionsOnMe).toEqual([{ player: ME, percentage: 0.5, untilTurn: 6 }]);
    expect(r.sanctionsOnOthers).toEqual([]);
  });

  it('lists Sanctions on another player apart, never applied to an estimate', () => {
    const r = run([sanctions(22, 6)]);
    expect(r.sanctionsOnMe).toEqual([]);
    expect(r.sanctionsOnOthers).toEqual([{ player: FOE, percentage: 0.5, untilTurn: 6 }]);
  });

  it('is not sure without a readable percentage, or past the duration', () => {
    expect(run([sanctions(11, 6)], { settings: settings({ SanctionsCard: { Duration: 1 } }) }).sanctionsOnMe).toEqual([]);
    expect(run([sanctions(11, 6)], { settings: settings({ SanctionsCard: { Duration: 1, Percentage: 1.5 } }) }).sanctionsOnMe).toEqual([]);
    expect(run([sanctions(11, 7)]).unsure.join('\n')).toMatch(/Sanctions on you/);
  });
});

describe('sanctionedIncome (the client bundle: round half up of (1 − p) × income, per card)', () => {
  it('cuts by each card in turn and rounds .5 up', () => {
    expect(sanctionedIncome(15, [0.5])).toBe(8);
    expect(sanctionedIncome(15, [0.6])).toBe(6);
    expect(sanctionedIncome(20, [0.5, 0.5])).toBe(5);
    expect(sanctionedIncome(10, [])).toBe(10);
  });

  it('a negative percentage raises it, capped at 10000', () => {
    expect(sanctionedIncome(10, [-0.5])).toBe(15);
    expect(sanctionedIncome(9000, [-0.5])).toBe(10000);
  });
});
