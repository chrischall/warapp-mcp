// A stress test for a proposed turn: the plan's orders are resolved (turn-sim.ts) against the
// replies an opponent could make with ONE deploy, and the ones that cost something are
// reported, worst first. Pure and deterministic; ties resolve on ascending ids.
//
// The planner judges each border and each capture by a rule. This judges the whole list of
// orders at once, by carrying the turn out: a border the plan's own transfer emptied, a capture
// that leaves two armies beside a stack, an attack that fails when its target is reinforced.
//
// Replies tried for each opponent (its deploy is the caller's estimate, all of it in one place):
//   attack      deploy on one stack next to a territory I hold (or will hold after my own
//               orders) and attack it with everything that stack can move, its commander too;
//   reinforce   deploy on a territory my plan attacks and sit still;
//   all-attack  every stack with a target attacks at once, the deploy on the largest: once
//               spread (each stack takes the most valuable target no other has taken) and once
//               concentrated (each takes its most valuable target). Tried when two or more
//               stacks have targets: it is what needs no deploy.
//   dodge       (#180) a stack my orders attack moves out first, its deploy on it and its
//               commander along, into each exit it can take: its own neighbour, or a neutral or
//               a territory of mine its armies break (luck-free, on the board after my deploys).
//               Run with it moving first only (moving second it is struck where it stands, which
//               the other replies cover), so never when I am known to move first; an order of
//               mine from a territory it took first does nothing (turn-sim.ts). A dodge into my
//               territory is the `attack` reply moving first and is not run twice. `dodges`
//               lists every one tried: what it took, the armies that got away, and what my
//               strike then hit. A player my orders finish off unanswered (its commander killed,
//               or, on a board with no fog, nothing left) that a reply keeps in the game is
//               `eliminationsFailed`: the reply the end of a game turns on.
//   joint       (#180) two opponents strike one territory of mine (now, or after my orders)
//               together, each from its largest stack beside it with its deploy: teammates
//               always, any two opponents in a free-for-all only when I lead (`leader`, the
//               caller's call: they gang up on the leader). Both relative orders are tried, with
//               me first and with me last. `jointFalls` lists the territories that fall to some
//               pair, with the armies they would need to hold (luck-free: one more than the two
//               attacks together kill; armies alone, a commander of mine there not counted).
//   chain       (#180) under Multi-Attack, a stack's survivors carry on: after a capture they
//               attack again, less the guard. For each stack (its deploy on it, its commander
//               left behind) the chains through territories not its own or a teammate's (and
//               not in the fog) are searched on the exact combat model, at most
//               CHAIN_MAX_STEPS attacks deep and CHAIN_MAX_NODES attacks tried, on the board
//               after my deploys; the one of two attacks or more that takes the most of mine
//               (the income it breaks, then territories, then the shortest, then the first
//               found in ascending ids) is tried.
// Each is run with me moving first and with the opponent moving first, unless the first mover
// is known; runs that end the same are reported once.
//
// Local Deployment (#180, `localDeployments`): every reply's deploy is bounded as the planner
// bounds it (#128; local-deploy.ts `enemyDeployReaching`): the opponent's free income plus the
// pools of the bonuses it holds that contain the territory deployed on.
//
// One turn ahead (`exposedNextTurn`, computed by lookahead.ts, which the planner shares): a territory of mine that no enemy stack touches today can
// be a border tomorrow. For each stack, each territory beside it that it can take this turn (mine
// or neutral), and each territory of mine beyond that one, the two turns are carried out: the
// stack takes the one in between with its deploy, then attacks on with the survivors and its next
// deploy. A territory that falls is listed with the armies it would need to hold. I am taken to
// add nothing next turn: it shows what the orders leave exposed, not what will happen.
//
// What this does NOT cover, so "safe" is only ever "safe against these": stacks hidden by fog,
// armies included (`blindBorders` lists my territories next to them), a deploy split over
// several stacks, two opponents together other than on one territory of mine (and two
// free-for-all opponents at all unless I lead), more than one chain per stack, cards, and an
// opponent that deploys more than the estimate. When no reply could be tried at all, `safe` is
// `null`: nothing is known.

import type { BoardState } from '../board.js';
import { bonusTerritories } from './bonuses.js';
import { COMMANDER_STRENGTH, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE, straightKills } from './combat.js';
import type { MapGraph } from './graph.js';
import { neighborsOf } from './graph.js';
import { enemyDeployReaching, heldBonusPools } from './local-deploy.js';
import { twoStepReaches } from './lookahead.js';
import { DEFAULT_BASE_INCOME } from './player.js';
import {
  simTerritories,
  simulateTurn,
  type SimDeploy,
  type SimEvent,
  type SimOrder,
  type SimResult,
  type SimSettings,
  type SimTerritory,
} from './turn-sim.js';

export interface StressOpponent {
  id: number;
  /** Armies it is expected to deploy this turn. */
  deploy: number;
  /** Its base income: under Local Deployment, what it may deploy anywhere (never below {@link DEFAULT_BASE_INCOME}). */
  base?: number;
}

export interface StressInput {
  graph: MapGraph;
  board: BoardState;
  me: number;
  deploys: readonly { territoryId: number; armies: number }[];
  /** My attacks and transfers, in the order they will be submitted, with their options (#165). */
  moves: readonly SimOrder[];
  opponents: readonly StressOpponent[];
  settings?: SimSettings;
  teams?: ReadonlyMap<number, number>;
  /** Who moves first this turn, when known (me, or the opponent replying); otherwise both are tried. */
  firstMover?: 'me' | 'opponent';
  /** I play an Order Priority card this turn (my first order runs before everything). */
  orderPriority?: boolean;
  /** Most replies listed (default {@link DEFAULT_MAX_REPLIES}); `harmful` counts them all. */
  maxReplies?: number;
  /** Also look one turn ahead (`exposedNextTurn`); default `true`. */
  lookAhead?: boolean;
  /** The game has Local Deployment: each opponent's deploy is bounded by where it lands (#180). */
  localDeployments?: boolean;
  /** I lead a free-for-all: any two opponents may strike one territory of mine together (#180). */
  leader?: boolean;
}

export const DEFAULT_MAX_REPLIES = 8;
/** The most attacks one chain is searched to (#180). */
export const CHAIN_MAX_STEPS = 6;
/** The most attacks tried while searching one stack's chains (#180). */
export const CHAIN_MAX_NODES = 4000;

export type StressReplyKind = 'attack' | 'reinforce' | 'all-attack' | 'dodge' | 'joint' | 'chain';

export interface StressReply {
  opponent: number;
  kind: StressReplyKind;
  /** Where its deploy went, and how much. */
  deployTo: number;
  deploy: number;
  /**
   * `attack`, `dodge`, `chain` (its first attack), `joint` (the first opponent's attack): the
   * order, and the armies that actually left.
   */
  from?: number;
  to?: number;
  armies?: number;
  /** `all-attack`, `joint`: every order tried. */
  attacks?: { from: number; to: number }[];
  /** `joint`: the second opponent, its deploy and where it went. */
  partner?: number;
  partnerDeployTo?: number;
  partnerDeploy?: number;
  /** `joint`: which of the two moved first for this outcome; absent when it ends the same either way. */
  firstOpponent?: number;
  /** `chain`: the stack, then every territory it attacks in turn. */
  path?: number[];
  /** Who has to move first for this outcome; absent when it ends the same either way. */
  firstMover?: 'me' | 'opponent';
  /** Territories I held at the start of the turn and no longer hold. */
  lost: number[];
  /** Territories my plan takes that this reply stops it taking. */
  capturesFailed: number[];
  /** Territories my plan takes that are taken back before the turn ends. */
  retaken: number[];
  /** Bonuses I would hold after my plan and do not hold after this reply. */
  bonusesLost: { id: number; value: number }[];
  incomeLost: number;
  commanderLost: boolean;
  /** Players my plan leaves with nothing (or kills the commander of) that this reply keeps in the game (#180). */
  eliminationsFailed: number[];
  /** Armies each side ends with, against the plan going unanswered (negative: fewer). */
  myArmies: number;
  theirArmies: number;
}

/** A stack my orders attack, moving out first (#180): see the header. */
export interface StressDodge {
  opponent: number;
  stack: number;
  exit: number;
  exitOwner: 'own' | 'neutral' | 'mine';
  deploy: number;
  /** Armies that left the stack. */
  sent: number;
  /** It holds the exit at the end, having moved in or taken it. */
  took: boolean;
  /** Its armies on the exit at the end (0 when it does not hold it). */
  escaped: number;
  /** Its commander went along and lives there. */
  commander: boolean;
  /** My orders onto the stack's territory, as they ran. */
  strikes: { from: number; result: SimEvent['result']; sent: number }[];
  /** It costs me something (it is then among the replies too). */
  harmful: boolean;
}

/** A territory of mine two opponents take together (#180): see the header. */
export interface StressJoint {
  territory: number;
  /** Armies on it after my orders, unanswered. */
  armies: number;
  opponents: [number, number];
  /** Each one's stack, and the armies it attacks with (its deploy included, less the guard). */
  from: [number, number];
  attackers: [number, number];
  /** Armies it would need to hold against both (luck-free). */
  needs: number;
  bonusesLost: { id: number; value: number }[];
  incomeLost: number;
}

/** A territory of mine that a stack two steps away could take next turn (see the header). */
export interface StressExposure {
  territory: number;
  /** Armies on it after my orders and this turn's reply. */
  armies: number;
  opponent: number;
  /** The stack today, and the territory in between that it takes this turn. */
  from: number;
  via: number;
  /** Armies that would attack it next turn: the survivors and the next deploy, less the guard. */
  attackers: number;
  /** Armies it would need to hold against them. */
  needs: number;
  /** Bonuses I would hold after my plan that go with it. */
  bonusesLost: { id: number; value: number }[];
  incomeLost: number;
}

export interface StressReport {
  /** `false` under luck or weighted rounding: battles were resolved at their expectation. */
  exact: boolean;
  /** Unstated rules an outcome rested on (see turn-sim.ts). */
  assumptions: string[];
  /** The plan with nobody answering: what it takes, what it holds, and each order's result. */
  baseline: { captured: number[]; failed: number[]; heldBonuses: number[]; log: SimEvent[] };
  /** Replies tried (each under one or more move orders: `runs` counts those). */
  considered: number;
  runs: number;
  /** Replies that cost a territory, a capture, a bonus, an elimination or my commander under some move order. */
  harmful: number;
  /** The most damaging of them, worst first, at most `maxReplies`. */
  replies: StressReply[];
  worst?: StressReply;
  /**
   * Everything some single reply costs, with the number of outcomes that cost it. Only one of
   * them happens: one deploy, one place. Outcomes that kill my commander are counted under
   * `commander` alone (everything goes with it).
   */
  atRisk: {
    commander: number;
    territories: { id: number; replies: number }[];
    captures: { id: number; replies: number }[];
    bonuses: { id: number; value: number; replies: number }[];
  };
  /** Every dodge tried (#180), by opponent, stack and exit. */
  dodges: StressDodge[];
  /** Territories two opponents take together (#180), costliest first, one per territory. */
  jointFalls: StressJoint[];
  /** Territories I hold, or take this turn, next to one whose owner or armies are hidden: nothing there was tested. */
  blindBorders: number[];
  /**
   * One turn ahead: territories no enemy stack touches now that one could take next turn by
   * first taking the territory in between, if I add nothing. Costliest first. This turn's
   * `safe` does not count them.
   */
  exposedNextTurn: StressExposure[];
  /**
   * `true`: no reply tried costs anything (it says nothing about `blindBorders`). `false`: one
   * does. `null`: no reply could be tried, so nothing is known.
   */
  safe: boolean | null;
}

const byNum = (a: number, b: number) => a - b;

/** One opponent's part in a reply. */
interface Side {
  player: number;
  deployTo: number;
  deploy: number;
  orders: SimOrder[];
}

interface Candidate extends Side {
  kind: StressReplyKind;
  /** `joint`: the second opponent. */
  partner?: Side;
  path?: number[];
  /** Read as a dodge too (an `attack` reply into my territory is one, moving first). */
  dodge?: { stack: number; exit: number; exitOwner: StressDodge['exitOwner'] };
}

interface Run {
  firstMover: 'me' | 'opponent';
  moveOrder: number[];
  firstOpponent?: number;
}

export function stressPlan(input: StressInput): StressReport {
  const { graph, board, me } = input;
  const start = simTerritories(board);
  const teams = input.teams;
  const sameTeam = (a: number, b: number): boolean => teams !== undefined && teams.get(a) !== undefined && teams.get(a) === teams.get(b);
  const friendly = (owner: unknown): boolean => owner === me || (typeof owner === 'number' && sameTeam(owner, me));
  const off = input.settings?.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const def = input.settings?.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const guard = input.settings?.oneArmyStandsGuard === false ? 0 : 1;

  const myDeploys: SimDeploy[] = input.deploys.map((d) => ({ player: me, territoryId: d.territoryId, armies: d.armies }));
  const myOrders: SimOrder[] = input.moves.map((m) => ({ ...m }));
  const simulate = (sides: readonly Side[], moveOrder: number[]): SimResult =>
    simulateTurn({
      graph,
      board,
      deploys: [...myDeploys, ...sides.flatMap((x) => (x.deploy > 0 ? [{ player: x.player, territoryId: x.deployTo, armies: x.deploy }] : []))],
      orders: [{ player: me, orders: myOrders }, ...sides.map((x) => ({ player: x.player, orders: x.orders }))],
      moveOrder,
      ...(input.settings ? { settings: input.settings } : {}),
      ...(teams ? { teams } : {}),
      ...(input.orderPriority ? { orderPriority: [me] } : {}),
    });

  const baseline = simulate([], [me]);
  const mineAtStart = new Set([...start].filter(([, t]) => t.owner === me).map(([id]) => id));
  const mineAfter = (r: SimResult): Set<number> => new Set([...r.territories].filter(([, t]) => t.owner === me).map(([id]) => id));
  const baseMine = mineAfter(baseline);
  const planned = [...baseMine].filter((id) => !mineAtStart.has(id)).sort(byNum);
  const mineEither = new Set([...mineAtStart, ...baseMine]);

  const bonusIds = [...graph.bonusById.keys()].sort(byNum);
  const heldBonuses = (held: ReadonlySet<number>): number[] =>
    bonusIds.filter((id) => {
      const ts = bonusTerritories(graph, id);
      return ts.length > 0 && ts.every((t) => held.has(t));
    });
  const baseBonuses = heldBonuses(baseMine);
  const bonusValue = (id: number): number => graph.bonusById.get(id)?.value ?? 0;
  /** My bonuses (after my plan) that go with any of these territories. */
  const bonusesWith = (ids: readonly number[]): number[] => baseBonuses.filter((b) => bonusTerritories(graph, b).some((t) => ids.includes(t)));
  /** What a territory is worth to an attacker choosing a target: the bonuses of mine it breaks. */
  const worth = (id: number): number => bonusesWith([id]).reduce((n, b) => n + bonusValue(b), 0);

  const armiesOf = (r: SimResult, test: (owner: unknown) => boolean): number =>
    [...r.territories.values()].reduce((n, t) => n + (test(t.owner) ? t.armies : 0), 0);
  const holdsAny = (r: SimResult, player: number): boolean => [...r.territories.values()].some((t) => t.owner === player);

  const blindBorders = [...mineEither].filter((id) => neighborsOf(graph, id).some((n) => start.get(n)?.owner === 'unknown')).sort(byNum);

  // Local Deployment (#180): each opponent's held bonuses pay only into their own territories.
  const shownOwner = new Map(board.territories.flatMap((t) => (t.owner.kind === 'player' ? [[t.territoryId, t.owner.playerId] as const] : [])));
  const pools = input.localDeployments ? heldBonusPools(graph, (t) => shownOwner.get(t)) : undefined;
  const deployOn = (opp: StressOpponent, on: number): number => {
    const all = Math.max(0, Math.floor(opp.deploy));
    return pools ? enemyDeployReaching(all, opp.base ?? 0, DEFAULT_BASE_INCOME, pools.get(opp.id) ?? [], [on]) : all;
  };

  /** Luck-free: `sent` armies (and a commander, when it goes along) take `t` as it stands. */
  const breaks = (sent: number, withCommander: boolean, t: SimTerritory | undefined): boolean => {
    if (!t || t.owner === 'unknown' || sent < 0) return false;
    const power = sent + (withCommander ? COMMANDER_STRENGTH : 0);
    const defPower = t.armies + (t.commander !== undefined ? COMMANDER_STRENGTH : 0);
    const kills = straightKills(power, off);
    const defenceGone = kills >= t.armies && (t.commander === undefined || kills - t.armies >= COMMANDER_STRENGTH);
    const losses = straightKills(defPower, def);
    const lives = sent - Math.min(sent, losses) > 0 || (withCommander && losses - sent < COMMANDER_STRENGTH);
    return defenceGone && lives;
  };
  /** The board after my deploys: what dodges and chains are searched on. */
  const afterMyDeploys = new Map([...start].map(([id, t]) => [id, { ...t }]));
  for (const d of myDeploys) {
    const c = afterMyDeploys.get(d.territoryId);
    if (c && c.owner === me && d.armies > 0) c.armies += d.armies;
  }
  const allOf = (s: number, deploy: number): number => (start.get(s)?.armies ?? 0) + deploy;
  const stacksOf = (id: number): number[] =>
    [...start]
      .filter(([, t]) => t.owner === id)
      .map(([t]) => t)
      .sort(byNum);

  /** The best chain out of `s` (see the header), or none of two attacks or more that takes a territory of mine. */
  const chainFrom = (opp: number, s: number, dep: number): Candidate | undefined => {
    const first = Math.max(0, allOf(s, dep) - guard);
    if (first <= 0) return undefined;
    let nodes = 0;
    let best: { path: number[]; sends: number[]; income: number; mine: number } | undefined;
    const hostile = (owner: SimTerritory['owner']): boolean => owner === 'neutral' || (typeof owner === 'number' && owner !== opp && !sameTeam(owner, opp));
    const visit = (at: number, sending: number, path: number[], sends: number[]): void => {
      for (const n of neighborsOf(graph, at)) {
        if (nodes >= CHAIN_MAX_NODES) return;
        if (path.includes(n)) continue;
        const t = afterMyDeploys.get(n);
        if (!t || !hostile(t.owner)) continue;
        nodes++;
        if (!breaks(sending, false, t)) continue;
        const defPower = t.armies + (t.commander !== undefined ? COMMANDER_STRENGTH : 0);
        const survivors = sending - Math.min(sending, straightKills(defPower, def));
        const p = [...path, n];
        const sd = [...sends, sending];
        const took = p.slice(1).filter((x) => mineEither.has(x));
        if (p.length >= 3 && took.length) {
          const income = bonusesWith(took).reduce((k, b) => k + Math.max(0, bonusValue(b)), 0);
          const better =
            !best ||
            income > best.income ||
            (income === best.income && (took.length > best.mine || (took.length === best.mine && p.length < best.path.length)));
          if (better) best = { path: p, sends: sd, income, mine: took.length };
        }
        const next = survivors - guard;
        if (next > 0 && p.length <= CHAIN_MAX_STEPS) visit(n, next, p, sd);
      }
    };
    visit(s, first, [s], []);
    if (!best) return undefined;
    const b = best;
    // The first order asks for everything (the resolver sends what can move); each next one the survivors less the guard.
    const orders: SimOrder[] = b.path.slice(1).map((to, i) => ({ from: b.path[i]!, to, armies: i === 0 ? allOf(s, dep) : b.sends[i]! }));
    return { player: opp, kind: 'chain', deployTo: s, deploy: dep, orders, path: b.path };
  };

  // ---- the replies to try ----
  const candidates: Candidate[] = [];
  const myTargets = new Set(input.moves.map((m) => m.to));
  const opponents = [...input.opponents].sort((a, b) => a.id - b.id).filter((o) => o.id !== me && !friendly(o.id));
  for (const opp of opponents) {
    const stacks = stacksOf(opp.id);
    /** For each stack, my territories (now, or after my plan) it touches. */
    const reach = new Map<number, number[]>();
    for (const s of stacks) {
      const ts = neighborsOf(graph, s).filter((n) => mineEither.has(n));
      if (ts.length) reach.set(s, ts);
    }
    const attacks = new Map<string, Candidate>();
    for (const [s, ts] of reach) {
      const dep = deployOn(opp, s);
      for (const t of ts) {
        const c: Candidate = { player: opp.id, kind: 'attack', deployTo: s, deploy: dep, orders: [{ from: s, to: t, armies: allOf(s, dep), withCommander: true }] };
        attacks.set(`${s}>${t}`, c);
        candidates.push(c);
      }
    }
    for (const s of stacks) {
      const dep = deployOn(opp, s);
      if (myTargets.has(s) && dep > 0) candidates.push({ player: opp.id, kind: 'reinforce', deployTo: s, deploy: dep, orders: [] });
    }
    if (reach.size >= 2) {
      const bySize = [...reach.keys()].sort((a, b) => (start.get(b)?.armies ?? 0) - (start.get(a)?.armies ?? 0) || a - b);
      const largest = bySize[0]!;
      const dep = deployOn(opp, largest);
      const ranked = (st: number): number[] => [...reach.get(st)!].sort((a, b) => worth(b) - worth(a) || a - b);
      const ordersFor = (choice: ReadonlyMap<number, number>): SimOrder[] =>
        [...reach.keys()].map((st) => ({
          from: st,
          to: choice.get(st)!,
          armies: allOf(st, st === largest ? dep : 0),
          withCommander: true,
        }));
      // Spread: largest stack first, each taking its most valuable target no other stack has
      // taken yet, so two stacks that reach the same two territories hit both.
      const taken = new Set<number>();
      const spread = new Map<number, number>();
      for (const st of bySize) {
        const ts = ranked(st);
        const pick = ts.find((t) => !taken.has(t)) ?? ts[0]!;
        taken.add(pick);
        spread.set(st, pick);
      }
      // Concentrated: every stack on its most valuable target, so several fall on one.
      const together = new Map([...reach.keys()].map((st) => [st, ranked(st)[0]!]));
      const variants = [ordersFor(spread), ordersFor(together)];
      const same = JSON.stringify(variants[0]) === JSON.stringify(variants[1]);
      for (const orders of same ? [variants[0]!] : variants) {
        candidates.push({ player: opp.id, kind: 'all-attack', deployTo: largest, deploy: dep, orders });
      }
    }
    // Dodge (#180): a stack my orders attack moves out first, never when I am known to move first.
    if (input.firstMover !== 'me') {
      for (const s of stacks.filter((x) => myTargets.has(x))) {
        const dep = deployOn(opp, s);
        const withCommander = start.get(s)?.commander === opp.id;
        for (const exit of [...neighborsOf(graph, s)].sort(byNum)) {
          const t = afterMyDeploys.get(exit);
          if (!t || t.owner === 'unknown') continue;
          const exitOwner: StressDodge['exitOwner'] | undefined =
            t.owner === opp.id ? 'own' : t.owner === 'neutral' ? 'neutral' : t.owner === me ? 'mine' : undefined;
          if (exitOwner === undefined) continue;
          if (exitOwner !== 'own' && !breaks(Math.max(0, allOf(s, dep) - guard), withCommander, t)) continue;
          const dodge = { stack: s, exit, exitOwner };
          // Into my territory it is the attack reply, moving first: read the dodge from that run.
          const same = attacks.get(`${s}>${exit}`);
          if (same) same.dodge = dodge;
          else candidates.push({ player: opp.id, kind: 'dodge', deployTo: s, deploy: dep, orders: [{ from: s, to: exit, armies: allOf(s, dep), withCommander: true }], dodge });
        }
      }
    }
    // Chains (#180): under Multi-Attack, survivors carry on.
    if (input.settings?.multiAttack) {
      for (const s of stacks) {
        const c = chainFrom(opp.id, s, deployOn(opp, s));
        if (c) candidates.push(c);
      }
    }
  }

  // Joint (#180): two opponents on one territory of mine.
  const largestBeside = (id: number, t: number): number | undefined =>
    stacksOf(id)
      .filter((s) => neighborsOf(graph, s).includes(t))
      .sort((x, y) => (start.get(y)?.armies ?? 0) - (start.get(x)?.armies ?? 0) || x - y)[0];
  for (let i = 0; i < opponents.length; i++) {
    for (let j = i + 1; j < opponents.length; j++) {
      const [a, b] = [opponents[i]!, opponents[j]!];
      if (!sameTeam(a.id, b.id) && !input.leader) continue;
      for (const t of [...mineEither].sort(byNum)) {
        const [sa, sb] = [largestBeside(a.id, t), largestBeside(b.id, t)];
        if (sa === undefined || sb === undefined) continue;
        const side = (o: StressOpponent, s: number): Side => {
          const dep = deployOn(o, s);
          return { player: o.id, deployTo: s, deploy: dep, orders: [{ from: s, to: t, armies: allOf(s, dep), withCommander: true }] };
        };
        candidates.push({ ...side(a, sa), kind: 'joint', partner: side(b, sb) });
      }
    }
  }

  // ---- run them ----
  const assumptions = new Set(baseline.assumptions);
  const baseCaptured = new Set(baseline.log.filter((e) => e.player === me && e.result === 'captured').map((e) => e.to));
  const baseMyArmies = armiesOf(baseline, (o) => o === me);
  /**
   * Players my plan kills the commander of, or leaves with nothing — only on a board with no fog:
   * with fog, a player may hold territories nobody sees.
   */
  const noFog = [...start.values()].every((t) => t.owner !== 'unknown');
  const finished = [...new Set([...start.values()].flatMap((t) => (typeof t.owner === 'number' && t.owner !== me ? [t.owner] : [])))]
    .filter((p) => baseline.eliminated.includes(p) || (noFog && !holdsAny(baseline, p)))
    .sort(byNum);
  let runs = 0;
  let harmfulCandidates = 0;
  const harmful: StressReply[] = [];
  const dodges: StressDodge[] = [];
  const joints = new Map<number, StressJoint>();

  const judge = (c: Candidate, r: SimResult, run: Run): StressReply | undefined => {
    const after = mineAfter(r);
    const lost = [...mineAtStart].filter((id) => !after.has(id)).sort(byNum);
    const tookHere = new Set(r.log.filter((e) => e.player === me && e.result === 'captured').map((e) => e.to));
    const commanderLost = r.eliminated.includes(me);
    // With my commander gone everything is: which captures stuck no longer means anything.
    const gone = commanderLost ? [] : planned.filter((id) => !after.has(id));
    const retaken = gone.filter((id) => tookHere.has(id));
    const capturesFailed = gone.filter((id) => !tookHere.has(id));
    const held = new Set(heldBonuses(after));
    const bonusesLost = baseBonuses.filter((id) => !held.has(id)).map((id) => ({ id, value: bonusValue(id) }));
    const eliminationsFailed = commanderLost ? [] : finished.filter((p) => !r.eliminated.includes(p) && holdsAny(r, p));
    if (!lost.length && !retaken.length && !capturesFailed.length && !bonusesLost.length && !commanderLost && !eliminationsFailed.length) {
      return undefined;
    }
    const sides: Side[] = [c, ...(c.partner ? [c.partner] : [])];
    const theirs = (o: unknown) => sides.some((x) => x.player === o);
    const sent = r.log.find((e) => e.player === c.player && e.index === 0)?.sent;
    const single = c.kind === 'attack' || c.kind === 'dodge' || c.kind === 'joint' || c.kind === 'chain';
    return {
      opponent: c.player,
      kind: c.kind,
      deployTo: c.deployTo,
      deploy: c.deploy,
      ...(single ? { from: c.orders[0]!.from, to: c.orders[0]!.to, armies: sent ?? 0 } : {}),
      ...(c.kind === 'all-attack' || c.kind === 'joint' ? { attacks: sides.flatMap((x) => x.orders.map((o) => ({ from: o.from, to: o.to }))) } : {}),
      ...(c.partner ? { partner: c.partner.player, partnerDeployTo: c.partner.deployTo, partnerDeploy: c.partner.deploy } : {}),
      ...(run.firstOpponent !== undefined ? { firstOpponent: run.firstOpponent } : {}),
      ...(c.path ? { path: c.path } : {}),
      firstMover: run.firstMover,
      lost,
      capturesFailed,
      retaken,
      bonusesLost,
      incomeLost: bonusesLost.reduce((n, b) => n + b.value, 0),
      commanderLost,
      eliminationsFailed,
      myArmies: armiesOf(r, (o) => o === me) - baseMyArmies,
      // Against what they would have with their deploys and nothing else happening.
      theirArmies: armiesOf(r, theirs) - (armiesOf(baseline, theirs) + sides.reduce((n, x) => n + x.deploy, 0)),
    };
  };
  /** Two outcomes are the same when they cost me the same things. */
  const signature = (x: StressReply): string => JSON.stringify({ ...x, firstMover: undefined, firstOpponent: undefined });

  const runsFor = (c: Candidate): Run[] => {
    const firsts: ('me' | 'opponent')[] = c.kind === 'dodge' ? ['opponent'] : input.firstMover !== undefined ? [input.firstMover] : ['me', 'opponent'];
    if (!c.partner) return firsts.map((f) => ({ firstMover: f, moveOrder: f === 'me' ? [me, c.player] : [c.player, me] }));
    const pair = [c.player, c.partner.player];
    return firsts.flatMap((f) =>
      [pair, [...pair].reverse()].map((p) => ({ firstMover: f, firstOpponent: p[0]!, moveOrder: f === 'me' ? [me, ...p] : [...p, me] })),
    );
  };

  for (const c of candidates) {
    const sides: Side[] = [c, ...(c.partner ? [c.partner] : [])];
    const plan = runsFor(c);
    const found: StressReply[] = [];
    let theyFirst: { r: SimResult; harmful: boolean } | undefined;
    let falls = false;
    for (const run of plan) {
      const r = simulate(sides, run.moveOrder);
      runs++;
      for (const a of r.assumptions) assumptions.add(a);
      const reply = judge(c, r, run);
      if (reply) found.push(reply);
      if (run.firstMover === 'opponent') theyFirst ??= { r, harmful: reply !== undefined };
      if (c.kind === 'joint' && r.territories.get(c.orders[0]!.to)?.owner !== me) falls = true;
    }
    if (found.length) harmfulCandidates++;
    // Outcomes that are the same are reported once: with no first mover named when every run
    // ends that way, and with no first opponent when both of theirs do under one first mover.
    const groups = new Map<string, StressReply[]>();
    for (const f of found) groups.set(signature(f), [...(groups.get(signature(f)) ?? []), f]);
    for (const g of groups.values()) {
      if (g.length === plan.length && plan.length > 1) {
        const { firstMover: _f, firstOpponent: _o, ...same } = g[0]!;
        harmful.push(same);
      } else if (g.length > 1 && c.partner && g.every((x) => x.firstMover === g[0]!.firstMover)) {
        const { firstOpponent: _o, ...same } = g[0]!;
        harmful.push(same);
      } else {
        harmful.push(g[0]!);
      }
    }
    if (c.dodge && theyFirst) {
      const { stack, exit, exitOwner } = c.dodge;
      const r = theyFirst.r;
      const out = r.log.find((e) => e.player === c.player && e.index === 0);
      const end = r.territories.get(exit);
      const took = end?.owner === c.player && (out?.result === 'captured' || out?.result === 'transferred');
      dodges.push({
        opponent: c.player,
        stack,
        exit,
        exitOwner,
        deploy: c.deploy,
        sent: out?.sent ?? 0,
        took,
        escaped: took ? end!.armies : 0,
        commander: took && end!.commander === c.player,
        strikes: r.log.filter((e) => e.player === me && e.to === stack).map((e) => ({ from: e.from, result: e.result, sent: e.sent })),
        harmful: theyFirst.harmful,
      });
    }
    if (c.partner && falls) {
      const t = c.orders[0]!.to;
      const strength = (x: Side) => {
        const armies = Math.max(0, allOf(x.deployTo, x.deploy) - guard);
        return { armies, power: armies + (start.get(x.deployTo)?.commander === x.player ? COMMANDER_STRENGTH : 0) };
      };
      const [pa, pb] = [strength(c), strength(c.partner)];
      const bonusesLost = bonusesWith([t]).map((id) => ({ id, value: bonusValue(id) }));
      const j: StressJoint = {
        territory: t,
        armies: baseline.territories.get(t)?.armies ?? 0,
        opponents: [c.player, c.partner.player],
        from: [c.deployTo, c.partner.deployTo],
        attackers: [pa.armies, pb.armies],
        needs: straightKills(pa.power, off) + straightKills(pb.power, off) + 1,
        bonusesLost,
        incomeLost: bonusesLost.reduce((n, b) => n + b.value, 0),
      };
      const known = joints.get(t);
      if (!known || j.needs > known.needs) joints.set(t, j);
    }
  }
  dodges.sort((a, b) => a.opponent - b.opponent || a.stack - b.stack || a.exit - b.exit);
  const jointFalls = [...joints.values()].sort(
    (a, b) => Math.max(0, b.incomeLost) - Math.max(0, a.incomeLost) || b.needs - b.armies - (a.needs - a.armies) || a.territory - b.territory,
  );

  // Worst first: my commander, an elimination undone, then income, territories held, captures undone, armies.
  const order = harmful
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        Number(b.r.commanderLost) - Number(a.r.commanderLost) ||
        b.r.eliminationsFailed.length - a.r.eliminationsFailed.length ||
        // A negative bonus lost is no reason to rank a reply below one that takes nothing.
        Math.max(0, b.r.incomeLost) - Math.max(0, a.r.incomeLost) ||
        b.r.lost.length - a.r.lost.length ||
        b.r.retaken.length + b.r.capturesFailed.length - (a.r.retaken.length + a.r.capturesFailed.length) ||
        a.r.myArmies - a.r.theirArmies - (b.r.myArmies - b.r.theirArmies) ||
        a.i - b.i,
    )
    .map((x) => x.r);

  const tally = (pick: (r: StressReply) => readonly number[]): { id: number; replies: number }[] => {
    const n = new Map<number, number>();
    for (const r of harmful) if (!r.commanderLost) for (const id of pick(r)) n.set(id, (n.get(id) ?? 0) + 1);
    return [...n].sort((a, b) => a[0] - b[0]).map(([id, replies]) => ({ id, replies }));
  };
  const replies = order.slice(0, Math.max(0, input.maxReplies ?? DEFAULT_MAX_REPLIES));

  // ---- one turn ahead (the shared look-ahead, lookahead.ts) ----
  const exposed = new Map<number, StressExposure>();
  if (input.lookAhead !== false) {
    const reaches = twoStepReaches({
      graph,
      board,
      me,
      opponents: input.opponents,
      deploys: input.deploys,
      moves: input.moves,
      ...(input.settings ? { settings: input.settings } : {}),
      ...(teams ? { teams } : {}),
      ...(input.firstMover !== undefined ? { firstMover: input.firstMover } : {}),
      ...(input.orderPriority ? { orderPriority: true } : {}),
    });
    for (const r of reaches) {
      if (!r.falls) continue;
      const bonusesLost = bonusesWith([r.territory]).map((id) => ({ id, value: bonusValue(id) }));
      const found: StressExposure = {
        territory: r.territory,
        armies: r.armies,
        opponent: r.opponent,
        from: r.from,
        via: r.via,
        attackers: r.attackers,
        needs: r.needs,
        bonusesLost,
        incomeLost: bonusesLost.reduce((n, b) => n + b.value, 0),
      };
      const known = exposed.get(r.territory);
      if (!known || found.attackers > known.attackers) exposed.set(r.territory, found);
    }
  }
  const exposedNextTurn = [...exposed.values()].sort(
    (a, b) => Math.max(0, b.incomeLost) - Math.max(0, a.incomeLost) || b.needs - b.armies - (a.needs - a.armies) || a.territory - b.territory,
  );
  return {
    exact: baseline.exact,
    assumptions: [...assumptions],
    baseline: {
      captured: [...baseCaptured].filter((id) => baseMine.has(id)).sort(byNum),
      failed: baseline.log
        .filter((e) => e.player === me && e.kind === 'attack' && e.result === 'failed')
        .map((e) => e.to)
        .sort(byNum),
      heldBonuses: baseBonuses,
      log: baseline.log.filter((e) => e.player === me),
    },
    considered: candidates.length,
    runs,
    harmful: harmfulCandidates,
    replies,
    ...(replies[0] ? { worst: replies[0] } : {}),
    atRisk: {
      commander: harmful.filter((r) => r.commanderLost).length,
      territories: tally((r) => r.lost),
      captures: tally((r) => [...r.capturesFailed, ...r.retaken]),
      bonuses: tally((r) => r.bonusesLost.map((b) => b.id)).map((x) => ({ id: x.id, value: bonusValue(x.id), replies: x.replies })),
    },
    dodges,
    jointFalls,
    blindBorders,
    exposedNextTurn,
    safe: candidates.length === 0 ? null : harmful.length === 0,
  };
}
