// Where a game's teams come from (docs/PLAN-TEAMS.md, "Team source"). GameFeed's player `team` is
// UNVERIFIED live (V1); when no player in GameFeed's game carries one and the game has more than two
// seats, the team comes from GetMyGames' GameInfoPlayer (read from the client bundle, itself unverified
// live), matched by in-game id. Every tool that decides teams loads its game through `resolveTeams`, so
// they all agree.
//
// Trust: the list's answer is checked against GameFeed's seats before it is used (`judgeList`). Trusted
// are only an answer that gives every seat a team with at least two distinct teams among them, and one
// that lists every seat with no team at all (a free-for-all). Every seat on one team, or one team only
// among them, is not trusted (a misread team field would read that way): the teams stay unknown and
// nothing is kept, so the next call asks again. An answer that leaves a seat out, or gives some seats a
// team and others none, is incomplete: the teams stay unknown too.
//
// Cost: GetMyGames is asked at most once per game. A trusted answer — the game's in-game ids and team
// numbers, or that the game carries none — is kept at `<dataDir>/teams/<gameId>.json` (NAME-FREE: ids and
// team numbers only; 0600 in a 0700 folder, atomic, best effort, the newest MAX_TEAM_RECORDS kept), since
// a game's teams do not change once it has started. An incomplete answer keeps only a marker
// (`incompleteTurn`, GameFeed's numberOfTurns when it was read) and no teams, so a list that permanently
// leaves a seat out is asked at most once per turn, not on every call. A lobby's answer is used but never
// kept (a player who joins later would have no entry), and a kept record that lacks a seated player's
// in-game id is not trusted: the list is asked again. A failed GetMyGames read, or a list that does not
// hold the game, leaves the teams unknown (as GameFeed sent them) and is not kept: the next call asks again.
//
// Bump TEAM_RECORD_VERSION whenever the GameInfoPlayer team decode (`src/my-games.ts`) or the trust
// check changes: a record kept by another version is ignored, so a misread kept earlier is never reused.

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { playersByInGameId } from '../live.js';
import { writeJsonAtomic } from '../map-store.js';
import { myGamesTeams, type RawMyGame } from '../my-games.js';
import type { Game, Player } from '../normalize.js';
import { carriesTeam, isTeamGame } from '../teams.js';
import type { LiveContext } from './live-context.js';
import { fetchMyGames } from './my-games.js';

/** Where the game's teams were read from: GameFeed, the GetMyGames list, or nowhere (not a team game, or unknown). */
export type TeamSource = 'gamefeed' | 'my-games' | 'none';

/** Team records kept; the least recently written goes first. */
export const MAX_TEAM_RECORDS = 200;

/** The kept record's version: bump it whenever the GameInfoPlayer team decode or the trust check changes. */
export const TEAM_RECORD_VERSION = 2;
const TEAM_FILE = /^\d+\.json$/;

export const teamsDir = (dir: string) => join(dir, 'teams');
export const teamRecordPath = (dir: string, gameId: number) => join(teamsDir(dir), `${gameId}.json`);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** A kept record: the game's teams (in-game id → team; empty: none), or the turn a list left a seat out. */
export type TeamRecord = { teams: Map<number, number> } | { incompleteTurn: number };

/** The kept record of `gameId`; `undefined` when none is kept, it is malformed or from another version. Never throws. */
export async function readTeamFile(dir: string, gameId: number): Promise<TeamRecord | undefined> {
  try {
    const r: unknown = JSON.parse(await readFile(teamRecordPath(dir, gameId), 'utf8'));
    if (!isRec(r) || r.version !== TEAM_RECORD_VERSION || r.gameId !== gameId) return undefined;
    if (!('teams' in r)) return isInt(r.incompleteTurn) ? { incompleteTurn: r.incompleteTurn } : undefined;
    if (!Array.isArray(r.teams)) return undefined;
    const out = new Map<number, number>();
    for (const e of r.teams) {
      if (!Array.isArray(e) || e.length !== 2 || !isInt(e[0]) || !isInt(e[1]) || !carriesTeam(e[1])) return undefined;
      out.set(e[0], e[1]);
    }
    return { teams: out };
  } catch {
    return undefined;
  }
}

/** The kept teams of `gameId` (in-game id → team; empty: the game carries none); `undefined` when none is kept. Never throws. */
export async function readTeamRecord(dir: string, gameId: number): Promise<Map<number, number> | undefined> {
  const r = await readTeamFile(dir, gameId);
  return r && 'teams' in r ? r.teams : undefined;
}

async function pruneTeams(dir: string, keep: number): Promise<void> {
  const folder = teamsDir(dir);
  const files: { name: string; at: number }[] = [];
  for (const name of await readdir(folder)) {
    if (!TEAM_FILE.test(name) || name === `${keep}.json`) continue;
    try {
      files.push({ name, at: (await stat(join(folder, name))).mtimeMs });
    } catch {
      // Gone already.
    }
  }
  const excess = files.length + 1 - MAX_TEAM_RECORDS;
  if (excess <= 0) return;
  files.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  for (const f of files.slice(0, excess)) await unlink(join(folder, f.name)).catch(() => {});
}

async function writeRecord(dir: string, gameId: number, body: Rec): Promise<void> {
  try {
    await writeJsonAtomic(teamRecordPath(dir, gameId), teamsDir(dir), { version: TEAM_RECORD_VERSION, gameId, ...body });
    await pruneTeams(dir, gameId).catch(() => {});
  } catch {
    // Not kept: the next call asks again.
  }
}

/** Keep `gameId`'s teams (in-game id → team; empty: none). Best effort, never throws. */
export function writeTeamRecord(dir: string, gameId: number, teams: ReadonlyMap<number, number>): Promise<void> {
  return writeRecord(dir, gameId, { teams: [...teams].sort((a, b) => a[0] - b[0]) });
}

/** Keep only that the list left a seat of `gameId` out on `turn` (no teams). Best effort, never throws. */
export function writeIncompleteMarker(dir: string, gameId: number, turn: number): Promise<void> {
  return writeRecord(dir, gameId, { incompleteTurn: turn });
}

/** The game list; `undefined` when the read fails or the list does not hold the game. */
async function myGamesWith(ctx: LiveContext, gameId: number): Promise<RawMyGame[] | undefined> {
  try {
    // The account first: an unknown one asks nothing (fetchMyGames reuses the cached answer).
    if ((await ctx.myInGameId()) === undefined) return undefined;
    const { games } = await fetchMyGames(ctx);
    return games.some((g) => g.id === gameId) ? games : undefined;
  } catch {
    return undefined;
  }
}

/** What the list's answer is worth against GameFeed's seats. */
export type Verdict = { kind: 'trusted'; teams: Map<number, number> } | { kind: 'incomplete' } | { kind: 'untrusted' };

/**
 * Judge the list's answer for `gameId` against the seats GameFeed shows (in-game ids): every seat listed
 * without a team is a free-for-all; every seat with a team and two or more teams among them is trusted; a
 * seat left out, or teams on some seats only, is incomplete; one team for every seat is not trusted.
 */
export function judgeList(games: readonly RawMyGame[], gameId: number, seats: readonly number[]): Verdict {
  const listed = new Set((games.find((g) => g.id === gameId)?.players ?? []).map((p) => p.id));
  if (!seats.every((id) => listed.has(id))) return { kind: 'incomplete' };
  const teams = myGamesTeams(games, gameId);
  const withTeam = seats.filter((id) => teams.has(id));
  if (!withTeam.length) return { kind: 'trusted', teams: new Map() };
  if (withTeam.length < seats.length) return { kind: 'incomplete' };
  if (new Set(withTeam.map((id) => teams.get(id))).size < 2) return { kind: 'untrusted' };
  return { kind: 'trusted', teams };
}

/** GameFeed's state for a game still filling its seats. */
const LOBBY_STATE = 'WaitingForPlayers';

/** Whether a kept record names every seated player of `game` (an empty one — no teams — always does). */
function coversSeats(game: Game, teams: ReadonlyMap<number, number>): boolean {
  if (!teams.size) return true;
  return [...playersByInGameId(game.players).keys()].every((id) => teams.has(id));
}

/** `game` with each player's team from `teams` (in-game id → team), for the players it can match. */
function withTeams(game: Game, teams: ReadonlyMap<number, number>): Game | undefined {
  if (!teams.size) return undefined;
  const byInGame = playersByInGameId(game.players);
  const teamOf = new Map<number, number>();
  for (const [inGame, team] of teams) {
    const p = byInGame.get(inGame);
    if (p) teamOf.set(p.id, team);
  }
  const players = game.players.map((p) => (teamOf.has(p.id) ? { ...p, team: teamOf.get(p.id)! } : p));
  return isTeamGame(players) ? { ...game, players } : undefined;
}

/** {@link resolveTeams}' answer: `known` is false when the game may have teams nobody could read. */
export interface ResolvedTeams {
  game: Game;
  source: TeamSource;
  /**
   * Whether the teams are known: GameFeed's (on every seat) or the list's, two seats or fewer, or a
   * trusted list that shows none. False when GameFeed gives some seats a team and others none. False when a game of more than two seats carries no team and the list was not read,
   * did not hold the game, left a seat out or was not trusted: any other player may be my teammate.
   */
  known: boolean;
}

/**
 * The game with each player's team, and where the teams came from. GameFeed's when any player carries
 * one (`gamefeed`); else, in a game of more than two seats, GetMyGames' — from the per-game record when
 * kept, else asked once, judged against the seats and kept when trusted (`my-games`); else the game as
 * GameFeed sent it (`none`). Never throws.
 */
export async function resolveTeams(ctx: LiveContext, game: Game): Promise<ResolvedTeams> {
  // A team on some seats but not all (GameFeed's team field is unverified): a seat without one may be
  // my teammate, so the teams are not known.
  if (isTeamGame(game.players)) return { game, source: 'gamefeed', known: game.players.every((p) => carriesTeam(p.team)) };
  if (game.players.length <= 2) return { game, source: 'none', known: true };
  const none = { game, source: 'none' as const, known: false };
  const kept = ctx.dataDir ? await readTeamFile(ctx.dataDir, game.id) : undefined;
  const turn = game.numberOfTurns;
  // The list left a seat out on this turn already: not asked again until the next.
  if (kept && 'incompleteTurn' in kept && turn !== undefined && kept.incompleteTurn === turn) return none;
  let teams = kept && 'teams' in kept && coversSeats(game, kept.teams) ? kept.teams : undefined;
  if (!teams) {
    const games = await myGamesWith(ctx, game.id);
    if (!games) return none;
    const verdict = judgeList(games, game.id, [...playersByInGameId(game.players).keys()]);
    // Kept only once the seats are settled: a lobby can still fill.
    const keep = ctx.dataDir && game.state !== LOBBY_STATE ? ctx.dataDir : undefined;
    if (verdict.kind === 'incomplete' && keep && turn !== undefined) await writeIncompleteMarker(keep, game.id, turn);
    if (verdict.kind !== 'trusted') return none;
    teams = verdict.teams;
    if (keep) await writeTeamRecord(keep, game.id, teams);
  }
  const resolved = withTeams(game, teams);
  // A trusted list with no team on any seat: a free-for-all, known.
  return resolved ? { game: resolved, source: 'my-games', known: true } : { ...none, known: !teams.size };
}

/**
 * {@link resolveTeams} for a tool that has already found my seat (and refused a seat it refuses, so
 * that refusal asks no game list): the game, the source, and my seat in the resolved game.
 */
export async function resolveTeamsFor(ctx: LiveContext, game: Game, me: Player): Promise<ResolvedTeams & { me: Player }> {
  const r = await resolveTeams(ctx, game);
  return { ...r, me: r.game.players.find((p) => p.id === me.id) ?? me };
}
