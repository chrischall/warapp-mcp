import { describe, expect, it } from 'vitest';
import { DATE_EPOCH_MS, NO_DATE_SENTINEL, Reader, Writer } from '../../src/protocol/codec.js';
import {
  BundleInterpreter,
  DEFAULT_DIALECT,
  DEFAULT_MAX_MILLIS,
  DEFAULT_MAX_STEPS,
  InterpError,
  MAX_NESTING,
  MAX_THROW_MESSAGE,
  parseBundle,
  type ReadBudget,
} from '../../src/protocol/interp.js';
import { MINI_BUNDLE } from './mini-bundle.js';

const GUID = '00112233445566778899aabbccddeeff';
const WHEN = new Date(DATE_EPOCH_MS + 86_400_000);

function boardBytes(version: number): Uint8Array {
  const w = new Writer();
  w.string('Alpha');
  w.bool(true).int32(1).int32(2); // origin
  w.bool(true).int32(2).bool(true).int32(3).int32(4).bool(false); // points: [Pt(3,4), null]
  w.bool(true).int32(1).int32(7).string('neutral'); // owners
  w.bool(true).int32(5); // army: fogged, 5
  if (version >= 240) w.int32(99); // extra
  w.u8(3); // kind
  w.u8(2).int32(6); // shape: square side 6
  w.int32(2).int32(10).int32(11); // ids
  w.date(WHEN);
  w.guid(GUID);
  w.float64(0.6); // P.ak reads a float64 (kill rates, luck)
  w.uint16(65535);
  w.int32(2).raw(new Uint8Array([0xab, 0xcd]));
  w.bool(true);
  return w.bytes();
}

const interp = (opts?: ConstructorParameters<typeof BundleInterpreter>[1]) =>
  new BundleInterpreter(parseBundle(MINI_BUNDLE), opts);

function interpError(fn: () => unknown): InterpError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InterpError);
    return e as InterpError;
  }
  throw new Error('expected an InterpError');
}

describe('parseBundle', () => {
  it('indexes class registrations both ways', () => {
    const b = parseBundle(MINI_BUNDLE);
    expect(b.typeNameOf.get('Bd')).toBe('demo.shared.Board');
    expect(b.varOf.get('warlight.shared.LatestGameInfo')).toBe('NE');
  });

  it('keeps the first registration of a var', () => {
    const b = parseBundle('W["a.First"]=X;W["a.Second"]=X;');
    expect(b.typeNameOf.get('X')).toBe('a.First');
  });
});

describe('BundleInterpreter', () => {
  it('reads every construct of a nested class and consumes every byte', () => {
    const r = new Reader(boardBytes(242));
    const calls: string[] = [];
    const v = interp({ trace: (k) => calls.push(k) }).readClass('demo.shared.Board', r);
    expect(r.remaining).toBe(0);
    expect(v).toEqual({
      $type: 'demo.shared.Board',
      name: 'Alpha',
      origin: { $type: 'demo.shared.Point', x: 1, y: 2 },
      points: [{ $type: 'demo.shared.Point', x: 3, y: 4 }, null],
      owners: [[7, 'neutral']],
      army: { $type: 'demo.shared.Army', n: 5, fog: true, tag: '{}' },
      extra: 99,
      kind: 3,
      shape: { $type: 'demo.shared.Square', side: 6 },
      round: false,
      square: true,
      ids: [10, 11],
      when: WHEN,
      id: GUID,
      big: 0.6,
      u16: 65535,
      blob: new Uint8Array([0xab, 0xcd]),
      flag: true,
    });
    expect(calls).toContain('Bd.rd');
    expect(calls).toContain('Pt.rd');
  });

  it('honours version checks', () => {
    const r = new Reader(boardBytes(200));
    const v = interp({ version: 200 }).readClass('demo.shared.Board', r) as Record<string, unknown>;
    expect(v.extra).toBeNull();
    expect(r.remaining).toBe(0);
  });

  it('accepts a var name and passes the protocol version', () => {
    const r = new Reader(new Writer().int32(4).bytes());
    expect(interp().readClass('NE', r)).toEqual({ $type: 'warlight.shared.LatestGameInfo', turn: 4, ver: 242 });
  });

  it('switches on a type tag with fall-through, break and instanceof', () => {
    const i = interp();
    const circle = i.readClass('demo.shared.Shape', new Reader(new Writer().u8(1).float32(1.5).bytes()));
    expect(circle).toEqual({ $type: 'demo.shared.Circle', r: 1.5 });
    const sq = i.readClass('demo.shared.Shape', new Reader(new Writer().u8(3).bytes()));
    expect(sq).toEqual({ $type: 'demo.shared.Square', side: -1 });
    const e = interpError(() => i.readClass('demo.shared.Shape', new Reader(new Writer().u8(9).bytes())));
    expect(e.kind).toBe('reader-threw');
    expect(e.message).toContain('unknown shape tag');
    expect(e.where).toBe('Sh.Ha');
  });

  it('evaluates operators, closures, wrappers and reader methods', () => {
    const w = new Writer().int32(3);
    w.u8(1).u8(2).u8(3); // E.Range mapped
    w.int32(-7).u8(200);
    w.varint(2).raw(new TextEncoder().encode('hi'));
    w.float64(42.5).float32(0.5).uint16(7).int16(-2).u8(9).raw(new Uint8Array([1, 2])).varint(300);
    w.float64(259_200_000).int32(1).int32(8).int32(-1).int32(-1).float64(NO_DATE_SENTINEL);
    const r = new Reader(w.bytes());
    const d = interp().readClass('demo.shared.Ops', r) as Record<string, unknown>;
    expect(r.remaining).toBe(0);
    expect(d).toMatchObject({
      sum: 5, diff: 1, prod: 6, bor: 3, band: 1, neg: -3, not: false, v: undefined, u: undefined,
      eq: true, ne: false, seq: true, sne: false, lt: false, le: true, gt: false, ge: true,
      or: 3, and: 7, andf: 0, seqv: 9, dbl: 6, pre: 4, post: 4, after: 3, w: 5, wn: null, arr: [],
      r: [1, 3, 5],
      raw: [-7, 200, 'hi', 42.5, 0.5, 7, -2, 9, new Uint8Array([1, 2]), 300],
      more: [259_200_000, [8], null, null, null],
      len: 10, id: 4, branch: 'else',
    });
  });

  it('keeps a constructor failure on the object instead of aborting the read', () => {
    const v = interp().readClass('demo.shared.BadCtor', new Reader(new Uint8Array())) as Record<string, unknown>;
    expect(v.$type).toBe('demo.shared.BadCtor');
    expect(String(v.$ctorError)).toContain('deeper of undefined in new Bk');
  });

  it('rejects an unknown type name', () => {
    const e = interpError(() => interp().readClass('demo.shared.Nope', new Reader(new Uint8Array())));
    expect(e.kind).toBe('unknown-class');
  });

  it.each([
    ['demo.shared.Loop', 'unsupported', 'WhileStatement', 'while'],
    ['demo.shared.BadMethod', 'unsupported', 'reader method Zq', 'a.Zq()'],
    ['demo.shared.NullMember', 'bad-value', 'x of null', 'b.x'],
    ['demo.shared.ObjLit', 'unsupported', 'ObjectExpression', '{}'],
    ['demo.shared.ReaderRef', 'unsupported', 'reader member Ua', 'a.Ua'],
    ['demo.shared.CallNum', 'unsupported', 'call of a non-function', 'b()'],
    ['demo.shared.CallObj', 'unsupported', 'call foo', 'b.foo()'],
    ['demo.shared.Compound', 'unsupported', '+=', 'b+=1'],
  ])('reports %s as %s with its location', (type, kind, text, at) => {
    const bundle = parseBundle(MINI_BUNDLE);
    const e = interpError(() => new BundleInterpreter(bundle).readClass(type, new Reader(new Uint8Array([1]))));
    expect(e.kind).toBe(kind);
    expect(e.message).toContain(text);
    expect(e.where).toMatch(/\.Ha$/);
    expect(e.message).toContain(e.where);
    expect(e.offset).toBeTypeOf('number');
    expect(bundle.src.slice(e.offset)).toMatch(new RegExp('^' + at.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('reports a static with no definition', () => {
    const e = interpError(() => interp().readClass('demo.shared.Missing', new Reader(new Uint8Array())));
    expect(e.kind).toBe('no-definition');
    expect(e.message).toContain('Nx.Ha');
  });

  it('stops a runaway loop', () => {
    const e = interpError(() => interp({ maxIterations: 50 }).readClass('demo.shared.Spin', new Reader(new Uint8Array())));
    expect(e.kind).toBe('loop-guard');
  });

  it('propagates codec errors from the bytes', () => {
    expect(() => interp().readClass('demo.shared.Board', new Reader(new Uint8Array([1])))).toThrow(/read past end|truncated/);
  });

  it('rejects a negative byte-array length', () => {
    const custom = parseBundle('W["d.B"]=Bb;Bb.Ha=function(a){return P.sL(a)};');
    expect(() => new BundleInterpreter(custom).readClass('d.B', new Reader(new Writer().int32(-5).bytes()))).toThrow(
      /negative/,
    );
  });

  it('caches resolved functions', () => {
    const i = interp();
    const read = () => i.readClass('demo.shared.Point', new Reader(new Writer().int32(1).int32(2).bytes()));
    expect(read()).toEqual(read());
  });
  it('hoists var declarations: a var declared in an untaken branch reads as undefined (#131)', () => {
    const b = parseBundle(
      'W["t.Hx"]=Hx;Hx.Ha=function(a,b,d){if(P.Yc(a))var f=P.Ya(a);var e=new Hx;e.v=null!=f?f:-1;e.w=f?1:0;' +
        'for(var i=0;2>i;i++){var g;if(0==i)g=5}e.g=g;return e};',
    );
    const i = new BundleInterpreter(b);
    expect(i.readClass('t.Hx', new Reader(new Writer().bool(false).bytes()))).toEqual({ $type: 't.Hx', v: -1, w: 0, g: 5 });
    expect(i.readClass('t.Hx', new Reader(new Writer().bool(true).int32(7).bytes()))).toEqual({ $type: 't.Hx', v: 7, w: 1, g: 5 });
  });

  it('caches a failed static lookup instead of rescanning the bundle (#131)', () => {
    const parsed = parseBundle('W["t.Q"]=Qq;Qq.Ha=function(a){return Qq.nope(a)};');
    let scans = 0;
    const src = parsed.src;
    Object.defineProperty(parsed, 'src', {
      get: () => {
        scans++;
        return src;
      },
    });
    const i = new BundleInterpreter(parsed);
    const read = () => interpError(() => i.readClass('t.Q', new Reader(new Uint8Array())));
    expect(read().kind).toBe('no-definition');
    const after = scans;
    expect(read().kind).toBe('no-definition');
    expect(scans).toBe(after);
  });


  it('reports an unbalanced function body', () => {
    const b = parseBundle('W["d.U"]=Uu;Uu.Ha=function(a){return "}"');
    const e = interpError(() => new BundleInterpreter(b).readClass('d.U', new Reader(new Uint8Array())));
    expect(e.kind).toBe('parse');
  });

  it('lets a dialect override primitives', () => {
    const b = parseBundle('W["d.Q"]=Qq;Qq.Ha=function(a){return Q2.zz(a)};');
    const i = new BundleInterpreter(b, { dialect: { statics: { Q2: { zz: () => 'custom' } } } });
    expect(i.readClass('d.Q', new Reader(new Uint8Array()))).toBe('custom');
  });
});

// The bundle is downloaded at run time, so the interpreter treats it as hostile: interpreted code
// must not reach anything of the host process. Every bundle here is hand-written.
describe('BundleInterpreter containment', () => {
  // A read that must END at the step budget gets a small one: the default (30M steps) is half a
  // second of CPU alone and several seconds when the suite runs many files at once, which made the
  // old wall-clock assertions fail under load. One test below still runs the default.
  const SMALL: ConstructorParameters<typeof BundleInterpreter>[1] = { maxSteps: 5_000_000 };
  // What proves a stop is the error's kind. The wall-clock bound only tells a read whose work was
  // charged from one that ran on for minutes, so it is generous (slow CI, a loaded machine).
  const SOON_MS = 4_000;
  /** Evaluate `body` as the reader `Hx.Ha=function(a,b,d){…}` of a one-class bundle. */
  const run = (body: string, bytes: Uint8Array = new Uint8Array(8), opts: ConstructorParameters<typeof BundleInterpreter>[1] = SMALL) =>
    new BundleInterpreter(parseBundle(`function Hx(){}W["h.X"]=Hx;Hx.Ha=function(a,b,d){${body}};`), opts).readClass(
      'h.X',
      new Reader(bytes),
    );
  const g = globalThis as Record<string, unknown>;
  const clean = () => {
    delete g.__interpPwned;
    for (const p of [Object.prototype, Array.prototype] as Record<string, unknown>[]) delete p.polluted;
  };

  it('answers typeof like JS for the values a runtime type check meets', () => {
    // The client's `Std.is`-style checks: "number"==typeof a, "function"==typeof b for a class.
    const r = run(
      'var f=function(){};return [typeof 1,typeof "s",typeof true,typeof null,typeof void 0,typeof [],typeof f,typeof Hx,"function"==typeof Hx,"number"==typeof a]',
    );
    expect(r).toEqual(['number', 'string', 'boolean', 'object', 'undefined', 'object', 'function', 'function', true, false]);
  });

  it('blocks the array-prototype route to the host Function constructor, with no side effect', () => {
    clean();
    for (const body of [
      'var F=[].constructor.constructor;return E.Za(["globalThis.__interpPwned=1"],F)',
      'var F=[]["constructor"]["constructor"];return E.Za(["globalThis.__interpPwned=1"],F)',
      'var e=new Hx;return e.__proto__',
      'return P.wc(a).constructor',
      'var x=[];return x.prototype',
    ]) {
      const e = interpError(() => run(body, new Writer().string('s').bytes()));
      expect(e.kind, body).toBe('forbidden');
    }
    expect(g.__interpPwned).toBeUndefined();
  });

  it('never resolves a static or reader method through an inherited member', () => {
    clean();
    // `constructor` as a class name would otherwise find Object (and its Function) on the dialect table.
    expect(() => run('return constructor.constructor("globalThis.__interpPwned=1")')).toThrow(InterpError);
    expect(() => run('return E.Za([0],constructor.constructor("globalThis.__interpPwned=1"))')).toThrow(InterpError);
    expect(() => run('return a.constructor(1)')).toThrow(InterpError);
    expect(() => run('return a.hasOwnProperty("x")')).toThrow(InterpError);
    expect(g.__interpPwned).toBeUndefined();
  });

  it('reads own members and the allowlisted array and string members only', () => {
    const v = run(
      'var e=new Hx,s=P.wc(a),x=[4,5];e.k=1;' +
        'return [e.k,e.toString,e.hasOwnProperty,x.length,x[1],x.map,x.push,s.length,s[1],s.charAt,e.missing]',
      new Writer().string('hey').bytes(),
    );
    expect(v).toEqual([1, undefined, undefined, 2, 5, undefined, undefined, 3, 'e', undefined, undefined]);
  });

  it('refuses writes through __proto__, constructor and prototype, leaving fresh objects unpolluted', () => {
    clean();
    for (const body of [
      'var e=new Hx;e.__proto__.polluted=1;return e',
      'var e=new Hx;e["__proto__"]=new Hx;return e',
      'var e=new Hx;e.__proto__=[];return e',
      'var q=[];q.constructor.prototype.polluted=1;return q',
      'var e=new Hx;e.constructor=1;return e',
      'var e=new Hx;e.prototype=1;return e',
    ]) {
      const e = interpError(() => run(body));
      expect(e.kind, body).toBe('forbidden');
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(([] as unknown as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses writes onto the reader', () => {
    expect(interpError(() => run('a.pos=0;return 1')).kind).toBe('forbidden');
  });

  it('makes natives refuse a callback that is not an interpreter closure', () => {
    for (const body of [
      'return P.Sd(a,5)',
      'return P.ms(a,"x")',
      'return P.ef(a,function(){return 1},new Hx)',
      'return E.Za([1],Hx)',
    ]) {
      const e = interpError(() => run(body, new Writer().int32(1).bytes()));
      expect(e.kind, body).toBe('forbidden');
    }
    // Called directly with a host function, a native refuses it too.
    const P = DEFAULT_DIALECT.statics.P!;
    const E = DEFAULT_DIALECT.statics.E!;
    const host = () => 'host';
    expect(() => P.Sd!(new Reader(new Writer().int32(1).bytes()), host)).toThrow(InterpError);
    expect(() => P.ef!(new Reader(new Writer().int32(1).bytes()), host, host)).toThrow(InterpError);
    expect(() => E.Za!([1], host)).toThrow(InterpError);
  });

  it('never returns a host function into interpreted scope', () => {
    expect(interpError(() => run('return O.fA(function(){return 1})')).kind).toBe('forbidden');
  });

  it('stops a nested-loop bomb within the step budget', () => {
    const e = interpError(() => run('for(var i=0;i<999999;i++){for(var j=0;j<999999;j++){}}return 1'));
    expect(e.kind).toBe('budget');
    expect(e.message).toContain(`${SMALL.maxSteps} steps`);
  });

  it('stops a nested-loop bomb under the DEFAULT limits too (the step budget or the deadline)', { timeout: 30_000 }, () => {
    const e = interpError(() => run('for(var i=0;i<999999;i++){for(var j=0;j<999999;j++){}}return 1', undefined, {}));
    expect(e.kind).toBe('budget');
    expect(e.message).toMatch(new RegExp(`${DEFAULT_MAX_STEPS} steps|${DEFAULT_MAX_MILLIS} ms`));
  });

  it('stops unbounded recursion at the call-depth limit, never a RangeError', () => {
    const t = Date.now();
    const e = interpError(() => run('return Hx.Ha(a,b,d)'));
    expect(e.kind).toBe('budget');
    expect(e.message).toContain('depth');
    expect(Date.now() - t).toBeLessThan(SOON_MS);
  });

  it('stops exponential fan-out at the step budget', () => {
    const t = Date.now();
    const b = parseBundle('W["h.F"]=Hf;Hf.Ha=function(a){return Hf.f(60)};Hf.f=function(n){if(n<1)return 1;return Hf.f(n-1)+Hf.f(n-1)};');
    const e = interpError(() => new BundleInterpreter(b, SMALL).readClass('h.F', new Reader(new Uint8Array())));
    expect(e.kind).toBe('budget');
    expect(Date.now() - t).toBeLessThan(SOON_MS);
  });

  it('takes the step budget and depth limit as options, and resets them per read', () => {
    expect(interpError(() => run('var i=0;for(;i<100;i++){}return i', undefined, { maxSteps: 50 })).kind).toBe('budget');
    expect(run('var i=0;for(;i<100;i++){}return i', undefined, { maxSteps: 5000 })).toBe(100);
    const b = parseBundle('W["h.D"]=Hd;Hd.Ha=function(a){return Hd.f(10)};Hd.f=function(n){if(n<1)return 0;return Hd.f(n-1)+1};');
    const i = new BundleInterpreter(b, { maxDepth: 5 });
    expect(interpError(() => i.readClass('h.D', new Reader(new Uint8Array()))).kind).toBe('budget');
    const ok = new BundleInterpreter(b, { maxDepth: 20, maxSteps: 1000 });
    for (let k = 0; k < 5; k++) expect(ok.readClass('h.D', new Reader(new Uint8Array()))).toBe(10);
  });

  it('parses a function too large for one read once, not again on every read', () => {
    // A parse is host work the budget can only charge afterwards. One that costs more than a whole
    // read's budget fails the same way every time, so it is a cached parse failure, never re-parsed.
    const big = `Hb.Ha=function(a){${'a;'.repeat(2_000)}return 1};`;
    const i = new BundleInterpreter(parseBundle(`function Hb(){}W["h.B"]=Hb;${big}`), { maxSteps: 500 });
    const first = interpError(() => i.readClass('h.B', new Reader(new Uint8Array())));
    expect(first.kind).toBe('parse');
    expect(first.message).toMatch(/too large/);
    // The same cached error: the second read did not parse it again.
    expect(interpError(() => i.readClass('h.B', new Reader(new Uint8Array())))).toBe(first);
    // A source that does not parse and is larger than the budget is cached the same way.
    const broken = new BundleInterpreter(parseBundle(`function Hc(){}W["h.C"]=Hc;Hc.Ha=function(a){${'a;'.repeat(2_000)}return (};`), { maxSteps: 500 });
    const e1 = interpError(() => broken.readClass('h.C', new Reader(new Uint8Array())));
    expect(e1.kind).toBe('parse');
    expect(interpError(() => broken.readClass('h.C', new Reader(new Uint8Array())))).toBe(e1);
  });

  it('does not let a constructor swallow a budget or containment error', () => {
    const b = parseBundle('function Hc(a){this.x=a.__proto__}W["h.C"]=Hc;Hc.Ha=function(a){return new Hc([])};');
    expect(interpError(() => new BundleInterpreter(b).readClass('h.C', new Reader(new Uint8Array()))).kind).toBe('forbidden');
  });

  it('refuses a huge, negative or fractional count to the allocating helper without allocating', () => {
    const t = Date.now();
    const e = interpError(() =>
      run('return E.Sa(E.Za(E.Range(0,P.Ya(a)),function(i){return 1}))', new Writer().int32(0x7fffffff).bytes()),
    );
    expect(e.kind).toBe('bad-value');
    expect(Date.now() - t).toBeLessThan(SOON_MS);
    const E = DEFAULT_DIALECT.statics.E!;
    for (const n of [-1, 1.5, Number.NaN, Infinity, 2 ** 31, '3']) expect(() => E.Range!(0, n), String(n)).toThrow(InterpError);
    expect(E.Range!(2, 3)).toEqual([2, 3, 4]);
  });

  it('keeps arrays dense: no write to length, no index past the end', () => {
    for (const body of [
      'var x=[];x.length=4294967295;return x',
      'var x=[];x["length"]=5;return x',
      'var x=[];x[4294967294]=1;return x',
      'var x=[1];x[2]=1;return x',
      'var x=[];x["01"]=1;return x',
      'var x=[];x[-1]=1;return x',
      'var x=[];x.foo=1;return x',
    ]) {
      expect(interpError(() => run(body)).kind, body).toBe('forbidden');
    }
    // Appending and overwriting still work.
    expect(run('var x=[];x[0]=1;x[1]=2;x[0]=3;x.push(4);return x')).toEqual([3, 2, 4]);
  });

  it('refuses an array longer than the cap to a native, as an InterpError (never a process abort)', () => {
    const E = DEFAULT_DIALECT.statics.E!;
    const long: unknown[] = [];
    long.length = 2 ** 32 - 1;
    expect(() => E.Sa!(long)).toThrow(InterpError);
    expect(() => E.Za!(long, () => 1)).toThrow(InterpError);
    // Through the interpreter the long array cannot be made in the first place.
    expect(interpError(() => run('var x=[];x.length=4294967295;return E.Sa(x)')).kind).toBe('forbidden');
  });

  it('charges native element work to the step budget', () => {
    const t = Date.now();
    const e = interpError(() => run('for(var i=0;i<999999;i++){for(var j=0;j<999999;j++){E.Sa(E.Range(0,1000000))}}return 1'));
    expect(e.kind).toBe('budget');
    expect(Date.now() - t).toBeLessThan(SOON_MS);
    // One Range of a million costs at least a million steps, charged before it allocates.
    expect(interpError(() => run('return E.Range(0,1000000)', undefined, { maxSteps: 999_999 })).kind).toBe('budget');
    expect(run('return E.Sa(E.Range(0,3))', undefined, { maxSteps: 1000 })).toEqual([0, 1, 2]);
  });

  it('refuses objects as operands of arithmetic and comparison, as an InterpError', () => {
    for (const body of [
      'var e=new Hx;e.k=function(){};return e+""',
      'var e=new Hx;return e<1',
      'var e=new Hx;return 1>=e',
      'var e=new Hx;return e-1',
      'return [1]+1',
    ]) {
      expect(interpError(() => run(body)).kind, body).toBe('bad-value');
    }
    // Equality, and null checks in particular, still work on objects.
    expect(run('var e=new Hx,f=new Hx;return [e===e,e!==f,e==null,e!=null,e==e]')).toEqual([true, true, false, true, true]);
  });

  it('never converts an object in loose equality or a switch case', () => {
    // An array compared with a primitive would otherwise be joined by the host on every comparison,
    // host work the step budget never sees.
    const t = Date.now();
    expect(run('var x=E.Sa(E.Range(0,1000000)),n=0;for(var i=0;i<200;i++){if(x=="x")n++}return n')).toBe(0);
    expect(run('var x=E.Sa(E.Range(0,1000000)),n=0;for(var i=0;i<200;i++){if(x!="x")n++}return n')).toBe(200);
    expect(
      run('var x=E.Sa(E.Range(0,1000000)),n=0;for(var i=0;i<200;i++){switch("x"){case x:n++;break;default:}}return n'),
    ).toBe(0);
    expect(Date.now() - t).toBeLessThan(SOON_MS);
    // Without conversion an object never loosely equals a primitive, even one its join would match.
    expect(run('var x=[1];return [x==1,x=="1",x!=1,1==x,x==x,x==null,x!=undefined]')).toEqual([
      false,
      false,
      true,
      false,
      true,
      false,
      true,
    ]);
    expect(run('var x=[1];switch(1){case x:return "obj";case 1:return "num"}')).toBe('num');
    // Primitives still compare loosely, as before.
    expect(run('return [1=="1",null==undefined,0==""]')).toEqual([true, true, true]);
    expect(run('switch("2"){case 2:return "two";default:return "none"}')).toBe('two');
  });

  it('refuses an object operand of ++ / --, as an InterpError', () => {
    expect(interpError(() => run('var x=[1];x++;return x')).kind).toBe('bad-value');
    expect(run('var x=1;x++;++x;x--;return x')).toBe(2);
  });

  it('caps a string built by + and charges its length, as an InterpError (never a RangeError or OOM)', () => {
    const t = Date.now();
    const e = interpError(() => run('var s="x";for(var i=0;i<40;i++){s=s+s}return s'));
    expect(e.kind).toBe('budget');
    expect(e.message).toContain('string');
    // Concatenating a long string over and over is charged per character, so it ends at the budget.
    const f = interpError(() =>
      run('var s="x";for(var i=0;i<19;i++){s=s+s}var k=[];for(var j=0;j<999999;j++){var t=s+"y";k.push(t[0])}return k'),
    );
    expect(f.kind).toBe('budget');
    // Comparing two long distinct strings is charged too.
    const c = interpError(() =>
      run('var s="x";for(var i=0;i<19;i++){s=s+s}var u=s+"y",v=s+"y",n=0;for(var j=0;j<999999;j++){if(u===v)n++}return n'),
    );
    expect(c.kind).toBe('budget');
    expect(Date.now() - t).toBeLessThan(SOON_MS);
    // Short strings still concatenate.
    expect(run('var s="a";s=s+1+"b";return s')).toBe('a1b');
  });

  it('does not let a constructor swallow a runaway string into $ctorError', () => {
    const b = parseBundle(
      'function Hs(a){var s="x";for(var i=0;i<40;i++){s=s+s}this.s=s}W["h.S"]=Hs;Hs.Ha=function(a){return new Hs(1)};',
    );
    const e = interpError(() => new BundleInterpreter(b).readClass('h.S', new Reader(new Uint8Array())));
    expect(e.kind).toBe('budget');
  });

  it('refuses BigInt and RegExp literals, so no operator does unbounded host work per step', () => {
    expect(interpError(() => run('var x=18446744073709551617n;x=x*x;return 1')).kind).toBe('bad-value');
    expect(interpError(() => run('var x=-1n;return 1')).kind).toBe('bad-value');
    expect(interpError(() => run('var x=/a/;return 1')).kind).toBe('bad-value');
    const t = Date.now();
    const e = interpError(() =>
      run('var x=18446744073709551617n;for(var i=0;i<22;i++){x=x*x}for(var i=0;i<999999;i++){for(var j=0;j<999999;j++){var y=x*3n}}return 1'),
    );
    expect(e.kind).toBe('bad-value');
    expect(Date.now() - t).toBeLessThan(SOON_MS);
    // Ordinary literals still evaluate.
    expect(run('return [1,"s",true,null]')).toEqual([1, 's', true, null]);
  });

  it('reads the length of a typed array from the raw-bytes reader', () => {
    expect(run('var b=a.JS(3);return [b.length,b[1]]', new Uint8Array([7, 8, 9]))).toEqual([3, 8]);
  });

  it('refuses writes of the inherited Object.prototype method names onto objects', () => {
    const inherited = Object.getOwnPropertyNames(Object.prototype).filter((k) => k !== 'constructor' && k !== '__proto__');
    expect(inherited).toContain('__defineGetter__');
    for (const k of ['toJSON', ...inherited]) {
      expect(interpError(() => run(`var e=new Hx;e.${k}=function(){};return e+""`)).kind, k).toBe('forbidden');
    }
  });

  it('resolves a missing static without rescanning the bundle, even when a constructor swallows the error', () => {
    // A large bundle: every lookup that scanned it would be host work the step budget never sees.
    const padding = '/*' + 'X.nop'.repeat(400_000) + '*/';
    const b = parseBundle(
      'W["h.M"]=Hm;W["h.A"]=Am;function Am(x){this.q=X.nope();this.r=X["n"+x]()}' +
        'Hm.Ha=function(a){var i;for(i=0;i<3000;i++){new Am(i)}return new Am(0)};' +
        padding,
    );
    const t = Date.now();
    const v = new BundleInterpreter(b).readClass('h.M', new Reader(new Uint8Array())) as { $ctorError?: string };
    expect(Date.now() - t).toBeLessThan(SOON_MS);
    // The failure still surfaces as before.
    expect(v.$ctorError).toContain('no definition for X.nope');
  });

  it('charges the length of a computed member key to the step budget', () => {
    const t = Date.now();
    const e = interpError(() => run('var s="1",i,x;for(i=0;i<19;i++){s=s+s}for(i=0;i<999999;i++){x="ab"[s]}return 1'));
    expect(e.kind).toBe('budget');
    expect(Date.now() - t).toBeLessThan(SOON_MS);
    // The same holds for a write and for a static looked up by a computed name.
    expect(interpError(() => run('var s="1",i,e=new Hx;for(i=0;i<19;i++){s=s+s}for(i=0;i<999999;i++){e[s]=1}return 1')).kind).toBe(
      'budget',
    );
    // Short keys still read and write.
    expect(run('var e=new Hx,x=[7,8];e["k"]=x[1];return [e.k,x[0],"ab"[1]]')).toEqual([8, 7, 'b']);
  });

  it('charges the length of a string converted to a number by an operator', () => {
    // Converting a string to a number is host work in its length; one step per conversion let a
    // long string in a loop run for far longer than the step budget allows.
    const long = 'var s="1",i,n=0;for(i=0;i<19;i++){s=s+s}';
    const t = Date.now();
    for (const op of [
      'if(s==1)n++',
      'if(1!=s)n++',
      'if(s==true)n++',
      'if(s<1)n++',
      'if(s>=1)n++',
      'n=s-0',
      'n=s*1',
      'n=s|0',
      'n=1&s',
      'n=-s',
      'var c=s;c++',
      'switch(1){case s:n++}',
    ]) {
      const e = interpError(() => run(`${long}for(i=0;i<999999;i++){${op}}return n`));
      expect(e.kind, op).toBe('budget');
    }
    expect(Date.now() - t).toBeLessThan(SOON_MS);
    // Short strings still convert as before.
    expect(run('var s="12";return [s==12,s<13,s-2,s*2,s|1,-s,1&s,s==true]')).toEqual([true, true, 10, 24, 13, -12, 0, false]);
    expect(run('var s="3";s++;return s')).toBe(4);
  });

  it('shares one step budget across several reads when given a ReadBudget', () => {
    const b = parseBundle('function Hx(){}W["h.X"]=Hx;Hx.Ha=function(a){var i;for(i=0;i<100;i++){}return i};');
    const interp = new BundleInterpreter(b, { maxSteps: 1000 });
    // Each read alone fits; with one shared budget the reads run out together.
    for (let k = 0; k < 20; k++) expect(interp.readClass('h.X', new Reader(new Uint8Array()))).toBe(100);
    const budget: ReadBudget = { spent: 0 };
    const e = interpError(() => {
      for (let k = 0; k < 20; k++) interp.readClass('h.X', new Reader(new Uint8Array()), budget);
    });
    expect(e.kind).toBe('budget');
    expect(budget.spent).toBeGreaterThan(1000);
  });

  it('ends a read at a wall-clock deadline, whatever the step count', () => {
    expect(DEFAULT_MAX_MILLIS).toBe(5000);
    const bomb = 'for(var i=0;i<999999;i++){for(var j=0;j<999999;j++){}}return 1';
    // A real clock: the step budget is out of reach, the deadline ends the read.
    const t = Date.now();
    const e = interpError(() => run(bomb, undefined, { maxSteps: Number.MAX_SAFE_INTEGER, maxMillis: 50 }));
    expect(e.kind).toBe('budget');
    expect(e.message).toContain('50 ms');
    expect(Date.now() - t).toBeLessThan(SOON_MS);
    // An injected clock: the deadline is per read, so the next read starts afresh.
    const src = 'function Hx(){}W["h.X"]=Hx;Hx.Ha=function(a){var i;for(i=0;i<5000;i++){}return i};';
    let clock = 0;
    const i = new BundleInterpreter(parseBundle(src), { maxMillis: 10, now: () => clock });
    expect(i.readClass('h.X', new Reader(new Uint8Array()))).toBe(5000);
    clock = 1000; // time passing between reads does not count against the next one
    expect(i.readClass('h.X', new Reader(new Uint8Array()))).toBe(5000);
    // A clock that advances a millisecond per check runs out within the read.
    const slow = new BundleInterpreter(parseBundle(src), { maxMillis: 10, now: () => (clock += 1) });
    expect(interpError(() => slow.readClass('h.X', new Reader(new Uint8Array()))).kind).toBe('budget');
  });

  it('shares the deadline across reads that share a ReadBudget', () => {
    let clock = 0;
    const src = 'function Hx(){}W["h.X"]=Hx;Hx.Ha=function(a){var i;for(i=0;i<5000;i++){}return i};';
    const i = new BundleInterpreter(parseBundle(src), { maxMillis: 10, now: () => clock });
    const budget: ReadBudget = { spent: 0 };
    expect(i.readClass('h.X', new Reader(new Uint8Array()), budget)).toBe(5000);
    clock = 11;
    expect(interpError(() => i.readClass('h.X', new Reader(new Uint8Array()), budget)).kind).toBe('budget');
  });

  it('builds the message of a thrown value once per throw site, capped and charged', () => {
    // A constructor whose throw argument holds many string literals, failing in a loop.
    const lits = Array.from({ length: 10_000 }, () => '"x"').join(',');
    const ctor = `W["h.C"]=Hc;function Hc(x){throw [${lits}]}`;
    const loop = parseBundle(`${ctor}W["h.B"]=Hb;Hb.Ha=function(a){for(var i=0;i<999999;i++){for(var j=0;j<999999;j++){new Hc(1)}}return 0};`);
    const t = Date.now();
    const e = interpError(() => new BundleInterpreter(loop, SMALL).readClass('h.B', new Reader(new Uint8Array())));
    expect(e.kind).toBe('budget');
    expect(Date.now() - t).toBeLessThan(SOON_MS);
    const one = parseBundle(`${ctor}W["h.O"]=Ho;Ho.Ha=function(a){return new Hc(1)};`);
    const v = new BundleInterpreter(one).readClass('h.O', new Reader(new Uint8Array())) as { $ctorError: string };
    expect(v.$ctorError).toContain('reader threw: x x x');
    expect(v.$ctorError.length).toBeLessThan(MAX_THROW_MESSAGE + 100);
  });

  it('caps lexical function nesting and charges each name lookup by the scopes it walks', () => {
    const nested = (depth: number, body: string) => {
      let inner = `function(){${body}}`;
      for (let k = 0; k < depth; k++) inner = `function(){return ${inner}}`;
      return `var f=${inner};for(var n=0;n<${depth + 1};n++){f=f()}return f`;
    };
    // Real readers nest a few functions deep: that still runs.
    expect(run(nested(4, 'return 7'))).toBe(7);
    // Past the cap, a read ends with a budget error rather than slow lookups.
    const deep = interpError(() => run(nested(MAX_NESTING + 1, 'return 7')));
    expect(deep.kind).toBe('budget');
    expect(deep.message).toContain('nested');
    // Inside the cap, an undeclared name looked up in a loop ends at the step budget quickly.
    const t = Date.now();
    const lookups = 'for(var i=0;i<999999;i++){for(var j=0;j<999999;j++){Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q,Q}}return 0';
    const e = interpError(() => run(nested(MAX_NESTING - 2, lookups)));
    expect(e.kind).toBe('budget');
    expect(e.message).toContain('steps');
    expect(Date.now() - t).toBeLessThan(SOON_MS);
  });

  it('refuses a reader argument that is not the reader, as an InterpError', () => {
    for (const body of [
      'return P.Sd(new Hx,function(){return 1})',
      'return P.ms("abc",function(){return 1})',
      'return P.ef(1,function(){},function(){})',
      'return P.Ya("abc")',
    ]) {
      const e = interpError(() => run(body, new Writer().int32(1).bytes()));
      expect(e.kind, body).toBe('bad-value');
    }
    expect(() => DEFAULT_DIALECT.statics.P!.Ya!({})).toThrow(InterpError);
  });

  it('never treats a key longer than ten characters as an array index', () => {
    // No canonical array index has more than ten digits: such a key is refused on an array write
    // and reads as undefined on a string, without a pattern test over the whole key.
    expect(interpError(() => run('var x=[];x["12345678901"]=1;return x')).kind).toBe('forbidden');
    expect(run('return "ab"["12345678901"]')).toBeUndefined();
    expect(run('var x=[5];x["1"]=6;return [x[1],"ab"["1"]]')).toEqual([6, 'b']);
  });

  // The per-function AST walks were quadratic (a duplicate check by array scan, a reader test repeated
  // for every enclosing assignment) and uncharged, so a few megabytes of bundle took minutes. The clock
  // is held still in these: only the step count (or the walks being linear) can end them. A quadratic
  // walk would take minutes, so the generous timeouts (for a loaded machine) still catch one.
  const still = { now: () => 0 };

  it('hoists a function with many `var` names in linear time, the walk charged', { timeout: 30_000 }, () => {
    const names = Array.from({ length: 200_000 }, (_, k) => `a${k}`).join(',');
    // Declared in an untaken branch, so only the hoisting does work.
    expect(run(`var g=function(){if(0){var ${names}}return 3};return g()`, undefined, still)).toBe(3);
    // The walk is charged to the step count: a budget that covers the parse alone runs out in it.
    const src = `function Hx(){}W["h.X"]=Hx;Hx.Ha=function(a,b,d){if(0){var ${names}}return 3};`;
    const parse = src.length - src.indexOf('function(a,b,d)');
    const tight = new BundleInterpreter(parseBundle(src), { ...still, maxSteps: parse + 10 });
    expect(interpError(() => tight.readClass('h.X', new Reader(new Uint8Array()))).kind).toBe('budget');
  });

  it('charges each call the parameters and hoisted names it declares', { timeout: 30_000 }, () => {
    const names = Array.from({ length: 1000 }, (_, k) => `a${k}`).join(',');
    for (const fn of [`function(){if(0){var ${names}}}`, `function(${names}){}`]) {
      const e = interpError(() => run(`var g=${fn};for(var i=0;i<999999999;i++){g()}return 0`, undefined, { ...still, ...SMALL }));
      expect(e.kind, fn.slice(0, 20)).toBe('budget');
      expect(e.message).toContain('steps');
    }
  });

  it('finds the fields a reader fills in linear time, the walks charged', { timeout: 30_000 }, () => {
    // A reader making many distinct calls to its own statics, none of them a field read.
    const calls = Array.from({ length: 100_000 }, (_, k) => `Lg.x${k}()`).join(';');
    const src = `W["t.Lg"]=Lg;W["t.F"]=Ff;\nLg.Ha=function(a,b,d){${calls}};\n`;
    expect(new BundleInterpreter(parseBundle(src), still).fieldsReadAs('t.Lg', 't.F')).toEqual([]);
    // A long assignment chain is judged once per node, not once per enclosing assignment.
    const chain = `${'e='.repeat(4000)}Ff.Ha(a)`;
    const deep = new BundleInterpreter(parseBundle(`W["t.Lg"]=Lg;W["t.F"]=Ff;\nLg.Ha=function(a,b,d){var e;${chain};d.f=e;d.g=Ff.Ha(a);d.f=e};\n`), still);
    expect(deep.fieldsReadAs('t.Lg', 't.F')).toEqual(['f', 'g']);
    // The walks are charged: a step budget covering the parse alone runs out in them.
    const parse = src.length - src.indexOf('function(a,b,d)');
    const tight = new BundleInterpreter(parseBundle(src), { ...still, maxSteps: parse + 10 });
    expect(interpError(() => tight.fieldsReadAs('t.Lg', 't.F')).kind).toBe('budget');
  });
});
