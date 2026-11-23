// The "Diplomacy 2" mod's alliances (mod 191), read from the game details. UNVERIFIED live: no game this
// account plays had an alliance to read on 2026-11-23 (the one mod-191 game was a lobby, where the mod
// had written nothing yet).
//
// Where the data lives (read from the client bundle; the location VERIFIED live 2026-11-23 on a lobby, with
// another mod's table in it): GameRefresh (40) asked with `nonChat` answers `GameDetailsAndChat`, whose
// fourth field (0-based 3) is MY player data of each mod (a dict of mod id → XML text, the client's
// `Mod.PlayerGameData`), and whose game (`GameWL`, field 1) carries every mod's public data at field 8
// (the same dict shape, `Mod.PublicGameData`). The XML is the client's mod-table format (src/mod-data.ts).
//
// What the mod keeps (its published source, FizzerWL/ExampleMods `Diplomacy2Mod`; that the mod running
// as 191 is that source is UNVERIFIED):
//   - public `Alliances`: a Lua array of { ID, PlayerOne (the proposer), PlayerTwo (who accepted) }, in-game
//     player ids. No turn is kept: `ID` (from the mod's one counter, shared with proposals) orders them.
//   - my `PendingProposals`: proposals TO me only ({ ID, PlayerOne = from, PlayerTwo = me }); a proposal I
//     sent sits in the other player's private data, which I cannot read.
//   - my `Alerts`: { ID, Message } — "<name> has broken their alliance with you", until the web client shows them.
// Its rules: an attack (GameOrderAttackTransfer) between two players allied at the START of the turn is
// skipped by the game, both ways; a break is a custom order in the breaker's own orders
// ("Diplomacy2_BreakAlliance_<other in-game id>"), applied at the END of that turn — so the alliance holds
// through the turn the break is entered, and either side can attack from the next. Nobody but the breaker
// can see a break before it applies. Bombs and other cards are not stopped by it.
//
// Pure. Never throws: a shape this server does not understand is `undefined` (unknown).

import type { ClassReader } from './live.js';
import type { Reader } from './protocol/codec.js';
import { fields, isObj } from './protocol/decoded.js';
import { GAME_DETAILS_AND_CHAT } from './chat.js';
import { GAME_WL, GAME_WL_FIELDS } from './surrender-pending.js';
import { intField, luaArray, parseModTable, type ModTable, type ModValue } from './mod-data.js';

/** The "Diplomacy 2" mod's id (GameFeed settings `Mods[].ModID`, VERIFIED live on game 45736172's settings). */
export const DIPLOMACY2_MOD_ID = 191;
/** The custom-order payload of a break, before the other player's in-game id. */
export const BREAK_PAYLOAD_PREFIX = 'Diplomacy2_BreakAlliance_';

/** GameDetailsAndChat: where my mod data is (0-based, read order). */
const GDC_PLAYER_MOD_DATA = 3;
/** GameWL: where the public mod data is (0-based, read order). */
const GW_PUBLIC_MOD_DATA = 8;

/** Every mod's stored data in one game-details read: mod id → XML text. */
export interface ModDataRead {
  /** `Mod.PublicGameData` per mod (absent mod: it stored nothing). */
  public: Map<number, string>;
  /** My `Mod.PlayerGameData` per mod. */
  mine: Map<number, string>;
}

/** A dict of int → string as decoded (pairs), `null` read as empty; `undefined` when it is not one. */
function intStringDict(v: unknown): Map<number, string> | undefined {
  if (v === null) return new Map();
  if (!Array.isArray(v)) return undefined;
  const out = new Map<number, string>();
  for (const pair of v) {
    if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0])) return undefined;
    if (pair[1] === null) continue;
    if (typeof pair[1] !== 'string') return undefined;
    out.set(pair[0] as number, pair[1]);
  }
  return out;
}

/**
 * The mod data of a GameRefresh reply asked with `nonChat` (the body at the result-present flag);
 * `undefined` without a result or game, or in a shape this server does not know. Never throws.
 */
export function readModData(bundle: ClassReader, body: Reader): ModDataRead | undefined {
  try {
    if (!body.bool()) return undefined;
    const ret = bundle.readClass(GAME_DETAILS_AND_CHAT, body);
    if (!isObj(ret) || ret.$type !== GAME_DETAILS_AND_CHAT) return undefined;
    const rf = fields(ret);
    const game = rf[1];
    if (!isObj(game) || game.$type !== GAME_WL) return undefined;
    const gf = fields(game);
    if (gf.length !== GAME_WL_FIELDS) return undefined;
    const pub = intStringDict(gf[GW_PUBLIC_MOD_DATA]);
    const mine = rf.length > GDC_PLAYER_MOD_DATA ? intStringDict(rf[GDC_PLAYER_MOD_DATA]) : undefined;
    if (!pub || !mine) return undefined;
    return { public: pub, mine };
  } catch {
    return undefined;
  }
}

/** One alliance as the mod keeps it (in-game ids). */
export interface ModAlliance {
  /** The mod's id: alliances and proposals share one counter, so it orders them. */
  id: number;
  /** Who proposed it. */
  proposer: number;
  /** Who accepted it. */
  accepter: number;
}

/** A proposal waiting for my answer (in-game ids). */
export interface ModProposal {
  id: number;
  from: number;
}

/** An alert the mod left for me (its text: other players' names, untrusted). */
export interface ModAlert {
  id: number;
  message: string;
}

/** What Diplomacy 2 holds that I can read. */
export interface Diplomacy2State {
  alliances: ModAlliance[];
  proposalsToMe: ModProposal[];
  alerts: ModAlert[];
}

const tableOrEmpty = (xml: string | undefined): ModTable | undefined => (xml === undefined ? new Map() : parseModTable(xml));

/** The entries of an optional Lua array field; `undefined` when it is there but not an array of tables. */
function records(t: ModTable, key: string): ModTable[] | undefined {
  const v: ModValue | undefined = t.get(key);
  if (v === undefined || v === null) return [];
  const list = luaArray(v);
  if (!list?.every((x): x is ModTable => x instanceof Map)) return undefined;
  return list;
}

/**
 * Diplomacy 2's state from one read (`undefined`: a table this server does not understand). No data for
 * the mod means it stored nothing yet: no alliance, proposal or alert.
 */
export function diplomacy2From(read: ModDataRead): Diplomacy2State | undefined {
  const pub = tableOrEmpty(read.public.get(DIPLOMACY2_MOD_ID));
  const mine = tableOrEmpty(read.mine.get(DIPLOMACY2_MOD_ID));
  if (!pub || !mine) return undefined;
  const a = records(pub, 'Alliances');
  const p = records(mine, 'PendingProposals');
  const al = records(mine, 'Alerts');
  if (!a || !p || !al) return undefined;
  const alliances: ModAlliance[] = [];
  for (const r of a) {
    const id = intField(r, 'ID');
    const proposer = intField(r, 'PlayerOne');
    const accepter = intField(r, 'PlayerTwo');
    if (id === undefined || proposer === undefined || accepter === undefined) return undefined;
    alliances.push({ id, proposer, accepter });
  }
  const proposalsToMe: ModProposal[] = [];
  for (const r of p) {
    const id = intField(r, 'ID');
    const from = intField(r, 'PlayerOne');
    if (id === undefined || from === undefined) return undefined;
    proposalsToMe.push({ id, from });
  }
  const alerts: ModAlert[] = [];
  for (const r of al) {
    const id = intField(r, 'ID');
    const message = r.get('Message');
    if (id === undefined || typeof message !== 'string') return undefined;
    alerts.push({ id, message });
  }
  return { alliances, proposalsToMe, alerts };
}

/**
 * The players my own orders this turn break an alliance with (in-game ids): every `GameOrderCustom` in the
 * decoded order list carrying the mod's break payload. Its field layout is not read: any string field with
 * the payload counts. `[]` for none.
 */
export function breaksInOrders(orders: readonly unknown[]): number[] {
  const out = new Set<number>();
  for (const o of orders) {
    if (!isObj(o) || typeof o.$type !== 'string' || !o.$type.endsWith('GameOrderCustom')) continue;
    for (const v of fields(o)) {
      if (typeof v !== 'string' || !v.startsWith(BREAK_PAYLOAD_PREFIX)) continue;
      const id = Number(v.slice(BREAK_PAYLOAD_PREFIX.length));
      if (Number.isInteger(id) && id > 0) out.add(id);
    }
  }
  return [...out].sort((x, y) => x - y);
}

/** One pair as `warapp_get_mod_alliances` reports it (in-game ids). */
export interface ModPair {
  players: [number, number];
  /**
   * `allied`: in force (attacks between them are skipped this turn); `breaking`: in force this turn, my break
   * order is entered and it is gone from `endsTurn`; `pending`: a proposal to me, not yet answered.
   */
  state: 'allied' | 'breaking' | 'pending';
  proposer: number;
  /** The mod's counter (alliances and proposals share it): the order they were made in. No turn is kept. */
  id: number;
  /** `breaking`: the first turn either side can attack. */
  endsTurn?: number;
}

/** Every pair, alliances first (by id), then proposals to me. `turn`: this turn; `breaksByMe`: in-game ids. */
export function modPairs(state: Diplomacy2State, me: number | undefined, turn: number | null, breaksByMe: readonly number[] = []): ModPair[] {
  const out: ModPair[] = [];
  for (const a of [...state.alliances].sort((x, y) => x.id - y.id)) {
    const other = a.proposer === me ? a.accepter : a.accepter === me ? a.proposer : undefined;
    const breaking = other !== undefined && breaksByMe.includes(other) && turn !== null;
    out.push({
      players: [a.proposer, a.accepter],
      state: breaking ? 'breaking' : 'allied',
      proposer: a.proposer,
      id: a.id,
      ...(breaking ? { endsTurn: turn! + 1 } : {}),
    });
  }
  for (const p of [...state.proposalsToMe].sort((x, y) => x.id - y.id)) {
    if (me === undefined) continue;
    out.push({ players: [p.from, me], state: 'pending', proposer: p.from, id: p.id });
  }
  return out;
}

/** My allies (in-game ids), ascending. */
export function myAllies(state: Diplomacy2State, me: number): number[] {
  const out = new Set<number>();
  for (const a of state.alliances) {
    if (a.proposer === me && a.accepter !== me) out.add(a.accepter);
    else if (a.accepter === me && a.proposer !== me) out.add(a.proposer);
  }
  return [...out].sort((x, y) => x - y);
}

/** The alerts that report a break of an alliance with me (the mod's own wording). */
export const breakAlerts = (state: Diplomacy2State): ModAlert[] =>
  state.alerts.filter((a) => / has broken their alliance with you$/.test(a.message));

/** Whether a game's mods (GameFeed settings, `modIds`) include Diplomacy 2. */
export const runsDiplomacy2 = (modIds: readonly number[] | undefined): boolean => (modIds ?? []).includes(DIPLOMACY2_MOD_ID);

/** One attack of mine on an ally (the game skips it). */
export interface AllyAttack {
  /** The move's index in the list given. */
  index: number;
  from: number;
  to: number;
  /** The ally (whatever id space the caller's owners use). */
  ally: number;
}

/**
 * The moves that attack a territory an ally holds at the start of the turn (`ownerAt`: the owner on this
 * turn's board, `undefined` when hidden or not a player). A transfer-only move attacks nothing. Pure.
 */
export function allyAttacksIn(
  moves: readonly { from: number; to: number; mode?: string }[],
  allies: ReadonlySet<number>,
  ownerAt: (territory: number) => number | undefined,
): AllyAttack[] {
  if (!allies.size) return [];
  return moves.flatMap((m, index) => {
    if (m.mode === 'transfer-only') return [];
    const owner = ownerAt(m.to);
    return owner !== undefined && allies.has(owner) ? [{ index, from: m.from, to: m.to, ally: owner }] : [];
  });
}

/** A difference between the mod's alliances and the agreement ledger (GameFeed ids). */
export interface AllianceMismatch {
  player: number;
  /** `mod-only`: allied in the mod, no live agreement recorded; `ledger-only`: a live agreement, no mod alliance. */
  kind: 'mod-only' | 'ledger-only';
  /** The ledger's agreement (`ledger-only`). */
  agreement?: string;
}

/**
 * Where the mod and the ledger disagree: an ally with no agreement active or in notice, and an agreement active
 * or in notice with a player the mod does not ally me with. By player, then kind. Pure.
 */
export function allianceMismatches(
  allies: readonly number[],
  live: readonly { id: string; with: number }[],
): AllianceMismatch[] {
  const allied = new Set(allies);
  const recorded = new Set(live.map((a) => a.with));
  const out: AllianceMismatch[] = [
    ...[...allied].filter((p) => !recorded.has(p)).map((player) => ({ player, kind: 'mod-only' as const })),
    ...live.filter((a) => !allied.has(a.with)).map((a) => ({ player: a.with, kind: 'ledger-only' as const, agreement: a.id })),
  ];
  return out.sort((x, y) => x.player - y.player || x.kind.localeCompare(y.kind));
}
