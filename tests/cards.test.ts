import { describe, expect, it } from 'vitest';
import {
  CARD_TYPES,
  cardRules,
  cardTypeByName,
  chooseCardPlays,
  readHand,
  type Card,
} from '../src/cards.js';
import { readLatestGameInfo } from '../src/live.js';
import { normalizeSettings } from '../src/normalize.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import { Reader, Writer } from '../src/protocol/codec.js';
import { LIVE_BUNDLE, writeLatestGameInfo, type SyntheticCard } from './protocol/live-bundle.js';

const bundle = new WarappBundle(LIVE_BUNDLE, 'test');
const ME = 123456;
const OTHER = 765432;
const G1 = '0123456789abcdef0123456789abcdef';
const G2 = 'fedcba9876543210fedcba9876543210';
const G3 = '11111111222222223333333344444444';

function info(hands: Record<number, SyntheticCard[]>, players = [ME, OTHER]): unknown {
  const w = new Writer();
  writeLatestGameInfo(w, [{ id: 1, fogLevel: 1, owner: ME, armies: 3 }], players, hands);
  return readLatestGameInfo(bundle, new Reader(w.bytes()));
}

describe('card types', () => {
  it('has the client registry ids', () => {
    expect(CARD_TYPES[1]).toBe('Reinforcement');
    expect(CARD_TYPES[4]).toBe('Order Priority');
    expect(CARD_TYPES[5]).toBe('Order Delay');
    expect(CARD_TYPES[12]).toBe('Blockade');
    expect(CARD_TYPES[13]).toBe('Bomb');
    expect(Object.keys(CARD_TYPES)).toHaveLength(13);
  });

  it('resolves a type by name, loosely', () => {
    expect(cardTypeByName('Reinforcement')).toBe(1);
    expect(cardTypeByName('order priority')).toBe(4);
    expect(cardTypeByName('OrderDelay')).toBe(5);
    expect(cardTypeByName('Emergency Blockade Card')).toBe(3);
    expect(cardTypeByName('blockade')).toBe(12);
    expect(cardTypeByName('joker')).toBeUndefined();
  });
});

describe('readHand', () => {
  it('reads my cards from the live board by type name, with Reinforcement armies', () => {
    const hand = readHand(
      info({
        [ME]: [
          { id: G1, type: 1, armies: 5 },
          { id: G2, type: 4 },
        ],
        [OTHER]: [{ id: G3, type: 12 }],
      }),
      ME,
    );
    expect(hand).toEqual<Card[]>([
      { id: G1, type: 1, name: 'Reinforcement', armies: 5 },
      { id: G2, type: 4, name: 'Order Priority' },
    ]);
  });

  it('does not mislabel a Reinforcement card whose armies collide with another type id (#20)', () => {
    // Live: a ReinforcementCardInstance decodes as [tc=armies, Gb=type]. Reading the type from the
    // first integer picked up tc (5) and labelled the Reinforcement as "Order Delay" (type 5), so
    // the planner tried to play the wrong card. The type is the LAST integer (Gb); tc is the first.
    const hand = readHand(info({ [ME]: [{ id: G1, type: 1, armies: 5 }, { id: G2, type: 5 }] }), ME);
    expect(hand).toEqual<Card[]>([
      { id: G1, type: 1, name: 'Reinforcement', armies: 5 },
      { id: G2, type: 5, name: 'Order Delay' },
    ]);
  });

  it('is empty when I hold no cards or the board carries none', () => {
    expect(readHand(info({}), ME)).toEqual([]);
    expect(readHand(info({ [ME]: [] }), ME)).toEqual([]);
    expect(readHand(null, ME)).toEqual([]);
  });

  // A decoded LatestGameInfo in the live field order (#20): pending orders, the CURRENT
  // GameStanding, the last GameTurn, the PREVIOUS GameStanding, then the turn number. Only the
  // current standing is the hand — the rest still carries stale, already-played instances.
  const GA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const GB = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const GC = 'cccccccccccccccccccccccccccccccc';
  const GD = 'dddddddddddddddddddddddddddddddd';
  const GE = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const GF = 'ffffffffffffffffffffffffffffffff';
  const inst = (id: string, type: number, armies?: number) =>
    armies !== undefined
      ? { $type: 'warlight.shared.ReinforcementCardInstance', c1: id, c2: armies, c3: type }
      : { $type: 'warlight.shared.NoParameterCardInstance', c1: id, c2: type };
  const standing = (hands: Record<number, Array<ReturnType<typeof inst>>>) => ({
    $type: 'warlight.shared.GameStanding',
    q1: Object.entries(hands).map(([pid, cards]) => [
      Number(pid),
      { $type: 'x.PlayerCards', z1: 0, z2: cards.map((c) => [c.c1, c]) },
    ]),
    q2: [],
  });
  const liveInfo = (current: unknown) => ({
    $type: 'warlight.shared.LatestGameInfo',
    a: [{ $type: 'warlight.shared.GameOrderPlayCardReinforcement', p: ME, card: GE }, inst(GE, 1, 5)],
    b: current,
    c: {
      $type: 'warlight.shared.GameTurn',
      o: [
        { $type: 'warlight.shared.GameOrderReceiveCard', p: ME, l: [[ME, [inst(GB, 1, 5), inst(GC, 4)]]] },
        { $type: 'warlight.shared.GameOrderPlayCardBlockade', p: ME, card: inst(GD, 12) },
      ],
    },
    d: standing({ [ME]: [inst(GA, 5), inst(GD, 12), inst(GE, 1, 5)] }),
    e: 7,
  });

  it('reads the hand from the current standing only, never stale instances (#20)', () => {
    const hand = readHand(liveInfo(standing({ [ME]: [inst(GA, 5), inst(GB, 1, 5), inst(GC, 4)] })), ME);
    expect(hand).toEqual<Card[]>([
      { id: GA, type: 5, name: 'Order Delay' },
      { id: GB, type: 1, name: 'Reinforcement', armies: 5 },
      { id: GC, type: 4, name: 'Order Priority' },
    ]);
  });

  it("still excludes another player's cards in the current standing", () => {
    const hand = readHand(liveInfo(standing({ [ME]: [inst(GA, 5)], [OTHER]: [inst(GF, 12)] })), ME);
    expect(hand.map((c) => c.id)).toEqual([GA]);
  });

  it('is empty when the info carries no GameStanding', () => {
    const noStanding = { ...liveInfo(null), b: null, d: null };
    expect(readHand(noStanding, ME)).toEqual([]);
    expect(readHand({ $type: 'warlight.shared.LatestGameInfo', a: [[ME, inst(GA, 5)]] }, ME)).toEqual([]);
  });

  it('names an unknown card type by its id and never throws on odd shapes', () => {
    expect(readHand(info({ [ME]: [{ id: G1, type: 99 }] }), ME)).toEqual([{ id: G1, type: 99, name: 'Card 99' }]);
    const odd = { $type: 'warlight.shared.GameStanding', a: [[1, { $type: 'warlight.shared.NoParameterCardInstance', b: 'nope' }]] };
    expect(readHand({ $type: 'x', s: odd }, 1)).toEqual([]);
  });
});

describe('cardRules', () => {
  it('reads MaxCardsHold, cards per turn, Reinforcement armies and the cards in play', () => {
    const rules = cardRules(
      normalizeSettings({
        MaxCardsHold: 4,
        NumberOfCardsToReceiveEachTurn: '1',
        ReinforcementCard: { NumPieces: 5, FixedArmies: 5 },
        OrderPriorityCard: { NumPieces: 4 },
        BlockadeCard: 'none',
      }),
    );
    expect(rules).toEqual({ maxCardsHold: 4, cardsPerTurn: 1, reinforcementArmies: 5, inPlay: ['Reinforcement', 'Order Priority'] });
  });

  it('is empty without settings', () => {
    expect(cardRules(undefined)).toEqual({ inPlay: [] });
  });
});

describe('chooseCardPlays', () => {
  const r = (armies?: number): Card => ({ id: G1, type: 1, name: 'Reinforcement', ...(armies !== undefined ? { armies } : {}) });
  const op: Card = { id: G2, type: 4, name: 'Order Priority' };
  const od: Card = { id: G3, type: 5, name: 'Order Delay' };
  const bl: Card = { id: '99999999999999999999999999999999', type: 12, name: 'Blockade' };

  it('always plays Reinforcement, adding its armies', () => {
    const c = chooseCardPlays([r(5), op], { maxCardsHold: 4, inPlay: [] });
    expect(c.required).toBe(false);
    expect(c.plays).toEqual([r(5)]);
    expect(c.extraArmies).toBe(5);
  });

  it('falls back to the settings armies for a Reinforcement card', () => {
    const c = chooseCardPlays([r()], { reinforcementArmies: 7, inPlay: [] });
    expect(c.extraArmies).toBe(7);
  });

  it('does not play a Reinforcement card whose armies are unknown, and says so', () => {
    const c = chooseCardPlays([r()], { inPlay: [] });
    expect(c.plays).toEqual([]);
    expect(c.warnings.join('\n')).toMatch(/armies/);
  });

  it('at the hold limit plays Order Priority, else Order Delay', () => {
    expect(chooseCardPlays([op, od, bl], { maxCardsHold: 3, inPlay: [] }).plays).toEqual([op]);
    expect(chooseCardPlays([bl, od], { maxCardsHold: 2, inPlay: [] }).plays).toEqual([od]);
    expect(chooseCardPlays([bl, od], { maxCardsHold: 2, inPlay: [] }).required).toBe(true);
  });

  it('a Reinforcement play satisfies the hold limit', () => {
    expect(chooseCardPlays([op, r(5)], { maxCardsHold: 2, inPlay: [] }).plays).toEqual([r(5)]);
  });

  it('never auto-plays Blockade; warns when a play is required and none can be chosen', () => {
    const c = chooseCardPlays([bl, bl], { maxCardsHold: 2, inPlay: [] });
    expect(c.required).toBe(true);
    expect(c.plays).toEqual([]);
    expect(c.warnings.join('\n')).toMatch(/must play a card/);
  });

  it('no play needed below the limit with no Reinforcement', () => {
    const c = chooseCardPlays([op], { maxCardsHold: 4, inPlay: [] });
    expect(c).toEqual({ required: false, plays: [], extraArmies: 0, warnings: [] });
  });
});
