// The colour a join sends. war.app refuses AcceptOpenSeat without one (verified
// live: server error 1, "color is null"), so warapp_join_game resolves it the way
// the web client does (verified from the client bundle, docs/WEB-PROTOCOL.md):
// the account's preferred colour, else its secondary colour — each only when no
// player in the lobby has it — else a standard colour still free.
//
// The account's colours come from the page itself: every war.app page that runs
// the client starts it with its startup parameters (`warlight.shared.InitParameters`)
// as one string of two characters per byte, and those carry the signed-in
// `warlight.shared.Player`. The Player record is read with the bundle's own reader;
// only its two GameColor fields are kept (the parameters also carry the session's
// auth string — never read out, never reported).

import type { ClassReader } from './live.js';
import { Reader } from './protocol/codec.js';
import { GAME_COLOR_COUNT } from './protocol/methods.js';

export const GAME_COLOR = 'warlight.shared.GameColor';
const PLAYER = 'warlight.shared.Player';
const INIT_PARAMETERS = 'warlight.shared.InitParameters';

/** Colours 0..23 are the standard ones (no unlock needed); the client offers these first. */
export const STANDARD_COLORS = 24;

/** Player field positions in read order (each checked for its type): the two GameColor fields. */
const PL = { secondary: 18, preferred: 32 } as const;
const PL_MIN_FIELDS = 33;

/** The startup string's alphabet: `>` (62) is 0, `M` (77) is 15. */
const BASE = 62;
const RUN_RE = /[>-M]{64,}/g;
/** How many candidate runs a page is searched for (longest first). */
const MAX_CANDIDATES = 8;

/**
 * The client's startup-string decoding: two characters per byte, each `code - 62`
 * a nibble; the first carries the byte's even bits (0, 2, 4, 6), the second its odd
 * bits (1, 3, 5, 7). `undefined` for an odd length or a character outside `>`..`M`.
 */
export function decodeStartupBytes(s: string): Uint8Array | undefined {
  if (s.length % 2 !== 0) return undefined;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) {
    const g = s.charCodeAt(2 * i) - BASE;
    const f = s.charCodeAt(2 * i + 1) - BASE;
    if (g < 0 || g > 15 || f < 0 || f > 15) return undefined;
    let b = 0;
    for (let bit = 0; bit < 4; bit++) {
      b |= ((g >> bit) & 1) << (2 * bit);
      b |= ((f >> bit) & 1) << (2 * bit + 1);
    }
    out[i] = b;
  }
  return out;
}

/** The inverse of {@link decodeStartupBytes} (for synthetic pages in tests). */
export function encodeStartupBytes(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) {
    let g = 0;
    let f = 0;
    for (let bit = 0; bit < 4; bit++) {
      g |= ((b >> (2 * bit)) & 1) << bit;
      f |= ((b >> (2 * bit + 1)) & 1) << bit;
    }
    s += String.fromCharCode(BASE + g, BASE + f);
  }
  return s;
}

/** The signed-in account's colours (GameColor indices); a colour not set is absent. */
export interface AccountColors {
  preferred?: number;
  secondary?: number;
}

type Obj = Record<string, unknown> & { $type?: unknown };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const META_KEYS = new Set(['$type', '$ctorError']);
const fields = (o: Obj): unknown[] =>
  Object.entries(o)
    .filter(([k]) => !META_KEYS.has(k))
    .map(([, v]) => v);

/** A GameColor record's index; `null` for an absent colour; `undefined` when it is neither. */
export function colorIndexOf(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || v.$type !== GAME_COLOR) return undefined;
  const [index] = fields(v);
  return typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < GAME_COLOR_COUNT
    ? index
    : undefined;
}

function colorsOfPlayer(p: Obj): AccountColors | undefined {
  const f = fields(p);
  if (f.length < PL_MIN_FIELDS) return undefined;
  const secondary = colorIndexOf(f[PL.secondary]);
  const preferred = colorIndexOf(f[PL.preferred]);
  if (secondary === undefined || preferred === undefined) return undefined;
  return { ...(preferred !== null ? { preferred } : {}), ...(secondary !== null ? { secondary } : {}) };
}

/** The account colours in one candidate startup string, or `undefined`. */
function colorsIn(run: string, bundle: ClassReader): AccountColors | undefined {
  const bytes = decodeStartupBytes(run);
  if (!bytes) return undefined;
  let params: unknown;
  try {
    params = bundle.readClass(INIT_PARAMETERS, new Reader(bytes));
  } catch {
    return undefined;
  }
  if (!isObj(params) || params.$type !== INIT_PARAMETERS) return undefined;
  const player = fields(params).find((v): v is Obj => isObj(v) && v.$type === PLAYER);
  return player ? colorsOfPlayer(player) : undefined;
}

/**
 * The signed-in account's preferred and secondary colours, from the client
 * startup parameters a war.app page carries; `undefined` when the page has none
 * that read (signed out, or the client changed). Never throws.
 */
export function readAccountColors(html: string, bundle: ClassReader): AccountColors | undefined {
  const runs = [...html.matchAll(RUN_RE)].map((m) => m[0]);
  runs.sort((a, b) => b.length - a.length);
  for (const run of runs.slice(0, MAX_CANDIDATES)) {
    // A run can pick up a neighbouring `>` (a tag's end): try it trimmed on either side.
    const tries = run.length % 2 === 0 ? [run] : [run.slice(1), run.slice(0, -1)];
    for (const t of tries) {
      const colors = colorsIn(t, bundle);
      if (colors) return colors;
    }
  }
  return undefined;
}

export type ColorSource = 'requested' | 'preferred' | 'secondary' | 'free';

export interface JoinColor {
  color: number;
  source: ColorSource;
}

/**
 * The colour to join with, as the web client picks it: the preferred colour when
 * no lobby player has it, else the secondary, else the first standard colour
 * (0..23) still free. `undefined` when every standard colour is taken.
 */
export function chooseJoinColor(account: AccountColors | undefined, taken: readonly number[]): JoinColor | undefined {
  const used = new Set(taken);
  if (account?.preferred !== undefined && !used.has(account.preferred)) {
    return { color: account.preferred, source: 'preferred' };
  }
  if (account?.secondary !== undefined && !used.has(account.secondary)) {
    return { color: account.secondary, source: 'secondary' };
  }
  for (let c = 0; c < STANDARD_COLORS; c++) if (!used.has(c)) return { color: c, source: 'free' };
  return undefined;
}
