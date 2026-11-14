// The agreement ledger's pure model (docs/PLAN-TEAMS.md A2): transitions, the state on a turn, the
// breach watch over a miniature board history, unspoken truces, the endgame and trust.
import { describe, expect, it } from 'vitest';
import { buildGraph } from '../../src/analysis/graph.js';
import type { MyOrders, TurnBoard } from '../../src/analysis/opponents.js';
import {
  agreementState,
  breachWatch,
  coveredTerritories,
  newAgreement,
  partyRefusal,
  scopeRefusal,
  tacitTruces,
  transitionAgreement,
  trust,
  truceEndgame,
  type Agreement,
  type AgreementTerms,
  type RelationPlayer,
} from '../../src/analysis/relations.js';
import type { TerritoryState } from '../../src/board.js';
import { board, fogged, mine, neutral, tinyMap } from './helpers.js';

// tinyMap: 1─2, 1─3, 2─3, 3─4─5─6─7. Me 10 on 1–4, partner 20 on 5–6, 7 neutral.
const graph = buildGraph(tinyMap());
const ME = 10;
const P = 20;
const OTHER = 30;
const theirs = (id: number, armies: number) => mine(id, armies, P);
const terms = (over: Partial<AgreementTerms> = {}): AgreementTerms => ({ scope: 'all', noticeTurns: 1, ...over });
const agreed = (over: Partial<AgreementTerms> = {}, turn = 3): Agreement => newAgreement('a1', P, 'agreed', turn, terms(over));
const players = (over: Partial<Record<number, Partial<RelationPlayer>>> = {}): RelationPlayer[] =>
  [ME, P, OTHER].map((id) => ({ id, state: 'Playing', isAI: false, humanTurnedIntoAI: false, ...over[id] }));

/** A board: me on 1–4 with `m4` on 4, the partner on 5 (`p5`) and 6 (`p6`), 7 neutral. */
const at = (turn: number, opts: { m4?: number; p5?: number; p6?: number; t4?: TerritoryState; t6?: TerritoryState; orders?: MyOrders } = {}): TurnBoard => ({
  turn,
  board: board([
    mine(1, 3),
    mine(2, 3),
    mine(3, 3),
    opts.t4 ?? mine(4, opts.m4 ?? 5),
    theirs(5, opts.p5 ?? 4),
    opts.t6 ?? theirs(6, opts.p6 ?? 2),
    neutral(7, 2),
  ]),
  ...(opts.orders ? { orders: opts.orders } : {}),
});
const noOrders: MyOrders = { deploys: [], moves: [] };

describe('transitions', () => {
  it('stamps the agreed, notice and ended turns, and keeps the history', () => {
    let a = newAgreement('a1', P, 'proposed-by-them', 2, terms());
    expect(a.agreedTurn).toBeUndefined();
    a = (transitionAgreement(a, 'agreed', 3) as { agreement: Agreement }).agreement;
    expect(a.agreedTurn).toBe(3);
    a = (transitionAgreement(a, 'notice-by-them', 5) as { agreement: Agreement }).agreement;
    expect(a.noticeTurn).toBe(5);
    a = (transitionAgreement(a, 'agreed', 6) as { agreement: Agreement }).agreement;
    expect(a.noticeTurn).toBeUndefined();
    expect(a.agreedTurn).toBe(3);
    a = (transitionAgreement(a, 'ended', 8) as { agreement: Agreement }).agreement;
    expect(a.endedTurn).toBe(8);
    expect(a.history.map((h) => h.status)).toEqual(['proposed-by-them', 'agreed', 'notice-by-them', 'agreed', 'ended']);
  });

  it('refuses anything after a terminal status, and moves the table does not allow', () => {
    const ended = (transitionAgreement(agreed(), 'broken-by-them', 4) as { agreement: Agreement }).agreement;
    expect(transitionAgreement(ended, 'agreed', 5)).toEqual({ refused: expect.stringMatching(/already broken-by-them/) });
    expect(transitionAgreement(newAgreement('a2', P, 'proposed-by-me', 2, terms()), 'notice-by-me', 3)).toEqual({
      refused: expect.stringMatching(/cannot go from proposed-by-me to notice-by-me/),
    });
  });
});

describe('agreementState', () => {
  it('is proposed, then active', () => {
    expect(agreementState(newAgreement('a', P, 'proposed-by-me', 2, terms()), 2, players())).toEqual({ phase: 'proposed' });
    expect(agreementState(agreed(), 4, players())).toEqual({ phase: 'active' });
  });

  it('in notice until the notice has run, then over', () => {
    const a = (transitionAgreement(agreed({ noticeTurns: 2 }), 'notice-by-me', 5) as { agreement: Agreement }).agreement;
    expect(agreementState(a, 5, players())).toEqual({ phase: 'notice', endsTurn: 7 });
    expect(agreementState(a, 6, players())).toEqual({ phase: 'notice', endsTurn: 7 });
    expect(agreementState(a, 7, players())).toEqual({ phase: 'over', reason: 'notice-served' });
  });

  it('is over past its last turn, once its named player is out, and when recorded ended or broken', () => {
    expect(agreementState(agreed({ untilTurn: 6 }), 6, players())).toEqual({ phase: 'active' });
    expect(agreementState(agreed({ untilTurn: 6 }), 7, players())).toEqual({ phase: 'over', reason: 'until-turn' });
    expect(agreementState(agreed({ untilPlayerOut: OTHER }), 4, players({ [OTHER]: { state: 'Eliminated' } }))).toEqual({
      phase: 'over',
      reason: 'two-left',
    });
    const four = [...players(), { id: 40, state: 'Playing' }];
    expect(agreementState(agreed({ untilPlayerOut: OTHER }), 4, four.map((p) => (p.id === OTHER ? { ...p, state: 'Booted' } : p)))).toEqual({
      phase: 'over',
      reason: 'player-out',
    });
    const broken = (transitionAgreement(agreed(), 'broken-by-me', 4) as { agreement: Agreement }).agreement;
    expect(agreementState(broken, 5, players())).toEqual({ phase: 'over', reason: 'broken-by-me' });
  });

  it('is over when the partner is eliminated or became an AI, and when two players remain', () => {
    expect(agreementState(agreed(), 4, players({ [P]: { state: 'Eliminated' } }))).toEqual({ phase: 'over', reason: 'partner-out' });
    expect(agreementState(agreed(), 4, players({ [P]: { humanTurnedIntoAI: true } }))).toEqual({ phase: 'over', reason: 'partner-ai' });
    expect(agreementState(agreed(), 4, players({ [OTHER]: { state: 'SurrenderAccepted' } }))).toEqual({ phase: 'over', reason: 'two-left' });
  });
});

describe('who can be a party', () => {
  it('refuses me, a stranger, an AI, a teammate, a player out, a 1v1 and two left', () => {
    expect(partyRefusal(players(), ME, P)).toBeUndefined();
    expect(partyRefusal(players(), ME, ME)).toMatch(/you/);
    expect(partyRefusal(players(), ME, 99)).toMatch(/not in this game/);
    expect(partyRefusal(players({ [P]: { isAI: true } }), ME, P)).toMatch(/AI/);
    expect(partyRefusal(players({ [ME]: { team: 1 }, [P]: { team: 1 } }), ME, P)).toMatch(/teammate/);
    expect(partyRefusal(players({ [P]: { state: 'Eliminated' } }), ME, P)).toMatch(/no longer playing/);
    expect(partyRefusal(players().slice(0, 2), ME, P)).toMatch(/1v1/);
    expect(partyRefusal(players({ [OTHER]: { state: 'Eliminated' } }), ME, P)).toMatch(/two players remain/);
  });

  it('refuses when no third player or team remains outside me, my team and the partner\'s team', () => {
    const MATE = 40;
    const four = (teams: Record<number, number>): RelationPlayer[] =>
      [ME, MATE, P, OTHER].map((id) => ({ id, state: 'Playing', isAI: false, humanTurnedIntoAI: false, team: teams[id] }));
    // 2v2: the only other player is the partner's teammate.
    expect(partyRefusal(four({ [ME]: 1, [MATE]: 1, [P]: 2, [OTHER]: 2 }), ME, P)).toMatch(/no third player or team/);
    // A third team outside both: allowed.
    expect(partyRefusal(four({ [ME]: 1, [MATE]: 1, [P]: 2, [OTHER]: 3 }), ME, P)).toBeUndefined();
    // Once that third team is out, refused.
    const out = four({ [ME]: 1, [MATE]: 1, [P]: 2, [OTHER]: 3 }).map((x) => (x.id === OTHER ? { ...x, state: 'Eliminated' } : x));
    expect(partyRefusal(out, ME, P)).toMatch(/no third player or team/);
  });

  it('refuses a scope naming what is not on the map', () => {
    expect(scopeRefusal(graph, 'all')).toBeUndefined();
    expect(scopeRefusal(graph, { territories: [4, 99] })).toMatch(/99/);
    expect(scopeRefusal(graph, { bonuses: [102] })).toBeUndefined();
    expect(scopeRefusal(graph, { bonuses: [] })).toMatch(/no bonus/);
  });

  it('covers my territories in the scope only', () => {
    const held = new Set([1, 2, 3, 4]);
    expect(coveredTerritories(graph, 'all', held)).toEqual([1, 2, 3, 4]);
    expect(coveredTerritories(graph, { territories: [4, 5] }, held)).toEqual([4]);
    expect(coveredTerritories(graph, { bonuses: [102] }, held)).toEqual([4]);
  });
});

describe('breachWatch', () => {
  it('flags broken when the partner takes a covered territory', () => {
    const flags = breachWatch({ agreement: agreed(), graph, me: ME, boards: [at(3), at(4, { t4: theirs(4, 3) })] });
    expect(flags).toEqual([expect.objectContaining({ kind: 'broken', turn: 3, territories: [4] })]);
  });

  it('flags broken when my orders cannot explain armies lost where only the partner borders', () => {
    const flags = breachWatch({ agreement: agreed(), graph, me: ME, boards: [at(3, { orders: noOrders }), at(4, { m4: 2 })] });
    expect(flags).toEqual([expect.objectContaining({ kind: 'broken', territories: [4], evidence: expect.stringMatching(/attacked/) })]);
    // My own transfer out explains it: no flag but kept.
    const moved: MyOrders = { deploys: [], moves: [{ from: 4, to: 3, armies: 3 }] };
    expect(breachWatch({ agreement: agreed(), graph, me: ME, boards: [at(3, { orders: moved }), at(4, { m4: 2 })] }).map((f) => f.kind)).toEqual(['kept']);
    // Without my orders a drop could be my transfer: nothing is read into it.
    expect(breachWatch({ agreement: agreed(), graph, me: ME, boards: [at(3), at(4, { m4: 2 })] }).map((f) => f.kind)).toEqual(['kept']);
  });

  it('a shortfall my transfer in would explain, when its source was taken or hit, is ambiguous, not broken', () => {
    // My move 3 -> 4 of 2 never arrived in full: 3 was taken by another player first.
    const fed: MyOrders = { deploys: [], moves: [{ from: 3, to: 4, armies: 2 }] };
    const turn4 = (t3: TerritoryState): TurnBoard => ({
      turn: 4,
      board: board([mine(1, 3), mine(2, 3), t3, mine(4, 5), theirs(5, 4), theirs(6, 2), neutral(7, 2)]),
    });
    const lost = breachWatch({ agreement: agreed(), graph, me: ME, boards: [at(3, { orders: fed }), turn4(mine(3, 2, OTHER))] });
    expect(lost).toEqual([expect.objectContaining({ kind: 'massing', ambiguous: true, territories: [4] })]);
    // Its source hit (fewer armies than my orders leave there): ambiguous too.
    const hit = breachWatch({ agreement: agreed(), graph, me: ME, boards: [at(3, { orders: fed }), turn4(mine(3, 0))] });
    expect(hit).toEqual([expect.objectContaining({ kind: 'massing', ambiguous: true, territories: [4] })]);
    // Its source intact: the transfer arrived, so the shortfall is the partner's.
    const intact = breachWatch({ agreement: agreed(), graph, me: ME, boards: [at(3, { orders: fed }), turn4(mine(3, 1))] });
    expect(intact).toEqual([expect.objectContaining({ kind: 'broken', territories: [4] })]);
  });

  it('under fog, a covered territory lost to an unseen owner is massing, not broken', () => {
    const flags = breachWatch({ agreement: agreed(), graph, me: ME, boards: [at(3), at(4, { t4: fogged(4) })] });
    expect(flags).toEqual([expect.objectContaining({ kind: 'massing', ambiguous: true, territories: [4] })]);
  });

  it('flags massing after growth near the border two turns running, but a fog reveal is no growth', () => {
    const growing = [at(3, { p5: 4 }), at(4, { p5: 7 }), at(5, { p5: 10 })];
    expect(breachWatch({ agreement: agreed(), graph, me: ME, boards: growing })).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'massing', growth: 6, turn: 4 })]),
    );
    // 6 fogged, then revealed with 30: not growth (5 holds steady).
    const reveal = [at(3, { t6: fogged(6) }), at(4, { t6: fogged(6) }), at(5, { p6: 30 })];
    expect(breachWatch({ agreement: agreed(), graph, me: ME, boards: reveal }).map((f) => f.kind)).toEqual(['kept']);
  });

  it('flags massing only when the growing pairs end at the newest board', () => {
    // Growth over 3→4→5, then a gap and a board for turn 7: the growth is old news.
    const stale = [at(3, { p5: 4 }), at(4, { p5: 7 }), at(5, { p5: 10 }), at(7, { p5: 10 })];
    expect(breachWatch({ agreement: agreed(), graph, me: ME, boards: stale }).some((f) => f.kind === 'massing')).toBe(false);
  });

  it('flags a stack over the cap on the newest board', () => {
    const flags = breachWatch({ agreement: agreed({ borderCap: 5 }), graph, me: ME, boards: [at(3, { p5: 8 })] });
    expect(flags).toEqual([expect.objectContaining({ kind: 'cap-exceeded', territories: [5], armies: 8, cap: 5 })]);
  });

  it('flags a partner outgrowing me', () => {
    const flags = breachWatch({ agreement: agreed(), graph, me: ME, boards: [at(3)], incomes: { mine: 10, partner: 16 } });
    expect(flags).toEqual([expect.objectContaining({ kind: 'outgrowing', ratio: 1.6 })]);
    expect(breachWatch({ agreement: agreed(), graph, me: ME, boards: [at(3)], incomes: { mine: 10, partner: 15 } })).toEqual([]);
  });

  it('counts quiet turns as kept, only from the turn agreed, and nothing for a proposal', () => {
    const boards = [at(1, { m4: 9 }), at(2, { t4: theirs(4, 1) }), at(3), at(4), at(5)];
    // The capture on turn 1 came before the agreement (turn 3).
    expect(breachWatch({ agreement: agreed(), graph, me: ME, boards })).toEqual([
      expect.objectContaining({ kind: 'kept', quietTurns: 2, turn: 4 }),
    ]);
    expect(breachWatch({ agreement: newAgreement('p', P, 'proposed-by-me', 3, terms()), graph, me: ME, boards })).toEqual([]);
  });
});

describe('tacitTruces', () => {
  const quiet = [at(2), at(3), at(4), at(5)];
  it('reports a neighbour quiet for three turns with no agreement', () => {
    expect(tacitTruces({ graph, boards: quiet, me: ME })).toEqual([{ player: P, quietTurns: 3, border: [4] }]);
    expect(tacitTruces({ graph, boards: quiet, me: ME, exclude: new Set([P]) })).toEqual([]);
  });

  it('a deploy on the border, or a turn missing, breaks the quiet', () => {
    expect(tacitTruces({ graph, boards: [at(2), at(3), at(4, { p5: 6 }), at(5, { p5: 6 })], me: ME })).toEqual([]);
    expect(tacitTruces({ graph, boards: [at(1), at(2), at(4), at(5)], me: ME })).toEqual([]);
    const deployed: MyOrders = { deploys: [{ territoryId: 4, armies: 2 }], moves: [] };
    expect(tacitTruces({ graph, boards: [at(2), at(3), at(4, { orders: deployed }), at(5, { m4: 7 })], me: ME })).toEqual([]);
  });
});

describe('endgame and trust', () => {
  it('is the endgame when no other opponent reaches half the larger of us', () => {
    expect(truceEndgame({ mine: 20, partner: 30, others: [14] })).toBe(true);
    expect(truceEndgame({ mine: 20, partner: 30, others: [15] })).toBe(false);
    expect(truceEndgame({ mine: 20, partner: 30, others: [] })).toBe(true);
  });

  it('watches on any flag but kept, on their notice, and in the endgame', () => {
    const kept = [{ kind: 'kept' as const, turn: 4, territories: [], evidence: '' }];
    expect(trust(agreed(), kept, { endgame: false })).toEqual({ level: 'clear', reasons: [] });
    expect(trust(agreed(), [{ kind: 'massing', turn: 4, territories: [4], evidence: '' }], {}).level).toBe('watch');
    const notice = (transitionAgreement(agreed(), 'notice-by-them', 5) as { agreement: Agreement }).agreement;
    expect(trust(notice, kept, {}).reasons).toEqual(['they gave notice']);
    expect(trust(agreed(), kept, { endgame: true }).level).toBe('watch');
  });
});
