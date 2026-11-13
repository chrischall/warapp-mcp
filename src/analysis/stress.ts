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
// Each is run with me moving first and with the opponent moving first, unless the first mover
// is known; two runs that end the same are reported once.
//
// What this does NOT cover, so "safe" is only ever "safe against these": stacks hidden by fog,
// armies included (`blindBorders` lists my territories next to them), a deploy split over
// several stacks, two opponents acting together, a chain of attacks under Multi-Attack, cards,
// and an opponent that deploys more than the estimate. When no reply could be tried at all,
// `safe` is `null`: nothing is known.

import type { BoardState } from '../board.js';
import { bonusTerritories } from './bonuses.js';
import type { MapGraph } from './graph.js';
import { neighborsOf } from './graph.js';
import { simTerritories, simulateTurn, type SimDeploy, type SimEvent, type SimOrder, type SimResult, type SimSettings } from './turn-sim.js';

export interface StressOpponent {
  id: number;
  /** Armies it is expected to deploy this turn. */
  deploy: number;
}

export interface StressInput {
  graph: MapGraph;
  board: BoardState;
  me: number;
  deploys: readonly { territoryId: number; armies: number }[];
  /** My attacks and transfers, in the order they will be submitted. */
  moves: readonly { from: number; to: number; armies: number }[];
  opponents: readonly StressOpponent[];
  settings?: SimSettings;
  teams?: ReadonlyMap<number, number>;
  /** Who moves first this turn, when known (me, or the opponent replying); otherwise both are tried. */
  firstMover?: 'me' | 'opponent';
  /** I play an Order Priority card this turn (my first order runs before everything). */
  orderPriority?: boolean;
  /** Most replies listed (default {@link DEFAULT_MAX_REPLIES}); `harmful` counts them all. */
  maxReplies?: number;
}

export const DEFAULT_MAX_REPLIES = 8;

export interface StressReply {
  opponent: number;
  kind: 'attack' | 'reinforce' | 'all-attack';
  /** Where its deploy went, and how much. */
  deployTo: number;
  deploy: number;
  /** `attack`: the order, and the armies that actually left. */
  from?: number;
  to?: number;
  armies?: number;
  /** `all-attack`: every order tried. */
  attacks?: { from: number; to: number }[];
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
  /** Armies each side ends with, against the plan going unanswered (negative: fewer). */
  myArmies: number;
  theirArmies: number;
}

export interface StressReport {
  /** `false` under luck or weighted rounding: battles were resolved at their expectation. */
  exact: boolean;
  /** Unstated rules an outcome rested on (see turn-sim.ts). */
  assumptions: string[];
  /** The plan with nobody answering: what it takes, what it holds, and each order's result. */
  baseline: { captured: number[]; failed: number[]; heldBonuses: number[]; log: SimEvent[] };
  /** Replies tried (each under one or both move orders: `runs` counts those). */
  considered: number;
  runs: number;
  /** Replies that cost a territory, a capture, a bonus or my commander under some move order. */
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
  /** Territories I hold, or take this turn, next to one whose owner or armies are hidden: nothing there was tested. */
  blindBorders: number[];
  /**
   * `true`: no reply tried costs anything (it says nothing about `blindBorders`). `false`: one
   * does. `null`: no reply could be tried, so nothing is known.
   */
  safe: boolean | null;
}

const byNum = (a: number, b: number) => a - b;

interface Candidate {
  opponent: number;
  kind: StressReply['kind'];
  deployTo: number;
  deploy: number;
  orders: SimOrder[];
}

export function stressPlan(input: StressInput): StressReport {
  const { graph, board, me } = input;
  const start = simTerritories(board);
  const teams = input.teams;
  const friendly = (owner: unknown): boolean =>
    owner === me || (typeof owner === 'number' && teams !== undefined && teams.get(owner) !== undefined && teams.get(owner) === teams.get(me));

  const myDeploys: SimDeploy[] = input.deploys.map((d) => ({ player: me, territoryId: d.territoryId, armies: d.armies }));
  const myOrders: SimOrder[] = input.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies }));
  const simulate = (deploys: SimDeploy[], theirs: { player: number; orders: SimOrder[] } | undefined, moveOrder: number[]): SimResult =>
    simulateTurn({
      graph,
      board,
      deploys: [...myDeploys, ...deploys],
      orders: [{ player: me, orders: myOrders }, ...(theirs ? [theirs] : [])],
      moveOrder,
      ...(input.settings ? { settings: input.settings } : {}),
      ...(teams ? { teams } : {}),
      ...(input.orderPriority ? { orderPriority: [me] } : {}),
    });

  const baseline = simulate([], undefined, [me]);
  const mineAtStart = new Set([...start].filter(([, t]) => t.owner === me).map(([id]) => id));
  const mineAfter = (r: SimResult): Set<number> => new Set([...r.territories].filter(([, t]) => t.owner === me).map(([id]) => id));
  const baseMine = mineAfter(baseline);
  const planned = [...baseMine].filter((id) => !mineAtStart.has(id)).sort(byNum);

  const bonusIds = [...graph.bonusById.keys()].sort(byNum);
  const heldBonuses = (held: ReadonlySet<number>): number[] =>
    bonusIds.filter((id) => {
      const ts = bonusTerritories(graph, id);
      return ts.length > 0 && ts.every((t) => held.has(t));
    });
  const baseBonuses = heldBonuses(baseMine);
  const bonusValue = (id: number): number => graph.bonusById.get(id)?.value ?? 0;
  /** What a territory is worth to an attacker choosing a target: the bonuses of mine it breaks. */
  const worth = (id: number): number => baseBonuses.filter((b) => bonusTerritories(graph, b).includes(id)).reduce((n, b) => n + bonusValue(b), 0);

  const armiesOf = (r: SimResult, test: (owner: unknown) => boolean): number =>
    [...r.territories.values()].reduce((n, t) => n + (test(t.owner) ? t.armies : 0), 0);

  const blindBorders = [...new Set([...mineAtStart, ...baseMine])]
    .filter((id) => neighborsOf(graph, id).some((n) => start.get(n)?.owner === 'unknown'))
    .sort(byNum);

  // ---- the replies to try ----
  const candidates: Candidate[] = [];
  const myTargets = new Set(input.moves.map((m) => m.to));
  for (const opp of [...input.opponents].sort((a, b) => a.id - b.id)) {
    if (opp.id === me || friendly(opp.id)) continue;
    const deploy = Math.max(0, Math.floor(opp.deploy));
    const stacks = [...start].filter(([, t]) => t.owner === opp.id).map(([id]) => id).sort(byNum);
    /** For each stack, my territories (now, or after my plan) it touches. */
    const reach = new Map<number, number[]>();
    for (const s of stacks) {
      const ts = neighborsOf(graph, s).filter((n) => mineAtStart.has(n) || baseMine.has(n));
      if (ts.length) reach.set(s, ts);
    }
    for (const [s, ts] of reach) {
      for (const t of ts) {
        const all = (start.get(s)?.armies ?? 0) + deploy;
        candidates.push({ opponent: opp.id, kind: 'attack', deployTo: s, deploy, orders: [{ from: s, to: t, armies: all, withCommander: true }] });
      }
    }
    if (deploy > 0) {
      for (const s of stacks) {
        if (myTargets.has(s)) candidates.push({ opponent: opp.id, kind: 'reinforce', deployTo: s, deploy, orders: [] });
      }
    }
    if (reach.size >= 2) {
      const bySize = [...reach.keys()].sort((a, b) => (start.get(b)?.armies ?? 0) - (start.get(a)?.armies ?? 0) || a - b);
      const largest = bySize[0]!;
      const ranked = (st: number): number[] => [...reach.get(st)!].sort((a, b) => worth(b) - worth(a) || a - b);
      const ordersFor = (choice: ReadonlyMap<number, number>): SimOrder[] =>
        [...reach.keys()].map((st) => ({
          from: st,
          to: choice.get(st)!,
          armies: (start.get(st)?.armies ?? 0) + (st === largest ? deploy : 0),
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
        candidates.push({ opponent: opp.id, kind: 'all-attack', deployTo: largest, deploy, orders });
      }
    }
  }

  // ---- run them ----
  const assumptions = new Set(baseline.assumptions);
  const baseCaptured = new Set(baseline.log.filter((e) => e.player === me && e.result === 'captured').map((e) => e.to));
  const baseMyArmies = armiesOf(baseline, (o) => o === me);
  let runs = 0;
  let harmfulCandidates = 0;
  const harmful: StressReply[] = [];

  const judge = (c: Candidate, r: SimResult, firstMover: 'me' | 'opponent'): StressReply | undefined => {
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
    if (!lost.length && !retaken.length && !capturesFailed.length && !bonusesLost.length && !commanderLost) return undefined;
    const theirs = (o: unknown) => o === c.opponent;
    const sent = c.kind === 'attack' ? r.log.find((e) => e.player === c.opponent)?.sent : undefined;
    return {
      opponent: c.opponent,
      kind: c.kind,
      deployTo: c.deployTo,
      deploy: c.deploy,
      ...(c.kind === 'attack' ? { from: c.orders[0]!.from, to: c.orders[0]!.to, armies: sent ?? 0 } : {}),
      ...(c.kind === 'all-attack' ? { attacks: c.orders.map((o) => ({ from: o.from, to: o.to })) } : {}),
      firstMover,
      lost,
      capturesFailed,
      retaken,
      bonusesLost,
      incomeLost: bonusesLost.reduce((n, b) => n + b.value, 0),
      commanderLost,
      myArmies: armiesOf(r, (o) => o === me) - baseMyArmies,
      // Against what it would have with its deploy and nothing else happening.
      theirArmies: armiesOf(r, theirs) - (armiesOf(baseline, theirs) + c.deploy),
    };
  };
  /** Two outcomes are the same when they cost me the same things. */
  const signature = (x: StressReply): string => JSON.stringify({ ...x, firstMover: undefined });

  for (const c of candidates) {
    const deploys: SimDeploy[] = c.deploy > 0 ? [{ player: c.opponent, territoryId: c.deployTo, armies: c.deploy }] : [];
    const theirs = { player: c.opponent, orders: c.orders };
    const firsts: ('me' | 'opponent')[] = input.firstMover !== undefined ? [input.firstMover] : ['me', 'opponent'];
    const found: StressReply[] = [];
    for (const first of firsts) {
      const r = simulate(deploys, theirs, first === 'me' ? [me, c.opponent] : [c.opponent, me]);
      runs++;
      for (const a of r.assumptions) assumptions.add(a);
      const reply = judge(c, r, first);
      if (reply) found.push(reply);
    }
    if (found.length) harmfulCandidates++;
    if (found.length === 2 && signature(found[0]!) === signature(found[1]!)) {
      // It ends the same whoever moves first: one reply, no first mover named.
      const { firstMover: _either, ...same } = found[0]!;
      harmful.push(same);
    } else {
      harmful.push(...found);
    }
  }

  // Worst first: my commander, then income, territories held, captures undone, armies.
  const order = harmful
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        Number(b.r.commanderLost) - Number(a.r.commanderLost) ||
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
    blindBorders,
    safe: candidates.length === 0 ? null : harmful.length === 0,
  };
}
