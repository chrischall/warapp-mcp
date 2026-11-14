// Who moved first, kept between turns (#127). Under a cyclic move order (`Cycle`, `NoLuckCycle`)
// the order reverses every turn (the client's own help text: "ABCD becomes DCBA the next turn"),
// so in a two-player game one turn whose first mover is known gives every other turn's. The
// first mover of a turn is learnt from `first_mover` given to warapp_plan_turn (the user saw it)
// or from the award of picks (src/analysis/award.ts: the wiki's rule, not verified live), and is
// kept at `<dataDir>/move-order/<gameId>.json` so later turns default to it, alternated.
//
// The game history is not read for it: war.app does not say who moves first under a plain cycle
// ("you must deduce it by observing the sequence that orders happen"), and whether GameFeed's
// `GetHistory` carries a game in progress's orders, in the order they ran, is UNVERIFIED
// (docs/WARAPP-API.md "Move order"). The first mover kept is the cycle's: an Order Priority or
// Order Delay card played on a turn changes who moves first on that turn only.
//
// One record per game: the newest turn known, with where it came from. A first mover given
// explicitly outranks one read from the award. Turn number and the two words only: no names.
// Best effort and never throws; a game's file not written for 60 days is deleted on the first
// write of a process.
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type FirstMover = 'me' | 'opponent';
/** Where a known first mover came from: `first_mover` given for that turn, or the award of picks. */
export type FirstMoverSource = 'explicit' | 'award';

interface FirstMoverSeen {
  /** The turn it is known for (the turn being played, as every tool reports `turn`). */
  turn: number;
  firstMover: FirstMover;
  source: FirstMoverSource;
}

export interface ResolvedFirstMover {
  firstMover: FirstMover;
  /** `remembered`: alternated from the turn kept in `from`. */
  source: FirstMoverSource | 'remembered';
  from?: { turn: number; source: FirstMoverSource };
}

/** Where a game's first mover is kept. */
export const firstMoverPath = (dir: string, gameId: number) => join(dir, 'move-order', `${gameId}.json`);

/** A game's file not written for this long is deleted (finished or abandoned games). */
export const FIRST_MOVER_MAX_AGE_MS = 60 * 86_400_000;
const FILE = /^\d+\.json$/;
const pruned = new Set<string>();

const other = (m: FirstMover): FirstMover => (m === 'me' ? 'opponent' : 'me');
const isTurn = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
const isMover = (v: unknown): v is FirstMover => v === 'me' || v === 'opponent';
const isSource = (v: unknown): v is FirstMoverSource => v === 'explicit' || v === 'award';

/** The first mover on `turn`, from one known turn: the same every second turn, the other in between. */
export function projectFirstMover(seen: { turn: number; firstMover: FirstMover }, turn: number): FirstMover {
  return Math.abs(turn - seen.turn) % 2 === 0 ? seen.firstMover : other(seen.firstMover);
}

const RANK: Record<FirstMoverSource, number> = { award: 0, explicit: 1 };
const said = (m: FirstMover, turn: number) => `${m === 'me' ? 'you move' : 'the opponent moves'} first on turn ${turn}`;

/**
 * Who moves first on `turn` and how it is known, with the record to keep (absent when nothing new
 * is known). An explicit first mover wins; then a remembered explicit turn, alternated; then the
 * award; then a remembered award turn. Outside a two-player cyclic order (or without a turn) only
 * an explicit first mover counts, for this turn alone, and nothing is kept. A source that
 * disagrees with the one used is a warning. Pure.
 */
export function resolveFirstMover(input: {
  turn: number | null;
  /** Two players under `Cycle` or `NoLuckCycle`. */
  cyclicDuel: boolean;
  explicit?: FirstMover;
  /** What the award of picks says for `turn` (`firstMoverOnTurn`); `null` when it says nothing. */
  award: FirstMover | null;
  remembered?: FirstMoverSeen;
}): { resolved: ResolvedFirstMover | null; record?: FirstMoverSeen; warnings: string[] } {
  const { turn, explicit, award } = input;
  if (turn === null || !input.cyclicDuel)
    return { resolved: explicit ? { firstMover: explicit, source: 'explicit' } : null, warnings: [] };

  type Candidate = { firstMover: FirstMover; label: string; resolved: ResolvedFirstMover; record?: FirstMoverSeen };
  const candidates: Candidate[] = [];
  const kept = input.remembered;
  const fromKept = (): Candidate | undefined =>
    kept && {
      firstMover: projectFirstMover(kept, turn),
      label: kept.source === 'explicit' ? `the first_mover given on turn ${kept.turn}` : `the award of picks (kept on turn ${kept.turn})`,
      resolved: { firstMover: projectFirstMover(kept, turn), source: 'remembered', from: { turn: kept.turn, source: kept.source } },
    };
  if (explicit)
    candidates.push({ firstMover: explicit, label: 'first_mover', resolved: { firstMover: explicit, source: 'explicit' }, record: { turn, firstMover: explicit, source: 'explicit' } });
  if (kept?.source === 'explicit') candidates.push(fromKept()!);
  if (award) candidates.push({ firstMover: award, label: 'the award of picks', resolved: { firstMover: award, source: 'award' }, record: { turn, firstMover: award, source: 'award' } });
  if (kept?.source === 'award') candidates.push(fromKept()!);

  const used = candidates[0];
  if (!used) return { resolved: null, warnings: [] };
  const warnings: string[] = [];
  const against = candidates.slice(1).filter((c) => c.firstMover !== used.firstMover);
  if (against.length)
    warnings.push(
      `Move order: the plan takes it that ${said(used.firstMover, turn)} (from ${used.label}), but ` +
        against.map((c) => `${c.label} says ${said(c.firstMover, turn)}`).join(', and ') +
        '. Give first_mover as the cycle has it, without an Order Priority or Order Delay card played this turn.',
    );
  // Keep what is newly known, unless a better-ranked turn is kept already.
  const record = used.record && (!kept || RANK[used.record.source] >= RANK[kept.source]) && !same(used.record, kept) ? used.record : undefined;
  return { resolved: used.resolved, ...(record ? { record } : {}), warnings };
}

/**
 * #215 review: a first mover the user gave (`first_mover`, now or on a remembered turn, alternated)
 * is verified; one read from the award of picks — the wiki's rule, not verified live — is not, and
 * the planner's hold sizing treats it as unknown (`movesFirstUnverified`).
 */
export function verifiedFirstMover(resolved: ResolvedFirstMover): boolean {
  return resolved.source === 'explicit' || (resolved.source === 'remembered' && resolved.from?.source === 'explicit');
}

const same = (a: FirstMoverSeen, b: FirstMoverSeen | undefined) =>
  b !== undefined && a.turn === b.turn && a.firstMover === b.firstMover && a.source === b.source;

/** The first mover kept for `gameId` when it is `playerId`'s; `undefined` when absent or unusable. Never throws. */
export async function readFirstMover(dir: string, gameId: number, playerId: number): Promise<FirstMoverSeen | undefined> {
  try {
    const c: unknown = JSON.parse(await readFile(firstMoverPath(dir, gameId), 'utf8'));
    if (typeof c !== 'object' || c === null || Array.isArray(c)) return undefined;
    const r = c as Record<string, unknown>;
    if (r.gameId !== gameId || r.playerId !== playerId) return undefined;
    if (!isTurn(r.turn) || !isMover(r.firstMover) || !isSource(r.source)) return undefined;
    return { turn: r.turn, firstMover: r.firstMover, source: r.source };
  } catch {
    return undefined;
  }
}

async function prune(dir: string): Promise<void> {
  const base = join(dir, 'move-order');
  if (pruned.has(base)) return;
  pruned.add(base);
  const cutoff = Date.now() - FIRST_MOVER_MAX_AGE_MS;
  try {
    for (const name of await readdir(base)) {
      if (!FILE.test(name)) continue;
      const file = join(base, name);
      try {
        if ((await stat(file)).mtimeMs < cutoff) await unlink(file);
      } catch {
        // Gone already, or unreadable: leave it.
      }
    }
  } catch {
    // No directory yet.
  }
}

/** Keep `seen` as `playerId`'s first mover for `gameId`, replacing what was kept. Never throws. */
export async function writeFirstMover(dir: string, gameId: number, playerId: number, seen: FirstMoverSeen): Promise<boolean> {
  if (!isTurn(seen.turn) || !isMover(seen.firstMover) || !isSource(seen.source)) return false;
  try {
    const path = firstMoverPath(dir, gameId);
    await mkdir(join(dir, 'move-order'), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ gameId, playerId, turn: seen.turn, firstMover: seen.firstMover, source: seen.source }), { mode: 0o600 });
    await rename(tmp, path);
    await prune(dir);
    return true;
  } catch {
    return false;
  }
}
