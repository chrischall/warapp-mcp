import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { airliftAdvice, diplomacyAdvice, giftAdvice, pressures, sanctionsAdvice } from '../../src/analysis/card-support.js';
import type { CardBoard } from '../../src/analysis/card-threats.js';
import type { SharedBonus } from '../../src/analysis/plan/team.js';
import { board, mine, neutral, tinyMap } from './helpers.js';

// tinyMap: 1 ─ 2 ─ 3 triangle (bonus A +3), 3 ─ 4 ─ 5 ─ 6 ─ 7 (bonus B +2: 4, 5).
const ME = 10;
const A = 20;
const B = 30;
const MATE = 40;
const g = buildGraph(tinyMap());
const of = (playerId: number) => (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId }, armies });
const a = of(A);
const b = of(B);
const mate = of(MATE);
const cb = (territories: TerritoryState[], over: Partial<CardBoard> = {}): CardBoard => ({
  graph: g,
  board: board(territories),
  me: ME,
  deploys: [],
  moves: [],
  enemyDeploy: 5,
  ...over,
});

// T4 (mine, 20) between A's 10 on T3 (reach 14: 9 hold it) and B's 20 on T5 (reach 24: 15 hold it).
const twoFronts = () => [neutral(1, 2), neutral(2, 2), a(3, 10), mine(4, 20), b(5, 20), neutral(6, 2)];

describe('pressures (D2)', () => {
  it('ranks the opponents in contact by the armies my borders keep against each alone', () => {
    expect(pressures(cb(twoFronts()))).toEqual([
      { player: B, armies: 15, takes: [], borders: [4] },
      { player: A, armies: 9, takes: [], borders: [4] },
    ]);
  });

  it('lists the borders an opponent can take as the plan leaves them', () => {
    const p = pressures(cb([a(3, 10), mine(4, 5), b(5, 2)]));
    expect(p[0]).toEqual({ player: A, armies: 9, takes: [4], borders: [4] });
  });
});

describe('diplomacyAdvice (D2)', () => {
  it('names the opponent pressing hardest when two or more are in contact', () => {
    const d = diplomacyAdvice(cb(twoFronts()))!;
    expect(d.player).toBe(B);
    expect(d.why).toMatch(/^Diplomacy with player 30: of the 2 opponents beside you it presses hardest — your borders 4 keep 15 armies/);
    expect(d.skipped).toEqual([]);
  });

  it('says nothing with one opponent in contact: peace with it is peace with everyone', () => {
    expect(diplomacyAdvice(cb([neutral(3, 2), mine(4, 20), b(5, 20)]))).toBeUndefined();
  });

  it('never names a truce partner already covered, and says so', () => {
    const d = diplomacyAdvice(cb(twoFronts()), { truces: [{ player: B, state: 'active', coveredMine: [4] }] })!;
    expect(d.player).toBe(A);
    expect(d.skipped).toEqual(['player 30: your truce already covers every border it presses, so the card adds nothing the truce does not']);
  });

  it('names a truce partner when the card adds protection: a border the truce leaves out, or a truce in notice', () => {
    const open = diplomacyAdvice(cb(twoFronts()), { truces: [{ player: B, state: 'active', coveredMine: [] }] })!;
    expect(open.player).toBe(B);
    expect(open.overTruce).toBe('your truce with player 30 does not cover 4, which it presses');
    expect(open.why).toMatch(/Played on a truce partner because your truce with player 30 does not cover 4/);
    const notice = diplomacyAdvice(cb(twoFronts()), { truces: [{ player: B, state: 'notice', coveredMine: [4], endsTurn: 9 }] })!;
    expect(notice.player).toBe(B);
    expect(notice.overTruce).toMatch(/in notice \(it ends turn 9\)/);
  });

  it('passes over an opponent a Diplomacy card already keeps from me', () => {
    const d = diplomacyAdvice(cb(twoFronts()), { atPeace: new Set([B]) })!;
    expect(d.player).toBe(A);
    expect(d.skipped).toEqual(['player 30: a Diplomacy card between you is already in force']);
  });

  it('holds the card when every opponent left is excluded', () => {
    const d = diplomacyAdvice(cb(twoFronts()), { atPeace: new Set([A, B]) })!;
    expect(d.player).toBeUndefined();
    expect(d.why).toMatch(/^Hold the Diplomacy card/);
  });

  it('never counts a teammate as an opponent', () => {
    expect(diplomacyAdvice(cb(twoFronts(), { friends: new Set([A]) }))).toBeUndefined();
  });
});

describe('sanctionsAdvice (D2)', () => {
  it('sanctions the leader', () => {
    const s = sanctionsAdvice({ me: ME, players: [{ playerId: ME, strength: 30 }, { playerId: A, strength: 50 }, { playerId: B, strength: 40 }], percentage: 0.3 })!;
    expect(s.player).toBe(A);
    expect(s.why).toMatch(/^Sanctions on player 20: it leads .*cuts its income by 30%/);
  });

  it('when I lead, sanctions the strongest opponent', () => {
    const s = sanctionsAdvice({ me: ME, players: [{ playerId: ME, strength: 60 }, { playerId: B, strength: 50 }, { playerId: A, strength: 50 }] })!;
    expect(s.player).toBe(A);
    expect(s.why).toMatch(/you lead, and it is the strongest opponent/);
  });

  it('a negative percentage raises income, so it goes on me; nothing with no opponent', () => {
    expect(sanctionsAdvice({ me: ME, players: [{ playerId: A, strength: 9 }], percentage: -0.5 })?.player).toBe(ME);
    expect(sanctionsAdvice({ me: ME, players: [{ playerId: ME, strength: 9 }] })).toBeUndefined();
  });
});

describe('airliftAdvice (D2)', () => {
  // T4's 2 fall to B's 10 + 5 (reach 14); 9 hold. T1's 20 face no one.
  const exposed = () => [mine(1, 20), mine(2, 1), mine(3, 1), mine(4, 2), b(5, 10), neutral(6, 2)];

  it('flies the armies a falling border of mine needs from a stack with armies to spare', () => {
    expect(airliftAdvice(cb(exposed()))).toMatchObject({ from: 1, to: 4, armies: 7, player: B, reach: 14, commander: false });
  });

  it("supports a teammate's falling border, counting the deploys it has entered", () => {
    const ts = [mine(1, 20), mine(2, 1), mine(3, 1), mate(4, 2), b(5, 10), neutral(6, 2)];
    const plain = airliftAdvice(cb(ts, { friends: new Set([MATE]) }))!;
    expect(plain).toMatchObject({ from: 1, to: 4, armies: 7, teammate: MATE });
    expect(plain.why).toMatch(/your teammate 40's 4.*become your teammate's/);
    const withOrders = cb(ts, { friends: new Set([MATE]) });
    withOrders.board = { ...withOrders.board, teammateOrders: [{ playerId: MATE, orders: { deploys: [{ territoryId: 4, armies: 3 }], moves: [], cards: [], discards: [], unread: [] }, picks: null }] };
    expect(airliftAdvice(withOrders)?.armies).toBe(4);
  });

  it('keeps what a source needs to hold, and what the plan moves out of it', () => {
    // T1 sends 15 away: 4 spare, short of the 7 needed.
    expect(airliftAdvice(cb(exposed(), { moves: [{ from: 1, to: 2, armies: 15, kind: 'transfer' }] }))).toBeUndefined();
  });

  it('never flies armies into a border the plan withdraws from', () => {
    expect(airliftAdvice(cb(exposed(), { moves: [{ from: 4, to: 3, armies: 1, kind: 'transfer' }] }))).toBeUndefined();
  });

  it('is undefined when every border holds', () => {
    expect(airliftAdvice(cb([mine(1, 20), mine(3, 1), mine(4, 12), b(5, 10)]))).toBeUndefined();
  });

  it("saves my commander's territory first", () => {
    const ts = [mine(1, 30), mine(2, 1), b(3, 10), { ...mine(4, 1), specialUnits: [{ kind: 'commander' as const, id: 'd'.repeat(32), playerId: ME }] }, b(5, 10), mine(6, 9)];
    const out = airliftAdvice(cb(ts))!;
    expect(out).toMatchObject({ to: 4, commander: true });
  });
});

describe('giftAdvice (D2)', () => {
  const shared: SharedBonus[] = [{ bonusId: 101, value: 3, mine: [3], teammates: [{ player: MATE, territories: [1, 2] }], others: [], nearer: MATE }];
  const ts = () => [mate(1, 2), mate(2, 2), mine(3, 4), mine(4, 4), b(5, 3)];

  it("gifts the member that completes a teammate's bonus", () => {
    const out = giftAdvice(cb(ts(), { friends: new Set([MATE]) }), shared, 1)!;
    expect(out).toMatchObject({ player: MATE, bonus: 101, value: 3, territories: [3] });
    expect(out.why).toMatch(/^Gift 3 to your teammate 40: .*\+3 a turn for the team/);
  });

  it('not without a Gift card, not when I am nearer, not with a unit on it or moves out of it', () => {
    const c = cb(ts(), { friends: new Set([MATE]) });
    expect(giftAdvice(c, shared, 0)).toBeUndefined();
    expect(giftAdvice(c, [{ ...shared[0]!, nearer: ME }], 1)).toBeUndefined();
    expect(giftAdvice(c, [{ ...shared[0]!, others: [7] }], 1)).toBeUndefined();
    expect(giftAdvice({ ...c, moves: [{ from: 3, to: 4, armies: 3, kind: 'transfer' }] }, shared, 1)).toBeUndefined();
    const unit = ts().map((t) => (t.territoryId === 3 ? { ...t, specialUnits: [{ kind: 'commander' as const, id: 'd'.repeat(32), playerId: ME }] } : t));
    expect(giftAdvice(cb(unit, { friends: new Set([MATE]) }), shared, 1)).toBeUndefined();
  });
});
