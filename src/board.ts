// Source-agnostic board state, plus a LOOSE parser for GameFeed's "standing".
//
// UNVERIFIED: the shape of an in-progress game's standing has not been seen
// live (only lobbies have — see docs/WARAPP-API.md). The docs describe one
// entry per territory carrying its armies, its owner and a fog level, so this
// parser accepts the plausible spellings of each and returns `undefined` for
// anything it cannot use, rather than throwing. The analysis core consumes
// `BoardState` only, so a browser-tab source can feed it later without
// touching the analysis.

import type { TeammateOrders } from './team-orders.js';
import { asInt } from './scalars.js';

/** Who holds a territory, as far as the viewer can see. */
export type TerritoryOwner =
  | { kind: 'player'; playerId: number }
  | { kind: 'neutral' }
  /** Still up for picking in a manual-distribution game. */
  | { kind: 'available' }
  /** Fogged, or an owner value this parser does not recognise (`raw` holds it). */
  | { kind: 'unknown'; raw?: string };

export interface TerritoryState {
  territoryId: number;
  owner: TerritoryOwner;
  /** Army count, or `null` when hidden by fog. */
  armies: number | null;
  /** The feed's fog level for this territory (e.g. `Visible`, `Fogged`), when sent. */
  fogLevel?: string;
  /** Special units standing here (the live board, and since #437 a GameFeed history's commanders); absent when there are none. */
  specialUnits?: BoardSpecialUnit[];
  /** #332, commerce games: the cities here (live board only); absent when there are none. */
  cities?: number;
}

/** A special unit on a territory: a commander, a boss or a custom unit. */
export interface BoardSpecialUnit {
  kind: 'commander' | 'boss' | 'custom' | 'unknown';
  /** The unit's GUID. */
  id: string;
  /** Its owner, keyed like `TerritoryOwner.playerId` (GameFeed id when known). */
  playerId: number;
}

export interface BoardState {
  /** Where the board came from. Only `gamefeed` exists today. */
  source: 'gamefeed' | 'browser';
  /** `false` until the parser has been checked against a live in-progress game. */
  verified: boolean;
  territories: TerritoryState[];
  /**
   * My teammates' entered orders and picks (C1, a team game's live board only), by GameFeed id: absent when
   * the board carries none (unknown, not "none entered"). From the client bundle, UNVERIFIED live (V5).
   */
  teammateOrders?: TeammateOrders[];
}

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

const pick = (r: Rec, keys: readonly string[]): unknown => {
  for (const k of keys) if (r[k] !== undefined) return r[k];
  return undefined;
};

const ID_KEYS = ['terrID', 'territoryID', 'territoryId', 'terrId', 'id'] as const;
const OWNER_KEYS = ['ownedBy', 'ownerID', 'ownerId', 'owner', 'playerID', 'playerId'] as const;
const ARMY_KEYS = ['armies', 'numArmies', 'NumArmies', 'Armies'] as const;
const FOG_KEYS = ['fogLevel', 'fog', 'FogLevel'] as const;

function ownerOf(v: unknown): TerritoryOwner {
  const id = asInt(v);
  // war.app's raw owner values (the live TerritoryStanding): 0 neutral, -2 pickable, and -1
  // on a fogged territory; no player has an id of 0 or below.
  if (id === 0) return { kind: 'neutral' };
  if (id === -2) return { kind: 'available' };
  if (id !== undefined && id < 0) return { kind: 'unknown' };
  if (id !== undefined) return { kind: 'player', playerId: id };
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'neutral') return { kind: 'neutral' };
    if (s === 'availablefordistribution') return { kind: 'available' };
    if (s === '' || s === 'fogged' || s === 'unknown') return { kind: 'unknown' };
    return { kind: 'unknown', raw: v };
  }
  return { kind: 'unknown' };
}

function armiesOf(v: unknown): number | null {
  if (isRec(v)) return armiesOf(pick(v, ['numArmies', 'NumArmies', 'armies']));
  return asInt(v) ?? null;
}

/** #437: the unit tags GameFeed's history writes after the bar; only `cmdr` is VERIFIED live (2026-11-20). */
const UNIT_TAGS: Readonly<Record<string, BoardSpecialUnit['kind']>> = { cmdr: 'commander' };

/**
 * #437, VERIFIED live 2026-11-20 (a finished Commanders game's GameFeed history): a territory where a special
 * unit stands sends `armies` as `"<N>|cmdr,<GUID>,<owner id>,"` — N the plain armies alone (every start read 5,
 * the commander's too, and 0 once its armies left), then per unit its tag, GUID and owner (a GameFeed id),
 * each followed by a comma. Returns `undefined` for any other value; units that do not read are dropped.
 */
function unitArmiesOf(v: unknown): { armies: number | null; units: BoardSpecialUnit[] } | undefined {
  if (typeof v !== 'string') return undefined;
  const bar = v.indexOf('|');
  if (bar < 0) return undefined;
  const armies = asInt(v.slice(0, bar).trim()) ?? null;
  const fields = v.slice(bar + 1).split(',');
  const units: BoardSpecialUnit[] = [];
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const tag = fields[i]!.trim();
    const id = fields[i + 1]!.trim();
    const playerId = asInt(fields[i + 2]!.trim());
    if (!tag || !id || playerId === undefined) break;
    units.push({ kind: UNIT_TAGS[tag] ?? 'unknown', id, playerId });
  }
  return { armies, units };
}

function entryOf(raw: unknown, fallbackId?: number): TerritoryState | undefined {
  if (!isRec(raw)) return undefined;
  const territoryId = asInt(pick(raw, ID_KEYS)) ?? fallbackId;
  if (territoryId === undefined) return undefined;
  const rawArmies = pick(raw, ARMY_KEYS);
  const withUnits = unitArmiesOf(rawArmies);
  const entry: TerritoryState = {
    territoryId,
    owner: ownerOf(pick(raw, OWNER_KEYS)),
    armies: withUnits ? withUnits.armies : armiesOf(rawArmies),
  };
  if (withUnits?.units.length) entry.specialUnits = withUnits.units;
  const fog = pick(raw, FOG_KEYS);
  if ((typeof fog === 'string' && fog) || typeof fog === 'number') {
    const level = String(fog).trim();
    entry.fogLevel = level;
    // war.app's StandingFogLevel: 1 You, 2 Visible, 3 OwnerOnly, 4 Fogged (every GameFeed
    // scalar is a string, so the number may come spelled as one). A fogged territory's
    // owner/armies are placeholders (war.app shows fogged land as neutral, or owner -1);
    // an owner-only one shows its owner but not its armies (#69).
    if (/fog/i.test(level) || level === '4') {
      entry.owner = { kind: 'unknown' };
      entry.armies = null;
      delete entry.specialUnits;
    } else if (/owneronly/i.test(level) || level === '3') {
      entry.armies = null;
      delete entry.specialUnits;
    }
  }
  return entry;
}

function entriesOf(raw: unknown): TerritoryState[] {
  if (Array.isArray(raw)) return raw.map((e) => entryOf(e)).filter((e): e is TerritoryState => e !== undefined);
  if (!isRec(raw)) return [];
  const wrapped = pick(raw, ['territories', 'Territories']);
  if (wrapped !== undefined) return entriesOf(wrapped);
  // An object keyed by territory id.
  const out: TerritoryState[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const e = entryOf(v, asInt(k));
    if (e) out.push(e);
  }
  return out;
}

/**
 * Parse a GameFeed standing into a {@link BoardState}, or `undefined` when it
 * is absent or carries no usable territory. Never throws.
 */
export function boardFromStanding(raw: unknown): BoardState | undefined {
  const territories = entriesOf(raw);
  if (territories.length === 0) return undefined;
  return { source: 'gamefeed', verified: false, territories };
}
