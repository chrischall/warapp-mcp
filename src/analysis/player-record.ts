// The cross-game record of how a player kept agreements (docs/PLAN-TEAMS.md A2, owner decision D5:
// on, local and hosted, keyed by a salted hash of the player's GameFeed id — see
// src/player-record-store.ts). Pure: one entry per agreement, name-free (no player id, no game id,
// no names, no message text: the entry's key is itself a salted hash), and the facts a later
// decision about that player can rest on (`playerRecord`, for part B3's pricing). Words never
// enter it: only what the player recorded with `warapp_record_agreement` and what the boards showed.
import { endCondition, TERMINAL_STATUSES, type Agreement, type WatchFlagKind } from './relations.js';

/** Entries kept per player (oldest updated dropped first). */
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
  /** Whether the side that gave notice let it run (ended) rather than breaking during it. */
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

/** `entries` with `entry` in place of the one with its key, capped at {@link MAX_RECORD_ENTRIES}. */
export function upsertEntry(entries: readonly RecordEntry[], entry: RecordEntry): RecordEntry[] {
  const rest = entries.filter((e) => e.key !== entry.key);
  return [...rest, entry].sort((a, b) => a.updated - b.updated || (a.key < b.key ? -1 : 1)).slice(-MAX_RECORD_ENTRIES);
}

/** The reliability facts of one player's entries: counts and a rate, never a judgement. */
export interface PlayerRecord {
  /** Entries on record. */
  entries: number;
  proposals: { byMe: number; byThem: number };
  /** Agreements that were agreed. */
  agreed: number;
  open: number;
  kept: number;
  endedWithNotice: number;
  /** Their notices let run, and broken during. */
  theirNotice: { honoured: number; broken: number };
  brokenByThem: number;
  brokenByMe: number;
  /** Of the breaks by them, those in the endgame. */
  brokenByThemInEndgame: number;
  /** After my breaks: how often they retaliated (of those recorded). */
  retaliated: number;
  /** Over agreements: how often they proposed again. */
  proposedAgain: number;
  /**
   * Of the agreed agreements that are over (not broken by me): the share they kept or ended with
   * notice honoured; `null` with none.
   */
  keptRate: number | null;
  /** The turns from agreement to their break, each (oldest entry first). */
  turnsToBreak: number[];
  /** The latest entry's outcome. */
  last: RecordOutcome | null;
}

export function playerRecord(entries: readonly RecordEntry[]): PlayerRecord {
  const sorted = [...entries].sort((a, b) => a.updated - b.updated || (a.key < b.key ? -1 : 1));
  const count = (f: (e: RecordEntry) => boolean) => sorted.filter(f).length;
  const closed = sorted.filter((e) => e.agreedTurn !== null && e.outcome !== 'open' && e.outcome !== 'broken-by-me' && e.outcome !== 'not-agreed');
  const good = closed.filter((e) => e.outcome === 'kept' || (e.outcome === 'ended-with-notice' && e.noticeHonoured !== false)).length;
  return {
    entries: sorted.length,
    proposals: { byMe: count((e) => e.proposedBy === 'me'), byThem: count((e) => e.proposedBy === 'them') },
    agreed: count((e) => e.agreedTurn !== null),
    open: count((e) => e.outcome === 'open'),
    kept: count((e) => e.outcome === 'kept'),
    endedWithNotice: count((e) => e.outcome === 'ended-with-notice'),
    theirNotice: {
      honoured: count((e) => e.noticeBy === 'them' && e.noticeHonoured === true),
      broken: count((e) => e.noticeBy === 'them' && e.noticeHonoured === false),
    },
    brokenByThem: count((e) => e.outcome === 'broken-by-them'),
    brokenByMe: count((e) => e.outcome === 'broken-by-me'),
    brokenByThemInEndgame: count((e) => e.outcome === 'broken-by-them' && e.context?.endgame === true),
    retaliated: count((e) => e.retaliated === true),
    proposedAgain: count((e) => e.proposedAgain === true),
    keptRate: closed.length ? Math.round((good / closed.length) * 100) / 100 : null,
    turnsToBreak: sorted
      .filter((e) => e.outcome === 'broken-by-them' && e.agreedTurn !== null && e.breakTurn !== undefined)
      .map((e) => e.breakTurn! - e.agreedTurn!),
    last: sorted.at(-1)?.outcome ?? null,
  };
}
