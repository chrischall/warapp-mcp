// How a note says which games it is for: a declarative condition tested against the game's
// profile and the settings the profile does not carry.
import { describe, expect, it } from 'vitest';
import type { GameProfile } from '../../src/analysis/profile.js';
import { normalizeSettings } from '../../src/normalize.js';
import { noteContext, noteMatches, type NoteCondition, type NoteContext } from '../../src/strategy/notes.js';
import { fixtureSettings } from '../analysis/helpers.js';

const profile = (over: Partial<GameProfile> = {}, settings: Partial<GameProfile['settings']> = {}): GameProfile => ({
  format: '1v1',
  opponents: 1,
  phase: 'expansion',
  standing: 'even',
  standingSource: 'visible',
  notes: [],
  ...over,
  settings: { luck: 0, rounding: 'StraightRound', cards: false, localDeployments: false, noSplit: false, commanders: false, fog: 'Foggy', ...settings },
});
const ok = (c: NoteCondition, p: GameProfile = profile(), x: NoteContext = {}) => noteMatches(c, p, x);

describe('noteMatches', () => {
  it('an empty condition fits every game', () => {
    expect(ok({})).toBe(true);
  });

  it('format, phase and fog must be among those listed', () => {
    expect(ok({ format: ['ffa', 'teams'] })).toBe(false);
    expect(ok({ format: ['1v1'] })).toBe(true);
    expect(ok({ phase: ['contact', 'late'] })).toBe(false);
    expect(ok({ phase: ['contact', 'late'] }, profile({ phase: 'late' }))).toBe(true);
    expect(ok({ fog: ['LightFog', 'ModerateFog'] })).toBe(false);
    expect(ok({ fog: ['Foggy'] })).toBe(true);
    // A game whose fog is not known fits no fog condition.
    expect(ok({ fog: ['Foggy'] }, profile({}, { fog: null }))).toBe(false);
  });

  it('a standing condition also fits when the standing is unknown', () => {
    expect(ok({ standing: ['behind'] })).toBe(false);
    expect(ok({ standing: ['behind'] }, profile({ standing: 'behind' }))).toBe(true);
    expect(ok({ standing: ['behind'] }, profile({ standing: 'unknown' }))).toBe(true);
  });

  it('a card condition needs one of its cards in play; without the list, any card in play will do', () => {
    const withCards = profile({}, { cards: true });
    expect(ok({ cardsInPlay: ['Bomb'] }, withCards, { cardsInPlay: ['Reinforcement', 'Bomb'] })).toBe(true);
    expect(ok({ cardsInPlay: ['Bomb', 'Airlift'] }, withCards, { cardsInPlay: ['Reinforcement'] })).toBe(false);
    expect(ok({ cardsInPlay: ['Bomb'] }, withCards)).toBe(true);
    expect(ok({ cardsInPlay: ['Bomb'] }, profile())).toBe(false);
    expect(ok({ anyCards: true }, withCards)).toBe(true);
    expect(ok({ anyCards: true })).toBe(false);
  });

  it('settings the profile carries: commanders, Local Deployment, No-Split, exact results', () => {
    expect(ok({ commanders: true })).toBe(false);
    expect(ok({ commanders: true }, profile({}, { commanders: true }))).toBe(true);
    expect(ok({ commanders: false })).toBe(true);
    expect(ok({ localDeployments: true }, profile({}, { localDeployments: true }))).toBe(true);
    expect(ok({ noSplit: false }, profile({}, { noSplit: true }))).toBe(false);
    expect(ok({ exact: true })).toBe(true);
    expect(ok({ exact: true }, profile({}, { luck: 16 }))).toBe(false);
    expect(ok({ exact: true }, profile({}, { rounding: 'WeightedRandom' }))).toBe(false);
  });

  it('settings from the context: the guard is on unless said otherwise, the rest must be stated', () => {
    expect(ok({ guard: true })).toBe(true);
    expect(ok({ guard: false })).toBe(false);
    expect(ok({ guard: false }, profile(), { oneArmyStandsGuard: false })).toBe(true);
    expect(ok({ multiAttack: true })).toBe(false);
    expect(ok({ multiAttack: true }, profile(), { multiAttack: true })).toBe(true);
    expect(ok({ moveOrder: ['Cycle', 'NoLuckCycle'] })).toBe(false);
    expect(ok({ moveOrder: ['Cycle', 'NoLuckCycle'] }, profile(), { moveOrder: 'Cycle' })).toBe(true);
    expect(ok({ distribution: 'manual' })).toBe(false);
    expect(ok({ distribution: 'manual' }, profile(), { distribution: 'manual' })).toBe(true);
    expect(ok({ territoryIncome: true }, profile(), { bonusArmyPer: 0 })).toBe(false);
    expect(ok({ territoryIncome: true }, profile(), { bonusArmyPer: 6 })).toBe(true);
    for (const key of ['attackOnlyAllowed', 'transferOnlyAllowed', 'percentageAllowed', 'commerce'] as const) {
      expect(ok({ [key]: true }), key).toBe(false);
      expect(ok({ [key]: true }, profile(), { [key]: true }), key).toBe(true);
    }
  });

  it('kill rates: the default pair, and defence out-killing attack', () => {
    expect(ok({ defaultKillRates: true })).toBe(true);
    expect(ok({ defaultKillRates: true }, profile(), { offensiveKillRate: 20, defensiveKillRate: 80 })).toBe(false);
    expect(ok({ defenceBeatsOffence: true })).toBe(true);
    expect(ok({ defenceBeatsOffence: true }, profile(), { offensiveKillRate: 75, defensiveKillRate: 60 })).toBe(false);
  });

  it('every key given must hold', () => {
    const c: NoteCondition = { format: ['1v1'], phase: ['contact'], guard: true };
    expect(ok(c)).toBe(false);
    expect(ok(c, profile({ phase: 'contact' }))).toBe(true);
  });
});

describe('noteContext: what the notes need from the game settings', () => {
  it('reads the anonymized lobby fixture', () => {
    expect(noteContext(fixtureSettings())).toEqual({
      offensiveKillRate: 60,
      defensiveKillRate: 70,
      armyCap: null,
      multiAttack: false,
      cardsInPlay: ['Reinforcement', 'Blockade', 'Airlift', 'Diplomacy', 'Sanctions', 'Reconnaissance'],
      oneArmyStandsGuard: true,
      moveOrder: 'Cycle',
      distribution: 'automatic',
      bonusArmyPer: 0,
      attackOnlyAllowed: false,
      transferOnlyAllowed: false,
      percentageAllowed: false,
      commerce: false,
      wastelands: false,
    });
  });

  it('reads manual distribution, the order modes and a commerce game', () => {
    const x = noteContext(
      normalizeSettings({
        AutomaticTerritoryDistribution: 'Manual',
        AllowAttackOnly: true,
        AllowTransferOnly: 'True',
        AllowPercentageAttacks: true,
        Commerce: { ArmyCost: 3 },
        MoveOrder: 'NoLuckCycle',
        OrderDelayCard: { NumPieces: 4 },
      }),
    );
    expect(x).toMatchObject({
      distribution: 'manual',
      attackOnlyAllowed: true,
      transferOnlyAllowed: true,
      percentageAllowed: true,
      commerce: true,
      moveOrder: 'NoLuckCycle',
      cardsInPlay: ['Order Delay'],
    });
  });

  it('counts wastelands only when they are walls: at least 5 armies and twice an ordinary neutral', () => {
    const w = (n: number, size: number, neutral = 2) =>
      noteContext(normalizeSettings({ Wastelands: { NumberOfWastelands: n, WastelandSize: size }, InitialNonDistributionArmies: neutral })).wastelands;
    expect(w(5, 10)).toBe(true);
    expect(w(0, 10)).toBe(false);
    // Many small "wastelands" no bigger than the neutrals around them are just neutrals.
    expect(w(85, 3)).toBe(false);
    expect(w(15, 4, 2)).toBe(false);
    expect(w(4, 6, 4)).toBe(false);
    expect(w(4, 8, 4)).toBe(true);
  });

  it('is empty without settings', () => {
    expect(noteContext(undefined)).toEqual({});
  });
});
