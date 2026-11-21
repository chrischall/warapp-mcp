// An opponent's deploy estimate and the income the planner reads off a board (split from shared.ts): the
// visible-bonus figure, the observed and tracked evidence, the fog prior, thin evidence (#368) and the income
// helpers (`incomeDetail`). Pure; shared.ts re-exports all of it.
import type { BoardState, TerritoryState } from '../../board.js';
import { commerceRules } from '../../commerce.js';
import type { MyOrders, ObservedTurn, OpponentTrack } from '../opponents.js';
import { LEAD_ARMIES } from '../opponents.js';
import type { GameSettings } from '../../normalize.js';
import { bonusTerritories } from '../bonuses.js';
import { neighborsOf, type MapGraph } from '../graph.js';
import { armyCapIncome, boardIncome, DEFAULT_BASE_INCOME, incomeRules, territoryIncome, type ArmyCapIncome } from '../player.js';
import { byNum } from './util.js';
import { LOW_COVERAGE, MIN_ENEMY_DEPLOY, OWNERS_SHOWN_FOG, PRIOR_EVIDENCE_TURNS, TRACKED_MIN_TURNS, bombPossibleOn, fogPaceIncome, localFreeOn } from './shared.js';
import type { EnemyDeployEstimate, EnemyIncomePrior, PlannerSettings, ReinforcementClock } from './shared.js';
import { observeDeploy, ownerShown, trackCoverage, visibleState } from './observe.js';

/**
 * The army count every visible player territory holds, when they all hold the same one (the
 * initial allotment). Neutrals are left out (#128): their stacks are not the starting stacks on
 * ordinary maps, so counting them meant this never fired. Only the first turn can be the opening
 * board (#128): with a previous board, or a known turn past the first, equal stacks are a
 * coincidence of the mid-game, and reading them as the opening would drop visible bonuses.
 */
export function openingArmies(
  g: MapGraph,
  board: BoardState,
  when: { turn?: number | null | undefined; previous?: BoardState | undefined } = {},
): number | null {
  if (when.previous !== undefined || (when.turn !== null && when.turn !== undefined && when.turn > 1)) return null;
  const counts = new Set<number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && t.armies !== null && t.owner.kind === 'player') counts.add(t.armies);
  return counts.size === 1 ? [...counts][0]! : null;
}

/**
 * #368: an opponent's tracked figure as of each of its last three consecutive observed turns — the most
 * it was seen to earn (`earned`) over that turn and the two before it, the tracker's max-observed window —
 * when it rose on both steps; else `null` (fewer than three consecutive turns, or a step not a rise).
 */
export function risingTracked(turns: readonly Pick<ObservedTurn, 'from' | 'earned'>[]): number[] | null {
  const n = turns.length;
  if (n < 3) return null;
  for (let i = n - 2; i < n; i++) if (turns[i]!.from !== turns[i - 1]!.from + 1) return null;
  const asOf = (i: number) => Math.max(...turns.slice(Math.max(0, i - 2), i + 1).map((x) => x.earned));
  const series = [asOf(n - 3), asOf(n - 2), asOf(n - 1)];
  return series[0]! < series[1]! && series[1]! < series[2]! ? series : null;
}

/**
 * Per-opponent enemy deploy estimates, one per visible enemy player (sorted by
 * id): base income plus the bonuses that player visibly holds in full, never
 * below max({@link MIN_ENEMY_DEPLOY}, base income). Its stack next to me does not
 * limit it — income held in plain view can all be deployed on my border, however
 * small the stack there. Bonuses in the fog are unseen, so this is what the
 * visible board supports. On the opening board (every visible player territory holds
 * the same count, with no previous board and `when.turn` unknown or the first) every
 * opponent gets the floor.
 */
export function enemyDeployEstimates(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings: PlannerSettings = {},
  previous?: BoardState,
  tracks?: readonly OpponentTrack[],
  prior?: EnemyIncomePrior,
  when: {
    turn?: number | null;
    fog?: string | undefined;
    reinforcement?: ReinforcementClock | undefined;
    /** #226: my orders on the turn between `previous` and `board` ({@link ObserveContext.myOrders}). */
    previousOrders?: MyOrders | undefined;
  } = {},
): EnemyDeployEstimate[] {
  const owner = new Map<number, number>();
  const armies = new Map<number, number>();
  const seenNow = new Map<number, TerritoryState>();
  for (const t of board.territories) if (g.territoryById.has(t.territoryId)) seenNow.set(t.territoryId, t);
  // Owners count whatever the armies: an owner-only territory (light fog) is visibly held, so
  // it counts toward base income and the bonuses held in full. Only stacks need the armies.
  for (const t of board.territories) {
    if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player') continue;
    owner.set(t.territoryId, t.owner.playerId);
    if (t.armies !== null) armies.set(t.territoryId, t.armies);
  }
  const players = [...new Set([...owner.values()].filter((p) => p !== me))].sort(byNum);
  const opening = openingArmies(g, board, { turn: when.turn, previous }) !== null;
  // #164: under No, Light and Dense fog every owner shows, so income is exact — when this board
  // shows every territory's owner too (the setting is a name, never compared by position).
  const ownersAll =
    when.fog !== undefined &&
    OWNERS_SHOWN_FOG.has(when.fog) &&
    g.map.territories.every((t) => ownerShown(seenNow.get(t.id)) !== undefined);
  const minimum = Math.max(0, Math.floor(settings.baseIncome ?? DEFAULT_BASE_INCOME));
  const per = settings.bonusArmyPer ?? 0;
  // #418: my income on the board (cards aside) and my armies in view, against which a rising track is weighed.
  const myLand = new Set<number>();
  let myArmies = 0;
  for (const [t, p] of owner)
    if (p === me) {
      myLand.add(t);
      myArmies += armies.get(t) ?? 0;
    }
  const myBoardIncome = boardIncome(g, myLand, { base: minimum, per }).total;
  return players.map((playerId) => {
    // Its visible territories are a lower bound on what it holds, so on its
    // per-territory income too.
    const theirs = new Set<number>();
    for (const [t, p] of owner) if (p === playerId) theirs.add(t);
    const held = theirs.size;
    const base = territoryIncome(held, minimum, per);
    // The one income rule (#85) over what it visibly holds; `bonusIncome` is what it adds to the base.
    const bonusIncome = boardIncome(g, theirs, { base: minimum, per }).total - base;
    let adjacent = 0;
    let any = 0;
    for (const [t, p] of owner) {
      if (p !== playerId) continue;
      const a = armies.get(t);
      if (a === undefined) continue;
      any = Math.max(any, a);
      if (neighborsOf(g, t).some((n) => owner.get(n) === me)) adjacent = Math.max(adjacent, a);
    }
    const largestStack = adjacent || any;
    // Every opponent earns at least the game's base income (never below the 5 minimum), and
    // never less than the bonuses it visibly holds: its stack next to me limits neither.
    const floor = Math.max(MIN_ENEMY_DEPLOY, base);
    const visible = opening ? floor : Math.max(floor, base + bonusIncome);
    // What it was seen to deploy is cut only by what it could earn
    // (#69): its base plus every bonus none of whose territories someone else visibly holds
    // (an owner-only territory is visibly held: its owner shows). Both come from this board,
    // so a bonus it lost since last turn is out, though it may have paid for that deploy.
    let possible = 0;
    /** #235: of `possible`, the bonuses it visibly holds in full (no share of them goes to another). */
    let possibleOwn = 0;
    for (const b of g.map.bonuses) {
      const ts = bonusTerritories(g, b.id);
      if (b.value <= 0 || !ts.length) continue;
      const taken = ts.some((t) => {
        const st = ownerShown(seenNow.get(t));
        return st !== undefined && !(st.owner.kind === 'player' && st.owner.playerId === playerId);
      });
      if (!taken) possible += b.value;
      if (!taken && ts.every((t) => theirs.has(t))) possibleOwn += b.value;
    }
    // #226: with per-territory income, the territories it could hold pay at the rate: its visible
    // ones and every one whose owner this board hides (it may hold any of them).
    const couldHold =
      per > 0
        ? g.map.territories.filter((t) => {
            const st = ownerShown(seenNow.get(t.id));
            return st === undefined || (st.owner.kind === 'player' && st.owner.playerId === playerId) || theirs.has(t.id);
          }).length
        : held;
    const couldEarn = territoryIncome(couldHold, minimum, per) + possible;
    // #119: the fog prior. In a symmetric-start 1v1 an opponent bordering the fog earns at least
    // what I earn, capped at what it could earn on this board. It only ever raises the figure.
    const fogBeside = [...theirs].some((t) => neighborsOf(g, t).some((n) => !ownerShown(seenNow.get(n))));
    // #166: with its starts proven, its opening simulated from them raises the prior when it earns
    // more than I do; never lowers it (the simulation is a simple player, and #119's evidence read low).
    const priorBase = Math.max(prior?.myIncome ?? 0, prior?.opening?.get(playerId) ?? 0);
    // #235: in a free-for-all the hidden part of the board is shared: an even share of the hidden
    // territories and of the bonuses it could still hold (its own in full), never above couldEarn.
    const k = prior?.format === 'ffa' && (prior.opponents ?? 0) > 1 ? prior.opponents! : 0;
    const priorCap =
      prior && k > 0
        ? Math.min(couldEarn, territoryIncome(held + Math.ceil((couldHold - held) / k), minimum, per) + possibleOwn + Math.ceil((possible - possibleOwn) / k))
        : null;
    const priorFull = prior && fogBeside ? Math.min(Math.max(0, Math.floor(priorBase!)), priorCap ?? couldEarn) : null;
    // #444: incomes other players stated scale this one's prior down by their ratio to mine (never up).
    const statedRatio = prior?.stated && !prior.stated.players.some((x) => x.id === playerId) ? prior.stated.ratio : null;
    const priorFigure = priorFull !== null && statedRatio !== null ? Math.min(priorFull, Math.ceil(priorFull * statedRatio - 1e-9)) : priorFull;
    // #419: the past winners' pace, as the prior is figured (capped, scaled, only beside the fog), when above it.
    const paceIncome = prior?.winnerPace ? fogPaceIncome(prior.winnerPace, prior.myIncome) : null;
    const paceFull = paceIncome !== null && fogBeside && paceIncome > priorBase ? Math.min(paceIncome, priorCap ?? couldEarn) : null;
    const paceFigure = paceFull !== null && statedRatio !== null ? Math.min(paceFull, Math.ceil(paceFull * statedRatio - 1e-9)) : paceFull;
    const paceTop = paceFigure !== null && priorFigure !== null && paceFigure > priorFigure ? paceFigure : null;
    // A track over enough turns replaces the single-turn observed figure (S3).
    const track = tracks?.find((t) => t.playerId === playerId);
    const usable = track && track.income !== null && track.turns.length >= TRACKED_MIN_TURNS ? track : undefined;
    const tracked = usable ? usable.income : null;
    // #235 review: does the track end on this board? Its newest observed turn then ends at the turn
    // being planned (the newest board's turn, when that is not given: tracks end on `board`).
    const newestTurn = when.turn ?? usable?.lastTurn ?? null;
    const newest = usable?.turns.at(-1);
    const trackEndsNow = newest !== undefined && newest.to === newestTurn;
    // #123: what it was expected to deploy before this observation (its visible income, and its
    // tracked income when it has a usable track, else the prior): ambiguous armies beyond twice that
    // are moves out of the fog ({@link ambiguousBound}); a capture from me is priced at the guard.
    // With a track the prior stays out of the bound, and the reading is no part of the estimate
    // (#235 1c): the track replaces it. A track that ends on this board has read the newest turn
    // already, so the turn is read with that track's own bound (`ObservedTurn.expected`), and the
    // rationale's observed line agrees with the tracker and with the label below.
    const trackBound = trackEndsNow ? newest!.expected : undefined;
    const observation = previous
      ? observeDeploy(g, board, previous, playerId, settings, {
          me,
          guard: (settings.oneArmyStandsGuard ?? true) ? 1 : 0,
          expected: Math.max(visible, trackBound ?? tracked ?? priorFull ?? 0),
          most: couldEarn,
          // #293: under Local Deployment, growth beside the fog outside every bonus it could hold is
          // deploy only up to its free income.
          ...(settings.localDeployments
            ? { localFree: localFreeOn(base, MIN_ENEMY_DEPLOY, when.reinforcement ?? settings.opponentReinforcement, when.turn == null ? null : when.turn - 1) }
            : {}),
          ...(when.previousOrders ? { myOrders: when.previousOrders } : {}),
          // #271 review: the turn read is the one before the turn planned.
          ...(bombPossibleOn(settings, when.turn == null ? null : when.turn - 1) ? { bomb: true } : {}),
        })
      : null;
    // #235 1c: the track's newest turn, when it ends on this board and its bound cut armies that
    // arrived beside the fog (or joined a capture): what that turn reads with them all as deploys.
    // A label only: a stack walking in is not income (#123 lesson 5), so the estimate stays.
    const newestCut: EnemyDeployEstimate['newestCut'] =
      trackEndsNow && newest!.high > newest!.raw && (newest!.grewFromFog.length > 0 || newest!.reinforced.length > 0)
        ? {
            from: newest!.from,
            to: newest!.to,
            observed: newest!.observed,
            reading: Math.min(newest!.high, newest!.cap),
            expected: newest!.expected ?? null,
          }
        : null;
    const observedCap = observation ? couldEarn : null;
    const observedRaw = observation?.deploy ?? null;
    const observed = observation ? Math.min(observation.deploy, observedCap!) : null;
    // A usable track replaces the single-turn observed figure (S3; #235 1c: its newest reading too).
    const seenSource: EnemyDeployEstimate['source'] =
      tracked !== null
        ? tracked > visible
          ? 'tracked'
          : 'visible'
        : observed !== null && observed > visible
          ? 'observed'
          : 'visible';
    const seen = seenSource === 'tracked' ? tracked! : seenSource === 'observed' ? observed! : visible;
    // #235: the prior shrinks toward that evidence: the more consecutive observed turns, and the more
    // of its edge in view, the less of its lead it keeps.
    let priorBlend: EnemyDeployEstimate['priorBlend'] = null;
    if (priorFigure !== null && usable) {
      const toward = Math.max(tracked!, visible);
      if (priorFigure > toward) {
        // The consecutive observed turns up to the newest board; a run that stopped earlier is none.
        let turns = trackEndsNow ? 1 : 0;
        const run = usable.turns;
        for (let i = run.length - 1; turns > 0 && i > 0 && run[i - 1]!.from === run[i]!.from - 1; i--) turns++;
        const edge = new Set<number>();
        for (const t of theirs) for (const n of neighborsOf(g, t)) if (!theirs.has(n)) edge.add(n);
        const edgeShare = edge.size ? [...edge].filter((n) => ownerShown(seenNow.get(n)) !== undefined).length / edge.size : 0;
        // #294: each turn of the run weighs what it read of its frontier (this board's edge for a turn
        // that carries no coverage).
        const evidence = run.slice(run.length - turns).reduce((n, x) => n + (x.coverage?.share ?? edgeShare), 0);
        const share = turns ? evidence / turns : edgeShare;
        const weight = PRIOR_EVIDENCE_TURNS / (PRIOR_EVIDENCE_TURNS + evidence);
        const figure = toward + Math.ceil(weight * (priorFigure - toward) - 1e-9);
        priorBlend = { prior: priorFigure, toward, turns, share, weight, figure };
      }
    }
    const priorUsed = priorBlend ? priorBlend.figure : priorFigure;
    // #164: with every owner shown, its income is base + held bonuses exactly; a deploy above it was
    // a card (or armies the board misread), never income.
    const exact = ownersAll && !opening ? Math.max(0, base + bonusIncome) : null;
    const source: EnemyDeployEstimate['source'] =
      exact !== null ? 'exact' : priorUsed !== null && priorUsed > seen ? 'prior' : seenSource;
    // #294: what its tracked figure was read from (#368: while that is little, thin evidence below).
    const coverage = usable ? trackCoverage(usable.turns.filter((x) => usable.incomeTurns.includes(x.from))) : null;
    // #444: an untracked opponent whose prior a stated income scaled: #368's midpoint between what is in
    // view (or observed) and that prior.
    const statedMid = statedRatio !== null && source === 'prior' && !usable ? seen + Math.ceil((priorUsed! - seen) / 2 - 1e-9) : null;
    const chosen = source === 'exact' ? exact! : source === 'prior' ? (statedMid ?? priorUsed!) : seen;
    // #368 (owner decision of 2026-11-19: on a hidden opponent, choose the middle until we learn
    // otherwise): thin evidence — its tracked figure read from under LOW_COVERAGE of its frontier —
    // sizes it for the midpoint between the lower bound (what is in view or tracked, raised to the
    // trend's next step when its tracked figure rose two turns running, #418: unless I lead it on armies
    // in view and on income — above its tracked figure, or with LEAD_ARMIES × its armies above what it
    // earned before the newest rise) and the upper bound (the fog
    // prior whole, else the most it could earn), moved toward what the evidence gives as the coverage
    // nears LOW_COVERAGE. A rising track read from more of its frontier only raises the estimate to that
    // lower bound. Never the maximum.
    let thinEvidence: EnemyDeployEstimate['thinEvidence'] = null;
    if (source !== 'exact' && usable && tracked !== null) {
      // #418: no trend step on an opponent I lead on income (its tracked figure) and on armies in view.
      // #418 review: with LEAD_ARMIES × its armies in view, the income lead is judged against what it
      // earned before the newest rise (or its visible income) instead: an over-read tracked figure must
      // not switch off the gate meant to stop it. (On that judgement alone, with a bare army lead, the
      // calibration lost 3 of 4 changed samples further below truth.)
      let theirArmies = 0;
      for (const t of theirs) theirArmies += armies.get(t) ?? 0;
      const risen = risingTracked(usable.turns);
      const leadIt =
        risen !== null &&
        myArmies > theirArmies &&
        (myBoardIncome > Math.max(visible, tracked) || (myArmies >= LEAD_ARMIES * theirArmies && myBoardIncome > Math.max(visible, risen[1]!)));
      const rising = leadIt ? null : risen;
      const thinCoverage = coverage !== null && coverage.share < LOW_COVERAGE;
      if (thinCoverage || rising) {
        const trend = rising ? Math.min(couldEarn, rising[2]! + Math.ceil((rising[2]! - rising[0]!) / 2 - 1e-9)) : null;
        const lower = Math.min(couldEarn, Math.max(visible, tracked, trend ?? 0));
        // #419: the top of its range is the larger of the prior and the past winners' pace.
        const upper = Math.max(lower, Math.min(couldEarn, paceTop ?? priorFigure ?? couldEarn));
        const midpoint = lower + Math.ceil((upper - lower) / 2 - 1e-9);
        // What the evidence gives without thin evidence (the track, or #235's prior shrunk toward it),
        // never below the lower bound: the figure meets it at LOW_COVERAGE, so it does not jump there.
        const toward = Math.min(couldEarn, Math.max(lower, chosen));
        const weight = thinCoverage ? Math.max(0, 1 - coverage!.share / LOW_COVERAGE) : 0;
        const figure = toward + Math.ceil(weight * (midpoint - toward) - 1e-9);
        // Thin coverage: the figure replaces the estimate, up or down. A rising track alone: a raise only.
        if (thinCoverage || figure > chosen)
          thinEvidence = {
            coverage: coverage ? coverage.share : null,
            rising,
            tracked,
            prior: priorFigure,
            trend,
            lower,
            upper,
            midpoint,
            toward,
            weight,
            figure,
            ...(paceTop !== null && prior?.winnerPace
              ? {
                  pace: {
                    figure: paceTop,
                    basis: prior.winnerPace.basis,
                    afterTurn: prior.winnerPace.afterTurn,
                    games: prior.winnerPace.games,
                    ...(prior.winnerPace.ratio !== undefined ? { ratio: prior.winnerPace.ratio } : {}),
                  },
                }
              : {}),
          };
      }
    }
    const income = thinEvidence ? thinEvidence.figure : chosen;
    // #368: the figure thin evidence chose names its source: the prior when there is one and the figure
    // lies above the lower bound, else the track.
    const finalSource: EnemyDeployEstimate['source'] = thinEvidence
      ? thinEvidence.prior !== null && thinEvidence.figure > thinEvidence.lower
        ? 'prior'
        : 'tracked'
      : source;
    // #164: a Reinforcement card, from the turn the clock says one can be in hand, until a deployment
    // above its income is seen; the next card is due a card's capturing turns after the last one
    // (pieces carry over while a card is held), never before the turn after the play.
    // A play is seen as a deploy (its low reading) above the income that turn: exactly, when every
    // owner shows; under fog only a jump of the card's armies over its visible income counts (a
    // smaller excess may be a bonus the fog hides — and the tracked income then carries the jump).
    const played: number[] = [];
    if (when.reinforcement) {
      const above = (low: number, income: number) => (exact !== null ? low > income : low >= income + when.reinforcement!.armies);
      for (const x of track?.turns ?? []) if (above(x.low, x.visibleIncome)) played.push(x.from);
      // Last turn's deploy was paid by last turn's income: what it held on the previous board (a
      // bonus it lost since paid for it), never below this board's figure.
      if (observation && previous && when.turn !== null && when.turn !== undefined) {
        const before = new Set<number>();
        for (const t of previous.territories)
          if (g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === playerId) before.add(t.territoryId);
        const paid = boardIncome(g, before, { base: minimum, per }).total;
        if (above(observation.low, Math.max(exact ?? visible, paid))) played.push(when.turn - 1);
      }
    }
    let card: EnemyDeployEstimate['card'] = null;
    let cardPlayed: number | null = null;
    if (when.reinforcement && when.turn !== null && when.turn !== undefined) {
      const r = when.reinforcement;
      let due = r.firstTurn;
      let cards = 0;
      for (const t of [...new Set(played)].sort(byNum)) {
        if (t < due || t >= when.turn) continue;
        cards++;
        cardPlayed = t;
        due = r.turnsPerCard === null ? Infinity : Math.max(t + 1, r.firstTurn + cards * Math.max(1, r.turnsPerCard));
      }
      if (when.turn >= due && r.armies > 0) card = { armies: r.armies, due };
    }
    const estimate = income + (card?.armies ?? 0);
    return {
      playerId,
      estimate,
      held,
      base,
      bonusIncome,
      largestStack,
      opening,
      observed,
      observedRaw,
      observedCap,
      couldEarn,
      couldHold,
      observation,
      tracked,
      newestCut,
      trackedTurns: usable ? usable.incomeTurns : [],
      prior: priorFigure,
      priorBlend,
      coverage,
      priorCap,
      fogBeside,
      source: finalSource,
      thinEvidence,
      exact,
      card,
      cardPlayed,
      ...(priorFull !== null && priorFigure! < priorFull ? { stated: { full: priorFull, scaled: priorFigure!, lower: seen, midpoint: statedMid } } : {}),
    };
  });
}

/**
 * Default enemy deploy: the largest {@link enemyDeployEstimates} figure among the
 * players with a stack next to me — visible, or its owner shown and its armies hidden (#164) —
 * at least {@link MIN_ENEMY_DEPLOY}. Pass the turn, fog setting and Reinforcement clock (`when`)
 * and the fog prior {@link planEnemyEstimates} uses, or a mid-game board of equal stacks reads as
 * the opening board (#128), an opponent's card is left out (#164), and the figure disagrees with
 * the planner's. Unlike the planner's, it does not know the teams: a teammate counts.
 */
export function defaultEnemyDeploy(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings: PlannerSettings = {},
  previous?: BoardState,
  tracks?: readonly OpponentTrack[],
  prior?: EnemyIncomePrior,
  when: { turn?: number | null; fog?: string | undefined; reinforcement?: ReinforcementClock | undefined } = {},
): number {
  const mineIds = new Set(
    board.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me ? [t.territoryId] : [])),
  );
  const next = new Set<number>();
  for (const t of board.territories) {
    if (t.owner.kind !== 'player' || t.owner.playerId === me) continue;
    if (t.armies === null && (ownerShown(t) === undefined || visibleState(t))) continue;
    if (!g.territoryById.has(t.territoryId)) continue;
    if (neighborsOf(g, t.territoryId).some((n) => mineIds.has(n))) next.add(t.owner.playerId);
  }
  return enemyDeployEstimates(g, board, me, settings, previous, tracks, prior, when).reduce(
    (m, e) => (next.has(e.playerId) ? Math.max(m, e.estimate) : m),
    MIN_ENEMY_DEPLOY,
  );
}

/**
 * This turn's income on the board, cards aside: {@link boardIncome} over the territories `me`
 * holds, cut by the game's army cap (#253, {@link armyCapIncome}: min(income, round(cap × income)
 * − my armies on the board)). warapp_plan_turn and warapp_submit_turn both use it (plus the armies
 * of the card plays in their orders, which the cap leaves alone), so the plan's deploy total is the
 * total the submit check requires.
 */
export function incomeFor(g: MapGraph, board: BoardState, me: number, settings?: GameSettings): number {
  return incomeDetail(g, board, me, settings).income;
}

/**
 * Another player's income from what the board shows, before any army cap: base, bonuses and cities
 * over the territories it visibly holds. The cap is not applied (#253): its fogged armies are
 * unknown, so a cut from its visible armies alone would depend on the fog. My own income is
 * {@link incomeFor}.
 */
export function visibleIncomeFor(g: MapGraph, board: BoardState, player: number, settings?: GameSettings): number {
  const held = new Set<number>();
  let cities = 0;
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === player) {
      held.add(t.territoryId);
      cities += t.cities ?? 0;
    }
  return boardIncome(g, held, incomeRules(settings)).total + cityGold(cities, settings);
}

/**
 * #332: the gold a commerce game's cities pay each turn (CityIncome each), part of the income like a bonus (the client's
 * income function adds it after base and bonuses, before the army cap). 0 outside a commerce game with city income.
 */
export function cityGold(cities: number, settings?: GameSettings): number {
  const per = commerceRules(settings)?.cityIncome ?? 0;
  return cities > 0 && per > 0 ? cities * per : 0;
}

/**
 * {@link incomeFor} with the army cap's arithmetic: `cap` when the game has one and every territory
 * of mine shows its armies (my own always should); `capUnknown` when one does not, and the income is
 * then left uncut. The cap reads my armies from the start-of-turn standing as war.app showed it:
 * callers may pass a board with the award or a prior merged in (livePlanSetup's `board`), which must
 * never change my own territories' armies — a merge that did would move the cap's cut.
 */
export function incomeDetail(
  g: MapGraph,
  board: BoardState,
  me: number,
  settings?: GameSettings,
): { income: number; cap?: ArmyCapIncome; capUnknown?: true } {
  const held = new Set<number>();
  let armies = 0;
  let unread = false;
  let cities = 0;
  for (const t of board.territories) {
    if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player' || t.owner.playerId !== me) continue;
    held.add(t.territoryId);
    cities += t.cities ?? 0;
    if (t.armies === null) unread = true;
    else armies += t.armies;
  }
  const income = boardIncome(g, held, incomeRules(settings)).total + cityGold(cities, settings);
  if (settings?.armyCap === undefined || settings.armyCap === null || !(settings.armyCap > 0)) return { income };
  if (unread) return { income, capUnknown: true };
  const cap = armyCapIncome(income, settings.armyCap, armies)!;
  return { income: cap.received, cap };
}

