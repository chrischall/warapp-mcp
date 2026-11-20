import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../src/board.js';
import { buildGraph } from '../src/analysis/graph.js';
import type { Card, CardChoice } from '../src/cards.js';
import type { GameSettings, Player } from '../src/normalize.js';
import { adviseCards, cardGame, cardPieceOption, handOwners, opponentReinforcement, type CardAdviceInput } from '../src/tools/card-advice.js';
import { normalizeSettings } from '../src/normalize.js';
import { turnOrdersArg } from '../src/tools/turn.js';
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
    expect(view.emergencyBlockade).toMatchObject({ territory: 4, wall: 30, kills: 21, order: { kind: 'card', card: eb.id, target: 4 } });
    expect(warnings.join('\n')).toMatch(/Consider an Emergency Blockade on T4/);
    expect(warnings.join('\n')).toMatch(/pass `cards.advice.emergencyBlockade.order` to warapp_submit_turn/);
  });

  it('says what my Emergency Blockade shields behind it, and what it gives up (#369)', () => {
    const eb: Card = { id: 'e'.repeat(32), type: 3, name: 'Emergency Blockade' };
    const plan = { deploys: [], moves: [], moveSlots: [], enemyDeploy: 5, conceded: [4] };
    // T3 holds bonus A (+3) with T1 and T2; T5's stack reaches T3 next turn only through T4.
    const territories = [me(1, 2), me(2, 2), me(3, 2), me(4, 6), foe(5, 10), neutral(6, 2)];
    const { view, warnings } = adviseCards(input({ territories, plan, hand: [eb] }));
    expect(view.emergencyBlockade).toMatchObject({
      territory: 4,
      givesUp: 6,
      wall: 18,
      protects: { territories: [3], bonuses: [{ bonus: 101, value: 3 }], income: 3, commander: false },
      order: { kind: 'card', card: eb.id, target: 4 },
    });
    const text = warnings.join('\n');
    expect(text).toMatch(/Consider an Emergency Blockade on T4/);
    expect(text).toMatch(/shields T3 \(bonus A, \+3 a turn\) from player 7176543229's ~14/);
    expect(text).toMatch(/gives up T4 and its 6 armies/);
  });

  it('#434: advises my Blockade on the one gate into a held bonus the plan concedes, never on a member of it, orders unchanged', () => {
    const bk: Card = { id: 'k'.repeat(32), type: 12, name: 'Blockade' };
    const game = { players: [ME, FOE], settings: settings({ BlockadeCard: { ...piece, MultiplyAmount: 3 } }) };
    const plan = { deploys: [{ territoryId: 4, armies: 2 }], moves: [], moveSlots: [], enemyDeploy: 5, conceded: [4] };
    const before = structuredClone(plan);
    // A (1, 2, 3) is mine; 4 is its one gate, facing 10 on T5 (~14): 6 × 3 = 18 stops it.
    const territories = [me(1, 2), me(2, 2), me(3, 2), me(4, 4), foe(5, 10), neutral(6, 2), neutral(7, 2)];
    const { view, warnings } = adviseCards(input({ territories, plan, game, hand: [bk] }));
    expect(view.blockade).toMatchObject({
      territory: 4,
      armies: 6,
      wall: 18,
      player: FOE.id,
      reach: 14,
      bonuses: [101],
      order: { kind: 'card', card: bk.id, target: 4 },
    });
    expect(turnOrdersArg.safeParse([view.blockade!.order]).success).toBe(true);
    const text = warnings.join('\n');
    expect(text).toMatch(/Consider a Blockade on T4: the plan concedes it, and it is the only way into bonus A \(\+3 a turn\)/);
    expect(text).toMatch(/Advice only, not in the orders: pass `cards.advice.blockade.order`/);
    // Advice only: the plan's orders are unchanged.
    expect(plan).toEqual(before);
    // Never on a member of a bonus I hold (a real game walled its own bonus): 3 is A's, facing T4's stack.
    const own = adviseCards(
      input({ territories: [me(1, 2), me(2, 2), me(3, 6), foe(4, 10), neutral(5, 2), neutral(6, 2), neutral(7, 2)], game, hand: [bk], plan: { ...plan, deploys: [], conceded: [3] } }),
    );
    expect(own.view.blockade).toBeUndefined();
    // No multiplier in the settings: no wall is sized, and it says so.
    const bare = adviseCards(input({ territories, plan, hand: [bk] }));
    expect(bare.view.blockade).toBeUndefined();
    expect(bare.warnings.join('\n')).toMatch(/You hold a Blockade, but the game does not say its multiplier/);
  });

  it('advises my Bomb with the order to play it, and no order when it says to hold the card', () => {
    const bomb: Card = { id: 'b'.repeat(32), type: 13, name: 'Bomb' };
    const plan = { deploys: [], moves: [{ from: 4, to: 5, armies: 15, kind: 'attack' as const, reason: '' }], moveSlots: ['last' as const], enemyDeploy: 5, conceded: [] };
    const { view, warnings } = adviseCards(input({ territories: [neutral(3, 2), me(4, 20), foe(5, 8), neutral(6, 2)], plan, hand: [bomb] }));
    expect(view.bomb).toMatchObject({ target: 5, order: { kind: 'card', card: bomb.id, target: 5 } });
    expect(warnings.join('\n')).toMatch(/pass `cards.advice.bomb.order` to warapp_submit_turn/);
    const hold = adviseCards(input({ territories: [neutral(3, 2), me(4, 2), foe(5, 2), neutral(6, 2)], hand: [bomb] }));
    expect(hold.view.bomb).toMatchObject({ target: null });
    expect(hold.view.bomb).not.toHaveProperty('order');
    expect(turnOrdersArg.safeParse([view.bomb!.order]).success).toBe(true);
  });

  it('#452: never advises a Bomb on a player a Diplomacy card in force or a binding truce keeps at peace with me', () => {
    const bomb: Card = { id: 'b'.repeat(32), type: 13, name: 'Bomb' };
    const plan = { deploys: [], moves: [{ from: 4, to: 5, armies: 15, kind: 'attack' as const, reason: '' }], moveSlots: ['last' as const], enemyDeploy: 5, conceded: [] };
    const territories = [neutral(3, 2), me(4, 20), foe(5, 8), neutral(6, 2)];
    // Unprotected, T5 is the Bomb's target (the test above).
    expect(adviseCards(input({ territories, plan, hand: [bomb] })).view.bomb).toMatchObject({ target: 5 });
    const diplomacy = {
      $type: 'warlight.shared.LatestGameInfo',
      s: {
        $type: 'warlight.shared.GameStanding',
        a: [{ $type: 'warlight.shared.ActiveCard', c: { $type: 'warlight.shared.GameOrderPlayCardDiplomacy', f0: ME_IN, f1: FOE_IN, g: 'ab'.repeat(16), p: FOE_IN }, e: 4 }],
      },
    };
    const held = (over: Partial<CardAdviceInput>) => {
      const { view, warnings } = adviseCards(input({ territories, plan, hand: [bomb], ...over }));
      expect(view.bomb).toMatchObject({ target: null });
      expect(view.bomb).not.toHaveProperty('order');
      const w = warnings.join('\n');
      expect(w).not.toMatch(/Bomb T5/);
      expect(w).toMatch(/Hold the Bomb: .*Player 7176543229 is passed over: you are at peace with it/);
    };
    // A Diplomacy card in force, read from the board.
    held({ info: diplomacy });
    // The plan's T9 enforced set alone (the decoder sure of the card).
    held({ enforced: new Set([FOE.id]) });
    // A binding truce (in notice) whose covered territories do not even name T5: the partner is at peace with me.
    held({ truces: [{ player: FOE.id, state: 'notice', coveredMine: [4], endsTurn: 6 }] });
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

describe('adviseCards: Diplomacy, Sanctions, Airlift and Gift (PLAN-TEAMS D2)', () => {
  const FOE2: Player = { ...FOE, id: 8811111299, name: 'Cy' };
  const foe2 = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: FOE2.id }, armies });
  const card = (type: number, name: string, c = 'd'): Card => ({ id: c.repeat(32), type, name });
  const ffa = { players: [ME, FOE, FOE2], settings: settings() };
  // T4 (mine) between FOE's 10 on T3 and FOE2's 20 on T5.
  const fronts = () => [neutral(1, 2), neutral(2, 2), foe(3, 10), me(4, 20), foe2(5, 20), neutral(6, 2)];

  it('advises Diplomacy on the opponent pressing hardest, with the order to play it, never auto-played', () => {
    const { view, warnings } = adviseCards(input({ territories: fronts(), game: ffa, hand: [card(8, 'Diplomacy')] }));
    expect(view.diplomacy).toMatchObject({ player: FOE2.id, borders: [4], armies: 15, order: { kind: 'card', card: 'd'.repeat(32), players: [ME.id, FOE2.id] } });
    expect(warnings.join('\n')).toMatch(/Diplomacy with player 8811111299: .*starts the turn after it is played.*Advice only, not in the orders/);
  });

  it('passes over a truce partner the truce already covers, and says so', () => {
    const truces = [{ player: FOE2.id, state: 'active' as const, coveredMine: [4] }];
    const { view, warnings } = adviseCards(input({ territories: fronts(), game: ffa, hand: [card(8, 'Diplomacy')], truces }));
    expect(view.diplomacy?.player).toBe(FOE.id);
    expect(warnings.join('\n')).toMatch(/Passed over: player 8811111299: your truce already covers every border it presses/);
  });

  it('#424: advises Diplomacy on the only opponent in contact in a free-for-all', () => {
    const plan = { deploys: [{ territoryId: 4, armies: 3 }], moves: [{ from: 4, to: 3, armies: 10, kind: 'attack' as const, reason: '' }], moveSlots: ['sure' as const], enemyDeploy: 5, conceded: [] };
    const before = structuredClone(plan);
    const { view } = adviseCards(input({ territories: [neutral(3, 2), me(4, 20), foe(5, 20)], plan, game: ffa, hand: [card(8, 'Diplomacy')] }));
    expect(view.diplomacy).toMatchObject({ player: FOE.id, borders: [4], order: { players: [ME.id, FOE.id] } });
    // Report-only: the plan's orders are unchanged.
    expect(plan).toEqual(before);
  });

  it('#424: warns on the last turn of a Diplomacy card in force, and advises chaining it', () => {
    const order = (...ints: number[]) => ({
      $type: 'warlight.shared.GameOrderPlayCardDiplomacy',
      ...Object.fromEntries(ints.map((n, i) => [`f${i}`, n])),
      g: 'ab'.repeat(16),
      p: FOE_IN,
    });
    const info = (e: number) => ({
      $type: 'warlight.shared.LatestGameInfo',
      s: { $type: 'warlight.shared.GameStanding', a: [{ $type: 'warlight.shared.ActiveCard', c: order(ME_IN, FOE_IN), e }] },
    });
    const territories = fronts();
    const plan = { deploys: [{ territoryId: 4, armies: 3 }], moves: [{ from: 4, to: 6, armies: 2, kind: 'attack' as const, reason: '' }], moveSlots: ['sure' as const], enemyDeploy: 5, conceded: [] };
    const before = structuredClone(plan);
    // e: 4 → in effect until turn 5: turn 4 is its last.
    const last = adviseCards(input({ territories, plan, info: info(4), turn: 4, game: ffa, hand: [card(8, 'Diplomacy')] }));
    const w = last.warnings.join('\n');
    expect(w).toMatch(/Diplomacy is in effect between you and player 7176543229 \(until turn 5\): .*This is its last turn: from turn 5 it can attack you again — chain it: play your Diplomacy card on it this turn/);
    expect(last.view.diplomacy).toMatchObject({ player: FOE.id, chain: true });
    expect(w).toMatch(/Chain it: the Diplomacy card in force with player 7176543229 ends after this turn/);
    // Without a card in hand: the warning, and the borders to ready.
    const bare = adviseCards(input({ territories, plan, info: info(4), turn: 4, game: ffa }));
    expect(bare.warnings.join('\n')).toMatch(/This is its last turn: from turn 5 it can attack you again — ready the borders it faces\./);
    // Not its last turn: no warning, and the partner is passed over.
    const early = adviseCards(input({ territories, plan, info: info(4), turn: 3, game: ffa, hand: [card(8, 'Diplomacy')] }));
    expect(early.warnings.join('\n')).not.toMatch(/last turn/);
    expect(early.view.diplomacy?.player).toBe(FOE2.id);
    // Report-only: the warning and the chain advice leave the plan's orders unchanged.
    expect(plan).toEqual(before);
  });

  it('#424: in a 1v1 the last-turn warning does not say to chain the card (no chain is advised there)', () => {
    const order = (...ints: number[]) => ({
      $type: 'warlight.shared.GameOrderPlayCardDiplomacy',
      ...Object.fromEntries(ints.map((n, i) => [`f${i}`, n])),
      g: 'ab'.repeat(16),
      p: FOE_IN,
    });
    const info = {
      $type: 'warlight.shared.LatestGameInfo',
      s: { $type: 'warlight.shared.GameStanding', a: [{ $type: 'warlight.shared.ActiveCard', c: order(ME_IN, FOE_IN), e: 4 }] },
    };
    const plan = { deploys: [{ territoryId: 4, armies: 3 }], moves: [{ from: 4, to: 3, armies: 10, kind: 'attack' as const, reason: '' }], moveSlots: ['sure' as const], enemyDeploy: 5, conceded: [] };
    const before = structuredClone(plan);
    const { view, warnings } = adviseCards(
      input({ territories: [neutral(3, 2), me(4, 20), foe(5, 20)], plan, info, turn: 4, hand: [card(8, 'Diplomacy')] }),
    );
    expect(plan).toEqual(before);
    const w = warnings.join('\n');
    expect(w).toMatch(/This is its last turn: from turn 5 it can attack you again — ready the borders it faces\./);
    expect(w).not.toMatch(/chain it/i);
    expect(view.diplomacy).toBeUndefined();
  });

  it('says nothing of Diplomacy in a 1v1', () => {
    const { view } = adviseCards(input({ territories: [neutral(3, 2), me(4, 20), foe(5, 20)], hand: [card(8, 'Diplomacy')] }));
    expect(view.diplomacy).toBeUndefined();
  });

  it('advises Sanctions on the leader, from the profile ranking when the plan has one', () => {
    const { view } = adviseCards(input({ territories: fronts(), game: ffa, hand: [card(9, 'Sanctions')] }));
    // Off the board: FOE2's 20 armies lead.
    expect(view.sanctions).toEqual({ player: FOE2.id, order: { kind: 'card', card: 'd'.repeat(32), player: FOE2.id } });
    const ranking = { leader: FOE.id, myRank: 2, of: 3, commonThreat: FOE.id, players: [{ playerId: FOE.id, armies: 9, income: 30, strength: 99 }, { playerId: ME.id, armies: 20, income: 5, strength: 35 }] };
    const plan = { deploys: [], moves: [], moveSlots: [], enemyDeploy: 5, conceded: [], profile: { ranking } as never };
    expect(adviseCards(input({ territories: fronts(), game: ffa, hand: [card(9, 'Sanctions')], plan })).view.sanctions?.player).toBe(FOE.id);
  });

  it('G2: advises the spy cards where the fog hides what the plan needs, each with its order, and never with fog off', () => {
    const fog = { territoryId: 3, owner: { kind: 'unknown' as const }, armies: null, fogLevel: 'Fogged' };
    const territories = [me(1, 5), me(2, 7), fog, neutral(4, 2), neutral(5, 2), neutral(6, 2), foe(7, 3)];
    const hand = [card(2, 'Spy', 'a'), card(10, 'Reconnaissance', 'b'), card(11, 'Surveillance', 'c')];
    const { view, warnings } = adviseCards(input({ territories, game: ffa, hand }));
    expect(view.spy).toEqual({ player: FOE2.id, order: { kind: 'card', card: 'a'.repeat(32), player: FOE2.id } });
    expect(view.reconnaissance).toEqual({ target: 3, order: { kind: 'card', card: 'b'.repeat(32), target: 3 } });
    expect(view.surveillance).toEqual({ bonus: 101, order: { kind: 'card', card: 'c'.repeat(32), bonus: 101 } });
    expect(warnings.join('\n')).toMatch(/Spy on player 8811111299: none of its territories is in view.*Advice only, not in the orders/);
    for (const o of [view.spy!.order, view.reconnaissance!.order, view.surveillance!.order]) expect(turnOrdersArg.safeParse([o]).success).toBe(true);
    const off = adviseCards(input({ territories, game: { ...ffa, settings: { ...settings(), fog: 'NoFog' } }, hand }));
    expect(off.view.spy ?? off.view.reconnaissance ?? off.view.surveillance).toBeUndefined();
    expect(off.warnings.join('\n')).not.toMatch(/Spy|Reconnaissance|Surveillance/);
  });

  it('G2: Sanctions pass over a truce partner, saying why', () => {
    const truces = [{ player: FOE2.id, state: 'active' as const, coveredMine: [4] }];
    const { view, warnings } = adviseCards(input({ territories: fronts(), game: ffa, hand: [card(9, 'Sanctions')], truces }));
    expect(view.sanctions).toMatchObject({ player: FOE.id, skipped: [expect.stringMatching(/^player 8811111299: your truce with it is in force/)] });
    expect(warnings.join('\n')).toMatch(/Sanctions on player 7176543229: .*Passed over: player 8811111299: your truce/);
  });

  it('advises an Airlift onto a border that falls without it', () => {
    const territories = [me(1, 20), me(2, 1), me(3, 1), me(4, 2), foe(5, 10), neutral(6, 2)];
    const { view } = adviseCards(input({ territories, hand: [card(6, 'Airlift')] }));
    expect(view.airlift).toEqual({ from: 1, to: 4, armies: 7, order: { kind: 'card', card: 'd'.repeat(32), from: 1, to: 4, armies: 7 } });
  });

  it('#434: advises an Airlift that flies an idle stack to the strike stack, advice only', () => {
    const territories = [me(1, 12), me(2, 1), me(3, 1), me(4, 10), foe(5, 3), neutral(6, 2), neutral(7, 2)];
    const plan = { deploys: [], moves: [{ from: 4, to: 5, armies: 9, kind: 'attack' as const, reason: '' }], moveSlots: ['sure' as const], enemyDeploy: 5, conceded: [] };
    const before = structuredClone(plan);
    const { view, warnings } = adviseCards(input({ territories, plan, hand: [card(6, 'Airlift')] }));
    expect(view.airlift).toEqual({
      from: 1,
      to: 4,
      armies: 11,
      redeploy: { source: 'idle', target: 'strike' },
      order: { kind: 'card', card: 'd'.repeat(32), from: 1, to: 4, armies: 11 },
    });
    expect(warnings.join('\n')).toMatch(/Airlift 11 from 1 to 4: they sit idle .*Advice only, not in the orders/);
    expect(plan).toEqual(before);
  });

  it("advises a Gift that completes a teammate's bonus, and never a card read under a teammate", () => {
    const MATE: Player = { ...FOE, id: 5544444411, name: 'Dee', team: 1 };
    const a = { ...ME, team: 1 };
    const b = { ...FOE, team: 2 };
    const mate = (territoryId: number, armies: number): TerritoryState => ({ territoryId, owner: { kind: 'player', playerId: MATE.id }, armies });
    const team = { sharedBonuses: [{ bonusId: 101, value: 3, mine: [3], teammates: [{ player: MATE.id, territories: [1, 2] }], others: [], nearer: MATE.id }] };
    const plan = { deploys: [], moves: [], moveSlots: [], enemyDeploy: 5, conceded: [], team };
    const territories = [mate(1, 2), mate(2, 2), me(3, 4), me(4, 4), foe(5, 3)];
    const game = { players: [a, MATE, b], settings: settings() };
    const gift = { ...card(7, 'Gift'), owner: ME_IN };
    const { view } = adviseCards(input({ territories, game, me: a, plan, hand: [gift] }));
    expect(view.gift).toEqual({ player: MATE.id, bonus: 101, territories: [3], orders: [{ kind: 'card', card: 'd'.repeat(32), target: 3, player: MATE.id }] });
    const theirs = { ...gift, owner: 444444 };
    expect(adviseCards(input({ territories, game, me: a, plan, hand: [theirs] })).view.gift).toBeUndefined();
  });

  it('every advised order is one warapp_submit_turn takes', () => {
    const hand = [card(8, 'Diplomacy', 'a'), card(9, 'Sanctions', 'b'), card(6, 'Airlift', 'c')];
    const territories = [me(1, 20), me(2, 1), foe(3, 10), me(4, 2), foe2(5, 20), neutral(6, 2)];
    const { view } = adviseCards(input({ territories, game: ffa, hand }));
    const orders = [view.diplomacy?.order, view.sanctions?.order, view.airlift?.order];
    expect(orders.every(Boolean)).toBe(true);
    expect(turnOrdersArg.safeParse(orders).success).toBe(true);
  });

  it('plays an Order Delay that must leave the hand where the plan can use it, instead of discarding it (#163)', () => {
    const od = card(5, 'Order Delay');
    const choice: CardChoice = { ...none, required: true, discards: [od] };
    const plan = { deploys: [], moves: [{ from: 4, to: 5, armies: 19, kind: 'attack' as const, reason: '' }], moveSlots: ['last' as const], enemyDeploy: 5, conceded: [] };
    const { view, warnings } = adviseCards(input({ territories: [neutral(3, 2), me(4, 20), foe(5, 4)], plan, hand: [od], choice }));
    expect(view.orderDelay).toMatchObject({ card: od.id, before: 1, insteadOfDiscard: true });
    expect(warnings.join('\n')).toMatch(/played \(below\) instead of discarded/);
  });
});

describe('the game around the hand (#163)', () => {
  it('a team game, its players and fog', () => {
    expect(cardGame({ players: [ME, FOE], settings: settings() })).toEqual({ players: 2, team: false, fog: 'Foggy' });
    expect(cardGame({ players: [{ ...ME, team: 0 }, { ...FOE, team: 1 }], settings: undefined })).toEqual({ players: 2, team: true });
    // With me, in a team game: my in-game id (V8: a card under a teammate is not mine to play).
    expect(cardGame({ players: [{ ...ME, team: 0 }, { ...FOE, team: 1 }], settings: undefined }, ME)).toEqual({ players: 2, team: true, me: ME_IN });
    expect(cardGame({ players: [ME, FOE], settings: undefined }, ME)).toEqual({ players: 2, team: false });
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

describe("opponentReinforcement (#164): an opponent's Reinforcement card on the card clock", () => {
  const fixed = normalizeSettings({
    NumberOfCardsToReceiveEachTurn: 1,
    ReinforcementCard: { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 1, Weight: 1, FixedArmies: 8 },
  });
  const progressive = normalizeSettings({
    NumberOfCardsToReceiveEachTurn: 1,
    ReinforcementCard: { NumPieces: 4, InitialPieces: 0, MinimumPiecesPerTurn: 1, Weight: 1, Mode: 1, ProgressivePercentage: 0.1 },
  });
  const rein = (armies: number): Card => ({ id: 'b'.repeat(32), type: 1, name: 'Reinforcement', armies });

  it('gives the first turn one can be in hand, its armies, and the capturing turns each further card takes', () => {
    expect(opponentReinforcement(fixed, [])).toEqual({ firstTurn: 5, armies: 8, turnsPerCard: 4 });
  });
  it('a progressive card is valued at the one in my hand, else unknown', () => {
    expect(opponentReinforcement(progressive, [rein(12)])).toEqual({ firstTurn: 5, armies: 12, turnsPerCard: 4 });
    expect(opponentReinforcement(progressive, [])).toBeUndefined();
    expect(opponentReinforcement(undefined, [])).toBeUndefined();
    expect(opponentReinforcement(settings(), [])).toBeUndefined();
  });
});
