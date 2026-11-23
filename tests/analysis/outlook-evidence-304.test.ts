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

  it('in a large game compares only the opponents near my land and counts the rest (scale)', () => {
    // 20 opponents on a 24-territory line, me on 1–2: only the ones within two steps (on 3 and 4) are rows.
    const big = buildGraph(line(24));
    const ids = Array.from({ length: 20 }, (_, i) => 100 + i);
    const b = (a: number) => board([mine(1, a), mine(2, a), ...ids.map((p, i) => foe(3 + i, 3, p)), neutral(23, 2), neutral(24, 2)]);
    const players = { players: [{ id: ME }, ...ids.map((id) => ({ id }))] };
    const o = gameOutlook({ graph: big, me: ME, boards: turns(4, [b(10), b(11), b(12)]), game: players });
    const ev = o.turns.at(-1)!.evidence!;
    expect(ev.opponents.map((r) => r.playerId)).toEqual([100, 101]);
    expect(ev.far?.count).toBe(18);
    expect(o.basis).toMatch(/18 more opponents are not near your land/);
    // At or under the threshold nothing is left out, and no `far` is reported.
    const few = ids.slice(0, 16);
    const s = (a: number) => board([mine(1, a), mine(2, a), ...few.map((p, i) => foe(3 + i, 3, p)), neutral(19, 2)]);
    const small = gameOutlook({ graph: buildGraph(line(19)), me: ME, boards: turns(4, [s(10), s(11), s(12)]), game: { players: [{ id: ME }, ...few.map((id) => ({ id }))] } });
    expect(small.turns.at(-1)!.evidence!.opponents).toHaveLength(16);
    expect(small.turns.at(-1)!.evidence!.far).toBeUndefined();
  });

  it('in a large game the surrender line still judges the strongest opponent anywhere (owner decision 2026-11-23)', () => {
    // 20 opponents on a 60-territory line, me on 1–2; the last opponent, far away, holds 31–60 and a +50 bonus there.
    const n = 60;
    const ids = Array.from({ length: n }, (_, i) => i + 1);
    const map: GameMap = {
      ...line(n),
      bonuses: [{ id: 900, name: 'Far', value: 50, territoryIds: ids.filter((x) => x > 30), bonusIds: [] }],
    };
    const big = buildGraph(map);
    const foes = Array.from({ length: 20 }, (_, i) => 100 + i);
    const runaway = foes.at(-1)!;
    const b = () =>
      board([
        mine(1, 5),
        mine(2, 5),
        ...foes.slice(0, -1).map((p, i) => foe(3 + i, 3, p)),
        ...ids.filter((x) => x > 21 && x <= 30).map((x) => neutral(x, 2)),
        ...ids.filter((x) => x > 30).map((x) => foe(x, 3, runaway)),
      ]);
    const players = { players: [{ id: ME }, ...foes.map((id) => ({ id }))] };
    const o = gameOutlook({ graph: big, me: ME, boards: turns(4, [b(), b(), b()]), game: players });
    const last = o.turns.at(-1)!;
    // The outlook itself compares the nearby players only…
    expect(last.evidence!.opponents.map((r) => r.playerId)).toEqual([100, 101]);
    expect(last.income!.theirs.playerId).not.toBe(runaway);
    // …while the surrender line reads the runaway leader far away.
    expect(last.surrenderSide).toMatchObject({ playerId: runaway, near: false });
    expect(o.surrenderLine).toMatchObject({ playerId: runaway, crossed: true });
    expect(o.surrenderLine!.advice).toMatch(/strongest of every opponent, near or not — this one is not near your land/);
    expect(o.basis).toMatch(/surrender line still judges the strongest opponent anywhere/);
  });
});
