// A map's distribution modes with the territories each lets a player start on (#328), read lazily from war.app's
// map details (GetMapDetails, method 73, no auth) through the web-client channel and kept with the map
// (src/map-store.ts). Asked only when a caller needs a mode's territories and the map lacks them, at most once
// per map per process (a failure is never retried in a loop); a failure leaves them unknown (`null`), never `[]`.
// UNVERIFIED live beyond #328's trace (src/map-details.ts).

import { applyModeTerritories, readMapDetailsModes } from '../map-details.js';
import type { DistributionMode, GameMap, GameSettings } from '../normalize.js';
import { Method, writeGetMapDetailsParams } from '../protocol/methods.js';
import { failureText, type LiveContext } from './live-context.js';

/** What a caller needs to read map details: the GameFeed client (its map cache) and the web-client channel. */
export type MapDetailsContext = Pick<LiveContext, 'client' | 'rpc' | 'bundle'>;

/** {@link withModeTerritories}' answer. */
export interface MapWithModes {
  /** `map` with every mode's `territories` set: the ids, else `null` (unknown). */
  map: GameMap;
  /** Why some are unknown, or ids were dropped; empty when nothing needs saying. */
  warnings: string[];
}

const known = (d: DistributionMode): boolean => Array.isArray(d.territories);

/** `map` with every mode not known marked unknown (`null`). */
const unknownRest = (map: GameMap): GameMap => ({
  ...map,
  distributionModes: map.distributionModes.map((d) => (known(d) ? d : { ...d, territories: null })),
});

const UNKNOWN = (map: GameMap, why: string) =>
  `The starting territories of map ${map.id}'s distribution modes could not be read from war.app's map details (${why}); ` +
  'they stay unknown and are not asked again until the server restarts.';

/**
 * `map` (the game's, overrides applied or not) with its modes' territories: what the cached map already has,
 * else read from war.app's map details and kept (the cached base map and the store). Never throws.
 */
export async function withModeTerritories(ctx: MapDetailsContext, map: GameMap): Promise<MapWithModes> {
  if (map.distributionModes.every(known)) return { map, warnings: [] };
  if (ctx.client.mapDetailsTried(map.id)) {
    return { map: unknownRest(map), warnings: [UNKNOWN(map, 'an earlier read this session did not give them')] };
  }
  ctx.client.markMapDetailsTried(map.id);
  let byMode: Map<number, number[] | null> | null;
  try {
    const env = await ctx.rpc.call('GetMapDetails', Method.GetMapDetails, (w) => writeGetMapDetailsParams(w, map.id));
    byMode = readMapDetailsModes(await ctx.bundle(), env.body);
  } catch (e) {
    return { map: unknownRest(map), warnings: [UNKNOWN(map, failureText(e))] };
  }
  if (byMode === null) return { map: unknownRest(map), warnings: [UNKNOWN(map, 'the reply carried no result')] };
  const read = applyModeTerritories(map, byMode);
  if (read.found.size) await ctx.client.keepModeTerritories(map.id, read.found).catch(() => {});
  const missing = read.map.distributionModes.filter((d) => d.territories === null).map((d) => d.id);
  const warnings = [...read.warnings];
  if (missing.length) warnings.push(UNKNOWN(map, `none listed for mode${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`));
  return { map: read.map, warnings };
}

/** One mode as warapp_get_map's full view lists it: its territory count and ids, `null` both when unknown. */
export function modeRow(d: DistributionMode) {
  const ids = Array.isArray(d.territories) ? d.territories : null;
  return {
    id: d.id,
    name: d.name,
    ...(d.type !== undefined ? { type: d.type } : {}),
    territoryCount: ids ? ids.length : null,
    territories: ids,
  };
}

/**
 * The map distribution mode an automatically distributed game dealt its starts from (#328): its settings say
 * `AutomaticTerritoryDistribution` "Automatic" and name, as `DistributionMode`, a mode of the map. `undefined`
 * otherwise — manual picks (the live board's pickable territories say where then), full distribution (-1),
 * random or custom distributions (no map mode), or settings that do not say.
 */
export function dealtMode(settings: Pick<GameSettings, 'distributionMode' | 'raw'> | undefined, map: GameMap): DistributionMode | undefined {
  if (settings?.raw.AutomaticTerritoryDistribution !== 'Automatic' || settings.distributionMode === undefined) return undefined;
  return map.distributionModes.find((d) => d.id === settings.distributionMode);
}

/** {@link modeStarts}' answer: the mode's territories, else why they are unknown (one line per reason). */
export type ModeStarts = { mode: number; territories: number[] } | { mode: number; territories: null; warnings: string[] };

/**
 * The territories `mode` (a mode of `map`) dealt starts among: what the map already has, else read once from
 * war.app's map details ({@link withModeTerritories}). Unknown (`null`, with the reasons) when the read failed or
 * listed none for it. Never throws.
 */
export async function modeStarts(ctx: MapDetailsContext, map: GameMap, mode: number): Promise<ModeStarts> {
  const read = await withModeTerritories(ctx, map);
  const ids = read.map.distributionModes.find((d) => d.id === mode)?.territories;
  if (Array.isArray(ids) && ids.length) return { mode, territories: ids };
  return {
    mode,
    territories: null,
    warnings: [
      `The game dealt its starts automatically from the map's distribution mode ${mode}, whose territories are unknown, ` +
        'so they are not used as start candidates.',
      ...read.warnings,
    ],
  };
}
