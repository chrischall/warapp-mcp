// Where a game's teams come from (docs/PLAN-TEAMS.md, "Team source"). GameFeed's player `team` is
// UNVERIFIED live (V1); when no player in GameFeed's game carries one and the game has more than two
// seats, the team comes from GetMyGames' GameInfoPlayer (read from the client bundle), matched by
// in-game id. Every tool that decides teams loads its game through `resolveTeams`, so they all agree.
//
// Cost: GetMyGames is asked at most once per game. Its answer — the game's in-game ids and team
// numbers, or that the game carries none — is kept at `<dataDir>/teams/<gameId>.json` (NAME-FREE: ids
// and team numbers only; 0600 in a 0700 folder, atomic, best effort, the newest MAX_TEAM_RECORDS kept),
// since a game's teams do not change. A failed GetMyGames read, or a list that does not hold the game,
// leaves the teams unknown (as GameFeed sent them) and is not kept: the next call asks again.

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { playersByInGameId } from '../live.js';
import { writeJsonAtomic } from '../map-store.js';
import { myGamesTeams } from '../my-games.js';
import type { Game, Player } from '../normalize.js';
import { carriesTeam, isTeamGame } from '../teams.js';
import type { LiveContext } from './live-context.js';
import { fetchMyGames } from './my-games.js';

/** Where the game's teams were read from: GameFeed, the GetMyGames list, or nowhere (not a team game, or unknown). */
export type TeamSource = 'gamefeed' | 'my-games' | 'none';

/** Team records kept; the least recently written goes first. */
export const MAX_TEAM_RECORDS = 200;

const VERSION = 1;
const TEAM_FILE = /^\d+\.json$/;

export const teamsDir = (dir: string) => join(dir, 'teams');
export const teamRecordPath = (dir: string, gameId: number) => join(teamsDir(dir), `${gameId}.json`);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** The kept teams of `gameId` (in-game id → team; empty: the game carries none); `undefined` when none is kept. Never throws. */
export async function readTeamRecord(dir: string, gameId: number): Promise<Map<number, number> | undefined> {
  try {
    const r: unknown = JSON.parse(await readFile(teamRecordPath(dir, gameId), 'utf8'));
    if (!isRec(r) || r.version !== VERSION || r.gameId !== gameId || !Array.isArray(r.teams)) return undefined;
    const out = new Map<number, number>();
    for (const e of r.teams) {
      if (!Array.isArray(e) || e.length !== 2 || !isInt(e[0]) || !isInt(e[1]) || !carriesTeam(e[1])) return undefined;
      out.set(e[0], e[1]);
    }
    return out;
  } catch {
    return undefined;
  }
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

/** Keep `gameId`'s teams (in-game id → team; empty: none). Best effort, never throws. */
export async function writeTeamRecord(dir: string, gameId: number, teams: ReadonlyMap<number, number>): Promise<void> {
  try {
    await writeJsonAtomic(teamRecordPath(dir, gameId), teamsDir(dir), {
      version: VERSION,
      gameId,
      teams: [...teams].sort((a, b) => a[0] - b[0]),
    });
    await pruneTeams(dir, gameId).catch(() => {});
  } catch {
    // Not kept: the next call asks again.
  }
}

/** GetMyGames' teams for the game; `undefined` when the read fails or the list does not hold the game. */
async function myGamesTeamsOf(ctx: LiveContext, gameId: number): Promise<Map<number, number> | undefined> {
  try {
    // The account first: an unknown one asks nothing (fetchMyGames reuses the cached answer).
    if ((await ctx.myInGameId()) === undefined) return undefined;
    const { games } = await fetchMyGames(ctx);
    return games.some((g) => g.id === gameId) ? myGamesTeams(games, gameId) : undefined;
  } catch {
    return undefined;
  }
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

/**
 * The game with each player's team, and where the teams came from. GameFeed's when any player carries
 * one (`gamefeed`); else, in a game of more than two seats, GetMyGames' — from the per-game record when
 * kept, else asked once and kept (`my-games`); else the game as GameFeed sent it (`none`). Never throws.
 */
export async function resolveTeams(ctx: LiveContext, game: Game): Promise<{ game: Game; source: TeamSource }> {
  if (isTeamGame(game.players)) return { game, source: 'gamefeed' };
  if (game.players.length <= 2) return { game, source: 'none' };
  let teams = ctx.dataDir ? await readTeamRecord(ctx.dataDir, game.id) : undefined;
  if (!teams) {
    teams = await myGamesTeamsOf(ctx, game.id);
    if (!teams) return { game, source: 'none' };
    if (ctx.dataDir) await writeTeamRecord(ctx.dataDir, game.id, teams);
  }
  const resolved = withTeams(game, teams);
  return resolved ? { game: resolved, source: 'my-games' } : { game, source: 'none' };
}

/**
 * {@link resolveTeams} for a tool that has already found my seat (and refused what it refuses, so a
 * refusal reads nothing more): the game, the source, and my seat in the resolved game.
 */
export async function resolveTeamsFor(ctx: LiveContext, game: Game, me: Player): Promise<{ game: Game; source: TeamSource; me: Player }> {
  const r = await resolveTeams(ctx, game);
  return { ...r, me: r.game.players.find((p) => p.id === me.id) ?? me };
}
