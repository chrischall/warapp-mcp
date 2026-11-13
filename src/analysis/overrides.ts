// Overridden bonus values (GameFeed settings `OverriddenBonuses`, #62): a game can
// change any bonus's value, superbonuses included. Every tool that combines a game's
// map with its settings goes through applyBonusOverrides (via the tools' `mapOf`), so
// income, Local Deployment pools, bonus scoring, "protects +N", enemy-deploy
// estimates and picks all see the game's values. Pure.

import type { GameMap, GameSettings } from '../normalize.js';

/**
 * Whether the `OverriddenBonuses` JSON shape has been verified against a live game. It
 * has (#62, 2026-11-12: an array of `{ bonusID, value }`; a Local Deployment game paid
 * 2 + 12 + 7 = 21 exactly as modelled), so a game whose overrides read in full gets the
 * hard deploy-total and Local Deployment pre-checks. Overrides that did not read in full
 * keep both soft (warn, not refuse; war.app enforces both).
 */
export const OVERRIDES_VERIFIED = true;

/** The reason given when `OverriddenBonuses` was sent in a shape that could not be read. */
export const OVERRIDES_UNPARSED =
  "This game has overridden bonus values that could not all be read; the model uses the map's own values for those.";

const applied = new WeakMap<GameMap, Map<string, GameMap>>();

/**
 * The map with the game's bonus values. Returns `map` itself when nothing changes
 * (no overrides, unreadable overrides, or overrides equal to the map's values); else a
 * new map sharing the territories, with copied bonuses — the cached map is never
 * mutated. The same (map, overrides) pair returns the same object, so per-map caches
 * (the tools' graph cache) keep working. Overrides of bonuses not on the map are ignored.
 */
export function applyBonusOverrides(map: GameMap, settings: GameSettings | undefined): GameMap {
  const o = settings?.overriddenBonuses;
  if (!o || o.size === 0) return map;
  const changes = map.bonuses.filter((b) => o.has(b.id) && o.get(b.id) !== b.value);
  if (!changes.length) return map;
  const key = changes.map((b) => `${b.id}:${o.get(b.id)}`).join(',');
  let byKey = applied.get(map);
  if (!byKey) applied.set(map, (byKey = new Map()));
  let out = byKey.get(key);
  if (!out) {
    out = {
      ...map,
      bonuses: map.bonuses.map((b) => (o.has(b.id) && o.get(b.id) !== b.value ? { ...b, value: o.get(b.id)! } : b)),
    };
    byKey.set(key, out);
  }
  return out;
}

/**
 * Why the deploy-total and Local Deployment pre-checks must stay soft because of
 * overrides: the overrides could not be read, or (until {@link OVERRIDES_VERIFIED})
 * they were read from an unverified shape. Empty when the game overrides nothing.
 */
export function overrideUncertainties(settings: GameSettings | undefined, verified = OVERRIDES_VERIFIED): string[] {
  if (settings?.overriddenBonusesUnparsed) return [OVERRIDES_UNPARSED];
  const n = settings?.overriddenBonuses?.size ?? 0;
  if (n === 0 || verified) return [];
  return [
    `This game overrides ${n} bonus value${n === 1 ? '' : 's'}; the model applies them, but how GameFeed sends ` +
      'them is unverified, so check the deploy panel.',
  ];
}
