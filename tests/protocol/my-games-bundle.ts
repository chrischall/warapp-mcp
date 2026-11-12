// A hand-written synthetic bundle carrying the classes a GetMyGames reply reads
// (MyGamesReturn → GameInfo → GameInfoPlayer, with their enums), in the same
// *shape* as war.app's generated readers and with fields read in the documented
// order (docs/PLAN-SCOUT.md, GetMyGames). Every var, field name and value here
// is made up; nothing is taken from the real bundle. `writeMyGamesReturn`
// encodes a matching reply body with this project's own Writer.
import type { Writer } from '../../src/protocol/codec.js';

export const MY_GAMES_BUNDLE = [
  'function Mr(){}function Gi(){}function Gp(){}function Sx(){}function Ox(){}',
  'W["warlight.shared.MyGamesReturn"]=Mr;',
  'Mr.Ha=function(a,b,d){null==d&&(d=242);var e=new Mr;' +
    'e.m1=a.Ua()?P.Sd(a,function(){return a.Ua()?Gi.Ha(a,e,d):null}):null;e.m2=P.Ya(a);return e};',
  'W["warlight.shared.GameInfo"]=Gi;',
  'Gi.Ha=function(a,b,d){var e=new Gi;e.a1=P.Ya(a);e.a2=P.ak(a);e.a3=P.wc(a);e.a4=P.Ya(a);e.a5=P.Ya(a);' +
    'e.a6=P.ak(a);e.a7=Fg.Ha(a);e.a8=P.Ya(a);e.a9=P.Yc(a);e.b1=P.Td(a);e.b2=P.Ya(a);e.b3=P.Ya(a);' +
    'e.b4=a.Ua()?P.Ya(a):null;e.b5=P.wc(a);e.b6=P.Ya(a);e.b7=a.Ua()?P.Sd(a,function(){return P.Ya(a)}):null;' +
    'e.b8=a.Ua()?P.Sd(a,function(){return Gp.Ha(a,e,d)}):null;' +
    'e.c1=P.Yc(a);e.c2=P.Yc(a);e.c3=P.Yc(a);e.c4=P.Yc(a);e.c5=a.Ua()?Sx.Ha(a,e,d):null;e.c6=Gt.Ha(a);' +
    'e.c7=P.Yc(a);e.c8=P.ak(a);e.c9=a.Ua()?Ox.Ha(a,e,d):null;e.d1=P.ak(a);return e};',
  'W["warlight.shared.GameInfoPlayer"]=Gp;',
  'Gp.Ha=function(a,b,d){var e=new Gp;e.p1=a.Ua()?Ox.Ha(a,e,d):null;e.p2=P.Yc(a);e.p3=P.Yc(a);e.p4=P.Ya(a);' +
    'e.p5=P.Yc(a);e.p6=P.wc(a);e.p7=P.Ya(a);e.p8=Ps.Ha(a);e.p9=P.Ya(a);e.q1=P.Yc(a);return e};',
  'W["warlight.shared.GameState"]=Gt;Gt.Ha=function(a){return P.uq(a)};',
  'W["warlight.shared.GamePlayerState"]=Ps;Ps.Ha=function(a){return P.uq(a)};',
  'Fg.Ha=function(a){return P.uq(a)};',
  'Sx.Ha=function(a,b,d){var e=new Sx;e.s1=P.Ya(a);return e};',
  'Ox.Ha=function(a,b,d){var e=new Ox;e.o1=P.Ya(a);return e};',
].join('\n');

export interface SyntheticGamePlayer {
  /** In-game player id. */
  id: number;
  name: string;
  /** GamePlayerState code (2 = Playing). */
  state: number;
  committed: boolean;
}

export interface SyntheticGame {
  id: number;
  name: string;
  /** -1 before turn 1. */
  lastTurn: number;
  /** GameState code (3 = Playing). */
  state: number;
  players: SyntheticGamePlayer[] | null;
  mapId?: number;
}

function writePlayer(w: Writer, p: SyntheticGamePlayer): void {
  w.bool(true).int32(11); // optional object, present
  w.bool(false).bool(p.committed).int32(0).bool(false).string(p.name).int32(p.id).u8(p.state).int32(0).bool(false);
}

function writeGame(w: Writer, g: SyntheticGame): void {
  w.bool(true); // list item present
  w.int32(1).int64(2).string('synthetic').int32(3).int32(4).int64(5).u8(1);
  w.int32(g.id).bool(false).date(null).int32(g.mapId ?? 39905).int32(0);
  w.bool(true).int32(7); // optional int32
  w.string(g.name).int32(g.lastTurn);
  w.bool(true).list([1, 2], (ww, n) => ww.int32(n)); // optional int list
  if (g.players === null) w.bool(false);
  else w.bool(true).list(g.players, writePlayer);
  w.bool(false).bool(false).bool(false).bool(false);
  w.bool(true).int32(9); // optional settings
  w.u8(g.state).bool(false).int64(0).bool(false).int64(0);
}

/** The result of GetMyGames (present flag first), as the synthetic bundle reads it. */
export function writeMyGamesReturn(w: Writer, games: readonly SyntheticGame[] | null): void {
  w.bool(true);
  if (games === null) w.bool(false);
  else w.bool(true).list(games, writeGame);
  w.int32(0);
}
