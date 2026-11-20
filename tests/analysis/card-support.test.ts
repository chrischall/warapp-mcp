import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { airliftAdvice, diplomacyAdvice, giftAdvice, intelAdvice, pressures, sanctionsAdvice, type IntelCard } from '../../src/analysis/card-support.js';
import type { CardBoard } from '../../src/analysis/card-threats.js';
import type { SharedBonus } from '../../src/analysis/plan/team.js';
import { board, fogged, mine, neutral, tinyMap } from './helpers.js';

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

  it('says nothing with one opponent in contact in a 1v1: peace with it is peace with everyone', () => {
    expect(diplomacyAdvice(cb([neutral(3, 2), mine(4, 20), b(5, 20)]))).toBeUndefined();
    expect(diplomacyAdvice(cb([neutral(3, 2), mine(4, 20), b(5, 20)]), { opponents: 1 })).toBeUndefined();
  });

  it('#424: names the only opponent in contact when others are still in the game', () => {
    const d = diplomacyAdvice(cb([neutral(3, 2), mine(4, 20), b(5, 20)]), { opponents: 3 })!;
    expect(d.player).toBe(B);
    expect(d.why).toMatch(/^Diplomacy with player 30: the only opponent beside you — your borders 4 keep 15 armies against it alone/);
  });

  it('#424: chains a card in force that ends after this turn rather than passing its player over', () => {
    const d = diplomacyAdvice(cb(twoFronts()), { atPeace: new Set([B]), lastTurn: new Set([B]) })!;
    expect(d.player).toBe(B);
    expect(d.chain).toBe(true);
    expect(d.skipped).toEqual([]);
    expect(d.why).toMatch(/Chain it: the Diplomacy card in force with player 30 ends after this turn, and a new one starts the turn after it is played, so the peace runs on unbroken\./);
    // A card that runs on past this turn is still passed over.
    expect(diplomacyAdvice(cb(twoFronts()), { atPeace: new Set([B]), lastTurn: new Set() })!.player).toBe(A);
  });

  it('#424: report-only — the advice leaves the plan\'s orders unchanged', () => {
    const orders = () => ({ deploys: [{ territoryId: 4, armies: 3 }], moves: [{ from: 4, to: 6, armies: 2, kind: 'attack' as const }] });
    const board1 = cb([neutral(3, 2), mine(4, 20), b(5, 20), neutral(6, 2)], orders());
    const board2 = cb(twoFronts(), orders());
    diplomacyAdvice(board1, { opponents: 3 });
    diplomacyAdvice(board2, { atPeace: new Set([B]), lastTurn: new Set([B]) });
    expect({ deploys: board1.deploys, moves: board1.moves }).toEqual(orders());
    expect({ deploys: board2.deploys, moves: board2.moves }).toEqual(orders());
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

  it('G2: passes over a truce partner and a player at peace with me by a Diplomacy card, saying why', () => {
    const players = [{ playerId: ME, strength: 30 }, { playerId: A, strength: 50 }, { playerId: B, strength: 40 }, { playerId: MATE, strength: 35 }];
    const pass = new Map([
      [A, 'your truce with player 20 is in force'],
      [B, 'a Diplomacy card between you is in force'],
    ]);
    const s = sanctionsAdvice({ me: ME, players, pass })!;
    expect(s.player).toBe(MATE);
    expect(s.skipped).toEqual(['player 20: your truce with player 20 is in force', 'player 30: a Diplomacy card between you is in force']);
    expect(s.why).toMatch(/Passed over: player 20: your truce .*; player 30: a Diplomacy card/);
    // Everyone passed over: hold the card, and say why.
    const none = sanctionsAdvice({ me: ME, players: players.slice(0, 3), pass })!;
    expect(none.player).toBeUndefined();
    expect(none.why).toMatch(/^Hold the Sanctions card: .*Passed over: player 20/);
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

describe('intelAdvice (G2): the spy cards only where they reveal what the plan needs', () => {
  const all = new Set<IntelCard>(['Spy', 'Reconnaissance', 'Surveillance']);
  // I hold 1 and 2 of bonus A (1, 2, 3); the fog hides 3, which borders both.
  const building = () => [mine(1, 5), mine(2, 7), fogged(3), neutral(4, 2), neutral(5, 2), neutral(6, 2), b(7, 3)];

  it('Surveillance on the bonus I am completing, Reconnaissance on the hidden border, Spy on an unseen opponent', () => {
    const { advice, hold } = intelAdvice(cb(building()), { fog: 'Foggy', opponents: [A, B], held: all });
    expect(advice).toEqual([
      { card: 'Spy', player: A, why: expect.stringMatching(/^Spy on player 20: none of its territories is in view/) },
      { card: 'Surveillance', bonus: 101, why: expect.stringMatching(/^Surveillance on bonus 101: you hold 2 of its 3 territories and the fog hides 3/) },
      { card: 'Reconnaissance', target: 3, why: expect.stringMatching(/^Reconnaissance on 3: it borders 2 of your territories \(12 armies\)/) },
    ]);
    expect(hold).toEqual([]);
  });

  it('never with fog off', () => {
    expect(intelAdvice(cb(building()), { fog: 'NoFog', opponents: [A, B], held: all })).toEqual({ advice: [], hold: [] });
  });

  it('Spy on the owner shown beside me whose stack the fog hides, when every opponent is in view', () => {
    const ownerOnly = { territoryId: 4, owner: { kind: 'player' as const, playerId: B }, armies: null, fogLevel: 'OwnerOnly' };
    const { advice } = intelAdvice(cb([neutral(1, 2), neutral(2, 2), mine(3, 9), ownerOnly, a(5, 3), neutral(6, 2), b(7, 3)]), {
      fog: 'Foggy',
      opponents: [A, B],
      held: new Set<IntelCard>(['Spy', 'Surveillance']),
    });
    expect(advice).toEqual([
      { card: 'Spy', player: B, why: expect.stringMatching(/^Spy on player 30: the fog hides the armies on its territory beside yours/) },
      { card: 'Surveillance', bonus: 104, why: expect.stringMatching(/^Surveillance on bonus 104 \(\+4\)/) },
    ]);
  });

  it('#443: Reconnaissance behind the opponent whose stacks tie down the most of my border armies, not a far bonus member', () => {
    // Normal fog: my border's neighbours are in view. B on 5 ties down 15 of T4's armies, A on 3 only 9.
    const view = [fogged(1), fogged(2), a(3, 10), mine(4, 20), b(5, 20), fogged(6), neutral(7, 2)];
    const { advice } = intelAdvice(cb(view), { fog: 'Foggy', opponents: [A, B], held: new Set<IntelCard>(['Reconnaissance']) });
    expect(advice).toEqual([
      { card: 'Reconnaissance', target: 6, why: expect.stringMatching(/^Reconnaissance on 6: the fog hides it behind player 30, whose stacks tie down 15 of your border armies/) },
    ]);
  });

  it('#443: prefers a likely start behind that opponent', () => {
    const view = [fogged(1), fogged(2), a(3, 10), mine(4, 20), neutral(5, 2), neutral(6, 2), neutral(7, 2)];
    const held = new Set<IntelCard>(['Reconnaissance']);
    expect(intelAdvice(cb(view), { fog: 'Foggy', opponents: [A], held }).advice[0]?.target).toBe(1);
    const { advice } = intelAdvice(cb(view), { fog: 'Foggy', opponents: [A], held, likelyStarts: new Set([2]) });
    expect(advice).toEqual([{ card: 'Reconnaissance', target: 2, why: expect.stringMatching(/behind player 20, .*\(a likely start\)\.$/) }]);
  });

  it('#443: report-only — the Reconnaissance advice leaves the plan\'s orders unchanged', () => {
    const orders = () => ({ deploys: [{ territoryId: 4, armies: 3 }], moves: [{ from: 4, to: 7, armies: 2, kind: 'attack' as const }] });
    const view = [fogged(1), fogged(2), a(3, 10), mine(4, 20), b(5, 20), fogged(6), neutral(7, 2)];
    const board1 = cb(view, orders());
    const { advice } = intelAdvice(board1, { fog: 'Foggy', opponents: [A, B], held: new Set<IntelCard>(['Reconnaissance']), likelyStarts: new Set([6]) });
    expect(advice).toHaveLength(1);
    expect({ deploys: board1.deploys, moves: board1.moves }).toEqual(orders());
  });

  it('holds each card, saying why, when the fog hides nothing the plan needs', () => {
    const { advice, hold } = intelAdvice(cb([mine(1, 5), mine(2, 5), mine(3, 5), neutral(4, 2), neutral(5, 2), a(6, 2), fogged(7)]), {
      fog: 'Foggy',
      opponents: [A],
      held: all,
    });
    expect(advice).toEqual([]);
    expect(hold).toHaveLength(3);
    expect(hold[0]).toMatch(/^Hold the Spy card: the fog hides nothing the plan needs/);
  });
});
