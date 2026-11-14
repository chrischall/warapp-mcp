// The outlook (#178): whether a game is being won, lost, is even or is stuck, from my boards over
// the last turns. Pure and deterministic; no I/O.
//
// Strength is armies + STRENGTH_INCOME_TURNS × income (the #167 FFA ranking's measure): what a
// player can field over the next few turns. Mine is exact. An opponent's is a range under fog:
//   - low: its visible armies + k × the income it visibly earns (both lower bounds);
//   - high: what it could have, at most — every army it can have received (its start plus, each
//     turn paid, the most it could earn that turn: the could-earn cap of an observed turn, else
//     the whole map's territory income plus every bonus, since a bonus held by someone else now
//     may have paid it before; under BonusArmyPer an observed cap, which counts only territories
//     in view, is raised by what the rest of the map could add) and k × its could-earn cap now.
//     In a team game a teammate can transfer armies to it, so its high is not a ceiling there. Unbounded (`null`) when the start is unknown, cards can add armies, or it has
//     nothing in view. With every territory in view, high = low.
// The ratio is mine ÷ the strongest opponent's, as a range: `low` against the highest `high`,
// `high` against the highest `low` (`null`: no upper limit). It is per player: in a team game my
// strength alone against the single strongest opponent, teams are not summed.
//
// Each turn gets a state: `winning` when even the low ratio is at least OUTLOOK_RATIO (or every
// opponent is bounded at no strength at all while I have some), `losing`
// when even the high ratio is at most 1 / OUTLOOK_RATIO, `stalemate` when neither and no territory
// in view on both boards changed owner since the turn before while I face an enemy and (#201) the
// main front's multi-turn forecast is a stand-off, else `even`. The main front is my biggest stack
// next to an enemy against the biggest enemy stack beside it, both owners deploying their visible
// income there every turn (`forecastBorder`, exchange.ts): a front that breaks or grinds me down
// within the horizon is not stuck, however quiet the last turns were.
// The outlook reports a state only once it has held for OUTLOOK_TURNS consecutive turns; until
// then `state` is null and the basis says what each turn read.
//
// OUTLOOK_RATIO (2.4×) is borrowed from a published bot's "lost" rule and has never been measured
// for war.app: the outlook is a basis for a decision, not a verdict. The planner acts on it in one
// way only (#201): once winning or losing, its payback tests count the turns the game has left.

import type { BoardState } from '../board.js';
import { carriesTeam } from '../teams.js';
import { neighborsOf, type MapGraph } from './graph.js';
import { trackOpponents, type TrackGame, type TurnBoard } from './opponents.js';
import type { PlannerSettings } from './planner.js';
import { boardIncome, DEFAULT_BASE_INCOME, territoryIncome } from './player.js';
import { STRENGTH_INCOME_TURNS } from './profile.js';
import { forecastBorder, type BorderOutcome } from './exchange.js';

/** Turns a state must hold before it is reported. */
export const OUTLOOK_TURNS = 3;
/** Winning at this strength ratio or more, losing at its inverse or less (borrowed, unmeasured). */
export const OUTLOOK_RATIO = 2.4;

export type OutlookState = 'winning' | 'losing' | 'even' | 'stalemate';

export interface OutlookTurn {
  turn: number;
  /** My strength: armies + k × income. */
  mine: number;
  /** The strongest opponent (by `high`, unbounded first, then `low`, then id); `null` when there is none. */
  strongest: { playerId: number; low: number; high: number | null } | null;
  /** Mine ÷ the opponents' strength: `low` against the highest high (0 when unbounded or that high is 0), `high` against the highest low (`null`: no limit). */
  ratio: { low: number; high: number | null };
  /** Territories in view on this board and the one before that changed owner (`null` without the board before). */
  changed: number | null;
  /**
   * #201: the main front's forecast — my biggest stack next to an enemy against the biggest enemy
   * stack beside it, both deploying their visible income every turn. Absent with no front.
   */
  front?: { mine: number; theirs: number; player: number; outcome: BorderOutcome; turn: number | null };
  state: OutlookState;
}

export interface GameOutlook {
  /** The state, once it held for {@link OUTLOOK_TURNS} turns; `null` until then. */
  state: OutlookState | null;
  /** How many of the latest turns read the newest turn's state. */
  heldTurns: number;
  /** The turns judged (the latest {@link OUTLOOK_TURNS} consecutive ones), oldest first. */
  turns: OutlookTurn[];
  /** Strength = armies + `k` × income. */
  k: number;
  threshold: number;
  /** One paragraph: the measure, the latest turn's figures, the thresholds and why they are not a verdict. */
  basis: string;
}

export interface OutlookInput {
  graph: MapGraph;
  me: number;
  /** My boards, any order (one per turn; the last given wins), the turn being played included. */
  boards: readonly TurnBoard[];
  settings?: PlannerSettings;
  /** The game's players and starts ({@link trackGame}). */
  game?: TrackGame;
  /** Cards are in play: a Reinforcement card can add armies, so no opponent's strength is bounded above under fog. */
  cards?: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

const fullyVisible = (g: MapGraph, b: BoardState) => {
  const seen = new Set<number>();
  for (const t of b.territories) if (t.owner.kind !== 'unknown' && t.armies !== null) seen.add(t.territoryId);
  return [...g.territoryById.keys()].every((t) => seen.has(t));
};

function ownersOf(g: MapGraph, b: BoardState): Map<number, string> {
  const m = new Map<number, string>();
  for (const t of b.territories) {
    if (!g.territoryById.has(t.territoryId) || t.owner.kind === 'unknown') continue;
    m.set(t.territoryId, t.owner.kind === 'player' ? `p${t.owner.playerId}` : 'n');
  }
  return m;
}

export function gameOutlook(input: OutlookInput): GameOutlook {
  const { graph: g, me } = input;
  const settings = input.settings ?? {};
  const k = STRENGTH_INCOME_TURNS;
  const byTurn = new Map<number, TurnBoard>();
  for (const b of input.boards) byTurn.set(b.turn, b);
  const all = [...byTurn.keys()].sort((a, b) => a - b);
  // The latest run of consecutive turns, at most OUTLOOK_TURNS long.
  const run: number[] = [];
  for (let i = all.length - 1; i >= 0 && run.length < OUTLOOK_TURNS; i--) {
    if (run.length && all[i] !== run[0]! - 1) break;
    run.unshift(all[i]!);
  }
  const players = input.game?.players ?? [];
  const myTeam = players.find((p) => p.id === me)?.team;
  const ally = (id: number) => id === me || (carriesTeam(myTeam) && players.find((p) => p.id === id)?.team === myTeam);
  const teamGame = players.some((p) => carriesTeam(p.team));
  const stillPlaying = (id: number) => (players.find((p) => p.id === id)?.state ?? 'Playing') === 'Playing';
  const rules = { base: Math.max(0, Math.floor(settings.baseIncome ?? DEFAULT_BASE_INCOME)), per: settings.bonusArmyPer ?? 0 };
  const allBonuses = [...g.bonusById.values()].reduce((s, b) => s + Math.max(0, b.value), 0);
  // The most any player can earn in a turn: the whole map's territory income (BonusArmyPer) plus
  // every bonus. An observed turn's cap counts only the territories in view, so under BonusArmyPer
  // it is raised by what the rest of the map could add to the base, never past this ceiling.
  const mapTerritories = territoryIncome(g.territoryById.size, rules.base, rules.per);
  const ceiling = mapTerritories + allBonuses;
  const turnCap = (observed: number | undefined) =>
    observed === undefined ? ceiling : Math.min(ceiling, observed + mapTerritories - rules.base);
  const start = input.game?.start ? input.game.start.territories * input.game.start.armiesPerTerritory : null;

  const turns: OutlookTurn[] = run.map((turn) => {
    const board = byTurn.get(turn)!.board;
    const held = new Map<number, Set<number>>();
    const armies = new Map<number, number>();
    for (const t of board.territories) {
      if (!g.territoryById.has(t.territoryId) || t.owner.kind !== 'player' || t.armies === null) continue;
      const p = t.owner.playerId;
      if (!held.has(p)) held.set(p, new Set());
      held.get(p)!.add(t.territoryId);
      armies.set(p, (armies.get(p) ?? 0) + t.armies);
    }
    const mine = (armies.get(me) ?? 0) + k * boardIncome(g, held.get(me) ?? new Set(), rules).total;
    const open = fullyVisible(g, board);
    const tracks = open ? [] : trackOpponents(g, [...byTurn.values()].filter((b) => b.turn <= turn), me, settings, input.game);
    const trackOf = new Map(tracks.map((t) => [t.playerId, t]));
    const ids = new Set<number>([...held.keys()].filter((p) => !ally(p)));
    for (const p of players) if (!ally(p.id) && stillPlaying(p.id)) ids.add(p.id);
    const rows = [...ids]
      .filter((p) => stillPlaying(p))
      .sort((a, b) => a - b)
      .map((playerId) => {
        const a = armies.get(playerId) ?? 0;
        const income = boardIncome(g, held.get(playerId) ?? new Set(), rules).total;
        const low = a + k * income;
        if (open) return { playerId, low, high: low as number | null };
        if (!held.has(playerId) || start === null || input.cards) return { playerId, low, high: null };
        // The could-earn cap per observed turn (paid at the start of `to`); any other turn is
        // bounded by the ceiling ({@link turnCap}).
        const observedCap = new Map<number, number>();
        for (const x of trackOf.get(playerId)?.turns ?? []) observedCap.set(x.to, Math.max(observedCap.get(x.to) ?? 0, x.cap));
        let received = start;
        for (let t = 1; t <= turn; t++) received += turnCap(observedCap.get(t));
        const cap = Math.max(income, turnCap(observedCap.get(turn)));
        return { playerId, low, high: Math.max(a, received) + k * cap };
      });
    const maxLow = rows.reduce((m, r) => Math.max(m, r.low), 0);
    const unbounded = rows.some((r) => r.high === null);
    const maxHigh = rows.reduce((m, r) => Math.max(m, r.high ?? 0), 0);
    const strongest =
      [...rows].sort(
        (a, b) =>
          (a.high === null ? 0 : 1) - (b.high === null ? 0 : 1) || (b.high ?? 0) - (a.high ?? 0) || b.low - a.low || a.playerId - b.playerId,
      )[0] ?? null;
    const ratio = {
      low: !unbounded && maxHigh > 0 ? round2(mine / maxHigh) : 0,
      high: maxLow > 0 ? round2(mine / maxLow) : null,
    };
    // Every opponent bounded at no strength at all while I have some: dominated.
    const dominated = rows.length > 0 && !unbounded && maxHigh === 0 && mine > 0;
    const prev = byTurn.get(turn - 1)?.board;
    let changed: number | null = null;
    if (prev) {
      const before = ownersOf(g, prev);
      const after = ownersOf(g, board);
      changed = [...after].filter(([t, o]) => before.has(t) && before.get(t) !== o).length;
    }
    // The first entry per territory, as a linear find would read it.
    const ownerById = new Map<number, BoardState['territories'][number]['owner']>();
    for (const x of board.territories) if (!ownerById.has(x.territoryId)) ownerById.set(x.territoryId, x.owner);
    const front = [...(held.get(me) ?? [])].some((t) =>
      neighborsOf(g, t).some((n) => {
        const o = ownerById.get(n);
        return o?.kind === 'player' && !ally(o.playerId);
      }),
    );
    // #201: the main front, forecast forward.
    let main: { mine: number; theirs: number; player: number } | undefined;
    for (const x of [...(held.get(me) ?? [])].sort((a, b) => a - b)) {
      const ours = board.territories.find((t) => t.territoryId === x)?.armies ?? 0;
      for (const n of neighborsOf(g, x)) {
        const o = ownerById.get(n);
        const st = board.territories.find((t) => t.territoryId === n);
        if (o?.kind !== 'player' || ally(o.playerId) || st?.armies == null) continue;
        if (!main || ours > main.mine || (ours === main.mine && st.armies > main.theirs))
          main = { mine: ours, theirs: st.armies, player: o.playerId };
      }
    }
    let forecast: OutlookTurn['front'];
    if (main) {
      const f = forecastBorder({
        mine: main.mine,
        theirs: main.theirs,
        myIncome: boardIncome(g, held.get(me) ?? new Set(), rules).total,
        theirIncome: boardIncome(g, held.get(main.player) ?? new Set(), rules).total,
        settings: {
          ...(settings.offensiveKillRate !== undefined ? { offensiveKillRate: settings.offensiveKillRate } : {}),
          ...(settings.defensiveKillRate !== undefined ? { defensiveKillRate: settings.defensiveKillRate } : {}),
          ...(settings.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: settings.oneArmyStandsGuard } : {}),
        },
      });
      forecast = { ...main, outcome: f.outcome, turn: f.turn };
    }
    const state: OutlookState =
      dominated || (rows.length && ratio.low >= OUTLOOK_RATIO)
        ? 'winning'
        : ratio.high !== null && ratio.high <= 1 / OUTLOOK_RATIO
          ? 'losing'
          : changed === 0 && front && (!forecast || forecast.outcome === 'stand-off')
            ? 'stalemate'
            : 'even';
    return { turn, mine, strongest, ratio, changed, ...(forecast ? { front: forecast } : {}), state };
  });

  const last = turns.at(-1);
  let heldTurns = 0;
  for (let i = turns.length - 1; i >= 0 && turns[i]!.state === last?.state; i--) heldTurns++;
  const state = last && heldTurns >= OUTLOOK_TURNS ? last.state : null;
  const measure = `Strength = armies + ${k} × income; an opponent's is a range under fog (low: what is in view; high: the most it could have received and earn). Per player: my strength alone against the single strongest opponent, teams not summed.${teamGame ? ' In a team game a teammate can transfer armies to an opponent, so its high is not a ceiling.' : ''}`;
  const thresholds = `Winning at ${OUTLOOK_RATIO}× the strongest opponent or more even at its high, losing at 1/${OUTLOOK_RATIO} (${round2(1 / OUTLOOK_RATIO)}×) or less even at its low, stalemate when nothing in view changed hands for ${OUTLOOK_TURNS} turns along a front whose forecast is a stand-off. The ${OUTLOOK_RATIO}× is borrowed from a bot and was never measured for war.app: a basis for a decision, not a verdict.`;
  let reading: string;
  if (!last) reading = 'No board to judge.';
  else {
    const s = last.strongest;
    const figures = s
      ? `turn ${last.turn}: mine ${last.mine}, the strongest opponent player ${s.playerId} at ${s.high === s.low ? s.low : `${s.low}–${s.high ?? 'unbounded'}`}, ratio ${last.ratio.high === last.ratio.low ? last.ratio.low : `${last.ratio.low}–${last.ratio.high ?? 'unbounded'}`}×`
      : `turn ${last.turn}: mine ${last.mine}, no opponent to compare`;
    reading =
      turns.length < OUTLOOK_TURNS
        ? `Only ${turns.length} turn${turns.length === 1 ? '' : 's'} of boards in a row (${OUTLOOK_TURNS} needed), so no state yet; ${figures}.`
        : state
          ? `${state[0]!.toUpperCase()}${state.slice(1)} for ${OUTLOOK_TURNS} turns running; ${figures}.`
          : `${last.state[0]!.toUpperCase()}${last.state.slice(1)} for ${heldTurns} of the ${OUTLOOK_TURNS} turns (${turns.map((t) => t.state).join(', ')}), so no state yet; ${figures}.`;
  }
  return { state, heldTurns, turns, k, threshold: OUTLOOK_RATIO, basis: `${reading} ${measure} ${thresholds}` };
}
