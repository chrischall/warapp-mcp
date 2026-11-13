import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../src/board.js';
import { buildGraph } from '../src/analysis/graph.js';
import type { Card, CardChoice } from '../src/cards.js';
import type { GameSettings, Player } from '../src/normalize.js';
import { adviseCards, cardGame, cardPieceOption, handOwners, type CardAdviceInput } from '../src/tools/card-advice.js';
import { normalizeSettings } from '../src/normalize.js';
import { board, mine, neutral, tinyMap } from './analysis/helpers.js';

// Synthetic GameFeed ids: the in-game id wrapped in two check digits each end.
const ME: Player = { id: 3312345644, name: 'Ann', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: 'Playing' };
const FOE: Player = { id: 7176543229, name: 'Bob', isAI: false, humanTurnedIntoAI: false, hasCommittedOrders: false, state: 'Playing' };
const ME_IN = 123456;
const FOE_IN = 765432;
const g = buildGraph(tinyMap());
const piece = { NumPieces: 1, InitialPieces: 1, MinimumPiecesPerTurn: 0, Weight: 1 };
const settings = (over: Record<string, unknown> = {}): GameSettings => ({
  cards: ['Bomb', 'EmergencyBlockade', 'Diplomacy', 'Sanctions'],
  fog: 'Foggy',
  raw: {
    BombCard: piece,
    EmergencyBlockadeCard: { ...piece, MultiplyAmount: 3 },
    DiplomacyCard: { ...piece, Duration: 2 },
    SanctionsCard: { ...piece, Duration: 1, Percentage: 0.5 },
    ...over,
  },
});
const foe = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE.id }, armies });
const me = (territoryId: number, armies: number) => mine(territoryId, armies, ME.id);
const none: CardChoice = { required: false, plays: [], discards: [], extraArmies: 0, warnings: [] };

function input(over: Partial<CardAdviceInput> & { territories: TerritoryState[] }): CardAdviceInput {
  const { territories, ...rest } = over;
  return {
    game: { players: [ME, FOE], settings: settings() },
    me: ME,
    turn: 3,
    info: null,
    hand: [],
    choice: none,
    plan: { deploys: [], moves: [], moveSlots: [], enemyDeploy: 5, conceded: [] },
    board: board(territories),
    graph: g,
    settings: { offensiveKillRate: 60, defensiveKillRate: 70 },
    label: (id) => `T${id}`,
    ...rest,
  };
}

describe('adviseCards (#163)', () => {
  it("warns of a border an opponent's Bomb would break, from the turn it can hold one", () => {
    const territories = [neutral(3, 2), me(4, 12), foe(5, 8), neutral(6, 2)];
    const { warnings } = adviseCards(input({ territories }));
    expect(warnings.join('\n')).toMatch(/If an opponent plays a Bomb, T4 \(12 → 6\) falls to player 7176543229's ~12/);
    // Before any opponent can hold one (it needs 3 pieces, 1 a turn at most), nothing is said.
    const later = settings({ BombCard: { NumPieces: 3, InitialPieces: 0, MinimumPiecesPerTurn: 0, Weight: 1 } });
    const early = adviseCards(input({ territories, turn: 2, game: { players: [ME, FOE], settings: later } }));
    expect(early.warnings.join('\n')).not.toMatch(/Bomb/);
  });

  it("warns of an attack an opponent's Emergency Blockade would stop", () => {
    const plan = { deploys: [], moves: [{ from: 4, to: 5, armies: 19, kind: 'attack' as const, reason: '' }], moveSlots: ['sure' as const], enemyDeploy: 5, conceded: [] };
    const { warnings } = adviseCards(input({ territories: [neutral(3, 2), me(4, 20), foe(5, 4), neutral(6, 2)], plan }));
    expect(warnings.join('\n')).toMatch(/The attack on T5 \(19 armies\) would die against an Emergency Blockade: .* × 3 ≈ 27/);
  });

  it('offers my Emergency Blockade on a conceded border where the wall pays', () => {
    const eb: Card = { id: 'e'.repeat(32), type: 3, name: 'Emergency Blockade' };
    const plan = { deploys: [], moves: [], moveSlots: [], enemyDeploy: 5, conceded: [4] };
    const { view, warnings } = adviseCards(input({ territories: [neutral(3, 2), me(4, 10), foe(5, 30), neutral(6, 2)], plan, hand: [eb] }));
    expect(view.emergencyBlockade).toMatchObject({ territory: 4, wall: 30, kills: 21 });
    expect(warnings.join('\n')).toMatch(/Consider an Emergency Blockade on T4/);
  });

  it('reads Diplomacy and Sanctions in effect: attacks on a protected player do nothing, Sanctions cut my income', () => {
    const order = (kind: string, ...ints: number[]) => ({
      $type: `warlight.shared.GameOrderPlayCard${kind}`,
      ...Object.fromEntries(ints.map((n, i) => [`f${i}`, n])),
      g: 'ab'.repeat(16),
      p: FOE_IN,
    });
    const info = {
      $type: 'warlight.shared.LatestGameInfo',
      s: {
        $type: 'warlight.shared.GameStanding',
        a: [
          { $type: 'warlight.shared.ActiveCard', c: order('Diplomacy', ME_IN, FOE_IN), e: 4 },
          { $type: 'warlight.shared.ActiveCard', c: order('Sanctions', ME_IN), e: 3 },
        ],
      },
    };
    const plan = { deploys: [], moves: [{ from: 4, to: 5, armies: 19, kind: 'attack' as const, reason: '' }], moveSlots: ['sure' as const], enemyDeploy: 0, conceded: [] };
    const { view, warnings } = adviseCards(
      input({ territories: [neutral(3, 2), me(4, 20), foe(5, 1), neutral(6, 2)], plan, info, game: { players: [ME, FOE], settings: settings({ EmergencyBlockadeCard: 'none' }) } }),
    );
    expect(view.active).toEqual([
      { card: 'Diplomacy', players: [ME.id, FOE.id], playedBy: FOE.id, expiresAfterTurn: 4, untilTurn: 5 },
      { card: 'Sanctions', target: ME.id, playedBy: FOE.id, expiresAfterTurn: 3, untilTurn: 4 },
    ]);
    const w = warnings.join('\n');
    expect(w).toMatch(/Diplomacy is in effect between you and player 7176543229 \(until turn 5\).*attacks on T5 would do nothing/);
    expect(w).toMatch(/Sanctions are on you \(until turn 4\): your income is cut by 50%/);
    expect(w).toMatch(/unverified decoder/);
  });
});

describe('the game around the hand (#163)', () => {
  it('a team game, its players and fog', () => {
    expect(cardGame({ players: [ME, FOE], settings: settings() })).toEqual({ players: 2, team: false, fog: 'Foggy' });
    expect(cardGame({ players: [{ ...ME, team: 0 }, { ...FOE, team: 1 }], settings: undefined })).toEqual({ players: 2, team: true });
  });

  it("the hand's owners: me, and my teammates in a team game", () => {
    expect(handOwners({ players: [ME, FOE] }, ME)).toEqual([ME_IN]);
    const a = { ...ME, team: 1 };
    expect(handOwners({ players: [a, { ...FOE, team: 1 }, { ...FOE, id: 1002, team: 1 }] }, a)).toEqual([ME_IN, FOE_IN]);
  });
});

describe('cardPieceOption (#127): the planner option a capture\'s card pieces are worth', () => {
  const fixed = normalizeSettings({
    NumberOfCardsToReceiveEachTurn: 1,
    ReinforcementCard: { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 1, Weight: 1, FixedArmies: 8 },
  });
  const progressive = normalizeSettings({
    NumberOfCardsToReceiveEachTurn: 1,
    ReinforcementCard: { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 1, Weight: 1, Mode: 1, ProgressivePercentage: 0.1 },
  });
  const rein = (armies: number): Card => ({ id: 'a'.repeat(32), type: 1, name: 'Reinforcement', armies });

  it('passes the value of a fixed Reinforcement card', () => {
    expect(cardPieceOption(fixed, [])).toEqual({ cardPieceValue: 2 });
  });

  it('values a progressive card at the one in hand, and passes nothing without one', () => {
    expect(cardPieceOption(progressive, [rein(12)])).toEqual({ cardPieceValue: 3 });
    expect(cardPieceOption(progressive, [])).toEqual({});
    expect(cardPieceOption(undefined, [])).toEqual({});
  });
});
