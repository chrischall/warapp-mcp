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
  /**
   * Its team, when GameFeed sends one (UNVERIFIED: no team game has been read; see
   * docs/WARAPP-API.md). Absent, or -1, means no team.
   */
  team?: number;
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
  const team = asInt(r.team);
  if (team !== undefined) p.team = team;
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
  /** Orders may be Transfer Only (`AllowTransferOnly`; war.app refuses one otherwise, error 361). */
  allowTransferOnly?: boolean;
  /** Orders may be Attack Only (`AllowAttackOnly`; error 362 otherwise). */
  allowAttackOnly?: boolean;
  /** Orders may send a percentage of the armies (`AllowPercentageAttacks`; error 360 otherwise). */
  allowPercentageAttacks?: boolean;
  /**
   * How many mods the game runs (`Mods`): 0 for none, -1 when the feed sends something that is
   * not a list (mods present, count unknown); absent when the feed does not send the key. The
   * entries' shape is unverified, so only the count is kept.
   */
  mods?: number;
  distributionMode?: number;
  territoryLimit?: number;
  initialPlayerArmiesPerTerritory?: number;
  initialNonDistributionArmies?: number;
  initialNeutralsInDistribution?: number;
  /** Enabled cards by name (`Reinforcement`, `Airlift`, …). */
  cards: string[];
  /**
   * The game's overridden bonus values (`OverriddenBonuses`), bonus id → value; set
   * whenever the feed sends the key (empty when none). Its JSON shape is verified live
   * (#62: an array of `{ bonusID, value }` numbers; docs/WARAPP-API.md): see {@link parseOverriddenBonuses}.
   */
  overriddenBonuses?: ReadonlyMap<number, number>;
  /** `true` when `OverriddenBonuses` could not be read in full (malformed entries skipped, or an unknown shape with no values). */
  overriddenBonusesUnparsed?: true;
  /**
   * #167: automatic Wastelands (`Wastelands: { NumberOfWastelands, WastelandSize }`, verified on a
   * lobby game as zeros): how many neutrals start at `size` armies. Absent when the feed does not send
   * a readable object.
   */
  wastelands?: { count: number; size: number };
  /**
   * #167: a commerce game (gold, cities). `false` for the `{}` every plain game sends, `true` when the
   * feed's `Commerce` object carries settings (UNVERIFIED: no commerce game seen yet), absent when the
   * key is missing.
   */
  commerce?: boolean;
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
  allowTransferOnly: 'AllowTransferOnly',
  allowAttackOnly: 'AllowAttackOnly',
  allowPercentageAttacks: 'AllowPercentageAttacks',
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
  // A number, not an integer: a cap of 1.5× income read as an integer would be "no cap" (#131).
  if ('ArmyCap' in r) s.armyCap = asNum(r.ArmyCap) ?? null;
  for (const [k, v] of Object.entries(r)) {
    if (k.endsWith('Card') && isRec(v)) s.cards.push(k.slice(0, -'Card'.length));
  }
  if (isRec(r.Wastelands)) {
    const count = asInt(r.Wastelands.NumberOfWastelands);
    const size = asInt(r.Wastelands.WastelandSize);
    if (count !== undefined && size !== undefined) s.wastelands = { count, size };
  }
  if (r.Commerce !== undefined && r.Commerce !== null) s.commerce = isRec(r.Commerce) ? Object.keys(r.Commerce).length > 0 : true;
  if (r.Mods !== undefined && r.Mods !== null) {
    const empty = r.Mods === '' || (isRec(r.Mods) && Object.keys(r.Mods).length === 0);
    s.mods = Array.isArray(r.Mods) ? r.Mods.length : empty ? 0 : -1;
  }
  if (r.OverriddenBonuses !== undefined && r.OverriddenBonuses !== null) {
    const o = parseOverriddenBonuses(r.OverriddenBonuses);
    s.overriddenBonuses = o.values;
    if (o.unparsed) s.overriddenBonusesUnparsed = true;
  }
  return s;
}

/** Key spellings tried for an override entry: `bonusID` / `value` is the verified live shape (#62); the rest are read only to be tolerant. */
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
 * Read GameFeed's `OverriddenBonuses` (bonus id → value). Verified live (#62, 2026-11-12):
 * GameFeed sends an array of `{ "bonusID": <int>, "value": <int> }` with JSON numbers, and
 * `[]` when nothing is overridden (war.app's client keeps a `Dictionary<bonusId, value>`,
 * values −1000..1000). Read loosely, never throwing: string numbers, other key spellings,
 * `[id, value]` pairs, an object keyed by bonus id, or any of those as a JSON string. A
 * malformed entry is skipped (the rest are kept) and the read flagged `unparsed`, so the
 * pre-checks stay soft; an unreadable shape gives no values and `unparsed: true`.
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
  let bad = false;
  if (Array.isArray(v)) {
    for (const e of v) {
      const pair = overrideEntry(e);
      if (!pair) {
        bad = true;
        continue;
      }
      values.set(pair[0], pair[1]);
    }
    return { values, unparsed: bad };
  }
  if (isRec(v)) {
    for (const [k, val] of Object.entries(v)) {
      const id = asInt(k);
      const value = asInt(val);
      if (id === undefined || value === undefined) {
        bad = true;
        continue;
      }
      values.set(id, value);
    }
    return { values, unparsed: bad };
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
  /** #178: the end-of-game, boot and AI settings, read from `settings` ({@link parseEndRules}). */
  endRules?: EndRules;
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
  if (isRec(g.settings)) {
    game.settings = normalizeSettings(g.settings);
    game.endRules = parseEndRules(g.settings);
  }
  const standing = boardFromStanding(g.standing ?? g.standings ?? g.latestStanding);
  if (standing) game.standing = standing;
  if (g.history !== undefined) game.history = g.history;
  if (g.chat !== undefined) game.chat = g.chat;
  return game;
}

// ---------- end of game: surrender, boot, AI seats (#178) ----------

/**
 * The settings that decide how a game ends and what a leaver's seat becomes (#178). Each is absent
 * when the feed does not send it. Key names are verified on a lobby (docs/WARAPP-API.md); what each
 * does is from the war.app wiki and the client, UNVERIFIED live.
 */
export interface EndRules {
  /**
   * `InstantSurrender`: a surrender takes effect at once, without the others accepting it. The feed
   * sent the string `Instant` on a lobby; the client reads the setting as a boolean. A string it
   * does not recognize leaves this absent and is kept in {@link EndRules.instantSurrenderRaw}.
   */
  instantSurrender?: boolean;
  /** The `InstantSurrender` value when it could not be read as a yes or no. */
  instantSurrenderRaw?: string;
  /** `SurrenderedPlayersTurnIntoAIs`: a surrendered seat is played by an AI (else its land turns neutral). */
  surrenderedTurnIntoAI?: boolean;
  /** `BootedPlayersTurnIntoAIs`: a booted seat is played by an AI (else its land turns neutral). */
  bootedTurnIntoAI?: boolean;
  /** `TimesCanComeBackFromAI`: how often a player turned into an AI may take its seat back. */
  timesCanComeBackFromAI?: number;
  /** `AIsSurrenderWhenOneHumanRemains`: the AIs give up once one human is left, so that human wins. */
  aisSurrenderWhenOneHumanRemains?: boolean;
  /** `DirectBoot`: minutes after which the others may boot a player who has not committed. */
  directBootMinutes?: number;
  /** `AutoBoot`: minutes after which a player who has not committed is booted automatically. */
  autoBootMinutes?: number;
  /** `BankingBootTimes`: banked boot time (minutes), when the game uses it. */
  bankingBoot?: { bankMinutes: number; initialBankMinutes: number };
  /** `AllowVacations`: a player on vacation is not booted. */
  allowVacations?: boolean;
}

const INSTANT_WORDS = new Set(['instant', 'instantly', 'immediate', 'yes']);
const NOT_INSTANT_WORDS = new Set(['notinstant', 'noninstant', 'notimmediate', 'requireacceptance', 'requiresacceptance', 'vote', 'no', 'never']);

/** {@link EndRules} from a raw settings object; never throws. */
export function parseEndRules(raw: unknown): EndRules {
  const r: Rec = isRec(raw) ? raw : {};
  const out: EndRules = {};
  const instant = r.InstantSurrender;
  if (instant !== undefined && instant !== null) {
    const b = asBool(instant);
    const word = typeof instant === 'string' ? instant.trim().toLowerCase().replace(/[\s_-]/g, '') : '';
    if (b !== undefined) out.instantSurrender = b;
    else if (INSTANT_WORDS.has(word)) out.instantSurrender = true;
    else if (NOT_INSTANT_WORDS.has(word)) out.instantSurrender = false;
    else out.instantSurrenderRaw = String(instant);
  }
  const bools = [
    ['surrenderedTurnIntoAI', 'SurrenderedPlayersTurnIntoAIs'],
    ['bootedTurnIntoAI', 'BootedPlayersTurnIntoAIs'],
    ['aisSurrenderWhenOneHumanRemains', 'AIsSurrenderWhenOneHumanRemains'],
    ['allowVacations', 'AllowVacations'],
  ] as const;
  for (const [k, src] of bools) {
    const v = asBool(r[src]);
    if (v !== undefined) out[k] = v;
  }
  const comeBack = asInt(r.TimesCanComeBackFromAI);
  if (comeBack !== undefined) out.timesCanComeBackFromAI = comeBack;
  const direct = asNum(r.DirectBoot);
  if (direct !== undefined) out.directBootMinutes = direct;
  const auto = asNum(r.AutoBoot);
  if (auto !== undefined) out.autoBootMinutes = auto;
  if (isRec(r.BankingBootTimes)) {
    const bank = asNum(r.BankingBootTimes.BankAmount);
    const initial = asNum(r.BankingBootTimes.InitialBankInMinutes);
    if (bank !== undefined && initial !== undefined) out.bankingBoot = { bankMinutes: bank, initialBankMinutes: initial };
  }
  return out;
}

/** A feed time (`M/D/YYYY HH:MM:SS`, UTC assumed, docs/WARAPP-API.md) as epoch ms; `undefined` when unreadable. */
export function parseFeedTime(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2}):(\d{2})\s*$/.exec(s);
  if (!m) return undefined;
  const [, mo, d, y, h, mi, se] = m.map(Number) as number[];
  const t = Date.UTC(y!, mo! - 1, d!, h!, mi!, se!);
  return Number.isFinite(t) ? t : undefined;
}

/** One player who may be booted soon (#178). */
export interface Leaver {
  playerId: number;
  /** Minutes since the feed's `lastTurnTime` (read as the turn's start: UNVERIFIED). */
  waitingMinutes: number;
  /** Minutes until the automatic boot (`AutoBoot`), 0 when it is due; absent when the game has none. */
  autoBootInMinutes?: number;
  /** Minutes until the others may boot it (`DirectBoot`), 0 when they already may; absent when the game has none. */
  directBootInMinutes?: number;
  /** What its seat becomes when booted: an AI (`BootedPlayersTurnIntoAIs`) or neutral land. */
  becomes: 'AI' | 'neutral';
}

export const LEAVERS_UNVERIFIED =
  "Read from the game's lastTurnTime, taken as the moment this turn began (UNVERIFIED: it may mean something else), " +
  'against the AutoBoot and DirectBoot minutes. Banked boot time and vacations can delay a boot, and are not counted.';

/**
 * Humans still playing who have not committed this turn, with the time left before each boot and
 * what their seat becomes (#178). `withinMinutes` keeps only those whose nearest boot is that close.
 * Empty unless the game is being played and `lastTurnTime` reads. Never throws.
 */
export function leavers(game: Game, now: number, opts: { withinMinutes?: number } = {}): { players: Leaver[]; unverified: string } {
  const out = { players: [] as Leaver[], unverified: LEAVERS_UNVERIFIED };
  if (game.state !== 'Playing') return out;
  const start = parseFeedTime(game.lastTurnTime);
  if (start === undefined) return out;
  const rules = game.endRules ?? {};
  const waiting = Math.max(0, Math.floor((now - start) / 60_000));
  const left = (m: number | undefined) => (m !== undefined && m > 0 ? Math.max(0, Math.ceil(m - waiting)) : undefined);
  for (const p of game.players) {
    if ((p.state ?? 'Playing') !== 'Playing' || p.isAI || p.humanTurnedIntoAI || p.hasCommittedOrders) continue;
    const auto = left(rules.autoBootMinutes);
    const direct = left(rules.directBootMinutes);
    const nearest = Math.min(auto ?? Infinity, direct ?? Infinity);
    if (opts.withinMinutes !== undefined && !(nearest <= opts.withinMinutes)) continue;
    out.players.push({
      playerId: p.id,
      waitingMinutes: waiting,
      ...(auto !== undefined ? { autoBootInMinutes: auto } : {}),
      ...(direct !== undefined ? { directBootInMinutes: direct } : {}),
      becomes: rules.bootedTurnIntoAI ? 'AI' : 'neutral',
    });
  }
  return out;
}
