// What one planning pass (`planPass` in planner.ts) works from and what it builds (#133).
//
// `PlanCtx` is read-only: the inputs and everything derived from them before the first order is
// planned (the estimates phase, plan/estimates.ts) — the graph, the board, the settings, the kill
// rates and combat model, the opponents' deploy estimates, the game profile and the goal it picks.
// `PlanState` is what the phases share and change: the warnings and rationale, and the orders the
// plan has made so far. A phase moved out of planner.ts takes `(ctx, state)` explicitly instead of
// closing over planPass's locals; planPass still names each field as the local it was.
import type { BoardState, TerritoryState } from '../../board.js';
import type { CombatSettings } from '../combat.js';
import type { MapGraph } from '../graph.js';
import type { Refusal } from './captures.js';
import type { GameProfile } from '../profile.js';
import type {
  CardAdvice,
  EnemyDeployEstimate,
  EnemyIncomePrior,
  PlanGameContext,
  PlanGoal,
  PlannedMove,
  PlannerSettings,
  PlanOptions,
} from '../planner.js';

/** The opponents, their estimates, the game profile and the goal it picks (rule 0p). */
export interface OpponentsCtx {
  g: MapGraph;
  board: BoardState;
  me: number;
  s: PlannerSettings;
  baseIncome: number;
  opts: PlanOptions;
  income: number;
  /** The game context (`input.game`); planPass calls it `ctx`. */
  game: PlanGameContext;
  /** My teammates (#128): players on my team, never a threat, a target or an estimate. */
  allies: Set<number>;
  /** A player whose stacks threaten me and whose territories I may attack: not me, not a teammate. */
  foe: (p: number) => boolean;
  /** The turn being planned, when known (the opening board is the first turn's only, #128). */
  turnNow: number | null;
  incomePrior: EnemyIncomePrior | undefined;
  /** The deploy estimates of the opponents (teammates out). */
  estimateList: EnemyDeployEstimate[];
  /** An opponent's income: its deploy estimate less the Reinforcement card the clock adds (#164). */
  incomeOf: (e: EnemyDeployEstimate) => number;
  profile: GameProfile;
  /** The profile picks the goal and tunes the scoring (rule 0p): adapting, with no explicit goal. */
  auto: boolean;
  /** Rule 0p.3: behind on income. */
  behind: boolean;
  /** Rule 0p.3 (#72): behind on income in a 1v1 — strike, never defend. */
  strike: boolean;
  goal: PlanGoal;
  balanced: boolean;
  /** Rule 0p.3: behind — size attacks at the minimum (no pressure margin). */
  minimal: boolean;
  pressureFactor: number;
  /** The pressure margin over an estimated deploy: none when sizing at the minimum. */
  marginFor: (d: number) => number;
  /** Goals that refuse to complete a bonus they cannot hold (R3); the others only warn. */
  guarded: boolean;
  focus: Set<number>;
  reserve: number;
  /** The caller overrode the enemy deploy (`options.enemyDeploy`). */
  custom: boolean;
  mineAtStart: Set<number>;
  enemyDeploy: number;
  /** The opponents' estimates by player. */
  estimates: Map<number, EnemyDeployEstimate>;
  /** The deploy assumed for one opponent's threat: the override, else its own estimate. */
  deployOf: (player: number) => number;
  /** One opponent's income per turn: {@link deployOf} less the Reinforcement card it adds (#164). */
  incomeOfPlayer: (player: number) => number;
  /** #201: the game is decided, with the turns it has left. */
  decidedGame: { state: 'winning' | 'losing'; turns: number; loser: number; rate: number } | undefined;
  /** The turns every payback test counts (#201). */
  paybackTurns: number;
}

/** The territories as the board shows them, and what they are worth (cards aside). */
export interface BoardCtx {
  /** Each territory on the map, as the board shows it; planPass calls it `state`. */
  territories: Map<number, TerritoryState>;
  label: (id: number) => string;
  /** A bonus by name and id, as the rationale names it. */
  bonusName: (id: number) => string;
  isMine: (id: number) => boolean;
  mine: number[];
  mineSet: Set<number>;
  boardIncomeNow: number;
  cardArmies: number;
  /** The income change (#70, #85) from holding `after` instead of what I held at the start. */
  incomeGain: (after: ReadonlySet<number>) => number;
  nextIncomeWith: (gain: number) => number;
  incomeAfter: (after: ReadonlySet<number>) => number;
  armiesOf: (id: number) => number;
  unitsAt: (id: number) => number;
  uncounted: (id: number) => boolean;
  uncountedKind: (id: number) => string;
  defenceAt: (id: number) => number;
  /** The territories of each bonus. */
  bonusTs: Map<number, readonly number[]>;
  /** The bonuses each territory is in (superbonuses through their members included). */
  bonusesWith: Map<number, number[]>;
  completedBy: (after: ReadonlySet<number>) => number[];
  completedOver: (holds: (t: number) => boolean, fresh: Iterable<number>) => number[];
  territoryShare: (k: number) => number;
  plainWorth: (_t: number, gain: number) => number;
  inFocus: (t: number) => boolean;
}

/** The combat model: kill rates, luck, rounding, and what a capture or a hold costs. */
export interface CombatCtx {
  guard: number;
  bombOn: boolean;
  rates: { offensiveKillRate: number; defensiveKillRate: number };
  combat: CombatSettings;
  chanceOf: (armies: number, defenders: number) => number;
  minWin: number;
  exactCombat: boolean;
  heldAtStart: Set<number>;
  chanceAt: (t: number) => number;
  costOf: (defenders: number, chance?: number) => number | null;
  costAt: (t: number, defenders?: number) => number | null;
  toTake: (defenders: number) => number | null;
  econCostAt: (x: number) => number;
  luck: number;
  weightedRounding: boolean;
  noSplit: boolean;
}

/** Where I stand on armies (#167, #201, rule 0p.3) and what that switches. */
export interface StandingCtx {
  armyLead: { my: number; rival: number | undefined; theirs: number; ratio: number };
  leadLever: boolean;
  clearLeader: number | undefined;
  ffaLeader: boolean;
  holdPasses: 'worst' | 'expected' | undefined;
  leadText: () => string;
  myCommanders: Set<number>;
  /** Rule 0p.3 (#72): behind on armies in a 1v1, with the totals the rationale names. */
  armiesBehindVs: { myArmies: number; rival: number; theirs: number } | undefined;
  armiesBehind: boolean;
}

/** Everything a planning pass reads and never changes. */
export type PlanCtx = OpponentsCtx & BoardCtx & CombatCtx & StandingCtx;

/**
 * What the phases of one planning pass share and change. The collections are shared as they are,
 * so a phase that takes the state sees (and makes) the same changes planPass's locals of the same
 * name do; the values a phase reassigns (`budget`, `holdings`, `cardAdvice`, and the capture
 * passes' `anchor`, `assumeGone`, `refusal`, `evenTradesOnly` and `spendKeeps`) are read and
 * written as `ps.<field>` everywhere.
 */
export interface PlanState {
  /** The income not yet deployed (the deploy book, plan/orders.ts, opens it at the income). */
  budget: number;
  /**
   * What protected value is judged against (R2): my holdings at the start of the turn until the
   * capture passes have run, then those plus this turn's captures.
   */
  holdings: ReadonlySet<number>;
  /** The card to play this turn, if any (rule 1s; rule 1b's withdrawals): reassigned as orders are made. */
  cardAdvice: CardAdvice | null;
  warnings: string[];
  rationale: string[];
  /** Armies deployed on each territory of mine. */
  deployed: Map<number, number>;
  /** Armies each territory of mine may still send (after the guard). */
  avail: Map<number, number>;
  locked: Set<number>;
  /** #179: what a territory covering a finished-off player's exit keeps, in `avail` terms. */
  coverKeep: Map<number, number>;
  /** #179: a buffer in an FFA left standing: no pass captures its territories this turn. */
  spared: Set<number>;
  /** #201: players left standing because absorbing them would not catch the leader. */
  unabsorbed: Set<number>;
  /** #201: the "Absorb player …" line per player, dropped when no attack on that player is made. */
  absorbLines: Map<number, string>;
  captured: Set<number>;
  /** Targets taken by a combined (multi-source) capture. */
  combined: Set<number>;
  moves: PlannedMove[];
  /** Armies withdrawn into each territory this turn (they stay there: armies never move twice). */
  incoming: Map<number, number>;
  /** Armies that occupy each capture this turn (its finishing attack's survivors). */
  survivorsAt: Map<number, number>;
  /** Every capture planned, in the order it was made (a rolled-back one may repeat; filter by `captured`). */
  captureOrder: number[];
  /** How to take back each capture's attacks (rule 4c's guard), by target. */
  captureUndo: Map<number, () => void>;
  /** Captures that stage a positive bonus under rule 4c(c), with the bonus they stage. */
  staged: Map<number, number>;
  /** The expansion stack: the source of the first bonus pass's finishing attack (the leftover deploy's home). */
  anchor: number | undefined;
  /** Territories a pass assumes fall this turn (finishing a player off): they threaten nothing. */
  assumeGone: (n: number) => boolean;
  /** Why the last tryCapture refused (R3, No-Split on a source that could take it); else size. */
  refusal: Refusal;
  /**
   * Rule 4e in contact (#107): a capture of a player's territory must trade at least even. Set while
   * the fallback tries an enemy capture; a combined capture that loses more than it kills is then
   * refused (as when behind on armies, rule 0p.3).
   */
  evenTradesOnly: boolean;
  /**
   * Set only while rule 4e retries a step that failed on its size, to name the border it would
   * have stripped (its hold check then reports it, as before #121).
   */
  spendKeeps: boolean;
}

/** An empty plan state: nothing deployed, moved, captured or said yet. */
export function newPlanState(): PlanState {
  return {
    budget: 0,
    holdings: new Set(),
    cardAdvice: null,
    warnings: [],
    rationale: [],
    deployed: new Map(),
    avail: new Map(),
    locked: new Set(),
    coverKeep: new Map(),
    spared: new Set(),
    unabsorbed: new Set(),
    absorbLines: new Map(),
    captured: new Set(),
    combined: new Set(),
    moves: [],
    incoming: new Map(),
    survivorsAt: new Map(),
    captureOrder: [],
    captureUndo: new Map(),
    staged: new Map(),
    anchor: undefined,
    assumeGone: () => false,
    refusal: undefined,
    evenTradesOnly: false,
    spendKeeps: false,
  };
}
