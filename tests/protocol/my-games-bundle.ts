// A hand-written synthetic bundle carrying the classes a GetMyGames reply and the
// OpenGames page payload read (MyGamesReturn → GameInfo → GameInfoPlayer, with its
// GameColor, and GameInfoSettings, with their enums) and the page startup
// parameters (InitParameters → Player, whose two GameColor fields are the
// account's secondary and preferred colours), in the same *shape* as war.app's generated
// readers and with fields read in the documented order (docs/PLAN-SCOUT.md,
// GetMyGames; docs/WEB-PROTOCOL.md, open games). Every var, field name and value
// here is made up; nothing is taken from the real bundle. `writeMyGamesReturn`,
// `writeGameInfo` and `writeInitParameters` encode matching bytes with this
// project's own Writer.
import type { Writer } from '../../src/protocol/codec.js';

export const MY_GAMES_BUNDLE = [
  'function Mr(){}function Gi(){}function Gp(){}function Sx(){}function Ox(){}function Cl(){}function Pr(){}function Ip(){}',
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
  'Gp.Ha=function(a,b,d){var e=new Gp;e.p1=a.Ua()?Cl.Ha(a,e,d):null;e.p2=P.Yc(a);e.p3=P.Yc(a);e.p4=P.Ya(a);' +
    'e.p5=P.Yc(a);e.p6=P.wc(a);e.p7=P.Ya(a);e.p8=Ps.Ha(a);e.p9=P.Ya(a);e.q1=P.Yc(a);return e};',
  'W["warlight.shared.GameState"]=Gt;Gt.Ha=function(a){return P.uq(a)};',
  'W["warlight.shared.GamePlayerState"]=Ps;Ps.Ha=function(a){return P.uq(a)};',
  'Fg.Ha=function(a){return P.uq(a)};',
  'W["warlight.shared.GameInfoSettings"]=Sx;',
  'Sx.Ha=function(a,b,d){var e=new Sx;e.s1=a.Ua()?new uc(P.ak(a)):new uc;e.s2=P.Yc(a);e.s3=P.Ya(a);e.s4=P.wc(a);' +
    'e.s5=P.Yc(a);e.s6=P.Yc(a);e.s7=a.Ua()?new Z(P.Ya(a)):new Z;e.s8=P.ak(a);e.s9=P.Yc(a);e.t1=P.Ya(a);e.t2=P.Yc(a);' +
    'e.t3=P.Yc(a);e.t4=P.uy(a);e.t5=P.Yc(a);e.t6=P.ak(a);e.t7=P.Ya(a);e.t8=Mo.Ha(a,b);e.t9=P.Yc(a);e.u1=P.Yc(a);' +
    'e.u2=P.Ya(a);e.u3=P.ak(a);e.u4=P.Yc(a);e.u5=P.Yc(a);e.u6=Rm.Ha(a,b);return e};',
  'Mo.Ha=function(a){return P.uq(a)};Rm.Ha=function(a){return P.uq(a)};',
  'Ox.Ha=function(a,b,d){var e=new Ox;e.o1=P.Ya(a);return e};',
  'W["warlight.shared.GameColor"]=Cl;Cl.Ha=function(a,b,d){var e=new Cl;e.k=P.Ya(a);return e};',
  // Player: 33 fields; the 19th (index 18) is the secondary colour, the 33rd (index 32) the preferred.
  'W["warlight.shared.Player"]=Pr;',
  'Pr.Ha=function(a,b,d){var e=new Pr;' +
    Array.from({ length: 33 }, (_, i) =>
      i === 18 || i === 32 ? `e.f${i}=a.Ua()?Cl.Ha(a,e,d):null;` : `e.f${i}=P.Ya(a);`,
    ).join('') +
    'return e};',
  'W["warlight.shared.InitParameters"]=Ip;',
  'Ip.Ha=function(a,b,d){var e=new Ip;e.i1=a.Ua()?P.Sd(a,function(){return P.Ya(a)}):null;e.i2=P.wc(a);' +
    'e.i3=a.Ua()?Pr.Ha(a,e,d):null;e.i4=P.Yc(a);e.i5=P.wc(a);return e};',
].join('\n');

export interface SyntheticGamePlayer {
  /** In-game player id. */
  id: number;
  name: string;
  /** GamePlayerState code (2 = Playing). */
  state: number;
  committed: boolean;
  /** -1 = no team. */
  team?: number;
  /** The player's GameColor index; absent by default. */
  color?: number | null;
}

/** GameInfoSettings, in read order (defaults: war.app's defaults, nothing unusual). */
export interface SyntheticSettings {
  armyCap?: number | null;
  autoDist?: boolean;
  bonusArmiesPer?: number;
  /** `3;<f|r>;<card ids>;<p|b>;<o|p>;<m|n>`. */
  settingsString?: string;
  attackOnly?: boolean;
  transferOnly?: boolean;
  commerce?: number | null;
  defensiveKillRate?: number;
  distribution?: number;
  commanders?: boolean;
  overriddenBonuses?: boolean;
  bankingBootMs?: number;
  localDeployments?: boolean;
  luck?: number;
  minArmies?: number;
  multiAttack?: boolean;
  noSplit?: boolean;
  wastelands?: number;
  offensiveKillRate?: number;
  oneArmyStandsGuard?: boolean;
  /** false = a practice game. */
  ranked?: boolean;
  roundingMode?: number;
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
  randomTeamsOf?: number;
  entryFee?: number;
  prize?: number;
  /** Boot time, TimeSpan milliseconds. */
  bootTimeMs?: number;
  /** Mega-game player cap. */
  maxPlayers?: number | null;
  /** The team of each open seat (-1 = no team). */
  openSeats?: number[] | null;
  realTime?: boolean;
  /** `null`: no settings record. */
  settings?: SyntheticSettings | null;
}

function writePlayer(w: Writer, p: SyntheticGamePlayer): void {
  if (p.color === undefined || p.color === null) w.bool(false);
  else w.bool(true).int32(p.color); // GameColor
  w.bool(false).bool(p.committed).int32(0).bool(false).string(p.name).int32(p.id).u8(p.state).int32(p.team ?? -1).bool(false);
}

function writeOptionalInt(w: Writer, v: number | null | undefined): void {
  if (v === null || v === undefined) w.bool(false);
  else w.bool(true).int32(v);
}

/** A GameInfoSettings record, as the synthetic bundle reads it. */
export function writeSettings(w: Writer, s: SyntheticSettings = {}): void {
  if (s.armyCap === null || s.armyCap === undefined) w.bool(false);
  else w.bool(true).float64(s.armyCap);
  w.bool(s.autoDist ?? true).int32(s.bonusArmiesPer ?? 0).string(s.settingsString ?? '3;r;;p;p;n');
  w.bool(s.attackOnly ?? false).bool(s.transferOnly ?? false);
  writeOptionalInt(w, s.commerce);
  w.float64(s.defensiveKillRate ?? 0.7).bool(false).int32(s.distribution ?? 0);
  w.bool(s.commanders ?? false).bool(s.overriddenBonuses ?? false).float64(s.bankingBootMs ?? 0);
  w.bool(s.localDeployments ?? false).float64(s.luck ?? 0).int32(s.minArmies ?? 5).u8(1);
  w.bool(s.multiAttack ?? false).bool(s.noSplit ?? false).int32(s.wastelands ?? 0);
  w.float64(s.offensiveKillRate ?? 0.6).bool(s.oneArmyStandsGuard ?? false).bool(s.ranked ?? true);
  w.u8(s.roundingMode ?? 1);
}

/** One GameInfo record (no present flag), as the synthetic bundle reads it. */
export function writeGameInfo(w: Writer, g: SyntheticGame): void {
  w.int32(g.randomTeamsOf ?? 0).float64(0).string('synthetic').int32(g.entryFee ?? 0).int32(g.prize ?? 0);
  w.float64(g.bootTimeMs ?? 259_200_000).u8(1);
  w.int32(g.id).bool(false).date(null).int32(g.mapId ?? 39905).int32(0);
  writeOptionalInt(w, g.maxPlayers === undefined ? 7 : g.maxPlayers);
  w.string(g.name).int32(g.lastTurn);
  const seats = g.openSeats === undefined ? [1, 2] : g.openSeats;
  if (seats === null) w.bool(false);
  else w.bool(true).list(seats, (ww, n) => ww.int32(n));
  if (g.players === null) w.bool(false);
  else w.bool(true).list(g.players, writePlayer);
  w.bool(false).bool(false).bool(g.realTime ?? false).bool(false);
  if (g.settings === null) w.bool(false);
  else writeSettings(w.bool(true), g.settings ?? {});
  w.u8(g.state).bool(false).float64(0).bool(false).float64(0);
}

/** The result of GetMyGames (present flag first), as the synthetic bundle reads it. */
export function writeMyGamesReturn(w: Writer, games: readonly SyntheticGame[] | null): void {
  w.bool(true);
  if (games === null) w.bool(false);
  else w.bool(true).list(games, (ww, g) => writeGameInfo(ww.bool(true), g));
  w.int32(0);
}

/** The signed-in account in a page's startup parameters (synthetic). */
export interface SyntheticAccount {
  /** An auth-like string the page carries before the account; never reported. */
  secret?: string;
  /** The account's preferred colour; `null`/absent: none set. */
  preferred?: number | null;
  /** The account's secondary colour; `null`/absent: none set. */
  secondary?: number | null;
  /** No Player record at all (a signed-out page). */
  signedOut?: boolean;
}

/** An InitParameters record (no present flag), as the synthetic bundle reads it. */
export function writeInitParameters(w: Writer, a: SyntheticAccount = {}): void {
  w.bool(true).list([1, 2], (ww, n) => ww.int32(n)).string(a.secret ?? 'test@example.com');
  if (a.signedOut) w.bool(false);
  else {
    w.bool(true);
    for (let i = 0; i < 33; i++) {
      if (i === 18 || i === 32) writeOptionalInt(w, i === 18 ? a.secondary : a.preferred);
      else w.int32(1000 + i);
    }
  }
  w.bool(false).string('OpenGames');
}
