// B4 (docs/PLAN-TEAMS.md section 8): a message promises only what the plan does — each commitment kind
// accepted and refused against this turn's orders and the ledger, and the warnings later orders draw.
import { describe, expect, it } from 'vitest';
import { checkCommitments, commitmentWarnings, type Commitment, type OrderMove, type RecordedCommitment } from '../../src/analysis/commitments.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { newAgreement, transitionAgreement, type Agreement, type AgreementTerms, type RelationPlayer } from '../../src/analysis/relations.js';
import { board, fogged, mine, neutral, tinyMap } from './helpers.js';

// tinyMap: 1─2, 1─3, 2─3, 3─4─5─6─7. Me 10 on 1–4, partner 20 on 5–6, 7 neutral.
const graph = buildGraph(tinyMap());
const ME = 10;
const P = 20;
const OTHER = 30;
const b = board([mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 9), mine(5, 4, P), mine(6, 2, P), neutral(7, 2)]);
const players: RelationPlayer[] = [ME, P, OTHER].map((id) => ({ id, state: 'Playing', isAI: false, humanTurnedIntoAI: false }));
const terms = (over: Partial<AgreementTerms> = {}): AgreementTerms => ({ scope: 'all', noticeTurns: 1, ...over });
const next = (as: readonly Agreement[]) => `a${as.length + 1}`;
const TURN = 5;

const check = (commitments: Commitment[], moves: OrderMove[] = [], agreements: Agreement[] = [], source: 'plan' | 'submitted' = 'plan') =>
  checkCommitments({ graph, board: b, me: ME, turn: TURN, players, agreements, nextAgreementId: next, commitments, moves, source });
const one = (c: Commitment, moves: OrderMove[] = [], agreements: Agreement[] = [], source: 'plan' | 'submitted' = 'plan') =>
  check([c], moves, agreements, source).checks[0]!;

const ATTACK_5: OrderMove = { from: 4, to: 5 };

describe('no-attack', () => {
  it('is carried when no order attacks a covered territory, and binds through its last turn', () => {
    const c = one({ kind: 'no-attack', with: P, scope: 'all', turns: 3 }, [{ from: 3, to: 4 }]);
    expect(c.refused).toBeUndefined();
    expect(c.carried).toMatch(/no planned order this turn attacks player 20's territories .*through turn 7/);
    expect(c.record).toEqual({ sentTurn: TURN, kind: 'no-attack', with: P, scope: 'all', fromTurn: 5, toTurn: 7 });
  });

  it('is refused when the plan attacks a covered territory, naming the move', () => {
    const c = one({ kind: 'no-attack', with: P, scope: 'all', turns: 1 }, [ATTACK_5]);
    expect(c.refused).toBe("the planned move 1 (4 → 5) attacks player 20's territory 5, which the promise covers");
    expect(c.record).toBeUndefined();
  });

  it('a territory outside the scope, and a transfer-only order, are no conflict', () => {
    expect(one({ kind: 'no-attack', with: P, scope: { territories: [6] }, turns: 1 }, [ATTACK_5]).refused).toBeUndefined();
    expect(one({ kind: 'no-attack', with: P, scope: 'all', turns: 1 }, [{ ...ATTACK_5, transferOnly: true }]).refused).toBeUndefined();
  });

  it('submitted orders are named as such', () => {
    expect(one({ kind: 'no-attack', with: P, scope: 'all', turns: 1 }, [ATTACK_5], [], 'submitted').refused).toMatch(/^the submitted move 1/);
  });

  it('refuses me, a player not in the game, and a scope not on the map', () => {
    expect(one({ kind: 'no-attack', with: ME, scope: 'all', turns: 1 }).refused).toMatch(/yourself/);
    expect(one({ kind: 'no-attack', with: 99, scope: 'all', turns: 1 }).refused).toMatch(/not in this game/);
    expect(one({ kind: 'no-attack', with: P, scope: { territories: [77] }, turns: 1 }).refused).toMatch(/not on this map/);
  });
});

describe('will-attack', () => {
  it('is carried by an order that attacks the player, or the territory', () => {
    const byPlayer = one({ kind: 'will-attack', with: P }, [{ from: 3, to: 4 }, ATTACK_5]);
    expect(byPlayer.carried).toBe('the planned move 2 (4 → 5) attacks player 20');
    expect(byPlayer.record).toEqual({ sentTurn: TURN, kind: 'will-attack', with: P, turn: TURN });
    const byTerritory = one({ kind: 'will-attack', territory: 7, turn: TURN }, [{ from: 4, to: 7 }]);
    expect(byTerritory.carried).toBe('the planned move 1 (4 → 7) attacks territory 7');
  });

  it('is refused when no order carries it, and for any turn but this one', () => {
    expect(one({ kind: 'will-attack', with: P }, [{ from: 3, to: 4 }]).refused).toBe('no planned order this turn attacks player 20');
    expect(one({ kind: 'will-attack', with: P }, [{ ...ATTACK_5, transferOnly: true }]).refused).toMatch(/no planned order/);
    expect(one({ kind: 'will-attack', with: P, turn: TURN + 1 }, [ATTACK_5]).refused).toMatch(/only this turn's orders \(turn 5\).*turn 6 is not planned yet/);
  });

  it('refuses a territory that is mine, another player\'s than named, or nothing named', () => {
    expect(one({ kind: 'will-attack', territory: 4 }, [ATTACK_5]).refused).toMatch(/is yours/);
    expect(one({ kind: 'will-attack', territory: 7, with: P }, [{ from: 4, to: 7 }]).refused).toMatch(/not player 20's/);
    expect(one({ kind: 'will-attack' }).refused).toMatch(/names a player or a territory/);
  });
});

describe('notice', () => {
  const agreed = (over: Partial<AgreementTerms> = {}) => newAgreement('a1', P, 'agreed', 2, terms(over));

  it('is carried on an agreed truce when no order attacks it, moving it to my notice', () => {
    const c = one({ kind: 'notice', agreement: 'a1' }, [{ from: 4, to: 7 }], [agreed({ noticeTurns: 2 })]);
    expect(c.carried).toMatch(/agreement a1 with player 20: notice from turn 5, binding until turn 7/);
    expect(c.change?.agreement).toMatchObject({ status: 'notice-by-me', noticeTurn: 5 });
    expect(c.record).toEqual({ sentTurn: TURN, kind: 'notice', agreement: 'a1', with: P, endsTurn: 7 });
  });

  it('a stated end that comes before the agreed notice has run is refused', () => {
    expect(one({ kind: 'notice', agreement: 'a1', endsTurn: 6 }, [], [agreed({ noticeTurns: 2 })]).refused).toBe(
      'agreement a1 carries 2 turns of notice: given on turn 5, it binds until turn 7, so the message cannot say it ends on turn 6',
    );
    expect(one({ kind: 'notice', agreement: 'a1', endsTurn: 7 }, [], [agreed({ noticeTurns: 2 })]).refused).toBeUndefined();
  });

  it('a stated end later than the agreed notice is refused: the ledger would free the territories first (D3)', () => {
    const c = one({ kind: 'notice', agreement: 'a1', endsTurn: 20 }, [], [agreed({ noticeTurns: 1 })]);
    expect(c.refused).toBe(
      'agreement a1 carries 1 turn of notice: given on turn 5, it binds until turn 6, so the message cannot say it ends on turn 20 ' +
        '(the ledger frees its territories on turn 6: to keep the truce longer, propose new terms)',
    );
    expect(c.record).toBeUndefined();
    expect(c.change).toBeUndefined();
  });

  it('is refused while an order attacks a covered territory, on a proposal, and on an unknown agreement', () => {
    expect(one({ kind: 'notice', agreement: 'a1' }, [ATTACK_5], [agreed()]).refused).toMatch(/attacks territory 5, which agreement a1 covers while its notice runs/);
    expect(one({ kind: 'notice', agreement: 'a1' }, [], [newAgreement('a1', P, 'proposed-by-me', 2, terms())]).refused).toMatch(/is proposed-by-me/);
    expect(one({ kind: 'notice', agreement: 'a9' }).refused).toMatch(/no agreement a9/);
  });

  it('notice already given restates it without moving its turn', () => {
    const inNotice = (transitionAgreement(agreed({ noticeTurns: 2 }), 'notice-by-me', 4) as { agreement: Agreement }).agreement;
    const c = one({ kind: 'notice', agreement: 'a1' }, [], [inNotice]);
    expect(c.carried).toMatch(/notice from turn 4, binding until turn 6/);
    expect(c.change?.agreement.noticeTurn).toBe(4);
    // Once it has run, there is nothing left to give notice on.
    const served = (transitionAgreement(agreed(), 'notice-by-me', 4) as { agreement: Agreement }).agreement;
    expect(one({ kind: 'notice', agreement: 'a1' }, [], [served]).refused).toMatch(/is over \(notice-served\)/);
  });
});

describe('propose and accept', () => {
  it('propose creates my proposal on its terms, or counters theirs', () => {
    const c = one({ kind: 'propose', with: P, terms: terms({ scope: { territories: [5] } }) });
    expect(c.change).toMatchObject({ created: true, agreement: { id: 'a1', with: P, status: 'proposed-by-me' } });
    expect(c.record).toEqual({ sentTurn: TURN, kind: 'propose', agreement: 'a1', with: P });
    const theirs = newAgreement('a1', P, 'proposed-by-them', 4, terms());
    const counter = one({ kind: 'propose', with: P, terms: terms({ noticeTurns: 2 }) }, [], [theirs]);
    expect(counter.change).toMatchObject({ created: false, agreement: { id: 'a1', status: 'proposed-by-me', terms: { noticeTurns: 2 } } });
  });

  it('propose is refused while the plan attacks what it covers, for an agreed partner, and for a player who cannot be a party', () => {
    expect(one({ kind: 'propose', with: P, terms: terms() }, [ATTACK_5]).refused).toMatch(/attacks player 20's territory 5, which the proposed truce covers/);
    expect(one({ kind: 'propose', with: P, terms: terms() }, [], [newAgreement('a1', P, 'agreed', 2, terms())]).refused).toMatch(/already agreed/);
    expect(one({ kind: 'propose', with: ME, terms: terms() }).refused).toMatch(/that is you/);
  });

  it('accept agrees a recorded proposal (by id or by player), or records new terms as agreed', () => {
    const theirs = newAgreement('a1', P, 'proposed-by-them', 4, terms());
    expect(one({ kind: 'accept', agreement: 'a1' }, [], [theirs]).change).toMatchObject({ agreement: { status: 'agreed', agreedTurn: TURN } });
    expect(one({ kind: 'accept', with: P }, [], [theirs]).change).toMatchObject({ agreement: { id: 'a1', status: 'agreed' } });
    const fresh = one({ kind: 'accept', with: P, terms: terms() });
    expect(fresh.change).toMatchObject({ created: true, agreement: { status: 'agreed', agreedTurn: TURN } });
    expect(fresh.record).toEqual({ sentTurn: TURN, kind: 'accept', agreement: 'a1', with: P });
  });

  it('accept is refused with other terms, with nothing to accept, and while the plan attacks what it covers', () => {
    const theirs = newAgreement('a1', P, 'proposed-by-them', 4, terms());
    expect(one({ kind: 'accept', agreement: 'a1', terms: terms({ noticeTurns: 3 }) }, [], [theirs]).refused).toMatch(/counter-offer is a propose/);
    expect(one({ kind: 'accept', with: P }).refused).toMatch(/no proposal from player 20 is recorded/);
    expect(one({ kind: 'accept', agreement: 'a1' }, [ATTACK_5], [theirs]).refused).toMatch(/which the accepted truce covers/);
  });

  it('accept is refused for another partner than the agreement\'s, with nothing named, and on an agreed partner', () => {
    const theirs = newAgreement('a1', P, 'proposed-by-them', 4, terms());
    expect(one({ kind: 'accept', agreement: 'a1', with: OTHER }, [], [theirs]).refused).toMatch(/is with player 20, not player 30/);
    expect(one({ kind: 'accept' }).refused).toMatch(/names the agreement, or the player and the terms/);
    expect(one({ kind: 'accept', with: P }, [], [newAgreement('a1', P, 'agreed', 2, terms())]).refused).toMatch(/already agreed/);
    expect(one({ kind: 'accept', agreement: 'a1' }, [], [newAgreement('a1', P, 'agreed', 2, terms())]).refused).toMatch(/only a proposal is accepted/);
  });

  it('later commitments see the changes earlier ones make', () => {
    const { checks, agreements } = check([
      { kind: 'propose', with: P, terms: terms() },
      { kind: 'accept', with: P },
    ]);
    expect(checks.map((c) => c.refused)).toEqual([undefined, undefined]);
    expect(agreements).toEqual([expect.objectContaining({ id: 'a1', status: 'agreed' })]);
  });
});

describe('a territory whose owner is not shown (fog)', () => {
  // 6 is fogged: it may be player 20's.
  const fb = board([mine(1, 3), mine(2, 3), mine(3, 3), mine(4, 9), mine(5, 4, P), fogged(6), neutral(7, 2)]);
  const onFog = (c: Commitment, moves: OrderMove[], agreements: Agreement[] = []) =>
    checkCommitments({ graph, board: fb, me: ME, turn: TURN, players, agreements, nextAgreementId: next, commitments: [c], moves, source: 'plan' }).checks[0]!;
  const INTO_6: OrderMove = { from: 5, to: 6 };

  it('a no-attack naming it is refused when an order attacks it', () => {
    expect(onFog({ kind: 'no-attack', with: P, scope: { territories: [6] }, turns: 1 }, [INTO_6]).refused).toBe(
      "the planned move 1 (5 → 6) attacks territory 6, which the promise names and whose owner is not shown: it may be player 20's",
    );
    expect(onFog({ kind: 'no-attack', with: P, scope: { bonuses: [103] }, turns: 1 }, [INTO_6]).refused).toMatch(/whose owner is not shown/);
    expect(onFog({ kind: 'no-attack', with: P, scope: { territories: [6] }, turns: 1 }, [{ ...INTO_6, transferOnly: true }]).refused).toBeUndefined();
  });

  it('a promise over all its territories says the orders into the fog were not checked', () => {
    const c = onFog({ kind: 'no-attack', with: P, scope: 'all', turns: 1 }, [INTO_6]);
    expect(c.refused).toBeUndefined();
    expect(c.carried).toMatch(/; move 1 \(5 → 6\) goes into a territory whose owner is not shown, which was not checked/);
  });

  it('a truce naming it is refused when an order attacks it', () => {
    expect(onFog({ kind: 'propose', with: P, terms: terms({ scope: { territories: [5, 6] } }) }, [INTO_6]).refused).toMatch(
      /attacks territory 6, which the proposed truce names and whose owner is not shown/,
    );
  });

  it('a promised attack on a player is not carried by an attack into the fog, and says why', () => {
    expect(onFog({ kind: 'will-attack', with: P }, [INTO_6]).refused).toBe(
      'no planned order this turn attacks player 20 (move 1 (5 → 6) goes into a territory whose owner is not shown, which does not count)',
    );
  });

  it('commitmentWarnings: an attack on a fogged territory a no-attack names', () => {
    const c = { id: 'c1', sentTurn: 4, kind: 'no-attack', with: P, scope: { territories: [6] }, fromTurn: 4, toTurn: 6 } as RecordedCommitment;
    expect(commitmentWarnings({ commitments: [c], agreements: [], graph, board: fb, me: ME, turn: TURN, moves: [INTO_6] })).toEqual([
      expect.objectContaining({ commitment: 'c1', moves: [{ index: 0, from: 5, to: 6 }], text: expect.stringMatching(/move 1 \(5 → 6\) attacks it \(territory 6's owner is not shown\)/) }),
    ]);
  });
});

describe('the end of a truce, and terms restated on an accept', () => {
  it('a truce whose last turn is before this one is refused, on propose and accept', () => {
    expect(one({ kind: 'propose', with: P, terms: terms({ untilTurn: 4 }) }).refused).toBe('the truce would bind only until turn 4, before this turn (5)');
    expect(one({ kind: 'accept', with: P, terms: terms({ untilTurn: 4 }) }).refused).toMatch(/until turn 4, before this turn/);
    const stale = newAgreement('a1', P, 'proposed-by-them', 2, terms({ untilTurn: 3 }));
    expect(one({ kind: 'accept', agreement: 'a1' }, [], [stale]).refused).toMatch(/until turn 3, before this turn/);
    expect(one({ kind: 'propose', with: P, terms: terms({ untilTurn: 5 }) }).refused).toBeUndefined();
  });

  it('an accept compares only the terms it restates', () => {
    const theirs = newAgreement('a1', P, 'proposed-by-them', 4, terms({ scope: { territories: [5] }, noticeTurns: 2 }));
    expect(one({ kind: 'accept', agreement: 'a1', terms: { noticeTurns: 2 } }, [], [theirs]).change).toMatchObject({ agreement: { status: 'agreed' } });
    expect(one({ kind: 'accept', agreement: 'a1', terms: { noticeTurns: 1 } }, [], [theirs]).refused).toMatch(/counter-offer/);
    expect(one({ kind: 'accept', agreement: 'a1', terms: { scope: 'all' } }, [], [theirs]).refused).toMatch(/counter-offer/);
    // New terms accepted: what is not given takes the defaults (all, 1 turn of notice).
    expect(one({ kind: 'accept', with: P, terms: { noticeTurns: 3 } }).change?.agreement.terms).toEqual({ scope: 'all', noticeTurns: 3 });
  });
});

describe('commitmentWarnings', () => {
  const rec = (c: Omit<RecordedCommitment, 'id' | 'sentTurn'> & Partial<RecordedCommitment>) => ({ id: 'c1', sentTurn: 4, ...c }) as RecordedCommitment;
  const warn = (commitments: RecordedCommitment[], moves: OrderMove[], agreements: Agreement[] = [], turn = TURN) =>
    commitmentWarnings({ commitments, agreements, graph, board: b, me: ME, turn, moves });

  it('an order that attacks what a no-attack still covers', () => {
    const c = rec({ kind: 'no-attack', with: P, scope: 'all', fromTurn: 4, toTurn: 6 });
    expect(warn([c], [ATTACK_5])).toEqual([
      { commitment: 'c1', kind: 'no-attack', with: P, moves: [{ index: 0, from: 4, to: 5 }], text: 'commitment c1 (sent turn 4) promised player 20 no attack there through turn 6: move 1 (4 → 5) attacks it' },
    ]);
    expect(warn([c], [ATTACK_5], [], 7)).toEqual([]);
    expect(warn([c], [{ from: 4, to: 7 }])).toEqual([]);
  });

  it('a will-attack this turn that no order carries', () => {
    const c = rec({ kind: 'will-attack', with: P, turn: TURN });
    expect(warn([c], [{ from: 4, to: 7 }])).toEqual([
      expect.objectContaining({ commitment: 'c1', kind: 'will-attack', text: 'commitment c1 (sent turn 4) said you would attack player 20 this turn: no order here does' }),
    ]);
    expect(warn([c], [ATTACK_5])).toEqual([]);
    expect(warn([c], [{ from: 4, to: 7 }], [], TURN + 1)).toEqual([]);
  });

  it('an attack on what a truce I proposed (still open) covers', () => {
    const a = newAgreement('a1', P, 'proposed-by-me', 4, terms());
    const c = rec({ kind: 'propose', agreement: 'a1', with: P });
    expect(warn([c], [ATTACK_5], [a])[0]?.text).toMatch(/proposed truce a1 to player 20, still open: move 1 \(4 → 5\)/);
    expect(warn([c], [ATTACK_5], [(transitionAgreement(a, 'ended', 5) as { agreement: Agreement }).agreement])).toEqual([]);
  });
});
