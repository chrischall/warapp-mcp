// The estimates phase of a planning pass (#133): everything planTurn derives from its input before
// the first order — the opponents' deploy estimates and the fog prior (#119), the game profile and
// the goal it picks (rule 0p), the combat model and capture costs (S2, #126), what the board's
// territories are worth (#70, #85, #125), where I stand on armies (#167, #201, rule 0p.3) — and the
// rationale and warnings that state them. Pure: it reads the input and writes only
// `state.warnings` / `state.rationale`.
import type { BoardState } from '../../board.js';
import { holdsSeat } from '../../player-states.js';
import { carriesTeam } from '../../teams.js';
import { bonusTerritories } from '../bonuses.js';
import { CHAIN_MAX_STEPS } from '../chains.js';
import {
  armiesForChance,
  armiesToTake,
  DEFAULT_DEFENSIVE_KILL_RATE,
  DEFAULT_OFFENSIVE_KILL_RATE,
  luckFraction,
  specialUnitStrength,
  straightKills,
  winChance,
} from '../combat.js';
import { neighborsOf, type MapGraph } from '../graph.js';
import type { MyOrders, OpponentTrack } from '../opponents.js';
import { OUTLOOK_TURNS } from '../outlook.js';
import { boardIncome, DEFAULT_BASE_INCOME } from '../player.js';
import {
  AHEAD_PRESSURE_FACTOR,
  captureCost,
  combatSettings,
  DECIDED_PAYBACK_MIN,
  defaultMinWinChance,
  enemyDeployEstimates,
  HOLD_FALL_CHANCE,
  LUCK_WIN_CHANCE,
  MIN_ENEMY_DEPLOY,
  minWinChanceOf,
  ownerShown,
  PAYBACK_TURNS,
  PRESSURE_FACTOR,
  pressureMargin,
  SECOND_FRONT_LEAD,
  visibleState,
  type EnemyDeployEstimate,
  type EnemyIncomePrior,
  type PlanGameContext,
  type PlanGoal,
  type PlanInput,
  type PlannerSettings,
  type TurnPlan,
} from './shared.js';
import { AHEAD_RATIO, BEHIND_RATIO, gameProfile, type ProfilePlayer } from '../profile.js';
import type { BoardCtx, CombatCtx, OpponentsCtx, PlanCtx, PlanState, StandingCtx } from './state.js';
import { byNum } from './util.js';

/**
 * The fog prior to apply (#119, {@link EnemyIncomePrior}): only when the game says the start was
 * symmetric (`symmetricStart`), with no teams, and every seated player still playing — a 1v1 (one
 * opponent), or (#226) a free-for-all, where every opponent beside the fog gets the same prior. A
 * game with a player out (eliminated, booted, surrendered) gets none: a survivor may have absorbed
 * its territories, or I may have, so the start no longer says who earns what. Without a player list,
 * only one opponent in sight counts (a 1v1 as far as the board tells).
 */
function fogPrior(board: BoardState, me: number, ctx: PlanGameContext, myIncome: number): EnemyIncomePrior | undefined {
  if (ctx.symmetricStart !== true) return undefined;
  const players = (ctx.players ?? []).filter((p) => holdsSeat(p.state));
  if (players.some((p) => carriesTeam(p.team))) return undefined;
  if (players.some((p) => (p.state ?? 'Playing') !== 'Playing' && p.id !== me)) return undefined;
  const opponents = players.length
    ? players.filter((p) => p.id !== me).length
    : new Set(board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId !== me ? [t.owner.playerId] : []))).size;
  if (opponents < 1 || (!players.length && opponents !== 1)) return undefined;
  return {
    myIncome: Math.max(0, myIncome),
    ...(opponents > 1 ? { format: 'ffa' as const } : {}),
    ...(ctx.opening ? { opening: ctx.opening } : {}),
  };
}

/** The players on `me`'s team (#128), from the game's player list; none in a no-team game. */
export function alliesOf(me: number, players: readonly ProfilePlayer[] | undefined): Set<number> {
  const team = players?.find((p) => p.id === me)?.team;
  if (!carriesTeam(team)) return new Set();
  return new Set((players ?? []).filter((p) => p.id !== me && p.team === team).map((p) => p.id));
}

/**
 * The per-opponent deploy estimates a plan works from: {@link enemyDeployEstimates} with the fog
 * prior (#119, {@link fogPrior}) when the game context allows it, and the turn being played (the
 * opening board is the first turn's only, #128). {@link planTurn} and warapp_check_plan both use
 * it, so they work from the same figures. `income` is my board income, card armies left out.
 * Every visible player is listed, teammates included (the caller filters them).
 */
export function planEnemyEstimates(input: {
  graph: MapGraph;
  board: BoardState;
  me: number;
  income: number;
  settings?: PlannerSettings;
  previousBoard?: BoardState;
  /** #226: my orders on the turn `previousBoard` was played: a failed attack's kills count back. */
  previousOrders?: MyOrders;
  tracks?: readonly OpponentTrack[];
  game?: PlanGameContext;
  turn?: number | null;
}): { estimates: EnemyDeployEstimate[]; prior: EnemyIncomePrior | undefined } {
  const ctx = input.game ?? {};
  const prior = fogPrior(input.board, input.me, ctx, input.income);
  const turn = input.turn ?? ctx.turn ?? null;
  const estimates = enemyDeployEstimates(input.graph, input.board, input.me, input.settings ?? {}, input.previousBoard, input.tracks, prior, {
    turn,
    fog: ctx.fog,
    reinforcement: ctx.reinforcement,
    ...(input.previousBoard && input.previousOrders ? { previousOrders: input.previousOrders } : {}),
  });
  return { estimates, prior };
}

/** The opponents' estimates, the game profile and the goal it picks (rule 0p). */
function opponentsCtx(input: PlanInput): OpponentsCtx {
  const { graph: g, board, me } = input;
  const s = input.settings ?? {};
  const baseIncome = Math.max(0, Math.floor(s.baseIncome ?? DEFAULT_BASE_INCOME));
  const opts = input.options ?? {};
  const income = Math.max(0, Math.floor(input.income));
  const ctx = input.game ?? {};
  /** My teammates (#128): players on my team, never a threat, a target or an estimate. */
  const allies = alliesOf(me, ctx.players);
  /** A player whose stacks threaten me and whose territories I may attack: not me, not a teammate. */
  const foe = (p: number) => p !== me && !allies.has(p);
  /** The turn being planned, when known (the opening board is the first turn's only, #128). */
  const turnNow = input.turn ?? ctx.turn ?? null;
  const { estimates: allEstimates, prior: incomePrior } = planEnemyEstimates({
    graph: g,
    board,
    me,
    income: income - Math.max(0, Math.floor(input.cardArmies ?? 0)),
    settings: s,
    ...(input.previousBoard ? { previousBoard: input.previousBoard } : {}),
    ...(input.previousOrders ? { previousOrders: input.previousOrders } : {}),
    ...(input.tracks ? { tracks: input.tracks } : {}),
    game: ctx,
    turn: turnNow,
  });
  const estimateList = allEstimates.filter((e) => foe(e.playerId));
  /** An opponent's income: its deploy estimate less the Reinforcement card the clock adds (#164). */
  const incomeOf = (e: EnemyDeployEstimate) => e.estimate - (e.card?.armies ?? 0);
  // ---- 0p. the game profile ----
  const profile = gameProfile({
    graph: g,
    board,
    me,
    players: ctx.players ?? [],
    settings: {
      ...(s.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
      ...(s.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
      ...(ctx.cards !== undefined ? { cards: ctx.cards } : {}),
      ...(s.localDeployments !== undefined ? { localDeployments: s.localDeployments } : {}),
      ...(s.noSplit !== undefined ? { noSplit: s.noSplit } : {}),
      ...(ctx.commanders !== undefined ? { commanders: ctx.commanders } : {}),
      ...(ctx.fog !== undefined ? { fog: ctx.fog } : {}),
      ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
      ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
      ...(s.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: s.oneArmyStandsGuard } : {}),
    },
    ...(ctx.turn !== undefined ? { turn: ctx.turn } : {}),
    ...(ctx.picking !== undefined ? { picking: ctx.picking } : {}),
    ...(ctx.endRules ? { endRules: ctx.endRules } : {}),
    income,
    // #164 x #167: an opponent's Reinforcement card is a one-off deploy, not income: the standing
    // and the FFA ranking read each estimate less its card.
    estimates: estimateList.map((e) => ({ ...e, estimate: incomeOf(e) })),
    // #94: opponents the tracker found with nothing in view, for the 'unknown' standing note.
    unseen: (input.tracks ?? []).flatMap((t) =>
      t.earnedAtLeast ? [{ playerId: t.playerId, turnsUnseen: t.turnsUnseen, turnsUnseenAtLeast: t.turnsUnseenAtLeast, earnedAtLeast: t.earnedAtLeast.total }] : [],
    ),
  });
  /** The profile picks the goal and tunes the scoring (rule 0p): adapting, with no explicit goal. */
  const auto = opts.adapt === true && opts.goal === undefined;
  /** Rule 0p.3: behind on income. */
  const behind = auto && profile.standing === 'behind';
  /** Rule 0p.3 (#72): behind on income in a 1v1 — strike (stay balanced, break first), never defend. */
  const strike = behind && profile.format === '1v1';
  const goal: PlanGoal = opts.goal ?? (behind && !strike ? 'defend' : 'balanced');
  const balanced = goal === 'balanced';
  /** Rule 0p.3: behind — size attacks at the minimum (no pressure margin). */
  const minimal = behind;
  /** Rule 0p.3: ahead in a 1v1 — pressure allowed at {@link AHEAD_PRESSURE_FACTOR}. */
  const pressureFactor = auto && profile.format === '1v1' && profile.standing === 'ahead' ? AHEAD_PRESSURE_FACTOR : PRESSURE_FACTOR;
  /** The pressure margin over an estimated deploy: none when sizing at the minimum. */
  const marginFor = (d: number) => (minimal ? 0 : pressureMargin(d));
  /** Goals that refuse to complete a bonus they cannot hold (R3); the others only warn. */
  const guarded = balanced || goal === 'defend';
  const focus = new Set(opts.focusBonusIds ?? []);
  const reserve = Math.min(income, Math.max(0, Math.floor(opts.reserve ?? 0)));
  const custom = opts.enemyDeploy !== undefined;
  const mineAtStart = new Set(
    board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me ? [t.territoryId] : [])),
  );
  // As {@link defaultEnemyDeploy}, over the opponents only (teammates out, #128).
  const enemyDeploy = custom
    ? Math.max(0, Math.floor(opts.enemyDeploy!))
    : estimateList.reduce(
        (m, e) =>
          board.territories.some(
            (t) =>
              t.owner.kind === 'player' &&
              t.owner.playerId === e.playerId &&
              (t.armies !== null || (ownerShown(t) !== undefined && !visibleState(t))) &&
              g.territoryById.has(t.territoryId) &&
              neighborsOf(g, t.territoryId).some((n) => mineAtStart.has(n)),
          )
            ? Math.max(m, e.estimate)
            : m,
        MIN_ENEMY_DEPLOY,
      );
  const estimates = new Map(estimateList.map((e) => [e.playerId, e]));
  /** The deploy assumed for one opponent's threat: the override, else its own estimate. */
  const deployOf = (player: number) => (custom ? enemyDeploy : (estimates.get(player)?.estimate ?? MIN_ENEMY_DEPLOY));
  /** One opponent's income per turn: {@link deployOf} less the Reinforcement card it adds (#164). */
  const incomeOfPlayer = (player: number) => {
    const e = custom ? undefined : estimates.get(player);
    return e ? incomeOf(e) : deployOf(player);
  };
  /**
   * #201: the planning horizon. Once the outlook (#178) says the game is decided — winning or losing
   * for OUTLOOK_TURNS turns running — every payback test counts the turns the game has left instead
   * of PAYBACK_TURNS: the loser's strength over the winner's income per turn (winning: the strongest
   * opponent's strength, its high when bounded, over my income; losing: mine over the strongest
   * opponent's deploy estimate), at least DECIDED_PAYBACK_MIN, at most PAYBACK_TURNS. Adapting only.
   * #208: winning on the likely high alone (`estimated`) counts that likely high, said as an estimate.
   */
  const decidedGame = (() => {
    const o = opts.outlook;
    const last = o?.turns.at(-1);
    if (!auto || !o || !last || (o.state !== 'winning' && o.state !== 'losing')) return undefined;
    const likely = o.state === 'winning' && last.estimated && last.likely ? last.likely.high : undefined;
    const loser =
      likely ?? (o.state === 'winning' ? (last.strongest ? (last.strongest.high ?? last.strongest.low) : 0) : last.mine);
    const rate = o.state === 'winning' ? income : last.strongest ? incomeOfPlayer(last.strongest.playerId) : 0;
    if (rate <= 0) return undefined;
    const turns = Math.min(PAYBACK_TURNS, Math.max(DECIDED_PAYBACK_MIN, Math.ceil(loser / rate)));
    return turns < PAYBACK_TURNS ? { state: o.state, turns, loser, rate, ...(likely !== undefined ? { estimated: true as const } : {}) } : undefined;
  })();
  /** The turns every payback test counts: {@link PAYBACK_TURNS}, or fewer once the game is decided (#201). */
  const paybackTurns = decidedGame?.turns ?? PAYBACK_TURNS;
  return {
    g,
    board,
    me,
    s,
    baseIncome,
    opts,
    income,
    game: ctx,
    allies,
    foe,
    turnNow,
    incomePrior,
    estimateList,
    incomeOf,
    profile,
    auto,
    behind,
    strike,
    goal,
    balanced,
    minimal,
    pressureFactor,
    marginFor,
    guarded,
    focus,
    reserve,
    custom,
    mineAtStart,
    enemyDeploy,
    estimates,
    deployOf,
    incomeOfPlayer,
    decidedGame,
    paybackTurns,
  };
}

/** The territories as the board shows them, and what holding them is worth (#70, #85, #125). */
function boardCtx(input: PlanInput, o: OpponentsCtx): BoardCtx {
  const { g, board, me, s, baseIncome, income, focus } = o;
  const state = new Map<number, BoardState['territories'][number]>();
  for (const t of board.territories) if (g.territoryById.has(t.territoryId)) state.set(t.territoryId, t);
  const label = (id: number) => `${g.territoryById.get(id)!.name} (#${id})`;
  const bonusName = (id: number) => `${g.bonusById.get(id)!.name} (#${id})`;
  const isMine = (id: number) => {
    const o = state.get(id)?.owner;
    return o?.kind === 'player' && o.playerId === me;
  };
  const mine = [...state.keys()].filter(isMine).sort(byNum);
  const mineSet = new Set(mine);
  // Next turn's income (#85): this turn's, less its card armies, moved by what the one income rule
  // ({@link boardIncome}) says the holdings `after` change — bonuses completed (negative ones
  // too), per-territory armies, the floor at 0.
  const incomeRulesNow = { base: baseIncome, per: s.bonusArmyPer ?? 0 };
  const boardIncomeNow = boardIncome(g, mineSet, incomeRulesNow).total;
  const cardArmies = Math.max(0, Math.floor(input.cardArmies ?? 0));
  /**
   * The income change (#70, #85) from holding `after` instead of what I held at the start: the one
   * income rule's ({@link boardIncome}) total over `after` less its total now — every bonus whose
   * completion changes (negative ones and superbonuses included), per-territory armies, and the
   * floor at 0 on both sides, so a change computed below the floor is what war.app pays.
   * Next income, R3, rule 4c's scoring and its guard all read it.
   */
  const incomeGain = (after: ReadonlySet<number>): number => boardIncome(g, after, incomeRulesNow).total - boardIncomeNow;
  /** Next income after a change of `gain`: this turn's, less its card armies, moved by `gain`. */
  const nextIncomeWith = (gain: number) => Math.max(0, income - cardArmies + gain);
  const incomeAfter = (after: ReadonlySet<number>) => nextIncomeWith(incomeGain(after));
  const armiesOf = (id: number) => state.get(id)?.armies ?? 0;
  /** The armies the special units on `id` fight as (a commander: {@link COMMANDER_STRENGTH}). */
  const unitsAt = (id: number) => specialUnitStrength(state.get(id)?.specialUnits);
  /**
   * #128: a territory holding a special unit whose strength the board does not carry (a boss, a
   * custom unit): it counts as 0 everywhere, so no attack on it is sized as sure.
   */
  const uncounted = (id: number) => (state.get(id)?.specialUnits ?? []).some((u) => u.kind !== 'commander');
  const uncountedKind = (id: number) =>
    [...new Set((state.get(id)?.specialUnits ?? []).filter((u) => u.kind !== 'commander').map((u) => (u.kind === 'boss' ? 'a boss' : u.kind === 'custom' ? 'a custom unit' : 'a special unit')))].join(' and ');
  /** What a territory defends as now: its armies plus its special units. */
  const defenceAt = (id: number) => armiesOf(id) + unitsAt(id);

  // ---- income change (#70): the one computation nextIncome, R3 and the negative-bonus rules use ----
  const bonusTs = new Map(g.map.bonuses.map((b) => [b.id, bonusTerritories(g, b.id)]));
  /** The bonuses each territory is in (superbonuses through their members included). */
  const bonusesWith = new Map<number, number[]>();
  for (const [id, ts] of bonusTs) for (const t of ts) bonusesWith.set(t, [...(bonusesWith.get(t) ?? []), id]);
  /**
   * Bonuses complete over `after` that were not complete at the start of the turn, sorted by id.
   * Such a bonus has a territory in `after` that was not mine at the start, so only the bonuses of
   * those territories are looked at (every bonus on the map was, many times a plan: #172 review).
   */
  const completedBy = (after: ReadonlySet<number>): number[] => completedOver((t) => after.has(t), after);
  /**
   * {@link completedBy} over the territories `holds` says are held, given every one of them that
   * was not mine at the start (`fresh`; mine are skipped).
   */
  const completedOver = (holds: (t: number) => boolean, fresh: Iterable<number>): number[] => {
    const out = new Set<number>();
    for (const t of fresh) {
      if (mineSet.has(t)) continue;
      for (const id of bonusesWith.get(t) ?? []) if (!out.has(id) && bonusTs.get(id)!.every(holds)) out.add(id);
    }
    return [...out].sort(byNum);
  };
  /**
   * The per-territory income (#125; Extra Armies for Territories) that `k` more territories add to
   * what I hold now: floor(territories / per) over the base, at 1/per a territory once past it (a
   * fraction, so a capture that does not cross a multiple of `per` still counts its share). 0 off.
   */
  const territoryShare = (k: number): number => {
    const per = s.bonusArmyPer ?? 0;
    if (per <= 0 || k <= 0) return 0;
    const now = mine.length;
    const exact = (n: number) => Math.max(baseIncome, n / per);
    return Math.round((exact(now + k) - exact(now)) * 100) / 100;
  };
  /** Income a turn that capturing `_t` adds on its own (#125): its bonuses' and its per-territory share. */
  const plainWorth = (_t: number, gain: number): number => Math.max(gain, territoryShare(1));
  /** `t` is in a bonus the caller focused: the negative-bonus rules never refuse it. */
  const inFocus = (t: number) => [...focus].some((id) => bonusTs.get(id)?.includes(t));
  return {
    territories: state,
    label,
    bonusName,
    isMine,
    mine,
    mineSet,
    boardIncomeNow,
    cardArmies,
    incomeGain,
    nextIncomeWith,
    incomeAfter,
    armiesOf,
    unitsAt,
    uncounted,
    uncountedKind,
    defenceAt,
    bonusTs,
    bonusesWith,
    completedBy,
    completedOver,
    territoryShare,
    plainWorth,
    inFocus,
  };
}

/** The combat model (S2, #126): kill rates, luck, rounding, and what a capture or a hold costs. */
function combatCtx(o: OpponentsCtx, b: BoardCtx): CombatCtx {
  const { g, board, me, s, opts, foe } = o;
  const { territories: state, isMine, armiesOf, defenceAt } = b;
  const guard = (s.oneArmyStandsGuard ?? true) ? 1 : 0;
  /** #163: an opponent may hold a Bomb: every hold is sized as if its stack were halved first. */
  const bombOn = opts.opponentsMayHoldBomb === true;
  const rates = {
    offensiveKillRate: s.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: s.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
  };
  /** The exact combat model's settings (S2): kill rates, luck, rounding. */
  const combat = combatSettings(s);
  const chanceOf = (armies: number, defenders: number) => winChance(armies, defenders, combat);
  /** The least win chance an ordinary capture is sized for (S2; #126: 95% by default with luck on). */
  const minWin = opts.minWinChance !== undefined ? minWinChanceOf(opts.minWinChance) : defaultMinWinChance(s);
  /** Exact results: 0% luck under straight rounding, where every chance is 0 or 1. */
  const exactCombat = !combat.luck && combat.rounding !== 'WeightedRandom';
  /**
   * #126: the chance each capture of `t` is sized for, so the captures a bonus still needs reach
   * {@link minWin} together: minWin^(1/k), k the most members not mine of any positive bonus `t`
   * is in (1 outside a bonus). 1 when minWin is.
   */
  const missingOf = new Map<number, number>();
  const heldAtStart = new Set(
    board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me ? [t.territoryId] : [])),
  );
  for (const bonus of g.map.bonuses) {
    if (bonus.value <= 0) continue;
    const ts = bonusTerritories(g, bonus.id);
    const missing = ts.filter((x) => !heldAtStart.has(x)).length;
    for (const x of ts) missingOf.set(x, Math.max(missingOf.get(x) ?? 1, missing));
  }
  const chanceAt = (t: number) => (minWin >= 1 ? 1 : minWin ** (1 / (missingOf.get(t) ?? 1)));
  const costMemo = new Map<string, number | null>();
  /** An ordinary capture's size against `defenders`, at `chance` (default {@link minWin}). */
  const costOf = (defenders: number, chance = minWin): number | null => {
    const key = `${defenders}|${chance}`;
    if (!costMemo.has(key)) costMemo.set(key, captureCost(defenders, s, chance));
    return costMemo.get(key)!;
  };
  /** An ordinary capture of `t`'s size against `defenders` (default what defends it now), at {@link chanceAt}. */
  const costAt = (t: number, defenders = defenceAt(t)): number | null => costOf(defenders, chanceAt(t));
  /** {@link toTake} by defenders, for this plan's settings. */
  const takeMemo = new Map<number, number | null>();
  /**
   * The attack that takes `defenders` (holds, threats, retakes): `armiesToTake` with exact results;
   * else (#126) the fewest attackers whose win chance exceeds {@link HOLD_FALL_CHANCE}, so a stack
   * that "needs N to take, above the threat" falls to that threat at most that often.
   */
  const toTake = (defenders: number): number | null => {
    if (exactCombat) return armiesToTake(defenders, rates);
    if (!takeMemo.has(defenders))
      takeMemo.set(defenders, defenders <= 0 ? 1 : armiesForChance(defenders, HOLD_FALL_CHANCE + 1e-9, combat));
    return takeMemo.get(defenders)!;
  };
  /**
   * What capturing `x` costs the economy (#125): the armies its attackers lose (the defenders'
   * kills at the defensive rate) plus the one army left on it — not the armies sent, whose
   * survivors are still mine. That one army is waived when a territory of mine beside it that
   * faces no visible enemy already has idle armies enough to take it (nothing is deployed for
   * it). Infinity when it cannot be taken.
   */
  const econCostAt = (x: number): number => {
    const c = costAt(x);
    if (c === null) return Infinity;
    const lost = Math.min(c - 1, straightKills(defenceAt(x), rates.defensiveKillRate));
    const idle = neighborsOf(g, x).some(
      (n) =>
        isMine(n) &&
        armiesOf(n) - guard >= c &&
        !neighborsOf(g, n).some((y) => {
          const o = state.get(y)?.owner;
          return o?.kind === 'player' && foe(o.playerId);
        }),
    );
    return lost + (idle ? 0 : 1);
  };
  const luck = luckFraction(s.luckModifier);
  const weightedRounding = s.roundingMode !== undefined && s.roundingMode !== 'StraightRound';
  const noSplit = s.noSplit === true;
  return {
    guard,
    bombOn,
    rates,
    combat,
    chanceOf,
    minWin,
    exactCombat,
    heldAtStart,
    chanceAt,
    costOf,
    costAt,
    toTake,
    econCostAt,
    luck,
    weightedRounding,
    noSplit,
  };
}

/** Where I stand on armies (#167, #201, rule 0p.3), and the rules that switches. */
function standingCtx(o: OpponentsCtx, b: BoardCtx): StandingCtx {
  const { me, opts, foe, profile, auto } = o;
  const { territories: state, mine, unitsAt } = b;
  /**
   * #167: my army lead over the largest opponent in view — my visible armies and special units over
   * theirs (Infinity with no opponent in view). Rule 0p.2 scales with it, and above
   * SECOND_FRONT_LEAD× it is off.
   */
  const armyLead = (() => {
    const by = new Map<number, number>();
    for (const [id, st] of state)
      if (st.owner.kind === 'player' && st.armies !== null) by.set(st.owner.playerId, (by.get(st.owner.playerId) ?? 0) + st.armies + unitsAt(id));
    const my = by.get(me) ?? 0;
    const rival = [...by].filter(([p]) => foe(p)).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    return { my, rival: rival?.[0], theirs: rival?.[1] ?? 0, ratio: rival && rival[1] > 0 ? my / rival[1] : Infinity };
  })();
  /**
   * #167: adapting (rule 0p), the lead switches rule 0p.2 off. Visible armies only, so under fog a
   * strong player showing one small stack would inflate it: the lever also needs me first in the
   * profile's FFA ranking on strength (armies + STRENGTH_INCOME_TURNS × income), when there is one.
   */
  const leadLever =
    opts.adapt === true &&
    opts.goal === undefined &&
    armyLead.rival !== undefined &&
    armyLead.ratio > SECOND_FRONT_LEAD &&
    (profile.ranking === undefined || profile.ranking.myRank === 1);
  /**
   * #167: a clear FFA leader that is not me (strength at least AHEAD_RATIO × the next player's): the
   * player the others combine against, never a second front.
   */
  const clearLeader = (() => {
    const r = profile.ranking;
    if (!(opts.adapt === true && opts.goal === undefined) || !r || r.commonThreat === null || r.players.length < 2) return undefined;
    return r.players[0]!.strength >= AHEAD_RATIO * r.players[1]!.strength ? r.commonThreat : undefined;
  })();
  /**
   * #201: I lead this free-for-all on strength (adapting, two or more opponents left): the others
   * may combine against me, so a border is held against every adjacent opponent together, and a
   * break is sized to land against its owner's one deploy.
   */
  const ffaLeader = opts.adapt === true && opts.goal === undefined && profile.format === 'ffa' && profile.opponents >= 2 && profile.ranking?.leader === me;
  /**
   * #201: fund holds by the standing (adapting). Ahead: every held bonus is held for the worst case
   * (each border against the whole deploy) before any capture, completions included. Behind: each
   * border is sized for the expected attack (#59: movable armies next to it plus the whole deploy
   * estimate), not the worst case the growth trend projects, and the plan says what that gambles —
   * only the trend above the deploy, never the deploy itself (sizing below it broke #118);
   * my commander's territory is never sized so (1k). Ahead, a held bonus never waits behind the
   * expansion share either.
   */
  const holdPasses: 'worst' | 'expected' | undefined =
    opts.adapt === true && opts.goal === undefined
      ? profile.standing === 'ahead'
        ? 'worst'
        : profile.standing === 'behind'
          ? 'expected'
          : undefined
      : undefined;
  /** "3.3×" */
  const leadText = () => (Number.isFinite(armyLead.ratio) ? `${(Math.round(armyLead.ratio * 10) / 10).toFixed(1)}×` : 'unbounded (no opponent army in view)');
  /** My territories where my own commander stands: must-hold (rule 1k). */
  const myCommanders = new Set(
    mine.filter((id) => (state.get(id)?.specialUnits ?? []).some((u) => u.kind === 'commander' && u.playerId === me)),
  );

  // ---- rule 0p.3 (#72): behind on armies ----
  // Adapting in a 1v1: my visible armies against the strongest opponent's visible armies, each
  // with the special units standing on them (a commander fights as COMMANDER_STRENGTH). Behind
  // (below BEHIND_RATIO×, strictly, as the plan states) means no trade below even: a combined
  // capture of a player's territory whose attacks lose more armies than they kill is not made.
  // A single capture needs no check: it kills every defender and loses at most
  // round(defenders × defensive rate) ≤ defenders, so it never trades below even (pinned by
  // tests at unusual kill rates) — revisit this if single-capture sizing ever changes.
  let armiesBehindVs: StandingCtx['armiesBehindVs'];
  if (auto && profile.format === '1v1') {
    const totals = new Map<number, number>();
    for (const st of state.values())
      if (st.owner.kind === 'player' && st.armies !== null)
        totals.set(
          st.owner.playerId,
          (totals.get(st.owner.playerId) ?? 0) + st.armies + specialUnitStrength(st.specialUnits),
        );
    const myArmies = totals.get(me) ?? 0;
    const [rival, theirs] = [...totals]
      .filter(([p]) => foe(p))
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])[0] ?? [undefined, 0];
    if (rival !== undefined && theirs > 0 && myArmies < BEHIND_RATIO * theirs) armiesBehindVs = { myArmies, rival, theirs };
  }
  return {
    armyLead,
    leadLever,
    clearLeader,
    ffaLeader,
    holdPasses,
    leadText,
    myCommanders,
    armiesBehindVs,
    armiesBehind: armiesBehindVs !== undefined,
  };
}

/** Everything a planning pass reads and never changes (the estimates phase). */
export function planContext(input: PlanInput): PlanCtx {
  const o = opponentsCtx(input);
  const b = boardCtx(input, o);
  return { ...o, ...b, ...combatCtx(o, b), ...standingCtx(o, b) };
}

/**
 * The rationale and warnings that state what the estimates phase decided: the goal and the profile
 * behind it (rule 0p), a decided game (#201), being behind on armies (rule 0p.3), the combat model's
 * settings (S2, #126), a possible Bomb (#163), Multi-Attack and No-Split (#124). The first lines of
 * every plan, in this order.
 */
export function noteEstimates(ctx: PlanCtx, state: PlanState): void {
  const { board, s, opts, income, estimateList, profile, auto, strike, goal, minimal, pressureFactor, decidedGame } = ctx;
  const { rates, minWin, exactCombat, bombOn, luck, weightedRounding, noSplit, armiesBehindVs } = ctx;
  const { warnings, rationale } = state;
  const profileText = `${profile.format}, ${profile.phase}, ${profile.standing}`;
  if (opts.adapt && opts.goal !== undefined) {
    rationale.push(`Goal ${goal} was given explicitly, so it overrides the game profile (${profileText}): none of the profile's rules apply.`);
    // Also a warning: live, a script that always passed `goal: balanced` switched the 1v1 rules
    // (strike stack, breaks before expansion) off for two whole games, and nobody noticed.
    warnings.push(
      `Goal ${goal} was given explicitly, so none of the game-profile rules for ${profile.format === 'ffa' ? 'an FFA' : profile.format === 'teams' ? 'a team game' : 'a 1v1'} apply this turn (standing ${profile.standing}): leave the goal out to let the profile choose it and apply them.`,
    );
  } else if (auto) {
    const strongest = estimateList.reduce((m, e) => Math.max(m, e.estimate), 0);
    rationale.push(
      strike
        ? `Goal balanced from the game profile (${profileText}): behind on income (${income} against ~${strongest}) in a 1v1 — strike: break the opponent's bonuses with minimal attacks before expansion that completes nothing (holds of my own bonuses that pay for themselves still come first), sized at the minimum (no extra margin beyond what the rules require).`
        : minimal
          ? `Goal defend from the game profile (${profileText}): behind on income (${income} against ~${strongest}), so defend first and size attacks at the minimum (no extra margin beyond what the rules require).`
          : `Goal balanced from the game profile (${profileText}): the base goal.`,
    );
    if (pressureFactor !== PRESSURE_FACTOR)
      rationale.push(
        `Ahead in a 1v1 (${income} against ~${strongest}): keep attacking — pressure on an opponent next to the fog is allowed when each capture costs up to ${pressureFactor}× a typical neutral capture (instead of ${PRESSURE_FACTOR}×).`,
      );
  }
  if (decidedGame)
    rationale.push(
      `Outlook (#201): ${decidedGame.state} for ${OUTLOOK_TURNS} turns running, so the game is decided — ${
        decidedGame.state === 'winning'
          ? `the strongest opponent's ${decidedGame.estimated ? 'likely strength' : 'strength'} of ${decidedGame.loser}${decidedGame.estimated ? ' (an estimate, not a bound)' : ''} over my income of ${decidedGame.rate}`
          : `my strength of ${decidedGame.loser} over the strongest opponent's ~${decidedGame.rate} a turn`
      } leaves ~${decidedGame.turns} turns, so every payback test counts ${decidedGame.turns} turns instead of ${PAYBACK_TURNS}.`,
    );
  if (armiesBehindVs) {
    const { myArmies, rival, theirs } = armiesBehindVs;
    rationale.push(
      `Behind on armies (${myArmies} visible against player ${rival}'s ${theirs}): no trade below even — a capture of a player's territory whose attacks lose more armies than they kill is not made.`,
    );
  }

  if (!board.verified)
    warnings.push('Board state comes from an unverified parser of the GameFeed standing; check it against the game.');
  if (luck > 0)
    warnings.push(
      minWin < 1
        ? `Luck is ${Math.round(luck * 100)}%: each capture is sized for at least a ${Math.round(minWin * 100)}% win chance (min_win_chance${opts.minWinChance === undefined ? `, ${Math.round(LUCK_WIN_CHANCE * 100)}% by default with luck on` : ''}), so it can fail; each attack's winChance says how likely it is.`
        : `Luck is ${Math.round(luck * 100)}%: each capture is sized to be certain (min_win_chance 1: the fewest armies whose every roll takes it); each attack's winChance says how likely it is.`,
    );
  if (s.offensiveKillRate === undefined || s.defensiveKillRate === undefined)
    warnings.push(
      `Kill rates missing from the game settings; assuming ${rates.offensiveKillRate}% offense, ${rates.defensiveKillRate}% defense.`,
    );
  if (s.roundingMode === 'WeightedRandom')
    warnings.push(
      `This game uses ${s.roundingMode} rounding: capture and hold sizes are computed under it (a fraction of a kill can round either way), and each attack's winChance says how likely it is.`,
    );
  else if (weightedRounding)
    warnings.push(`Capture costs assume straight rounding; this game uses ${s.roundingMode}, which the combat model does not know.`);
  if (minWin < 1)
    rationale.push(
      `Captures are sized for at least a ${Math.round(minWin * 100)}% win chance (min_win_chance), not a guaranteed take: each gets the fewest armies whose exact win chance reaches it, and the captures a bonus still needs reach it together (each at that chance to the power 1/k, k the bonus's missing members). Attacks sized for a worst case (finishing a player off, fog pressure, commander strikes) stay certain: their win chance is 1.`,
    );
  if (!exactCombat)
    rationale.push(
      `Holds are sized so the attack assumed wins at most ${Math.round(HOLD_FALL_CHANCE * 100)}%: "need N to take" is the smallest attack that wins more often than that${luck > 0 ? ` at ${Math.round(luck * 100)}% luck` : ''}${weightedRounding ? ` under ${s.roundingMode} rounding` : ''}.`,
    );
  if (bombOn)
    rationale.push(
      'An opponent may hold a Bomb (#163): it halves one territory of mine next to it after the deploys and before any move, so every hold here is sized as if its stack were halved first (my commander unharmed), and the leftover goes to two stacks, not one, unless it concentrates for an attack.',
    );
  if (s.multiAttack)
    rationale.push(
      `Multi-attack is on: the plan does not chain its own attacks from captured territories, but an enemy stack's chain — a capture, then the survivors on from it, through territories not mine — counts as a threat to the territory of mine, or the capture, it reaches (luck-free, at most ${CHAIN_MAX_STEPS} attacks deep).`,
    );
  if (noSplit) {
    rationale.push(
      'No-Split: each territory issues at most one attack or transfer this turn, and it sends the whole stack (every army there, this turn\'s deploys included, less the guard); a territory that would split keeps its first (best) order, and one that must hold issues none.',
    );
  }
}

/** The plan for a player holding no territory: nothing to deploy or move. */
export function emptyPlan(ctx: PlanCtx, state: PlanState): TurnPlan {
  const { me, goal, profile, income, cardArmies, enemyDeploy } = ctx;
  const { warnings, rationale } = state;
  warnings.push(`Player ${me} holds no territories on this board, so there is nothing to deploy or move.`);
  return {
    goal,
    profile,
    deploys: [],
    moves: [],
    expected: { captures: [], bonusesCompleted: [], nextIncome: Math.max(0, income - cardArmies) },
    warnings,
    rationale,
    enemyDeploy,
    conceded: [],
    cardAdvice: null,
    multiSourceCaptures: [],
    frontier: { borders: 0, enemyBorders: 0, holdCost: 0, income },
    offence: [],
  };
}
