// Coordination notes (report only): a joint attack agreed with a partner — who hits what, and which
// territories I follow on, on a turn or while open — kept per game in the agreement ledger
// (warapp_record_agreement `coordination`), listed by warapp_get_relations and told by
// warapp_plan_turn on its turn. Name-free (player and territory ids, turns, a note with names
// scrubbed). Never read into an order.

/** Coordination notes kept per game (the newest). */
export const MAX_COORDINATION = 50;
/** The longest note a coordination keeps. */
export const MAX_COORDINATION_NOTE = 200;

export interface Coordination {
  /** Unique within its game's ledger: `k1`, `k2`, … */
  id: string;
  /** The partner (GameFeed id). */
  with: number;
  /** The player attacked together (GameFeed id). */
  target: number;
  /** The territories I hit or follow on, ascending. */
  mine: number[];
  /** The territories the partner hits, ascending. */
  theirs: number[];
  /** The turn agreed for it (the turn's orders); absent: any turn while it is open. */
  turn?: number;
  /** The turn it was recorded. */
  recordedTurn: number;
  /** The turn it was closed (`coordination_done`); absent while open. */
  doneTurn?: number;
  /** The owner's own words, player names scrubbed to `Player <id>`; absent when none. */
  note?: string;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const ints = (v: unknown): number[] | undefined => (Array.isArray(v) && v.every(isInt) ? [...v] : undefined);
const ID = /^k(\d{1,9})$/;

/** A coordination read back, or `undefined` when it is unusable. */
export function coordinationOf(v: unknown): Coordination | undefined {
  if (!isRec(v) || typeof v.id !== 'string' || !ID.test(v.id) || !isInt(v.with) || !isInt(v.target) || !isInt(v.recordedTurn)) return undefined;
  const mine = ints(v.mine);
  const theirs = ints(v.theirs);
  if (!mine || !theirs) return undefined;
  const c: Coordination = { id: v.id, with: v.with, target: v.target, mine, theirs, recordedTurn: v.recordedTurn };
  if (isInt(v.turn)) c.turn = v.turn;
  if (isInt(v.doneTurn)) c.doneTurn = v.doneTurn;
  if (typeof v.note === 'string' && v.note.length) c.note = v.note.slice(0, MAX_COORDINATION_NOTE);
  return c;
}

/** The next coordination id in `list`: `k1`, `k2`, … */
export function nextCoordinationId(list: readonly Coordination[] | undefined): string {
  const n = (list ?? []).reduce((m, c) => Math.max(m, Number(ID.exec(c.id)?.[1] ?? 0)), 0);
  return `k${n + 1}`;
}

/** Whether `c` is still open and falls on `turn` (one with no turn falls on every turn while open). */
export const coordinationDue = (c: Coordination, turn: number): boolean => c.doneTurn === undefined && (c.turn === undefined || c.turn === turn);

/** The plan's line for `c`: who hits what and where I follow on. Report only. */
export function coordinationLine(c: Coordination, label: (t: number) => string): string {
  const list = (ts: readonly number[]) => ts.map(label).join(', ');
  const parts = [
    ...(c.theirs.length ? [`they hit ${list(c.theirs)}`] : []),
    ...(c.mine.length ? [`you follow on ${list(c.mine)}`] : []),
  ];
  return (
    `Agreed with player ${c.with} (coordination ${c.id}, against player ${c.target}${c.turn !== undefined ? `, turn ${c.turn}` : ''}): ` +
    `${parts.length ? parts.join(', ') : 'a joint attack'}. Report only: the orders are the plan's own; close it with coordination_done once it is over.`
  );
}
