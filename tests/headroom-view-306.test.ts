// #306: the headroom table as the tools show it. The compact view ranks the borders that protect
// something (a held bonus, bonus income behind them, a breach's income) ahead of bare tiles, and each row
// is flagged against its opponent's own deploy estimate as well as my income. Synthetic map, made up.
import { describe, expect, it } from 'vitest';
import type { HeadroomRow } from '../src/analysis/headroom.js';
import type { GameMap } from '../src/normalize.js';
import { HEADROOM_COMPACT, headroomView } from '../src/tools/survival.js';

const ids = Array.from({ length: 30 }, (_, i) => i + 1);
const map: GameMap = {
  id: 1,
  name: 'Synthetic',
  territories: ids.map((id) => ({ id, name: `T${id}`, connectedTo: [] })),
  bonuses: [{ id: 900, name: 'Gate', value: 7, territoryIds: [21, 22], bonusIds: [] }],
  distributionModes: [],
};
const row = (territory: number, deploy: number | null, o: Partial<HeadroomRow> = {}): HeadroomRow => ({
  territory,
  armies: 1,
  opponent: territory % 2 ? 7 : 8,
  from: 30,
  deploy,
  bonuses: [],
  behind: [],
  behindIncome: 0,
  breach: { territories: [], income: 0 },
  ...o,
});
// Weakest first, as headroomTable sorts them: twelve bare 1-army tiles at 0, then the rows that matter.
const rows: HeadroomRow[] = [
  ...Array.from({ length: 12 }, (_, i) => row(i + 1, 0)),
  row(21, 16, { armies: 20, bonuses: [{ id: 900, value: 7 }] }),
  row(22, 31, { armies: 35, bonuses: [{ id: 900, value: 7 }] }),
  row(23, 40, { armies: 44, behindIncome: 5 }),
  row(24, 50, { armies: 54, breach: { territories: [25], income: 3 } }),
  row(26, 105, { armies: 110, bonuses: [{ id: 900, value: 7 }] }),
];

describe('headroomView (#306)', () => {
  it('compact lists the borders that protect something first, weakest first among them, then the bare tiles', () => {
    const v = headroomView(rows, map, 136, false);
    expect(v).toHaveLength(HEADROOM_COMPACT);
    expect(v.map((r) => r.territory.id)).toEqual([21, 22, 23, 24, 26, 1, 2, 3, 4, 5]);
  });

  it('full keeps every row in the table order', () => {
    const v = headroomView(rows, map, 136, true);
    expect(v.map((r) => r.territory.id)).toEqual(rows.map((r) => r.territory));
  });

  it("flags each row against its opponent's deploy estimate, which separates the rows my income flags all of", () => {
    const est = new Map([
      [7, 64],
      [8, 53],
    ]);
    const v = headroomView(rows, map, 136, true, false, (p) => est.get(p));
    const of = (id: number) => v.find((r) => r.territory.id === id)!;
    expect(v.every((r) => r.belowMyIncome)).toBe(true);
    expect(of(21)).toMatchObject({ opponentEstimate: 64, belowOpponentEstimate: true });
    expect(of(22)).toMatchObject({ opponentEstimate: 53, belowOpponentEstimate: true });
    expect(of(26)).toMatchObject({ opponentEstimate: 53, belowOpponentEstimate: false });
  });

  it('carries no estimate flag for an opponent with no estimate', () => {
    const v = headroomView(rows, map, 136, true, false, () => undefined);
    expect(v[0]).not.toHaveProperty('belowOpponentEstimate');
    expect(v[0]).not.toHaveProperty('opponentEstimate');
  });
});
