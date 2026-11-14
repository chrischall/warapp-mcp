// Multi-Attack chains (#180, #199): under Multi-Attack a stack's survivors carry on — after a
// capture they attack again from the territory taken, less the guard. This searches the chains
// out of one stack on the exact luck-free combat model, depth first in ascending neighbour ids,
// at most `maxSteps` attacks deep and `maxNodes` attacks tried. It reports every attack tried; the
// caller picks what matters (stress.ts the most damaging chain, the planner the armies a chain
// lands on each territory of mine). Pure and deterministic.

import { COMMANDER_STRENGTH, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE, straightKills } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';
import type { SimTerritory } from './turn-sim.js';

/** The most attacks one chain is searched to (#180). */
export const CHAIN_MAX_STEPS = 6;
/** The most attacks tried while searching one stack's chains (#180). */
export const CHAIN_MAX_NODES = 4000;

export interface KillRates {
  offensiveKillRate?: number;
  defensiveKillRate?: number;
}

/** Luck-free: `sent` armies (and a commander, when it goes along) take `t` as it stands. */
export function breaksLuckFree(sent: number, withCommander: boolean, t: SimTerritory | undefined, rates: KillRates = {}): boolean {
  if (!t || t.owner === 'unknown' || sent < 0) return false;
  const off = rates.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const def = rates.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const power = sent + (withCommander ? COMMANDER_STRENGTH : 0);
  const defPower = t.armies + (t.commander !== undefined ? COMMANDER_STRENGTH : 0);
  const kills = straightKills(power, off);
  const defenceGone = kills >= t.armies && (t.commander === undefined || kills - t.armies >= COMMANDER_STRENGTH);
  const losses = straightKills(defPower, def);
  const lives = sent - Math.min(sent, losses) > 0 || (withCommander && losses - sent < COMMANDER_STRENGTH);
  return defenceGone && lives;
}

/** One attack of a chain, as {@link searchChains} reports it. */
export interface ChainAttack {
  /** The stack, then every territory attacked in turn; the last is this attack's target. */
  path: readonly number[];
  /** The armies each attack on the path sent; the last is this one's. */
  sends: readonly number[];
  /** The armies this attack sends. */
  sending: number;
  /** Whether it takes the target (luck-free). */
  captured: boolean;
  /** The armies left after it (luck-free; on a failed attack, those still standing on the source). */
  survivors: number;
}

interface ChainSearch extends KillRates {
  graph: MapGraph;
  /** The board the chains run on. */
  territories: ReadonlyMap<number, SimTerritory>;
  /** The stack the chains start from. */
  from: number;
  /** The armies its first attack sends (the stack less the guard, a commander left behind). */
  sending: number;
  /** Armies that stay behind on each territory taken (1 with One Army Stands Guard, else 0). */
  guard: number;
  /** A territory the chain may attack. */
  hostile: (id: number, t: SimTerritory) => boolean;
  /** A territory taken that the survivors may go on from (default every one). */
  goOn?: (id: number) => boolean;
  maxSteps?: number;
  maxNodes?: number;
  /** Called for every attack tried, in search order (each with its own `path` and `sends`). */
  onAttack: (attack: ChainAttack) => void;
}

/** Search the chains out of one stack (see the header). */
export function searchChains(o: ChainSearch): void {
  if (o.sending <= 0) return;
  const def = o.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const maxSteps = o.maxSteps ?? CHAIN_MAX_STEPS;
  const maxNodes = o.maxNodes ?? CHAIN_MAX_NODES;
  let nodes = 0;
  const visit = (at: number, sending: number, path: number[], sends: number[]): void => {
    for (const n of neighborsOf(o.graph, at)) {
      if (nodes >= maxNodes) return;
      if (path.includes(n)) continue;
      const t = o.territories.get(n);
      if (!t || !o.hostile(n, t)) continue;
      nodes++;
      const captured = breaksLuckFree(sending, false, t, o);
      const defPower = t.armies + (t.commander !== undefined ? COMMANDER_STRENGTH : 0);
      const survivors = sending - Math.min(sending, straightKills(defPower, def));
      const p = [...path, n];
      const sd = [...sends, sending];
      o.onAttack({ path: p, sends: sd, sending, captured, survivors });
      if (!captured) continue;
      const next = survivors - o.guard;
      if (next > 0 && p.length <= maxSteps && (o.goOn?.(n) ?? true)) visit(n, next, p, sd);
    }
  };
  visit(o.from, o.sending, [o.from], []);
}
