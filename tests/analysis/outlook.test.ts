import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { gameOutlook, OUTLOOK_RATIO, OUTLOOK_TURNS } from '../../src/analysis/outlook.js';
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
    // Turns 1–8 at most 5 + 10 = 15 each, turns 9–10 (observed: X is broken) at most 5:
    // 10 + 8 × 15 + 2 × 5 = 140, plus 3 × 5 = 155.
    expect(o.turns.at(-1)!.strongest).toMatchObject({ playerId: FOE, low: 2 + 3 * 5, high: 155 });
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
    // territory income, max(5, floor(41 / 2)) = 20, on every turn: 15 + 12 × 20 + 3 × 20 = 315.
    expect(s.high).toBeGreaterThanOrEqual(240);
    expect(s).toMatchObject({ playerId: FOE, high: 315 });
    expect(o.turns.map((t) => t.state)).not.toContain('winning');
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

  it('in a team game, says a teammate\'s transfers can take an opponent past its high', () => {
    const players = [{ id: ME, team: 1 }, { id: FOE, team: 2 }, { id: 30, team: 2 }];
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [apart(20, 5), apart(20, 5), apart(20, 5)]), game: { players } });
    expect(o.basis).toMatch(/teammate can transfer armies.*not a ceiling/i);
  });

  it('counts an opponent still playing with nothing in view as unbounded', () => {
    const hidden = board([mine(1, 30), mine(2, 30), mine(3, 30), neutral(4, 2), fogged(5), fogged(6), fogged(7), fogged(8)]);
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [hidden, hidden, hidden]), game });
    expect(o.turns.at(-1)!.strongest).toMatchObject({ playerId: FOE, low: 3 * 5, high: null });
    expect(o.turns.at(-1)!.ratio.low).toBe(0);
    expect(o.state).toBe('even');
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
