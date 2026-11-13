import { describe, expect, it } from 'vitest';
import {
  CARD_TYPES,
  cardRules,
  cardTypeByName,
  cardsToShed,
  chooseCardPlays,
  holdsOrderPriority,
  advisedOrderPriority,
  adviseOrderDelay,
  readActiveCards,
  playRequired,
  handReadable,
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

  it('tells an unreadable hand from an empty one: my player entry must be there (#130)', () => {
    expect(handReadable(info({}), ME)).toBe(true);
    expect(handReadable(info({ [ME]: [{ id: G1, type: 5 }] }), ME)).toBe(true);
    expect(handReadable(info({}, [OTHER]), ME)).toBe(false);
    expect(handReadable(null, ME)).toBe(false);
  });

  it('reads a team hand as readable when any of its owners has an entry, as readHand gathers them (#163)', () => {
    expect(handReadable(info({}, [OTHER]), [ME, OTHER])).toBe(true);
    expect(handReadable(info({}, [OTHER]), [ME])).toBe(false);
    expect(handReadable(info({}, []), [ME, OTHER])).toBe(false);
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

  it("in a team game reads the team's hand: every teammate's entry, one card once (#163, unverified live)", () => {
    const hand = readHand(
      liveInfo(standing({ [ME]: [inst(GA, 5)], [OTHER]: [inst(GA, 5), inst(GB, 1, 5)], 999999: [inst(GF, 12)] })),
      [ME, OTHER],
    );
    expect(hand.map((c) => c.id)).toEqual([GA, GB]);
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

  const sp: Card = { id: '88888888888888888888888888888888', type: 2, name: 'Spy' };
  const al: Card = { id: '77777777777777777777777777777777', type: 6, name: 'Airlift' };
  const bl2: Card = { ...bl, id: '99999999999999999999999999999998' };

  it('over the hold limit keeps Order Delay: the information card goes first (#163)', () => {
    // Every ranking read keeps the timing cards longest: an unplayed Order Delay is a threat in itself.
    const c = chooseCardPlays([op, od, bl, sp, al], { maxCardsHold: 4, inPlay: [] });
    expect(c.required).toBe(true);
    expect(c.plays).toEqual([]);
    expect(c.discards).toEqual([sp]);
  });

  it('keeps the timing cards longest: Order Delay, Order Priority, Emergency Blockade, Bomb, Airlift (#163)', () => {
    const eb: Card = { id: '55555555555555555555555555555555', type: 3, name: 'Emergency Blockade' };
    const bo: Card = { id: '44444444444444444444444444444444', type: 13, name: 'Bomb' };
    const gi: Card = { id: '33333333333333333333333333333333', type: 7, name: 'Gift' };
    const c = chooseCardPlays([od, op, eb, bo, al, gi, bl], { maxCardsHold: 5, inPlay: [] });
    expect(c.discards).toEqual([gi, bl]);
    // Seven must go down to one: Order Delay is the card kept; Order Priority, when it must go, is played.
    const d = chooseCardPlays([od, op, eb, bo, al, gi, bl], { maxCardsHold: 1, inPlay: [] });
    expect(d.plays).toEqual([op]);
    expect(d.discards).toEqual([gi, bl, al, bo, eb]);
  });

  it('plays Order Priority rather than discarding it when it is the card that must go', () => {
    const c = chooseCardPlays([op, r()], { maxCardsHold: 1, inPlay: [] });
    expect(c.plays).toEqual([op]);
    expect(c.discards).toEqual([]);
  });

  it('plays at most one Order Priority when two must go: the second adds nothing, so it is discarded', () => {
    const op2: Card = { ...op, id: '66666666666666666666666666666666' };
    const c = chooseCardPlays([op, op2, r()], { maxCardsHold: 1, inPlay: [] });
    expect(c.plays).toEqual([op]);
    expect(c.discards).toEqual([op2]);
  });

  it('says it plays an Order Priority because it must go, not because the plan advises it', () => {
    const c = chooseCardPlays([op, r()], { maxCardsHold: 1, inPlay: [] });
    expect(c.warnings).toContain(
      'You hold 2 cards (the limit is 1), so 1 must be played or discarded this turn. Playing Order Priority because it is ' +
        'the card that must go (a play costs nothing a discard would keep), whatever the plan advises for it.',
    );
  });

  it('a Reinforcement play satisfies the hold limit', () => {
    const c = chooseCardPlays([op, r(5), bl], { maxCardsHold: 2, inPlay: [] });
    expect(c.plays).toEqual([r(5)]);
    expect(c.discards).toEqual([]);
  });

  it('discards the lowest-value card when no play is useful (only Blockade, Order Delay, …)', () => {
    const c = chooseCardPlays([bl, od, bl2, al, sp], { maxCardsHold: 4, inPlay: [] });
    expect(c.required).toBe(true);
    expect(c.plays).toEqual([]);
    expect(c.discards).toEqual([sp]);
    expect(c.warnings.join('\n')).toMatch(/Discarding Spy/);
    expect(c.warnings.join('\n')).not.toMatch(/must play a card/);
    expect(c.warnings.join('\n')).not.toMatch(/holds back your own attacks/);
  });

  it('discards a Blockade when Blockades are all it holds', () => {
    const c = chooseCardPlays([bl, bl2], { maxCardsHold: 1, inPlay: [] });
    expect(c.plays).toEqual([]);
    expect(c.discards).toEqual([bl]);
  });

  it('sheds as many cards as the hand is over the limit: plays first, then the lowest-value discards', () => {
    expect(chooseCardPlays([bl, al, od, sp, bl2, op], { maxCardsHold: 3, inPlay: [] })).toMatchObject({
      plays: [],
      discards: [sp, bl, bl2],
    });
    expect(chooseCardPlays([r(5), op, bl, al, sp, bl2], { maxCardsHold: 4, inPlay: [] })).toMatchObject({
      plays: [r(5)],
      discards: [sp],
    });
  });

  it('discards a Reinforcement whose armies are unknown only as a last resort', () => {
    const c = chooseCardPlays([r(), al], { maxCardsHold: 1, inPlay: [] });
    expect(c.discards).toEqual([al]);
  });

  describe('keep values depend on the game (#163)', () => {
    const dip: Card = { id: '22222222222222222222222222222222', type: 8, name: 'Diplomacy' };
    const gi: Card = { id: '33333333333333333333333333333333', type: 7, name: 'Gift' };
    const rules = { maxCardsHold: 1, inPlay: [] };

    it('a Spy-type card goes first in a fogged game with several players', () => {
      expect(chooseCardPlays([dip, sp], rules, { players: 4, fog: 'Foggy' }).discards).toEqual([sp]);
    });

    it('Gift and Diplomacy are worth little in a 1v1: they go before an information card', () => {
      expect(chooseCardPlays([sp, dip], rules, { players: 2, fog: 'Foggy' }).discards).toEqual([dip]);
      expect(chooseCardPlays([sp, gi], rules, { players: 2, fog: 'Foggy' }).discards).toEqual([gi]);
    });

    it('the Spy-type cards are worth nothing without fog', () => {
      expect(chooseCardPlays([dip, sp], rules, { players: 2, fog: 'NoFog' }).discards).toEqual([sp]);
      const recon: Card = { id: '11111111111111111111111111111110', type: 10, name: 'Reconnaissance' };
      expect(chooseCardPlays([bl, recon], rules, { players: 4, fog: 'NoFog' }).discards).toEqual([recon]);
    });

    it('a team game of two teams is not a 1v1', () => {
      expect(chooseCardPlays([sp, dip], rules, { players: 4, team: true, fog: 'Foggy' }).discards).toEqual([sp]);
    });
  });

  describe('Reinforcement in a team game (#163)', () => {
    const r2: Card = { id: '12121212121212121212121212121212', type: 1, name: 'Reinforcement', armies: 5 };

    it('is not auto-played: the team shares one hand, and a teammate may need it more', () => {
      const c = chooseCardPlays([r(5), op], { maxCardsHold: 4, inPlay: [] }, { team: true });
      expect(c.plays).toEqual([]);
      expect(c.extraArmies).toBe(0);
      expect(c.warnings.join('\n')).toMatch(/team shares one hand/);
    });

    it('is played when cards must be shed: one per card over the limit, before any discard', () => {
      const c = chooseCardPlays([r(5), r2, bl], { maxCardsHold: 2, inPlay: [] }, { team: true });
      expect(c.plays).toEqual([r(5)]);
      expect(c.discards).toEqual([]);
      expect(c.extraArmies).toBe(5);
    });
  });

  it('outside a team game says the Reinforcement play is a default, not a must (#163)', () => {
    const c = chooseCardPlays([r(5)], { maxCardsHold: 4, inPlay: [] });
    expect(c.plays).toEqual([r(5)]);
    expect(c.warnings.join('\n')).toMatch(/by default/);
    // A play that must happen (over the limit) is not called a default.
    const d = chooseCardPlays([r(5), bl], { maxCardsHold: 1, inPlay: [] });
    expect(d.warnings.join('\n')).not.toMatch(/by default/);
  });

  it('no play needed below the limit with no Reinforcement', () => {
    const c = chooseCardPlays([op], { maxCardsHold: 4, inPlay: [] });
    expect(c).toEqual({ required: false, plays: [], discards: [], extraArmies: 0, warnings: [] });
  });
});

describe('the must-play threshold', () => {
  // Live (#20): no card was accepted at 4/4 whole cards and refused at 5/4. The bundle's
  // GameValidateOrders removes every played or discarded instance from the hand, then
  // refuses (error 51) while what is left is still > MaxCardsHold.
  const hand = (n: number): Card[] =>
    Array.from({ length: n }, (_, i) => ({ id: String(i).padStart(32, '0'), type: 12, name: 'Blockade' }));
  const rules = { maxCardsHold: 4, inPlay: [] };

  it('is not reached AT the limit (4/4)', () => {
    expect(playRequired(hand(4), rules)).toBe(false);
    expect(cardsToShed(hand(4), rules)).toBe(0);
  });

  it('is reached OVER the limit (5/4), one card per card over', () => {
    expect(playRequired(hand(5), rules)).toBe(true);
    expect(cardsToShed(hand(5), rules)).toBe(1);
    expect(cardsToShed(hand(7), rules)).toBe(3);
  });

  it('never applies without a known limit', () => {
    expect(cardsToShed(hand(9), { inPlay: [] })).toBe(0);
    expect(playRequired(hand(9), { inPlay: [] })).toBe(false);
  });
});

describe('holdsOrderPriority', () => {
  const op: Card = { id: G2, type: 4, name: 'Order Priority' };
  const od: Card = { id: G3, type: 5, name: 'Order Delay' };

  it('is true with an Order Priority card that is not discarded (played or kept)', () => {
    expect(holdsOrderPriority([op], { required: false, plays: [], discards: [], extraArmies: 0, warnings: [] })).toBe(true);
    expect(holdsOrderPriority([op], { required: true, plays: [op], discards: [], extraArmies: 0, warnings: [] })).toBe(true);
  });

  it('is false without one, or when the only one is discarded', () => {
    expect(holdsOrderPriority([od], { required: false, plays: [], discards: [], extraArmies: 0, warnings: [] })).toBe(false);
    expect(holdsOrderPriority([op], { required: true, plays: [], discards: [op], extraArmies: 0, warnings: [] })).toBe(false);
  });
});

describe('advisedOrderPriority', () => {
  const op: Card = { id: G2, type: 4, name: 'Order Priority' };
  const od: Card = { id: G3, type: 5, name: 'Order Delay' };
  const choice = (plays: Card[], discards: Card[]) => ({ required: false, plays, discards, extraArmies: 0, warnings: [] });

  it('is the Order Priority card the choice neither plays nor discards', () => {
    expect(advisedOrderPriority([od, op], choice([], []))).toBe(op);
  });

  it('is undefined when the choice already plays one, discards it, or there is none', () => {
    expect(advisedOrderPriority([op], choice([op], []))).toBeUndefined();
    expect(advisedOrderPriority([op], choice([], [op]))).toBeUndefined();
    expect(advisedOrderPriority([od], choice([], []))).toBeUndefined();
  });
});

describe('adviseOrderDelay (#163)', () => {
  const od: Card = { id: G3, type: 5, name: 'Order Delay' };
  const op: Card = { id: G2, type: 4, name: 'Order Priority' };
  const none = { required: false, plays: [], discards: [], extraArmies: 0, warnings: [] };
  const mv = (from: number, to: number, kind: 'attack' | 'transfer' = 'attack') => ({ from, to, kind });
  const moves = [mv(4, 1, 'transfer'), mv(1, 3), mv(1, 2)];

  it('advises the card above the first order that is not urgent when an answerable attack is planned', () => {
    const a = adviseOrderDelay([op, od], none, moves, ['early', 'filler', 'last']);
    expect(a).toEqual({ card: od, before: 2, attacks: [3] });
  });

  it('goes above every move when none is urgent', () => {
    expect(adviseOrderDelay([od], none, moves, ['filler', 'sure', 'last'])?.before).toBe(1);
  });

  it('is not advised without a late attack, without the card, or when the card is discarded', () => {
    expect(adviseOrderDelay([od], none, moves, ['early', 'filler', 'sure'])).toBeUndefined();
    expect(adviseOrderDelay([op], none, moves, ['early', 'filler', 'last'])).toBeUndefined();
    expect(adviseOrderDelay([od], { ...none, discards: [od] }, moves, ['early', 'filler', 'last'])).toBeUndefined();
    expect(adviseOrderDelay([od], none, moves, undefined)).toBeUndefined();
    // A transfer put last is not an attack the opponent can answer.
    expect(adviseOrderDelay([od], none, [mv(1, 2, 'transfer')], ['last'])).toBeUndefined();
  });
});

describe('readActiveCards (#163, unverified live)', () => {
  // The client's ActiveCard is { Card: the GameOrderPlayCard<X> that was played, ExpiresAfterTurn }.
  // A Diplomacy order reads its two players, then the card GUID, then the player who played it;
  // a Sanctions order its target, then the GUID and the player.
  const GZ = 'abababababababababababababababab';
  const diplomacy = { $type: 'warlight.shared.GameOrderPlayCardDiplomacy', x1: ME, x2: OTHER, x3: GZ, x4: OTHER, x5: null };
  const sanctions = { $type: 'warlight.shared.GameOrderPlayCardSanctions', y1: ME, y2: GZ, y3: OTHER, y4: null };
  const active = (card: unknown, expires: number) => ({ $type: 'warlight.shared.ActiveCard', k1: card, k2: expires });
  const info = (current: unknown[], previous: unknown[] = []) => ({
    $type: 'warlight.shared.LatestGameInfo',
    b: { $type: 'warlight.shared.GameStanding', t: [], c: [], a: current },
    d: { $type: 'warlight.shared.GameStanding', t: [], c: [], a: previous },
  });

  it('reads Diplomacy (the two players) and Sanctions (the target) from the current standing', () => {
    expect(readActiveCards(info([active(diplomacy, 9), active(sanctions, 8)]))).toEqual([
      { card: 'Diplomacy', players: [ME, OTHER], playedBy: OTHER, expiresAfterTurn: 9, untilTurn: 10 },
      { card: 'Sanctions', target: ME, playedBy: OTHER, expiresAfterTurn: 8, untilTurn: 9 },
    ]);
  });

  it("reads 'until turn' as the client does: ExpiresAfterTurn + 1, except for a card that expires at the beginning of the next turn", () => {
    // The bundle's ActiveCard: BeginningOfNextTurn (Spy, Reconnaissance, Surveillance) → ExpiresAfterTurn;
    // EndOfTurn (every other card) → ExpiresAfterTurn + 1.
    const spy = { $type: 'warlight.shared.GameOrderPlayCardSpy', s1: OTHER, s2: GZ, s3: ME };
    const recon = { $type: 'warlight.shared.GameOrderPlayCardReconnaissance', r1: 7, r2: GZ, r3: ME };
    expect(readActiveCards(info([active(spy, 5), active(recon, 6)])).map((a) => [a.card, a.untilTurn])).toEqual([
      ['Spy', 5],
      ['Reconnaissance', 6],
    ]);
  });

  it('names other cards by their order type, and never reads the previous standing', () => {
    const abandon = { $type: 'warlight.shared.GameOrderPlayCardAbandon', z1: 4, z2: GZ, z3: OTHER };
    expect(readActiveCards(info([active(abandon, 3)], [active(diplomacy, 2)]))).toEqual([
      { card: 'Emergency Blockade', playedBy: OTHER, expiresAfterTurn: 3, untilTurn: 4 },
    ]);
  });

  it('is empty, never throwing, on odd or missing shapes', () => {
    expect(readActiveCards(null)).toEqual([]);
    expect(readActiveCards(info([active(null, 1), { $type: 'warlight.shared.ActiveCard' }]))).toEqual([]);
  });
});
