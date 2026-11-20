// PLAN-TEAMS C3.7: the team hand against my teammates' entered card plays (synthetic GUIDs and ids).
import { describe, expect, it } from 'vitest';
import type { Card } from '../src/cards.js';
import { claimedCardUses, claimedCardWarning, teamCardClaims, teamCardLimit, teamCardRoles, teamHandLeft, unclaimedFirst } from '../src/team-cards.js';
import type { TeamCardPlay, TeammateOrders } from '../src/team-orders.js';

const G = (n: number) => n.toString(16).padStart(32, '0');
const R1: Card = { id: G(1), type: 1, name: 'Reinforcement', armies: 5 };
const R2: Card = { id: G(2), type: 1, name: 'Reinforcement', armies: 5 };
const OP: Card = { id: G(3), type: 4, name: 'Order Priority' };
const OD: Card = { id: G(4), type: 5, name: 'Order Delay' };
const entry = (playerId: number, cards: TeamCardPlay[], discards: { cardId?: string }[] = []): TeammateOrders => ({
  playerId,
  orders: { deploys: [], moves: [], cards, discards, unread: [] },
  picks: null,
});

describe('teamCardClaims', () => {
  it("reads only my teammates' plays and discards", () => {
    const claims = teamCardClaims(
      [entry(11, [{ cardId: R1.id, type: 1, name: 'Reinforcement' }], [{ cardId: OD.id }]), entry(30, [{ type: 4, name: 'Order Priority' }]), { playerId: 12, orders: null, picks: null }],
      new Set([11, 12]),
    );
    expect(claims).toEqual([
      { player: 11, kind: 'play', cardId: R1.id, type: 1, name: 'Reinforcement' },
      { player: 11, kind: 'discard', cardId: OD.id, type: null },
    ]);
    expect(teamCardClaims(undefined, new Set([11]))).toEqual([]);
  });
});

describe('teamHandLeft', () => {
  it('takes a named card, else the first card of a named type', () => {
    const { left, claimed } = teamHandLeft([R1, R2, OP, OD], [
      { player: 11, kind: 'play', cardId: R2.id, type: 1 },
      { player: 11, kind: 'play', type: 1 },
      { player: 12, kind: 'discard', type: null },
      { player: 12, kind: 'play', cardId: G(99), type: 4 },
    ]);
    expect(left).toEqual([OP, OD]);
    expect(claimed).toEqual([
      { card: R1, player: 11, kind: 'play' },
      { card: R2, player: 11, kind: 'play' },
    ]);
  });
});

describe('teamCardRoles', () => {
  it('says who plays each card', () => {
    const roles = teamCardRoles([R1, R2, OP, OD], [{ card: R1, player: 11, kind: 'play' }], { plays: [OP], discards: [OD] });
    expect(roles.map((r) => [r.card, r.by, r.action])).toEqual([
      [R1.id, 11, 'play'],
      [R2.id, null, 'hold'],
      [OP.id, 'me', 'play'],
      [OD.id, 'me', 'discard'],
    ]);
    expect(roles[0]!.why).toMatch(/player 11 has already entered a play of it/);
  });
});

describe('claimedCardUses (G3): my orders against what my teammates entered', () => {
  const claimed = [
    { card: R1, player: 11, kind: 'play' as const },
    { card: OD, player: 12, kind: 'discard' as const },
  ];
  it('names each card my orders play or discard that a teammate has entered', () => {
    const out = claimedCardUses(
      [
        { card: R1, kind: 'play' },
        { card: OP, kind: 'play' },
        { card: OD, kind: 'discard' },
      ],
      claimed,
    );
    expect(out).toEqual([
      { card: R1, mine: 'play', player: 11, theirs: 'play' },
      { card: OD, mine: 'discard', player: 12, theirs: 'discard' },
    ]);
    expect(claimedCardUses([{ card: OP, kind: 'play' }], claimed)).toEqual([]);
  });
  it('words one warning, ids only', () => {
    const w = claimedCardWarning(claimedCardUses([{ card: R1, kind: 'play' }], claimed));
    expect(w).toMatch(new RegExp(`plays the Reinforcement card ${R1.id}, which player 11 has already entered a play of`));
    expect(w).toMatch(/one card twice/);
    expect(w).toMatch(/UNVERIFIED live/);
    expect(claimedCardWarning([])).toBeUndefined();
  });
  it('puts the unclaimed cards first, so a card named by its type is one nobody entered', () => {
    expect(unclaimedFirst([R1, R2, OP, OD], claimed)).toEqual([R2, OP, R1, OD]);
    expect(unclaimedFirst([R1, R2], [])).toEqual([R1, R2]);
  });
});

// V8 (#310), from the client bundle's GameValidateOrders and seen on a live team board: each player's cards sit under
// that player's id and the team's hand is all of them; the committed teammates' plays and discards leave it first;
// war.app refuses (error 51) a hand still over MaxCardsHold only from the last of the team to commit.
describe('teamCardLimit', () => {
  const SP: Card = { id: G(5), type: 2, name: 'Spy' };
  const rules = { maxCardsHold: 3, inPlay: [] };
  const mate = (id: number, committed: boolean, state = 'Playing') => ({ id, hasCommittedOrders: committed, state });

  it('counts the whole team hand, and binds only when every teammate still playing has committed', () => {
    const hand = [R1, R2, OP, OD, SP];
    expect(teamCardLimit(hand, rules, [mate(11, false)], [entry(11, [])])).toMatchObject({ shed: 2, lastToCommit: false, ordersRead: true, binding: false });
    expect(teamCardLimit(hand, rules, [mate(11, true)], [entry(11, [])])).toMatchObject({ shed: 2, lastToCommit: true, ordersRead: true, binding: true });
    // A teammate out of the game does not wait to commit.
    expect(teamCardLimit(hand, rules, [mate(11, false, 'Eliminated')], [])).toMatchObject({ lastToCommit: true, binding: true });
  });

  it("takes a committed teammate's plays and discards out first, never an uncommitted one's", () => {
    const hand = [R1, R2, OP, OD, SP];
    const read = [entry(11, [{ cardId: R1.id, type: 1, name: 'Reinforcement' }], [{ cardId: OD.id }]), entry(12, [{ cardId: SP.id, type: 2, name: 'Spy' }])];
    const r = teamCardLimit(hand, rules, [mate(11, true), mate(12, false)], read);
    expect(r.left.map((c) => c.id)).toEqual([R2.id, OP.id, SP.id]);
    expect(r).toMatchObject({ shed: 0, binding: false });
    // Once both have committed, the second one's play leaves the hand too.
    expect(teamCardLimit(hand, rules, [mate(11, true), mate(12, true)], read)).toMatchObject({ shed: 0, binding: true });
    expect(teamCardLimit(hand, rules, [mate(11, true), mate(12, true)], read).left).toHaveLength(2);
  });

  it("never binds on a committed teammate's orders it could not read", () => {
    const hand = [R1, R2, OP, OD, SP];
    expect(teamCardLimit(hand, rules, [mate(11, true)], undefined)).toMatchObject({ shed: 2, lastToCommit: true, ordersRead: false, binding: false });
    expect(teamCardLimit(hand, rules, [mate(11, true)], [{ playerId: 11, orders: null, picks: null }]).binding).toBe(false);
  });
});
