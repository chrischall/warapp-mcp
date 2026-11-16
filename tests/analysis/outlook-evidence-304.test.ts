import { describe, expect, it } from 'vitest';
import type { TerritoryState } from '../../src/board.js';
import { buildGraph } from '../../src/analysis/graph.js';
import { gameOutlook } from '../../src/analysis/outlook.js';
import { LOW_COVERAGE } from '../../src/analysis/plan/shared.js';
import type { TurnBoard } from '../../src/analysis/opponents.js';
import type { GameMap } from '../../src/normalize.js';
import { board, fogged, mine, neutral } from './helpers.js';

// #304: the outlook says beside its state which two incomes it compared and how much of each
// opponent's frontier was in view (#294's coverage), and flags thin evidence. Reporting only.

const ME = 10;
const FOE = 20;
const FOE2 = 30;

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
const start = { territories: 3, armiesPerTerritory: 5 };
const turns = (from: number, boards: ReturnType<typeof board>[]): TurnBoard[] => boards.map((b, i) => ({ turn: from + i, board: b }));

/** Every territory in view: me on 1–3, neutrals on 4–5, the foe on 6–8. */
const open = (a: number, b: number) =>
  board([mine(1, a), mine(2, a), mine(3, a), neutral(4, 2), neutral(5, 2), foe(6, b), foe(7, b), foe(8, b)]);
/** Only the foe's T6 in view, with fog on both sides of it: one of ~3 frontier territories read. */
const thin = (a: number, b: number) =>
  board([mine(1, a), mine(2, a), mine(3, a), neutral(4, 2), fogged(5), foe(6, b), fogged(7), fogged(8)]);

describe('outlook evidence (#304)', () => {
  it('names the two incomes compared and each opponent\'s frontier read; a board in full view is no thin evidence', () => {
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [open(10, 10), open(10, 11), open(10, 12)]), game });
    const ev = o.turns.at(-1)!.evidence!;
    expect(ev.incomes).toMatchObject({ mine: 5, theirs: 5, playerId: FOE });
    expect(ev.opponents).toEqual([expect.objectContaining({ playerId: FOE, coverage: 1 })]);
    expect(ev.thin).toBe(false);
    expect(o.evidence).toEqual(ev);
    expect(o.basis).toMatch(/Incomes compared: mine 5, player 20's 5/);
    expect(o.basis).not.toMatch(/thin evidence/i);
  });

  it('flags a state read from under LOW_COVERAGE of an opponent\'s frontier as thin, so "even" does not read as safe', () => {
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [thin(10, 10), thin(10, 12), thin(10, 14)]), game: { ...game, start } });
    const last = o.turns.at(-1)!;
    const ev = last.evidence!;
    const row = ev.opponents.find((r) => r.playerId === FOE)!;
    expect(row.coverage).not.toBeNull();
    expect(row.coverage!).toBeLessThan(LOW_COVERAGE);
    expect(ev.thin).toBe(true);
    expect(ev.incomes!.playerId).toBe(FOE);
    expect(o.basis).toMatch(/frontier territories \(33%\)/);
    expect(o.basis).toMatch(new RegExp(`Thin evidence: .*under ${Math.round(LOW_COVERAGE * 100)}%`));
    expect(o.basis).toMatch(new RegExp(`"${last.state}" is not a safe reading`));
  });

  it('an opponent never measured under fog has no coverage and is thin evidence too', () => {
    // One board only: no pair of boards measured anything.
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [thin(10, 10)]), game: { ...game, start } });
    const ev = o.turns.at(-1)!.evidence!;
    expect(ev.opponents).toEqual([expect.objectContaining({ playerId: FOE, coverage: null, source: 'visible' })]);
    expect(ev.thin).toBe(true);
    expect(o.basis).toMatch(/player 20 not measured/);
  });

  it('lists every opponent still playing, by id, and compares against the side the likely high rests on', () => {
    const three = (b: number, c: number) =>
      board([mine(1, 10), mine(2, 10), neutral(3, 2), foe(4, b), foe(5, b), neutral(6, 2), foe(7, c, FOE2), foe(8, c, FOE2)]);
    const players = { players: [{ id: ME }, { id: FOE }, { id: FOE2 }] };
    const o = gameOutlook({ graph: g, me: ME, boards: turns(4, [three(5, 30), three(6, 31), three(7, 32)]), game: players });
    const ev = o.turns.at(-1)!.evidence!;
    expect(ev.opponents.map((r) => r.playerId)).toEqual([FOE, FOE2]);
    expect(ev.incomes!.playerId).toBe(o.turns.at(-1)!.strongest!.playerId);
  });
});
