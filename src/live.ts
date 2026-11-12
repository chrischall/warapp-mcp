// The live board: a GetLatestGameInfo reply, decoded by the client bundle's own
// readers, turned into territory standings — and from there into the
// source-agnostic BoardState the analysis core takes.
//
// Field names in the bundle are minified and change between releases, so
// nothing here keys on them. Classes are found by their stable registered type
// name (`$type`), and a TerritoryStanding's fields by read order — verified
// through the bridge (docs/WEB-PROTOCOL.md): fog level, territory id, Armies,
// owner. The territory id also keys the standing's dict, which is checked, so a
// reordered layout is an error rather than a silently wrong board.

import { McpToolError } from '@chrischall/mcp-utils';
import type { BoardState, TerritoryOwner } from './board.js';
import type { Player } from './normalize.js';
import type { Reader } from './protocol/codec.js';

export const LATEST_GAME_INFO = 'warlight.shared.LatestGameInfo';
export const GAME_STANDING = 'warlight.shared.GameStanding';
export const TERRITORY_STANDING = 'warlight.shared.TerritoryStanding';
export const ARMIES = 'warlight.shared.Armies';

/** TerritoryStanding owner values that are not players. */
export const OWNER_NEUTRAL = 0;
export const OWNER_PICKABLE = -2;

/** StandingFogLevel. */
export const FOG_LEVEL_NAMES: Readonly<Record<number, string>> = { 1: 'Visible', 2: 'OwnerOnly', 4: 'Fogged' };
export const FOG_LEVEL_FOGGED = 4;

/** One territory as the viewer's standing has it. */
export interface LiveTerritory {
  territoryId: number;
  fogLevel: number;
  /** Hidden by fog: owner and armies are not evidence. */
  fogged: boolean;
  /** Raw owner: an in-game player id, {@link OWNER_NEUTRAL}, {@link OWNER_PICKABLE}, or negative when hidden. */
  owner: number;
  /** Army count, `null` when fogged. */
  armies: number | null;
}

/** Reads a registered class from the reply (a loaded `WarappBundle`). */
export interface ClassReader {
  readClass(typeName: string, reader: Reader): unknown;
}

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

function territoryOf(key: unknown, ts: Obj): LiveTerritory {
  const values = fields(ts);
  const ints = values.filter((v): v is number => typeof v === 'number');
  const armies = values.find((v) => isType(v, ARMIES));
  if (ints.length < 3 || !armies) throw new LiveBoardFormatError('a territory standing lacks its fields');
  const [fogLevel, territoryId, owner] = ints as [number, number, number];
  if (typeof key === 'number' && key !== territoryId) {
    throw new LiveBoardFormatError(`territory standing ${key} reads as territory ${territoryId}`);
  }
  const armyFields = fields(armies);
  const armyFogged = armyFields.find((v) => typeof v === 'boolean') === true;
  const count = armyFields.find((v) => typeof v === 'number');
  const fogged = armyFogged || fogLevel === FOG_LEVEL_FOGGED;
  return {
    territoryId,
    fogLevel,
    fogged,
    owner,
    armies: fogged || typeof count !== 'number' ? null : count,
  };
}

/**
 * Read a GetLatestGameInfo result (the body positioned at the result-present
 * flag). Returns the territories, or `null` when war.app sent no standing (no
 * result, or a game with no board yet).
 */
export function readLiveStanding(bundle: ClassReader, body: Reader): LiveTerritory[] | null {
  if (!body.bool()) return null;
  const info = bundle.readClass(LATEST_GAME_INFO, body);
  if (!isObj(info)) throw new LiveBoardFormatError('no LatestGameInfo');
  const standing = fields(info).find((v) => isType(v, GAME_STANDING));
  if (!standing) return null;
  for (const v of fields(standing)) {
    const list = entries(v);
    if (!list?.length || !list.some((e) => isType(e.value, TERRITORY_STANDING))) continue;
    return list
      .filter((e) => isType(e.value, TERRITORY_STANDING))
      .map((e) => territoryOf(e.key, e.value as Obj));
  }
  return null;
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
    territories: territories.map((t) => ({
      territoryId: t.territoryId,
      owner: ownerOf(t, byInGame),
      armies: t.armies,
      fogLevel: FOG_LEVEL_NAMES[t.fogLevel] ?? String(t.fogLevel),
    })),
  };
}
