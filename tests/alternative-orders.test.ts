// The orders of an alternative plan beside the plain one (airliftPlan; auto-review #558): the plain card plays and
// discards, the advised Order Delay left out (its place names a plain-plan move) and discarded only when the plain card
// choice had to shed it anyway, then the alternative's own card plays, deploys and moves.
import { describe, expect, it } from 'vitest';
import { alternativeOrders, cardsLeftAfter, playsCardType } from '../src/tools/alternative-orders.js';

const DELAY = 'd'.repeat(32);
const OP = 'a'.repeat(32);
const delayOrder = { kind: 'card', card: DELAY, before: 2 };
const plain = [
  { kind: 'discard', card: 'c'.repeat(32) },
  { kind: 'card', card: OP },
  { kind: 'deploy', territory: 1, armies: 5 },
  { kind: 'move', from: 1, to: 2, armies: 4 },
  delayOrder,
];
const extra = {
  cardPlays: [{ kind: 'card' as const, card: 'f'.repeat(32), from: 3, to: 1, armies: 6 }],
  deploys: [{ kind: 'deploy' as const, territory: 3, armies: 5 }],
  moves: [],
};

describe('alternativeOrders (#558)', () => {
  it('keeps an advised Order Delay the player could keep: neither played nor discarded', () => {
    const o = alternativeOrders({ orders: plain, delayOrder, playedDelay: DELAY, delayMustGo: false, ...extra });
    expect(o).toEqual([plain[0], plain[1], ...extra.cardPlays, ...extra.deploys]);
  });

  it('discards it only when the plain card choice had to shed it', () => {
    const o = alternativeOrders({ orders: plain, delayOrder, playedDelay: DELAY, delayMustGo: true, ...extra });
    expect(o).toEqual([plain[0], plain[1], { kind: 'discard', card: DELAY }, ...extra.cardPlays, ...extra.deploys]);
  });
});

describe('playsCardType (#558)', () => {
  it('reads an advised Order Priority from the orders, as the plain check counts it', () => {
    const hand = [{ id: OP, type: 4 }, { id: DELAY, type: 5 }];
    expect(playsCardType(plain, hand, 4)).toBe(true);
    expect(playsCardType(plain.filter((o) => o.kind !== 'card'), hand, 4)).toBe(false);
  });
});

describe('cardsLeftAfter (#558)', () => {
  it('counts only the cards the plain plan leaves, less those this plan spends', () => {
    // 3 held, the plain plan discards 1, this plan spends 1: 1 left (not 2).
    expect(cardsLeftAfter({ held: 3, free: 2, spent: 1 })).toBe(1);
  });
});

describe('recordedWithCommit (#556)', () => {
  it('names what was recorded with the commit, so an Airlift mismatch error loses none of it', async () => {
    const { recordedWithCommit } = await import('../src/tools/airlift-readback.js');
    expect(recordedWithCommit({ status: 'committed' })).toBeUndefined();
    const line = recordedWithCommit({
      agreementsBroken: [{ agreement: 'a1', recorded: 'broken-by-me' }],
      exceptionsRecorded: [{ agreement: 'a2' }],
      commanderRiskAccepted: { territory: 5, needs: 9 },
      chatReviewed: { blocks: [] },
    })!;
    expect(line).toMatch(/^Recorded with this commit: /);
    for (const k of ['agreementsBroken', 'exceptionsRecorded', 'commanderRiskAccepted', 'chatReviewed']) expect(line).toContain(k);
    expect(line).toContain('broken-by-me');
  });
});
