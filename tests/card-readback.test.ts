// The committed card plays read back (Airlifts and territory-targeted plays): a card swapped for another of its type
// still matches by its fields, and an altered target is named. Pure.
import { describe, expect, it } from 'vitest';
import { checkAirlifts, checkTargeted, targetedMismatchParts } from '../src/tools/airlift-readback.js';
import type { MyOrders } from '../src/my-orders.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const read = (orders: MyOrders['orders']): MyOrders => ({ orders, unread: [] });

describe('checkAirlifts', () => {
  it('matches a card war.app swapped for another of its type by the same fields', () => {
    const r = checkAirlifts([{ card: A, from: 1, to: 2, armies: 5, commander: false }], read([{ kind: 'card', card: B, cardType: 'Airlift', from: 1, to: 2, armies: 5 }]));
    expect(r.status).toBe('verified');
  });
});

describe('checkTargeted', () => {
  it('matches a swapped card by its target, and names an altered target', () => {
    const swapped = checkTargeted([{ card: A, kind: 'Bomb', target: 7 }], read([{ kind: 'card', card: B, cardType: 'Bomb', target: 7 }]));
    expect(swapped.status).toBe('verified');
    const altered = checkTargeted([{ card: A, kind: 'Bomb', target: 7 }], read([{ kind: 'card', card: A, cardType: 'Bomb', target: 9 }]));
    expect(altered.status).toBe('mismatch');
    expect(targetedMismatchParts(altered)).toEqual(['the Bomb play on 7 reads back on 9']);
    expect(checkTargeted([{ card: A, kind: 'Bomb', target: 7 }], null).status).toBe('unread');
  });
});
