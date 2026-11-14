// B3 (docs/PLAN-TEAMS.md section 8): pricing a truce by planning with and without it, the verdict,
// the three checks on an offer, the shared border and the facts the agent may cite. Every map, id
// and name here is made up.
import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type PlannerSettings, type PlanRelation } from '../../src/analysis/planner.js';
import {
  diplomacyFacts,
  offerChecks,
  partnerReading,
  priceTruce,
  reliabilityOf,
  seesUnderFog,
  sharedBorder,
  suggestedTerms,
  SUGGESTED_TRUCE_TURNS,
  truceVerdict,
  type AgreementTerms,
  type RecordFacts,
} from '../../src/analysis/relations.js';
import type { GameMap } from '../../src/normalize.js';
import { board, mine, neutral } from './helpers.js';

const ME = 10;
const PARTNER = 20;
const OTHER = 30;
const STD: PlannerSettings = { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true };
const FFA = [{ id: ME }, { id: PARTNER }, { id: OTHER }];

function makeMap(ids: number[], edges: [number, number][], bonuses: [number, number, number[]][]): GameMap {
  return {
    id: 1,
    name: 'Synthetic',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      connectedTo: edges.filter(([a, b]) => a === id || b === id).map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: bonuses.map(([id, value, territoryIds]) => ({ id, name: `B${id}`, value, territoryIds, bonusIds: [] })),
    distributionModes: [],
  };
}
const enemy = (territoryId: number, armies: number, playerId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const fogged = (territoryId: number): TerritoryState => ({ territoryId, owner: { kind: 'unknown' }, armies: null, fogLevel: 'Fogged' });

// The B2 miniature: T1 (24) faces the partner's 40 on T2; T3 (2) beside the 4-army neutral T4
// completes B900 (+3). T6 is a neutral beside the partner; T7 the other player's, beside the partner;
// T9 the other player's, far from me. Income 5: holding T1 against the partner's 39 movable plus its
// ~5 deploy takes 3, and the capture of T4 takes all 5.
const g = buildGraph(
  makeMap(
    [1, 2, 3, 4, 5, 6, 7, 9],
    [
      [1, 2],
      [1, 3],
      [3, 4],
      [4, 5],
      [5, 9],
      [2, 6],
      [2, 7],
    ],
    [
      [900, 3, [3, 4]],
      [901, 2, [7, 9]],
    ],
  ),
);
const at = (over: { t2?: TerritoryState; t6?: TerritoryState; t7?: TerritoryState } = {}) =>
  board([
    mine(1, 24),
    over.t2 ?? enemy(2, 40, PARTNER),
    mine(3, 2),
    neutral(4, 4),
    neutral(5, 2),
    over.t6 ?? neutral(6, 2),
    over.t7 ?? enemy(7, 6, OTHER),
    enemy(9, 3, OTHER),
  ]);
const input = (over: Partial<PlanInput> = {}): PlanInput => ({
  graph: g,
  board: at(),
  me: ME,
  income: 5,
  settings: STD,
  game: { players: FFA, turn: 8 },
  options: { adapt: true, enemyDeploy: 5 },
  ...over,
});
const scope12: AgreementTerms = { scope: { territories: [1, 2] }, noticeTurns: 1 };
const record = (over: Partial<RecordFacts> = {}): RecordFacts => ({
  made: 4,
  kept: 4,
  endedWithNotice: 0,
  brokenByThem: 0,
  keptRate: 1,
  theirNotice: { honoured: 0, broken: 0 },
  brokenByThemInEndgame: 0,
  brokenByThemLeading: 0,
  ...over,
});

describe('B3 priceTruce: plan with and without the truce', () => {
  it('prices the armies freed, the captures, the bonus and the income it gains this turn', () => {
    const price = priceTruce(input(), PARTNER, scope12);
    expect(price).toMatchObject({
      player: PARTNER,
      coveredMine: [1],
      coveredTheirs: [2],
      honoured: true,
      relaxed: [1],
      armiesFreed: 3,
      capturesGained: [4],
      capturesLost: [],
      bonusesGained: [900],
      incomeGained: 3,
      attacksForgone: [],
      lossIfBroken: expect.objectContaining({ from: 2, to: 1 }),
      reliability: 'unknown',
      record: null,
    });
  });

  it('is the planner called, not changed: its two plans are the plans planTurn makes', () => {
    const i = input();
    const truce: PlanRelation = { player: PARTNER, coveredMine: [1], coveredTheirs: [2], state: 'active', trust: 'clear' };
    const without = planTurn(i);
    const withIt = planTurn({ ...i, relations: [truce] });
    const price = priceTruce(i, PARTNER, scope12);
    expect(price.capturesGained).toEqual(withIt.expected.captures.filter((c) => !without.expected.captures.includes(c)));
    expect(price.incomeGained).toBe(withIt.expected.nextIncome - without.expected.nextIncome);
    expect(price.armiesFreed).toBe(withIt.relations![0]!.armiesFreed);
  });

  it('is deterministic and leaves the input as it was', () => {
    const i = input();
    const before = JSON.stringify(i);
    expect(priceTruce(i, PARTNER, scope12)).toEqual(priceTruce(i, PARTNER, scope12));
    expect(JSON.stringify(i)).toBe(before);
  });

  it('reuses a no-deal plan given, and keeps every other relation on both sides', () => {
    const other: PlanRelation = { player: OTHER, coveredMine: [3], coveredTheirs: [9], state: 'active', trust: 'clear' };
    const i = input({ relations: [other] });
    const without = planTurn(i);
    expect(priceTruce(i, PARTNER, scope12, { without })).toEqual(priceTruce(i, PARTNER, scope12));
    // A recorded truce with the same player is taken out of the no-deal plan and replaced by the terms priced.
    const same: PlanRelation = { player: PARTNER, coveredMine: [1], coveredTheirs: [2], state: 'active', trust: 'clear' };
    expect(priceTruce(input({ relations: [same] }), PARTNER, scope12).armiesFreed).toBe(3);
  });

  it('ignores a no-deal plan given when the input already holds a relation with the partner (it is no no-deal plan)', () => {
    const same: PlanRelation = { player: PARTNER, coveredMine: [1], coveredTheirs: [2], state: 'active', trust: 'clear' };
    const i = input({ relations: [same] });
    // planTurn(i) carries the recorded truce: priced against it, the truce would gain nothing.
    const price = priceTruce(i, PARTNER, scope12, { without: planTurn(i) });
    expect(price).toEqual(priceTruce(i, PARTNER, scope12));
    expect(price).toMatchObject({ armiesFreed: 3, capturesGained: [4], bonusesGained: [900], incomeGained: 3 });
  });

  it('a truce under watch trust (the endgame) relaxes nothing and frees nothing', () => {
    const price = priceTruce(input(), PARTNER, scope12, { trust: 'watch', watch: ['endgame'] });
    expect(price).toMatchObject({ armiesFreed: 0, relaxed: [], incomeGained: 0, fullHold: [{ territory: 1, why: 'watch' }] });
    expect(truceVerdict(price, 5)).toMatchObject({ verdict: 'no' });
    expect(truceVerdict(price, 5).reasons.join(' ')).toMatch(/full hold \(1: watch\)/);
  });

  it("carries the board's reading of a recorded truce into the price: a break by them is no truce (T8)", () => {
    const broken: PlanRelation = {
      player: PARTNER,
      coveredMine: [1],
      coveredTheirs: [2],
      state: 'broken',
      trust: 'watch',
      watch: ['broken'],
      agreement: 'a1',
      breach: { term: 'took or attacked a covered territory of mine', turn: 7, evidence: 'took territories 1 on turn 7', territories: [1] },
    };
    const i = input({ relations: [broken] });
    const price = priceTruce(i, PARTNER, scope12, { agreement: 'a1' });
    // The plan with it is the plan warapp_plan_turn makes: the broken relation, as recorded.
    const asPlanned = planTurn(i);
    expect(price).toMatchObject({ state: 'broken', trust: 'watch', watch: ['broken'], honoured: false, armiesFreed: 0, incomeGained: 0 });
    expect(price.breach).toMatchObject({ turn: 7, territories: [1] });
    expect(asPlanned.relations?.[0]).toMatchObject({ state: 'broken', honoured: false });
    const v = truceVerdict(price, 5);
    expect(v).toEqual({ verdict: 'no', reasons: [expect.stringMatching(/broke the truce: took or attacked a covered territory of mine on turn 7 \(took territories 1 on turn 7\).*ordinary opponent/)] });
  });

  it("carries a recorded truce's watch flags (massing, their notice) into the price: full holds, and no", () => {
    for (const watch of [['massing'], ['their-notice'], ['cap-exceeded', 'outgrowing']] as const) {
      const rel: PlanRelation = { player: PARTNER, coveredMine: [1], coveredTheirs: [2], state: 'active', trust: 'watch', watch: [...watch] };
      const price = priceTruce(input({ relations: [rel] }), PARTNER, scope12);
      expect(price).toMatchObject({ state: 'active', trust: 'watch', watch: [...watch], armiesFreed: 0, relaxed: [], incomeGained: 0 });
      const v = truceVerdict(price, 5);
      expect(v.verdict).toBe('no');
      expect(v.reasons.join(' ')).toMatch(/under watch/);
    }
    const massing = truceVerdict(
      priceTruce(input({ relations: [{ player: PARTNER, coveredMine: [1], coveredTheirs: [2], state: 'active', trust: 'watch', watch: ['massing'] }] }), PARTNER, scope12),
      5,
    );
    expect(massing.reasons.join(' ')).toMatch(/massing armies beside the covered border/);
    // The endgame given by the caller joins the relation's own flags, once each.
    const both = priceTruce(
      input({ relations: [{ player: PARTNER, coveredMine: [1], coveredTheirs: [2], state: 'active', trust: 'watch', watch: ['massing', 'endgame'] }] }),
      PARTNER,
      scope12,
      { trust: 'watch', watch: ['endgame'] },
    );
    expect(both.watch).toEqual(['massing', 'endgame']);
    // A clear relation stays clear: the price is the unrecorded one's.
    const clear = priceTruce(input({ relations: [{ player: PARTNER, coveredMine: [1], coveredTheirs: [2], state: 'active', trust: 'clear' }] }), PARTNER, scope12);
    expect(clear).toMatchObject({ trust: 'clear', watch: [], armiesFreed: 3 });
    expect(truceVerdict(clear, 5).verdict).toBe('propose');
  });

  it('carries a recorded truce in notice into the price, with when it ends', () => {
    const rel: PlanRelation = { player: PARTNER, coveredMine: [1], coveredTheirs: [2], state: 'notice', endsTurn: 9, noticeBy: 'me', trust: 'clear' };
    const price = priceTruce(input({ relations: [rel] }), PARTNER, scope12);
    expect(price).toMatchObject({ state: 'notice', endsTurn: 9, noticeBy: 'me', trust: 'clear' });
    expect(price.armiesFreed).toBe(planTurn(input({ relations: [rel] })).relations![0]!.armiesFreed);
    // I am already ending it: never a proposal of the truce I gave notice on.
    expect(truceVerdict(price, 5)).toEqual({
      verdict: 'no',
      reasons: ['I already gave notice on this truce with player 20: it no longer binds from turn 9. To keep a truce, withdraw the notice or propose new terms'],
    });
  });

  it('outside a free-for-all the plan does not honour it, and the verdict is no', () => {
    const price = priceTruce(input({ game: { players: [{ id: ME }, { id: PARTNER }], turn: 8 } }), PARTNER, scope12);
    expect(price.honoured).toBe(false);
    expect(truceVerdict(price, 5)).toEqual({ verdict: 'no', reasons: [expect.stringMatching(/would not honour/)] });
  });

  it("names the no-deal plan's attacks on the partner's covered territories as given up", () => {
    // The partner's T2 is down to 2: the plan without a truce takes it.
    const i = input({ board: at({ t2: enemy(2, 2, PARTNER) }) });
    const without = planTurn(i);
    expect(without.moves.some((m) => m.kind === 'attack' && m.to === 2)).toBe(true);
    const price = priceTruce(i, PARTNER, scope12);
    expect(price.attacksForgone).toEqual([2]);
    expect(price.capturesLost).toContain(2);
    expect(truceVerdict(price, 5).verdict).not.toBe('propose');
  });
});

describe('B3 the partner reading (an estimate)', () => {
  it('reads another front, the neutrals beside it and its armies on the border', () => {
    expect(partnerReading(g, at(), ME, PARTNER, [1])).toEqual({
      estimate: true,
      otherFronts: [OTHER],
      neutralsBeside: 1,
      fogBeside: false,
      armiesOnBorder: 40,
      roomToGrow: true,
    });
  });

  it('no room when it is boxed in by me; unknown when only the fog borders it', () => {
    const boxed = at({ t6: mine(6, 2), t7: mine(7, 2) });
    expect(partnerReading(g, boxed, ME, PARTNER, [1])).toMatchObject({ otherFronts: [], neutralsBeside: 0, roomToGrow: false });
    const fog = at({ t6: mine(6, 2), t7: fogged(7) });
    expect(partnerReading(g, fog, ME, PARTNER, [1])).toMatchObject({ fogBeside: true, roomToGrow: null });
  });
});

describe('B3 the verdict', () => {
  it('proposes a truce that completes a bonus, gives up nothing and leaves the partner room', () => {
    const v = truceVerdict(priceTruce(input(), PARTNER, scope12), 5);
    expect(v.verdict).toBe('propose');
    expect(v.reasons[0]).toMatch(/frees 3 armies; \+3 next income; captures 4/);
  });

  it('only accepts if offered when the partner has nowhere else to go', () => {
    const i = input({ board: at({ t6: mine(6, 2), t7: mine(7, 2) }) });
    const v = truceVerdict(priceTruce(i, PARTNER, scope12), 5);
    expect(v.verdict).toBe('accept-if-offered');
    expect(v.reasons.join(' ')).toMatch(/no other front and no neutral/);
  });

  it("uses the partner's record (D5): one who keeps them is said so; one who breaks them is never proposed to", () => {
    const kept = truceVerdict(priceTruce(input(), PARTNER, scope12, { record: record() }), 5);
    expect(kept.verdict).toBe('propose');
    expect(kept.reasons.join(' ')).toMatch(/keeps agreements \(kept rate 1\)/);
    const broke = priceTruce(input(), PARTNER, scope12, { record: record({ kept: 0, brokenByThem: 3, keptRate: 0 }) });
    expect(broke.reliability).toBe('broke');
    // A break this turn costs me T1: with a record of breaking, the answer is no.
    expect(broke.lossIfBroken?.territories.length).toBeGreaterThan(0);
    expect(truceVerdict(broke, 5)).toMatchObject({ verdict: 'no', reasons: [expect.stringMatching(/breaks agreements/)] });
  });

  it('reads a record by its kept rate', () => {
    expect(reliabilityOf(null)).toBe('unknown');
    expect(reliabilityOf(record({ keptRate: null }))).toBe('unknown');
    expect(reliabilityOf(record({ keptRate: 0.75 }))).toBe('kept');
    expect(reliabilityOf(record({ keptRate: 0.5 }))).toBe('mixed');
    expect(reliabilityOf(record({ keptRate: 0.4 }))).toBe('broke');
  });

  it('a truce on territories that face nothing frees nothing: no', () => {
    const v = truceVerdict(priceTruce(input(), PARTNER, { scope: { territories: [3] }, noticeTurns: 1 }), 5);
    expect(v).toMatchObject({ verdict: 'no', reasons: [expect.stringMatching(/frees nothing/)] });
  });
});

describe('B3 the three checks on an offer', () => {
  it('all three true: stress-test first', () => {
    const c = offerChecks(priceTruce(input(), PARTNER, scope12));
    expect(c).toMatchObject({
      iGainOnlyIfTheyKeepIt: true,
      iLoseIfIComplyAndTheyDoNot: true,
      theyGainFromMyCompliance: true,
      stressTestFirst: true,
    });
    expect(c.reasons[2]).toMatch(/frees their 40 armies on the border for another front/);
  });

  it('an offer that gains me nothing is no reason to stress-test', () => {
    const c = offerChecks(priceTruce(input(), PARTNER, { scope: { territories: [3] }, noticeTurns: 1 }));
    expect(c).toMatchObject({ iGainOnlyIfTheyKeepIt: false, stressTestFirst: false });
  });

  it('a gain that comes only from attacks on them I give up survives a break: it does not rest on their keeping it', () => {
    const base = priceTruce(input(), PARTNER, scope12);
    const c = offerChecks({ ...base, armiesFreed: 0, concededAvoided: [], incomeGained: 2, capturesGained: [4] });
    expect(c.iGainOnlyIfTheyKeepIt).toBe(false);
    expect(c.stressTestFirst).toBe(false);
    expect(c.reasons[0]).toMatch(/not from thinner holds/);
    // Armies freed, or a border kept that would be conceded, come from thinner holds facing them.
    expect(offerChecks({ ...base, armiesFreed: 0, concededAvoided: [1], incomeGained: 0 }).iGainOnlyIfTheyKeepIt).toBe(true);
  });

  it('a boxed-in partner gains nothing from my compliance that shows', () => {
    const c = offerChecks(priceTruce(input({ board: at({ t6: mine(6, 2), t7: mine(7, 2) }) }), PARTNER, scope12));
    expect(c).toMatchObject({ theyGainFromMyCompliance: false, stressTestFirst: false });
  });
});

describe('B3 the shared border and the suggested terms', () => {
  it('counts both sides, their stacks and the chokepoints among them', () => {
    const b = sharedBorder(g, at(), ME, PARTNER, new Set([2, 5]));
    expect(b).toEqual({ mine: [1], theirs: [2], chokepoints: [2], myArmies: 24, theirArmies: 40, theirHidden: 0, largestStack: 40 });
  });

  it('suggests named territories on both sides, one turn of notice, a cap at the largest stack and an end', () => {
    const b = sharedBorder(g, at(), ME, PARTNER, new Set());
    expect(suggestedTerms(b, 8)).toEqual({ scope: { territories: [1, 2] }, noticeTurns: 1, borderCap: 40, untilTurn: 8 + SUGGESTED_TRUCE_TURNS });
    expect(suggestedTerms(b, null)).not.toHaveProperty('untilTurn');
  });
});

describe('B3 facts the agent may cite', () => {
  it('states third players only, true of my board, with what the recipient can see under the fog', () => {
    const facts = diplomacyFacts({ graph: g, board: at(), me: ME, recipient: PARTNER, fog: 'Foggy' });
    expect(facts).toEqual([
      expect.objectContaining({ kind: 'stack-beside-you', about: OTHER, territory: 7, beside: 2, armies: 6, recipientSees: 'yes' }),
      expect.objectContaining({ kind: 'territories', about: OTHER, count: 2, atLeast: true, recipientSees: 'no' }),
      expect.objectContaining({ kind: 'bonuses', about: OTHER, bonuses: [901], value: 2, recipientSees: 'no' }),
    ]);
    expect(facts[1]!.text).toBe(`player ${OTHER} holds at least 2 territories`);
    // Nothing about me: withholding is free.
    expect(facts.every((f) => f.about !== ME && f.about !== PARTNER)).toBe(true);
  });

  it('under fog, what lies wholly beside the recipient is not said to be hidden from it', () => {
    // The other player holds only T7, beside the partner's T2; T9 is neutral.
    const b = board([mine(1, 24), enemy(2, 40, PARTNER), mine(3, 2), neutral(4, 4), neutral(5, 2), neutral(6, 2), enemy(7, 6, OTHER), neutral(9, 3)]);
    const count = (fog: string) => diplomacyFacts({ graph: g, board: b, me: ME, recipient: PARTNER, fog }).find((f) => f.kind === 'territories');
    // Under normal fog it sees the owners beside it; under heavier fog that is not known.
    expect(count('Foggy')).toMatchObject({ count: 1, recipientSees: 'yes' });
    expect(count('VeryFoggy')).toMatchObject({ recipientSees: 'unknown' });
    expect(count('ExtremeFog')).toMatchObject({ recipientSees: 'unknown' });
    // Not wholly beside it (T9 is far from the partner): it cannot be assumed to see it.
    expect(diplomacyFacts({ graph: g, board: at(), me: ME, recipient: PARTNER, fog: 'VeryFoggy' }).find((f) => f.kind === 'bonuses')).toMatchObject({
      recipientSees: 'no',
    });
  });

  it('with every owner shown the count is exact', () => {
    const facts = diplomacyFacts({ graph: g, board: at(), me: ME, recipient: PARTNER, fog: 'NoFog' });
    expect(facts.find((f) => f.kind === 'territories')).toMatchObject({ text: `player ${OTHER} holds 2 territories`, recipientSees: 'yes' });
    expect(facts.find((f) => f.kind === 'territories')).not.toHaveProperty('atLeast');
  });

  it('reads the fog settings, unknown for a name not listed', () => {
    expect(seesUnderFog('LightFog', 'owners')).toBe('yes');
    expect(seesUnderFog('VeryFoggy', 'armies-beside')).toBe('no');
    expect(seesUnderFog('ModerateFog', 'armies-beside')).toBe('unknown');
    expect(seesUnderFog(undefined, 'owners')).toBe('unknown');
    expect(seesUnderFog('SomethingNew', 'owners')).toBe('unknown');
  });
});
