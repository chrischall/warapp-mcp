// An evaluator for war.app's own generated reader functions.
//
// The client bundle (`ujs.js`, fetched from War.app's CDN at runtime — never vendored)
// contains, for every wire class, a reader `<Var>.Ha=function(a,b,d){…}` that reads the
// class's fields from a binary reader `a`. Rather than transcribe each layout (which
// changes between client releases), this module parses those functions with acorn and
// evaluates them against a codec `Reader`. Only the small JS subset the readers use is
// supported: primitive reads, present-flag ternaries, lists/dicts of nested classes via
// closures, version checks, `switch` on a type tag, `instanceof` by registered type name
// and constructors that assign `this.*`. Anything else raises an {@link InterpError}
// naming the function and the bundle offset of the construct.
//
// The primitive helpers (`P.Ya`, the dialect) are built in and shadow the bundle's own
// definitions; `verifyDialect` checks them against those definitions when a bundle loads.
//
// Classes are registered in the bundle as `W["warlight.shared.Foo"]=Xy;` — the type name
// is stable, the var is minified. Decoded objects carry the type name as `$type`.
//
// Containment. The bundle is downloaded at run time, so it is treated as hostile: interpreted
// code must not reach anything of the host process (which holds the user's credentials), even
// though a browser would have sandboxed it. The design keeps the objects the interpreter makes
// ordinary (decoded objects stay plain `{ $type, … }` for every consumer) and enforces the rules
// at the only places interpreted code touches host values:
// - a member read returns an own property, or `length` / an index of an array, a string or the
//   raw-bytes reader's Uint8Array (the only inherited members the readers use); any other inherited member reads as `undefined`, and the
//   keys `constructor`, `__proto__` and `prototype` raise. Interpreter internals (closures, the
//   reader, class refs) are not readable at all.
// - a write goes only to an array or a plain object the interpreter made, never with one of those
//   three keys, so it can only create or replace an own data property. An array takes only an index
//   at most its length (never `length`), so it stays dense; an object never takes one of
//   Object.prototype's member names (or `toJSON`), which would shadow the host method with a non-callable value.
// - no operator converts an object operand (that would run host code such as an array's join):
//   arithmetic, relational, bitwise and `++`/`--` refuse one (and a BigInt), and loose equality (`==`, `!=` and a
//   `switch` case) compares an object by identity, so `x == null` still works.
// - only string, number, boolean and null literals evaluate: a BigInt would make one step cost the
//   host work proportional to its size, and a RegExp is a host object.
// - a string built by `+` is capped at MAX_STRING characters and its length is charged to the step
//   budget, as is comparing two strings, so string work cannot outrun the budget or the heap.
// - statics and reader methods are looked up as own entries of the dialect tables only.
// - natives call back only into interpreter closures (`toNative` brands the functions it makes and
//   `callback` checks the brand), and no call or read hands a host function back to the bundle.
// - every `readClass` has one budget: a step count and a call depth (options with defaults), so
//   nested loops and recursion end in an InterpError; native element work (an array handed to a
//   native, a range's count) is charged to the same step count, and an allocating helper caps its count.
//   A reply decoded by several `readClass` calls (the open-games list, one call per record) passes one
//   `ReadBudget` to all of them, so the step count bounds the whole reply rather than each record.
// - converting a string operand to a number (arithmetic, relational, bitwise, unary minus, `++`/`--`,
//   and `==` against a number or boolean) costs the string's length: the host scans it to convert it.
// - host work that grows with something the bundle controls is charged too, or done once: a computed
//   member key costs its length, parsing a function costs the characters parsed, a constructor failure
//   kept as `$ctorError` costs CTOR_FAILURE_STEPS, and definitions are indexed in one pass over the
//   source, with failed lookups cached, so no lookup rescans the bundle. A thrown value's message is
//   built once per throw site, capped at MAX_THROW_MESSAGE and charged; a key longer than ten
//   characters is never an array index (no pattern test over a long key); a name lookup costs the
//   scopes it walks, and functions nest at most MAX_NESTING deep.
// - a wall-clock deadline backs the step count up: each `readClass` (or shared `ReadBudget`) has
//   `maxMillis` (default DEFAULT_MAX_MILLIS), checked every CLOCK_EVERY steps and raising the same
//   budget error. It can only end a read between steps, so it bounds uncounted work only because every
//   single host operation is itself size-bounded: a string is at most MAX_STRING characters when `+`
//   builds it, else a literal (bounded by the bundle, whose parsing is charged) or a wire string
//   (bounded by the frame); an array handed to a native is at most MAX_RANGE long, `E.Range` allocates at
//   most MAX_RANGE, a wire list's count is capped by the codec, and every other array grows by one
//   element per charged step (dense writes, `push` of the source's own arguments); a parse, the
//   definition index and the per-function AST walks (hoisting, `fieldsReadAs`, a throw's literals) are
//   bounded by the bundle's size and done once per function or per interpreter.

import {
  parseExpressionAt,
  type AnyNode,
  type Expression,
  type FunctionExpression,
  type Node as AcornNode,
  type Pattern,
  type Statement,
} from 'acorn';
import { PROTOCOL_VERSION, ProtocolError, Reader } from './codec.js';

export type InterpErrorKind =
  | 'unsupported'
  | 'no-definition'
  | 'unknown-class'
  | 'reader-threw'
  | 'loop-guard'
  | 'bad-value'
  | 'parse'
  /** The bundle tried to reach something outside the interpreter (an inherited member, a host function). */
  | 'forbidden'
  /** The step budget or the call-depth limit of one `readClass` was exceeded. */
  | 'budget';

/** A reader the interpreter cannot evaluate, or one that failed on the bytes. */
export class InterpError extends Error {
  constructor(
    readonly kind: InterpErrorKind,
    message: string,
    /** The bundle function being evaluated, e.g. `Xy.Ha`. */
    readonly where?: string,
    /** Character offset of the offending construct in the bundle source. */
    readonly offset?: number,
  ) {
    super(where === undefined ? message : `${message} in ${where}${offset === undefined ? '' : ` at bundle offset ${offset}`}`);
    this.name = 'InterpError';
  }
}

export interface ParsedBundle {
  src: string;
  /** Minified class var → registered type name. */
  typeNameOf: Map<string, string>;
  /** Registered type name → minified class var. */
  varOf: Map<string, string>;
}

/** Index the `W["<type name>"]=<var>;` registrations of a bundle. */
export function parseBundle(src: string): ParsedBundle {
  const typeNameOf = new Map<string, string>();
  const varOf = new Map<string, string>();
  for (const m of src.matchAll(/W\["([\w.$]+)"\]=([\w$]+);/g)) {
    if (!typeNameOf.has(m[2])) typeNameOf.set(m[2], m[1]);
    if (!varOf.has(m[1])) varOf.set(m[1], m[2]);
  }
  return { src, typeNameOf, varOf };
}

/** A decoded object: its fields plus the registered type name. */
export interface DecodedObject {
  $type: string;
  [field: string]: unknown;
}

type Native = (...args: unknown[]) => unknown;

/**
 * The minified names the readers call. These track the client release, so they are
 * data: a newer bundle that renames a primitive needs only a dialect override.
 */
export interface Dialect {
  /** Methods called directly on the reader (`a.Ua()`). */
  readerMethods: Record<string, (r: Reader, ...args: unknown[]) => unknown>;
  /** Native statics (`P.Ya(a)`), by class var then function name. Closures arrive as JS functions. */
  statics: Record<string, Record<string, Native>>;
  /** Nullable-value wrapper classes: `new Z(v)` is `v`, `new Z` is null. */
  wrappers: string[];
}

function readBytes(r: Reader): Uint8Array | null {
  const at = r.position;
  const n = r.int32();
  if (n === -1) return null;
  if (n < 0) throw new ProtocolError('bad-length', `negative byte-array length ${n} at offset ${at}`);
  return r.raw(n);
}

function strBody(r: Reader): string {
  const n = r.varint();
  return new TextDecoder('utf-8', { fatal: true }).decode(r.raw(n));
}

/** A helper's reader argument: the codec reader, else an InterpError (never a host TypeError). */
function asReader(x: unknown): Reader {
  if (!(x instanceof Reader)) throw new InterpError('bad-value', `expected the reader, got ${describe(x)}`);
  return x;
}

/** Functions `toNative` made from interpreter closures: the only callables a native may call. */
const CALLBACKS = new WeakSet<object>();

/** A native's callback argument, refused unless it is an interpreter closure made callable by `toNative`. */
function callback(f: unknown): Native {
  if (typeof f !== 'function' || !CALLBACKS.has(f)) {
    throw new InterpError('forbidden', 'a native was handed a callback that is not an interpreter function');
  }
  return f as Native;
}

/** The largest count `E.Range` will allocate, and the longest array a native takes (special-unit counts are a byte). */
export const MAX_RANGE = 1_000_000;

function asArray(xs: unknown): unknown[] {
  if (!Array.isArray(xs)) throw new InterpError('bad-value', `expected an array, got ${describe(xs)}`);
  // A backstop: interpreted writes keep arrays dense, so only a host-made array could be this long.
  if (xs.length > MAX_RANGE) throw new InterpError('bad-value', `array of ${xs.length} elements (at most ${MAX_RANGE})`);
  return xs;
}

/**
 * Charges native element work to the step budget of the `readClass` that called the native (set by
 * `callStatic` for the duration of the call; a no-op when a native is called from host code).
 */
let chargeNative: (n: number) => void = () => {};

function range(start: unknown, count: unknown): number[] {
  if (typeof start !== 'number' || !Number.isFinite(start)) throw new InterpError('bad-value', `bad range start ${String(start)}`);
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > MAX_RANGE) {
    throw new InterpError('bad-value', `bad range count ${String(count)} (an integer 0..${MAX_RANGE})`);
  }
  chargeNative(count);
  return Array.from({ length: count }, (_, i) => start + i);
}

function list(r: unknown, item: unknown): unknown[] | null {
  const f = callback(item);
  return asReader(r).list(() => f());
}

/** The names used by client v6.07 (protocol 242). */
export const DEFAULT_DIALECT: Dialect = {
  readerMethods: {
    Ua: (r) => r.bool(),
    Og: (r) => r.int32(),
    bc: (r) => r.u8(),
    FJ: (r) => strBody(r),
    // The client's 8-byte read is a float64 (its two int32 halves reassembled as a double), not an
    // int64: kill rates, luck and TimeSpans (milliseconds) all arrive through it.
    E3a: (r) => r.float64(),
    Om: (r) => r.float32(),
    NGb: (r) => r.uint16(),
    S3c: (r) => r.int16(),
    MGb: (r) => r.u8(),
    JS: (r, n) => {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) throw new InterpError('bad-value', `bad byte count ${String(n)}`);
      return r.raw(n);
    },
    I3c: (r) => r.varint(),
  },
  statics: {
    P: {
      Ya: (r) => asReader(r).int32(),
      wc: (r) => asReader(r).string(),
      Yc: (r) => asReader(r).bool(),
      uq: (r) => asReader(r).u8(),
      Ao: (r) => asReader(r).float32(),
      ak: (r) => asReader(r).float64(),
      uy: (r) => asReader(r).float64(),
      Td: (r) => asReader(r).date(),
      tL: (r) => asReader(r).guid(),
      Z5: (r) => asReader(r).uint16(),
      sL: (r) => readBytes(asReader(r)),
      Sd: list,
      ms: list,
      uL: list,
      ef: (r, k, v) => {
        const fk = callback(k);
        const fv = callback(v);
        return asReader(r).list(() => [fk(), fv()]);
      },
    },
    O: { fA: (x) => x, Fy: (x) => x, rc: (x) => x },
    za: { rc: (x) => x },
    // Enumerable helpers (special-unit lists): Range → Select → ToArray.
    E: {
      Range: range,
      Za: (xs, f) => {
        const fn = callback(f);
        return asArray(xs).map((x) => fn(x));
      },
      Sa: (xs) => [...asArray(xs)],
    },
  },
  wrappers: ['Z', 'Yb', 'uc', 'dc', 'oc', 'ec', 'fc'],
};

/** The class whose statics are the reader helpers (`P.Ya(a)`), checked by `verifyDialect`. */
export const READER_HELPERS = 'P';

/** What `verifyDialect` found: built-in helpers by `Class.name`. */
export interface DialectCheck {
  /** The bundle's definition read the same as the built-in on the probes. */
  verified: string[];
  /** Defined in the bundle, but not in a form the interpreter can evaluate. */
  unverified: string[];
  /** The bundle's definition reads differently: the built-in would mis-read. */
  mismatched: string[];
}

/** Byte strings each helper is run on: small counts, a -1 count, ascending bytes, zeros. */
const DIALECT_PROBES: readonly Uint8Array[] = [
  Uint8Array.from([2, 0, 0, 0, 1, 0, 0, 0, 3, 0, 0, 0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
  Uint8Array.from([1, 1, 0, 0, 0, 1, 7, 0, 0, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9]),
  Uint8Array.from([255, 255, 255, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  Uint8Array.from({ length: 32 }, (_, i) => i),
  new Uint8Array(32),
];

type ProbeOutcome =
  | { kind: 'value'; value: unknown; position: number }
  | { kind: 'read-error' }
  | { kind: 'unevaluable' };

/** Run a helper on a probe: the reader, then one item reader (a byte) per extra parameter. */
function runProbe(probe: Uint8Array, arity: number, call: (args: unknown[]) => unknown): ProbeOutcome {
  const r = new Reader(probe);
  const args: unknown[] = [r];
  for (let i = 1; i < arity; i++) {
    // An item reader the host made: registered as a callback, so a native list helper (and the
    // bundle's own definition, through \`call\`) may call it like an interpreter closure.
    const item = () => r.u8();
    CALLBACKS.add(item);
    args.push(item);
  }
  try {
    const value = call(args);
    return { kind: 'value', value, position: r.position };
  } catch (e) {
    return e instanceof InterpError && e.kind !== 'reader-threw' ? { kind: 'unevaluable' } : { kind: 'read-error' };
  }
}

const isClientObject = (v: unknown): boolean =>
  isObject(v) && !Array.isArray(v) && !(v instanceof Date) && !(v instanceof Uint8Array) && typeof v.$type === 'string';

function sameOutcome(a: ProbeOutcome, b: ProbeOutcome): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== 'value' || b.kind !== 'value') return true;
  return a.position === b.position && sameValue(a.value, b.value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (a instanceof Date && b instanceof Date) return Object.is(a.getTime(), b.getTime());
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  return false;
}

export interface InterpOptions {
  /** The protocol version handed to every `Ha` (default {@link PROTOCOL_VERSION}). */
  version?: number;
  /** Called with `Var.fn` for every bundle function evaluated. */
  trace?: (fn: string) => void;
  /** Overrides merged over {@link DEFAULT_DIALECT}. */
  dialect?: Partial<Dialect>;
  /** Iteration cap for a single `for` loop (default 1e6). */
  maxIterations?: number;
  /** Evaluation steps (statements, expressions and calls) allowed per `readClass` (default {@link DEFAULT_MAX_STEPS}). */
  maxSteps?: number;
  /** Nesting of interpreted calls allowed per `readClass` (default {@link DEFAULT_MAX_DEPTH}). */
  maxDepth?: number;
  /** Wall-clock milliseconds allowed per `readClass` (default {@link DEFAULT_MAX_MILLIS}). */
  maxMillis?: number;
  /** The clock the deadline is measured on (default `performance.now`); tests inject one. */
  now?: () => number;
}

/**
 * Steps per `readClass`. Native element work counts too: an array handed to a native costs its
 * length, and `E.Range` its count. A synthetic 3,000-territory board with 40 players' hands and
 * special units (the test mini-bundle) takes about 0.49M steps (about 25 ms); this is about 60 times that.
 * Measured, it ends a runaway read in well under a second: a nested-loop bomb in about 0.4 s, and
 * one that repeats `E.Sa(E.Range(0,1e6))` in about 0.3 s.
 */
export const DEFAULT_MAX_STEPS = 30_000_000;
/**
 * One step budget shared by several `readClass` calls that decode one reply: pass the same object to
 * each, starting at `{ spent: 0 }`; each read continues the count where the last one stopped.
 */
export interface ReadBudget {
  spent: number;
  /** When the first read on this budget started (the interpreter's clock), so the reads share one deadline. */
  startedAt?: number;
}

/**
 * Wall-clock milliseconds per `readClass` (or per shared {@link ReadBudget}): the backstop for host
 * work the step count does not see. A legitimate read of the large synthetic board takes about 25 ms.
 */
export const DEFAULT_MAX_MILLIS = 5_000;

/** The clock is read once every this many steps. */
const CLOCK_EVERY = 1024;

/**
 * Lexical function nesting allowed (a function inside a function inside …). A name lookup walks every
 * enclosing scope, so without a cap one step could cost hundreds of lookups; real readers nest a few deep.
 */
export const MAX_NESTING = 32;

/** The longest message kept for a thrown value (`reader threw: …`). */
export const MAX_THROW_MESSAGE = 200;

/** Interpreted call depth per `readClass`; real readers nest a few dozen deep at most. */
export const DEFAULT_MAX_DEPTH = 256;

/** Steps charged when a constructor's failure is kept on the object (`$ctorError`) rather than thrown. */
const CTOR_FAILURE_STEPS = 20;

/** Keys that lead from any value to its prototype or constructor: never read or written. */
const FORBIDDEN_KEYS = new Set(['constructor', '__proto__', 'prototype']);

/**
 * Object.prototype's member names (the legacy `__defineGetter__` family included) plus `toJSON`.
 * Written onto a decoded object they would shadow the host member with a value that is not
 * callable, so `String(obj)`, `obj.hasOwnProperty(…)`, `JSON.stringify` or loose equality in a
 * consumer (or the interpreter) would throw. Never written.
 */
const SHADOWING_KEYS = new Set(
  ['toJSON', ...Object.getOwnPropertyNames(Object.prototype)].filter((k) => !FORBIDDEN_KEYS.has(k)),
);

/** Operators that compare without converting an object operand (`==` / `!=` go through `looseEquals`). */
const EQUALITY_OPS = new Set(['===', '!==', '==', '!=']);
/** Operators that compare two string operands as strings (`==` / `!=` are charged in `looseEquals`). */
const STRING_COMPARE_OPS = new Set(['===', '!==', '<', '<=', '>', '>=']);

/**
 * The longest string `+` may build. Real readers build only short strings (names, messages); without
 * a cap, repeated doubling reaches the host's string limit (a RangeError) or exhausts the heap.
 */
export const MAX_STRING = 1_000_000;

/**
 * A canonical array index (`"0"`, `"12"`, not `"01"` or `"1.0"`). No index has more than ten digits, so a
 * longer key is refused before the pattern test, which would otherwise scan the whole key.
 */
const isIndex = (k: string) => k.length <= 10 && /^(?:0|[1-9]\d*)$/.test(k);

// ---------------------------------------------------------------------------
// Runtime values

class ClassRef {
  constructor(readonly name: string) {}
}

class Closure {
  constructor(
    readonly node: FunctionExpression,
    readonly scope: Scope,
    readonly where: string,
  ) {}
}

/** What `Scope.lookup` returns for a name no enclosing scope declares. */
const UNDECLARED: unique symbol = Symbol('undeclared');

class Scope {
  private readonly vars = new Map<string, unknown>();
  /** Enclosing scopes: a function's scope is one deeper than the scope its closure was made in. */
  readonly depth: number;
  constructor(private readonly parent: Scope | null = null) {
    this.depth = parent ? parent.depth + 1 : 0;
  }

  /**
   * The value of the nearest declaration of `name`, or UNDECLARED; `walked` is called with the number
   * of scopes visited, so the caller can charge the lookup. Iterative: no host recursion per scope.
   */
  lookup(name: string, walked: (n: number) => void): unknown {
    let n = 0;
    for (let s: Scope | null = this; s; s = s.parent) {
      n++;
      if (s.vars.has(name)) {
        walked(n);
        return s.vars.get(name);
      }
    }
    walked(n);
    return UNDECLARED;
  }

  hasOwn(name: string): boolean {
    return this.vars.has(name);
  }


  declare(name: string, value: unknown): void {
    this.vars.set(name, value);
  }

  /** Assign to the nearest scope that declares `name` (else this one); returns the scopes visited. */
  assign(name: string, value: unknown): number {
    let n = 1;
    let s: Scope | null = this;
    while (s && !s.vars.has(name)) {
      s = s.parent;
      n++;
    }
    (s ?? this).vars.set(name, value);
    return n;
  }
}

type Completion = undefined | { type: 'return'; value: unknown } | { type: 'break' };

interface ResolvedFn {
  node: FunctionExpression;
  where: string;
}

/** Definition sites in the bundle source (see `BundleInterpreter.definitions`). */
interface Definitions {
  /** `Cls.fn` → offsets of each `function` assigned to it, in source order. */
  statics: Map<string, number[]>;
  /** `Cls` → offset of its first `function Cls(`. */
  ctors: Map<string, number>;
  /** `Cls` → offset of its first registration. */
  registrations: Map<string, number>;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Descend from a parsed expression to the function expression that starts it. */
function leadingFunction(node: AnyNode): FunctionExpression | null {
  let n: AnyNode | null | undefined = node;
  while (n) {
    switch (n.type) {
      case 'FunctionExpression':
        return n;
      case 'SequenceExpression':
        n = n.expressions[0];
        break;
      case 'CallExpression':
        n = n.callee;
        break;
      case 'MemberExpression':
        n = n.object;
        break;
      case 'BinaryExpression':
      case 'LogicalExpression':
      case 'AssignmentExpression':
        n = n.left;
        break;
      case 'ConditionalExpression':
        n = n.test;
        break;
      default:
        return null;
    }
  }
  return null;
}

/** Evaluates a bundle's reader functions against codec readers. */
export class BundleInterpreter {
  readonly version: number;
  private readonly dialect: Dialect;
  private readonly wrappers: Set<string>;
  /** Resolved functions by `Cls.fn` / `new Cls`: a hit, `null` (no constructor) or the cached failure. */
  private readonly fnCache = new Map<string, ResolvedFn | InterpError | null>();
  private defs: Definitions | null = null;
  private readonly maxIterations: number;
  private readonly maxSteps: number;
  private readonly maxDepth: number;
  private readonly maxMillis: number;
  private readonly now: () => number;
  private steps = 0;
  private depth = 0;
  /** When this read must end (the interpreter's clock), and the step count at which the clock is next read. */
  private deadline = Infinity;
  private nextClock = 0;
  /** `reader threw: …` per throw site, built once (see `throwMessage`). */
  private readonly throwMessages = new WeakMap<AcornNode, string>();

  constructor(
    readonly bundle: ParsedBundle,
    private readonly opts: InterpOptions = {},
  ) {
    this.version = opts.version ?? PROTOCOL_VERSION;
    this.maxIterations = opts.maxIterations ?? 1e6;
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
    this.maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.maxMillis = opts.maxMillis ?? DEFAULT_MAX_MILLIS;
    this.now = opts.now ?? (() => performance.now());
    const d = opts.dialect ?? {};
    this.dialect = {
      readerMethods: { ...DEFAULT_DIALECT.readerMethods, ...d.readerMethods },
      statics: { ...DEFAULT_DIALECT.statics, ...d.statics },
      wrappers: d.wrappers ?? DEFAULT_DIALECT.wrappers,
    };
    this.wrappers = new Set(this.dialect.wrappers);
  }

  /** The class var for a registered type name, or the argument itself if it is a var. */
  resolveVar(typeNameOrVar: string): string {
    const v = this.bundle.varOf.get(typeNameOrVar);
    if (v) return v;
    if (this.bundle.typeNameOf.has(typeNameOrVar) || !typeNameOrVar.includes('.')) return typeNameOrVar;
    throw new InterpError('unknown-class', `no class registered as ${typeNameOrVar}`);
  }

  /**
   * Read one instance of a class (`<Var>.Ha(reader, null, version)`). With `budget`, the read draws on
   * that shared step count (and records what it spent there) instead of a fresh one.
   */
  readClass(typeNameOrVar: string, reader: Reader, budget?: ReadBudget): unknown {
    const cls = this.resolveVar(typeNameOrVar);
    return this.budgeted(budget, () => this.callStatic(cls, 'Ha', [reader, null, this.version]));
  }

  /**
   * Run interpreted code under one step and depth budget: a fresh one, or `budget`'s count continued
   * (and what was spent recorded there). Every entry into interpreted code goes through here.
   */
  private budgeted<T>(budget: ReadBudget | undefined, run: () => T): T {
    this.steps = budget && Number.isFinite(budget.spent) && budget.spent > 0 ? budget.spent : 0;
    this.depth = 0;
    // One deadline per read, or per shared budget: its first read records when it started.
    let started = this.now();
    if (budget) {
      if (typeof budget.startedAt === 'number' && Number.isFinite(budget.startedAt)) started = budget.startedAt;
      else budget.startedAt = started;
    }
    this.deadline = started + this.maxMillis;
    this.nextClock = this.steps + CLOCK_EVERY;
    try {
      return run();
    } catch (e) {
      // The depth limit should always fire first; this keeps a native stack overflow an InterpError too.
      // Any other host RangeError (an invalid string or array length) is a runaway read too.
      if (e instanceof RangeError) {
        throw new InterpError('budget', /call stack/i.test(e.message) ? 'reader recursed past the host stack' : `read ran past a host limit: ${e.message}`);
      }
      throw e;
    } finally {
      if (budget) budget.spent = this.steps;
    }
  }

  /**
   * Check the built-in reader helpers (the dialect's statics on {@link READER_HELPERS}) against
   * the bundle's own definitions of the same names: each definition is evaluated on a few probe
   * byte strings and must read the same value and the same number of bytes as the built-in. The
   * built-ins shadow the bundle's definitions, so a new client that gives a name to another helper
   * would otherwise decode every field through the wrong read without an error (#131). A
   * definition the interpreter cannot evaluate is unverified, not a mismatch.
   */
  verifyDialect(): DialectCheck {
    const out: DialectCheck = { verified: [], unverified: [], mismatched: [] };
    const natives = Object.hasOwn(this.dialect.statics, READER_HELPERS) ? this.dialect.statics[READER_HELPERS]! : {};
    // The bundle's definitions run like any interpreted code: contained, and under one step budget
    // shared by the whole check, so a hostile bundle cannot spend more than one read's worth here.
    // Past the budget, a probe is unevaluable (the helper unverified), never a mismatch.
    const budget: ReadBudget = { spent: 0 };
    const defined = this.indexDefinitions(READER_HELPERS, Object.keys(natives), budget);
    for (const name of [...defined].sort()) {
      const native = natives[name]!;
      const key = `${READER_HELPERS}.${name}`;
      let agreed = 0;
      let mismatch = false;
      for (const probe of DIALECT_PROBES) {
        const mine = runProbe(probe, native.length, (args) => native(...args));
        const theirs = runProbe(probe, native.length, (args) =>
          this.budgeted(budget, () => {
            const { node, where } = this.resolveStatic(READER_HELPERS, name);
            return this.invoke(node, args, new Scope(), where);
          }),
        );
        // A client collection (`new Je`, a dictionary) is not comparable with the built-in's
        // JS array: only plain values say whether the two read alike.
        if (theirs.kind === 'unevaluable' || (theirs.kind === 'value' && isClientObject(theirs.value))) continue;
        if (sameOutcome(mine, theirs)) agreed++;
        else mismatch = true;
      }
      if (mismatch) out.mismatched.push(key);
      else if (agreed) out.verified.push(key);
      else out.unverified.push(key);
    }
    return out;
  }

  /**
   * Which of `names` the bundle defines as `<cls>.<name>=function` in a form that parses: looked up
   * in the one-pass definition index (never a rescan), parsed and cached, the parsing charged to `budget`.
   */
  private indexDefinitions(cls: string, names: readonly string[], budget: ReadBudget): Set<string> {
    const found = new Set<string>();
    for (const name of names) {
      if (!this.definitions().statics.has(`${cls}.${name}`)) continue;
      try {
        this.budgeted(budget, () => this.resolveStatic(cls, name));
        found.add(name);
      } catch {
        // Unparsable (or past the budget): not checked.
      }
    }
    return found;
  }

  /**
   * The fields a class's reader fills from another class's reader, in read order — found by
   * reading the reader's source, not by running it, so a field the reply leaves absent (null)
   * is still named. Follows the reader into its own class's statics (`Lg.Ha` → `Lg.R`). Empty
   * when either class is unknown or no field is read from it.
   */
  fieldsReadAs(ownerTypeOrVar: string, fieldType: string): string[] {
    const fieldVar = this.bundle.varOf.get(fieldType);
    let ownerVar: string;
    try {
      ownerVar = this.resolveVar(ownerTypeOrVar);
    } catch {
      return [];
    }
    if (!fieldVar) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const visit = (fn: string, depth: number): void => {
      if (seen.has(fn) || depth > 3) return;
      seen.add(fn);
      let node: FunctionExpression;
      try {
        node = this.resolveStatic(ownerVar, fn).node;
      } catch {
        return;
      }
      const found = fieldAssignments(node, fieldVar);
      for (const f of found) if (!out.includes(f)) out.push(f);
      if (!found.length) for (const next of ownStaticCalls(node, ownerVar)) visit(next, depth + 1);
    };
    // Parsing a reader is charged to a step budget like any other entry into the bundle.
    this.budgeted(undefined, () => visit('Ha', 0));
    return out;
  }

  // -------------------------------------------------------------------------
  // Resolution

  /**
   * Parse the function expression at `pos`. The characters acorn consumed are charged to the step
   * budget: each definition is parsed once per interpreter (see {@link fnCache}), but a hostile
   * bundle could otherwise make one step parse megabytes.
   */
  private parseFunctionAt(pos: number, where: string): FunctionExpression {
    let node: AnyNode;
    try {
      node = parseExpressionAt(this.bundle.src, pos, { ecmaVersion: 'latest' }) as AnyNode;
    } catch (e) {
      const at = (e as { raisedAt?: unknown }).raisedAt;
      this.spend(typeof at === 'number' && at > pos ? at - pos : 1, where, pos);
      throw new InterpError('parse', `cannot parse function: ${(e as Error).message}`, where, pos);
    }
    this.spend(Math.max(1, node.end - pos), where, pos);
    const fn = leadingFunction(node);
    if (!fn || fn.start !== pos) throw new InterpError('parse', 'no function expression', where, pos);
    return fn;
  }

  /**
   * The bundle's definition sites, found in one pass the first time any function is resolved, so a
   * lookup never rescans the source: a scan is host work in the bundle's length that the step budget
   * cannot see, and before this a loop of failing lookups (a constructor swallows the error) rescanned
   * the whole bundle on every iteration. Names are the minifier's ASCII identifiers (`[\w$]+`).
   */
  private definitions(): Definitions {
    if (this.defs) return this.defs;
    const { src, typeNameOf } = this.bundle;
    const statics = new Map<string, number[]>();
    // `Cls.fn = function`: the lookahead leaves `function` unconsumed, so no definition hides another.
    for (const m of src.matchAll(/(?<![\w$.])([\w$]+)\.([\w$]+)\s*=\s*(?=function\b)/g)) {
      const key = `${m[1]}.${m[2]}`;
      const at = m.index + m[0].length;
      const list = statics.get(key);
      if (list) list.push(at);
      else statics.set(key, [at]);
    }
    const ctors = new Map<string, number>();
    for (const m of src.matchAll(/function ([\w$]+)\(/g)) if (!ctors.has(m[1])) ctors.set(m[1], m.index);
    // Where each class's first registration (`W["<type name>"]=<var>;`) sits.
    const registrations = new Map<string, number>();
    for (const m of src.matchAll(/W\["([\w.$]+)"\]=([\w$]+);/g)) {
      if (!registrations.has(m[2]) && typeNameOf.get(m[2]) === m[1]) registrations.set(m[2], m.index);
    }
    this.defs = { statics, ctors, registrations };
    return this.defs;
  }

  private resolveStatic(cls: string, fn: string): ResolvedFn {
    const where = `${cls}.${fn}`;
    const cached = this.fnCache.get(where);
    // A failure is cached too, so a missing or unparsable function costs one lookup per interpreter.
    if (cached instanceof InterpError) throw cached;
    if (cached) return cached;
    try {
      const sites = this.definitions().statics.get(where);
      if (!sites) throw new InterpError('no-definition', `no definition for ${where}`);
      // Prefer the definition that follows the class's registration.
      const from = this.definitions().registrations.get(cls) ?? 0;
      const at = sites.find((p) => p >= from) ?? sites[0];
      const resolved = { node: this.parseFunctionAt(at, where), where };
      this.fnCache.set(where, resolved);
      return resolved;
    } catch (e) {
      if (e instanceof InterpError && (e.kind === 'no-definition' || e.kind === 'parse')) this.fnCache.set(where, e);
      throw e;
    }
  }

  private resolveCtor(cls: string): ResolvedFn | null {
    const key = `new ${cls}`;
    const cached = this.fnCache.get(key);
    if (cached instanceof InterpError) throw cached;
    if (cached !== undefined) return cached;
    const at = this.definitions().ctors.get(cls);
    let resolved: ResolvedFn | null = null;
    try {
      if (at !== undefined) resolved = { node: this.parseFunctionAt(at, key), where: key };
    } catch (e) {
      if (e instanceof InterpError && e.kind === 'parse') this.fnCache.set(key, e);
      throw e;
    }
    this.fnCache.set(key, resolved);
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Calls

  private callStatic(cls: string, fn: string, args: unknown[]): unknown {
    // Own entries only: an inherited `constructor` would hand over Object and, through it, Function.
    const table = Object.hasOwn(this.dialect.statics, cls) ? this.dialect.statics[cls] : undefined;
    const native = table && Object.hasOwn(table, fn) ? table[fn] : undefined;
    if (native) {
      const where = `${cls}.${fn}`;
      const nargs = args.map((a) => this.toNative(a));
      // Element work a native does over an array argument is charged before it runs.
      for (const a of nargs) if (Array.isArray(a)) this.spend(a.length, where);
      const outer = chargeNative;
      chargeNative = (n) => this.spend(n, where);
      try {
        return fromNative(native(...nargs));
      } finally {
        chargeNative = outer;
      }
    }
    const { node, where } = this.resolveStatic(cls, fn);
    this.opts.trace?.(where);
    return this.invoke(node, args, new Scope(), where);
  }

  private toNative(v: unknown): unknown {
    if (v instanceof Closure) {
      const f = (...args: unknown[]) => this.invoke(v.node, args, v.scope, v.where);
      CALLBACKS.add(f);
      return f;
    }
    return fromNative(v);
  }

  /** Count one evaluation step against this read's budget. */
  private tick(where: string, node: AcornNode): void {
    this.spend(1, where, node.start);
  }

  /** Count `n` steps (native element work, or one evaluation) against this read's budget. */
  private spend(n: number, where: string, offset?: number): void {
    this.steps += n;
    if (this.steps > this.maxSteps) {
      throw new InterpError('budget', `read ran past ${this.maxSteps} steps`, where, offset);
    }
    if (this.steps >= this.nextClock) {
      this.nextClock = this.steps + CLOCK_EVERY;
      if (this.now() > this.deadline) throw new InterpError('budget', `read ran past ${this.maxMillis} ms`, where, offset);
    }
  }

  /** Charge a name lookup that visited `walked` scopes: the first is the step's own, each further one a step. */
  private chargeLookup(walked: number, where: string, node: AcornNode): void {
    if (walked > 1) this.spend(walked - 1, where, node.start);
  }

  /** The value of `name` in `scope`, or UNDECLARED, its walk charged. */
  private lookup(scope: Scope, name: string, where: string, node: AcornNode): unknown {
    return scope.lookup(name, (walked) => this.chargeLookup(walked, where, node));
  }

  private invoke(node: FunctionExpression, args: unknown[], outer: Scope, where: string, self?: unknown): unknown {
    this.tick(where, node);
    if (this.depth >= this.maxDepth) {
      throw new InterpError('budget', `call depth ran past ${this.maxDepth}`, where, node.start);
    }
    this.depth++;
    try {
      return this.invokeBody(node, args, outer, where, self);
    } finally {
      this.depth--;
    }
  }

  private invokeBody(node: FunctionExpression, args: unknown[], outer: Scope, where: string, self?: unknown): unknown {
    const scope = new Scope(outer);
    if (scope.depth > MAX_NESTING) {
      throw new InterpError('budget', `functions nested past ${MAX_NESTING}`, where, node.start);
    }
    if (self !== undefined) scope.declare('this', self);
    node.params.forEach((p, i) => scope.declare(this.paramName(p, where), args[i]));
    // `var` is function-scoped and hoisted: a var declared only in an untaken branch is undefined,
    // not an unknown name (which would read as a class reference).
    for (const name of hoistedVars(node)) if (!scope.hasOwn(name)) scope.declare(name, undefined);
    const c = this.execBlock(node.body.body, scope, where);
    return c?.type === 'return' ? c.value : undefined;
  }

  private paramName(p: Pattern, where: string): string {
    if (p.type !== 'Identifier') throw this.unsupported(`parameter ${p.type}`, p, where);
    return p.name;
  }

  private unsupported(what: string, node: AcornNode, where: string): InterpError {
    return new InterpError('unsupported', `unsupported ${what}`, where, node.start);
  }

  // -------------------------------------------------------------------------
  // Statements

  private execBlock(body: Statement[], scope: Scope, where: string): Completion {
    for (const st of body) {
      const c = this.exec(st, scope, where);
      if (c) return c;
    }
    return undefined;
  }

  private exec(st: Statement, scope: Scope, where: string): Completion {
    this.tick(where, st);
    switch (st.type) {
      case 'VariableDeclaration':
        for (const d of st.declarations) {
          const name = this.paramName(d.id, where);
          // `var x;` re-run (in a loop) keeps x's value; hoisting already declared it.
          if (d.init) scope.declare(name, this.eval(d.init, scope, where));
          else if (!scope.hasOwn(name)) scope.declare(name, undefined);
        }
        return undefined;
      case 'ExpressionStatement':
        this.eval(st.expression, scope, where);
        return undefined;
      case 'ReturnStatement':
        return { type: 'return', value: st.argument ? this.eval(st.argument, scope, where) : undefined };
      case 'IfStatement':
        if (this.eval(st.test, scope, where)) return this.exec(st.consequent, scope, where);
        return st.alternate ? this.exec(st.alternate, scope, where) : undefined;
      case 'BlockStatement':
        return this.execBlock(st.body, scope, where);
      case 'ForStatement': {
        if (st.init) {
          if (st.init.type === 'VariableDeclaration') this.exec(st.init, scope, where);
          else this.eval(st.init, scope, where);
        }
        for (let n = 0; !st.test || this.eval(st.test, scope, where); n++) {
          if (n >= this.maxIterations) throw new InterpError('loop-guard', `loop ran past ${this.maxIterations} iterations`, where, st.start);
          const c = this.exec(st.body, scope, where);
          if (c?.type === 'break') break;
          if (c) return c;
          if (st.update) this.eval(st.update, scope, where);
        }
        return undefined;
      }
      case 'SwitchStatement': {
        const v = this.eval(st.discriminant, scope, where);
        let i = st.cases.findIndex((c) => c.test && this.looseEquals(this.eval(c.test, scope, where), v, where, c));
        if (i < 0) i = st.cases.findIndex((c) => !c.test);
        if (i < 0) return undefined;
        for (; i < st.cases.length; i++) {
          const c = this.execBlock(st.cases[i].consequent, scope, where);
          if (c?.type === 'break') return undefined;
          if (c) return c;
        }
        return undefined;
      }
      case 'BreakStatement':
        if (st.label) throw this.unsupported('labelled break', st, where);
        return { type: 'break' };
      case 'EmptyStatement':
        return undefined;
      case 'ThrowStatement':
        // The argument is not evaluated (it may read bytes or build exception objects);
        // its string literals are the message, built once per throw site and capped.
        throw new InterpError('reader-threw', this.throwMessage(st, where), where, st.start);
      default:
        throw this.unsupported(`statement ${st.type}`, st, where);
    }
  }

  /**
   * `reader threw: <the argument's string literals>`, capped at MAX_THROW_MESSAGE characters. Walking the
   * argument is host work in its size, so it is done once per throw site (and charged by the nodes
   * walked); every throw is then charged the message's length, as building the error copies it.
   */
  private throwMessage(st: AcornNode & { argument: AcornNode }, where: string): string {
    let msg = this.throwMessages.get(st);
    if (msg === undefined) {
      const { literals, nodes } = stringLiterals(st.argument, MAX_THROW_MESSAGE);
      this.spend(nodes, where, st.start);
      const text = literals.join(' ');
      msg = `reader threw: ${text.length > MAX_THROW_MESSAGE ? `${text.slice(0, MAX_THROW_MESSAGE)}…` : text || '(no message)'}`;
      this.throwMessages.set(st, msg);
    }
    this.spend(msg.length, where, st.start);
    return msg;
  }

  // -------------------------------------------------------------------------
  // Expressions

  private eval(n: Expression, scope: Scope, where: string): unknown {
    this.tick(where, n);
    switch (n.type) {
      case 'Literal':
        // Only string, number, boolean and null literals. A BigInt costs the host O(size) per
        // operator while the budget charges one step, and a RegExp is a host object; no reader uses either.
        if (n.value !== null && typeof n.value === 'object') throw new InterpError('bad-value', 'regexp literal', where, n.start);
        if (typeof n.value === 'bigint') throw new InterpError('bad-value', 'bigint literal', where, n.start);
        return n.value;
      case 'Identifier': {
        const v = this.lookup(scope, n.name, where, n);
        if (v !== UNDECLARED) return v;
        if (n.name === 'undefined') return undefined;
        return new ClassRef(n.name);
      }
      case 'ThisExpression': {
        const v = this.lookup(scope, 'this', where, n);
        return v === UNDECLARED ? undefined : v;
      }
      case 'SequenceExpression': {
        let v: unknown;
        for (const e of n.expressions) v = this.eval(e, scope, where);
        return v;
      }
      case 'ConditionalExpression':
        return this.eval(n.test, scope, where) ? this.eval(n.consequent, scope, where) : this.eval(n.alternate, scope, where);
      case 'LogicalExpression': {
        const l = this.eval(n.left, scope, where);
        if (n.operator === '&&') return l ? this.eval(n.right, scope, where) : l;
        if (n.operator === '||') return l ? l : this.eval(n.right, scope, where);
        throw this.unsupported(`operator ${n.operator}`, n, where);
      }
      case 'UnaryExpression': {
        const v = this.eval(n.argument, scope, where);
        if (n.operator === '!') return !v;
        if (n.operator === '-') return -(this.numeric(v, n, where) as number);
        if (n.operator === 'void') return undefined;
        throw this.unsupported(`operator ${n.operator}`, n, where);
      }
      case 'BinaryExpression':
        return this.binary(n.operator, n.left as Expression, n.right, scope, where, n);
      case 'AssignmentExpression': {
        if (n.operator !== '=') throw this.unsupported(`assignment ${n.operator}`, n, where);
        const v = this.eval(n.right, scope, where);
        const t = n.left;
        if (t.type === 'Identifier') {
          this.chargeLookup(scope.assign(t.name, v), where, t);
          return v;
        }
        if (t.type === 'MemberExpression') {
          const o = this.eval(t.object as Expression, scope, where);
          const k = this.memberKey(t, scope, where);
          if (!isObject(o) || o instanceof ClassRef) throw new InterpError('bad-value', `cannot set ${k} on ${describe(o)}`, where, t.start);
          // Only arrays and plain objects (the ones the interpreter makes) take writes, and only as
          // own data properties: never onto the reader, a closure or a host object, never a prototype.
          const proto = Object.getPrototypeOf(o);
          if (Array.isArray(o)) {
            // An array stays dense: an index at most its length (overwrite or append), never `length`
            // itself or a far index, which would make a huge sparse array for free.
            if (!isIndex(k) || Number(k) > o.length) throw new InterpError('forbidden', `cannot set ${k} on an array of ${o.length}`, where, t.start);
          } else if (proto !== Object.prototype && proto !== null) {
            throw new InterpError('forbidden', `cannot set ${k} on ${describe(o)}`, where, t.start);
          } else if (SHADOWING_KEYS.has(k)) {
            throw new InterpError('forbidden', `cannot set ${k}: it would shadow a built-in method`, where, t.start);
          }
          o[k] = v;
          return v;
        }
        throw this.unsupported(`assignment target ${t.type}`, t, where);
      }
      case 'UpdateExpression': {
        if (n.argument.type !== 'Identifier') throw this.unsupported(`update of ${n.argument.type}`, n, where);
        const name = n.argument.name;
        // ToNumeric, as the language does (`"3"++` is 4), with a string's conversion charged.
        const cur = this.lookup(scope, name, where, n);
        const old = Number(this.numeric(cur === UNDECLARED ? undefined : cur, n, where));
        const next = n.operator === '++' ? old + 1 : old - 1;
        this.chargeLookup(scope.assign(name, next), where, n);
        return n.prefix ? next : old;
      }
      case 'FunctionExpression':
        return new Closure(n, scope, where);
      case 'NewExpression':
        return this.construct(n.callee as Expression, n.arguments as Expression[], scope, where, n);
      case 'ArrayExpression':
        return n.elements.map((e) => {
          if (!e || e.type === 'SpreadElement') throw this.unsupported('array element', n, where);
          return this.eval(e, scope, where);
        });
      case 'MemberExpression': {
        const o = this.eval(n.object as Expression, scope, where);
        const k = this.memberKey(n, scope, where);
        if (o instanceof ClassRef) throw this.unsupported(`static read ${o.name}.${k}`, n, where);
        if (o instanceof Reader) throw this.unsupported(`reader member ${k}`, n, where);
        if (o === null || o === undefined) throw new InterpError('bad-value', `read of ${k} of ${String(o)}`, where, n.start);
        if (o instanceof Closure || o instanceof Scope) throw new InterpError('forbidden', `read of ${k} of an interpreter value`, where, n.start);
        return readMember(o, k);
      }
      case 'CallExpression':
        return this.call(n.callee as Expression, n.arguments as Expression[], scope, where, n);
      default:
        throw this.unsupported(`expression ${n.type}`, n, where);
    }
  }

  private memberKey(n: AcornNode & { computed: boolean; property: Expression | { type: 'PrivateIdentifier' } }, scope: Scope, where: string): string {
    const p = n.property;
    let k: string;
    if (n.computed) {
      const v = this.eval(p as Expression, scope, where);
      // A string or number key only: converting an object would run its (host) toString.
      if (typeof v !== 'string' && typeof v !== 'number') throw new InterpError('bad-value', `member key ${describe(v)}`, where, n.start);
      k = String(v);
      // Using a key is host work in its length (the index test, hashing, a static's lookup), so a long
      // computed key is charged: built once, it could otherwise be used over and over at one step a time.
      this.spend(k.length, where, n.start);
    } else {
      k = (p as { name: string }).name;
    }
    if (FORBIDDEN_KEYS.has(k)) throw new InterpError('forbidden', `access to ${k}`, where, n.start);
    return k;
  }

  private binary(op: string, left: Expression, right: Expression, scope: Scope, where: string, n: AcornNode): unknown {
    const l = this.eval(left, scope, where) as never;
    const r = this.eval(right, scope, where) as never;
    // Arithmetic, relational and bitwise operators convert an object through the host's
    // ToPrimitive: refused, so an odd operand is an InterpError rather than a host TypeError.
    if (op !== 'instanceof' && !EQUALITY_OPS.has(op)) {
      this.primitive(l, n, where);
      this.primitive(r, n, where);
    }
    if (typeof l === 'string' && typeof r === 'string' && STRING_COMPARE_OPS.has(op)) {
      // Comparing two strings is host work in their length: charged so long strings cannot outrun the budget
      // (`looseEquals` charges `==` / `!=`).
      this.spend(Math.min((l as string).length, (r as string).length), where, n.start);
    } else if (op !== '+' && op !== 'instanceof' && !EQUALITY_OPS.has(op)) {
      // Every other string operand of a numeric operator is converted to a number, host work in its length.
      this.chargeConversion(l, where, n);
      this.chargeConversion(r, where, n);
    }
    switch (op) {
      case '==':
        return this.looseEquals(l, r, where, n);
      case '!=':
        return !this.looseEquals(l, r, where, n);
      case '===':
        return l === r;
      case '!==':
        return l !== r;
      case '<':
        return l < r;
      case '<=':
        return l <= r;
      case '>':
        return l > r;
      case '>=':
        return l >= r;
      case '+': {
        const v = (l as number) + (r as number);
        if (typeof v === 'string') {
          if ((v as string).length > MAX_STRING) {
            throw new InterpError('budget', `string of ${(v as string).length} characters (at most ${MAX_STRING})`, where, n.start);
          }
          this.spend((v as string).length, where, n.start);
        }
        return v;
      }
      case '-':
        return l - r;
      case '*':
        return l * r;
      case '|':
        return l | r;
      case '&':
        return l & r;
      case 'instanceof': {
        const cls = r as unknown;
        if (!(cls instanceof ClassRef)) throw this.unsupported('instanceof of a non-class', n, where);
        const o = l as unknown;
        return isObject(o) && o.$type === (this.bundle.typeNameOf.get(cls.name) ?? cls.name);
      }
      default:
        throw this.unsupported(`operator ${op}`, n, where);
    }
  }

  /**
   * `l == r` without converting an object: an object (or function) loosely equals only itself, so
   * `x == null` keeps working and an object never equals a primitive (the host would convert it
   * through ToPrimitive, an array's join for instance, outside the step budget).
   */
  private looseEquals(l: unknown, r: unknown, where: string, n: AcornNode): boolean {
    const ref = (v: unknown) => isObject(v) || typeof v === 'function';
    if (ref(l) || ref(r)) return l === r;
    if (typeof l === 'string' && typeof r === 'string') this.spend(Math.min(l.length, r.length), where, n.start);
    // A string against a number or boolean is converted to a number: host work in its length.
    else if (typeof l === 'string' && (typeof r === 'number' || typeof r === 'boolean')) this.chargeConversion(l, where, n);
    else if (typeof r === 'string' && (typeof l === 'number' || typeof l === 'boolean')) this.chargeConversion(r, where, n);
    return l == r;
  }

  /** `v` for a numeric operator: refused when it is an object, its conversion charged when it is a string. */
  private numeric(v: unknown, n: AcornNode, where: string): unknown {
    this.primitive(v, n, where);
    this.chargeConversion(v, where, n);
    return v;
  }

  /**
   * Charges the conversion of a string operand to a number. ToNumber scans the whole string, so one
   * step per conversion would let a long string in a loop do far more host work than the budget allows.
   */
  private chargeConversion(v: unknown, where: string, n: AcornNode): void {
    if (typeof v === 'string') this.spend(v.length, where, n.start);
  }

  /** `v`, refused when it is an object (whose conversion to a primitive would run host code). */
  private primitive(v: unknown, n: AcornNode, where: string): unknown {
    if (isObject(v) || typeof v === 'function' || typeof v === 'bigint') throw new InterpError('bad-value', `operand ${describe(v)}`, where, n.start);
    return v;
  }

  private construct(callee: Expression, argNodes: Expression[], scope: Scope, where: string, n: AcornNode): unknown {
    if (callee.type !== 'Identifier') throw this.unsupported(`new of ${callee.type}`, n, where);
    const args = argNodes.map((a) => this.eval(a, scope, where));
    const name = callee.name;
    if (this.wrappers.has(name)) return args.length ? args[0] : null;
    if (name === 'Array') return [];
    const obj: DecodedObject = { $type: this.bundle.typeNameOf.get(name) ?? name };
    if (args.length) {
      // Constructors only normalise what the reader passes in; a failure there (they can
      // validate or build helper objects) is kept on the object rather than losing the read.
      const ctor = this.resolveCtor(name);
      if (ctor) {
        try {
          this.invoke(ctor.node, args, new Scope(), ctor.where, obj);
        } catch (e) {
          // A budget or containment failure is never swallowed into the object.
          if (e instanceof InterpError && (e.kind === 'budget' || e.kind === 'forbidden')) throw e;
          // A host RangeError (stack, string or array length) is a runaway read: readClass turns it into a budget error.
          if (e instanceof RangeError) throw e;
          // A host throw and catch costs far more than a step: charged, so a loop of failing
          // constructors ends at the budget about as fast as any other loop.
          this.spend(CTOR_FAILURE_STEPS, where, n.start);
          obj.$ctorError = (e as Error).message;
        }
      }
    }
    return obj;
  }

  private call(callee: Expression, argNodes: Expression[], scope: Scope, where: string, n: AcornNode): unknown {
    if (callee.type === 'MemberExpression') {
      const o = this.eval(callee.object as Expression, scope, where);
      const k = this.memberKey(callee, scope, where);
      const args = argNodes.map((a) => this.eval(a, scope, where));
      if (o instanceof Reader) {
        const f = Object.hasOwn(this.dialect.readerMethods, k) ? this.dialect.readerMethods[k] : undefined;
        if (!f) throw this.unsupported(`reader method ${k}`, n, where);
        return fromNative(f(o, ...args));
      }
      if (o instanceof ClassRef) return this.callStatic(o.name, k, args);
      if (Array.isArray(o) && k === 'push') return o.push(...args);
      throw this.unsupported(`call ${k} on ${describe(o)}`, n, where);
    }
    const f = this.eval(callee, scope, where);
    const args = argNodes.map((a) => this.eval(a, scope, where));
    if (f instanceof Closure) return this.invoke(f.node, args, f.scope, f.where);
    // A host function handed in as an argument (the dialect check's item readers): only one
    // registered as a callback, and its result is checked like any native's.
    if (typeof f === 'function' && CALLBACKS.has(f)) return fromNative((f as Native)(...args));
    throw this.unsupported('call of a non-function', n, where);
  }
}

const hoistCache = new WeakMap<FunctionExpression, string[]>();

/** The names a function declares with `var` anywhere in its body (not in nested functions). */
function hoistedVars(fn: FunctionExpression): string[] {
  let out = hoistCache.get(fn);
  if (out) return out;
  const names: string[] = [];
  const walk = (n: AstNode): void => {
    if (n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration' || n.type === 'ArrowFunctionExpression') return;
    if (n.type === 'VariableDeclarator') {
      const id = n.id as AstNode;
      if (id.type === 'Identifier' && !names.includes(id.name as string)) names.push(id.name as string);
    }
    for (const c of childrenOf(n)) walk(c);
  };
  for (const st of fn.body.body) walk(st as unknown as AstNode);
  out = names;
  hoistCache.set(fn, out);
  return out;
}

type AstNode = AcornNode & Record<string, unknown>;
const isNode = (v: unknown): v is AstNode => isObject(v) && typeof v.type === 'string' && typeof v.start === 'number';

/** A node's child nodes, in source order. */
function childrenOf(n: AstNode): AstNode[] {
  const out: AstNode[] = [];
  for (const [k, v] of Object.entries(n)) {
    if (k === 'type') continue;
    if (Array.isArray(v)) for (const c of v) if (isNode(c)) out.push(c);
    if (isNode(v)) out.push(v);
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Whether an expression calls `<cls>.Ha(…)` (not counting nested functions). */
function callsReader(n: AstNode, cls: string): boolean {
  if (n.type === 'FunctionExpression') return false;
  if (n.type === 'CallExpression') {
    const c = n.callee as AstNode;
    const o = c.object as AstNode | undefined;
    const p = c.property as AstNode | undefined;
    if (c.type === 'MemberExpression' && o?.type === 'Identifier' && o.name === cls && p?.name === 'Ha') return true;
  }
  return childrenOf(n).some((c) => callsReader(c, cls));
}

/**
 * The `this`-free member assignments (`d.f = …`) of a reader whose value comes from `<cls>.Ha`,
 * directly or through a local (`e = a.Ua() ? Cls.Ha(a, d, b) : null; d.f = e`), in source order.
 */
function fieldAssignments(fn: FunctionExpression, cls: string): string[] {
  const holds = new Set<string>();
  const out: string[] = [];
  const assign = (target: AstNode, value: AstNode) => {
    const yes = callsReader(value, cls) || (value.type === 'Identifier' && holds.has(value.name as string));
    if (target.type === 'Identifier') {
      if (yes) holds.add(target.name as string);
      else holds.delete(target.name as string);
    } else if (target.type === 'MemberExpression' && !target.computed && yes) {
      out.push((target.property as AstNode).name as string);
    }
  };
  const walk = (n: AstNode): void => {
    if (n.type === 'FunctionExpression' && n !== (fn as unknown)) return;
    if (n.type === 'VariableDeclarator') {
      const init = n.init as AstNode | null;
      if (init) {
        walk(init);
        assign(n.id as AstNode, init);
      }
      return;
    }
    if (n.type === 'AssignmentExpression' && n.operator === '=') {
      walk(n.right as AstNode);
      assign(n.left as AstNode, n.right as AstNode);
      return;
    }
    for (const c of childrenOf(n)) walk(c);
  };
  walk(fn as unknown as AstNode);
  return out;
}

/** The statics of `cls` a function calls (`Cls.R(…)`), in source order. */
function ownStaticCalls(fn: FunctionExpression, cls: string): string[] {
  const out: string[] = [];
  const walk = (n: AstNode): void => {
    if (n.type === 'FunctionExpression' && n !== (fn as unknown)) return;
    if (n.type === 'CallExpression') {
      const c = n.callee as AstNode;
      const o = c.object as AstNode | undefined;
      const p = c.property as AstNode | undefined;
      if (c.type === 'MemberExpression' && !c.computed && o?.type === 'Identifier' && o.name === cls && p?.name) {
        if (!out.includes(p.name as string)) out.push(p.name as string);
      }
    }
    for (const c of childrenOf(n)) walk(c);
  };
  walk(fn as unknown as AstNode);
  return out;
}

/** A native's result, refused if it would hand a host function to the bundle. */
function fromNative(v: unknown): unknown {
  if (typeof v === 'function') throw new InterpError('forbidden', 'a host function cannot enter interpreted code');
  return v;
}

/**
 * Interpreted `o[k]`: an own property, or `length` / an index of an array, a string or a typed array
 * (the raw-bytes reader returns a Uint8Array, whose `length` is an inherited accessor). Every other
 * inherited member (methods, accessors, the prototype chain) reads as `undefined`.
 */
function readMember(o: unknown, k: string): unknown {
  let v: unknown;
  if (typeof o === 'string') v = k === 'length' || isIndex(k) ? o[k as never] : undefined;
  else if (o instanceof Uint8Array && k === 'length') v = o.length;
  else if (isObject(o) && Object.hasOwn(o, k)) v = o[k];
  else v = undefined;
  return fromNative(v);
}

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return 'an array';
  if (isObject(v) && typeof v.$type === 'string') return `a ${v.$type}`;
  return typeof v;
}

/**
 * The string literals of an expression in source order, until they add up to more than `maxChars`
 * characters, and the number of nodes walked. Iterative: a deeply nested argument cannot overflow the stack.
 */
function stringLiterals(node: AcornNode, maxChars: number): { literals: string[]; nodes: number } {
  const literals: string[] = [];
  let chars = 0;
  let nodes = 0;
  const stack: unknown[] = [node];
  while (stack.length && chars <= maxChars) {
    const v = stack.pop();
    if (Array.isArray(v)) {
      for (let i = v.length - 1; i >= 0; i--) stack.push(v[i]);
      continue;
    }
    if (!isObject(v) || typeof v.type !== 'string') continue;
    nodes++;
    if (v.type === 'Literal' && typeof v.value === 'string') {
      literals.push(v.value);
      chars += v.value.length + 1;
    }
    const children = Object.entries(v).filter(([k]) => k !== 'type');
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i][1]);
  }
  return { literals, nodes };
}
