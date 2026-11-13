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
// Classes are registered in the bundle as `W["warlight.shared.Foo"]=Xy;` — the type name
// is stable, the var is minified. Decoded objects carry the type name as `$type`.

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
  | 'parse';

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

const asReader = (x: unknown) => x as Reader;
const asFn = (x: unknown) => x as () => unknown;

function list(r: unknown, item: unknown): unknown[] | null {
  return asReader(r).list(() => asFn(item)());
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
    JS: (r, n) => r.raw(n as number),
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
      ef: (r, k, v) => asReader(r).list(() => [asFn(k)(), asFn(v)()]),
    },
    O: { fA: (x) => x, Fy: (x) => x, rc: (x) => x },
    za: { rc: (x) => x },
    // Enumerable helpers (special-unit lists): Range → Select → ToArray.
    E: {
      Range: (start, count) => Array.from({ length: count as number }, (_, i) => (start as number) + i),
      Za: (xs, f) => (xs as unknown[]).map((x) => (f as Native)(x)),
      Sa: (xs) => [...(xs as unknown[])],
    },
  },
  wrappers: ['Z', 'Yb', 'uc', 'dc', 'oc', 'ec', 'fc'],
};

export interface InterpOptions {
  /** The protocol version handed to every `Ha` (default {@link PROTOCOL_VERSION}). */
  version?: number;
  /** Called with `Var.fn` for every bundle function evaluated. */
  trace?: (fn: string) => void;
  /** Overrides merged over {@link DEFAULT_DIALECT}. */
  dialect?: Partial<Dialect>;
  /** Iteration cap for a single `for` loop (default 1e6). */
  maxIterations?: number;
}

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

class Scope {
  private readonly vars = new Map<string, unknown>();
  constructor(private readonly parent: Scope | null = null) {}

  has(name: string): boolean {
    return this.vars.has(name) || (this.parent?.has(name) ?? false);
  }

  get(name: string): unknown {
    if (this.vars.has(name)) return this.vars.get(name);
    return this.parent?.get(name);
  }

  declare(name: string, value: unknown): void {
    this.vars.set(name, value);
  }

  /** Assign to the nearest scope that declares `name` (else this one). */
  assign(name: string, value: unknown): void {
    let s: Scope | null = this;
    while (s && !s.vars.has(name)) s = s.parent;
    (s ?? this).vars.set(name, value);
  }
}

type Completion = undefined | { type: 'return'; value: unknown } | { type: 'break' };

interface ResolvedFn {
  node: FunctionExpression;
  where: string;
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

const escapeRe = (s: string) => s.replace(/[$]/g, '\\$');

/** Evaluates a bundle's reader functions against codec readers. */
export class BundleInterpreter {
  readonly version: number;
  private readonly dialect: Dialect;
  private readonly wrappers: Set<string>;
  private readonly fnCache = new Map<string, ResolvedFn | null>();
  private readonly maxIterations: number;

  constructor(
    readonly bundle: ParsedBundle,
    private readonly opts: InterpOptions = {},
  ) {
    this.version = opts.version ?? PROTOCOL_VERSION;
    this.maxIterations = opts.maxIterations ?? 1e6;
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

  /** Read one instance of a class (`<Var>.Ha(reader, null, version)`). */
  readClass(typeNameOrVar: string, reader: Reader): unknown {
    return this.callStatic(this.resolveVar(typeNameOrVar), 'Ha', [reader, null, this.version]);
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
    visit('Ha', 0);
    return out;
  }

  // -------------------------------------------------------------------------
  // Resolution

  private parseFunctionAt(pos: number, where: string): FunctionExpression {
    let node: AnyNode;
    try {
      node = parseExpressionAt(this.bundle.src, pos, { ecmaVersion: 'latest' }) as AnyNode;
    } catch (e) {
      throw new InterpError('parse', `cannot parse function: ${(e as Error).message}`, where, pos);
    }
    const fn = leadingFunction(node);
    if (!fn || fn.start !== pos) throw new InterpError('parse', 'no function expression', where, pos);
    return fn;
  }

  private resolveStatic(cls: string, fn: string): ResolvedFn {
    const where = `${cls}.${fn}`;
    const cached = this.fnCache.get(where);
    if (cached) return cached;
    const { src } = this.bundle;
    // Prefer the definition that follows the class's registration.
    const typeName = this.bundle.typeNameOf.get(cls);
    const from = typeName ? Math.max(0, src.indexOf(`W["${typeName}"]=${cls};`)) : 0;
    const re = new RegExp(`(?<![\\w$.])${escapeRe(cls)}\\.${escapeRe(fn)}\\s*=\\s*function\\b`, 'g');
    re.lastIndex = from;
    let m = re.exec(src);
    if (!m && from > 0) {
      re.lastIndex = 0;
      m = re.exec(src);
    }
    if (!m) throw new InterpError('no-definition', `no definition for ${where}`);
    const resolved = { node: this.parseFunctionAt(m.index + m[0].length - 'function'.length, where), where };
    this.fnCache.set(where, resolved);
    return resolved;
  }

  private resolveCtor(cls: string): ResolvedFn | null {
    const key = `new ${cls}`;
    if (this.fnCache.has(key)) return this.fnCache.get(key) ?? null;
    const m = new RegExp(`function ${escapeRe(cls)}\\(`).exec(this.bundle.src);
    const resolved = m ? { node: this.parseFunctionAt(m.index, key), where: key } : null;
    this.fnCache.set(key, resolved);
    return resolved;
  }

  // -------------------------------------------------------------------------
  // Calls

  private callStatic(cls: string, fn: string, args: unknown[]): unknown {
    const native = this.dialect.statics[cls]?.[fn];
    if (native) return native(...args.map((a) => this.toNative(a)));
    const { node, where } = this.resolveStatic(cls, fn);
    this.opts.trace?.(where);
    return this.invoke(node, args, new Scope(), where);
  }

  private toNative(v: unknown): unknown {
    if (v instanceof Closure) return (...args: unknown[]) => this.invoke(v.node, args, v.scope, v.where);
    return v;
  }

  private invoke(node: FunctionExpression, args: unknown[], outer: Scope, where: string, self?: unknown): unknown {
    const scope = new Scope(outer);
    if (self !== undefined) scope.declare('this', self);
    node.params.forEach((p, i) => scope.declare(this.paramName(p, where), args[i]));
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
    switch (st.type) {
      case 'VariableDeclaration':
        for (const d of st.declarations) {
          scope.declare(this.paramName(d.id, where), d.init ? this.eval(d.init, scope, where) : undefined);
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
        let i = st.cases.findIndex((c) => c.test && this.eval(c.test, scope, where) == v);
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
        // its string literals are the message.
        throw new InterpError('reader-threw', `reader threw: ${stringLiterals(st.argument).join(' ') || '(no message)'}`, where, st.start);
      default:
        throw this.unsupported(`statement ${st.type}`, st, where);
    }
  }

  // -------------------------------------------------------------------------
  // Expressions

  private eval(n: Expression, scope: Scope, where: string): unknown {
    switch (n.type) {
      case 'Literal':
        return n.value;
      case 'Identifier':
        if (scope.has(n.name)) return scope.get(n.name);
        if (n.name === 'undefined') return undefined;
        return new ClassRef(n.name);
      case 'ThisExpression':
        return scope.get('this');
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
        if (n.operator === '-') return -(v as number);
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
          scope.assign(t.name, v);
          return v;
        }
        if (t.type === 'MemberExpression') {
          const o = this.eval(t.object as Expression, scope, where);
          const k = this.memberKey(t, scope, where);
          if (!isObject(o) || o instanceof ClassRef) throw new InterpError('bad-value', `cannot set ${k} on ${describe(o)}`, where, t.start);
          o[k] = v;
          return v;
        }
        throw this.unsupported(`assignment target ${t.type}`, t, where);
      }
      case 'UpdateExpression': {
        if (n.argument.type !== 'Identifier') throw this.unsupported(`update of ${n.argument.type}`, n, where);
        const name = n.argument.name;
        const old = scope.get(name) as number;
        const next = n.operator === '++' ? old + 1 : old - 1;
        scope.assign(name, next);
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
        return (o as Record<string, unknown>)[k];
      }
      case 'CallExpression':
        return this.call(n.callee as Expression, n.arguments as Expression[], scope, where, n);
      default:
        throw this.unsupported(`expression ${n.type}`, n, where);
    }
  }

  private memberKey(n: { computed: boolean; property: Expression | { type: 'PrivateIdentifier' } }, scope: Scope, where: string): string {
    const p = n.property;
    if (n.computed) return String(this.eval(p as Expression, scope, where));
    return (p as { name: string }).name;
  }

  private binary(op: string, left: Expression, right: Expression, scope: Scope, where: string, n: AcornNode): unknown {
    const l = this.eval(left, scope, where) as never;
    const r = this.eval(right, scope, where) as never;
    switch (op) {
      case '==':
        return l == r;
      case '!=':
        return l != r;
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
      case '+':
        return (l as number) + (r as number);
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
        const f = this.dialect.readerMethods[k];
        if (!f) throw this.unsupported(`reader method ${k}`, n, where);
        return f(o, ...args);
      }
      if (o instanceof ClassRef) return this.callStatic(o.name, k, args);
      if (Array.isArray(o) && k === 'push') return o.push(...args);
      throw this.unsupported(`call ${k} on ${describe(o)}`, n, where);
    }
    const f = this.eval(callee, scope, where);
    const args = argNodes.map((a) => this.eval(a, scope, where));
    if (f instanceof Closure) return this.invoke(f.node, args, f.scope, f.where);
    throw this.unsupported('call of a non-function', n, where);
  }
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

function describe(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (Array.isArray(v)) return 'an array';
  if (isObject(v) && typeof v.$type === 'string') return `a ${v.$type}`;
  return typeof v;
}

/** Every string literal in an expression, in source order. */
function stringLiterals(node: AcornNode): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!isObject(v) || typeof v.type !== 'string') return;
    if (v.type === 'Literal' && typeof v.value === 'string') out.push(v.value);
    for (const [k, child] of Object.entries(v)) if (k !== 'type') visit(child);
  };
  visit(node);
  return out;
}
