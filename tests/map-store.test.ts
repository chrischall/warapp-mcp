import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MAX_GAME_INDEX,
  MAX_STORED_MAPS,
  mapStorePath,
  readGameMapId,
  readStoredMap,
  rememberGameMap,
  writeStoredMap,
} from '../src/map-store.js';
import type { GameMap } from '../src/normalize.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'warapp-mapstore-'));

function mapOf(id: number): GameMap {
  return {
    id,
    name: `Map ${id}`,
    territories: [
      { id: 1, name: 'A', coords: { x: 1, y: 2 }, connectedTo: [2] },
      { id: 2, name: 'B', connectedTo: [1] },
    ],
    bonuses: [{ id: 1, name: 'AB', value: 3, territoryIds: [1, 2], bonusIds: [] }],
    distributionModes: [{ id: -1, name: 'Full' }],
  };
}

describe('the persistent map store', () => {
  it('writes a map at <dir>/maps/<mapId>.json (0600, dir 0700) and reads it back equal', async () => {
    const dir = tmp();
    expect(await writeStoredMap(dir, mapOf(7))).toBe(true);
    const path = mapStorePath(dir, 7);
    expect(path).toBe(join(dir, 'maps', '7.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'maps')).mode & 0o777).toBe(0o700);
    expect(await readStoredMap(dir, 7)).toEqual(mapOf(7));
    expect(readdirSync(join(dir, 'maps')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('reads nothing for an absent map, a bad file or a file naming another map', async () => {
    const dir = tmp();
    expect(await readStoredMap(dir, 7)).toBeUndefined();
    mkdirSync(join(dir, 'maps'), { recursive: true });
    writeFileSync(mapStorePath(dir, 7), '{not json');
    expect(await readStoredMap(dir, 7)).toBeUndefined();
    writeFileSync(mapStorePath(dir, 7), JSON.stringify({ version: 1, map: mapOf(8) }));
    expect(await readStoredMap(dir, 7)).toBeUndefined();
    writeFileSync(mapStorePath(dir, 7), JSON.stringify({ version: 1, map: { ...mapOf(7), territories: [{ id: 'x' }] } }));
    expect(await readStoredMap(dir, 7)).toBeUndefined();
    writeFileSync(mapStorePath(dir, 7), JSON.stringify({ version: 1, map: { ...mapOf(7), bonuses: [{ id: 1 }] } }));
    expect(await readStoredMap(dir, 7)).toBeUndefined();
    writeFileSync(mapStorePath(dir, 7), JSON.stringify({ version: 2, map: mapOf(7) }));
    expect(await readStoredMap(dir, 7)).toBeUndefined();
    // A bad file is replaced by the next write.
    await writeStoredMap(dir, mapOf(7));
    expect(await readStoredMap(dir, 7)).toEqual(mapOf(7));
  });

  it('keeps optional fields only when well formed (unknown bonus members, distribution type)', async () => {
    const dir = tmp();
    const m = mapOf(9);
    m.bonuses[0]!.unknownIds = [99];
    m.distributionModes[0]!.type = 'x';
    await writeStoredMap(dir, m);
    expect(await readStoredMap(dir, 9)).toEqual(m);
  });

  it(`keeps at most ${MAX_STORED_MAPS} maps, evicting the least recently used`, async () => {
    const dir = tmp();
    for (let i = 1; i <= MAX_STORED_MAPS; i++) {
      await writeStoredMap(dir, mapOf(i));
      utimesSync(mapStorePath(dir, i), i, i);
    }
    // Reading map 1 makes it the most recently used: map 2 goes first.
    expect(await readStoredMap(dir, 1)).toBeDefined();
    await writeStoredMap(dir, mapOf(1000));
    expect(existsSync(mapStorePath(dir, 2))).toBe(false);
    expect(existsSync(mapStorePath(dir, 1))).toBe(true);
    expect(existsSync(mapStorePath(dir, 1000))).toBe(true);
    expect(readdirSync(join(dir, 'maps')).filter((f) => /^\d+\.json$/.test(f))).toHaveLength(MAX_STORED_MAPS);
  });

  it('never throws: an unwritable data dir gives false', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'maps'), 'a file where the folder should be');
    expect(await writeStoredMap(dir, mapOf(1))).toBe(false);
    expect(await rememberGameMap(dir, 5, 1)).toBe(false);
    expect(await readGameMapId(dir, 5)).toBeUndefined();
  });

  it('remembers which map a game is on, bounded, newest kept', async () => {
    const dir = tmp();
    expect(await readGameMapId(dir, 5)).toBeUndefined();
    expect(await rememberGameMap(dir, 5, 39905)).toBe(true);
    expect(await readGameMapId(dir, 5)).toBe(39905);
    expect(statSync(join(dir, 'maps', 'games.json')).mode & 0o777).toBe(0o600);
    for (let g = 100; g < 100 + MAX_GAME_INDEX; g++) await rememberGameMap(dir, g, 1);
    expect(await readGameMapId(dir, 5)).toBeUndefined();
    expect(await readGameMapId(dir, 100 + MAX_GAME_INDEX - 1)).toBe(1);
    const index = JSON.parse(readFileSync(join(dir, 'maps', 'games.json'), 'utf8')) as { games: unknown[] };
    expect(index.games).toHaveLength(MAX_GAME_INDEX);
  });

  it('reads the game index loosely (a bad file or entry is ignored)', async () => {
    const dir = tmp();
    mkdirSync(join(dir, 'maps'), { recursive: true });
    writeFileSync(join(dir, 'maps', 'games.json'), 'nope');
    expect(await readGameMapId(dir, 5)).toBeUndefined();
    writeFileSync(join(dir, 'maps', 'games.json'), JSON.stringify({ version: 1, games: [[5, 'x'], 'junk', [6, 2]] }));
    expect(await readGameMapId(dir, 5)).toBeUndefined();
    expect(await readGameMapId(dir, 6)).toBe(2);
    await rememberGameMap(dir, 7, 3);
    expect(await readGameMapId(dir, 6)).toBe(2);
    expect(await readGameMapId(dir, 7)).toBe(3);
  });
});
