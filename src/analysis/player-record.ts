// The cross-game record of how a player kept agreements (docs/PLAN-TEAMS.md A2, D5's default: on,
// local only — never hosted — and counts only; see src/player-record-store.ts). Pure: per player,
// counts of agreements made, kept to their end, ended with notice, and broken (by them, by me), and
// nothing else — no per-agreement entry, no turn, no terms, no game, no name, no message. Each count
// moves once, on the recorded transition that earns it (`recordDelta`), so recording the same
// agreement again never counts it twice. Words never enter it: only what the player recorded with
// `warapp_record_agreement`.
import { TERMINAL_STATUSES, type Agreement } from './relations.js';

/** Players kept (the least recently updated dropped first). */
export const MAX_RECORD_PLAYERS = 300;

export type RecordOutcome = 'open' | 'not-agreed' | 'kept' | 'ended-with-notice' | 'broken-by-them' | 'broken-by-me';

/** What the agreement's outcome is so far, from its status history. */
export function outcomeOf(a: Agreement): { outcome: RecordOutcome; noticeBy?: 'me' | 'them'; noticeHonoured?: boolean } {
  const statuses = a.history.map((h) => h.status);
  // Notice counts only when it was still standing at the end (withdrawn notice goes back to `agreed`).
  const standing = a.status === 'ended' || a.status === 'broken-by-me' || a.status === 'broken-by-them' ? statuses.at(-2) : a.status;
  const noticeBy = standing === 'notice-by-me' ? 'me' : standing === 'notice-by-them' ? 'them' : undefined;
  if (!TERMINAL_STATUSES.has(a.status)) return { outcome: 'open', ...(noticeBy ? { noticeBy } : {}) };
  if (a.status === 'ended') {
    if (noticeBy) return { outcome: 'ended-with-notice', noticeBy, noticeHonoured: true };
    return { outcome: a.agreedTurn === undefined ? 'not-agreed' : 'kept' };
  }
  const outcome: RecordOutcome = a.status === 'broken-by-me' ? 'broken-by-me' : 'broken-by-them';
  if (!noticeBy) return { outcome };
  // Broken during notice: the breaker's notice was not honoured when it was theirs to keep.
  const breaker = a.status === 'broken-by-me' ? 'me' : 'them';
  return { outcome, noticeBy, noticeHonoured: noticeBy !== breaker };
}

/** One player's counts. */
export interface RecordCounts {
  /** Agreements that were agreed. */
  made: number;
  /** Agreed, then ended with no notice standing: kept to their end. */
  kept: number;
  /** Agreed, then ended after notice. */
  endedWithNotice: number;
  brokenByThem: number;
  brokenByMe: number;
}

export const ZERO_COUNTS: Readonly<RecordCounts> = Object.freeze({ made: 0, kept: 0, endedWithNotice: 0, brokenByThem: 0, brokenByMe: 0 });
export const COUNT_KEYS = Object.keys(ZERO_COUNTS) as (keyof RecordCounts)[];

const OUTCOME_COUNT: Partial<Record<RecordOutcome, keyof RecordCounts>> = {
  kept: 'kept',
  'ended-with-notice': 'endedWithNotice',
  'broken-by-them': 'brokenByThem',
  'broken-by-me': 'brokenByMe',
};

/**
 * What one recorded change adds to the partner's counts: `made` the first time it is agreed, and its
 * outcome when it becomes over. `before` is the agreement as it stood (`undefined` for a new one).
 */
export function recordDelta(before: Agreement | undefined, after: Agreement): RecordCounts {
  const delta: RecordCounts = { ...ZERO_COUNTS };
  if (before?.agreedTurn === undefined && after.agreedTurn !== undefined) delta.made = 1;
  const wasOver = before !== undefined && TERMINAL_STATUSES.has(before.status);
  if (!wasOver && TERMINAL_STATUSES.has(after.status)) {
    const key = OUTCOME_COUNT[outcomeOf(after).outcome];
    if (key) delta[key] = 1;
  }
  return delta;
}

export const isZero = (c: RecordCounts): boolean => COUNT_KEYS.every((k) => c[k] === 0);

export function addCounts(a: RecordCounts, b: RecordCounts): RecordCounts {
  const out: RecordCounts = { ...ZERO_COUNTS };
  for (const k of COUNT_KEYS) out[k] = a[k] + b[k];
  return out;
}

/** The reliability facts of one player: the counts and a rate, never a judgement. */
export interface PlayerRecord extends RecordCounts {
  /** Of the agreements over and not broken by me: the share kept or ended with notice; `null` with none. */
  keptRate: number | null;
}

export function playerRecord(c: RecordCounts): PlayerRecord {
  const over = c.kept + c.endedWithNotice + c.brokenByThem;
  return { ...c, keptRate: over ? Math.round(((c.kept + c.endedWithNotice) / over) * 100) / 100 : null };
}
