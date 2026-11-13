// Opponent tracking (S3): what a history of my own boards says about each opponent. Pure and
// deterministic (ties on ascending id, no I/O).
//
// Every turn pair is read with F1's rules (#69, `observeDeploy`): only territories visible on
// both boards count, so a stack that comes out of the fog is never deploy, never a capture and
// never "armies that moved into the fog". A capture out of the fog (#86, `fromFog`) counts
// what it cost (the defenders' kills at the defensive kill rate), never the stack standing
// there: that stack moved, it is not income. From the per-turn observations:
//  - income (visible income is the one income rule, `boardIncome`, via enemyDeployEstimates):
//    the median of the last {@link MEDIAN_TURNS} observed deploys, floored at what it
//    visibly earns on the newest board (base income + the bonuses it visibly holds in full);
//  - unaccounted armies: the income it earned since first seen (each turn: what it visibly
//    earned, or what it was seen to deploy when more) minus the change of its visible armies
//    and what it visibly lost — armies that must be somewhere in the fog;
//  - inferred bonuses: when the income beats the visible income, the combinations of bonuses
//    it could hold (none of their territories visibly held by anyone else, neutral included)
//    whose values come closest to the gap. Every combination that fits equally well is listed:
//    they are candidates, never an assertion.
import type { BoardState } from '../board.js';
import { bonusTerritories } from './bonuses.js';
import { DEFAULT_DEFENSIVE_KILL_RATE, straightKills } from './combat.js';
import type { MapGraph } from './graph.js';
import { enemyDeployEstimates, ownerShown, visibleState, type PlannerSettings } from './planner.js';

/** One of my boards and the turn it was seen on (the turn being played on it). */
export interface TurnBoard {
  turn: number;
  board: BoardState;
}

/** Observed deploys feeding the income median. */
export const MEDIAN_TURNS = 3;
/** Most bonuses in one inferred combination. */
export const MAX_COMBINATION = 3;
/** Inferred combinations listed before "and N more". */
export const MAX_LISTED_COMBINATIONS = 8;

/** What one turn (board `from` → board `to`) showed of one opponent. */
export interface ObservedTurn {
  /** The turn whose orders the change shows (the earlier board's turn). */
  from: number;
  /** The later board's turn (`from + 1`: only consecutive boards are compared). */
  to: number;
  /** Its observed deploy, capped at what it could earn ({@link ObservedTurn.cap}). */
  observed: number;
  /** The observed deploy before the cap. */
  raw: number;
  /** Base income plus every bonus it could still hold, on the later board. */
  cap: number;
  /** Territories visible on both boards and its on the later one, by id. */
  counted: number[];
  /** Of `counted`, those it took from another visible owner. */
  captured: number[];
  /** Of `captured`, those taken (at least partly) out of the fog (#86): only their cost is deploy. */
  fromFog: number[];
  /** Its territories on the later board that the earlier one did not show: fog reveals. */
  reveals: number[];
  /** Base income + visibly held bonuses on the earlier board: what it surely earned that turn. */
  visibleIncome: number;
  /** What it earned, as far as can be told: max(visibleIncome, observed). */
  earned: number;
  /** Change of its armies over territories visible on both boards (held on either). */
  net: number;
  /**
   * Armies it visibly lost: whole stacks on territories taken from it, and what its captures
   * cost (the defenders' kills at the defensive kill rate, as observeDeploy counts them).
   */
  losses: number;
}

/** One combination of bonuses that would explain an income gap. */
export interface BonusCombination {
  bonusIds: number[];
  total: number;
}

export interface InferredBonuses {
  /** income − visibleIncome. */
  gap: number;
  /** Some combination's values sum to exactly the gap. */
  exact: boolean;
  /** The best-fitting combinations (fewest bonuses first, then ids), at most {@link MAX_LISTED_COMBINATIONS}. */
  candidates: BonusCombination[];
  /** Further combinations that fit equally well, not listed. */
  more: number;
}

export interface OpponentTrack {
  playerId: number;
  /** The first turn whose board showed any territory of it. */
  firstSeen: number;
  /** The newest turn in the history. */
  lastTurn: number;
  /** Observed turns since first seen, oldest first. */
  turns: ObservedTurn[];
  /** Base income on the newest board (visible territories). */
  base: number;
  /** Bonuses it visibly holds in full on the newest board. */
  bonusIncome: number;
  /** base + bonusIncome: what it visibly earns. */
  visibleIncome: number;
  /** Median of the last {@link MEDIAN_TURNS} observed deploys, at least `visibleIncome`; `null` before any observed turn. */
  income: number | null;
  /** The `from` turns the median used. */
  incomeTurns: number[];
  /** Armies that must be in the fog (≥ 0); `null` before any observed turn. */
  unaccounted: number | null;
  /** Bonuses that could explain `income − visibleIncome`; `null` when there is no gap. */
  inferred: InferredBonuses | null;
  /** Confidence notes, plain sentences. */
  notes: string[];
}

const byNum = (a: number, b: number) => a - b;

function median(xs: number[]): number {
  const s = [...xs].sort(byNum);
  const m = Math.floor(s.length / 2);
  // An even count takes the mean of the middle two, rounded up (threats err high).
  return s.length % 2 ? s[m]! : Math.ceil((s[m - 1]! + s[m]!) / 2);
}

/** Its army change over territories visible on both boards, and what it visibly lost. */
function armyChange(g: MapGraph, before: BoardState, after: BoardState, playerId: number, defensive: number) {
  const was = new Map(before.territories.map((t) => [t.territoryId, t]));
  const ids = [...new Set(after.territories.map((t) => t.territoryId))].sort(byNum);
  let net = 0;
  let losses = 0;
  const now = new Map(after.territories.map((t) => [t.territoryId, t]));
  for (const id of ids) {
    if (!g.territoryById.has(id)) continue;
    const a = visibleState(now.get(id));
    const b = visibleState(was.get(id));
    if (!a || !b) continue;
    const mineNow = a.owner.kind === 'player' && a.owner.playerId === playerId;
    const mineThen = b.owner.kind === 'player' && b.owner.playerId === playerId;
    if (mineNow && mineThen) net += a.armies! - b.armies!;
    else if (mineNow) {
      // The stack now standing there came into view (from a visible source or the fog): it
      // counts in `net`; the capture cost what the defenders killed, as in observeDeploy (#86).
      net += a.armies!;
      losses += straightKills(b.armies!, defensive);
    } else if (mineThen) {
      net -= b.armies!;
      losses += b.armies!; // destroyed defending
    }
  }
  return { net, losses };
}

function seesPlayer(board: BoardState, g: MapGraph, playerId: number): boolean {
  return board.territories.some(
    (t) => g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.owner.playerId === playerId && ownerShown(t),
  );
}

/** Bonuses `playerId` could hold but does not visibly hold in full, on `board`. */
function possibleBonuses(g: MapGraph, board: BoardState, playerId: number): { id: number; value: number }[] {
  const seen = new Map(board.territories.map((t) => [t.territoryId, t]));
  const out: { id: number; value: number }[] = [];
  for (const b of [...g.map.bonuses].sort((x, y) => x.id - y.id)) {
    const ts = bonusTerritories(g, b.id);
    if (b.value <= 0 || !ts.length) continue;
    let held = 0;
    let taken = false;
    for (const t of ts) {
      const st = ownerShown(seen.get(t));
      if (!st) continue;
      if (st.owner.kind === 'player' && st.owner.playerId === playerId) held++;
      else taken = true;
    }
    if (!taken && held < ts.length) out.push({ id: b.id, value: b.value });
  }
  return out;
}

/**
 * The combinations of up to {@link MAX_COMBINATION} bonuses whose total comes closest to `gap`
 * (within max(1, a quarter of the gap)), fewest bonuses first, then by ids.
 */
function inferBonuses(options: { id: number; value: number }[], gap: number): InferredBonuses {
  const tolerance = Math.max(1, Math.round(gap / 4));
  const sorted = [...options].sort((a, b) => a.value - b.value || a.id - b.id);
  let best = Infinity;
  let found: BonusCombination[] = [];
  const pick: { id: number; value: number }[] = [];
  const visit = (start: number, sum: number) => {
    if (pick.length) {
      const diff = Math.abs(sum - gap);
      if (diff <= tolerance && diff <= best) {
        if (diff < best) {
          best = diff;
          found = [];
        }
        found.push({ bonusIds: pick.map((p) => p.id).sort(byNum), total: sum });
      }
    }
    if (pick.length === MAX_COMBINATION) return;
    for (let i = start; i < sorted.length; i++) {
      const b = sorted[i]!;
      // Values only grow from here: past the gap plus the tolerance nothing fits.
      if (sum + b.value > gap + tolerance) break;
      pick.push(b);
      visit(i + 1, sum + b.value);
      pick.pop();
    }
  };
  visit(0, 0);
  found.sort((a, b) => {
    if (a.bonusIds.length !== b.bonusIds.length) return a.bonusIds.length - b.bonusIds.length;
    for (let i = 0; i < a.bonusIds.length; i++) if (a.bonusIds[i] !== b.bonusIds[i]) return a.bonusIds[i]! - b.bonusIds[i]!;
    return 0;
  });
  return {
    gap,
    exact: best === 0,
    candidates: found.slice(0, MAX_LISTED_COMBINATIONS),
    more: Math.max(0, found.length - MAX_LISTED_COMBINATIONS),
  };
}

/**
 * Per opponent (visible on the newest board, sorted by id): its observed deploys turn by turn,
 * an income estimate, the armies that must be in the fog and the bonuses that could explain an
 * income gap. `boards` are my views of the same game, any order; only consecutive turns are
 * compared. See the module comment for the rules.
 */
export function trackOpponents(
  g: MapGraph,
  boards: readonly TurnBoard[],
  me: number,
  settings: PlannerSettings = {},
): OpponentTrack[] {
  // One board per turn (the last given wins), oldest first.
  const byTurn = new Map<number, BoardState>();
  for (const b of boards) byTurn.set(b.turn, b.board);
  const turns = [...byTurn.keys()].sort(byNum);
  if (!turns.length) return [];
  const lastTurn = turns.at(-1)!;
  const latest = byTurn.get(lastTurn)!;
  const visibleOn = new Map<number, Map<number, { playerId: number; base: number; bonusIncome: number }>>();
  const visibleAt = (turn: number) => {
    let m = visibleOn.get(turn);
    if (!m) {
      m = new Map(enemyDeployEstimates(g, byTurn.get(turn)!, me, settings).map((e) => [e.playerId, e]));
      visibleOn.set(turn, m);
    }
    return m;
  };
  return [...visibleAt(lastTurn).values()].map(({ playerId }) => {
    const firstSeen = turns.find((t) => seesPlayer(byTurn.get(t)!, g, playerId)) ?? lastTurn;
    const observed: ObservedTurn[] = [];
    const missing: number[] = [];
    const unseen: number[] = [];
    for (let i = 1; i < turns.length; i++) {
      const from = turns[i - 1]!;
      const to = turns[i]!;
      if (from < firstSeen) continue;
      for (let m = from + 1; m < to; m++) missing.push(m);
      if (to !== from + 1) continue;
      const before = byTurn.get(from)!;
      const after = byTurn.get(to)!;
      // A turn pair where the opponent has no territory in view on either board says nothing
      // about its deploy (every stack would read as a reveal, or there is no estimate at all):
      // skip it with a note rather than observe 0 or throw (#83).
      const e = seesPlayer(before, g, playerId)
        ? enemyDeployEstimates(g, after, me, settings, before).find((x) => x.playerId === playerId)
        : undefined;
      if (!e?.observation) {
        unseen.push(seesPlayer(before, g, playerId) ? to : from);
        continue;
      }
      const o = e.observation;
      const v = visibleAt(from).get(playerId);
      const visibleIncome = v ? v.base + v.bonusIncome : 0;
      const { net, losses } = armyChange(
        g,
        before,
        after,
        playerId,
        settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
      );
      observed.push({
        from,
        to,
        observed: e.observed!,
        raw: e.observedRaw!,
        cap: e.observedCap!,
        counted: o.counted,
        captured: o.captured,
        fromFog: o.fromFog,
        reveals: o.reveals,
        visibleIncome,
        earned: Math.max(visibleIncome, e.observed!),
        net,
        losses,
      });
    }
    const v = visibleAt(lastTurn).get(playerId)!;
    const visibleIncome = v.base + v.bonusIncome;
    const recent = observed.slice(-MEDIAN_TURNS);
    const income = recent.length ? Math.max(visibleIncome, median(recent.map((x) => x.observed))) : null;
    const unaccounted = observed.length
      ? Math.max(0, observed.reduce((s, x) => s + x.earned - x.net - x.losses, 0))
      : null;
    const gap = income !== null ? income - visibleIncome : 0;
    const inferred = gap > 0 ? inferBonuses(possibleBonuses(g, latest, playerId), gap) : null;

    const notes: string[] = [];
    if (observed.length < 2)
      notes.push(
        `Only ${observed.length} observed turn${observed.length === 1 ? '' : 's'} (fewer than 2 observed turns): the planner keeps its single-turn estimate.`,
      );
    else
      notes.push(
        `Income is the median of ${recent.length} observed turn${recent.length === 1 ? '' : 's'} (turn${recent.length === 1 ? '' : 's'} ${recent.map((x) => x.from).join(', ')}), at least its visible income ${visibleIncome}.`,
      );
    if (missing.length)
      notes.push(`No board for turn ${missing.join(', ')}: only consecutive turns are compared, so those turns are not observed.`);
    if (unseen.length) {
      const ts = [...new Set(unseen)].sort(byNum);
      notes.push(
        `No territory of it in view on turn ${ts.join(', ')}: the turn pairs around ${ts.length === 1 ? 'it are' : 'them are'} not observed.`,
      );
    }
    const capped = observed.filter((x) => x.raw > x.cap);
    if (capped.length)
      notes.push(
        `Capped at what it could earn on turn ${capped.map((x) => `${x.from} (+${x.raw} → ${x.cap})`).join(', ')}: armies from the fog or a Reinforcement card may explain the rest.`,
      );
    const reveals = observed.reduce((s, x) => s + x.reveals.length, 0);
    if (reveals) notes.push(`${reveals} fog reveal${reveals === 1 ? '' : 's'} skipped: stacks that only came into view are not income.`);
    const fogCaptures = observed.filter((x) => x.fromFog.length);
    if (fogCaptures.length) {
      const n = fogCaptures.reduce((s, x) => s + x.fromFog.length, 0);
      notes.push(
        `${n} capture${n === 1 ? '' : 's'} out of the fog on turn ${fogCaptures.map((x) => x.from).join(', ')}: only what ${n === 1 ? 'it' : 'they'} cost counts as deploy; the stack moved in from the fog.`,
      );
    }
    if (observed.length)
      notes.push(
        'Observed deploys are lower bounds: armies moved into the fog and losses in failed attacks are unseen, and the fog may hide territories and bonuses.',
      );
    if (inferred) {
      const n = inferred.candidates.length + inferred.more;
      if (!n) notes.push(`No combination of bonuses it could hold explains its income gap of ${gap}.`);
      else
        notes.push(
          `${n} combination${n === 1 ? '' : 's'} fit${n === 1 ? 's' : ''} its income gap of ${gap}${inferred.exact ? '' : ' approximately'}: candidates, not facts.`,
        );
    }
    return {
      playerId,
      firstSeen,
      lastTurn,
      turns: observed,
      base: v.base,
      bonusIncome: v.bonusIncome,
      visibleIncome,
      income,
      incomeTurns: recent.map((x) => x.from),
      unaccounted,
      inferred,
      notes,
    };
  });
}
