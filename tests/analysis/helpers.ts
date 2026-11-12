import { readFileSync } from 'node:fs';
import type { BoardState, TerritoryState } from '../../src/board.js';
import { normalizeMap, normalizeSettings, type GameMap, type GameSettings } from '../../src/normalize.js';

/** The anonymized lobby fixture's map (761 territories, 372 bonuses). */
export function fixtureMap(): GameMap {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/gamefeed-lobby-map39905.json', import.meta.url), 'utf8'),
  ) as { map: unknown };
  return normalizeMap(raw.map);
}

export function fixtureSettings(): GameSettings {
  const raw = JSON.parse(
    readFileSync(new URL('../fixtures/gamefeed-lobby-map39905.json', import.meta.url), 'utf8'),
  ) as { settings: unknown };
  return normalizeSettings(raw.settings);
}

/**
 * A small hand-built map:
 *
 *   1 ─ 2        bonus A (3):  1, 2, 3
 *    \ /         bonus B (2):  4, 5
 *     3 ─ 4 ─ 5 ─ 6 ─ 7      bonus C (0):  6
 *                            bonus S (4):  A + B (superbonus)
 *                            7 is in no bonus
 */
export function tinyMap(): GameMap {
  const edges: [number, number][] = [
    [1, 2],
    [2, 3],
    [1, 3],
    [3, 4],
    [4, 5],
    [5, 6],
    [6, 7],
  ];
  const ids = [1, 2, 3, 4, 5, 6, 7];
  return {
    id: 1,
    name: 'Tiny',
    territories: ids.map((id) => ({
      id,
      name: `T${id}`,
      // Deliberately one-sided adjacency for 6-7: the graph must symmetrize it.
      connectedTo: edges
        .filter(([a, b]) => a === id || (b === id && !(a === 6 && b === 7)))
        .map(([a, b]) => (a === id ? b : a)),
    })),
    bonuses: [
      { id: 101, name: 'A', value: 3, territoryIds: [1, 2, 3], bonusIds: [] },
      { id: 102, name: 'B', value: 2, territoryIds: [4, 5], bonusIds: [] },
      { id: 103, name: 'C', value: 0, territoryIds: [6], bonusIds: [] },
      { id: 104, name: 'S', value: 4, territoryIds: [], bonusIds: [101, 102] },
    ],
    distributionModes: [],
  };
}

export function board(entries: TerritoryState[], verified = false): BoardState {
  return { source: 'gamefeed', verified, territories: entries };
}

export const mine = (territoryId: number, armies: number, playerId = 10): TerritoryState => ({
  territoryId,
  owner: { kind: 'player', playerId },
  armies,
});
export const neutral = (territoryId: number, armies: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'neutral' },
  armies,
});
export const fogged = (territoryId: number): TerritoryState => ({
  territoryId,
  owner: { kind: 'unknown' },
  armies: null,
  fogLevel: 'Fogged',
});
