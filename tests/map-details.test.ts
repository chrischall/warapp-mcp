import { describe, expect, it } from 'vitest';
import { applyModeTerritories, MapDetailsFormatError, readMapDetailsModes } from '../src/map-details.js';
import type { GameMap } from '../src/normalize.js';
import { WarappBundle } from '../src/protocol/bundle.js';
import { Reader, Writer } from '../src/protocol/codec.js';
import { MAP_DETAILS_BUNDLE, writeMapDetailsResult, type SyntheticMode } from './protocol/map-details-bundle.js';

const bundle = new WarappBundle(`var W={};\n${MAP_DETAILS_BUNDLE}`, 'test');

function read(modes: Parameters<typeof writeMapDetailsResult>[1]) {
  const w = new Writer();
  writeMapDetailsResult(w, modes);
  const r = new Reader(w.bytes());
  const out = readMapDetailsModes(bundle, r);
  expect(r.remaining).toBe(0);
  return out;
}

describe('readMapDetailsModes (#328)', () => {
  it("reads each normal mode's territory ids by mode id", () => {
    const modes: SyntheticMode[] = [
      { kind: 'normal', id: 1, territories: [10, 11, 12] },
      { kind: 'normal', id: 2, territories: [] },
    ];
    expect(read(modes)).toEqual(
      new Map([
        [1, [10, 11, 12]],
        [2, []],
      ]),
    );
  });

  it("reads a scenario mode's territories from its territory → slot dict", () => {
    const out = read([{ kind: 'scenario', id: 3, slots: [[0, 'A']], territories: [[20, 0], [21, 0]] }]);
    expect(out).toEqual(new Map([[3, [20, 21]]]));
  });

  it('a mode with no territory list is unknown (null), never empty', () => {
    const out = read([
      { kind: 'normal', id: 1, territories: null },
      { kind: 'scenario', id: 2, territories: null },
      { key: 5, mode: null },
    ]);
    expect(out).toEqual(
      new Map<number, number[] | null>([
        [1, null],
        [2, null],
        [5, null],
      ]),
    );
  });

  it('an absent mode dict reads as no modes', () => {
    expect(read(null)).toEqual(new Map());
  });

  it('no result reads as null', () => {
    const r = new Reader(new Writer().bool(false).bytes());
    expect(readMapDetailsModes(bundle, r)).toBeNull();
  });

  it("refuses a mode whose own id disagrees with the dict's key", () => {
    expect(() => read([{ key: 9, mode: { kind: 'normal', id: 1, territories: [1] } }])).toThrow(MapDetailsFormatError);
  });
});

const MAP: GameMap = {
  id: 900001,
  name: 'Test map',
  territories: [1, 2, 3, 4].map((id) => ({ id, name: `T${id}`, connectedTo: [] })),
  bonuses: [],
  distributionModes: [
    { id: 1, name: 'Mode one' },
    { id: 2, name: 'Mode two', type: 'normal' },
    { id: 3, name: 'Mode three' },
  ],
};

describe('applyModeTerritories (#328)', () => {
  it('sets each listed mode, drops ids that are not territories of the map with a warning, and leaves a missing mode unknown', () => {
    const { map, warnings, found } = applyModeTerritories(
      MAP,
      new Map<number, number[] | null>([
        [1, [1, 2, 99]],
        [2, null],
        [7, [3]],
      ]),
    );
    expect(map.distributionModes).toEqual([
      { id: 1, name: 'Mode one', territories: [1, 2] },
      { id: 2, name: 'Mode two', type: 'normal', territories: null },
      { id: 3, name: 'Mode three', territories: null },
    ]);
    expect(found).toEqual(new Map([[1, [1, 2]]]));
    expect(warnings).toEqual([
      'Distribution mode 1: 1 territory id war.app listed is not a territory of map 900001 and was dropped (99).',
    ]);
    // The map given is not changed.
    expect(MAP.distributionModes[0]).toEqual({ id: 1, name: 'Mode one' });
  });

  it('dedupes ids and keeps their order', () => {
    const { map } = applyModeTerritories(MAP, new Map([[1, [3, 1, 3]]]));
    expect(map.distributionModes[0]!.territories).toEqual([3, 1]);
  });
});
