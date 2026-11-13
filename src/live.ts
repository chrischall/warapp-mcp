// The live board: a GetLatestGameInfo reply, decoded by the client bundle's own
// readers, turned into territory standings — and from there into the
// source-agnostic BoardState the analysis core takes.
//
// Field names in the bundle are minified and change between releases, so
// nothing here keys on them. Classes are found by their stable registered type
// name (`$type`), and a TerritoryStanding's fields by read order — verified
// through the bridge (docs/WEB-PROTOCOL.md): fog level, territory id, Armies,
// owner. The territory id also keys the standing's dict, which is checked, so a
// reordered layout is an error rather than a silently wrong board. An Armies
// record carries its special units (commanders, bosses) as a list; every unit
// class ends with the shared fields GUID, owner (read from the bundle, #61).

import { McpToolError } from '@chrischall/mcp-utils';
import type { BoardSpecialUnit, BoardState, TerritoryOwner, TerritoryState } from './board.js';
import type { Player } from './normalize.js';
import type { DecoderReport } from './protocol/bundle.js';
import type { Reader } from './protocol/codec.js';
import type { ReadBudget } from './protocol/interp.js';

export const LATEST_GAME_INFO = 'warlight.shared.LatestGameInfo';
export const GAME_STANDING = 'warlight.shared.GameStanding';
export const TERRITORY_STANDING = 'warlight.shared.TerritoryStanding';
export const ARMIES = 'warlight.shared.Armies';
export const COMMANDER = 'warlight.shared.Commander';

/** What a special unit is: the registered unit classes, by kind. */
export type SpecialUnitKind = BoardSpecialUnit['kind'];

const UNIT_KINDS: Readonly<Record<string, SpecialUnitKind>> = {
  [COMMANDER]: 'commander',
  'warlight.shared.Boss1': 'boss',
  'warlight.shared.Boss2': 'boss',
  'warlight.shared.Boss3': 'boss',
  'warlight.shared.Boss4': 'boss',
  'warlight.shared.CustomSpecialUnit': 'custom',
};

/** A special unit on a territory, as the standing has it. */
export interface LiveSpecialUnit {
  kind: SpecialUnitKind;
  /** The unit's GUID (32 hex digits). */
  id: string;
  /** In-game id of the player the unit belongs to. */
  owner: number;
  /** The registered class name, kept only when the kind is `unknown`. */
  type?: string;
}

/** TerritoryStanding owner values that are not players. */
export const OWNER_NEUTRAL = 0;
export const OWNER_PICKABLE = -2;

/**
 * StandingFogLevel, as the client bundle names it (verified 2026-11-12): 1 You (my own
 * territory), 2 Visible, 3 OwnerOnly (owner shown, armies hidden), 4 Fogged. The client
 * refuses a deploy on 3 or 4 as "on fogged territory"; a fully fogged standing is
 * fog level 4, owner -1 and `Armies(0, fogged)`.
 */
export const FOG_LEVEL_NAMES: Readonly<Record<number, string>> = { 1: 'You', 2: 'Visible', 3: 'OwnerOnly', 4: 'Fogged' };
export const FOG_LEVEL_YOU = 1;
export const FOG_LEVEL_VISIBLE = 2;
export const FOG_LEVEL_OWNER_ONLY = 3;
export const FOG_LEVEL_FOGGED = 4;
const KNOWN_FOG_LEVELS: ReadonlySet<number> = new Set([FOG_LEVEL_YOU, FOG_LEVEL_VISIBLE, FOG_LEVEL_OWNER_ONLY, FOG_LEVEL_FOGGED]);

/** One territory as the viewer's standing has it. */
export interface LiveTerritory {
  territoryId: number;
  fogLevel: number;
  /** Hidden by fog (fog level 4): owner and armies are not evidence. An owner-only (3) standing is not fogged: its owner shows. */
  fogged: boolean;
  /** Raw owner: an in-game player id, {@link OWNER_NEUTRAL}, {@link OWNER_PICKABLE}, or negative when hidden. */
  owner: number;
  /** Army count, `null` when fogged. */
  armies: number | null;
  /** Special units (commanders, bosses) on the territory; absent when there are none or it is fogged. */
  specialUnits?: LiveSpecialUnit[];
}

/** Reads a registered class from the reply (a loaded `WarappBundle`). */
export interface ClassReader {
  /** `budget`, when given, is one step budget shared by every read of the same reply. */
  readClass(typeName: string, reader: Reader, budget?: ReadBudget): unknown;
  /** The fields a class's reader fills from another class, in read order (a loaded bundle has it). */
  fieldsReadAs?(ownerType: string, fieldType: string): string[];
  /** What the decoding rests on: version, stand-in flag, reader-helper check (a loaded bundle has it). */
  report?(): DecoderReport;
}

/** On a decoded LatestGameInfo: the name of its CURRENT standing's field, from the bundle's reader. */
const CURRENT_STANDING_FIELD = Symbol('currentStandingField');

/** The live standing arrived in a shape this server does not understand. */
export class LiveBoardFormatError extends McpToolError {
  constructor(detail: string) {
    super(`war.app's live board arrived in an unexpected shape (${detail}).`, {
      kind: 'unknown',
      hint: 'The war.app client may have changed. warapp_get_map and warapp_plan_route work without a board.',
    });
    this.name = 'LiveBoardFormatError';
  }
}

type Obj = Record<string, unknown> & { $type?: unknown };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const fields = (o: Obj): unknown[] => Object.entries(o).filter(([k]) => k !== '$type').map(([, v]) => v);
const isType = (v: unknown, type: string): v is Obj => isObj(v) && v.$type === type;

/** `[key, value]` pairs of a decoded dict, or the items of a list. */
function entries(v: unknown): Array<{ key?: unknown; value: unknown }> | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((item) =>
    Array.isArray(item) && item.length === 2 ? { key: item[0], value: item[1] } : { value: item },
  );
}

const GUID = /^[0-9a-f]{32}$/i;

/** One decoded special unit: its class names the kind; GUID and owner are its last two fields. */
function specialUnitOf(u: unknown): LiveSpecialUnit {
  if (!isObj(u) || typeof u.$type !== 'string') throw new LiveBoardFormatError('a special unit is not a unit');
  const values = fields(u);
  const [id, owner] = values.slice(-2);
  if (typeof id !== 'string' || !GUID.test(id) || typeof owner !== 'number') {
    throw new LiveBoardFormatError(`a special unit (${u.$type}) lacks its GUID and owner`);
  }
  const kind = UNIT_KINDS[u.$type] ?? 'unknown';
  return kind === 'unknown' ? { kind, type: u.$type, id, owner } : { kind, id, owner };
}

function territoryOf(key: unknown, ts: Obj): LiveTerritory {
  const values = fields(ts);
  const ints = values.filter((v): v is number => typeof v === 'number');
  const armies = values.find((v) => isType(v, ARMIES));
  if (ints.length < 3 || !armies) throw new LiveBoardFormatError('a territory standing lacks its fields');
  const [fogLevel, territoryId, owner] = ints as [number, number, number];
  if (typeof key === 'number' && key !== territoryId) {
    throw new LiveBoardFormatError(`territory standing ${key} reads as territory ${territoryId}`);
  }
  // A constructor the interpreter could not run (the client changed how it builds Armies) leaves
  // a half-built record: its count would be a default, not the territory's armies (#131).
  if (typeof armies.$ctorError === 'string') {
    throw new LiveBoardFormatError(`territory ${territoryId}'s armies: the client's Armies constructor failed (${armies.$ctorError})`);
  }
  const armyFields = fields(armies);
  const armyFogged = armyFields.find((v) => typeof v === 'boolean') === true;
  // The count is the record's one number (verified 2026-11-13: fogged flag, count, units). A second
  // number means the client added a field, and nothing here can tell which is the count: refuse,
  // rather than read the wrong one as every territory's armies (#148).
  const numbers = armyFields.filter((v) => typeof v === 'number');
  if (numbers.length > 1) {
    throw new LiveBoardFormatError(`territory ${territoryId}'s Armies record carries ${numbers.length} numbers, so its army count cannot be told`);
  }
  const count = numbers[0];
  // The fog level alone says whether the owner shows: Light Fog's owner-only standings (3) carry a
  // real owner under an Armies record marked fogged (#131). A level this server does not know
  // falls back to the Armies' flag.
  const fogged = KNOWN_FOG_LEVELS.has(fogLevel) ? fogLevel === FOG_LEVEL_FOGGED : armyFogged;
  // Owner-only: the owner shows, any army count is a placeholder (#69).
  const armiesHidden = fogged || armyFogged || fogLevel === FOG_LEVEL_OWNER_ONLY;
  if (!armiesHidden && typeof count !== 'number') {
    throw new LiveBoardFormatError(`visible territory ${territoryId} has no army count`);
  }
  const out: LiveTerritory = {
    territoryId,
    fogLevel,
    fogged,
    owner,
    armies: armiesHidden || typeof count !== 'number' ? null : count,
  };
  const units = armyFields.find((v): v is unknown[] => Array.isArray(v));
  if (!armiesHidden && units?.length) out.specialUnits = units.map(specialUnitOf);
  return out;
}

/**
 * Read a GetLatestGameInfo result (the body positioned at the result-present
 * flag). Returns the territories, or `null` when war.app sent no standing (no
 * result, or a game with no board yet).
 */
export function readLiveStanding(bundle: ClassReader, body: Reader): LiveTerritory[] | null {
  return standingFromInfo(readLatestGameInfo(bundle, body));
}

/**
 * Decode a GetLatestGameInfo result (the body positioned at the result-present
 * flag) into the bundle's LatestGameInfo object; `null` when war.app sent no result.
 */
export function readLatestGameInfo(bundle: ClassReader, body: Reader): unknown {
  if (!body.bool()) return null;
  const info = bundle.readClass(LATEST_GAME_INFO, body);
  if (!isObj(info)) throw new LiveBoardFormatError('no LatestGameInfo');
  // The result is the whole body: bytes left over mean the readers and the reply disagree
  // on the layout, so what was read cannot be trusted (#131).
  if (body.remaining !== 0) throw new LiveBoardFormatError(`${body.remaining} bytes left unread after the LatestGameInfo`);
  if (bundle.fieldsReadAs) {
    const current = bundle.fieldsReadAs(LATEST_GAME_INFO, GAME_STANDING)[0];
    // The info carries the current standing and the previous turn's. When the reader's source does
    // not show which field is the current one (read in another class, through a closure or an
    // own-class helper this check does not follow), the first one present could be last turn's:
    // refuse rather than guess (#148).
    if (current === undefined) {
      throw new LiveBoardFormatError("the client's reader does not show which field holds the current standing, so last turn's could be read in its place");
    }
    Object.defineProperty(info, CURRENT_STANDING_FIELD, { value: current });
  }
  return info;
}

/**
 * The CURRENT GameStanding of a decoded LatestGameInfo: the first field its reader fills
 * from GameStanding (verified 2026-11-12, #20 — the info also carries the previous turn's
 * standing, later in field order). When the bundle named that field, a withheld (null)
 * current standing is `undefined` — never last turn's standing in its place (#131);
 * otherwise the first GameStanding present. `undefined` when there is none; never throws.
 */
export function currentStanding(info: unknown): Obj | undefined {
  if (!isObj(info)) return undefined;
  const field = (info as { [CURRENT_STANDING_FIELD]?: string })[CURRENT_STANDING_FIELD];
  if (field !== undefined) {
    const v = info[field];
    return isType(v, GAME_STANDING) ? v : undefined;
  }
  return fields(info).find((v): v is Obj => isType(v, GAME_STANDING));
}

/** The territories of a decoded LatestGameInfo; `null` when it carries no standing. */
export function standingFromInfo(info: unknown): LiveTerritory[] | null {
  const standing = currentStanding(info);
  if (!standing) return null;
  for (const v of fields(standing)) {
    const list = entries(v);
    if (!list?.length || !list.some((e) => isType(e.value, TERRITORY_STANDING))) continue;
    const territories = list
      .filter((e) => isType(e.value, TERRITORY_STANDING))
      .map((e) => territoryOf(e.key, e.value as Obj));
    checkArmies(territories);
    return territories;
  }
  return null;
}

/**
 * A board-wide sanity check on the army counts, one that a misread count cannot pass by accident
 * (#148): when every territory of mine (fog level You) reads 0 armies, the count was read from the
 * wrong field. A single empty territory of mine is possible (a commander standing alone, or a game
 * without "one army stands guard"), so it proves nothing: a territory carrying a special unit is left
 * out, and the check needs at least two of mine. Two or more all empty is not a board war.app sends.
 */
function checkArmies(territories: readonly LiveTerritory[]): void {
  const mine = territories.filter((t) => t.fogLevel === FOG_LEVEL_YOU && t.armies !== null && !t.specialUnits?.length);
  if (mine.length >= 2 && mine.every((t) => t.armies === 0)) {
    throw new LiveBoardFormatError(
      `every territory of yours reads 0 armies (${mine.length} of them), so the army count was not read from the right field (if the board in war.app really shows 0 on all of them, e.g. with one-army-stands-guard off, report it: this check assumes that cannot happen)`,
    );
  }
}

/**
 * A player's in-game id: GameFeed (and invite tokens) wrap it in two leading
 * and two trailing check digits that vary per player — `id[2:-2]`.
 */
export function inGameId(player: Pick<Player, 'id' | 'feedId'>): number {
  const text = player.feedId ?? String(player.id);
  if (!/^\d{5,}$/.test(text)) {
    throw new McpToolError(`Player id ${text} is not a GameFeed player id (expected 5 or more digits).`, {
      kind: 'unknown',
    });
  }
  return Number(text.slice(2, -2));
}

/** In-game id → GameFeed player, for the players whose ids can be derived. */
export function playersByInGameId(players: readonly Player[]): Map<number, Player> {
  const out = new Map<number, Player>();
  for (const p of players) {
    try {
      out.set(inGameId(p), p);
    } catch {
      // Not a wrapped id (e.g. an AI slot): it cannot own a standing entry by it.
    }
  }
  return out;
}

/** The owner as the analysis core sees it, players keyed by GameFeed id. */
export function ownerOf(t: LiveTerritory, players: ReadonlyMap<number, Player>): TerritoryOwner {
  if (t.fogged) return { kind: 'unknown' };
  if (t.owner === OWNER_NEUTRAL) return { kind: 'neutral' };
  if (t.owner === OWNER_PICKABLE) return { kind: 'available' };
  if (t.owner > 0) return { kind: 'player', playerId: players.get(t.owner)?.id ?? t.owner };
  return { kind: 'unknown' };
}

/** The live standing as a BoardState (verified through the bridge). */
export function toBoardState(territories: readonly LiveTerritory[], players: readonly Player[]): BoardState {
  const byInGame = playersByInGameId(players);
  return {
    source: 'browser',
    verified: true,
    territories: territories.map((t) => {
      const out: TerritoryState = {
        territoryId: t.territoryId,
        owner: ownerOf(t, byInGame),
        // territoryOf already nulls these; kept for a LiveTerritory built elsewhere.
        armies: t.fogLevel === FOG_LEVEL_OWNER_ONLY ? null : t.armies,
        fogLevel: FOG_LEVEL_NAMES[t.fogLevel] ?? String(t.fogLevel),
      };
      if (t.specialUnits?.length) {
        out.specialUnits = t.specialUnits.map((u) => ({
          kind: u.kind,
          id: u.id,
          playerId: byInGame.get(u.owner)?.id ?? u.owner,
        }));
      }
      return out;
    }),
  };
}

/**
 * The live standing as the analysis `BoardState`, seen by `me`: my territories
 * are keyed by my GameFeed id (the id the planner takes as `me`), other known
 * players by theirs, unknown players by their in-game id. Fogged territories
 * are owner `unknown` with `null` armies.
 */
export function boardStateFromLive(
  territories: readonly LiveTerritory[],
  me: Player,
  players: readonly Player[] = [],
): BoardState {
  return toBoardState(territories, [...players.filter((p) => p.id !== me.id), me]);
}
