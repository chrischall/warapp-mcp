// A hand-written synthetic bundle carrying the classes the live board reads
// (LatestGameInfo → GameStanding → TerritoryStanding → Armies → SpecialUnit), in
// the same *shape* as war.app's generated readers and with TerritoryStanding
// fields read in the documented order: fog level, territory id, Armies, owner,
// then a trailing field. Armies is read as the client reads it: fogged, count,
// then (protocol ≥ 107) a byte count of special units, each dispatched on a
// byte tag (1 Commander, 2 Boss1, 6 CustomSpecialUnit) and ending with the
// shared unit fields GUID, owner — then built through its constructor. Every var, field name and value here is made up; nothing is
// taken from the real bundle. `writeLatestGameInfo` encodes a matching reply
// body with this project's own Writer.
import type { Writer } from '../../src/protocol/codec.js';
import { REQUIRED_HELPER_DEFS } from './mini-bundle.js';

/**
 * The LatestGameInfo reader: my own orders this turn (a list of GameOrder, read through a closure as the client
 * reads its first field), a number, the current standing, teammates' entered orders (a dict in-game id →
 * TeammateOrders, read through a closure as the client reads it), a number, then (#427) the last GameTurn
 * when present.
 */
export const LATEST_GAME_INFO_READER =
  'Lg.Ha=function(a,b,d){null==d&&(d=243);var e=new Lg;' +
  'e.k0=a.Ua()?P.ms(a,function(){return a.Ua()?Go.Ha(a,e,d):null}):null;e.k1=P.Ya(a);e.k2=a.Ua()?Gs.Ha(a,e,d):null;' +
  'e.k4=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return a.Ua()?Tq.Ha(a,e,d):null}):null;' +
  'e.k3=P.Ya(a);e.k5=a.Ua()?Gq.Ha(a,e,d):null;return e};';

export const LIVE_BUNDLE = [
  'var W={};',
  REQUIRED_HELPER_DEFS,
  'function Lg(){this.k1=0}function Gs(){}function Ts(){}function Pc(){}',
  'W["warlight.shared.LatestGameInfo"]=Lg;',
  LATEST_GAME_INFO_READER,
  // TeammateOrders: a stamp, the orders entered (a turn), the picks entered (distribution).
  'function Tq(){this.n1=0}',
  'W["warlight.shared.TeammateOrders"]=Tq;',
  'Tq.Ha=function(a,b,d){var e=new Tq;e.n1=P.Ya(a);' +
    'e.n2=a.Ua()?P.ms(a,function(){return a.Ua()?Go.Ha(a,e,d):null}):null;' +
    'e.n3=a.Ua()?P.ms(a,function(){return P.Ya(a)}):null;return e};',
  // GameOrder: a byte tag, the subclass's fields, then the base: player (in-game id), an optional result,
  // an optional list of standing updates.
  'function Go(){}function Gd(){}function Ga(){}function Gk(){}function Gr(){}function Gx(){}function Ge(){}',
  'W["warlight.shared.GameOrder"]=Go;',
  'Go.Ha=function(a,b,d){var e=a.bc();switch(e){case 1:return Ga.r(a,b,d);case 2:return Gd.r(a,b,d);' +
    'case 5:return Gr.r(a,b,d);case 9:return Gx.r(a,b,d);case 10:return Gk.r(a,b,d);case 14:return Gy.r(a,b,d);' +
    'case 15:return Gz.r(a,b,d);case 11:return Gl.r(a,b,d);case 12:return Gf.r(a,b,d);case 13:return Gg.r(a,b,d);' +
    'case 18:return Gb.r(a,b,d);case 22:return new Ge;' +
    'default:throw Y.sa(new Pa("unknown order "+e))}};',
  'Go.base=function(a,b,d){b.o9=P.Ya(a);b.oa=a.Ua()?P.Ya(a):null;b.ob=a.Ua()?P.Sd(a,function(){return P.Ya(a)}):null};',
  'W["warlight.shared.GameOrderDeploy"]=Gd;',
  'Gd.r=function(a,b,d){b=new Gd;b.o1=P.Ya(a);b.o2=P.Yc(a);b.o3=P.Ya(a);Go.base(a,b,d);return b};',
  'W["warlight.shared.GameOrderAttackTransfer"]=Ga;',
  'Ga.r=function(a,b,d){b=new Ga;b.o1=P.Yc(a);b.o2=P.uq(a);b.o3=P.Yc(a);b.o4=P.Ya(a);b.o5=Am.Ha(a,b,d);' +
    'b.o6=P.Ya(a);Go.base(a,b,d);return b};',
  'W["warlight.shared.GameOrderPlayCardReinforcement"]=Gr;',
  'Gr.r=function(a,b,d){b=new Gr;b.o1=P.tL(a);Go.base(a,b,d);return b};',
  'W["warlight.shared.GameOrderPlayCardOrderPriority"]=Gk;',
  'Gk.r=function(a,b,d){b=new Gk;b.o1=P.tL(a);Go.base(a,b,d);return b};',
  'W["warlight.shared.GameOrderDiscard"]=Gx;',
  'Gx.r=function(a,b,d){b=new Gx;b.o1=P.tL(a);Go.base(a,b,d);return b};',
  'W["warlight.shared.GameOrderEvent"]=Ge;',
  // Card plays with targets, each its own fields, then the card GUID and the base: Gift (recipient, territory),
  // Airlift (an optional Armies, from, a legacy count, to), Blockade (territory); Order Delay has none.
  'function Gl(){}function Gf(){}function Gg(){}function Gb(){}',
  'W["warlight.shared.GameOrderPlayCardOrderDelay"]=Gl;',
  'Gl.r=function(a,b,d){b=new Gl;b.o1=P.tL(a);Go.base(a,b,d);return b};',
  'W["warlight.shared.GameOrderPlayCardAirlift"]=Gf;',
  'Gf.r=function(a,b,d){b=new Gf;b.o1=a.Ua()?Am.Ha(a,b,d):null;b.o2=P.Ya(a);b.o3=P.Ya(a);b.o4=P.Ya(a);' +
    'b.o5=P.tL(a);Go.base(a,b,d);return b};',
  'W["warlight.shared.GameOrderPlayCardGift"]=Gg;',
  'Gg.r=function(a,b,d){b=new Gg;b.o1=P.Ya(a);b.o2=P.Ya(a);b.o3=P.tL(a);Go.base(a,b,d);return b};',
  'W["warlight.shared.GameOrderPlayCardBlockade"]=Gb;',
  'Gb.r=function(a,b,d){b=new Gb;b.o1=P.Ya(a);b.o2=P.tL(a);Go.base(a,b,d);return b};',
  // #427: GameTurn — the turn's orders (each optional), then its 0-based number.
  'function Gq(){}',
  'W["warlight.shared.GameTurn"]=Gq;',
  'Gq.Ha=function(a,b,d){var e=new Gq;e.t1=a.Ua()?P.Sd(a,function(){return a.Ua()?Go.Ha(a,e,d):null}):null;e.t2=P.Ya(a);return e};',
  // PLAN-TEAMS D3: the play orders an ActiveCard carries. Diplomacy reads its two players, Sanctions its
  // target, then the card GUID and the base (the player who played it).
  'function Gy(){}function Gz(){}function Ac(){}',
  'W["warlight.shared.GameOrderPlayCardDiplomacy"]=Gy;',
  'Gy.r=function(a,b,d){b=new Gy;b.o1=P.Ya(a);b.o2=P.Ya(a);b.o3=P.tL(a);Go.base(a,b,d);return b};',
  'W["warlight.shared.GameOrderPlayCardSanctions"]=Gz;',
  'Gz.r=function(a,b,d){b=new Gz;b.o1=P.Ya(a);b.o3=P.tL(a);Go.base(a,b,d);return b};',
  // ActiveCard: the play order that started it (optional), then ExpiresAfterTurn.
  'W["warlight.shared.ActiveCard"]=Ac;',
  'Ac.Ha=function(a,b,d){var e=new Ac;e.x1=a.Ua()?Go.Ha(a,e,d):null;e.x2=P.Ya(a);return e};',
  'W["warlight.shared.GameStanding"]=Gs;',
  'Gs.Ha=function(a,b,d){var e=new Gs;' +
    'e.q1=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return Pc.Ha(a,e,d)}):null;' +
    'e.q2=a.Ua()?P.ef(a,function(){return P.Ya(a)},function(){return a.Ua()?Ts.Ha(a,e,d):null}):null;' +
    'e.q3=a.Ua()?P.Sd(a,function(){return Ac.Ha(a,e,d)}):null;return e};',
  // Per-player data keyed by in-game id (an unregistered class, as in the client),
  // holding the player's cards: a dict GUID → card instance.
  'Pc.Ha=function(a,b,d){var e=new Pc;e.z1=P.Ya(a);' +
    'e.z2=a.Ua()?P.ef(a,function(){return P.tL(a)},function(){return a.Ua()?Cd.Ha(a,e,d):null}):null;return e};',
  'function Cd(){}function Rc(){}function Nc(){}',
  'W["warlight.shared.CardInstance"]=Cd;',
  'Cd.Ha=function(a,b,d){switch(P.uq(a)){case 1:return Rc.Ha(a,b,d);case 2:return Nc.Ha(a,b,d);' +
    'default:throw Y.sa(new Pa("unknown card instance tag"))}};',
  'W["warlight.shared.ReinforcementCardInstance"]=Rc;',
  'Rc.Ha=function(a,b,d){var e=new Rc;e.c1=P.tL(a);e.c2=P.Ya(a);e.c3=P.Ya(a);return e};',
  'W["warlight.shared.NoParameterCardInstance"]=Nc;',
  'Nc.Ha=function(a,b,d){var e=new Nc;e.c1=P.tL(a);e.c2=P.Ya(a);return e};',
  'W["warlight.shared.TerritoryStanding"]=Ts;',
  'Ts.Ha=function(a,b,d){var e=new Ts;e.f1=P.Ya(a);e.f2=P.Ya(a);e.f3=Am.Ha(a,e,d);e.f4=P.Ya(a);' +
    'e.f5=a.Ua()?P.Ya(a):null;return e};',
  'W["warlight.shared.Armies"]=Am;',
  'Am.Ha=function(a,b,d){null==d&&(d=0);return Am.r(a,d)};' +
    'Am.r=function(a,b){null==b&&(b=0);var d=P.Yc(a),e=P.Ya(a);if(107>b)var f=null;else f=P.uq(a),' +
    'f=0==f?null:E.Sa(E.Za(E.Range(0,f),function(){return Su.Ha(a,null,b)}));return new Am(e,f,d)};',
  'function Am(a,b,d){null==d&&(d=!1);null==a&&(a=0);this.g1=!1;this.g2=0;this.g1=d;this.g2=a;' +
    'this.g3=null!=b&&0==b.length?null:b}',
  'function Su(){}function Cm(){}function Bs(){}function Cu(){}',
  'W["warlight.shared.SpecialUnit"]=Su;',
  'Su.Ha=function(a,b){return Su.k(a,b)};' +
    'Su.k=function(a,b){var d=a.bc();switch(d){case 1:return Cm.r(a,b);case 2:return Bs.r(a,b);' +
    'case 6:return Cu.r(a,b);default:throw Y.sa(new Pa("Unexpected token "+d));}};' +
    'Su.E=function(a,b){b.u1=P.tL(a);b.u2=P.Ya(a)};',
  'W["warlight.shared.Commander"]=Cm;',
  'Cm.r=function(a,b){b=Cm.mc(b);Su.E(a,b);return b};Cm.mc=function(){return new Cm};',
  'W["warlight.shared.Boss1"]=Bs;',
  'Bs.r=function(a,b){b=Bs.mc(b);b.h1=P.Ya(a);Su.E(a,b);return b};Bs.mc=function(){return new Bs};',
  'W["warlight.shared.CustomSpecialUnit"]=Cu;',
  'Cu.r=function(a,b){b=Cu.mc(b);b.h1=a.Ua()?new Z(P.Ya(a)):new Z;b.h2=P.wc(a);Su.E(a,b);return b};' +
    'Cu.mc=function(){return new Cu};',
].join('\n');

/** A synthetic special unit: a made-up GUID and an in-game owner id. */
export type SyntheticUnit =
  | { kind: 'commander'; id: string; owner: number }
  | { kind: 'boss'; id: string; owner: number; health: number }
  | { kind: 'custom'; id: string; owner: number; power: number | null; name: string };

function writeUnit(w: Writer, u: SyntheticUnit): void {
  if (u.kind === 'commander') w.u8(1);
  else if (u.kind === 'boss') w.u8(2).int32(u.health);
  else {
    w.u8(6).bool(u.power !== null);
    if (u.power !== null) w.int32(u.power);
    w.string(u.name);
  }
  w.guid(u.id).int32(u.owner);
}

/** A synthetic card instance: a made-up GUID, the card type id and, for Reinforcement, its armies. */
export interface SyntheticCard {
  id: string;
  type: number;
  armies?: number;
}

export interface SyntheticTerritory {
  id: number;
  /** 1 visible, 2 owner only, 4 fogged. */
  fogLevel: number;
  /** In-game player id, 0 neutral, -2 pickable, -1 hidden. */
  owner: number;
  armies: number;
  fogged?: boolean;
  /** Special units on the territory (commanders, bosses), none by default. */
  units?: readonly SyntheticUnit[];
}

/** One order a teammate entered, as the synthetic bundle's GameOrder classes read it. */
export type SyntheticOrder =
  | { kind: 'deploy'; territory: number; armies: number; free?: boolean }
  | {
      kind: 'move';
      from: number;
      to: number;
      armies: number;
      /** 1 Attack, 2 Transfer, 3 AttackTransfer (the default). */
      mode?: number;
      percent?: boolean;
      attackTeammates?: boolean;
      units?: readonly SyntheticUnit[];
    }
  | { kind: 'card'; tag: 5 | 10 | 11; card: string }
  /** Gift (13): the recipient's in-game id, then the territory. Blockade (18): the territory. Sanctions (15): the sanctioned player's in-game id. */
  | { kind: 'card'; tag: 13 | 15 | 18; card: string; ints: readonly number[] }
  /** Airlift (12): the armies (and units), from, to. */
  | { kind: 'card'; tag: 12; card: string; from: number; to: number; armies: number; units?: readonly SyntheticUnit[] }
  | { kind: 'discard'; card: string }
  /** An order class the projection does not read (tag 22, an event). */
  | { kind: 'event' };

/** A teammate's entry in LatestGameInfo's teammate orders: orders (a turn) and/or picks (distribution). */
export interface SyntheticTeammateOrders {
  stamp?: number;
  /** `null` (or absent): none sent. */
  orders?: readonly SyntheticOrder[] | null;
  picks?: readonly number[] | null;
}

function writeOrder(w: Writer, o: SyntheticOrder, player: number): void {
  if (o.kind === 'event') {
    w.u8(22);
    return;
  }
  if (o.kind === 'deploy') w.u8(2).int32(o.territory).bool(o.free ?? false).int32(o.armies);
  else if (o.kind === 'move') {
    const units = o.units ?? [];
    w.u8(1).bool(o.attackTeammates ?? false).u8(o.mode ?? 3).bool(o.percent ?? false).int32(o.from);
    w.bool(false).int32(o.armies).u8(units.length);
    for (const u of units) writeUnit(w, u);
    w.int32(o.to);
  } else if (o.kind === 'card') {
    w.u8(o.tag);
    if (o.tag === 12) {
      const units = o.units ?? [];
      w.bool(true).bool(false).int32(o.armies).u8(units.length);
      for (const u of units) writeUnit(w, u);
      w.int32(o.from).int32(0).int32(o.to);
    } else if (o.tag === 13 || o.tag === 15 || o.tag === 18) for (const n of o.ints) w.int32(n);
    w.guid(o.card);
  }
  else w.u8(9).guid(o.card);
  w.int32(player).bool(false).bool(false);
}

/**
 * A card in effect (PLAN-TEAMS D3): the play order that started it — Diplomacy between two in-game ids, or
 * Sanctions on one — played by `by`, and the raw ExpiresAfterTurn.
 */
export type SyntheticActiveCard =
  | { card: 'Diplomacy'; players: [number, number]; by: number; guid: string; expiresAfterTurn: number }
  | { card: 'Sanctions'; target: number; by: number; guid: string; expiresAfterTurn: number };

/** The result of GetLatestGameInfo (present flag first), as the synthetic bundle reads it. */
export function writeLatestGameInfo(
  w: Writer,
  territories: readonly SyntheticTerritory[] | null,
  playerIds: readonly number[] = [],
  hands: Readonly<Record<number, readonly SyntheticCard[]>> = {},
  teammateOrders?: Readonly<Record<number, SyntheticTeammateOrders | null>>,
  activeCards?: readonly SyntheticActiveCard[],
  lastTurn?: SyntheticTurn,
  /** My own orders this turn (LatestGameInfo's first field): `null` or absent, none sent. */
  myOrders?: { player: number; orders: readonly SyntheticOrder[] } | null,
): void {
  w.bool(true);
  if (!myOrders) w.bool(false);
  else
    w.bool(true).list(myOrders.orders, (ow, o) => {
      ow.bool(true);
      writeOrder(ow, o, myOrders.player);
    });
  w.int32(1);
  if (territories === null) {
    w.bool(false);
  } else {
    w.bool(true);
    w.bool(true).list(playerIds, (ww, id) => {
      ww.int32(id).int32(0);
      const hand = hands[id];
      if (!hand) {
        ww.bool(false);
        return;
      }
      ww.bool(true).list(hand, (cw, c) => {
        cw.guid(c.id).bool(true);
        // ReinforcementCardInstance reads tc (armies) in its subclass, THEN the base reads Gb (type):
        // the live wire carries armies before the type, so the decoded integer fields are [armies, type].
        if (c.armies !== undefined) cw.u8(1).guid(c.id).int32(c.armies).int32(c.type);
        else cw.u8(2).guid(c.id).int32(c.type);
      });
    });
    w.bool(true).list(territories, (ww, t) => {
      ww.int32(t.id).bool(true).int32(t.fogLevel).int32(t.id).bool(t.fogged ?? false).int32(t.armies);
      const units = t.units ?? [];
      ww.u8(units.length);
      for (const u of units) writeUnit(ww, u);
      ww.int32(t.owner).bool(false);
    });
    if (activeCards === undefined) w.bool(false);
    else
      w.bool(true).list(activeCards, (aw, c) => {
        aw.bool(true);
        if (c.card === 'Diplomacy') aw.u8(14).int32(c.players[0]).int32(c.players[1]);
        else aw.u8(15).int32(c.target);
        aw.guid(c.guid).int32(c.by).bool(false).bool(false);
        aw.int32(c.expiresAfterTurn);
      });
  }
  if (teammateOrders === undefined) w.bool(false);
  else {
    w.bool(true).list(Object.entries(teammateOrders), (ww, [key, t]) => {
      const id = Number(key);
      ww.int32(id);
      if (t === null) {
        ww.bool(false);
        return;
      }
      ww.bool(true).int32(t.stamp ?? 1);
      if (t.orders === undefined || t.orders === null) ww.bool(false);
      else
        ww.bool(true).list(t.orders, (ow, o) => {
          ow.bool(true);
          writeOrder(ow, o, id);
        });
      if (t.picks === undefined || t.picks === null) ww.bool(false);
      else ww.bool(true).list(t.picks, (pw, n) => pw.int32(n));
    });
  }
  w.int32(2);
  if (lastTurn === undefined) w.bool(false);
  else {
    w.bool(true).bool(true).list(lastTurn.orders, (ow, { player, order }) => {
      ow.bool(true);
      writeOrder(ow, order, player);
    });
    w.int32(lastTurn.index);
  }
}

/** #427: the last GameTurn a LatestGameInfo carries: its orders (each with its player's in-game id) and 0-based number. */
export interface SyntheticTurn {
  index: number;
  orders: readonly { player: number; order: SyntheticOrder }[];
}
