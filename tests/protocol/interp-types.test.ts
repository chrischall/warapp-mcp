// Runtime type checks: static data reads on a class, `instanceof` through the superclass chain the
// bundle declares, and a decoded object's class through its prototype field — all on the made-up
// TYPES_BUNDLE, never the real client.
import { describe, expect, it } from 'vitest';
import { Reader, Writer } from '../../src/protocol/codec.js';
import { BundleInterpreter, InterpError, parseBundle } from '../../src/protocol/interp.js';
import { TYPES_BUNDLE } from './mini-bundle.js';

const SMALL = { maxSteps: 2_000_000 };

/** Evaluate `body` as the reader `Hx.Ha=function(a,b,d){…}` added to `bundle`. */
const run = (body: string, bytes: Uint8Array = new Uint8Array(8), bundle = TYPES_BUNDLE, opts = SMALL) =>
  new BundleInterpreter(parseBundle(`${bundle}\nfunction Hx(){}W["h.X"]=Hx;Hx.Ha=function(a,b,d){${body}};`), opts).readClass(
    'h.X',
    new Reader(bytes),
  );

function interpError(fn: () => unknown): InterpError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(InterpError);
    return e as InterpError;
  }
  throw new Error('expected an InterpError');
}

const tag = (t: number) => new Writer().u8(t).bytes();

describe('static data reads', () => {
  it('reads literal, null, class and class-list statics', () => {
    expect(run('return [Bo.Ver,Bo.Nm,Bo.Neg,Bo.Off,Bo.Nil,Bo.aa,Ib.Ifc,Bo.None.length,Bo.If.length]')).toEqual([
      3,
      "it's",
      -2,
      false,
      null,
      'demo.shared.BaseOrder',
      true,
      0,
      1,
    ]);
    expect(run('return [Bo.If[0]==Ia,Mo.Sup==Bo,Lo.Sup==Mo,Lo.Sup==Bo,Ia.If[0]===Ib]')).toEqual([true, true, true, false, true]);
  });

  it('reads a key the class never assigns as undefined', () => {
    expect(run('return [void 0===Bo.Ifc,void 0===Mo.If,void 0===Ot.Sup,null==Bo.nope]')).toEqual([true, true, true, true]);
  });

  it('reads a host object member name the class never assigns as undefined, not the host member', () => {
    expect(run('return [Bo.toString,Bo.hasOwnProperty,Bo.valueOf,Bo.isPrototypeOf]')).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('keeps a static assigned any other way unsupported', () => {
    for (const [body, what] of [
      ['return Bo.Cx', 'Bo.Cx'], // `new Ot`
      ['return Bo.Two', 'Bo.Two'], // two different values
      ['return Bo.Ctr', 'Bo.Ctr'], // changed at run time (`Bo.Ctr++`)
      ['return Bo.Lc', 'Bo.Lc'], // an identifier that is not a class
      ['return Bo.Ha', 'Bo.Ha'], // a static function read as a value
      ['return Qz.k', 'Qz.k'], // not a class the bundle defines
      ['return Math.PI', 'Math.PI'], // a host global's own member: not the bundle's to answer
      ['return Array.isArray', 'Array.isArray'],
    ]) {
      const e = interpError(() => run(body!));
      expect(e.kind, body).toBe('unsupported');
      expect(e.message, body).toContain(`static read ${what}`);
    }
  });

  it("reads a key neither the bundle nor the host gives a host global as undefined", () => {
    expect(run('return [void 0===Array.If,void 0===Array.Sup,void 0===String.Ifc]')).toEqual([true, true, true]);
  });

  it('keeps static function calls on their own path', () => {
    expect(run('return Rt.is(1,Kn)')).toBe(true);
  });
});

describe('instanceof', () => {
  it('is true for an instance of the class or any subclass, two levels down', () => {
    expect(
      run('var x=new Lo,m=new Mo,o=new Bo;return [x instanceof Lo,x instanceof Mo,x instanceof Bo,m instanceof Bo,m instanceof Lo,o instanceof Mo,x instanceof Ot]'),
    ).toEqual([true, true, true, true, false, false, false]);
  });

  it('is false for primitives, null and an interface, and Array-only for arrays', () => {
    expect(run('return [5 instanceof Bo,"s" instanceof Bo,null instanceof Bo,void 0 instanceof Bo,new Lo instanceof Ia,[] instanceof Array,new Bo instanceof Array]')).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
    ]);
  });

  it('keeps exact-type instanceof when the bundle declares no superclass chain', () => {
    const flat = 'var W={};function Ba(){}function Su(){}W["d.Base"]=Ba;W["d.Sub"]=Su;Su.Sup=Ba;';
    expect(run('var x=new Su;return [x instanceof Su,x instanceof Ba]', undefined, flat)).toEqual([true, false]);
  });

  it('ends on a superclass cycle a hostile bundle declares', () => {
    const cyclic = 'var W={};function Ex(a,b){}function Ca(){}function Cb(){}function Cc(){}W["d.A"]=Ca;' +
      'Ca.prototype=Ex(Cb.prototype,{});Cb.prototype=Ex(Ca.prototype,{});';
    expect(run('return new Ca instanceof Cc', undefined, cyclic)).toBe(false);
  });
});

describe("the client's cast helper", () => {
  it('casts an instance of a subclass and refuses one of another class', () => {
    expect(new BundleInterpreter(parseBundle(TYPES_BUNDLE), SMALL).readClass('demo.shared.MidOrder', new Reader(tag(3)))).toEqual({
      $type: 'demo.shared.LeafOrder',
    });
    const e = interpError(() => new BundleInterpreter(parseBundle(TYPES_BUNDLE), SMALL).readClass('demo.shared.MidOrder', new Reader(tag(4))));
    expect(e.kind).toBe('reader-threw');
    expect(e.message).toContain('Cannot cast');
    expect(interpError(() => new BundleInterpreter(parseBundle(TYPES_BUNDLE), SMALL).readClass('demo.shared.MidOrder', new Reader(tag(1)))).kind).toBe(
      'reader-threw',
    );
  });

  it('answers an interface check through the interface list and superclass walk', () => {
    expect(
      run('return [Rt.is(new Lo,Ib),Rt.is(new Lo,Ia),Rt.is(new Bo,Ib),Rt.is(new Ot,Ib),Rt.is(new Ot,Ot),Rt.is(new Lo,Bo),Rt.is(new Bo,Lo)]'),
    ).toEqual([true, true, true, false, true, true, false]);
  });

  it('answers the built-in cases and nulls like JS', () => {
    expect(run('return [Rt.is(5,Kn),Rt.is("s",Kn),Rt.is("s",String),Rt.is([],Array),Rt.is(new Bo,Array),Rt.is(null,Bo),Rt.is(new Bo,null),Rt.is([],Ib)]')).toEqual([
      true,
      false,
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it("reads a decoded object's class through its prototype field, an own field first", () => {
    expect(run('var x=new Lo,o=new Bo;o.ty=5;return [Rt.cls(x)==Lo,Rt.cls([])==Array,o.ty,typeof x.ty,void 0===x.wr,void 0===x.toString]')).toEqual([
      true,
      true,
      5,
      'function',
      true,
      true,
    ]);
  });
});

describe('containment of class values', () => {
  it('keeps statics read-only', () => {
    expect(interpError(() => run('Bo.Ver=4;return 1')).kind).toBe('bad-value');
    expect(interpError(() => run('var x=new Bo;x.ty.Ver=4;return 1')).kind).toBe('bad-value');
    // A class-list static is a fresh array on every read: changing one changes no other read.
    expect(run('var l=Bo.If;l[0]=Ot;l.push(Ot);return [Bo.If.length,Bo.If[0]==Ia]')).toEqual([1, true]);
  });

  it('never reaches a prototype or constructor through a class value', () => {
    for (const body of [
      'return Bo.prototype',
      'return Bo.constructor',
      'return Bo.__proto__',
      'var x=new Lo;return x.ty.prototype',
      'var x=new Lo;return x.ty["constructor"]',
      'return Bo.If.constructor',
      'return Bo.Nm.constructor',
    ]) {
      expect(interpError(() => run(body)).kind, body).toBe('forbidden');
    }
  });

  it('charges static reads and instanceof walks to the step budget', () => {
    const e = interpError(() => run('var x=new Lo;for(;;){x instanceof Bo;Bo.If;Rt.is(x,Ib)}', undefined, TYPES_BUNDLE, { maxSteps: 200_000 }));
    expect(e.kind).toBe('budget');
  });
});

describe('static data reads stay bounded and exact', () => {
  /** How many entries an interpreter's caches hold (internal, read for the bound only). */
  const cacheSizes = (it: BundleInterpreter) => {
    const c = it as unknown as { staticCache: Map<string, unknown>; fnCache: Map<string, unknown> };
    return { statics: c.staticCache.size, fns: c.fnCache.size };
  };
  const interp = (body: string, bundle = TYPES_BUNDLE) =>
    new BundleInterpreter(parseBundle(`${bundle}\nfunction Hx(){}W["h.X"]=Hx;Hx.Ha=function(a,b,d){${body}};`), SMALL);

  it('answers a long digit run quickly, without a match that grows with the square of its length', () => {
    for (const tail of [`${'1'.repeat(100_000)}z`, `${'1'.repeat(400)}${' '.repeat(200_000)}z`, `0x${'f'.repeat(100_000)}z`, `1e${'1'.repeat(100_000)}z`]) {
      const started = performance.now();
      const e = interpError(() => run('return Bo.Big', undefined, `${TYPES_BUNDLE}\nBo.Big=${tail};`));
      expect(e.kind).toBe('unsupported');
      // A backstop only: the bound is the pattern's, not the clock's.
      expect(performance.now() - started).toBeLessThan(5_000);
    }
  });

  it('refuses a leading-zero integer, which JS reads as octal', () => {
    expect(interpError(() => run('return Bo.Oct', undefined, `${TYPES_BUNDLE}\nBo.Oct=010;`)).kind).toBe('unsupported');
    expect(run('return [Bo.Z,Bo.Zf,Bo.Ze]', undefined, `${TYPES_BUNDLE}\nBo.Z=0;Bo.Zf=0.5;Bo.Ze=-0.25e1;`)).toEqual([0, 0.5, -2.5]);
  });

  it('treats a logical assignment as a change in place', () => {
    for (const op of ['||=', '&&=', '??=']) {
      const e = interpError(() => run('return Bo.Lg', undefined, `${TYPES_BUNDLE}\nBo.Lg=1;Bo.Lg${op}5;`));
      expect(e.kind, op).toBe('unsupported');
    }
  });

  it('keeps no cache entry for a static key the source never names', () => {
    const it = interp('for(var i=0;i<2000;i++)Bo["k"+i];return Bo.Ver');
    expect(it.readClass('h.X', new Reader(new Uint8Array(8)))).toBe(3);
    expect(cacheSizes(it).statics).toBeLessThan(10);
  });

  it('keeps no cache entry for a static function the bundle does not define', () => {
    // A constructor's failing call is swallowed (the decoded object keeps the fields it had), so a
    // loop of constructions can look up as many invented names as the budget allows.
    const it = interp('for(var i=0;i<2000;i++)new Cc(i);return 1', `${TYPES_BUNDLE}\nfunction Cc(a){this.v=Bo["f"+a]()}`);
    expect(it.readClass('h.X', new Reader(new Uint8Array(8)))).toBe(1);
    expect(cacheSizes(it).fns).toBeLessThan(10);
    // A missing function is still an error each time it is called.
    expect(interpError(() => interp('return Bo.nope()').readClass('h.X', new Reader(new Uint8Array(8)))).kind).toBe('no-definition');
  });
});

describe('instanceof with one type name registered twice', () => {
  it('is true for an instance of either class registered under the name', () => {
    const twice = 'var W={};function Xa(){}function Ya(){}W["t.A"]=Xa;W["t.A"]=Ya;';
    expect(run('return [new Ya instanceof Ya,new Xa instanceof Xa]', undefined, twice)).toEqual([true, true]);
  });
});
