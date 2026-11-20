// #298: stop funding a contested bonus piecemeal after repeated failures (owner defaults of 2026-11-20).
// A bonus is *attempted* on a turn when it is contested (positive, a missing member held by another player
// on that turn's board) and the plan expects to complete it that turn (`expected.bonusesCompleted`).
// The attempt *failed* when the bonus is not all mine on the next turn's board. After FAILED_ATTEMPTS (2)
// failed attempts on consecutive turns the bonus gets one all-in push — every missing member taken this
// turn, each player-held one sized for its defenders plus its owner's deploy (#368's middle figure,
// `reinforcementAt`), the whole at most ALL_IN_VALUE_TURNS (2) × its value and at most my income — when
// that push completes it; otherwise, and after an all-in that also fails, it is dropped as a target for
// DROP_TURNS (3) turns, this one included. The memory (src/bonus-attempt-store.ts) holds ids and numbers
// only. Pure; the planner reads the verdicts through `PlanInput.bonusAttempts`.
import type { BoardState } from '../../board.js';
import { bonusTerritories } from '../bonuses.js';
import type { MapGraph } from '../graph.js';

/** #298: failed attempts on consecutive turns that end piecemeal funding. */
export const FAILED_ATTEMPTS = 2;
/** #298: an all-in push costs at most this many turns of the bonus's value (and at most my income). */
export const ALL_IN_VALUE_TURNS = 2;
/** #298: turns a dropped bonus is not funded, the turn it is dropped on included. */
export const DROP_TURNS = 3;
/** #298: attempts older than this many turns are forgotten. */
export const ATTEMPT_MEMORY_TURNS = 6;

export interface BonusAttempt {
  turn: number;
  /** The plan pushed all-in on that turn. */
  allIn: boolean;
  /** Judged on the next turn's board: the bonus was not all mine. Absent: not judged (no plan that turn). */
  failed?: boolean;
}

export interface BonusAttemptRecord {
  bonusId: number;
  /** Oldest first. */
  attempts: BonusAttempt[];
  /** Dropped as a target on turns `from` to `until`, both included. */
  drop?: { from: number; until: number };
}

/** #298: per game and account, the bonuses I attempted (`PlanInput.bonusAttempts`). */
export interface BonusAttemptMemory {
  bonuses: BonusAttemptRecord[];
}

/** What the memory says of one bonus this turn. */
export type BonusVerdict =
  | { bonusId: number; kind: 'all-in'; failedTurns: number[] }
  | { bonusId: number; kind: 'dropped'; why: 'all-in-failed' | 'still-dropped'; from: number; until: number; failedTurns: number[] };

/** #298: what the plan did about a bonus the memory names (`TurnPlan.bonusPush`). */
export type BonusPushEntry =
  | { bonusId: number; kind: 'all-in'; failedTurns: number[]; cost: number; cap: number }
  | {
      bonusId: number;
      kind: 'dropped';
      /**
       * `no-all-in`: two failed attempts and no single push this turn completes it within the cap;
       * `all-in-failed`: last turn's all-in failed too; `still-dropped`: dropped on an earlier turn.
       */
      why: 'no-all-in' | 'all-in-failed' | 'still-dropped';
      from: number;
      until: number;
      failedTurns: number[];
      /** `no-all-in`: what stopped it (the push's armies over the cap, a member out of reach or out of view, or members left untaken). */
      detail?: string;
    };

/** The all-in sizing the planner tried for one bonus (captureTargets, plan/targets.ts). */
export interface AllInTry {
  feasible: boolean;
  cost: number;
  cap: number;
  detail?: string;
}

const complete = (g: MapGraph, board: BoardState, me: number, bonusId: number): boolean => {
  const ts = bonusTerritories(g, bonusId);
  const at = new Map(board.territories.map((t) => [t.territoryId, t]));
  return ts.length > 0 && ts.every((t) => {
    const o = at.get(t)?.owner;
    return o?.kind === 'player' && o.playerId === me;
  });
};

/**
 * The memory with the attempts made on `turn − 1` judged against `turn`'s board (`board`): failed when
 * the bonus is not all mine. Idempotent: planning a turn again judges them the same way.
 */
export function judgeAttempts(memory: BonusAttemptMemory, turn: number, g: MapGraph, board: BoardState, me: number): BonusAttemptMemory {
  return {
    bonuses: memory.bonuses.map((r) => ({
      ...r,
      attempts: r.attempts.map((a) => (a.turn === turn - 1 && a.failed === undefined ? { ...a, failed: !complete(g, board, me, r.bonusId) } : a)),
    })),
  };
}

/** The failed attempts that end on `turn − 1`, on consecutive turns, oldest first. */
function failedRun(r: BonusAttemptRecord, turn: number): BonusAttempt[] {
  const byTurn = new Map(r.attempts.map((a) => [a.turn, a]));
  const run: BonusAttempt[] = [];
  for (let t = turn - 1; byTurn.get(t)?.failed === true; t--) run.unshift(byTurn.get(t)!);
  return run;
}

/**
 * #298: each bonus the (judged) memory gives a verdict for on `turn`, by bonus id: still dropped (a drop
 * made on an earlier turn running to this one); dropped now (last turn's all-in failed); or all-in (the
 * last {@link FAILED_ATTEMPTS} turns' attempts failed, none of them all-in). A drop this turn's own
 * earlier plan made is ignored, so planning a turn again decides it again.
 */
export function bonusVerdicts(memory: BonusAttemptMemory | undefined, turn: number): BonusVerdict[] {
  const out: BonusVerdict[] = [];
  for (const r of [...(memory?.bonuses ?? [])].sort((a, b) => a.bonusId - b.bonusId)) {
    const run = failedRun(r, turn);
    const failedTurns = run.map((a) => a.turn);
    if (r.drop && r.drop.from < turn && r.drop.until >= turn) {
      out.push({ bonusId: r.bonusId, kind: 'dropped', why: 'still-dropped', from: r.drop.from, until: r.drop.until, failedTurns });
      continue;
    }
    const last = run[run.length - 1];
    if (last?.allIn) {
      out.push({ bonusId: r.bonusId, kind: 'dropped', why: 'all-in-failed', from: turn, until: turn + DROP_TURNS - 1, failedTurns });
      continue;
    }
    if (run.length >= FAILED_ATTEMPTS) out.push({ bonusId: r.bonusId, kind: 'all-in', failedTurns: failedTurns.slice(-FAILED_ATTEMPTS) });
  }
  return out;
}

/**
 * #298: the memory to keep after planning `turn` on `board` (the start of the turn): the attempts on
 * `turn - 1` judged; this turn's attempts (every contested bonus the plan expects to complete,
 * `completes`, the plan's `expected.bonusesCompleted`; all-in when `push` says so) in place of any an
 * earlier plan of this turn recorded; this turn's drops from `push`; nothing older than
 * {@link ATTEMPT_MEMORY_TURNS} turns. Only a completion is an attempt: a turn that only advances a bonus
 * leaves it incomplete by design, and a capture that also steps into a larger bonus is no try at it.
 */
export function rememberBonusAttempts(
  memory: BonusAttemptMemory | undefined,
  turn: number,
  g: MapGraph,
  board: BoardState,
  me: number,
  completes: readonly number[],
  push: readonly BonusPushEntry[] = [],
): BonusAttemptMemory {
  const judged = judgeAttempts(memory ?? { bonuses: [] }, turn, g, board, me);
  const at = new Map(board.territories.map((t) => [t.territoryId, t]));
  const records = new Map<number, BonusAttemptRecord>();
  for (const r of judged.bonuses) {
    const drop = r.drop && r.drop.from !== turn ? r.drop : undefined;
    records.set(r.bonusId, { bonusId: r.bonusId, attempts: r.attempts.filter((a) => a.turn !== turn), ...(drop ? { drop } : {}) });
  }
  const allIn = new Set(push.filter((p) => p.kind === 'all-in').map((p) => p.bonusId));
  for (const id of [...new Set(completes)].sort((a, b) => a - b)) {
    const b = g.bonusById.get(id);
    if (!b || b.value <= 0) continue;
    const contested = bonusTerritories(g, id).some((t) => {
      const o = at.get(t)?.owner;
      return o?.kind === 'player' && o.playerId !== me;
    });
    if (!contested) continue;
    const r = records.get(id) ?? { bonusId: id, attempts: [] };
    r.attempts = [...r.attempts, { turn, allIn: allIn.has(id) }].sort((x, y) => x.turn - y.turn);
    records.set(id, r);
  }
  for (const p of push)
    if (p.kind === 'dropped' && p.from === turn) {
      const r = records.get(p.bonusId) ?? { bonusId: p.bonusId, attempts: [] };
      r.drop = { from: p.from, until: p.until };
      records.set(p.bonusId, r);
    }
  const bonuses = [...records.values()]
    .map((r) => ({ ...r, attempts: r.attempts.filter((a) => a.turn > turn - ATTEMPT_MEMORY_TURNS) }))
    .filter((r) => r.attempts.length || (r.drop && r.drop.until >= turn))
    .sort((a, b) => a.bonusId - b.bonusId);
  return { bonuses };
}
