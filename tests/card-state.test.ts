// My card state (owner request 2026-11-24, Airlift part 1): whole cards by type and the pieces toward the next.
// Synthetic shapes only (made-up GUIDs and ids), in the decoded GameStanding's shape `readHand` reads.
import { describe, expect, it } from 'vitest';
import { cardState, countOf, heldCards, readPieces } from '../src/card-state.js';
import { normalizeSettings } from '../src/normalize.js';

const ME = 123456;
const MATE = 222222;
const GA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const GB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GC = 'cccccccccccccccccccccccccccccccc';
const inst = (id: string, type: number, armies?: number) =>
  armies !== undefined
    ? { $type: 'warlight.shared.ReinforcementCardInstance', c1: id, c2: armies, c3: type }
    : { $type: 'warlight.shared.NoParameterCardInstance', c1: id, c2: type };
type Entry = { cards: ReturnType<typeof inst>[]; pieces?: Array<[unknown, number]> };
const info = (entries: Record<number, Entry>) => ({
  $type: 'warlight.shared.LatestGameInfo',
  b: {
    $type: 'warlight.shared.GameStanding',
    q1: Object.entries(entries).map(([pid, e]) => [
      Number(pid),
      { $type: 'x.PlayerCards', z1: Number(pid), z2: e.pieces ?? [], z3: e.cards.map((c) => [c.c1, c]) },
    ]),
    q2: [],
  },
});
const SETTINGS = normalizeSettings({
  MaxCardsHold: 3,
  ReinforcementCard: { NumPieces: 5, FixedArmies: 5 },
  AirliftCard: { NumPieces: 4 },
});

describe('card state', () => {
  it('groups whole cards by type', () => {
    expect(heldCards([
      { id: GA, type: 6, name: 'Airlift' },
      { id: GB, type: 1, name: 'Reinforcement', armies: 5 },
      { id: GC, type: 6, name: 'Airlift' },
    ])).toEqual([
      { type: 1, name: 'Reinforcement', count: 1, armies: 5 },
      { type: 6, name: 'Airlift', count: 2 },
    ]);
  });

  it('reads the pieces dict by shape (type id → count), summing a team', () => {
    const i = info({ [ME]: { cards: [inst(GA, 6)], pieces: [[6, 3], [1, 2]] }, [MATE]: { cards: [], pieces: [[6, 1]] } });
    expect(readPieces(i, ME)).toEqual(new Map([[6, 3], [1, 2]]));
    expect(readPieces(i, [ME, MATE])).toEqual(new Map([[6, 4], [1, 2]]));
    // A key that is a record carrying the type id reads the same.
    expect(readPieces(info({ [ME]: { cards: [], pieces: [[{ $type: 'x.CardType', v: 6 }, 2]] } }), ME)).toEqual(new Map([[6, 2]]));
  });

  it('reads an entry with no pieces as none, and no entry as unknown', () => {
    expect(readPieces(info({ [ME]: { cards: [inst(GA, 6)] } }), ME)).toEqual(new Map());
    expect(readPieces(info({ [MATE]: { cards: [] } }), ME)).toBeUndefined();
    expect(readPieces(null, ME)).toBeUndefined();
  });

  it('gives the held cards, the limit and the pieces of each card in play', () => {
    const s = cardState(info({ [ME]: { cards: [inst(GA, 6), inst(GB, 6), inst(GC, 1, 5)], pieces: [[6, 3]] } }), ME, SETTINGS)!;
    expect(s.held).toEqual([
      { type: 1, name: 'Reinforcement', count: 1, armies: 5 },
      { type: 6, name: 'Airlift', count: 2 },
    ]);
    expect(s.total).toBe(3);
    expect(s.maxCardsHold).toBe(3);
    expect(s.pieces).toEqual([
      { type: 1, name: 'Reinforcement', pieces: 0, of: 5 },
      { type: 6, name: 'Airlift', pieces: 3, of: 4 },
    ]);
    expect(s.note).toMatch(/UNVERIFIED/);
    expect(countOf(s, 'Airlift')).toBe(2);
    expect(countOf(s, 'Gift')).toBe(0);
  });

  it('says pieces are unknown when they cannot be read, and nothing without cards in play', () => {
    const s = cardState(info({ [MATE]: { cards: [] } }), ME, SETTINGS)!;
    expect(s.pieces).toBeNull();
    expect(s.held).toEqual([]);
    expect(cardState(info({}), ME, normalizeSettings({}))).toBeUndefined();
  });

  it("states each card's settings that change how it plays: the Sanctions percentage's sign and whom it goes on (owner request 2026-11-24)", () => {
    const settings = normalizeSettings({
      AirliftCard: { NumPieces: 4 },
      DiplomacyCard: { NumPieces: 4, Duration: 2 },
      SanctionsCard: { NumPieces: 10, Duration: 1, Percentage: -0.3 },
    });
    const s = cardState(info({ [ME]: { cards: [] } }), ME, settings)!;
    expect(s.settings).toEqual([
      { type: 8, name: 'Diplomacy', duration: 2 },
      { type: 9, name: 'Sanctions', duration: 1, percentage: -0.3, effect: 'boost', targets: 'your side' },
    ]);
    const cut = cardState(info({ [ME]: { cards: [] } }), ME, normalizeSettings({ SanctionsCard: { NumPieces: 4, Duration: 1, Percentage: 0.5 } }))!;
    expect(cut.settings).toEqual([{ type: 9, name: 'Sanctions', duration: 1, percentage: 0.5, effect: 'cut', targets: 'opponents' }]);
    // A game with no such card states none.
    expect(cardState(info({ [ME]: { cards: [] } }), ME, SETTINGS)!).not.toHaveProperty('settings');
  });
});
