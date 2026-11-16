// A map's distribution modes and the territories each lets a player start on (#328): the GetMapDetails
// reply (method 73, no auth, the int32 map id), decoded by the client bundle's own readers by stable type
// name, like GetMyGames — fields by read order, checked by type, never by their minified names
// (docs/WEB-PROTOCOL.md, "Map details: distribution modes"). GameFeed's map names its modes but not their
// territories; the client's map preview reads them from here.
//
// `MapDetails` reads its modes fourth, an int32-count dict of mode id → `DistributionMode`, which the
// bundle reads by a byte tag: a `NormalDistribution` (its territory ids, then the description, the id and
// the name) or a `ScenarioDistribution` (its slot names, its territory → slot dict, then the same three).
// UNVERIFIED live beyond what #328's trace shows (a normal mode's bytes, and its ids against GameFeed's map).

import { McpToolError } from '@chrischall/mcp-utils';
import type { ClassReader } from './live.js';
import type { GameMap } from './normalize.js';
import type { Reader } from './protocol/codec.js';
import { fields, isObj } from './protocol/decoded.js';

export const MAP_DETAILS = 'warlight.shared.MapDetails';
export const NORMAL_DISTRIBUTION = 'warlight.shared.NormalDistribution';
export const SCENARIO_DISTRIBUTION = 'warlight.shared.ScenarioDistribution';

/** MapDetails: the position of its mode dict in read order, and its whole field count. */
const MD = { modes: 3 } as const;
export const MAP_DETAILS_FIELDS = 14;
/** NormalDistribution: its territory list, then the base fields (description, id, name). */
const ND = { territories: 0, id: 2 } as const;
export const NORMAL_DISTRIBUTION_FIELDS = 4;
/** ScenarioDistribution: its slot names, its territory → slot dict, then the base fields. */
const SD = { territories: 1, id: 3 } as const;
export const SCENARIO_DISTRIBUTION_FIELDS = 5;

/** The GetMapDetails reply arrived in a shape this server does not understand. */
export class MapDetailsFormatError extends McpToolError {
  constructor(detail: string) {
    super(`war.app's map details arrived in an unexpected shape (${detail}).`, {
      kind: 'unknown',
      hint: "The war.app client may have changed; the distribution modes' territories stay unknown.",
    });
    this.name = 'MapDetailsFormatError';
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isIntList = (v: unknown): v is number[] => Array.isArray(v) && v.every(isInt);
/** A decoded dict: `[key, value]` pairs. */
const isPairs = (v: unknown): v is Array<[unknown, unknown]> =>
  Array.isArray(v) && v.every((e) => Array.isArray(e) && e.length === 2);

/** One mode's territory ids (`null`: the reply lists none), checked against the dict's key. */
function territoriesOf(key: number, mode: unknown): number[] | null {
  if (mode === null) return null;
  if (!isObj(mode)) throw new MapDetailsFormatError(`mode ${key} is not a record`);
  const f = fields(mode);
  let id: unknown;
  let ids: number[] | null;
  if (mode.$type === NORMAL_DISTRIBUTION) {
    if (f.length !== NORMAL_DISTRIBUTION_FIELDS) throw new MapDetailsFormatError(`a NormalDistribution has ${f.length} fields`);
    const list = f[ND.territories];
    if (list !== null && !isIntList(list)) throw new MapDetailsFormatError(`mode ${key}'s territories are not ids`);
    id = f[ND.id];
    ids = list;
  } else if (mode.$type === SCENARIO_DISTRIBUTION) {
    if (f.length !== SCENARIO_DISTRIBUTION_FIELDS) throw new MapDetailsFormatError(`a ScenarioDistribution has ${f.length} fields`);
    const dict = f[SD.territories];
    if (dict !== null && !(isPairs(dict) && dict.every(([t, s]) => isInt(t) && isInt(s)))) {
      throw new MapDetailsFormatError(`mode ${key}'s territories are not ids`);
    }
    id = f[SD.id];
    ids = dict === null ? null : dict.map(([t]) => t as number);
  } else {
    throw new MapDetailsFormatError(`mode ${key} is neither a normal nor a scenario distribution`);
  }
  if (id !== key) throw new MapDetailsFormatError(`mode ${key} names itself ${String(id)}`);
  return ids;
}

/**
 * Read a GetMapDetails result (the body positioned at the result-present flag): mode id → its territory
 * ids, `null` for a mode the reply lists none for. `null` when there is no result.
 */
export function readMapDetailsModes(bundle: ClassReader, body: Reader): Map<number, number[] | null> | null {
  if (!body.bool()) return null;
  const details = bundle.readClass(MAP_DETAILS, body);
  if (!isObj(details) || details.$type !== MAP_DETAILS) throw new MapDetailsFormatError('no MapDetails');
  const f = fields(details);
  if (f.length !== MAP_DETAILS_FIELDS) throw new MapDetailsFormatError(`a MapDetails has ${f.length} fields, not ${MAP_DETAILS_FIELDS}`);
  const modes = f[MD.modes];
  const out = new Map<number, number[] | null>();
  if (modes === null) return out;
  if (!isPairs(modes)) throw new MapDetailsFormatError('no mode list');
  for (const [key, mode] of modes) {
    if (!isInt(key)) throw new MapDetailsFormatError('a mode id is not an integer');
    out.set(key, territoriesOf(key, mode));
  }
  return out;
}

/** {@link applyModeTerritories}' answer. */
export interface ModeTerritories {
  /** `map` with every mode's `territories` set: the ids read, else `null` (unknown). */
  map: GameMap;
  /** The modes whose territories were read, by id (checked ids only): what may be kept. */
  found: Map<number, number[]>;
  /** One line per mode that listed ids the map lacks (they are dropped). */
  warnings: string[];
}

/**
 * Lay the territories read (`byMode`) on `map`'s modes, a copy: each mode's ids that are territories of the
 * map, in order, once each (an id the map lacks is dropped, with a warning); a mode the reply leaves out, or
 * lists none for, is `null` — unknown, never empty. A mode the reply has but the map does not is ignored.
 */
export function applyModeTerritories(map: GameMap, byMode: ReadonlyMap<number, number[] | null>): ModeTerritories {
  const land = new Set(map.territories.map((t) => t.id));
  const found = new Map<number, number[]>();
  const warnings: string[] = [];
  const distributionModes = map.distributionModes.map((d) => {
    const ids = byMode.get(d.id);
    if (!ids) return { ...d, territories: null };
    const kept = [...new Set(ids.filter((id) => land.has(id)))];
    const dropped = [...new Set(ids.filter((id) => !land.has(id)))];
    if (dropped.length) {
      const one = dropped.length === 1;
      warnings.push(
        `Distribution mode ${d.id}: ${dropped.length} territory id${one ? '' : 's'} war.app listed ${one ? 'is' : 'are'} not ` +
          `${one ? 'a territory' : 'territories'} of map ${map.id} and ${one ? 'was' : 'were'} dropped (${dropped.join(', ')}).`,
      );
    }
    found.set(d.id, kept);
    return { ...d, territories: kept };
  });
  return { map: { ...map, distributionModes }, found, warnings };
}
