// Part 5 of the mega-game spec: my commander against opponents the fog hides. Pure and deterministic.
//
// In a big free-for-all under fog the players beside my commander are mostly unknown, and two of them
// striking it in the same turn is likely. Every fogged territory within two moves of the commander's
// territory may hide one: beside it, it strikes this turn; one step beyond a territory not mine whose
// armies show, it takes that territory this turn and strikes next turn (my next deploy and its next
// deploy cancel out, so it is sized as one turn's: what taking the territory in between costs it comes
// off). Each is assumed a player as strong as the caller says — `stack` armies plus a whole `deploy` —
// and the `count` strongest strike in turn: every one but the last softens (its luck-free kills come off),
// and the last must not take what is left.

import { COMMANDER_STRENGTH, guaranteedKills, straightKills } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';

/** How many fogged neighbours strike my commander together by default in a big free-for-all. */
export const DEFAULT_FOGGED_ATTACKERS = 2;
/** Players (me included) from which a game without teams is a big free-for-all for {@link defaultFoggedAttackers}. */
export const FOG_FFA_MIN_PLAYERS = 8;
/** The sentinel player of a border sized for the fog's attackers (no player id is negative). */
export const FOG_PLAYER = -1;

/** The fog's attackers the plan holds my commander against: how many strike together, and each one's strength. */
export interface FoggedAttackers {
  count: number;
  /** The armies each hidden player's stack is taken to hold (the caller's assumption). */
  stack: number;
}

/** One fogged territory that may hide an opponent able to strike my commander's territory. */
export interface FogAttack {
  /** The fogged territory. */
  territory: number;
  /** The territory not mine it takes first (two moves away); absent beside it. */
  via?: number;
  /** The armies that strike: its stack and deploy, less what taking `via` costs it. */
  armies: number;
}

/** What the caller knows of a territory: mine, hidden by the fog, or its armies when they show. */
export interface FogView {
  mine: (t: number) => boolean;
  /** Hidden from me (owner unknown, or an opponent's armies the fog hides), and not a teammate's. */
  fogged: (t: number) => boolean;
  /** The armies on a territory whose armies show (null otherwise). */
  armies: (t: number) => number | null;
}

/**
 * Every fogged territory that may strike my `t` (see the header), the strongest first (then by id); each
 * once, at its strongest. `gone` territories (taken this turn) neither hide one nor are passed through.
 */
export function foggedAttacks(
  g: MapGraph,
  view: FogView,
  t: number,
  strength: { stack: number; deploy: number; defensiveKillRate: number },
  gone: (n: number) => boolean = () => false,
): FogAttack[] {
  const full = Math.max(0, strength.stack) + Math.max(0, strength.deploy);
  const best = new Map<number, FogAttack>();
  const offer = (a: FogAttack) => {
    const was = best.get(a.territory);
    if (a.armies > 0 && (!was || a.armies > was.armies)) best.set(a.territory, a);
  };
  for (const n of neighborsOf(g, t)) {
    if (gone(n) || view.mine(n)) continue;
    if (view.fogged(n)) {
      offer({ territory: n, armies: full });
      continue;
    }
    const there = view.armies(n);
    if (there === null) continue;
    // Taking `n` first: its defenders kill this many of the attackers (luck-free).
    const cost = straightKills(there, strength.defensiveKillRate);
    for (const m of neighborsOf(g, n)) {
      if (m === t || gone(m) || view.mine(m) || !view.fogged(m)) continue;
      offer({ territory: m, via: n, armies: full - cost });
    }
  }
  return [...best.values()].sort((a, b) => b.armies - a.armies || a.territory - b.territory);
}

/**
 * The `count` strongest of `attacks` striking in turn: the most defenders they take together
 * (`takesAlone` of the last plus `killsOf` every softener), the last tried as each of them. 0 with none.
 */
export function foggedTakes(
  attacks: readonly number[],
  count: number,
  killsOf: (n: number) => number,
  takesAlone: (n: number) => number,
): number {
  const used = [...attacks].sort((a, b) => b - a).slice(0, Math.max(0, count));
  let takes = 0;
  for (const [i, last] of used.entries()) {
    const soft = used.reduce((n, a, j) => (j === i ? n : n + killsOf(a)), 0);
    takes = Math.max(takes, soft + takesAlone(last));
  }
  return takes;
}

/** The default number of fogged attackers: {@link DEFAULT_FOGGED_ATTACKERS} in a big free-for-all with commanders, else 0 (off). */
export function defaultFoggedAttackers(a: { commanders: boolean; players: number; teams: boolean; fog: boolean }): number {
  return a.commanders && a.fog && !a.teams && a.players >= FOG_FFA_MIN_PLAYERS ? DEFAULT_FOGGED_ATTACKERS : 0;
}

/**
 * The armies a hidden player's stack is taken to hold: an opponent's start (the game's armies on each
 * player's starting territory, when it sets them), else my largest stack — a player as strong as I am.
 */
export function foggedStack(startArmies: number | undefined, myLargest: number): number {
  return startArmies !== undefined && startArmies > 0 ? startArmies : Math.max(0, myLargest);
}

/** The check of my commander, after my orders, against the fog's attackers (warapp_check_plan's `commander.fogged`). */
export interface FoggedCommanderCheck {
  territory: number;
  /** My armies there after my orders (the commander not counted). */
  armies: number;
  /** How many strike together (at most `count`), and the fogged territories they may come from. */
  attackers: number;
  from: FogAttack[];
  /** Whether it survives them (luck-free); `needs`: the armies there that do. */
  safe: boolean;
  needs: number;
}

/**
 * My commander on `territory` with `armies` of mine there against the `count` strongest fogged attacks:
 * each softener's luck-free kills come off, and the last must not kill every defender left (my commander
 * fights as {@link COMMANDER_STRENGTH}). Undefined with no fogged territory in reach.
 */
export function foggedCommanderCheck(
  g: MapGraph,
  view: FogView,
  territory: number,
  armies: number,
  a: { count: number; stack: number; deploy: number; offensiveKillRate: number; defensiveKillRate: number },
): FoggedCommanderCheck | undefined {
  if (a.count <= 0) return undefined;
  const from = foggedAttacks(g, view, territory, a);
  if (!from.length) return undefined;
  const used = from.slice(0, a.count);
  const kills = (n: number) => guaranteedKills(n, a.offensiveKillRate, 0, 'StraightRound');
  const survives = (d: number) =>
    used.every((last, i) => {
      const left = d + COMMANDER_STRENGTH - used.reduce((n, x, j) => (j === i ? n : n + kills(x.armies)), 0);
      return left > 0 && kills(last.armies) < left;
    });
  let needs = Math.max(0, armies);
  if (!survives(needs)) {
    needs = 0;
    while (!survives(needs)) needs++;
  } else {
    while (needs > 0 && survives(needs - 1)) needs--;
  }
  return { territory, armies, attackers: used.length, from: used, safe: survives(armies), needs };
}
