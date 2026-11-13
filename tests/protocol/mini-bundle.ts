// A hand-written mini-bundle in the same *shape* as war.app's client bundle:
// classes registered as `W["<type name>"]=<var>;`, generated readers as
// `<var>.Ha=function(a,b,d){…}` over a reader `a`, primitive helpers on `P`,
// constructors as `function <var>(…){this.…}`. Every name and value here is
// made up — nothing is taken from the real bundle.

/**
 * The count, flag and byte helpers (int32, bool, byte), defined as the built-ins read them. Every test bundle
 * that reads through one defines it: a bundle that reads through one the load-time check cannot find is
 * refused (#148), as the real client always defines the helpers it calls.
 */
export const REQUIRED_HELPER_DEFS =
  'var P={};P.Ya=function(a){return a.Og()};P.Yc=function(a){return a.Ua()};P.uq=function(a){return a.bc()};';

export const MINI_BUNDLE = [
  'var W={};',
  REQUIRED_HELPER_DEFS,
  // A decoy definition *before* the registration: resolution must prefer the one after it.
  'Pt.rd=function(a){throw Y.sa(new Pa("decoy definition used"))};',
  'function Pt(){this.x=0;this.y=0}',
  'function Ar(a,b){null==b&&(b=!1);this.n=a;this.fog=b;this.tag="{}"}',
  'function Bd(){}function Ci(a){this.r=a}function Sq(){}function Op(){}',
  'function Bk(a){this.ok=a.nope.deeper}',
  'W["demo.shared.Point"]=Pt;Pt.aa="demo.shared.Point";',
  'Pt.Ha=function(a,b,d){null==d&&(d=242);return Pt.rd(a,d)};',
  // Whitespace-tolerant `X.fn = function`.
  'Pt.rd = function(a,b){var d=new Pt;d.x=P.Ya(a);d.y=P.Ya(a);return d};',
  'W["demo.shared.Army"]=Ar;',
  'Ar.Ha=function(a,b,d){var e=P.Yc(a),f=P.Ya(a);return new Ar(f,e)};',
  'W["demo.shared.Circle"]=Ci;',
  'Ci.Ha=function(a,b){return new Ci(P.Ao(a))};',
  'W["demo.shared.Square"]=Sq;',
  'W["demo.shared.Shape"]=Sh;',
  'Sh.Ha=function(a,b){var d;switch(P.uq(a)){case 1:return Ci.Ha(a,b);case 2:d=new Sq;d.side=P.Ya(a);break;' +
    'case 3:case 4:d=new Sq;d.side=-1;break;default:throw Y.sa(new Pa("unknown shape tag"))}return d};',
  'W["demo.shared.Kind"]=Kd;',
  'Kd.Ha=function(a){return P.uq(a)};',
  'W["demo.shared.Board"]=Bd;',
  'Bd.Ha = function(a,b,d){null==d&&(d=242);return Bd.rd(a,b,d)};',
  'Bd.rd=function(a,b,d){var e=new Bd,f;e.name=P.wc(a);e.origin=a.Ua()?Pt.Ha(a,e,d):null;' +
    'e.points=a.Ua()?P.Sd(a,function(){return a.Ua()?Pt.Ha(a,e,d):null}):null;' +
    'e.owners=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return P.wc(a)}):null;' +
    'e.army=Ar.Ha(a,e,d);if(240>d)e.extra=null;else e.extra=P.Ya(a);e.kind=Kd.Ha(a);e.shape=Sh.Ha(a,d);' +
    'e.round=e.shape instanceof Ci;e.square=e.shape instanceof Sq;' +
    'e.ids=[];for(f=P.Ya(a);0<f;f--)e.ids.push(P.Ya(a));' +
    'e.when=P.Td(a);e.id=P.tL(a);e.big=P.ak(a);e.u16=P.Z5(a);e.blob=P.sL(a);e.flag=O.fA(a.Ua());return e};',
  'W["demo.shared.Ops"]=Op;',
  'Op.Ha=function(a){var b=P.Ya(a),d=new Op,g=function(x){return x*2};' +
    'd.sum=b+2;d.diff=b-2;d.prod=b*2;d.bor=b|1;d.band=b&1;d.neg=-b;d.not=!b;d.v=void 0;d.u=undefined;' +
    'd.eq=b==3;d.ne=b!=3;d.seq=b===3;d.sne=b!==3;d.lt=b<3;d.le=b<=3;d.gt=b>3;d.ge=b>=3;' +
    'd.or=0||b;d.and=b&&7;d.andf=0&&7;d.seqv=(b,9);d.dbl=g(b);' +
    'd.pre=++b;d.post=b--;d.after=b;d.w=new Z(5);d.wn=new Z;d.arr=new Array;' +
    'd.r=E.Sa(E.Za(E.Range(0,b),function(i){return i+P.uq(a)}));' +
    'd.raw=[a.Og(),a.bc(),a.FJ(),a.E3a(),a.Om(),a.NGb(),a.S3c(),a.MGb(),a.JS(2),a.I3c()];' +
    'd.more=[P.uy(a),P.ms(a,function(){return P.Ya(a)}),P.uL(a,function(){return P.Ya(a)}),P.sL(a),P.Td(a)];' +
    'd.len=d.raw.length;d.id=za.rc(4);if(d.not){d.branch="then"}else{d.branch="else"}for(;;){break}' +
    'return d};',
  'W["warlight.shared.LatestGameInfo"]=NE;',
  'NE.Ha=function(a,b,d){null==d&&(d=242);var e=new NE;e.turn=P.Ya(a);e.ver=d;return e};',
  'function NE(){this.turn=0}',
  // Constructs the interpreter does not support, each to be reported with its location.
  'W["demo.shared.Loop"]=Lp;Lp.Ha=function(a){while(a.Ua()){}return 1};',
  'W["demo.shared.BadMethod"]=Bm;Bm.Ha=function(a){return a.Zq()};',
  'W["demo.shared.Missing"]=Ms;Ms.Ha=function(a){return Nx.Ha(a)};',
  'W["demo.shared.NullMember"]=Nm;Nm.Ha=function(a){var b=null;return b.x};',
  'W["demo.shared.ObjLit"]=Ob;Ob.Ha=function(a){return {}};',
  'W["demo.shared.ReaderRef"]=Rr;Rr.Ha=function(a){return a.Ua};',
  'W["demo.shared.CallNum"]=Cn;Cn.Ha=function(a){var b=1;return b()};',
  'W["demo.shared.CallObj"]=Co;Co.Ha=function(a){var b=new Op;return b.foo()};',
  'W["demo.shared.Compound"]=Cp;Cp.Ha=function(a){var b=1;b+=1;return b};',
  'W["demo.shared.Spin"]=Sp;Sp.Ha=function(a){for(;;){}};',
  'W["demo.shared.BadCtor"]=Bk;Bk.Ha=function(a){return new Bk(1)};',
].join('\n');

/**
 * Runtime type checks in the shape the client's compiler emits (a cast helper that switches on the
 * built-in types, then `instanceof`, then — for an interface — walks the class's interface list and
 * superclass link). Classes carry statics (`Xx.If=[…]` interfaces, `Xx.Sup=…` superclass, `Xx.Ifc=!0`
 * on an interface) and a prototype field naming their class (`Xx.prototype={ty:Xx}`); a subclass's
 * prototype is built from its superclass's (`Xx.prototype=Ex(Yy.prototype,{…})`). Every name is made up.
 */
export const TYPES_BUNDLE = [
  'var W={};',
  REQUIRED_HELPER_DEFS,
  'function Ex(a,b){var d=Object.create(a);for(var e in b)d[e]=b[e];return d}',
  'var Kn=Number,Rt={};',
  'Rt.loop=function(a,b){if(null==a)return!1;if(a==b)return!0;var d=a.If;if(null!=d)for(var e=0,f=d.length;e<f;){var g=e++;' +
    'g=d[g];if(g==b||Rt.loop(g,b))return!0}return Rt.loop(a.Sup,b)};',
  'Rt.cls=function(a){if(null==a)return null;if(a instanceof Array)return Array;var b=a.ty;return null!=b?b:null};',
  'Rt.is=function(a,b){if(null==b)return!1;switch(b){case Array:return a instanceof Array;case Kn:return"number"==typeof a;' +
    'case String:return"string"==typeof a;default:if(null!=a&&"function"==typeof b){if(a instanceof b)return!0;' +
    'if(b.Ifc)return Rt.loop(Rt.cls(a),b)}return!1}};',
  'Rt.cast=function(a,b){if(null==a||Rt.is(a,b))return a;throw Y.sa("Cannot cast to the class")};',
  // Two interfaces, one extending the other.
  'function Ib(){}Ib.Ifc=!0;Ib.prototype={ty:Ib};',
  'function Ia(){}Ia.Ifc=!0;Ia.If=[Ib];Ia.prototype={ty:Ia};',
  // A three-level hierarchy; the base implements Ia (so, through it, Ib).
  'function Bo(){}W["demo.shared.BaseOrder"]=Bo;Bo.aa="demo.shared.BaseOrder";Bo.If=[Ia];',
  'Bo.Ver=3;Bo.Nm=\'it\\\'s\';Bo.Neg=-2;Bo.Off=!1;Bo.Nil=null;Bo.None=[];',
  'Bo.Cx=new Ot;Bo.Two=1;Bo.Lc=Qq;',
  'Bo.Ha=function(a,b,d){switch(P.uq(a)){case 1:return new Bo;case 2:return new Mo;case 3:return new Lo;default:return new Ot}};',
  'Bo.prototype={ty:Bo,wr:function(){return 1}};',
  'function Mo(){}W["demo.shared.MidOrder"]=Mo;Mo.aa="demo.shared.MidOrder";Mo.Sup=Bo;',
  'Mo.Ha=function(a,b,d){return Rt.cast(Bo.Ha(a,b,d),Mo)};',
  'Mo.prototype=Ex(Bo.prototype,{ty:Mo});',
  'function Lo(){}W["demo.shared.LeafOrder"]=Lo;Lo.Sup=Mo;Lo.prototype=Ex(Mo.prototype,{ty:Lo});',
  'function Ot(){}W["demo.shared.Other"]=Ot;Ot.prototype={ty:Ot};',
  // A static assigned twice with different values, and one changed at run time.
  'Bo.Two=2;Bo.Ctr=0;Bo.bump=function(){Bo.Ctr++};',
].join('\n');
