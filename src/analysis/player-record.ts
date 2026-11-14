// The cross-game record of how a player kept agreements (docs/PLAN-TEAMS.md A2, owner decision D5 of
// 2026-11-14: ON, local and hosted — a hosted child keeps it in its per-user data dir — keyed by a
// salted hash of the player's GameFeed id; see src/player-record-store.ts). Pure.
//
// Per player it keeps two things:
// - one entry per agreement, name-free (no player id, no game id, no name, no message: the entry's
//   key is itself a salted hash): the game's format, the turns agreed and ended, the shape of the
//   terms, the outcome (kept, ended with notice and whether it was honoured, broken by them or by
//   me), the break turn and the strongest breach flag my boards showed, the context at the break
//   (endgame, who led, outgrowing), whether they retaliated and whether they proposed again;
// - tallies (`RecordCounts`), each moved once by the recorded transition that earns it
//   (`recordDelta`), so recording the same agreement again never counts it twice, and an entry
//   dropped past the bound still counts.
// Words never enter it: only what the player recorded with `warapp_record_agreement` and what the
// boards showed.
import { endCondition, TERMINAL_STATUSES, type Agreement, type WatchFlagKind } from './relations.js';

/** Entries kept per player (the least recently updated dropped first). */
export const MAX_RECORD_ENTRIES = 30;
/** Players kept (the least recently updated dropped first). */
export const MAX_RECORD_PLAYERS = 300;

export type RecordOutcome = 'open' | 'not-agreed' | 'kept' | 'ended-with-notice' | 'broken-by-them' | 'broken-by-me';

/** Who was leading when it broke: by estimated income. */
export type RecordLeader = 'me' | 'partner' | 'other' | 'unknown';

/** The board context at a break, as far as my boards showed it. */
export interface BreakContext {
  /** No other opponent was still a match for either of us (`truceEndgame`); `null`: unknown. */
  endgame: boolean | null;
  leader: RecordLeader;
  /** The partner's income had passed the outgrowing ratio × mine; `null`: unknown. */
  outgrowing: boolean | null;
}

export interface RecordEntry {
  /** A salted hash of the game and the agreement: the entry's identity, unlinkable to either. */
  key: string;
  format: {
    /** Players seated when it was recorded. */
    players: number;
    /** A team game. */
    teams: boolean;
    /** Players still playing in a free-for-all when it was first recorded; `null` in a team game. */
    ffaSize: number | null;
  };
  /** Who proposed it: `null` when it was first recorded as already agreed. */
  proposedBy: 'me' | 'them' | null;
  agreedTurn: number | null;
  endedTurn: number | null;
  terms: {
    scope: 'all' | 'territories' | 'bonuses';
    /** Territories or bonuses named; `null` for `all`. */
    scopeSize: number | null;
    noticeTurns: number;
    cap: number | null;
    endCondition: 'none' | 'turn' | 'player-out' | 'turn-or-player-out';
    /** It named a player it was aimed at. */
    against: boolean;
  };
  outcome: RecordOutcome;
  /** Who gave notice, when someone did. */
  noticeBy?: 'me' | 'them';
  /** Whether the notice was honoured (let run) rather than broken during by the side that gave it. */
  noticeHonoured?: boolean;
  /** A break: its turn, and the strongest breach flag my boards showed then (`null`: none). */
  breakTurn?: number;
  breachFlag?: WatchFlagKind | null;
  context?: BreakContext;
  /** After I broke it: whether they retaliated, when recorded. */
  retaliated?: boolean;
  /** They proposed a new agreement in the same game after this one was over. */
  proposedAgain?: boolean;
  /** When the entry was last written (ms since the epoch). */
  updated: number;
}

/** What the agreement's outcome is so far, from its status history. */
export function outcomeOf(a: Agreement): Pick<RecordEntry, 'outcome' | 'noticeBy' | 'noticeHonoured'> {
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

/** The entry for `a` (name-free), merged over `previous` when it exists. */
export function recordEntryFor(
  a: Agreement,
  input: {
    key: string;
    format: RecordEntry['format'];
    now: number;
    breachFlag?: WatchFlagKind | null;
    context?: BreakContext;
  },
  previous?: RecordEntry,
): RecordEntry {
  const first = a.history[0]?.status;
  const scope = a.terms.scope;
  const entry: RecordEntry = {
    key: input.key,
    format: previous?.format ?? input.format,
    proposedBy: first === 'proposed-by-me' ? 'me' : first === 'proposed-by-them' ? 'them' : null,
    agreedTurn: a.agreedTurn ?? null,
    endedTurn: a.endedTurn ?? null,
    terms: {
      scope: scope === 'all' ? 'all' : 'territories' in scope ? 'territories' : 'bonuses',
      scopeSize: scope === 'all' ? null : 'territories' in scope ? scope.territories.length : scope.bonuses.length,
      noticeTurns: a.terms.noticeTurns,
      cap: a.terms.borderCap ?? null,
      endCondition: endCondition(a.terms),
      against: a.terms.against !== undefined,
    },
    ...outcomeOf(a),
    ...(previous?.proposedAgain ? { proposedAgain: true } : {}),
    ...(a.retaliated !== undefined ? { retaliated: a.retaliated } : {}),
    updated: input.now,
  };
  if (a.status === 'broken-by-them' || a.status === 'broken-by-me') {
    entry.breakTurn = a.endedTurn ?? previous?.breakTurn ?? 0;
    entry.breachFlag = input.breachFlag !== undefined ? input.breachFlag : (previous?.breachFlag ?? null);
    const context = input.context ?? previous?.context;
    if (context) entry.context = context;
  }
  return entry;
}

const byUpdated = (a: RecordEntry, b: RecordEntry) => a.updated - b.updated || (a.key < b.key ? -1 : 1);

/** `entries` with `entry` in place of the one with its key, capped at {@link MAX_RECORD_ENTRIES}. */
export function upsertEntry(entries: readonly RecordEntry[], entry: RecordEntry): RecordEntry[] {
  const rest = entries.filter((e) => e.key !== entry.key);
  return [...rest, entry].sort(byUpdated).slice(-MAX_RECORD_ENTRIES);
}

/** One player's tallies. */
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
 * What one recorded change adds to the partner's tallies: `made` the first time it is agreed, and its
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

/** Tallies rebuilt from entries alone (a file written before tallies were kept). */
export function talliesOf(entries: readonly RecordEntry[]): RecordCounts {
  const out: RecordCounts = { ...ZERO_COUNTS };
  for (const e of entries) {
    if (e.agreedTurn !== null) out.made++;
    const key = OUTCOME_COUNT[e.outcome];
    if (key) out[key]++;
  }
  return out;
}

/** The reliability facts of one player: tallies, a rate and what the entries show, never a judgement. */
export interface PlayerRecord extends RecordCounts {
  /** Of the agreements over and not broken by me: the share kept or ended with notice; `null` with none. */
  keptRate: number | null;
  /** Entries on record (at most {@link MAX_RECORD_ENTRIES}; the tallies outlive dropped ones). */
  entries: number;
  /** The rest is over the entries on record. */
  proposals: { byMe: number; byThem: number };
  open: number;
  /** Their notices let run, and broken during. */
  theirNotice: { honoured: number; broken: number };
  /** Of their breaks, those in the endgame. */
  brokenByThemInEndgame: number;
  /** Of their breaks, those while they led. */
  brokenByThemLeading: number;
  /** After my breaks: how often they retaliated (of those recorded). */
  retaliated: number;
  /** How often they proposed again after an agreement was over. */
  proposedAgain: number;
  /** The turns from agreement to their break, each (oldest entry first). */
  turnsToBreak: number[];
  /** The latest entry's outcome. */
  last: RecordOutcome | null;
}

export function playerRecord(tallies: RecordCounts, entries: readonly RecordEntry[] = []): PlayerRecord {
  const sorted = [...entries].sort(byUpdated);
  const count = (f: (e: RecordEntry) => boolean) => sorted.filter(f).length;
  const over = tallies.kept + tallies.endedWithNotice + tallies.brokenByThem;
  const theirBreak = (e: RecordEntry) => e.outcome === 'broken-by-them';
  return {
    ...tallies,
    keptRate: over ? Math.round(((tallies.kept + tallies.endedWithNotice) / over) * 100) / 100 : null,
    entries: sorted.length,
    proposals: { byMe: count((e) => e.proposedBy === 'me'), byThem: count((e) => e.proposedBy === 'them') },
    open: count((e) => e.outcome === 'open'),
    theirNotice: {
      honoured: count((e) => e.noticeBy === 'them' && e.noticeHonoured === true),
      broken: count((e) => e.noticeBy === 'them' && e.noticeHonoured === false),
    },
    brokenByThemInEndgame: count((e) => theirBreak(e) && e.context?.endgame === true),
    brokenByThemLeading: count((e) => theirBreak(e) && e.context?.leader === 'partner'),
    retaliated: count((e) => e.retaliated === true),
    proposedAgain: count((e) => e.proposedAgain === true),
    turnsToBreak: sorted.filter((e) => theirBreak(e) && e.agreedTurn !== null && e.breakTurn !== undefined).map((e) => e.breakTurn! - e.agreedTurn!),
    last: sorted.at(-1)?.outcome ?? null,
  };
}
