// The threats of a planning pass (#133): what each opponent can bring against each territory of
// mine this turn — the trend of its stacks since the previous board (rule 1t, #69, #123), Local
// Deployment's enemy pools (#128), the fog's hidden stacks and the large stacks that left view
// (#164), Multi-Attack chains (#199), Bomb-sized threats (#163) — and the borders they make (rule
// 1), stated in the rationale and warnings. Run once, right after the deploy book (it reads no deploy).
import { carriesTeam } from '../../teams.js';
import { searchChains } from '../chains.js';
import { guaranteedKills } from '../combat.js';
import { bfsDistances, neighborsOf } from '../graph.js';
import { enemyDeployReaching, heldBonusPools } from '../local-deploy.js';
import { incomeBasis, LOST_STACK_TURNS } from '../opponents.js';
import {
  HIDDEN_POOL_INCOMES,
  MAX_NAMED_REVEALS,
  MIN_ENEMY_DEPLOY,
  openingArmies,
  ownerShown,
  visibleState,
  type EnemyDeployEstimate,
  type PlanInput,
} from './shared.js';
import { territoryIncome } from '../player.js';
import { simTerritories } from '../turn-sim.js';
import type { PlanCtx, PlanState } from './state.js';
import { byNum } from './util.js';


/** A visible enemy stack next to me that grew since the previous board (rule 1t): its armies then and now. */
export interface Growth {
  from: number;
  to: number;
  growth: number;
}
export interface Force {
  player: number;
  /** That player's movable armies (and units) next to the territory. */
  movable: number;
  /** That player's fastest-growing stack next to it (0 without a trend, or not projected). */
  growth: number;
  /** What that player may deploy there (its estimate; under Local Deployment what reaches it). */
  deploy: number;
  /**
   * The attack that takes as much as the force can (#128): the larger of that player's movable
   * plus max(deploy, growth) as one attack, and the single attack equivalent to several
   * separate attacks (each stack its own, and with `allPlayers`, every opponent's too).
   */
  threat: number;
  /** When separate attacks beat one: what they are, for the rationale. */
  split?: { attacks: number[]; takes: number; players: number[] };
  /** #199: when a Multi-Attack chain lands more than the stacks next to it: that chain. */
  chain?: ChainThreat;
}
/** #199: a Multi-Attack chain onto a territory of mine: its player, path (the stack first) and the armies it lands. */
export interface ChainThreat {
  player: number;
  path: readonly number[];
  armies: number;
}
export interface Exposure {
  id: number;
  player: number;
  /** Armies the enemy needs to take it. */
  take: number;
  /** Deploys it still needs next turn to hold. */
  need: number;
}
/** A border's threat ({@link forceAt}): the strongest player's force, separate attacks included. */
export interface Border extends Force {
  id: number;
  /** #201, behind: the worst-case threat when `threat` is the expected attack it is sized for. */
  worst?: number;
}

/** The threats phase's helpers, for the phases after it. */
export type Threats = ReturnType<typeof threatsPhase>;
export type ThreatSources = ReturnType<typeof threatSources>;
export type ThreatForces = ReturnType<typeof threatForces>;

/** Read the threats against my territories, and state them. */
export function threatsPhase(pc: PlanCtx, ps: PlanState, input: PlanInput) {
  const src = threatSources(pc, ps, input);
  const forces = threatForces(pc, ps, src);
  const { borders, facing, borderAt, safeAtStart } = borderThreats(pc, ps, input, src, forces);
  const {
    growthOf, deployReaching, reinforcementAt, holdArmies, bombSized, hiddenFoe, hiddenMovable, hiddenPool,
  } = src;
  const { chainAt, stacksAt, forceAt, threatAt, expectedAt, exposure } = forces;
  const seen = visibleOpponents(pc, input);
  return {
    ...seen,
    growthOf,
    deployReaching,
    reinforcementAt,
    holdArmies,
    bombSized,
    hiddenFoe,
    hiddenMovable,
    hiddenPool,
    chainAt,
    stacksAt,
    forceAt,
    threatAt,
    expectedAt,
    exposure,
    borders,
    facing,
    borderAt,
    safeAtStart,
  };
}

/** Rule 1t's trend, the enemy deploys that reach a territory, the fog's hidden stacks and the lost stacks (#164). */
export function threatSources(pc: PlanCtx, ps: PlanState, input: PlanInput) {
  const {
    g, s, game: ctx, foe, custom, estimates, deployOf, territories: state, label, mine, mineSet, unitsAt, guard, bombOn,
    rates, toTake, turnNow,
  } = pc;
  const { warnings, rationale } = ps;
  // ---- 1t. threat trend ----
  // Growth of each visible enemy territory next to me since the previous board
  // (visible both times, same owner, grown): its armies per turn of build-up.
  const growthOf = new Map<number, Growth>();
  if (input.previousBoard) {
    const before = new Map(input.previousBoard.territories.map((t) => [t.territoryId, t]));
    /** Same owner, shown with armies on both boards. */
    const heldBoth = (id: number, player: number) => {
      const a = visibleState(state.get(id));
      const b = visibleState(before.get(id));
      return a?.owner.kind === 'player' && a.owner.playerId === player && b?.owner.kind === 'player' && b.owner.playerId === player;
    };
    // #123: what each enemy territory visibly sent away (its shrink), claimed once (ascending ids)
    // by a growing neighbour of the same owner: that growth was a transfer, a one-off, not a trend.
    // The board cannot tell a fight from a transfer: a shrink beside another player's shrinking
    // stack is read as a fight and explains nothing.
    const shrinkLeft = new Map<number, number>();
    // A neighbour that shrank beside a shrinking stack of another player (me included) may have
    // lost a fight rather than sent armies (as `combatLosses` in the tracker reads it): it explains
    // no growth, so a deploy on the border beside it is still projected.
    const shrankBy = (id: number): { player: number; shrink: number } | null => {
      const a = visibleState(state.get(id));
      const b = visibleState(before.get(id));
      if (a?.owner.kind !== 'player' || b?.owner.kind !== 'player' || a.owner.playerId !== b.owner.playerId) return null;
      return { player: a.owner.playerId, shrink: b.armies! - a.armies! };
    };
    const fought = (id: number, player: number) =>
      neighborsOf(g, id).some((n) => {
        const o = shrankBy(n);
        return o !== null && o.player !== player && o.shrink > 0;
      });
    for (const [id, st] of state)
      if (st.owner.kind === 'player' && foe(st.owner.playerId) && heldBoth(id, st.owner.playerId) && !fought(id, st.owner.playerId))
        shrinkLeft.set(id, Math.max(0, visibleState(before.get(id))!.armies! - st.armies!));
    for (const [id, st] of [...state].sort((a, b) => a[0] - b[0])) {
      if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
      if (!neighborsOf(g, id).some((n) => mineSet.has(n))) continue;
      // Visible both times (#69): a stack hidden last turn only came into view.
      const was = visibleState(before.get(id));
      if (was?.owner.kind !== 'player' || was.owner.playerId !== st.owner.playerId || was.armies === null) continue;
      let growth = st.armies - was.armies;
      if (growth <= 0) continue;
      for (const n of [...neighborsOf(g, id)].sort((a, b) => a - b)) {
        const left = shrinkLeft.get(n);
        if (!left || growth <= 0 || !heldBoth(n, st.owner.playerId)) continue;
        const take = Math.min(left, growth);
        shrinkLeft.set(n, left - take);
        growth -= take;
      }
      // Projected growth never beats what it could have deployed, every ambiguous army read as
      // deploy (#123, `high`): a stack that walked in beside the fog is massing all the same
      // (lesson 5), but growth no deploy or fog arrival explains is not projected.
      const observedHigh = estimates.get(st.owner.playerId)?.observation?.high;
      if (observedHigh !== undefined) growth = Math.min(growth, observedHigh);
      if (growth > 0) growthOf.set(id, { from: was.armies, to: st.armies, growth });
    }
  }
  /** Each opponent's team, in a team game (#128): opponents on one team attack together. */
  const teamOf = new Map<number, number>();
  for (const p of ctx.players ?? []) if (carriesTeam(p.team) && foe(p.id)) teamOf.set(p.id, p.team);
  /**
   * Local Deployment (#128): each opponent's bonuses it visibly holds in full, as deploy pools that
   * land only on their own territories. Empty without Local Deployment or under the override.
   */
  const enemyPools = new Map<number, { value: number; members: ReadonlySet<number> }[]>();
  // #199: the one Local Deployment bound (local-deploy.ts), shared with check_plan's stress test.
  // A what-if `enemyDeploy` is taken as it stands: no pool bounds it.
  if (s.localDeployments && !custom)
    for (const [p, pools] of heldBonusPools(g, (t) => {
      const o = ownerShown(state.get(t))?.owner;
      return o?.kind === 'player' ? o.playerId : undefined;
    }))
      if (foe(p)) enemyPools.set(p, pools);
  /**
   * What `player` may deploy on any of `on` (#128): its whole estimate, except under Local
   * Deployment, where a bonus it visibly holds pays only into that bonus's territories — the
   * estimate less the visible pools it counts (unseen income counts as deployable anywhere) plus
   * the pools that contain one of `on`, never above the estimate. The estimate may leave pools
   * out (the opening board's floor; a negative bonus lowering its bonus income), so only what
   * it holds above its free floor — max({@link MIN_ENEMY_DEPLOY}, base income) — is taken as
   * pooled: the free base always lands anywhere.
   */
  const deployReaching = (player: number, on: readonly number[]): number =>
    enemyDeployReaching(deployOf(player), estimates.get(player)?.base ?? 0, MIN_ENEMY_DEPLOY, enemyPools.get(player) ?? [], on);
  /**
   * #120: what the owner of enemy territory `t` may add there before my attack lands — its deploy
   * estimate (under Local Deployment, what reaches `t`), or its growth there per turn when larger
   * (rule 1t). 0 for a territory no opponent holds.
   */
  const reinforcementAt = (t: number): number => {
    const st = state.get(t);
    if (st?.owner.kind !== 'player' || !foe(st.owner.playerId)) return 0;
    return Math.max(deployReaching(st.owner.playerId, [t]), growthOf.get(t)?.growth ?? 0);
  };
  /** Fewest armies on a territory that hold against `threat` attackers. */
  const holdArmies = (threat: number) => {
    let a = 0;
    while ((toTake(a) ?? Infinity) <= threat) a++;
    return a;
  };
  /**
   * #163: the threat to my `t` as a Bomb would leave it. A Bomb halves my stack before the attack
   * (the smaller half stays; a commander is unharmed), so it holds only with twice the armies: the
   * threat becomes the attack that the doubled stack just holds against. Where toTake is flat
   * across 2·armies+u−1 and 2·armies+u (luck, weighted rounding) no threat maps to a hold of exactly
   * 2·armies+u, so this rounds up to the next hold a threat can express: larger, never smaller.
   * The threat unchanged when no opponent may hold a Bomb.
   */
  const bombSized = (t: number, threat: number) => {
    if (!bombOn) return threat;
    const u = mineSet.has(t) ? unitsAt(t) : 0;
    const armies = Math.max(0, holdArmies(threat) - u);
    return armies > 0 ? Math.max(threat, toTake(2 * armies + u - 1) ?? threat) : threat;
  };
  /** The most defenders one attack of `attackers` takes ({@link toTake}); -1 when it takes none. */
  const reachMemo = new Map<number, number>();
  const takesAlone = (attackers: number): number => {
    if (!reachMemo.has(attackers)) reachMemo.set(attackers, holdArmies(attackers) - 1);
    return reachMemo.get(attackers)!;
  };
  /**
   * The armies a softening attack of `n` kills, in a separate-attack threat: the luck-free share,
   * rounded straight (S2) — deliberately not the game's luck and rounding. Under luck,
   * {@link guaranteedKills} is the fewest kills luck allows, which would understate a threat
   * whose last attack ({@link toTake}) is sized pessimistically for me; the luck-free share is
   * what the softener kills on average, under either rounding.
   */
  const killsOf = (n: number) => guaranteedKills(n, rates.offensiveKillRate, 0, 'StraightRound');
  /**
   * #164: the opponent holding `id` when its owner shows and the fog hides its armies (Dense and
   * Heavy fog): a threat of unknown size, never unseen land and never a target. Else `undefined`.
   */
  function hiddenFoe(id: number): number | undefined {
    const st = state.get(id);
    if (!st || visibleState(st) || !ownerShown(st) || st.owner.kind !== 'player' || !foe(st.owner.playerId)) return undefined;
    return st.owner.playerId;
  }
  /**
   * #164: what a stack of `player` the fog hides may move: its unaccounted armies from the tracker
   * (`unexplained`: earned and not seen since), the guard staying; 0 without a track (the guard alone).
   */
  function hiddenMovable(player: number): number {
    const pool = hiddenPool(player);
    return pool.cap === null ? pool.unexplained : Math.min(pool.unexplained, pool.cap);
  }
  /**
   * #164: the tracker's unaccounted armies of `player` and the cap on what one hidden stack moves,
   * {@link HIDDEN_POOL_INCOMES} turns of its income (`null` without an income figure).
   */
  function hiddenPool(player: number): { unexplained: number; cap: number | null } {
    const tr = input.tracks?.find((x) => x.playerId === player);
    // Its income, a Reinforcement card left out: the card is counted once, in the deploy.
    const e = estimates.get(player);
    const income = Math.max(tr?.income ?? 0, (e?.estimate ?? 0) - (e?.card?.armies ?? 0));
    return {
      unexplained: Math.max(0, Math.floor(tr?.unexplained ?? 0)),
      cap: income > 0 ? HIDDEN_POOL_INCOMES * income : null,
    };
  }
  /**
   * #164: large stacks that left view (the tracker's `lostStacks`, for {@link LOST_STACK_TURNS}
   * turns after the last sighting), by my territory each can attack
   * this turn: one move a turn since the turn it was last seen, never through my land, onto a
   * territory the fog hides next to mine (fogged, or its owner's with the armies hidden). `via` is
   * the nearest such territory (then id); `from` the earliest turn it could attack there.
   */
  const lostAt = new Map<number, { player: number; seenOn: number; turn: number; armies: number; movable: number; via: number; from: number }[]>();
  /** #164: lost stacks that cannot attack my `t` this turn but can stand beside it (`via`) by next turn. */
  const lostSoon: { player: number; seenOn: number; turn: number; armies: number; movable: number; t: number; via: number }[] = [];
  /** #164: arrivals assume one move a turn; under Multi-attack a stack can chain moves and come sooner. */
  const multiNote = s.multiAttack ? ' (one move a turn assumed: with Multi-attack on it can arrive sooner)' : '';
  if (turnNow !== null)
    for (const tr of [...(input.tracks ?? [])].sort((a, b) => a.playerId - b.playerId)) {
      if (!foe(tr.playerId)) continue;
      for (const l of tr.lostStacks ?? []) {
        const elapsed = turnNow - l.turn;
        const movable = Math.max(0, l.armies - guard);
        if (elapsed < 1 || elapsed > LOST_STACK_TURNS || movable <= 0 || !g.territoryById.has(l.territoryId)) continue;
        const dist = bfsDistances(g, [l.territoryId], { passable: (x) => !mineSet.has(x) });
        for (const t of mine) {
          const via = neighborsOf(g, t)
            .filter((n) => {
              const d = dist.get(n);
              if (d === undefined || d > elapsed || mineSet.has(n) || visibleState(state.get(n))) return false;
              const o = ownerShown(state.get(n))?.owner;
              return o === undefined || (o.kind === 'player' && o.playerId === tr.playerId);
            })
            .sort((a, b) => dist.get(a)! - dist.get(b)! || a - b)[0];
          if (via === undefined) {
            // Not there yet: where it can stand next to `t` by next turn (a territory beside `t`
            // it can reach in one more move), warned of a turn ahead.
            if (elapsed + 1 > LOST_STACK_TURNS) continue;
            const soon = neighborsOf(g, t)
              .filter((n) => !mineSet.has(n) && (dist.get(n) ?? Infinity) <= elapsed + 1)
              .sort((a, b) => dist.get(a)! - dist.get(b)! || a - b)[0];
            if (soon !== undefined)
              lostSoon.push({ player: tr.playerId, seenOn: l.territoryId, turn: l.turn, armies: l.armies, movable, t, via: soon });
            continue;
          }
          lostAt.set(t, [
            ...(lostAt.get(t) ?? []),
            { player: tr.playerId, seenOn: l.territoryId, turn: l.turn, armies: l.armies, movable, via, from: l.turn + dist.get(via)! },
          ]);
        }
      }
    }
  {
    // One line per stack, naming each border it reaches (the first MAX_NAMED_REVEALS, then a count).
    const byStack = new Map<string, { l: { player: number; seenOn: number; turn: number; armies: number; movable: number }; at: string[] }>();
    for (const [t, ls] of [...lostAt].sort((a, b) => a[0] - b[0]))
      for (const l of ls) {
        const key = `${l.player}|${l.seenOn}|${l.turn}`;
        const e = byStack.get(key) ?? { l, at: [] };
        e.at.push(`${label(t)} from turn ${l.from} (through ${label(l.via)})`);
        byStack.set(key, e);
      }
    for (const { l, at } of byStack.values()) {
      const more = at.length > MAX_NAMED_REVEALS ? ` and ${at.length - MAX_NAMED_REVEALS} more` : '';
      rationale.push(
        `Player ${l.player}'s stack of ${l.armies} armies last seen on ${label(l.seenOn)} on turn ${l.turn} left view: it can attack ${at.slice(0, MAX_NAMED_REVEALS).join(', ')}${more}, so each one's worst case counts it as a separate threat of ${l.movable}${multiNote}.`,
      );
    }
    // A turn ahead: one warning per stack, naming each border it can stand beside by next turn.
    const soonBy = new Map<string, { l: (typeof lostSoon)[number]; at: string[] }>();
    for (const l of lostSoon) {
      const key = `${l.player}|${l.seenOn}|${l.turn}`;
      const e = soonBy.get(key) ?? { l, at: [] };
      e.at.push(`${label(l.via)}, next to my ${label(l.t)}`);
      soonBy.set(key, e);
    }
    for (const { l, at } of soonBy.values()) {
      const more = at.length > MAX_NAMED_REVEALS ? ` and ${at.length - MAX_NAMED_REVEALS} more` : '';
      warnings.push(
        `Player ${l.player}'s stack of ${l.armies} armies last seen on ${label(l.seenOn)} on turn ${l.turn} is out of view and can stand on ${at.slice(0, MAX_NAMED_REVEALS).join('; ')}${more}, by next turn, and attack the turn after with up to ${l.movable} plus its deploy: not counted in this turn's holds${multiNote}.`,
      );
    }
  }
  return {
    growthOf,
    teamOf,
    deployReaching,
    reinforcementAt,
    holdArmies,
    bombSized,
    takesAlone,
    killsOf,
    hiddenFoe,
    hiddenMovable,
    hiddenPool,
    lostAt,
  };
}

/** What each opponent can bring against one territory: its stacks, its deploy, its Multi-Attack chains (#199). */
export function threatForces(pc: PlanCtx, ps: PlanState, src: ThreatSources) {
  const { g, board, s, foe, territories: state, mineSet, unitsAt, guard, rates, toTake, ffaLeader } = pc;
  const { captured } = ps;
  const {
    growthOf, teamOf, deployReaching, holdArmies, bombSized, takesAlone, killsOf, hiddenFoe, hiddenMovable, lostAt,
  } = src;
  /**
   * #199: under Multi-Attack, every visible enemy stack's attack chains ({@link searchChains}: its
   * deploy that reaches it, less the guard, its commander left behind; luck-free, capped) that take
   * one territory or more not mine and then attack a territory — of mine, or one this plan may
   * capture (a territory not its player's own) — by that territory, most armies first. With
   * `standing`, the stack's armies alone, no deploy: armies already there, for the floor tier.
   * Built on first use; empty without Multi-Attack.
   */
  const chainMemo = new Map<boolean, Map<number, ChainThreat[]>>();
  const chainsOnto = (t: number, standing = false): readonly ChainThreat[] => {
    if (!s.multiAttack) return [];
    let memo = chainMemo.get(standing);
    if (!memo) {
      memo = new Map<number, ChainThreat[]>();
      chainMemo.set(standing, memo);
      const sim = simTerritories(board);
      for (const [n, st] of [...state].sort((a, b) => a[0] - b[0])) {
        if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null || hiddenFoe(n) !== undefined) continue;
        const player = st.owner.playerId;
        const team = teamOf.get(player);
        searchChains({
          graph: g,
          territories: sim,
          from: n,
          sending: Math.max(0, st.armies - guard) + (standing ? 0 : deployReaching(player, [n])),
          guard,
          ...rates,
          hostile: (_id, x) => x.owner === 'neutral' || (typeof x.owner === 'number' && x.owner !== player && (team === undefined || teamOf.get(x.owner) !== team)),
          goOn: (id) => !mineSet.has(id),
          onAttack: (a) => {
            const to = a.path[a.path.length - 1]!;
            if (a.path.length < 3) return;
            memo!.set(to, [...(memo!.get(to) ?? []), { player, path: a.path, armies: a.sending }]);
          },
        });
      }
      for (const list of memo.values()) list.sort((a, b) => b.armies - a.armies || a.player - b.player || a.path.join().localeCompare(b.path.join()));
    }
    return memo.get(t) ?? [];
  };
  /**
   * #199: the strongest chain onto `t` (mine, or a capture) that passes through no territory in
   * `gone`; with `standing`, of the stack's armies alone, no deploy.
   */
  const chainAt = (t: number, gone: (n: number) => boolean, standing = false): ChainThreat | undefined =>
    chainsOnto(t, standing).find((c) => !c.path.some((x) => x !== t && gone(x)));
  /**
   * The enemy force that can hit my `t` next turn (#128). Per opponent: each of its stacks next
   * to `t` (territories in `gone` excluded) is movable armies plus its units, and it may deploy
   * {@link deployReaching} there — onto one stack — plus, with `trend`, its fastest growth when
   * larger. One attack of all of it is the old model (a transfer then an attack); separate attacks
   * each round on their own, so a 1-army softener kills 1 at 60% and the last attack takes the
   * rest: the force reaches max over the last attack L of Σ kills(others) + reach(L). With
   * `allPlayers`, every opponent next to `t` may attack it in the same turn (worst case); else
   * each opponent alone. `player` is the strongest one alone. `null` with no opponent next to it.
   */
  /**
   * Per opponent, its stacks next to my `t` (territories in `gone` excluded) and what each may
   * move: visible stacks their movable armies and units; #164's hidden stacks its unaccounted
   * armies, once per border (its first hidden stack carries them); stacks that left view
   * ({@link lostAt}), the pool's carrier keeping what they leave of it. With `trend`, its fastest
   * growth there. Shared by {@link forceAt} and the floor tier's armies already next to a border.
   */
  const stacksAt = (t: number, gone: (n: number) => boolean, trend: boolean) => {
    const byPlayer = new Map<number, { stacks: { id: number; movable: number }[]; growth: number }>();
    // #164: a player's unaccounted armies are one pool, in one place at most: its first hidden stack
    // next to `t` carries them; any other hidden stack of it there is the guard alone (movable 0).
    const pooled = new Set<number>();
    const carrier = new Map<number, number>();
    for (const n of [...neighborsOf(g, t)].sort(byNum)) {
      const st = state.get(n);
      if (gone(n) || st?.owner.kind !== 'player' || !foe(st.owner.playerId)) continue;
      // #164: an owner shown with its armies hidden (Dense / Heavy fog) is a stack of bounded size.
      const hidden = hiddenFoe(n) !== undefined;
      if (st.armies === null && !hidden) continue;
      const p = byPlayer.get(st.owner.playerId) ?? { stacks: [], growth: 0 };
      // An enemy commander can join the attack: it fights as COMMANDER_STRENGTH armies.
      const movable = !hidden
        ? Math.max(0, st.armies! - guard) + unitsAt(n)
        : pooled.has(st.owner.playerId)
          ? 0
          : hiddenMovable(st.owner.playerId);
      if (hidden && !pooled.has(st.owner.playerId)) carrier.set(st.owner.playerId, n);
      if (hidden) pooled.add(st.owner.playerId);
      p.stacks.push({ id: n, movable });
      if (trend && !hidden) p.growth = Math.max(p.growth, growthOf.get(n)?.growth ?? 0);
      byPlayer.set(st.owner.playerId, p);
    }
    // #164: a large stack that left view and can stand next to `t` by now: a separate stack of its owner.
    for (const l of lostAt.get(t) ?? []) {
      if (gone(l.via)) continue;
      const p = byPlayer.get(l.player) ?? { stacks: [], growth: 0 };
      const there = p.stacks.find((x) => x.id === l.via);
      if (there) there.movable = Math.max(there.movable, l.movable);
      else p.stacks.push({ id: l.via, movable: l.movable });
      byPlayer.set(l.player, p);
    }
    // #164: a lost stack's armies left the visible total, so they are part of its owner's
    // unaccounted armies: the pool's carrier keeps only what the lost stacks elsewhere on this
    // border leave of it, so the two together are never more than the larger. A lost stack via the
    // carrier itself is a stack seen there: the carrier keeps at least it.
    for (const [player, id] of carrier) {
      const p = byPlayer.get(player)!;
      const theirs = (lostAt.get(t) ?? []).filter((l) => l.player === player && !gone(l.via));
      const lostElsewhere = theirs.filter((l) => l.via !== id);
      if (!lostElsewhere.length) continue;
      const c = p.stacks.find((x) => x.id === id)!;
      const viaCarrier = theirs.filter((l) => l.via === id).reduce((n, l) => Math.max(n, l.movable), 0);
      const pool = hiddenMovable(player);
      c.movable = Math.max(viaCarrier, pool - lostElsewhere.reduce((n, l) => n + l.movable, 0));
    }
    return byPlayer;
  };
  /**
   * #199: the force of a Multi-Attack chain onto my `t`: its player's, its armies all of it (the
   * deploy that reaches its stack is already inside them), no growth or separate deploy.
   */
  const chainForce = (t: number, chain: ChainThreat): Force => ({
    player: chain.player,
    movable: chain.armies,
    growth: 0,
    deploy: 0,
    threat: bombSized(t, chain.armies),
    chain,
  });
  const forceAt = (
    t: number,
    gone: (n: number) => boolean,
    o: { trend: boolean; allPlayers: boolean; pileOn?: boolean },
  ): Force | null => {
    const byPlayer = stacksAt(t, gone, o.trend);
    const chain = chainAt(t, gone);
    if (!byPlayer.size) return chain ? chainForce(t, chain) : null;
    const each = [...byPlayer]
      .sort((a, b) => a[0] - b[0])
      .map(([player, p]) => {
        const deploy = deployReaching(player, p.stacks.map((x) => x.id));
        const movable = p.stacks.reduce((n, x) => n + x.movable, 0);
        const add = Math.max(deploy, p.growth);
        return { player, stacks: p.stacks, growth: p.growth, deploy, movable, add, single: movable + add };
      });
    const best = [...each].sort((a, b) => b.single - a.single || a.player - b.player)[0]!;
    // Separate attacks: try each stack as the last attack, its owner's deploy on it; every other
    // opponent in the group lands its deploy on its own largest stack.
    let split: Force['split'];
    let splitTakes = -1;
    // Opponents on one team coordinate; players of an FFA each attack alone (two of them landing
    // on one border in the same turn is a warning, {@link pileOnAt}, not a hold).
    const groups: (typeof each)[] = [];
    for (const e of each) {
      const team = o.allPlayers ? teamOf.get(e.player) : undefined;
      const mates = team === undefined ? undefined : groups.find((gr) => teamOf.get(gr[0]!.player) === team);
      if (mates) mates.push(e);
      else groups.push([e]);
    }
    // #201: the FFA leader holds against every adjacent opponent together.
    if (o.pileOn || (o.allPlayers && ffaLeader)) groups.splice(0, groups.length, each);
    for (const group of groups) {
      const count = group.reduce((n, e) => n + e.stacks.length, 0);
      if (count < 2) continue;
      for (const last of group)
        for (const L of last.stacks) {
          const attacks: number[] = [];
          for (const e of group) {
            const big = [...e.stacks].sort((a, b) => b.movable - a.movable || a.id - b.id)[0]!;
            const on = e === last ? L : big;
            for (const x of e.stacks) if (x !== L) attacks.push(x.movable + (x === on ? e.add : 0));
          }
          const lastArmies = L.movable + last.add;
          const softeners = attacks.filter((a) => a > 0);
          const takes = softeners.reduce((n, a) => n + killsOf(a), 0) + takesAlone(lastArmies);
          if (takes > splitTakes) {
            splitTakes = takes;
            split = { attacks: [...softeners, lastArmies], takes, players: group.map((e) => e.player) };
          }
        }
    }
    let threat = best.single;
    if (split && split.takes > takesAlone(best.single)) threat = Math.max(threat, toTake(split.takes) ?? threat);
    else split = undefined;
    // #199: a Multi-Attack chain that lands more than the stacks next to it is the threat, and
    // the force is its player's: the chain (its deploy included) is all of it.
    if (chain && chain.armies > threat) return chainForce(t, chain);
    return {
      player: best.player,
      movable: best.movable,
      growth: best.growth,
      deploy: best.deploy,
      // #163: sized as if a Bomb halved my stack first ({@link bombSized}).
      threat: bombSized(t, threat),
      ...(split ? { split } : {}),
    };
  };
  /**
   * The strongest visible enemy force that could hit `t` next turn ({@link forceAt}, every
   * opponent next to it, trend included). `null` with no enemy next to it.
   */
  const threatAt = (t: number, gone: (n: number) => boolean): { player: number; threat: number } | null => {
    const f = forceAt(t, gone, { trend: true, allPlayers: true });
    return f ? { player: f.player, threat: f.threat } : null;
  };
  /**
   * The expected (not worst-case) attack on my `t` next turn (issue #59): per player, its
   * movable armies (and units, #128) next to `t` plus its deploy estimate — no trend projection,
   * one opponent at a time, its stacks attacking separately when that takes more. 0 with none.
   */
  const expectedAt = (t: number): number =>
    forceAt(t, (n) => captured.has(n), { trend: false, allPlayers: false })?.threat ?? 0;
  /** Members of a bonus I would hold that a visible enemy could take next turn, given the armies staying on each. */
  const exposure = (members: readonly number[], gone: (n: number) => boolean, stays: (m: number) => number): Exposure[] => {
    const out: Exposure[] = [];
    for (const m of members) {
      const th = threatAt(m, gone);
      if (!th) continue;
      // My commander defends with the armies on my territory (a capture's units were the enemy's).
      const have = stays(m) + (mineSet.has(m) ? unitsAt(m) : 0);
      const take = toTake(have);
      if (take === null || take > th.threat) continue;
      out.push({ id: m, player: th.player, take, need: holdArmies(th.threat) - have });
    }
    return out;
  };
  return {
    chainAt,
    stacksAt,
    forceAt,
    threatAt,
    expectedAt,
    exposure,
  };
}

/** Rule 1's borders: the strongest force next to each territory of mine, stated in the rationale. */
export function borderThreats(pc: PlanCtx, ps: PlanState, input: PlanInput, src: ThreatSources, forces: ThreatForces) {
  const {
    g, board, game: ctx, foe, custom, estimates, incomePrior, enemyDeploy, territories: state, label, mine, mineSet,
    armiesOf, unitsAt, uncounted, uncountedKind, bombOn, toTake, turnNow, holdPasses, myCommanders, s, baseIncome, rates,
  } = pc;
  const { warnings, rationale } = ps;
  const { growthOf, holdArmies, hiddenFoe, lostAt } = src;
  /** #226: the game pays per territory (BonusArmyPer). */
  const perTerritory = (s.bonusArmyPer ?? 0) > 0;
  /** #226: what the bonuses it could still hold add to what it could earn (its territories' pay aside). */
  const possibleOf = (e: EnemyDeployEstimate) => e.couldEarn - territoryIncome(e.couldHold, baseIncome, s.bonusArmyPer ?? 0);
  const { forceAt } = forces;
  // ---- 1. defence ----
  const borders = new Map<number, Border>();
  /** Every visible enemy player with a stack next to one of my territories. */
  const facing = new Set<number>();
  /**
   * The strongest visible enemy threat to my `t` (territories in `gone` excluded), or `null` with none
   * next to it. Pure: callers judge hypothetical boards with it, so what a border is actually sized
   * for (its `worst` included, #201) is read from `borders`, never from a side table.
   */
  const borderAt = (t: number, gone: (n: number) => boolean): Border | null => {
    const f = forceAt(t, gone, { trend: true, allPlayers: true });
    if (!f) return null;
    // #201, behind: sized for the expected attack (#59's {@link expectedAt}: every adjacent player's
    // movable armies next to it plus its whole deploy estimate, the largest of them), not the worst
    // case — the trend projection above the deploy. The deploy is counted in full on each border, so
    // no border is left short of what one deploy landing there takes: the gamble is only the growth
    // trend above the deploy, and with none it is a no-op. (Sizing for the movable stacks alone broke
    // #118, and one stack beside two such borders splits its deploy to take both.) Separate attacks, Multi-Attack
    // chains and Bomb sizing are no gamble here (they keep the worst case), nor my commander's
    // territory (rule 1k holds it against the whole deploy), nor an `enemyDeploy` override.
    if (holdPasses === 'expected' && !myCommanders.has(t) && !f.split && !f.chain && !bombOn && !custom) {
      const e = forceAt(t, gone, { trend: false, allPlayers: true });
      if (e && !e.split && !e.chain && e.threat < f.threat) return { id: t, ...f, threat: e.threat, worst: f.threat };
    }
    return { id: t, ...f };
  };
  for (const t of mine) {
    for (const n of neighborsOf(g, t)) {
      const st = state.get(n);
      if (st?.owner.kind === 'player' && foe(st.owner.playerId) && (st.armies !== null || hiddenFoe(n) !== undefined)) facing.add(st.owner.playerId);
    }
    for (const l of lostAt.get(t) ?? []) if (estimates.has(l.player)) facing.add(l.player);
    const b = borderAt(t, () => false);
    if (b) borders.set(t, b);
  }
  // #199: say where a Multi-Attack chain sets a border's threat.
  for (const b of [...borders.values()].filter((x) => x.chain).sort((x, y) => y.chain!.armies - x.chain!.armies || x.id - y.id).slice(0, MAX_NAMED_REVEALS)) {
    const c = b.chain!;
    const via = c.path.slice(1, -1).map(label).join(' then ');
    warnings.push(
      `Multi-Attack chain: player ${c.player}'s stack on ${label(c.path[0]!)} can take ${via} and attack ${label(b.id)} with ~${c.armies} armies (its deploy included, luck-free): that is the threat counted there.`,
    );
  }
  // #128: an enemy unit the board gives no strength for is in no threat: say so.
  for (const e of [...state.keys()].sort(byNum)) {
    const st = state.get(e)!;
    if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || !uncounted(e)) continue;
    const next = neighborsOf(g, e).filter((n) => mineSet.has(n));
    if (next.length)
      warnings.push(
        `${label(e)} (player ${st.owner.playerId}) holds ${uncountedKind(e)}, whose strength the board does not carry: the threat to ${next.map(label).join(', ')} counts its armies only.`,
      );
  }
  /**
   * Borders that hold at the start of the turn on the armies they have (#121): their surplus is
   * what they hold beyond that, and a capture from one keeps what holds it.
   */
  const safeAtStart = new Set(
    [...borders.values()]
      .filter((b) => (toTake(armiesOf(b.id) + unitsAt(b.id)) ?? Infinity) > b.threat)
      .map((b) => b.id),
  );
  for (const [e, gr] of growthOf) {
    // Name the most exposed of my territories next to it (fewest armies, then id).
    const t = neighborsOf(g, e)
      .filter((n) => mineSet.has(n))
      .sort((a, b) => armiesOf(a) - armiesOf(b) || a - b)[0]!;
    const b = borders.get(t)!;
    const next = b.movable + Math.max(b.deploy, b.growth);
    const after = b.movable + b.growth + Math.max(b.deploy, b.growth);
    warnings.push(
      `${label(e)} is building: +${gr.growth}/turn (${gr.from} → ${gr.to}); at this rate ${label(t)} needs ${holdArmies(next)} to hold next turn and ${holdArmies(after)} the turn after`,
    );
  }
  for (const b of borders.values())
    if (b.growth > b.deploy)
      rationale.push(
        `Threat on ${label(b.id)} uses the trend: player ${b.player}'s stack next to it grows +${b.growth}/turn, more than the ~${b.deploy} deploy estimate, so ~${b.threat}.`,
      );
  if (borders.size) {
    if (custom)
      warnings.push(
        `Enemy deploy estimate: threat checks assume ~${enemyDeploy} (your estimate); enemy income is unknown, so they could deploy more.`,
      );
    else {
      const opening = openingArmies(g, board, { turn: turnNow, previous: input.previousBoard });
      // #199: a player whose only threat is a chain has its deploy inside that chain: explain it too.
      const estimated = new Set(facing);
      for (const b of borders.values()) if (b.chain && estimates.has(b.chain.player)) estimated.add(b.chain.player);
      for (const p of [...estimated].sort(byNum)) {
        const e = estimates.get(p)!;
        const visible = `base ${e.base} + visible bonuses +${e.bonusIncome} = ${e.base + e.bonusIncome}`;
        if (e.observation) {
          const o = e.observation;
          const turns = input.turn !== undefined ? `turn ${input.turn - 1} → turn ${input.turn}` : 'previous board → this board';
          const shown = o.reveals.slice(0, MAX_NAMED_REVEALS).map(label).join(', ');
          const more = o.reveals.length > MAX_NAMED_REVEALS ? ` and ${o.reveals.length - MAX_NAMED_REVEALS} more` : '';
          // #226: my failed attack's kills, counted back into what stood there.
          if (o.attacked.length)
            rationale.push(
              `Player ${p}: my failed attack${o.attacked.length === 1 ? '' : 's'} on ${o.attacked.map(label).join(', ')} killed ~${o.attackKills} of its defenders (at the ${rates.offensiveKillRate}% kill rate, from the orders I sent last turn), which stood there too: they count back into its observed deploy (after + kills − before, a lower bound${o.grewFromFog.some((x) => o.attacked.includes(x)) ? '; beside the fog, read as deploy only up to the turn\'s bound' : ''}).`,
            );
          // #226: in a per-territory game a large reveal says it holds more than is in view; still not income.
          const revealed = o.reveals.reduce((n, id) => n + armiesOf(id), 0);
          if (perTerritory && revealed > e.estimate - (e.card?.armies ?? 0))
            warnings.push(
              `Player ${p}: ${revealed} armies came into view on ${o.reveals.length} ${o.reveals.length === 1 ? 'territory' : 'territories'} (fog reveals, not income); with income per territory, stacks that size say it holds more territories than the ${e.held} in view, so its ~${e.estimate - (e.card?.armies ?? 0)} estimate may be far too low.`,
            );
          rationale.push(
            `Observed deploy for player ${p}, ${turns}: +${e.observedRaw}/turn over ${o.counted.length} territories visible on both boards (${o.captured.length} captured${o.captured.length ? `, ${o.fromFog.length} from the fog` : ''}); ${o.reveals.length} skipped as fog reveals${o.reveals.length ? ` (${shown}${more}): not shown with an owner and armies last turn (fogged, armies hidden, or not yet picked), so what they hold is not income` : ''}.`,
          );
          // A stack that arrived from the fog by a capture is a threat, never income (#86).
          for (const id of o.fromFog) {
            const where = neighborsOf(g, id).some((n) => mineSet.has(n)) ? 'stack next to you' : 'stack';
            rationale.push(
              `Player ${p}'s ${where}: ${armiesOf(id)} on ${label(id)} (threat), arrived from the fog by a capture: a move, not income.`,
            );
          }
          // #123: the ambiguous readings, each named with the other way it could read.
          if (o.grewFromFog.length) {
            rationale.push(
              `Player ${p}: ${o.fogGrowth} of its growth on ${o.grewFromFog.map(label).join(', ')} (beyond twice the ~${o.expected} it was expected to deploy) is next to the fog: read as a move out of the fog, not income — though it may be income the fog hides (observed +${o.low}–${o.high} either way).`,
            );
          }
          if (o.reinforced.length)
            rationale.push(
              `Player ${p} took ${o.reinforced.map(label).join(', ')} with more than its visible stack next to ${o.reinforced.length === 1 ? 'it' : 'them'} sent: read as armies deployed on that stack before it attacked (deploy-then-capture), though a stack out of the fog may have joined (observed +${o.low}–${o.high} either way).`,
            );
          if (o.emptied.length)
            rationale.push(
              `Player ${p} took ${o.emptied.map(label).join(', ')} from you: priced at what the guard you may have left there kills, not your stack last turn (you may have attacked out of it); had it all stood there, it deployed +${o.high}.`,
            );
          if (o.fromFog.length) {
            const n = o.fromFog.length;
            rationale.push(
              `Player ${p}'s estimated income: ~${e.estimate - (e.card?.armies ?? 0)}/turn (${n} ${n === 1 ? 'stack' : 'stacks'} that arrived from the fog not counted in it).`,
            );
          }
          if (e.observedRaw! > e.observedCap!)
            warnings.push(
              `player ${p} was observed to deploy +${e.observedRaw}/turn, more than it could earn on this board (${
                perTerritory && e.observedCap! - possibleOf(e) > e.base
                  ? `${e.observedCap! - possibleOf(e)} for the ${e.couldHold} territories it could hold: its ${e.held} visible and ${e.couldHold - e.held} whose owner is hidden`
                  : `base ${e.base} for its ${e.held} visible territories`
              } + bonuses it could still hold +${possibleOf(e)} = ${e.observedCap}): capped at ${e.observedCap}. Armies moved in from the fog, a Reinforcement card, or a bonus it has lost since may explain the rest.`,
            );
        }
        if (e.tracked !== null) {
          const track = input.tracks!.find((t) => t.playerId === p)!;
          const used = track.turns.filter((x) => e.trackedTurns.includes(x.from));
          rationale.push(
            `Tracked income for player ${p}: ~${e.tracked}/turn (${incomeBasis(track)}): ${used.map((x) => `turn ${x.from} +${x.observed}`).join(', ')}, each observed deploy a lower bound under fog; at least its visible base + bonuses ${track.visibleIncome}; used in place of the single-turn observed figure (warapp_track_opponents has the details).`,
          );
        }
        // #164: a Reinforcement card the clock says it may hold, on top of its income.
        if (e.card)
          warnings.push(
            `Player ${p} may hold a Reinforcement card from turn ${e.card.due} (the card clock${e.cardPlayed !== null ? `; it last played one on turn ${e.cardPlayed}` : ''}): +${e.card.armies} added to its deploy, ~${e.estimate} in all, until a deployment above its income is seen; one card at most is counted, though more may be in hand after a long time due.`,
          );
        else if (e.cardPlayed !== null)
          warnings.push(
            e.source === 'exact'
              ? `Player ${p}'s Reinforcement card is taken as played on turn ${e.cardPlayed} (a deployment above its exact income), so none is added until the next can be due; armies the board misread, or that moved into view out of a territory whose armies the fog hid, can look the same, so it may still hold one and the estimate errs low.`
              : `Player ${p}'s Reinforcement card is taken as played on turn ${e.cardPlayed} (a deployment of a card's armies over its visible income), so none is added until the next can be due; income the fog hides can look the same, so it may still hold one and the estimate errs low.`,
          );
        // #164: the income behind the estimate; a card the clock adds is named on top of it.
        const income = e.estimate - (e.card?.armies ?? 0);
        const withCard = e.card ? `, plus +${e.card.armies} from its Reinforcement card (~${e.estimate} in all)` : '';
        if (e.source === 'exact') {
          warnings.push(
            `Enemy deploy estimate for player ${p}: ~${income} (exact: under ${ctx.fog} every territory's owner shows, so its income is ${visible}${e.observed !== null && e.observed > income ? `; the +${e.observed} observed above it is a card or armies the board misread, not income` : ''}); only the army cap, Sanctions and a Reinforcement card are unknown.`,
          );
          continue;
        }
        if (e.source === 'prior') {
          warnings.push(
            `Enemy deploy estimate for player ${p}: ~${income} (a prior, not an observation: ${
              (incomePrior!.opening?.get(p) ?? -1) > incomePrior!.myIncome
                ? `its opening simulated from the starts the award of picks proved earns ${incomePrior!.opening!.get(p)} this turn`
                : `in ${incomePrior!.format === 'ffa' ? 'a free-for-all that started even (no teams, every player still in)' : 'a 1v1 that started even'}, an opponent bordering the fog is assumed to earn at least my own income ${incomePrior!.myIncome}`
            }, capped at the most it could earn on this board, ${e.couldEarn}; ${visible}${e.tracked !== null ? `, tracked ~${e.tracked}` : e.observed !== null ? `, observed +${e.observed}/turn` : ''})${withCard}; observed deploys are lower bounds under fog, and it could deploy more.`,
          );
          continue;
        }
        if (e.source === 'tracked') {
          warnings.push(
            `Enemy deploy estimate for player ${p}: ~${income} (tracked over ${e.trackedTurns.length} observed turns, more than ${visible})${withCard}; it holds income the fog hides, and could deploy more.`,
          );
          continue;
        }
        if (e.source === 'observed') {
          warnings.push(
            `Enemy deploy estimate for player ${p}: ~${income} (observed +${e.observed}/turn: the net growth of its territories visible on both boards plus what its captures from a visible owner cost it, more than ${visible})${withCard}; it holds income the fog hides, and could deploy more.`,
          );
          continue;
        }
        const seen = e.observed !== null ? ` Its deploy was observed +${e.observed}/turn since last turn, below that.` : '';
        warnings.push(
          (opening !== null
            ? `Enemy deploy estimate for player ${p}: ~${income} (opening board: every visible player territory holds ${opening}, so no one has deployed yet and every opponent gets its base income, at least ${MIN_ENEMY_DEPLOY})${withCard}; enemy income is unknown, so they could deploy more.`
            : `Enemy deploy estimate for player ${p}: ~${income} (${visible}, at least max(${MIN_ENEMY_DEPLOY}, base); its largest stack next to me (${e.largestStack}) is what can move, not a limit on what it deploys)${withCard}; enemy income beyond its visible bonuses is unknown, so they could deploy more.`) + seen,
        );
      }
    }
  }
  return {
    borders,
    facing,
    borderAt,
    safeAtStart,
  };
}

/**
 * The opponents in view (rule 1e, #45): each visible opponent's territories, the fog's edge, and
 * the weak ones — fully visible, fewer territories than mine, a deploy below my income — with the
 * territories of mine just taken from one. Pure: read from the board at the start of the turn.
 */
export function visibleOpponents(pc: PlanCtx, input: PlanInput) {
  const { g, me, foe, territories: state, mine, mineSet, deployOf, income } = pc;
  // Visible enemy territories by owner, sorted.
  const ownedBy = new Map<number, number[]>();
  for (const [id, st] of [...state].sort((a, b) => a[0] - b[0])) {
    if (st.owner.kind !== 'player' || !foe(st.owner.playerId) || st.armies === null) continue;
    ownedBy.set(st.owner.playerId, [...(ownedBy.get(st.owner.playerId) ?? []), id]);
  }
  const ownerOf = (id: number) => {
    const o = state.get(id)?.owner;
    return o?.kind === 'player' ? o.playerId : undefined;
  };
  const hidden = (n: number) => {
    const st = state.get(n);
    return !st || st.owner.kind === 'unknown' || st.armies === null;
  };
  // Anything on the board hidden: an opponent may hold territories there no visible one borders.
  const fogAnywhere = [...g.territoryById.keys()].some(hidden);
  /** Its territories with a fogged neighbour: it may hold more in the fog. */
  const fogEdge = (p: number) => ownedBy.get(p)!.filter((t) => neighborsOf(g, t).some(hidden));
  const inReach = (p: number) => ownedBy.get(p)!.every((t) => neighborsOf(g, t).some((n) => mineSet.has(n)));
  /** Fully visible, fewer territories than mine, and a deploy below my income. */
  const weak = new Set(
    [...ownedBy.keys()].filter(
      (p) => !fogEdge(p).length && ownedBy.get(p)!.length < mine.length && deployOf(p) < income,
    ),
  );
  const previousOwner = new Map(
    (input.previousBoard?.territories ?? []).flatMap((t) =>
      t.owner.kind === 'player' ? [[t.territoryId, t.owner.playerId] as const] : [],
    ),
  );
  /** The weak opponent that held my `id` on the previous board, if any. */
  const recentlyTakenFrom = (id: number): number | undefined => {
    const p = previousOwner.get(id);
    return p !== undefined && p !== me && weak.has(p) ? p : undefined;
  };
  return { ownedBy, ownerOf, hidden, fogAnywhere, fogEdge, inReach, weak, previousOwner, recentlyTakenFrom };
}
