// The agreement ledger on disk (docs/PLAN-TEAMS.md A2): per game and account, at
// `<dataDir>/relations/<gameId>-<playerId>.json` (a second account in the same game has its own file),
// the agreements the player recorded with `warapp_record_agreement` — name-free (player, territory
// and bonus ids, turns, statuses; never a name or a message), 0600 in a 0700 directory, written
// atomically. It is the only file `warapp_record_agreement` writes besides the cross-game player
// record (src/player-record-store.ts); nothing is sent to war.app. Reads are loose: an unusable
// file or entry is dropped, never thrown on.
//
// `usage` is a stub for part B2: per planned turn, what each truce freed and what a break would
// cost. Nothing fills it yet (`recordTruceUsage` is there for the planner work to call).
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { withPathLock } from './path-lock.js';
import {
  AGREEMENT_STATUSES,
  MAX_NOTICE_TURNS,
  type Agreement,
  type AgreementScope,
  type AgreementStatus,
  type AgreementTerms,
} from './analysis/relations.js';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const ints = (v: unknown): number[] | undefined => (Array.isArray(v) && v.every(isInt) ? [...v] : undefined);

/** Agreements kept per game (the oldest over ones dropped first). */
export const MAX_AGREEMENTS = 50;
/** Planned turns of usage kept per game (the newest). */
export const MAX_USAGE_TURNS = 200;

/** Part B2's per-turn log for one truce: filled by the planner later; `null` until then. */
export interface TruceUsage {
  agreementId: string;
  /** Armies the truce freed from the covered border this turn. */
  armiesFreed: number | null;
  /** What the plan would lose if the partner broke the truce this turn. */
  lossIfBroken: number | null;
}

export interface RelationsLedger {
  gameId: number;
  /** My GameFeed id: the ledger is mine. */
  playerId: number;
  agreements: Agreement[];
  /** Per planned turn (as a string key), each truce's {@link TruceUsage}. */
  usage: Record<string, TruceUsage[]>;
}

export const relationsDir = (dir: string) => join(dir, 'relations');
export const relationsPath = (dir: string, gameId: number, playerId: number) => join(relationsDir(dir), `${gameId}-${playerId}.json`);

const AGREEMENT_ID = /^a(\d{1,9})$/;
/** An agreement id's number (`a7` is 7); ids are made by {@link nextAgreementId}. */
const idNumber = (id: string) => Number(AGREEMENT_ID.exec(id)?.[1] ?? 0);

function scopeOf(v: unknown): AgreementScope | undefined {
  if (v === 'all') return 'all';
  if (!isRec(v)) return undefined;
  const t = ints(v.territories);
  if (t) return { territories: t };
  const b = ints(v.bonuses);
  return b ? { bonuses: b } : undefined;
}

const isStatus = (v: unknown): v is AgreementStatus => typeof v === 'string' && (AGREEMENT_STATUSES as readonly string[]).includes(v);

function termsOf(v: unknown): AgreementTerms | undefined {
  if (!isRec(v)) return undefined;
  const scope = scopeOf(v.scope);
  if (!scope || !isInt(v.noticeTurns) || v.noticeTurns < 0 || v.noticeTurns > MAX_NOTICE_TURNS) return undefined;
  const t: AgreementTerms = { scope, noticeTurns: v.noticeTurns };
  if (isInt(v.borderCap)) t.borderCap = v.borderCap;
  if (isInt(v.untilTurn)) t.untilTurn = v.untilTurn;
  if (isInt(v.untilPlayerOut)) t.untilPlayerOut = v.untilPlayerOut;
  if (isInt(v.against)) t.against = v.against;
  return t;
}

/** An agreement read back, or `undefined` when it is unusable. */
export function agreementOf(v: unknown): Agreement | undefined {
  if (!isRec(v) || typeof v.id !== 'string' || !AGREEMENT_ID.test(v.id) || !isInt(v.with) || v.kind !== 'truce' || !isStatus(v.status) || !isInt(v.createdTurn))
    return undefined;
  const terms = termsOf(v.terms);
  if (!terms || !Array.isArray(v.history)) return undefined;
  const history = v.history.filter((h): h is { turn: number; status: AgreementStatus } => isRec(h) && isInt(h.turn) && isStatus(h.status));
  const a: Agreement = { id: v.id, with: v.with, kind: 'truce', status: v.status, createdTurn: v.createdTurn, terms, history };
  if (isInt(v.agreedTurn)) a.agreedTurn = v.agreedTurn;
  if (isInt(v.noticeTurn)) a.noticeTurn = v.noticeTurn;
  if (isInt(v.endedTurn)) a.endedTurn = v.endedTurn;
  if (typeof v.enforced === 'boolean') a.enforced = v.enforced;
  if (typeof v.retaliated === 'boolean') a.retaliated = v.retaliated;
  return a;
}

function usageOf(v: unknown): Record<string, TruceUsage[]> {
  if (!isRec(v)) return {};
  const out: Record<string, TruceUsage[]> = {};
  for (const [k, list] of Object.entries(v)) {
    if (!/^\d+$/.test(k) || !Array.isArray(list)) continue;
    const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    out[k] = list
      .filter((u): u is Rec => isRec(u) && typeof u.agreementId === 'string')
      .map((u) => ({ agreementId: u.agreementId as string, armiesFreed: num(u.armiesFreed), lossIfBroken: num(u.lossIfBroken) }));
  }
  return out;
}

/** An empty ledger for `gameId` as `playerId`. */
export const emptyLedger = (gameId: number, playerId: number): RelationsLedger => ({ gameId, playerId, agreements: [], usage: {} });

/**
 * The ledger of `gameId` as `playerId` recorded it; `undefined` when there is none, it is another
 * account's, or it is unusable. Never throws.
 */
export async function readLedger(dir: string, gameId: number, playerId: number): Promise<RelationsLedger | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(relationsPath(dir, gameId, playerId), 'utf8'));
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId || !Array.isArray(c.agreements)) return undefined;
    const agreements = c.agreements.map(agreementOf).filter((a): a is Agreement => a !== undefined);
    return { gameId, playerId, agreements, usage: usageOf(c.usage) };
  } catch {
    return undefined;
  }
}

/**
 * The ledger for a write: `null` when there is no file yet, `'unreadable'` when a file exists but
 * cannot be read as this game's and account's ledger (bad JSON, another shape, a read error), so a
 * caller never replaces recorded agreements with an empty ledger.
 */
export async function readLedgerForWrite(
  dir: string,
  gameId: number,
  playerId: number,
): Promise<RelationsLedger | null | 'unreadable'> {
  let text: string;
  try {
    text = await readFile(relationsPath(dir, gameId, playerId), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const c: unknown = JSON.parse(text);
    if (!isRec(c) || c.gameId !== gameId || c.playerId !== playerId || !Array.isArray(c.agreements)) return 'unreadable';
    const agreements = c.agreements.map(agreementOf).filter((a): a is Agreement => a !== undefined);
    return { gameId, playerId, agreements, usage: usageOf(c.usage) };
  } catch {
    return 'unreadable';
  }
}

/**
 * The ledger with its agreements in id order, at most {@link MAX_AGREEMENTS} of them (over ones
 * dropped oldest first), and at most {@link MAX_USAGE_TURNS} usage turns.
 */
export function boundLedger(ledger: RelationsLedger): RelationsLedger {
  let agreements = [...ledger.agreements].sort((a, b) => idNumber(a.id) - idNumber(b.id) || (a.id < b.id ? -1 : 1));
  if (agreements.length > MAX_AGREEMENTS) {
    const over = agreements.filter((a) => a.endedTurn !== undefined).sort((a, b) => a.endedTurn! - b.endedTurn! || (a.id < b.id ? -1 : 1));
    const drop = new Set(over.slice(0, agreements.length - MAX_AGREEMENTS).map((a) => a.id));
    agreements = agreements.filter((a) => !drop.has(a.id)).slice(-MAX_AGREEMENTS);
  }
  const turns = Object.keys(ledger.usage)
    .map(Number)
    .sort((a, b) => b - a)
    .slice(0, MAX_USAGE_TURNS)
    .sort((a, b) => a - b);
  return { ...ledger, agreements, usage: Object.fromEntries(turns.map((t) => [String(t), ledger.usage[String(t)]!])) };
}

/** Write the ledger (bounded), atomically, 0600. `true` when written; never throws. */
export async function writeLedger(dir: string, ledger: RelationsLedger): Promise<boolean> {
  try {
    const path = relationsPath(dir, ledger.gameId, ledger.playerId);
    await mkdir(relationsDir(dir), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(tmp, JSON.stringify(boundLedger(ledger)), { mode: 0o600 });
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** The next agreement id in `ledger`: `a1`, `a2`, … */
export function nextAgreementId(ledger: RelationsLedger): string {
  const n = ledger.agreements.reduce((m, a) => Math.max(m, idNumber(a.id)), 0);
  return `a${n + 1}`;
}

/**
 * Part B2's stub: record what each truce freed and would cost on `turn`. Writes only when a ledger
 * exists for the game. `true` when written; never throws.
 */
export async function recordTruceUsage(dir: string, gameId: number, playerId: number, turn: number, usage: readonly TruceUsage[]): Promise<boolean> {
  return withLedgerLock(dir, gameId, playerId, async () => {
    const ledger = await readLedger(dir, gameId, playerId);
    if (!ledger) return false;
    return writeLedger(dir, { ...ledger, usage: { ...ledger.usage, [String(turn)]: [...usage] } });
  });
}

/**
 * Run a read-modify-write of one ledger under the in-process lock for its file (src/path-lock.ts),
 * so two calls in this process never lose each other's change. Not re-entrant: never nest it on
 * the same ledger.
 */
export const withLedgerLock = <T>(dir: string, gameId: number, playerId: number, fn: () => Promise<T>): Promise<T> =>
  withPathLock(relationsPath(dir, gameId, playerId), fn);
