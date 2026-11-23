import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { gameOutlook, LIKELY_INCOME_MARGIN, OUTLOOK_RATIO, OUTLOOK_TURNS, peerPace, type GameOutlook } from '../../src/analysis/outlook.js';
import { planTurn } from '../../src/analysis/planner.js';
import type { TurnBoard } from '../../src/analysis/opponents.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

const ME = 10;
const FOE = 20;

function line(n: number): GameMap {
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  return {
    id: 1,
    name: 'Line',
    territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: ids.filter((x) => Math.abs(x - id) === 1) })),
    bonuses: [],
    distributionModes: [],
  };
}
const g = buildGraph(line(8));
const foe = (territoryId: number, armies: number, playerId = FOE): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
const game = { players: [{ id: ME }, { id: FOE }] };

/** Me on 1–3 with `a` armies each, the foe on 6–8 with `b` each, neutrals on 4–5. */
const apart = (a: number, b: number) =>
  board([mine(1, a), mine(2, a), mine(3, a), neutral(4, 2), neutral(5, 2), foe(6, b), foe(7, b), foe(8, b)]);
const turns = (from: number, boards: ReturnType<typeof board>[]): TurnBoard[] => boards.map((b, i) => ({ turn: from + i, board: b }));

describe('gameOutlook (#178)', () => {
  it('reports winning once strength (armies + 3 × income) is at least 2.4× the strongest opponent on 3 turns running', () => {
    // Me: 3 × 20 + 3 × 5 = 75; the foe: 3 × 5 + 3 × 5 = 30 — 2.5×.
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [apart(20, 5), apart(20, 5), apart(20, 5)]), game });
    expect(OUTLOOK_TURNS).toBe(3);
    expect(o.state).toBe('winning');
    expect(o.heldTurns).toBe(3);
    expect(o.turns.at(-1)).toMatchObject({ turn: 6, mine: 75, strongest: { playerId: FOE, low: 30, high: 30 }, state: 'winning' });
    expect(o.turns.at(-1)!.ratio.low).toBeCloseTo(2.5);
    expect(o.basis).toMatch(/armies \+ 3 × income/);
    expect(o.basis).toMatch(new RegExp(`${OUTLOOK_RATIO}×`));
    expect(o.basis).toMatch(/never measured for war\.app/);
  });

  it('reports losing at 1/2.4 or below', () => {
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [apart(5, 20), apart(5, 20), apart(5, 20)]), game });
    expect(o.state).toBe('losing');
  });

  it('reports nothing until the state has held for 3 turns, and lists each turn', () => {
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [apart(10, 10), apart(20, 5), apart(20, 5)]), game });
    expect(o.state).toBeNull();
    expect(o.heldTurns).toBe(2);
    expect(o.turns.map((t) => t.state)).toEqual(['even', 'winning', 'winning']);
    expect(o.basis).toMatch(/winning for 2 of the 3 turns/i);
  });

  it('needs 3 consecutive turns of boards: fewer, or a gap, reports nothing', () => {
    const short = gameOutlook({ graph: g, me: ME, boards: turns(5, [apart(20, 5), apart(20, 5)]), game });
    expect(short.state).toBeNull();
    expect(short.basis).toMatch(/2 turns? of boards/);
    const gap = gameOutlook({
      graph: g,
      me: ME,
      boards: [{ turn: 2, board: apart(20, 5) }, ...turns(5, [apart(20, 5), apart(20, 5)])],
      game,
    });
    expect(gap.state).toBeNull();
    expect(gap.turns.map((t) => t.turn)).toEqual([5, 6]);
  });

  it('reports a stalemate when nothing changed hands for 3 turns along a front, even on strength', () => {
    const front = (a: number) =>
      board([mine(1, a), mine(2, a), mine(3, a), foe(4, a), foe(5, a), foe(6, a), neutral(7, 2), neutral(8, 2)]);
    const o = gameOutlook({ graph: g, me: ME, boards: turns(3, [front(10), front(12), front(14), front(16)]), game });
    expect(o.state).toBe('stalemate');
    expect(o.turns.map((t) => t.turn)).toEqual([4, 5, 6]);
    // A capture on the last turn breaks it.
    const moved = board([mine(1, 16), mine(2, 16), mine(3, 16), mine(4, 3), foe(5, 16), foe(6, 16), neutral(7, 2), neutral(8, 2)]);
    expect(gameOutlook({ graph: g, me: ME, boards: turns(3, [front(10), front(12), front(14), moved]), game }).state).toBeNull();
  });

  it('#201: a front the forecast says breaks is no stalemate, though nothing changed hands', () => {
    // Player 20's 30 on T4 beside my 4 on T3: pressing every turn it grinds T3 down at once.
    const lopsided = board([mine(1, 16), mine(2, 16), mine(3, 4), foe(4, 30), foe(5, 5), foe(6, 5), neutral(7, 2), neutral(8, 2)]);
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [lopsided, lopsided, lopsided]), game });
    expect(o.turns.at(-1)!.front).toMatchObject({ outcome: 'ground-down', mine: 4, theirs: 30 });
    expect(o.turns.at(-1)!.state).toBe('even');
    expect(o.state).toBe('even');
    // Even stacks are a stand-off: the stalemate stands, and the turn carries that forecast.
    const front = (a: number) => board([mine(1, a), mine(2, a), mine(3, a), foe(4, a), foe(5, a), foe(6, a), neutral(7, 2), neutral(8, 2)]);
    const st = gameOutlook({ graph: g, me: ME, boards: turns(3, [front(10), front(12), front(14), front(16)]), game });
    expect(st.turns.at(-1)!.front).toMatchObject({ outcome: 'stand-off' });
  });

  it('under fog an opponent\'s strength is a range; an unbounded one is never a win', () => {
    const fog = (a: number) => board([mine(1, a), mine(2, a), mine(3, a), neutral(4, 2), fogged(5), fogged(6), foe(7, 2), fogged(8)]);
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [fog(30), fog(30), fog(30)]), game });
    const last = o.turns.at(-1)!;
    expect(last.strongest).toMatchObject({ playerId: FOE, low: 2 + 3 * 5 });
    expect(last.ratio.high).toBeGreaterThan(OUTLOOK_RATIO);
    expect(last.state).not.toBe('winning');
    expect(o.state).not.toBe('winning');
  });

  it('with the starts known (and no cards), bounds a fogged opponent by all it could have received, and can call a win', () => {
    const fog = (a: number) => board([mine(1, a), mine(2, a), mine(3, a), neutral(4, 2), fogged(5), fogged(6), foe(7, 2), fogged(8)]);
    const start = { territories: 2, armiesPerTerritory: 5 };
    const o = gameOutlook({ graph: g, me: ME, boards: turns(2, [fog(40), fog(40), fog(40)]), game: { ...game, start } });
    // Turn 4: received at most 10 + 4 × 5 = 30, so 30 + 3 × 5 = 45 against my 120 + 15 = 135: 3×.
    expect(o.turns.at(-1)!.strongest).toMatchObject({ playerId: FOE, low: 17, high: 45 });
    expect(o.state).toBe('winning');
    // A Reinforcement card could add armies: unbounded again.
    expect(gameOutlook({ graph: g, me: ME, boards: turns(2, [fog(40), fog(40), fog(40)]), game: { ...game, start }, cards: true }).state).not.toBe('winning');
  });

  it('bounds the turns it was not observed by base income plus every bonus, not by the newest cap (a bonus now mine could have paid it before)', () => {
    // Bonus X {6, 7, 8} worth 10: I hold 6 now, so its newest could-earn cap is 5, but it could have
    // held X on every turn before the boards I have.
    const gx = buildGraph({ ...line(8), bonuses: [{ id: 100, name: 'X', value: 10, territoryIds: [6, 7, 8], bonusIds: [] }] });
    const b = (a: number) => board([mine(1, a), mine(2, a), mine(3, a), neutral(4, 2), neutral(5, 2), mine(6, 3), foe(7, 2), fogged(8)]);
    const start = { territories: 2, armiesPerTerritory: 5 };
    const o = gameOutlook({ graph: gx, me: ME, boards: turns(8, [b(60), b(60), b(60)]), game: { ...game, start } });
    // Turns 1–7 at most 5 + 10 = 15 each, turns 8–10 (#205: on my boards X is broken) at most 5:
    // 10 + 7 × 15 + 3 × 5 = 130, plus 3 × 5 = 145.
    expect(o.turns.at(-1)!.strongest).toMatchObject({ playerId: FOE, low: 2 + 3 * 5, high: 145 });
    expect(o.turns.map((t) => t.state)).not.toContain('winning');
    expect(o.state).not.toBe('winning');
  });

  it('under BonusArmyPer, bounds every turn by the per-territory income of the whole map (a fogged territory can raise it)', () => {
    // 41 territories in a line; me on 1–10 (60 each), the foe on 11–40 (1 each, 30 territories:
    // 15 a turn at 1 per 2), 41 fogged. Base 5, 1 army per 2 territories, start 3 × 5.
    const gl = buildGraph(line(41));
    const b = board([
      ...Array.from({ length: 10 }, (_, i) => mine(i + 1, 60)),
      ...Array.from({ length: 30 }, (_, i) => foe(i + 11, 1)),
      fogged(41),
    ]);
    const start = { territories: 3, armiesPerTerritory: 5 };
    const o = gameOutlook({
      graph: gl,
      me: ME,
      boards: turns(10, [b, b, b]),
      settings: { baseIncome: 5, bonusArmyPer: 2 },
      game: { ...game, start },
    });
    const s = o.turns.at(-1)!.strongest!;
    // It could really hold 15 + 12 × 15 + 3 × 15 = 240; the bound charges the whole map's
    // territory income, max(5, floor(41 / 2)) = 20, on every turn before my boards, and (#205) on
    // turns 10–12 the 31 territories I do not see someone else hold, floor(31 / 2) = 15:
    // 15 + 9 × 20 + 3 × 15 + 3 × 15 = 285.
    expect(s.high).toBeGreaterThanOrEqual(240);
    expect(s).toMatchObject({ playerId: FOE, high: 285 });
    // Turn 10's bound (15 + 9 × 20 + 15 + 3 × 15 = 255) is under my 615 ÷ 2.4, and it really could
    // hold no more than 210 then: winning that turn is sound. By turn 12 the bound no longer is, and
    // (#436) the incomes read behind: its 15 + 5 in view against my 5 + 5.
    // #454: the state stays even; the income reading is the lean beside it.
    expect(o.turns.map((t) => t.state)).toEqual(['winning', 'even', 'even']);
    expect(o.turns.map((t) => t.lean)).toEqual([undefined, 'behind', 'behind']);
    expect(o.state).toBeNull();
    expect(o.heldTurns).toBe(2);
    expect(o.basis).toMatch(/Behind for 2 of the 3 turns \(winning, behind, behind\), so no state yet/);
  });

  it('a bounded opponent with no strength at all is dominated: winning', () => {
    const empty = board([mine(1, 5), mine(2, 5), mine(3, 5), neutral(4, 2), neutral(5, 2), neutral(6, 2), neutral(7, 2), neutral(8, 2)]);
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [empty, empty, empty]), game, settings: { baseIncome: 0 } });
    expect(o.turns.at(-1)!.strongest).toMatchObject({ playerId: FOE, low: 0, high: 0 });
    expect(o.state).toBe('winning');
  });

  it('says the comparison is per player, not by team', () => {
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [apart(20, 5), apart(20, 5), apart(20, 5)]), game });
    expect(o.basis).toMatch(/per player/i);
    expect(o.basis).not.toMatch(/transfer/i);
  });

  it('in a team game, sums by team, so a teammate\'s transfers stay inside its team\'s high (PLAN-TEAMS C3)', () => {
    const players = [{ id: ME, team: 1 }, { id: FOE, team: 2 }, { id: 30, team: 2 }];
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [apart(20, 5), apart(20, 5), apart(20, 5)]), game: { players } });
    expect(o.basis).toMatch(/summed, a teammate's transfers stay inside its team's high/i);
    expect(o.basis).toMatch(/at 2\.4× the strongest enemy team or more/);
    expect(o.basis).not.toMatch(/not a ceiling/i);
  });

  it('counts an opponent still playing with nothing in view as unbounded without its start, and (#205) bounds it by what it received with one', () => {
    const hidden = board([mine(1, 30), mine(2, 30), mine(3, 30), neutral(4, 2), fogged(5), fogged(6), fogged(7), fogged(8)]);
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [hidden, hidden, hidden]), game });
    expect(o.turns.at(-1)!.strongest).toMatchObject({ playerId: FOE, low: 3 * 5, high: null });
    expect(o.turns.at(-1)!.ratio.low).toBe(0);
    expect(o.state).toBe('even');
    // Started with 2 × 5: by turn 6 at most 10 + 6 × 5 = 40, plus 3 × 5 = 55.
    const known = gameOutlook({ graph: g, me: ME, boards: turns(4, [hidden, hidden, hidden]), game: { ...game, start: { territories: 2, armiesPerTerritory: 5 } } });
    expect(known.turns.at(-1)!.strongest).toMatchObject({ playerId: FOE, low: 3 * 5, high: 55 });
  });

  describe('#205: a fogged opponent bounded by what it can have received', () => {
    const OTHER = 30;
    const ffa = { players: [{ id: ME }, { id: FOE }, { id: OTHER }] };
    // A 4-player-style fogged FFA on the line: me on 1–3, each opponent with one territory in view.
    const fog = (a: number) => board([mine(1, a), mine(2, a), mine(3, a), neutral(4, 2), fogged(5), foe(6, 2), fogged(7), foe(8, 3, OTHER)]);

    it('the starts unknown under an even split: at most ⌈territories ÷ players⌉ × armies each, so a fogged FFA can read winning', () => {
      const game = { ...ffa, startUnknown: 'full distribution', startArmiesPerTerritory: 5 };
      const o = gameOutlook({ graph: g, me: ME, boards: turns(2, [fog(40), fog(40), fog(40)]), game });
      // Started with at most ⌈8 ÷ 3⌉ = 3 territories × 5 = 15; by turn 4 at most 15 + 4 × 5 = 35
      // received, plus 3 × 5: 50 against my 120 + 15 = 135, 2.7×.
      const last = o.turns.at(-1)!;
      expect(last.strongest).toMatchObject({ high: 50 });
      expect(last.ratio.low).toBeGreaterThanOrEqual(OUTLOOK_RATIO);
      expect(o.state).toBe('winning');
      // A scenario's starts stay unknown: unbounded, never winning.
      const scenario = gameOutlook({ graph: g, me: ME, boards: turns(2, [fog(40), fog(40), fog(40)]), game: { ...ffa, startUnknown: 'scenario' } });
      expect(scenario.turns.at(-1)!.strongest!.high).toBeNull();
      expect(scenario.state).not.toBe('winning');
    });

    it('a player who never took a seat (Invited, Declined, RemovedByHost) does not shrink the even share', () => {
      const game = { ...ffa, startUnknown: 'full distribution', startArmiesPerTerritory: 5 };
      const unseated = [
        { id: 41, state: 'Declined' },
        { id: 42, state: 'RemovedByHost' },
        { id: 43, state: 'Invited' },
      ];
      const listed = { ...game, players: [...ffa.players, ...unseated] };
      const o = gameOutlook({ graph: g, me: ME, boards: turns(2, [fog(40), fog(40), fog(40)]), game: listed });
      // Still ⌈8 ÷ 3⌉ = 3 territories × 5, not ⌈8 ÷ 6⌉ = 2 × 5: high 50, as with the seated three alone.
      expect(o.turns.at(-1)!.strongest).toMatchObject({ high: 50 });
    });

    it('cards on: a fixed Reinforcement card adds at most what the card clock lets it hold', () => {
      const start = { territories: 2, armiesPerTerritory: 5 };
      const cardArmies = { armiesPerCard: 5, pieces: 4, initialPieces: 0, piecesPerTurn: 1 };
      const o = gameOutlook({ graph: g, me: ME, boards: turns(2, [fog(40), fog(40), fog(40)]), game: { ...ffa, start }, cards: true, cardArmies });
      // Turn 4: 10 + 4 × 5 = 30 received and no card yet (3 pieces); the next 3 turns at most 3 × 5
      // and one card (6 pieces by turn 7): 30 + 15 + 5 = 50.
      expect(o.turns.at(-1)!.strongest).toMatchObject({ high: 50 });
      expect(o.state).toBe('winning');
      // Cards on without that bound (a Gift card, a progressive Reinforcement card): unbounded.
      const loose = gameOutlook({ graph: g, me: ME, boards: turns(2, [fog(40), fog(40), fog(40)]), game: { ...ffa, start }, cards: true });
      expect(loose.turns.at(-1)!.strongest!.high).toBeNull();
    });

    it('a turn with a board earns at most the base plus the bonuses nobody else visibly holds that turn', () => {
      // Bonus X {6, 7, 8} worth 10, broken by me on every board I have (turns 1–3).
      const gx = buildGraph({ ...line(8), bonuses: [{ id: 100, name: 'X', value: 10, territoryIds: [6, 7, 8], bonusIds: [] }] });
      const b = board([mine(1, 30), mine(2, 30), mine(3, 30), neutral(4, 2), neutral(5, 2), mine(6, 3), foe(7, 2), fogged(8)]);
      const start = { territories: 2, armiesPerTerritory: 5 };
      const o = gameOutlook({ graph: gx, me: ME, boards: turns(1, [b, b, b]), game: { ...game, start } });
      // 10 + 3 × 5 = 25, plus 3 × 5: 40 (not 10 + 3 × 15 + 3 × 15 = 100).
      expect(o.turns.at(-1)!.strongest).toMatchObject({ playerId: FOE, high: 40 });
    });
  });

  describe('#208: a likely high, an estimate that winning may use when the bound is too loose', () => {
    // The issue's shape: a 4-player FFA on turn 10, my boards from turn 8 only, me on 52 of 160
    // territories, each opponent with one territory in view and the rest of the map fogged.
    const O2 = 30;
    const O3 = 40;
    const ffa4 = { players: [{ id: ME }, { id: FOE }, { id: O2 }, { id: O3 }], start: { territories: 4, armiesPerTerritory: 5 } };
    const big = buildGraph({
      ...line(160),
      bonuses: Array.from({ length: 40 }, (_, i) => ({
        id: 1000 + i,
        name: `B${i}`,
        value: 5,
        territoryIds: [4 * i + 1, 4 * i + 2, 4 * i + 3, 4 * i + 4],
        bonusIds: [],
      })),
    });
    /** Me on 1–52 (168 armies, 13 bonuses: income 70, strength 378), the foe's stack on 54. */
    const shape = (foeArmies = 52, extra: TerritoryState[] = []) =>
      board([
        ...Array.from({ length: 52 }, (_, i) => mine(i + 1, i === 51 ? 15 : 3)),
        neutral(53, 2),
        foe(54, foeArmies),
        neutral(55, 2),
        foe(56, 3, O2),
        neutral(57, 2),
        foe(58, 3, O3),
        neutral(59, 2),
        neutral(60, 2),
        ...Array.from({ length: 100 }, (_, i) => fogged(61 + i)),
        ...extra,
      ]);

    it("the issue's shape reads winning on the likely high, labelled an estimate, while the bound stays loose", () => {
      // #214: an observed income needs a pair of boards, so the first of the three judged turns
      // needs the board before it (turn 7); on a first board every opponent rests on the prior.
      const o = gameOutlook({ graph: big, me: ME, boards: turns(7, [shape(), shape(), shape(), shape()]), game: ffa4 });
      expect(o.turns.map((t) => t.likely?.source)).toEqual(['tracked', 'tracked', 'tracked']);
      const first = gameOutlook({ graph: big, me: ME, boards: turns(8, [shape()]), game: ffa4 }).turns[0]!;
      expect(first.likely!.source).toBe('prior');
      expect(first.state).not.toBe('winning');
      const last = o.turns.at(-1)!;
      expect(last.mine).toBe(378);
      // The sound bound is unchanged: the whole map's income on turns 1–7, the fog's on 8–10.
      expect(last.strongest).toMatchObject({ playerId: FOE, low: 67 });
      expect(last.strongest!.high).toBeGreaterThan(2000);
      expect(last.ratio.low).toBeLessThan(1);
      // Likely: it earns at most twice its tracked income (5) each turn — 20 + 10 × 10 + 3 × 10.
      expect(last.likely).toEqual({ playerId: FOE, high: 150, ratio: 2.52, source: 'tracked' });
      expect(last.state).toBe('winning');
      expect(last.estimated).toBe(true);
      expect(o.state).toBe('winning');
      expect(o.basis).toMatch(/likely high/i);
      expect(o.basis).toMatch(/estimate, not a bound/i);
    });

    it('an opponent seen deploying a lot is likely strong: not winning', () => {
      // The foe's stack grows by 30 a turn in view: its tracked income is 30.
      const o = gameOutlook({ graph: big, me: ME, boards: turns(8, [shape(52), shape(82), shape(112)]), game: ffa4 });
      const last = o.turns.at(-1)!;
      expect(last.likely!.high).toBeGreaterThan(378 / OUTLOOK_RATIO);
      expect(last.state).not.toBe('winning');
      expect(last.estimated).toBeUndefined();
    });

    describe('#214: an opponent with nothing in view now, or no observed income, rests on a modest labelled prior', () => {
      const hide = (ids: number[]) => (b: ReturnType<typeof board>) =>
        board(b.territories.map((t) => (ids.includes(t.territoryId) ? fogged(t.territoryId) : t)));
      const withStack = (stack: number) =>
        board(shape().territories.map((t) => (t.territoryId === 52 ? mine(52, stack) : t)));
      /** The issue's shape: turn 11, mine 455 (my stack on 52 is 92), the third opponent never in view. */
      const issue = (stack = 92) => hide([58])(withStack(stack));

      it("the issue's shape: the hidden opponent's likely high is its even share of the map's income, not its loose high", () => {
        const o = gameOutlook({ graph: big, me: ME, boards: turns(9, [issue(), issue(), issue()]), game: ffa4 });
        const last = o.turns.at(-1)!;
        expect(last.turn).toBe(11);
        expect(last.mine).toBe(455);
        expect(last.strongest!.high).toBeGreaterThan(2000);
        // Prior: twice my income, at most an even share of the map's income — 160 ÷ 4 = 40 territories
        // at base 5, plus 200 ÷ 4 of the bonuses = 55 a turn. Before my first board (turn 9) my income
        // ramps from the opening's 5 to turn 9's 70 (5, 13, 21, 29, 38, 46, 54, 62), paced at 10, 26,
        // 42, then 55: 20 + 353 + 3 × 55 + 3 × 55 = 703.
        expect(last.likely).toEqual({ playerId: O3, high: 703, ratio: 0.65, source: 'prior', why: 'unseen' });
        expect(last.likely!.high).toBeLessThan(last.strongest!.high!);
        expect(last.state).not.toBe('winning');
        expect(last.estimated).toBeUndefined();
        // Said plainly: which opponent blocks an estimated win, and why.
        expect(o.basis).toMatch(/player 40 blocks a win on the estimate/i);
        expect(o.basis).toMatch(/no territory in view now/i);
        // #214: the even share is a ceiling now (it binds here: twice my income, 140, is more).
        expect(o.basis).toMatch(/at most an even share of the map.s income \(55\)/i);
      });

      it('one seen on an earlier board but not now also rests on the prior', () => {
        const o = gameOutlook({ graph: big, me: ME, boards: turns(9, [withStack(92), issue(), issue()]), game: ffa4 });
        expect(o.turns.at(-1)!.likely).toMatchObject({ playerId: O3, high: 703, source: 'prior' });
      });

      it('one in view now with no observed income (no turn pair shows it) rests on the prior, said so', () => {
        const late = hide([56]);
        const o = gameOutlook({ graph: big, me: ME, boards: turns(9, [late(withStack(92)), late(withStack(92)), withStack(92)]), game: ffa4 });
        const last = o.turns.at(-1)!;
        expect(last.likely).toMatchObject({ playerId: O2, high: 703, source: 'prior', why: 'unmeasured' });
        expect(o.basis).toMatch(/no observed income/i);
      });

      it('an unmeasured opponent is never more hopeful than the same opponent measured: twice its visible income at least', () => {
        // O2 visibly holds 61–120 (15 bonuses: visible income 80).
        const wide = board(shape().territories.map((t) => (t.territoryId >= 61 && t.territoryId <= 120 ? foe(t.territoryId, 3, O2) : t)));
        const lone = gameOutlook({ graph: big, me: ME, boards: turns(8, [wide]), game: ffa4 }).turns[0]!;
        const pair = gameOutlook({ graph: big, me: ME, boards: turns(7, [wide, wide]), game: ffa4 }).turns.at(-1)!;
        expect(lone.likely).toMatchObject({ playerId: O2, source: 'prior', why: 'unmeasured' });
        expect(pair.likely).toMatchObject({ playerId: O2, source: 'tracked' });
        expect(lone.likely!.high).toBeGreaterThanOrEqual(pair.likely!.high);
        expect(lone.likely!.high).toBeLessThanOrEqual(lone.strongest!.high!);
      });

      it('#436: a prior far below me is no lead claim while the evidence is thin, labelled a prior', () => {
        const o = gameOutlook({ graph: big, me: ME, boards: turns(9, [issue(2000), issue(2000), issue(2000)]), game: ffa4 });
        const last = o.turns.at(-1)!;
        expect(last.likely).toMatchObject({ playerId: O3, high: 703, source: 'prior' });
        expect(last.ratio.low).toBeLessThan(OUTLOOK_RATIO);
        expect(last.likely!.ratio).toBeGreaterThanOrEqual(OUTLOOK_RATIO);
        expect(last.evidence!.thin).toBe(true);
        expect(last.state).not.toBe('winning');
        expect(last.estimated).toBeUndefined();
        expect(last.income!.noLeadClaim).toBe(true);
        expect(o.basis).toMatch(/no lead is claimed/i);
        expect(o.basis).toMatch(/even share of the map's income/i);
      });

      it('#436: the plan reads no decided game on that thin-evidence lead: orders as with no outlook', () => {
        const boards = turns(9, [issue(2000), issue(2000), issue(2000)]);
        const o = gameOutlook({ graph: big, me: ME, boards, game: ffa4 });
        const last = o.turns.at(-1)!;
        const plan = (outlook?: Pick<GameOutlook, 'state' | 'turns'>) =>
          planTurn({
            graph: big,
            board: boards.at(-1)!.board,
            me: ME,
            income: last.income!.mine,
            settings: { offensiveKillRate: 60, defensiveKillRate: 70, oneArmyStandsGuard: true },
            game: { players: ffa4.players, turn: last.turn },
            options: { adapt: true, ...(outlook ? { outlook } : {}) },
          });
        const now = plan(o);
        expect(now.rationale.join('\n')).not.toMatch(/Outlook \(#201\)/);
        expect({ deploys: now.deploys, moves: now.moves }).toEqual({ deploys: plan().deploys, moves: plan().moves });
      });

      it('a measured opponent that drops out of view keeps its tracked pace: losing sight never reads more hopeful', () => {
        // The foe's stack grows by 50 a turn in view on turns 5–9 (tracked income 50), then on
        // turn 10 it is fogged. Its likely high must not fall to the even-share prior.
        const grow = (stack: number) => (i: number) => {
          const b = shape(52 + 50 * i);
          return stack === 92 ? b : board(b.territories.map((t) => (t.territoryId === 52 ? mine(52, stack) : t)));
        };
        for (const stack of [92, 1500, 2000]) {
          const at = grow(stack);
          const seen = [0, 1, 2, 3, 4, 5].map(at);
          const gone = [...seen.slice(0, 5), hide([54])(seen[5]!)];
          const inView = gameOutlook({ graph: big, me: ME, boards: turns(5, seen), game: ffa4 }).turns.at(-1)!;
          const fogged = gameOutlook({ graph: big, me: ME, boards: turns(5, gone), game: ffa4 }).turns.at(-1)!;
          expect(inView.likely).toMatchObject({ playerId: FOE, source: 'tracked' });
          expect(fogged.likely).toMatchObject({ playerId: FOE, source: 'prior', why: 'unseen' });
          expect(fogged.likely!.high).toBeGreaterThanOrEqual(inView.likely!.high);
          expect(fogged.likely!.high).toBeLessThanOrEqual(fogged.strongest!.high!);
          // In view it is no win at any of these stacks; out of view it must not become an estimated one.
          expect(inView.state).not.toBe('winning');
          expect(fogged.state).not.toBe('winning');
          expect(fogged.estimated).toBeUndefined();
        }
      });

      it('an opponent whose stack drops out of view keeps at least what it was last seen with: no estimated win from losing sight', () => {
        // The foe holds a 1500 stack on 54 on turns 5–9, more than its tracked pace could have paid;
        // my stack on 52 is 2500. In view on turn 10 that is no win; fogged on turn 10 it must not
        // become one either.
        const at = () => board(shape(1500).territories.map((t) => (t.territoryId === 52 ? mine(52, 2500) : t)));
        const seen = [0, 1, 2, 3, 4, 5].map(at);
        const gone = [...seen.slice(0, 5), hide([54])(seen[5]!)];
        const inView = gameOutlook({ graph: big, me: ME, boards: turns(5, seen), game: ffa4 }).turns.at(-1)!;
        const fogged = gameOutlook({ graph: big, me: ME, boards: turns(5, gone), game: ffa4 }).turns.at(-1)!;
        expect(inView.mine).toBe(2863);
        expect(inView.likely).toMatchObject({ playerId: FOE, source: 'tracked' });
        expect(inView.state).not.toBe('winning');
        expect(fogged.likely).toMatchObject({ playerId: FOE, source: 'prior', why: 'unseen' });
        expect(fogged.likely!.high).toBeGreaterThanOrEqual(1500);
        expect(fogged.likely!.high).toBeGreaterThanOrEqual(inView.likely!.high);
        expect(fogged.likely!.high).toBeLessThanOrEqual(fogged.strongest!.high!);
        expect(fogged.state).not.toBe('winning');
        expect(fogged.estimated).toBeUndefined();
      });

      describe('the prior is peer-paced: what I and the opponents I can measure earn, not the size of the map', () => {
        // A 1,200-territory map in 300 four-territory bonuses worth 4 (base 6): an even share of its
        // income is 6 + 1,200 ÷ 4 = 306 a turn, and an even share of its territories 300.
        const huge = (n: number) =>
          buildGraph({
            ...line(n),
            bonuses: Array.from({ length: n / 4 }, (_, i) => ({
              id: 10000 + i,
              name: `H${i}`,
              value: 4,
              territoryIds: [4 * i + 1, 4 * i + 2, 4 * i + 3, 4 * i + 4],
              bonusIds: [],
            })),
          });
        const settings = { baseIncome: 6 };
        /** Me on 1–76 (19 bonuses: income 82; 3 armies each and 600 on 76), the foe and O2 in view, O3 never. */
        const view = (n: number) =>
          board([
            ...Array.from({ length: 76 }, (_, i) => mine(i + 1, i === 75 ? 600 : 3)),
            neutral(77, 2),
            foe(78, 10),
            neutral(79, 2),
            foe(80, 10, O2),
            ...Array.from({ length: n - 80 }, (_, i) => fogged(81 + i)),
          ]);
        // The starts unknown (no TerritoryLimit): the bound starts it on an even share, 300 × 5.
        const full = { players: ffa4.players, startArmiesPerTerritory: 5 };

        it('a 1,200-territory map where my income is 82: paced at twice my income, ramped up to it from a symmetric opening, not from the map', () => {
          const o = gameOutlook({ graph: huge(1200), me: ME, boards: turns(9, [view(1200), view(1200), view(1200)]), settings, game: full });
          const last = o.turns.at(-1)!;
          expect(last.turn).toBe(11);
          expect(last.mine).toBe(825 + 3 * 82);
          // The even share would have been 300 × 5 + 11 × 306 + 3 × 306 = 5,784. Peer-paced, each turn
          // twice my income (under the even share's 306). My income before my first board (turn 9) is
          // unknown: it ramps from a symmetric opening's (the base, 6: three territories, war.app's
          // default limit, since the settings do not give it) to the 82 of turn 9 — 6, 16, 25, 35, 44,
          // 54, 63, 73 on turns 1–8, paced at 12, 32, 50, 70, 88, 108, 126, 146 (632). The start is that
          // opening, 3 × 5 = 15, never the territories I held on a later board: 15 + 632 + 3 × 164 +
          // 3 × 164 = 1,631. (The margin on my own history keeps it near twice my strength: whether that
          // is modest enough is the owner's call on LIKELY_INCOME_MARGIN.)
          expect(last.likely).toEqual({ playerId: O3, high: 1631, ratio: 0.66, source: 'prior', why: 'unseen' });
          expect(last.strongest!.high).toBeGreaterThan(5784);
          // It still blocks a win, and the basis names it.
          expect(last.state).not.toBe('winning');
          expect(o.basis).toMatch(/player 40 blocks a win on the estimate/i);
          expect(o.basis).toMatch(/twice the higher of my income/i);
          expect(o.basis).toMatch(/even share of the map's income \(306\)/i);
        });

        it('the turns before my first board ramp up to its income instead of being charged at it', () => {
          // With one board (turn 11) the ramp runs to turn 11's 82 over ten turns; with three it reaches
          // 82 on turn 9. Each is below charging all of turns 1–8 at 82 (2,676 before #214 review).
          const one = gameOutlook({ graph: huge(1200), me: ME, boards: turns(11, [view(1200)]), settings, game: full });
          const three = gameOutlook({ graph: huge(1200), me: ME, boards: turns(9, [view(1200), view(1200), view(1200)]), settings, game: full });
          expect(one.turns.at(-1)!.likely!.high).toBeLessThan(three.turns.at(-1)!.likely!.high);
          expect(three.turns.at(-1)!.likely!.high).toBeLessThan(2676);
        });

        it('does not grow with the map: the same boards on twice the map give the same prior', () => {
          const a = gameOutlook({ graph: huge(1200), me: ME, boards: turns(9, [view(1200), view(1200), view(1200)]), settings, game: full });
          const b = gameOutlook({ graph: huge(2400), me: ME, boards: turns(9, [view(2400), view(2400), view(2400)]), settings, game: full });
          expect(b.turns.at(-1)!.likely).toEqual(a.turns.at(-1)!.likely);
          expect(b.turns.at(-1)!.strongest!.high).toBeGreaterThan(a.turns.at(-1)!.strongest!.high!);
        });

        it('starts on my own opening board when I have one, never on the even share', () => {
          const opening = board([
            ...Array.from({ length: 4 }, (_, i) => mine(i + 1, 5)),
            ...Array.from({ length: 1196 }, (_, i) => fogged(5 + i)),
          ]);
          const o = gameOutlook({ graph: huge(1200), me: ME, boards: turns(1, [opening, opening, opening]), settings, game: full });
          // Turn 3: I started on 4 territories with 5 each (20) and earn 10 (base 6 + H0's 4), so the
          // pace is 20: 20 + 3 × 20 + 3 × 20 = 140 (the even share would start it on 300 × 5 = 1,500).
          expect(o.turns.at(-1)!.likely).toMatchObject({ playerId: FOE, high: 140, source: 'prior' });
        });

        it('paces at the most an opponent was tracked earning when that is more than mine', () => {
          // The peer pace itself: twice the higher of mine and the peers', the base at least, under the
          // ceiling, over the opponent's own evidence.
          expect(peerPace({ base: 6, mine: 82, peers: 0, ceiling: 306 })).toBe(164);
          expect(peerPace({ base: 6, mine: 82, peers: 100, ceiling: 306 })).toBe(200);
          expect(peerPace({ base: 6, mine: 82, peers: 100, ceiling: 55 })).toBe(55);
          expect(peerPace({ base: 6, mine: 82, peers: 100, ceiling: 55, floor: 90 })).toBe(90);
          expect(peerPace({ base: 6, mine: 0, peers: 0, ceiling: 306 })).toBe(6);
          // The foe's stack on 78 grows by 100 a turn: tracked at 100, it outranks the hidden one.
          const grow = (i: number) => board(view(1200).territories.map((t) => (t.territoryId === 78 ? foe(78, 10 + 100 * i) : t)));
          const o = gameOutlook({ graph: huge(1200), me: ME, boards: turns(8, [0, 1, 2, 3].map(grow)), settings, game: full });
          const last = o.turns.at(-1)!;
          // 15 + 11 × 200 + 3 × 200 = 2,815: it starts as a symmetric opening (3 × 5), not an even share.
          expect(last.likely).toEqual({ playerId: FOE, high: 2815, ratio: 0.38, source: 'tracked' });
          expect(last.state).not.toBe('winning');
        });

        it("a hidden opponent is paced by its peers only from the turn they were measured earning more than me", () => {
          // O3 was last seen on turn 8 with 2,000 armies on 81, then hidden. The foe's stack on 78 grows
          // by 100 only from turn 10 to 11, so the peers' 100 counts from turn 11 (the measured turn), and
          // turns 9 and 10 stay at twice my 82: 2,000 + 164 + 164 + 200, plus 3 × 200 = 3,128. (Peers
          // counted on every turn would give 3,200; none at all, 2,984.) The foe, tracked at 100, is
          // 15 + 11 × 200 + 3 × 200 = 2,815, so the hidden one is the top row.
          const at = (turn: number) =>
            board(
              view(1200).territories.map((t) =>
                t.territoryId === 78 && turn === 11 ? foe(78, 110) : t.territoryId === 81 && turn === 8 ? foe(81, 2000, O3) : t,
              ),
            );
          const o = gameOutlook({ graph: huge(1200), me: ME, boards: turns(8, [8, 9, 10, 11].map(at)), settings, game: full });
          const last = o.turns.at(-1)!;
          expect(last.likely).toEqual({ playerId: O3, high: 3128, ratio: 0.34, source: 'prior', why: 'unseen' });
        });

        it('under full distribution every likely high starts on the real even share, whatever I hold now', () => {
          // A 40-territory 1v1, full distribution at 5 armies a territory: each player started on 20
          // territories, 100 armies. My boards are turns 12–14 only. Losing territory since must not
          // make the opponent look weaker (it used to start on my territories on turn 12 × 5).
          const map40 = buildGraph(line(40));
          const fd = { players: [{ id: ME }, { id: FOE }], startArmiesPerTerritory: 5, fullDistribution: true as const };
          const shapeOf = (n: number, seen: boolean) =>
            board([
              ...Array.from({ length: n }, (_, i) => mine(i + 1, 5)),
              ...Array.from({ length: 19 - n }, (_, i) => neutral(n + 1 + i, 2)),
              seen ? foe(20, 10) : fogged(20),
              ...Array.from({ length: 20 }, (_, i) => fogged(21 + i)),
            ]);
          const likelyOf = (n: number, seen: boolean) =>
            gameOutlook({ graph: map40, me: ME, boards: turns(12, [0, 1, 2].map(() => shapeOf(n, seen))), settings: { baseIncome: 5 }, game: fd })
              .turns.at(-1)!.likely!;
          // No bonuses, so no one earns more than the base 5 a turn (the map's whole income): 100 + 14 × 5
          // + 3 × 5 = 185, with me on 2 territories or 6 (it read 2 × 5 + … = 95 with me on 2).
          expect(likelyOf(2, true)).toMatchObject({ playerId: FOE, high: 185, source: 'tracked' });
          expect(likelyOf(6, true)).toMatchObject({ playerId: FOE, high: 185, source: 'tracked' });
          // Unseen: the same start and pace.
          expect(likelyOf(2, false)).toMatchObject({ playerId: FOE, high: 185, source: 'prior', why: 'unseen' });
          expect(likelyOf(6, false)).toMatchObject({ playerId: FOE, high: 185, source: 'prior', why: 'unseen' });
        });

        it('a small map where the even share is below twice my income: the share binds (703)', () => {
          const o = gameOutlook({ graph: big, me: ME, boards: turns(9, [issue(), issue(), issue()]), game: ffa4 });
          expect(o.turns.at(-1)!.likely).toMatchObject({ playerId: O3, high: 703, source: 'prior', why: 'unseen' });
        });
      });

      it('tracked opponents are labelled tracked', () => {
        const o = gameOutlook({ graph: big, me: ME, boards: turns(8, [shape(), shape(), shape()]), game: ffa4 });
        expect(o.turns.at(-1)!.likely!.source).toBe('tracked');
      });
    });

    describe('#228: a likely ratio far below parity reads losing, on the estimate', () => {
      /** Me on 1–4 (one bonus, income 10, 5 armies each: strength 50); the foe's stack on 54 in view. */
      const small = (foeArmies: number) =>
        board(shape(foeArmies).territories.map((t) => (t.territoryId > 4 && t.territoryId <= 52 ? neutral(t.territoryId, 2) : t.territoryId <= 4 ? mine(t.territoryId, 5) : t)));

      it("the issue's shape: an opponent deploying 20 a turn against my 10 reads losing, labelled an estimate, not even", () => {
        // In view the foe's stack is the least it has (ratio.high above 1/2.4), so the bound alone says even.
        const o = gameOutlook({ graph: big, me: ME, boards: turns(7, [small(20), small(40), small(60), small(80)]), game: ffa4 });
        const last = o.turns.at(-1)!;
        expect(last.mine).toBe(50);
        expect(last.ratio.high!).toBeGreaterThan(1 / OUTLOOK_RATIO);
        expect(last.likely!.source).toBe('tracked');
        expect(last.likely!.ratio).toBeLessThanOrEqual(1 / (OUTLOOK_RATIO * LIKELY_INCOME_MARGIN));
        expect(last.state).toBe('losing');
        expect(last.estimated).toBe(true);
        expect(o.state).toBe('losing');
        expect(o.basis).toMatch(/losing rests on it/i);
      });

      it('a likely ratio as low beside a level income and a quiet front stays even, and says what losing on it needs', () => {
        // Both earn 10: the likely high counts every army the foe could have received at twice its
        // pace and none lost, so it reads 0.18× here though nothing says I am losing.
        const o = gameOutlook({ graph: big, me: ME, boards: turns(7, [small(5), small(15), small(25), small(35)]), game: ffa4 });
        const last = o.turns.at(-1)!;
        expect(last.likely!.ratio).toBeLessThanOrEqual(1 / (OUTLOOK_RATIO * LIKELY_INCOME_MARGIN));
        expect(last.state).toBe('even');
        expect(last.estimated).toBeUndefined();
        expect(last.lowLikely).toEqual({ myIncome: 10, mostTracked: 10, groundDown: false, losing: false });
        expect(o.basis).toMatch(/but that alone is no loss/);
        expect(o.basis).toMatch(/mine 10, the most tracked 10/);
      });

      describe('#522: the income corroboration reads a thin frontier read at its calibrated estimate', () => {
        // Past games read every coverage band at 0.3× the truth (enough samples to calibrate).
        const cal = Object.fromEntries(['none', 'under-25', '25-50', '50-75', '75-up'].map((b) => [b, { geoMean: 0.3, n: 20 }]));
        /** As `small`, with the neutrals beside the foe's stack fogged: a third of its frontier is read. */
        const thin = (foeArmies: number) =>
          board(small(foeArmies).territories.map((t) => (t.territoryId === 53 || t.territoryId === 55 ? fogged(t.territoryId) : t)));
        const quiet = turns(7, [thin(5), thin(15), thin(25), thin(35)]);

        it('a fogged leader tracked at my income but estimated well above it corroborates the loss', () => {
          const o = gameOutlook({ graph: big, me: ME, boards: quiet, game: ffa4, calibration: cal });
          const last = o.turns.at(-1)!;
          expect(last.evidence!.opponents.find((r) => r.playerId === FOE)).toMatchObject({ income: 10, thin: true });
          // Tracked 10 ÷ 0.3 = 33: my 10 is at most 0.8× of it.
          expect(last.lowLikely).toEqual({ myIncome: 10, mostTracked: 33, calibrated: true, groundDown: false, losing: true });
          expect(last.state).toBe('losing');
          expect(last.estimated).toBe(true);
          expect(o.basis).toMatch(/the most an opponent is estimated earning \(33, calibrated on past games' estimate ÷ truth: its frontier read is thin\)/);
          // The surrender line keeps #436's rule: calibration deepens a deficit the tracked figure shows, never creates one.
          expect(o.surrenderLine).toBeUndefined();
        });

        it('without a calibrated band the tracked figure stands, as before', () => {
          const o = gameOutlook({ graph: big, me: ME, boards: quiet, game: ffa4 });
          const last = o.turns.at(-1)!;
          expect(last.lowLikely).toEqual({ myIncome: 10, mostTracked: 10, groundDown: false, losing: false });
          expect(last.state).toBe('even');
        });

        it('a solid frontier read keeps the tracked figure, calibration or not', () => {
          const o = gameOutlook({ graph: big, me: ME, boards: turns(7, [small(5), small(15), small(25), small(35)]), game: ffa4, calibration: cal });
          const last = o.turns.at(-1)!;
          expect(last.evidence!.opponents.find((r) => r.playerId === FOE)).toMatchObject({ thin: false });
          expect(last.lowLikely).toEqual({ myIncome: 10, mostTracked: 10, groundDown: false, losing: false });
          expect(last.state).toBe('even');
          expect(o.basis).toMatch(/mine 10, the most tracked 10/);
        });
      });

      it('the same ratio beside a front that grinds me down reads losing (#218 item 2)', () => {
        // The foe's stack stands next to mine (#5 beside #4) and grows by its income, 10 a turn.
        const beside = (foeArmies: number) =>
          board(small(0).territories.map((t) => (t.territoryId === 5 ? foe(5, foeArmies) : t.territoryId === 54 ? neutral(54, 2) : t)));
        const o = gameOutlook({ graph: big, me: ME, boards: turns(7, [beside(30), beside(40), beside(50), beside(60)]), game: ffa4 });
        const last = o.turns.at(-1)!;
        expect(last.front!.outcome).toBe('ground-down');
        expect(last.lowLikely).toMatchObject({ groundDown: true, losing: true });
        expect(last.state).toBe('losing');
        expect(last.estimated).toBe(true);
        expect(o.basis).toMatch(/Losing on the estimate: .*corroborated by the main front grinding me down/);
      });

      describe("the planner's read and the reported one agree when the plan's front incomes differ (#228 review)", () => {
        const beside = (foeArmies: number) =>
          board(small(0).territories.map((t) => (t.territoryId === 5 ? foe(5, foeArmies) : t.territoryId === 54 ? neutral(54, 2) : t)));
        /** The first call is what the planner reads; the second, fed the plan's front, is reported and logged. */
        const withPlanFront = (boards: TurnBoard[], myIncome: number, theirIncome: number) => {
          const first = gameOutlook({ graph: big, me: ME, boards, game: ffa4 });
          const f = first.turns.at(-1)!.front!;
          const second = gameOutlook({
            graph: big,
            me: ME,
            boards,
            game: ffa4,
            front: { turn: boards.at(-1)!.turn, from: f.from, at: f.at, myIncome, theirIncome },
          });
          return { first: first.turns.at(-1)!, second: second.turns.at(-1)!, firstState: first.state, secondState: second.state, basis: second.basis };
        };

        it("a front ground down on my boards' incomes but breaking on the plan's stays losing in both", () => {
          const r = withPlanFront(turns(7, [beside(30), beside(40), beside(50), beside(60)]), 60, 1);
          expect(r.first.state).toBe('losing');
          expect(r.second.front!.incomeSource).toBe('plan');
          expect(r.second.front!.outcome).not.toBe('ground-down');
          expect(r.second.state).toBe('losing');
          expect(r.second.estimated).toBe(true);
          expect(r.secondState).toBe(r.firstState);
          expect(r.basis).toMatch(/on the incomes read off my boards/);
        });

        it("a front quiet on my boards' incomes that the plan's grind down stays even in both", () => {
          // A small foe stack beside mine, its big one away from me: on my boards' incomes nothing grinds
          // me down; the plan prices the foe at 60 a turn against my 1.
          const quiet = (foeArmies: number) => board(small(foeArmies).territories.map((t) => (t.territoryId === 5 ? foe(5, 3) : t)));
          const r = withPlanFront(turns(7, [quiet(5), quiet(15), quiet(25), quiet(35)]), 1, 60);
          expect(r.first.lowLikely).toMatchObject({ groundDown: false, losing: false });
          expect(r.first.state).not.toBe('losing');
          expect(r.second.front!.outcome).toBe('ground-down');
          // The planner reads only winning and losing (stalemate may follow the reported front, as before).
          expect(r.second.state).not.toBe('losing');
          expect(r.second.lowLikely).toMatchObject({ groundDown: false, losing: false });
          expect(r.secondState === 'losing').toBe(r.firstState === 'losing');
        });
      });

      it("explains an even outlook beside the profile's standing when they differ", () => {
        const o = gameOutlook({
          graph: big,
          me: ME,
          boards: turns(7, [small(5), small(15), small(25), small(35)]),
          game: ffa4,
          standing: 'behind',
        });
        expect(o.state).toBe('even');
        expect(o.basis).toMatch(/standing reads behind/i);
        expect(o.basis).toMatch(/neither the winning nor the losing threshold/i);
        const same = gameOutlook({ graph: big, me: ME, boards: turns(7, [small(5), small(15), small(25), small(35)]), game: ffa4, standing: 'even' });
        expect(same.basis).not.toMatch(/standing reads/i);
      });
    });

    it('never estimates an unbounded opponent', () => {
      const o = gameOutlook({ graph: big, me: ME, boards: turns(8, [shape(), shape(), shape()]), game: { players: ffa4.players } });
      expect(o.turns.at(-1)!.strongest!.high).toBeNull();
      expect(o.turns.at(-1)!.likely).toBeUndefined();
      expect(o.state).not.toBe('winning');
    });

    it('a game in full view needs no estimate', () => {
      const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [apart(20, 5), apart(20, 5), apart(20, 5)]), game });
      expect(o.turns.at(-1)!.likely).toBeUndefined();
      expect(o.turns.at(-1)!.estimated).toBeUndefined();
      expect(o.basis).not.toMatch(/likely high/i);
    });
  });

  it('leaves out teammates and players no longer playing, and is deterministic', () => {
    const three = (a: number) =>
      board([mine(1, a), mine(2, a), mine(3, a), foe(4, 1, 30), neutral(5, 2), foe(6, 5), foe(7, 5), foe(8, 5)]);
    const players = [{ id: ME, team: 1 }, { id: 30, team: 1 }, { id: FOE, team: 2 }];
    const input = { graph: g, me: ME, boards: turns(4, [three(20), three(20), three(20)]), game: { players } };
    const a = gameOutlook(input);
    expect(a.turns.at(-1)!.strongest!.playerId).toBe(FOE);
    expect(gameOutlook(input)).toEqual(a);
  });
});

describe('gameOutlook: team strength is summed (PLAN-TEAMS C3)', () => {
  const MATE = 11;
  const players = [
    { id: ME, team: 1 },
    { id: MATE, team: 1 },
    { id: FOE, team: 2 },
    { id: 21, team: 2 },
  ];
  /** Me on 1–2 (`a` each), my teammate on 3 (`m`), neutrals 4–5, player 20 on 6–7 (`b` each), player 21 on 8 (`c`). */
  const teams = (a: number, m: number, b: number, c: number) =>
    board([mine(1, a), mine(2, a), foe(3, m, MATE), neutral(4, 2), neutral(5, 2), foe(6, b), foe(7, b), foe(8, c, 21)]);

  it("adds my teammate's strength to mine", () => {
    // Me 2 × 20 + 15 = 55, my teammate 40 + 15 = 55: 110 against team 2's (10 + 15) + (5 + 15) = 45, 2.44×.
    // Alone, 55 against player 20's 25 is 2.2×: even.
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [teams(20, 40, 5, 5), teams(20, 40, 5, 5), teams(20, 40, 5, 5)]), game: { players } });
    expect(o.state).toBe('winning');
    expect(o.turns.at(-1)).toMatchObject({ mine: 110, minePlayers: [ME, MATE], strongest: { playerId: FOE, team: 2, players: [FOE, 21], low: 45, high: 45 } });
    expect(o.basis).toMatch(/by team/i);
    expect(o.basis).toMatch(/the strongest enemy team, team 2 \(players 20, 21\)/);
    expect(o.basis).not.toMatch(/per player/i);
  });

  it("sums an enemy team's strength against mine", () => {
    // Me 2 × 25 + 15 = 65 and my teammate 5 + 15 = 20: 85 against team 2's 25 + 20 = 45, 1.89×: even.
    // Per player, 65 against 25 read 2.6×: winning.
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [teams(25, 5, 5, 5), teams(25, 5, 5, 5), teams(25, 5, 5, 5)]), game: { players } });
    expect(o.turns.at(-1)!.state).toBe('even');
    expect(o.turns.at(-1)!.ratio.low).toBeCloseTo(1.89);
  });

  it('a no-team game carries no team fields', () => {
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [apart(20, 5), apart(20, 5), apart(20, 5)]), game });
    expect(o.turns.at(-1)!.minePlayers).toBeUndefined();
    expect(o.turns.at(-1)!.strongest).toEqual({ playerId: FOE, low: 30, high: 30 });
  });

  it('#283: each turn carries the armies and income behind its strengths: mine and the strongest side in view', () => {
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [apart(20, 5), apart(20, 5), apart(20, 5)]), game });
    for (const t of o.turns) {
      expect(t.figures!.mine.armies + o.k * t.figures!.mine.income).toBe(t.mine);
      expect(t.figures!.strongest!.armies + o.k * t.figures!.strongest!.income).toBe(t.strongest!.low);
    }
    // By team, each side's summed: my team 20 + 20 + 40 armies on +5 and +5, team 2's 10 + 5 on +5 and +5.
    const team = gameOutlook({ graph: g, me: ME, boards: turns(4, [teams(20, 40, 5, 5), teams(20, 40, 5, 5), teams(20, 40, 5, 5)]), game: { players } });
    expect(team.turns.at(-1)!.figures).toEqual({ mine: { armies: 80, income: 10 }, strongest: { armies: 15, income: 10 } });
  });
});
