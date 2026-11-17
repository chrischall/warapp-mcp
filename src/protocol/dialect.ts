// Deriving the reader dialect from the client bundle itself.
//
// Every war.app client build re-minifies the code, hotfix builds included (docs/CLIENT-RELEASES.md),
// so the names the bundle's readers call — the BinaryReader's methods (`a.Tg()`), the Serializer's
// helpers (`P.Ya(a)`), the Enumerable helpers, the nullable wrapper classes — change with every
// build while what they do does not. Rather than pin one build's names, this module finds them by
// structure:
//
// - the wrapper and helper CLASSES by their registered type names (`W["warlight.shared.Serializer"]=P`),
//   which the minifier keeps;
// - the haxe.io.Input methods by what they do (readByte throws its own name; readInt32 reads four
//   bytes and shifts by 24; readInt16 sign-extends at 32768; …);
// - the BinaryReader methods by the Input method they call (or the varint/raw/string shapes);
// - the static helpers by their canonical form: the function's tokens with every name renamed to
//   its order of first appearance, except reader-method names (replaced by their role) and class
//   vars (replaced by their registered type name). Two builds' helpers that do the same thing have
//   the same canonical form, whatever the minifier called them.
//
// Nothing here runs bundle code: it reads source text. The result is only names → roles; the
// interpreter attaches its built-in natives to them and `verifyDialect` still probes the bundle's
// own definitions against those natives, so a wrong derivation is refused at load, never decoded
// through. A bundle this module cannot read in full gets `null`, and the interpreter falls back to
// its built-in (v6.07) names.
import { parseExpressionAt } from 'acorn';

/** What a BinaryReader method reads. */
export type ReaderRole = 'bool' | 'int32' | 'u8' | 'string' | 'float64' | 'float32' | 'uint16' | 'int16' | 'raw' | 'varint';

/** What a static helper does (the interpreter's built-in for it). */
export type StaticRole =
  | 'int32'
  | 'string'
  | 'bool'
  | 'u8'
  | 'float32'
  | 'float64'
  | 'timespan'
  | 'date'
  | 'guid'
  | 'uint16'
  | 'bytes'
  | 'list'
  | 'dict'
  | 'identity'
  | 'range'
  | 'select'
  | 'toArray';

/** The names a bundle's readers call, by role. */
export interface DerivedDialect {
  /** BinaryReader method name → role. */
  readerMethods: Record<string, ReaderRole>;
  /** Class var → static name → role. */
  statics: Record<string, Record<string, StaticRole>>;
  /** The nullable/value wrapper class vars (`new Z(v)` is `v`). */
  wrappers: string[];
  /** The Serializer class var (the reader helpers `verifyDialect` checks). */
  serializer: string;
  /** The protocol version the bundle's readers default to (`null==d&&(d=243)`), when one is clear. */
  protocol: number | undefined;
}

/** Registered type names of the classes the dialect lives on. */
const INPUT_TYPE = 'haxe.io.Input';
const READER_TYPE = 'system.io.BinaryReader';
const SERIALIZER_TYPE = 'warlight.shared.Serializer';
const UTILITY_TYPE = 'warlight.shared.SharedUtility';
const PUMP_TYPE = 'warlight.shared.MessagePump';
const ENUMERABLE_TYPE = 'system.linq.Enumerable';

/** The wrapper classes `new X(v)` reads as `v` (v6.07: Z, Yb, uc, dc, oc, ec, fc). */
export const WRAPPER_TYPES: readonly string[] = [
  'system.Nullable_Int',
  'system.Nullable',
  'system.Nullable_Float',
  'system.Nullable_Bool',
  'system.CsRef',
  'system.TimeSpan',
  'system.DateTime',
];

/** The longest function source this module canonicalizes (the helpers are a few hundred characters). */
const MAX_FN_SOURCE = 4000;

/** The reader roles a derivation must find, or it is not used. */
const REQUIRED_READER_ROLES: readonly ReaderRole[] = ['bool', 'int32', 'u8', 'string', 'float64', 'float32', 'uint16', 'raw', 'varint'];

/** The Serializer roles a derivation must find (every one the v6.07 dialect had). */
const REQUIRED_STATIC_ROLES: readonly StaticRole[] = [
  'int32',
  'string',
  'bool',
  'u8',
  'float32',
  'float64',
  'timespan',
  'date',
  'guid',
  'uint16',
  'bytes',
  'list',
  'dict',
];

const KEYWORDS = new Set(
  'var let const function return if else for while do break continue new null true false this typeof instanceof in of throw try catch finally switch case default void delete'.split(' '),
);

const TOKEN =
  /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][\w$]*|\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|>>>=?|===|!==|<<=|>>=|[=!<>]=|&&|\|\||\+\+|--|<<|>>|[-+*/%&|^]=|\S/g;

/**
 * A function's canonical form: its tokens, with keywords, literals and punctuation kept, a member
 * name that is a known reader method replaced by `@<role>`, an identifier that is a registered class
 * var replaced by `@T:<type name>`, and every other name by `#<n>`, its order of first appearance.
 */
export function canonicalize(
  src: string,
  roleOf: (name: string) => string | undefined,
  typeOf: (name: string) => string | undefined,
): string {
  const names = new Map<string, string>();
  const out: string[] = [];
  let prev = '';
  for (const t of src.match(TOKEN) ?? []) {
    const c = t[0]!;
    const isName = /[A-Za-z_$]/.test(c);
    if (!isName || KEYWORDS.has(t)) out.push(t);
    else if (prev === '.' && roleOf(t) !== undefined) out.push(`@${roleOf(t)}`);
    else if (prev !== '.' && typeOf(t) !== undefined) out.push(`@T:${typeOf(t)}`);
    else {
      let n = names.get(t);
      if (n === undefined) {
        n = `#${names.size}`;
        names.set(t, n);
      }
      out.push(n);
    }
    prev = t;
  }
  return out.join(' ');
}

/**
 * The Serializer helpers of client v6.07.0.1 in canonical form (generated from that bundle with this
 * module's own reader roles), by role. 6.08.0.1 and 6.08.0.2 give the same forms.
 */
export const SERIALIZER_TEMPLATES: Readonly<Record<string, StaticRole>> = {
  'function ( #0 ) { return #0 . @int32 ( ) }': 'int32',
  'function ( #0 ) { return #0 . @bool ( ) ? #0 . @string ( ) : null }': 'string',
  'function ( #0 ) { return #0 . @bool ( ) }': 'bool',
  'function ( #0 ) { return #0 . @u8 ( ) }': 'u8',
  'function ( #0 ) { return #0 . @float32 ( ) }': 'float32',
  'function ( #0 ) { return #0 . @float64 ( ) }': 'float64',
  'function ( #0 ) { return #0 . @uint16 ( ) }': 'uint16',
  'function ( #0 ) { #0 = #0 . @float64 ( ) ; return - 922336666814565 >= #0 ? @T:system.TimeSpan . #1 : 922336666814565 <= #0 ? @T:system.TimeSpan . #2 : new @T:system.TimeSpan ( #0 ) }':
    'timespan',
  'function ( #0 ) { var #1 = #0 . @int32 ( ) ; return - 1 == #1 ? null : #0 . @raw ( #1 ) }': 'bytes',
  'function ( #0 , #1 ) { #0 = #0 . @int32 ( ) ; if ( - 1 == #0 ) return null ; for ( var #2 = [ ] , #3 = 0 ; #3 < #0 ; ) #2 . #4 ( #1 ( ) ) , ++ #3 ; return #2 }':
    'list',
  'function ( #0 , #1 ) { #0 = #0 . @int32 ( ) ; if ( - 1 == #0 ) return null ; for ( var #2 = [ ] , #3 = 0 ; #3 < #0 ; ) #2 [ #3 ] = #1 ( ) , ++ #3 ; return #2 }':
    'list',
  'function ( #0 , #1 , #2 ) { #0 = #0 . @int32 ( ) ; if ( - 1 == #0 ) return null ; for ( var #3 = new @T:system.collections.generic.Dictionary ( #0 ) , #4 = 0 ; #4 < #0 ; ) { var #5 = #1 ( ) ; @T:warlight.shared.Assert . #6 ( ! #3 . #7 ( #5 ) , "Dupe keys deserialized" ) ; #3 . #8 ( #5 , #2 ( ) ) ; ++ #4 } return #3 }':
    'dict',
};

/** The date and guid helpers call a SharedUtility reader: matched by that helper's shape (see `utilityRole`). */
const UTILITY_CALL = 'function ( #0 ) { return @T:warlight.shared.SharedUtility . #1 ( #0 ) }';

/** v6.07's `P.uL`: a list into a client collection class (`new Je`), whose type name varies. */
const COLLECTION_LIST =
  /^function \( #0 , #1 \) \{ #0 = #0 \. @int32 \( \) ; if \( - 1 == #0 \) return null ; for \( var #2 = new (?:#\d+|@T:[\w.$]+) , #3 = 0 ; #3 < #0 ; \) #2 \. #\d+ \( #1 \( \) \) , \+\+ #3 ; return #2 \}$/;

/** SharedUtility's ParseLongSafe and TryGetValue-or-default (`O.fA`, `O.Fy`): identity in the built-in dialect. */
const UTILITY_IDENTITY_MARK = '"ParseLongSafe(null)"';
const UTILITY_TRY_GET = /^function \( #0 , #1 , #2 \) \{ var #3 = new @T:system\.CsRef \( null \) ; return #0 \. #4 \( #1 , #3 \) \? #3 \. #5 : #2 \}$/;

/** MessagePump's identity (`za.rc`). */
const IDENTITY = 'function ( #0 ) { return #0 }';

/** Enumerable's Select and ToArray (`E.Za`, `E.Sa`). */
const SELECT = 'function ( #0 , #1 ) { for ( var #2 = [ ] , #3 = 0 ; #3 < #0 . #4 ; ) { var #5 = #0 [ #3 ] ; ++ #3 ; #2 . #6 ( #1 ( #5 ) ) } return #2 }';
const TO_ARRAY = 'function ( #0 ) { for ( var #1 = [ ] , #2 = 0 ; #2 < #0 . #3 ; ) { var #4 = #0 [ #2 ] ; ++ #2 ; #1 . #5 ( #4 ) } return #1 }';

/** A bundle's registrations, as `parseBundle` indexes them. */
interface Registered {
  src: string;
  typeNameOf: Map<string, string>;
  varOf: Map<string, string>;
}

/** The source of the function expression starting at `at`, or undefined when it does not parse or is too long. */
function functionAt(src: string, at: number): string | undefined {
  try {
    const end = Math.min(src.length, at + MAX_FN_SOURCE);
    const node = parseExpressionAt(src.slice(0, end), at, { ecmaVersion: 'latest' }) as { type: string; end: number };
    if (node.type !== 'FunctionExpression') return undefined;
    return src.slice(at, node.end);
  } catch {
    return undefined;
  }
}

const esc = (s: string) => s.replace(/\$/g, '\\$');

/** `cls.name=function…` statics of a class: name → source (the first definition of each name). */
function staticsOf(src: string, cls: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(new RegExp(`(?<![\\w$.])${esc(cls)}\\.([\\w$]+)\\s*=\\s*(?=function\\b)`, 'g'))) {
    if (out.has(m[1]!)) continue;
    const fn = functionAt(src, m.index + m[0].length);
    if (fn) out.set(m[1]!, fn);
  }
  return out;
}

/**
 * The function-valued properties of `cls.prototype={…}` (or `cls.prototype=Fa(base.prototype,{…})`),
 * name → source. Only the first prototype assignment of the class is read.
 */
function prototypeOf(src: string, cls: string): Map<string, string> {
  const out = new Map<string, string>();
  const m = new RegExp(`(?<![\\w$.])${esc(cls)}\\.prototype\\s*=\\s*`).exec(src);
  if (!m) return out;
  let at = m.index + m[0].length;
  if (src[at] !== '{') {
    // `Fa(base.prototype,{` — the object literal is the second argument.
    const brace = src.indexOf('{', at);
    if (brace < 0 || brace - at > 200) return out;
    at = brace;
  }
  let obj: { type: string; properties?: Array<{ type: string; key: { type: string; name?: string }; value: { type: string; start: number; end: number } }> };
  try {
    obj = parseExpressionAt(src, at, { ecmaVersion: 'latest' }) as typeof obj;
  } catch {
    return out;
  }
  if (obj.type !== 'ObjectExpression') return out;
  for (const p of obj.properties ?? []) {
    if (p.type !== 'Property' || p.key.type !== 'Identifier' || !p.key.name) continue;
    if (p.value.type !== 'FunctionExpression' || p.value.end - p.value.start > MAX_FN_SOURCE) continue;
    out.set(p.key.name, src.slice(p.value.start, p.value.end));
  }
  return out;
}

type InputRole = 'readByte' | 'readInt32' | 'readInt16' | 'readUInt16' | 'readFloat' | 'readDouble';

/** Classify haxe.io.Input's methods by what they do. */
function inputRoles(methods: Map<string, string>): Map<string, InputRole> {
  const roles = new Map<string, InputRole>();
  let readByte: string | undefined;
  for (const [name, fn] of methods) {
    if (/methodName\s*:\s*"readByte"/.test(fn)) readByte = name;
  }
  if (!readByte) return roles;
  roles.set(readByte, 'readByte');
  const calls = (fn: string, name: string) => fn.split(`this.${name}(`).length - 1;
  let readInt32: string | undefined;
  for (const [name, fn] of methods) {
    if (name === readByte) continue;
    const bytes = calls(fn, readByte);
    if (bytes === 4 && fn.includes('<<24')) {
      readInt32 = name;
      roles.set(name, 'readInt32');
    } else if (bytes === 2 && fn.includes('32768')) roles.set(name, 'readInt16');
    else if (bytes === 2) roles.set(name, 'readUInt16');
  }
  if (readInt32) {
    for (const [name, fn] of methods) {
      if (roles.has(name)) continue;
      const ints = calls(fn, readInt32);
      if (ints === 2) roles.set(name, 'readDouble');
      else if (ints === 1) roles.set(name, 'readFloat');
    }
  }
  return roles;
}

const FROM_INPUT: Record<InputRole, ReaderRole> = {
  readByte: 'u8',
  readInt32: 'int32',
  readInt16: 'int16',
  readUInt16: 'uint16',
  readFloat: 'float32',
  readDouble: 'float64',
};

/** Classify the BinaryReader's methods by the Input method they call, or their own shape. */
function readerRoles(methods: Map<string, string>, input: Map<string, InputRole>): Map<string, ReaderRole> {
  const roles = new Map<string, ReaderRole>();
  for (const [name, fn] of methods) {
    if (fn.includes('"Bad format"') && /&127\)<</.test(fn)) roles.set(name, 'varint');
    else if (/new [\w$]+\(new ArrayBuffer\(/.test(fn)) roles.set(name, 'raw');
    else if (fn.includes('4294967296')) continue; // the int64 read: no built-in
    else {
      const bool = /return\s*0\s*!=\s*this\.[\w$]+\.([\w$]+)\(\)/.exec(fn);
      if (bool && input.get(bool[1]!) === 'readByte') {
        roles.set(name, 'bool');
        continue;
      }
      const direct = /return\s+this\.[\w$]+\.([\w$]+)\(\)/.exec(fn);
      const r = direct ? input.get(direct[1]!) : undefined;
      if (r) roles.set(name, FROM_INPUT[r]);
    }
  }
  // Self calls (`bc:function(){try{return this.JIb()}…}`) and the string read (varint then raw).
  for (let pass = 0; pass < 3; pass++) {
    for (const [name, fn] of methods) {
      if (roles.has(name)) continue;
      const own = [...fn.matchAll(/this\.([\w$]+)\(/g)].map((m) => m[1]!).filter((n) => methods.has(n));
      const ownRoles = own.map((n) => roles.get(n));
      if (ownRoles.includes('varint') && ownRoles.includes('raw')) roles.set(name, 'string');
      else if (own.length === 1 && ownRoles[0] && /^function\(\)\{try\{return this\.[\w$]+\(\)\}/.test(fn)) roles.set(name, ownRoles[0]);
    }
  }
  return roles;
}

/** The protocol version most of the bundle's readers default to (`null==d&&(d=243)`). */
export function bundleProtocol(src: string): number | undefined {
  const counts = new Map<number, number>();
  for (const m of src.matchAll(/null==([a-z])&&\(\1=(\d{3})\)/g)) {
    const v = Number(m[2]);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  let best: number | undefined;
  let n = 0;
  for (const [v, c] of counts) {
    if (c > n) {
      best = v;
      n = c;
    }
  }
  return n >= 3 ? best : undefined;
}

/**
 * Derive the dialect from a bundle, or `null` when any required class or role cannot be found (the
 * interpreter then uses its built-in names).
 */
export function deriveDialect(bundle: Registered): DerivedDialect | null {
  const { src, typeNameOf, varOf } = bundle;
  const inputVar = varOf.get(INPUT_TYPE);
  const readerVar = varOf.get(READER_TYPE);
  const serializer = varOf.get(SERIALIZER_TYPE);
  if (!inputVar || !readerVar || !serializer) return null;

  const input = inputRoles(prototypeOf(src, inputVar));
  const reader = readerRoles(prototypeOf(src, readerVar), input);
  const readerMethods: Record<string, ReaderRole> = {};
  for (const [n, r] of reader) readerMethods[n] = r;
  const found = new Set(reader.values());
  if (!REQUIRED_READER_ROLES.every((r) => found.has(r))) return null;

  const roleOf = (n: string) => reader.get(n);
  const typeOf = (n: string) => typeNameOf.get(n);
  const canon = (fn: string) => canonicalize(fn, roleOf, typeOf);

  const statics: Record<string, Record<string, StaticRole>> = {};
  const put = (cls: string, name: string, role: StaticRole) => {
    (statics[cls] ??= {})[name] = role;
  };

  // The SharedUtility date and guid readers (P.Td → O.N3c, P.tL → O.Q3c): told apart by what they read.
  const utility = varOf.get(UTILITY_TYPE);
  const utilityStatics = utility ? staticsOf(src, utility) : new Map<string, string>();
  const utilityRole = (name: string): StaticRole | undefined => {
    const fn = utilityStatics.get(name);
    if (!fn) return undefined;
    // A guid is 16 raw bytes; a date is one float64.
    if (/@raw \( 16 \)/.test(canon(fn)) || /\(16\)/.test(fn)) return 'guid';
    if (canon(fn).includes('@float64')) return 'date';
    return undefined;
  };

  for (const [name, fn] of staticsOf(src, serializer)) {
    const c = canon(fn);
    const role = SERIALIZER_TEMPLATES[c];
    if (role) put(serializer, name, role);
    else if (COLLECTION_LIST.test(c)) put(serializer, name, 'list');
    else if (c === UTILITY_CALL) {
      const callee = /return [\w$]+\.([\w$]+)\(/.exec(fn)?.[1];
      const r = callee ? utilityRole(callee) : undefined;
      if (r) put(serializer, name, r);
    }
  }
  const roles = new Set(Object.values(statics[serializer] ?? {}));
  if (!REQUIRED_STATIC_ROLES.every((r) => roles.has(r))) return null;

  if (utility) {
    for (const [name, fn] of utilityStatics) {
      if (fn.includes(UTILITY_IDENTITY_MARK) || UTILITY_TRY_GET.test(canon(fn))) put(utility, name, 'identity');
    }
  }
  const pump = varOf.get(PUMP_TYPE);
  if (pump) {
    for (const [name, fn] of staticsOf(src, pump)) if (canon(fn) === IDENTITY) put(pump, name, 'identity');
  }
  const enumerable = varOf.get(ENUMERABLE_TYPE);
  if (enumerable) {
    for (const [name, fn] of staticsOf(src, enumerable)) {
      if (name === 'Range') put(enumerable, name, 'range');
      else {
        const c = canon(fn);
        if (c === SELECT) put(enumerable, name, 'select');
        else if (c === TO_ARRAY) put(enumerable, name, 'toArray');
      }
    }
  }
  const wrappers = WRAPPER_TYPES.map((t) => varOf.get(t)).filter((v): v is string => v !== undefined);
  return { readerMethods, statics, wrappers, serializer, protocol: bundleProtocol(src) };
}
