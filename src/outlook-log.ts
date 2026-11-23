// The outlook log (#178): per game, the strength ratio of every turn this server planned and the
// latest outlook, plus the final result once a game this server logs is seen finished and, when
// it was lost, how (#274: `loss`, read from the cached boards; a log may hold only that). Local
// only, at `<dataDir>/outlook/<gameId>.json`, and name-free (player ids and figures, no names):
// it is the data the outlook's thresholds are to be calibrated from (OUTLOOK_RATIO is borrowed).
// Best effort: never throws.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { HowLost } from './analysis/how-lost.js';
import { splitReading, type GameOutlook, type OutlookEvidence, type OutlookLean, type OutlookState } from './analysis/outlook.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Turns kept per game (a long game is still a small file). */
const OUTLOOK_LOG_TURNS = 500;

export const outlookLogPath = (dir: string, gameId: number) => join(dir, 'outlook', `${gameId}.json`);

export interface OutlookLogTurn {
  /** My strength. */
  mine: number;
  /** The strongest opponent's strength range (`high` `null`: unbounded). */
  low: number | null;
  high: number | null;
  ratio: { low: number; high: number | null };
  /** #454: winning, losing, even or stalemate only. */
  state: OutlookState;
  /** #454: the income lean beside an `even` state (additive); absent when the state already says it. */
  lean?: OutlookLean;
  /** #312: the state was read on the likely high (an estimate, not a bound). Absent otherwise, and on turns logged before #312. */
  estimated?: true;
  /**
   * #283: the armies and income behind the strengths (an opponent's in view only), and which side the
   * strongest was (its lowest player id; `team` in a team game). Absent on turns logged before #283.
   */
  figures?: {
    mine: { armies: number; income: number };
    strongest: { playerId: number; team?: number; armies: number; income: number } | null;
  };
  /**
   * #304: what the state rested on — the incomes compared, each opponent's income and the share of its
   * frontier read, and whether that was thin (ids and figures; the coverage's words are left out).
   * Absent on turns logged before #304.
   */
  evidence?: LoggedEvidence;
  /**
   * #436: my income against the strongest opponent's (its range and estimate), the lean, and whether the
   * estimate was calibrated. Absent on turns logged before #436.
   */
  income?: {
    mine: number;
    low: number;
    high: number;
    estimate: number;
    lean: string;
    calibrated: boolean;
    /** #522: the side the range is for (its lowest player id; `team` in a team game). Absent on turns logged before #522. */
    playerId?: number;
    team?: number;
  };
  /**
   * #522: in a large game, the strongest opponent side ANYWHERE by estimate, which the surrender line judges
   * against when it is not the outlook's own (nearby) side. Absent otherwise.
   */
  surrender?: { playerId: number; team?: number; low: number; estimate: number; calibrated: boolean };
}

/** #304: {@link OutlookEvidence} as logged: name-free, without the words. */
export interface LoggedEvidence {
  incomes: OutlookEvidence['incomes'];
  opponents: { playerId: number; income: number; source: 'tracked' | 'visible'; coverage: number | null; thin: boolean }[];
  thin: boolean;
}

const logged = (e: OutlookEvidence): LoggedEvidence => ({
  incomes: e.incomes ? { ...e.incomes, ...(e.incomes.players ? { players: [...e.incomes.players] } : {}) } : null,
  opponents: e.opponents.map(({ playerId, income, source, coverage, thin }) => ({ playerId, income, source, coverage, thin })),
  thin: e.thin,
});

/** The log as read back: the outlook log's turns and latest outlook, the result and the loss. */
export interface OutlookLog {
  gameId: number;
  playerId: number;
  turns: Record<string, OutlookLogTurn>;
  /** The outlook of the newest turn planned. */
  latest?: {
    turn: number;
    state: OutlookState | null;
    /** #454: the income lean beside an `even` state (additive); absent when the state already says it. */
    lean?: OutlookLean;
    heldTurns: number;
    basis: string;
    evidence?: LoggedEvidence;
    /** #436: the surrender line (advice only) on the newest turn, when under it. */
    surrenderLine?: { crossed: boolean; turnsBelow: number; line: number };
  };
  /** My GameFeed state once the game was seen finished (e.g. `Won`, `Eliminated`, `SurrenderAccepted`). */
  result?: string;
  /**
   * How the game was lost, read from the cached boards once it was seen finished (#274): ids and
   * figures only, so it outlives the board cache.
   */
  loss?: HowLost;
}

/** The log of `gameId` as `playerId` played it; `undefined` when absent, another player's, or unusable. */
export async function readOutlookLog(dir: string, gameId: number, playerId: number): Promise<OutlookLog | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(outlookLogPath(dir, gameId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId || !isRec(c.turns)) return undefined;
    return contractStates(c as unknown as OutlookLog);
  } catch {
    return undefined;
  }
}

/**
 * #454: a log written while #453 put the income lean in the state (`ahead`, `behind`, `unknown`) reads as
 * `even` with that lean, per turn and on the latest; every other entry is left as it is.
 */
function contractStates(log: OutlookLog): OutlookLog {
  const fix = <T extends { state: OutlookState | null; lean?: OutlookLean }>(e: T): T => {
    const { state, lean } = splitReading(e.state);
    return lean && e.lean === undefined ? { ...e, state, lean } : e;
  };
  for (const [k, t] of Object.entries(log.turns)) if (isRec(t)) log.turns[k] = fix(t);
  if (isRec(log.latest)) log.latest = fix(log.latest);
  return log;
}

async function write(dir: string, log: OutlookLog): Promise<void> {
  const path = outlookLogPath(dir, log.gameId);
  await mkdir(join(dir, 'outlook'), { recursive: true, mode: 0o700 });
  // Unique per write: two plans of one game in this process must not share (and race on) a temp file.
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(log), { mode: 0o600 });
  await rename(tmp, path);
}

/** Add the outlook's turns to the log and make it the latest. Best effort. */
export async function recordOutlook(dir: string, gameId: number, playerId: number, outlook: GameOutlook): Promise<void> {
  try {
    const log = (await readOutlookLog(dir, gameId, playerId)) ?? { gameId, playerId, turns: {} };
    for (const t of outlook.turns)
      log.turns[String(t.turn)] = {
        mine: t.mine,
        low: t.strongest?.low ?? null,
        high: t.strongest?.high ?? null,
        ratio: t.ratio,
        state: t.state,
        ...(t.lean ? { lean: t.lean } : {}),
        ...(t.estimated ? { estimated: true as const } : {}),
        ...(t.figures
          ? {
              figures: {
                mine: { ...t.figures.mine },
                strongest:
                  t.figures.strongest && t.strongest
                    ? {
                        playerId: t.strongest.playerId,
                        ...(t.strongest.team !== undefined ? { team: t.strongest.team } : {}),
                        ...t.figures.strongest,
                      }
                    : null,
              },
            }
          : {}),
        ...(t.evidence ? { evidence: logged(t.evidence) } : {}),
        ...(t.income
          ? {
              income: {
                mine: t.income.mine,
                low: t.income.theirs.low,
                high: t.income.theirs.high,
                estimate: t.income.theirs.estimate,
                lean: t.income.lean,
                calibrated: t.income.calibrated,
                playerId: t.income.theirs.playerId,
                ...(t.income.theirs.team !== undefined ? { team: t.income.theirs.team } : {}),
              },
            }
          : {}),
        ...(t.surrenderSide
          ? {
              surrender: {
                playerId: t.surrenderSide.playerId,
                ...(t.surrenderSide.team !== undefined ? { team: t.surrenderSide.team } : {}),
                low: t.surrenderSide.low,
                estimate: t.surrenderSide.estimate,
                calibrated: t.surrenderSide.calibrated,
              },
            }
          : {}),
      };
    const keep = Object.keys(log.turns)
      .map(Number)
      .sort((a, b) => b - a)
      .slice(0, OUTLOOK_LOG_TURNS);
    log.turns = Object.fromEntries(keep.sort((a, b) => a - b).map((k) => [String(k), log.turns[String(k)]!]));
    const last = outlook.turns.at(-1);
    if (last)
      log.latest = {
        turn: last.turn,
        state: outlook.state,
        ...(outlook.lean ? { lean: outlook.lean } : {}),
        heldTurns: outlook.heldTurns,
        basis: outlook.basis,
        ...(outlook.evidence ? { evidence: logged(outlook.evidence) } : {}),
        // #436: the surrender line as it stood (advice only), figures only.
        ...(outlook.surrenderLine
          ? { surrenderLine: { crossed: outlook.surrenderLine.crossed, turnsBelow: outlook.surrenderLine.turnsBelow, line: outlook.surrenderLine.line } }
          : {}),
      };
    await write(dir, log);
  } catch {
    // The log is optional.
  }
}

/**
 * #312: the final outlook line as the end-of-game record keeps it — the newest planned turn's state, how
 * long it held, its ratio, and whether it rested on an estimate or thin evidence. Name-free: no player id
 * and none of the basis's words. `undefined` when the log holds no latest outlook. Pure.
 */
export interface FinalOutlook {
  turn: number;
  state: OutlookState | null;
  /** #454: the income lean beside an `even` state (additive); absent when the state already says it. */
  lean?: OutlookLean;
  heldTurns: number;
  ratio?: { low: number; high: number | null };
  estimated?: true;
  thin?: true;
}

/** #454: a final outlook read back from a finished record: one written with the lean as the state reads as `even` with that lean. */
export function contractFinalOutlook(o: FinalOutlook): FinalOutlook {
  const { state, lean } = splitReading(o.state);
  return lean && o.lean === undefined ? { ...o, state, lean } : o;
}

export function finalOutlookOf(log: OutlookLog): FinalOutlook | undefined {
  const l = log.latest;
  if (!l || typeof l.turn !== 'number') return undefined;
  const t = log.turns[String(l.turn)];
  return {
    turn: l.turn,
    state: l.state ?? null,
    ...(l.lean ? { lean: l.lean } : {}),
    heldTurns: typeof l.heldTurns === 'number' ? l.heldTurns : 0,
    ...(t?.ratio ? { ratio: { low: t.ratio.low, high: t.ratio.high } } : {}),
    ...(t?.estimated ? { estimated: true as const } : {}),
    ...(l.evidence?.thin ? { thin: true as const } : {}),
  };
}

/** Record the final result of a game the log already holds; `true` when written. Best effort. */
export async function recordResult(dir: string, gameId: number, playerId: number, result: string): Promise<boolean> {
  try {
    const log = await readOutlookLog(dir, gameId, playerId);
    if (!log) return false;
    if (log.result === result) return true;
    await write(dir, { ...log, result });
    return true;
  } catch {
    return false;
  }
}

/** The player whose log `gameId` is; `undefined` when there is none. Never throws. */
export async function readOutlookPlayer(dir: string, gameId: number): Promise<number | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(outlookLogPath(dir, gameId), 'utf8'));
    return isRec(c) && c.gameId === gameId && typeof c.playerId === 'number' ? c.playerId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Keep how `gameId` was lost (#274) in its log, starting one when this server logged no outlook for
 * it (the boards were cached by another tool); `true` when written, `false` (nothing written) when the
 * log is another account's. Name-free: ids and figures. Best effort.
 */
export async function recordLoss(dir: string, gameId: number, playerId: number, loss: HowLost): Promise<boolean> {
  try {
    // Another account's log (its calibration turns) is never replaced.
    const owner = await readOutlookPlayer(dir, gameId);
    if (owner !== undefined && owner !== playerId) return false;
    const log = (await readOutlookLog(dir, gameId, playerId)) ?? { gameId, playerId, turns: {} };
    if (JSON.stringify(log.loss) === JSON.stringify(loss)) return true;
    await write(dir, { ...log, loss });
    return true;
  } catch {
    return false;
  }
}

/**
 * When `game` is finished and this server logs it, record the logged player's final GameFeed state
 * as the result; `true` when written. Best effort.
 */
export async function recordFinalResult(
  dir: string,
  game: { id: number; state: string; players: ReadonlyArray<{ id: number; state?: string }> },
): Promise<boolean> {
  if (game.state !== 'Finished') return false;
  try {
    const c: unknown = JSON.parse(await readFile(outlookLogPath(dir, game.id), 'utf8'));
    if (!isRec(c) || typeof c.playerId !== 'number') return false;
    const playerId = c.playerId;
    const state = game.players.find((p) => p.id === playerId)?.state;
    return state === undefined ? false : await recordResult(dir, game.id, playerId, state);
  } catch {
    return false;
  }
}
