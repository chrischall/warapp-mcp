// Attacks on a player judged by their exchange, and a multi-turn view of a contested border
// (#167). Pure and deterministic; no I/O.
//
// Exchange. At the default rates (60/70, no luck) an attack below seven sixths of the defenders
// loses more armies than it kills; from there to five thirds it kills more without capturing;
// above that it captures. `classifyExchange` gives kills, losses and capture at three defender
// sizes — as they stand, after the owner's estimated deploy, after its whole income — and a label:
//   - certain first strike: it captures even if the whole income lands there first;
//   - favourable exchange: against the estimated deploy it kills more than it loses (or captures);
//   - strike last: it does not pay, but the target's stack can hit my source — stand, let it
//     attack first, and strike its survivors last;
//   - stand: it loses more than it kills.
// Kills are luck-free and straight-rounded (`straightKills`), each side capped at the other's
// armies; a capture needs every defender dead and an attacker alive (`armiesToTake`).
//
// Border forecast. Two stacks facing each other, both owners deploying on them every turn, simulated
// forward with `simulateTurn` (one turn's resolution, chained through its `start` board, so the
// guard and the rounding are the game's): "press" — I attack with everything movable every turn
// while the opponent defends — and "pressed", the reverse. The outcome is `breaks` (press captures
// first), `ground-down` (pressed captures first; a tie goes to the opponent: the worse case), or
// `stand-off` (neither within the horizon). `pinned` is the least I must deploy there each turn for
// pressed not to break me within the horizon: the income the border pins (my whole income when
// even that is not enough).

import { armiesToTake, DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE, straightKills, type KillRates } from './combat.js';
import { buildGraph, type MapGraph } from './graph.js';
import { simulateTurn, type SimSettings, type SimTerritory } from './turn-sim.js';

export type ExchangeLabel = 'certain first strike' | 'favourable exchange' | 'strike last' | 'stand';

export interface ExchangeCase {
  /** `now`: the defenders as they stand; `estimated`: plus the owner's estimated deploy; `whole`: plus its whole income. */
  case: 'now' | 'estimated' | 'whole';
  defenders: number;
  kills: number;
  losses: number;
  /** kills − losses. */
  net: number;
  captures: boolean;
}

export interface ExchangeInput {
  attackers: number;
  /** The defenders there now (special units included). */
  defenders: number;
  /** The owner's estimated deploy there. */
  deploy: number;
  /** The owner's whole income (at least `deploy`). */
  income: number;
  /** The target's stack can attack my source this turn (an equal stack): an unprofitable attack is struck last. */
  threatensSource?: boolean;
  rates?: KillRates;
}

export interface Exchange {
  label: ExchangeLabel;
  cases: ExchangeCase[];
}

export function classifyExchange(input: ExchangeInput): Exchange {
  const off = input.rates?.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE;
  const def = input.rates?.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE;
  const a = Math.max(0, input.attackers);
  const at = (kind: ExchangeCase['case'], d: number): ExchangeCase => {
    const kills = Math.min(d, straightKills(a, off));
    const losses = Math.min(a, straightKills(d, def));
    const take = armiesToTake(d, input.rates);
    return { case: kind, defenders: d, kills, losses, net: kills - losses, captures: take !== null && a >= take };
  };
  const d0 = Math.max(0, input.defenders);
  const est = Math.max(0, input.deploy);
  const whole = Math.max(est, input.income);
  const cases = [at('now', d0), at('estimated', d0 + est), at('whole', d0 + whole)];
  const [, e, w] = cases as [ExchangeCase, ExchangeCase, ExchangeCase];
  const label: ExchangeLabel = w.captures
    ? 'certain first strike'
    : e.captures || e.net > 0
      ? 'favourable exchange'
      : input.threatensSource
        ? 'strike last'
        : 'stand';
  return { label, cases };
}

/** The forecast horizon in turns (the planner's payback horizon). */
export const FORECAST_TURNS = 10;

export type BorderOutcome = 'breaks' | 'ground-down' | 'stand-off';

export interface BorderForecastInput {
  /** My stack on the border. */
  mine: number;
  /** The opponent's stack facing it. */
  theirs: number;
  myIncome: number;
  theirIncome: number;
  /** What I deploy on my stack each turn (default my whole income). */
  myDeploy?: number;
  /** Default {@link FORECAST_TURNS}. */
  turns?: number;
  settings?: SimSettings;
}

export interface BorderForecast {
  outcome: BorderOutcome;
  /** The turn (1-based) the border breaks either way; `null` for a stand-off. */
  turn: number | null;
  /** The horizon simulated. */
  turns: number;
  /** The least deploy a turn on my stack that keeps it from being ground down within the horizon. */
  pinned: number;
}

const ME = 1;
const THEM = 2;
let pairGraph: MapGraph | undefined;
/** Two territories, 1 (mine) and 2 (theirs), next to each other. */
function pair(): MapGraph {
  pairGraph ??= buildGraph({
    id: 0,
    name: 'border',
    territories: [
      { id: 1, name: 'mine', connectedTo: [2] },
      { id: 2, name: 'theirs', connectedTo: [1] },
    ],
    bonuses: [],
    distributionModes: [],
  });
  return pairGraph;
}

/**
 * The turn (1-based) `attacker` first captures the other stack when it attacks with everything
 * movable every turn and both deploy their per-turn armies on their stacks; `null` within `turns`.
 */
function grind(attacker: number, mine: number, theirs: number, myDeploy: number, theirDeploy: number, turns: number, settings: SimSettings): number | null {
  const g = pair();
  const guard = settings.oneArmyStandsGuard === false ? 0 : 1;
  let start = new Map<number, SimTerritory>([
    [1, { owner: ME, armies: Math.max(0, mine) }],
    [2, { owner: THEM, armies: Math.max(0, theirs) }],
  ]);
  const from = attacker === ME ? 1 : 2;
  const to = attacker === ME ? 2 : 1;
  for (let turn = 1; turn <= turns; turn++) {
    const before = start.get(from)!.armies + (attacker === ME ? myDeploy : theirDeploy);
    const movable = before - guard;
    const r = simulateTurn({
      graph: g,
      board: { source: 'gamefeed', verified: false, territories: [] },
      start,
      deploys: [
        { player: ME, territoryId: 1, armies: Math.max(0, myDeploy) },
        { player: THEM, territoryId: 2, armies: Math.max(0, theirDeploy) },
      ],
      orders: movable > 0 ? [{ player: attacker, orders: [{ from, to, armies: movable }] }] : [],
      moveOrder: [attacker],
      settings,
    });
    if (r.territories.get(to)!.owner === attacker) return turn;
    start = r.territories;
  }
  return null;
}

export function forecastBorder(input: BorderForecastInput): BorderForecast {
  const turns = Math.max(1, Math.floor(input.turns ?? FORECAST_TURNS));
  const settings: SimSettings = { ...input.settings, luckModifier: 0, roundingMode: 'StraightRound' };
  const myIncome = Math.max(0, Math.floor(input.myIncome));
  const theirIncome = Math.max(0, Math.floor(input.theirIncome));
  const myDeploy = Math.min(myIncome, Math.max(0, Math.floor(input.myDeploy ?? myIncome)));
  const press = grind(ME, input.mine, input.theirs, myDeploy, theirIncome, turns, settings);
  const pressed = grind(THEM, input.mine, input.theirs, myDeploy, theirIncome, turns, settings);
  let outcome: BorderOutcome;
  let turn: number | null;
  if (pressed !== null && (press === null || pressed <= press)) {
    outcome = 'ground-down';
    turn = pressed;
  } else if (press !== null) {
    outcome = 'breaks';
    turn = press;
  } else {
    outcome = 'stand-off';
    turn = null;
  }
  let pinned = myIncome;
  for (let d = 0; d <= myIncome; d++)
    if (grind(THEM, input.mine, input.theirs, d, theirIncome, turns, settings) === null) {
      pinned = d;
      break;
    }
  return { outcome, turn, turns, pinned };
}
