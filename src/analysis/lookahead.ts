// One turn ahead (#156, #172): a territory of mine that no enemy stack touches today can be a
// border tomorrow. For each stack, each territory beside it that it can take this turn (mine or
// neutral), and each territory of mine beyond that one, the two turns are carried out: the stack
// takes the one in between with its deploy (under whichever move order leaves it strongest
// there), then attacks on with the survivors and its next deploy. I am taken to add nothing next
// turn. Pure and deterministic; the reaches come out in a fixed order (opponents, stacks and
// territories ascending, as the graph lists neighbours).
//
// The one computation behind `warapp_check_plan`'s `exposedNextTurn` (stress.ts, which keeps
// only the reaches that take the territory) and the planner's two-step hold (planner.ts rule 6,
// which keeps what the territory needs against them). `needs` is luck-free (check_plan's measure);
// the planner measures its hold from `power` as its one-step holds are, never below `needs`.

import type { BoardState } from '../board.js';
import { COMMANDER_STRENGTH, DEFAULT_OFFENSIVE_KILL_RATE, straightKills } from './combat.js';
import type { MapGraph } from './graph.js';
import { neighborsOf } from './graph.js';
import { simTerritories, simulateTurn, type SimDeploy, type SimOrder, type SimResult, type SimSettings } from './turn-sim.js';

export interface TwoStepInput {
  graph: MapGraph;
  board: BoardState;
  me: number;
  /** Each opponent and the armies it is expected to deploy each turn. */
  opponents: readonly { id: number; deploy: number }[];
  /** My deploys this turn (default none: the board as it stands). */
  deploys?: readonly { territoryId: number; armies: number }[];
  /** My attacks and transfers this turn, in order (default none). */
  moves?: readonly { from: number; to: number; armies: number }[];
  settings?: SimSettings;
  teams?: ReadonlyMap<number, number>;
  /** Who moves first this turn, when known; otherwise both are tried. */
  firstMover?: 'me' | 'opponent';
  /** I play an Order Priority card this turn. */
  orderPriority?: boolean;
  /** Only these of my territories are looked at (default every one I hold after my orders). */
  only?: (territory: number) => boolean;
}

/** A territory of mine a stack two steps away could attack next turn (see the header). */
export interface TwoStepReach {
  territory: number;
  /** Armies on it after my orders and this turn's capture of the territory in between. */
  armies: number;
  opponent: number;
  /** The stack today, and the territory in between that it takes this turn. */
  from: number;
  via: number;
  /** Armies that would attack it next turn: the survivors and the next deploy, less the guard. */
  attackers: number;
  /** That attack's strength: {@link attackers} and the opponent's commander when it comes along. */
  power: number;
  /** Armies it would need to hold against them: one more than that attack can kill (luck-free). */
  needs: number;
  /** That attack takes it as it stands. */
  falls: boolean;
}

const byNum = (a: number, b: number) => a - b;

export function twoStepReaches(input: TwoStepInput): TwoStepReach[] {
  const { graph, board, me, teams } = input;
  const start = simTerritories(board);
  const friendly = (owner: unknown): boolean =>
    owner === me || (typeof owner === 'number' && teams !== undefined && teams.get(owner) !== undefined && teams.get(owner) === teams.get(me));
  const myDeploys: SimDeploy[] = (input.deploys ?? []).map((d) => ({ player: me, territoryId: d.territoryId, armies: d.armies }));
  const myOrders: SimOrder[] = (input.moves ?? []).map((m) => ({ from: m.from, to: m.to, armies: m.armies }));
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
  const mineAfter = new Set([...baseline.territories].filter(([, t]) => t.owner === me).map(([id]) => id));
  const only = input.only ?? (() => true);
  const off = input.settings?.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const firsts: ('me' | 'opponent')[] = input.firstMover !== undefined ? [input.firstMover] : ['me', 'opponent'];
  const out: TwoStepReach[] = [];
  for (const opp of [...input.opponents].sort((a, b) => a.id - b.id)) {
    if (opp.id === me || friendly(opp.id)) continue;
    const deploy = Math.max(0, Math.floor(opp.deploy));
    const theirDeploy = (territoryId: number): SimDeploy[] => (deploy > 0 ? [{ player: opp.id, territoryId, armies: deploy }] : []);
    const stacks = [...start].filter(([, t]) => t.owner === opp.id).map(([id]) => id).sort(byNum);
    for (const from of stacks) {
      const beside = new Set(neighborsOf(graph, from));
      for (const via of beside) {
        const between = start.get(via);
        // The territory in between must be one it can attack and whose defenders are known.
        if (!between || between.owner === 'unknown' || between.owner === opp.id) continue;
        if (typeof between.owner === 'number' && between.owner !== me && teams?.get(between.owner) !== undefined && teams.get(between.owner) === teams.get(opp.id)) continue;
        // Beyond it: territories I hold after my orders that this stack does not touch today.
        const beyond = neighborsOf(graph, via).filter((t) => t !== from && mineAfter.has(t) && !beside.has(t) && only(t));
        if (!beyond.length) continue;
        // This turn: the stack takes it, under whichever move order leaves it strongest there.
        let first: SimResult | undefined;
        for (const order1 of firsts) {
          const r = simulate(
            theirDeploy(from),
            { player: opp.id, orders: [{ from, to: via, armies: (start.get(from)?.armies ?? 0) + deploy, withCommander: true }] },
            order1 === 'me' ? [me, opp.id] : [opp.id, me],
          );
          const held = r.territories.get(via);
          if (held?.owner !== opp.id) continue;
          if (!first || held.armies > (first.territories.get(via)?.armies ?? 0)) first = r;
        }
        if (!first) continue;
        for (const territory of beyond) {
          const there = first.territories.get(territory);
          if (!there || there.owner !== me) continue;
          // Next turn: it deploys there again and attacks on; I add nothing.
          const second = simulateTurn({
            graph,
            board,
            start: first.territories,
            deploys: theirDeploy(via),
            orders: [{ player: opp.id, orders: [{ from: via, to: territory, armies: (first.territories.get(via)?.armies ?? 0) + deploy, withCommander: true }] }],
            moveOrder: [opp.id],
            ...(input.settings ? { settings: input.settings } : {}),
            ...(teams ? { teams } : {}),
          });
          const blow = second.log[0];
          if (!blow) continue;
          const attackers = blow.sent;
          const power = attackers + (first.territories.get(via)?.commander === opp.id ? COMMANDER_STRENGTH : 0);
          out.push({
            territory,
            armies: there.armies,
            opponent: opp.id,
            from,
            via,
            attackers,
            power,
            needs: straightKills(power, off) + 1,
            falls: second.territories.get(territory)?.owner !== me,
          });
        }
      }
    }
  }
  return out;
}
