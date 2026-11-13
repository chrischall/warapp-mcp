// GameFeed normalizers. war.app sends EVERY scalar as a string ("-1", "False",
// territory "id": "1", bonus "value": "6") while adjacency / membership lists
// are number arrays, and settings are mostly real JSON types. Everything is
// turned into real types here, once, so nothing downstream re-parses strings.

import { McpToolError } from '@chrischall/mcp-utils';
import { z } from 'zod';
import { boardFromStanding, type BoardState } from './board.js';

export { asBool, asInt, asNum } from './scalars.js';
import { asBool, asInt, asNum } from './scalars.js';

const asStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The `error` string of a GameFeed error body (`{ termsOfUse, error }`), if it is one. */
export function feedErrorOf(body: unknown): string | undefined {
  return isRec(body) && typeof body.error === 'string' ? body.error : undefined;
}

/** A GameFeed body that does not have the shape a game or map must have. */
export class WarappFormatError extends McpToolError {
  constructor(what: string, detail: string) {
    super(`war.app returned a ${what} in an unexpected shape (${detail}).`, { kind: 'unknown' });
    this.name = 'WarappFormatError';
  }
}

// ---------- raw shapes (loose: unknown keys pass through, scalars may be string or number) ----------

const scalar = z.union([z.string(), z.number()]);
const intLike = scalar.refine((v) => asInt(v) !== undefined, 'not an integer');

const RawTerritory = z.looseObject({
  id: intLike,
  name: z.string(),
  coords: z.string().optional(),
  connectedTo: z.array(intLike).default([]),
});
const RawBonus = z.looseObject({
  id: intLike,
  name: z.string(),
  value: intLike,
  territoryIDs: z.array(intLike).default([]),
});
const RawDistributionMode = z.looseObject({ id: intLike, name: z.string(), type: z.string().optional() });
const RawMap = z.looseObject({
  id: intLike,
  name: z.string(),
  territories: z.array(RawTerritory),
  bonuses: z.array(RawBonus).default([]),
  distributionModes: z.array(RawDistributionMode).default([]),
});
const RawPlayer = z.looseObject({ id: intLike, name: z.string().default('') });
const RawGame = z.looseObject({
  id: intLike,
  state: z.string(),
  name: z.string().optional(),
  players: z.array(RawPlayer).default([]),
});

function issueOf(err: z.ZodError): string {
  const i = err.issues[0];
  return i ? `${i.path.join('.') || '(root)'}: ${i.message}` : 'invalid';
}

// ---------- map ----------

export interface Territory {
  id: number;
  name: string;
  coords?: { x: number; y: number };
  connectedTo: number[];
}

export interface Bonus {
  id: number;
  name: string;
  /** Armies per turn for holding it. Can be 0 or negative. */
  value: number;
  /** Member territories. */
  territoryIds: number[];
  /** Member bonuses (a superbonus): ids that are not territories but are bonuses. */
  bonusIds: number[];
  /** Member ids that are neither — only present when there are any. */
  unknownIds?: number[];
}

export interface DistributionMode {
  id: number;
  name: string;
  type?: string;
}

export interface GameMap {
  id: number;
  name: string;
  territories: Territory[];
  bonuses: Bonus[];
  distributionModes: DistributionMode[];
}

function coordsOf(s: string | undefined): Territory['coords'] {
  if (!s) return undefined;
  const [x, y, ...rest] = s.split(',').map((p) => asNum(p));
  return x !== undefined && y !== undefined && rest.length === 0 ? { x, y } : undefined;
}

/**
 * Normalize a GameFeed `map`. A bonus member id is a territory whenever a
 * territory has that id (ids overlap between the two namespaces on real maps),
 * else a member bonus (superbonus), else unknown.
 */
export function normalizeMap(raw: unknown): GameMap {
  const parsed = RawMap.safeParse(raw);
  if (!parsed.success) throw new WarappFormatError('map', issueOf(parsed.error));
  const m = parsed.data;
  const territories: Territory[] = m.territories.map((t) => {
    const id = asInt(t.id)!;
    const connectedTo = t.connectedTo.map((n) => asInt(n)!);
    const coords = coordsOf(t.coords);
    return coords ? { id, name: t.name, coords, connectedTo } : { id, name: t.name, connectedTo };
  });
  const territoryIds = new Set(territories.map((t) => t.id));
  const bonusIdSet = new Set(m.bonuses.map((b) => asInt(b.id)!));
  const bonuses: Bonus[] = m.bonuses.map((b) => {
    const bonus: Bonus = { id: asInt(b.id)!, name: b.name, value: asInt(b.value)!, territoryIds: [], bonusIds: [] };
    const unknown: number[] = [];
    for (const raw of b.territoryIDs) {
      const id = asInt(raw)!;
      if (territoryIds.has(id)) bonus.territoryIds.push(id);
      else if (bonusIdSet.has(id)) bonus.bonusIds.push(id);
      else unknown.push(id);
    }
    if (unknown.length) bonus.unknownIds = unknown;
    return bonus;
  });
  const distributionModes = m.distributionModes.map((d) => {
    const out: DistributionMode = { id: asInt(d.id)!, name: d.name };
    if (d.type !== undefined) out.type = d.type;
    return out;
  });
  return { id: asInt(m.id)!, name: m.name, territories, bonuses, distributionModes };
}

// ---------- players ----------

export interface Player {
  id: number;
  name: string;
  isAI: boolean;
  humanTurnedIntoAI: boolean;
  hasCommittedOrders: boolean;
  /**
   * The id exactly as GameFeed sent it, kept only when the number loses
   * something (leading zeros) — the in-game id is cut from its digits.
   */
  feedId?: string;
  color?: string;
  /** e.g. `Playing`, `Invited`, `Eliminated`, `Booted`, `Won`. */
  state?: string;
}

export function normalizePlayer(raw: unknown): Player {
  const r = RawPlayer.parse(raw);
  const p: Player = {
    id: asInt(r.id)!,
    name: r.name,
    isAI: asBool(r.isAI) ?? false,
    humanTurnedIntoAI: asBool(r.humanTurnedIntoAI) ?? false,
    hasCommittedOrders: asBool(r.hasCommittedOrders) ?? false,
  };
  if (typeof r.id === 'string' && r.id.trim() !== String(p.id)) p.feedId = r.id.trim();
  const color = asStr(r.color);
  if (color !== undefined) p.color = color;
  const state = asStr(r.state);
  if (state !== undefined) p.state = state;
  return p;
}

// ---------- settings ----------

export interface GameSettings {
  mapId?: number;
  pace?: string;
  fog?: string;
  /** Percent of attacking armies that kill a defender. */
  offensiveKillRate?: number;
  /** Percent of defending armies that kill an attacker. */
  defensiveKillRate?: number;
  luckModifier?: number;
  roundingMode?: string;
  /** `Random`, `Cycle`, or `NoLuckCycle` (the first turn is a speed race, the board hidden until Begin). */
  moveOrder?: string;
  oneArmyStandsGuard?: boolean;
  minimumArmyBonus?: number;
  bonusArmyPer?: number;
  /** `null` when there is no cap. */
  armyCap?: number | null;
  multiAttack?: boolean;
  localDeployments?: boolean;
  /** No-Split: a territory issues at most one attack or transfer per turn. */
  noSplit?: boolean;
  commanders?: boolean;
  distributionMode?: number;
  territoryLimit?: number;
  initialPlayerArmiesPerTerritory?: number;
  initialNonDistributionArmies?: number;
  initialNeutralsInDistribution?: number;
  /** Enabled cards by name (`Reinforcement`, `Airlift`, …). */
  cards: string[];
  /**
   * The game's overridden bonus values (`OverriddenBonuses`), bonus id → value; set
   * whenever the feed sends the key (empty when none). Its JSON shape is UNVERIFIED
   * (docs/WARAPP-API.md): see {@link parseOverriddenBonuses}.
   */
  overriddenBonuses?: ReadonlyMap<number, number>;
  /** `true` when `OverriddenBonuses` was sent in a shape that could not be read (then `overriddenBonuses` is empty). */
  overriddenBonusesUnparsed?: true;
  /** Every setting as the feed sent it. */
  raw: Rec;
}

const INT_SETTINGS = {
  mapId: 'Map',
  minimumArmyBonus: 'MinimumArmyBonus',
  bonusArmyPer: 'BonusArmyPer',
  distributionMode: 'DistributionMode',
  territoryLimit: 'TerritoryLimit',
  initialPlayerArmiesPerTerritory: 'InitialPlayerArmiesPerTerritory',
  initialNonDistributionArmies: 'InitialNonDistributionArmies',
  initialNeutralsInDistribution: 'InitialNeutralsInDistribution',
} as const;
const BOOL_SETTINGS = {
  oneArmyStandsGuard: 'OneArmyStandsGuard',
  multiAttack: 'MultiAttack',
  localDeployments: 'LocalDeployments',
  noSplit: 'NoSplit',
  commanders: 'Commanders',
} as const;
const STR_SETTINGS = { pace: 'Pace', fog: 'Fog', roundingMode: 'RoundingMode', moveOrder: 'MoveOrder' } as const;

export function normalizeSettings(raw: unknown): GameSettings {
  const r: Rec = isRec(raw) ? raw : {};
  const s: GameSettings = { cards: [], raw: r };
  for (const [k, src] of Object.entries(INT_SETTINGS)) {
    const v = asInt(r[src]);
    if (v !== undefined) s[k as keyof typeof INT_SETTINGS] = v;
  }
  for (const [k, src] of Object.entries(BOOL_SETTINGS)) {
    const v = asBool(r[src]);
    if (v !== undefined) s[k as keyof typeof BOOL_SETTINGS] = v;
  }
  for (const [k, src] of Object.entries(STR_SETTINGS)) {
    const v = asStr(r[src]);
    if (v !== undefined) s[k as keyof typeof STR_SETTINGS] = v;
  }
  // Kill rates are read as numbers, not integers: a rate sent as "20.0" must
  // never be dropped, or every combat computation would silently assume 60/70.
  const off = asNum(r.OffensiveKillRate);
  if (off !== undefined) s.offensiveKillRate = off;
  const def = asNum(r.DefensiveKillRate);
  if (def !== undefined) s.defensiveKillRate = def;
  const luck = asNum(r.LuckModifier);
  if (luck !== undefined) s.luckModifier = luck;
  if ('ArmyCap' in r) s.armyCap = asInt(r.ArmyCap) ?? null;
  for (const [k, v] of Object.entries(r)) {
    if (k.endsWith('Card') && isRec(v)) s.cards.push(k.slice(0, -'Card'.length));
  }
  if (r.OverriddenBonuses !== undefined && r.OverriddenBonuses !== null) {
    const o = parseOverriddenBonuses(r.OverriddenBonuses);
    s.overriddenBonuses = o.values;
    if (o.unparsed) s.overriddenBonusesUnparsed = true;
  }
  return s;
}

/** Key spellings tried for an override entry's bonus id and value (the feed's shape is unverified). */
const OVERRIDE_ID_KEYS = ['bonusID', 'BonusID', 'bonusId', 'BonusId', 'bonusid', 'id', 'ID', 'Id', 'key', 'Key', 'bonus', 'Bonus'];
const OVERRIDE_VALUE_KEYS = ['value', 'Value', 'val', 'Val', 'armies', 'Armies'];

function overrideEntry(e: unknown): [number, number] | undefined {
  if (Array.isArray(e)) {
    if (e.length !== 2) return undefined;
    const id = asInt(e[0]);
    const value = asInt(e[1]);
    return id !== undefined && value !== undefined ? [id, value] : undefined;
  }
  if (!isRec(e)) return undefined;
  const idKey = OVERRIDE_ID_KEYS.find((k) => k in e);
  const valueKey = OVERRIDE_VALUE_KEYS.find((k) => k in e);
  if (idKey === undefined || valueKey === undefined) return undefined;
  const id = asInt(e[idKey]);
  const value = asInt(e[valueKey]);
  return id !== undefined && value !== undefined ? [id, value] : undefined;
}

/**
 * Read GameFeed's `OverriddenBonuses` (bonus id → value). war.app's client keeps it as
 * a `Dictionary<bonusId, value>` (values −1000..1000); how GameFeed serialises it is
 * UNVERIFIED (a lobby with none sent `[]`), so this accepts, without throwing: an
 * array of `{ <id key>, <value key> }` objects (several key spellings) or `[id, value]`
 * pairs, an object keyed by bonus id, string scalars throughout, and any of those as a
 * JSON string. Anything else — or any entry that does not read — gives no values and
 * `unparsed: true` (all or nothing: a half-read map would be silently wrong).
 */
export function parseOverriddenBonuses(raw: unknown): { values: ReadonlyMap<number, number>; unparsed: boolean } {
  const none = { values: new Map<number, number>(), unparsed: false };
  const fail = { values: new Map<number, number>(), unparsed: true };
  let v = raw;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return none;
    try {
      v = JSON.parse(t) as unknown;
    } catch {
      return fail;
    }
    if (typeof v === 'string') return fail;
  }
  const values = new Map<number, number>();
  if (Array.isArray(v)) {
    for (const e of v) {
      const pair = overrideEntry(e);
      if (!pair) return fail;
      values.set(pair[0], pair[1]);
    }
    return { values, unparsed: false };
  }
  if (isRec(v)) {
    for (const [k, val] of Object.entries(v)) {
      const id = asInt(k);
      const value = asInt(val);
      if (id === undefined || value === undefined) return fail;
      values.set(id, value);
    }
    return { values, unparsed: false };
  }
  return fail;
}

// ---------- game ----------

export interface Game {
  id: number;
  name?: string;
  /** e.g. `WaitingForPlayers`, `DistributingTerritories`, `Playing`, `Finished`. */
  state: string;
  /** `-1` before the game starts. */
  numberOfTurns?: number;
  /** As the feed sends it (live: `M/D/YYYY HH:MM:SS`, UTC assumed). */
  created?: string;
  lastTurnTime?: string;
  players: Player[];
  settings?: GameSettings;
  /** The map, from the feed or the per-process cache. Attached by the client. */
  map?: GameMap;
  /** Current board, when the feed sends a standing (UNVERIFIED parser). */
  standing?: BoardState;
  /** Raw `GetHistory` turns, when asked for and sent. */
  history?: unknown;
  /** Raw `GetChat` messages, when asked for and sent. Third-party text. */
  chat?: unknown;
}

/** Normalize a GameFeed game body (the map is left to the client). */
export function normalizeGame(raw: unknown): Game {
  const parsed = RawGame.safeParse(raw);
  if (!parsed.success) throw new WarappFormatError('game', issueOf(parsed.error));
  const g = parsed.data;
  const game: Game = { id: asInt(g.id)!, state: g.state, players: g.players.map(normalizePlayer) };
  if (g.name !== undefined) game.name = g.name;
  const turns = asInt(g.numberOfTurns);
  if (turns !== undefined) game.numberOfTurns = turns;
  const created = asStr(g.created);
  if (created !== undefined) game.created = created;
  const last = asStr(g.lastTurnTime);
  if (last !== undefined) game.lastTurnTime = last;
  if (isRec(g.settings)) game.settings = normalizeSettings(g.settings);
  const standing = boardFromStanding(g.standing ?? g.standings ?? g.latestStanding);
  if (standing) game.standing = standing;
  if (g.history !== undefined) game.history = g.history;
  if (g.chat !== undefined) game.chat = g.chat;
  return game;
}
