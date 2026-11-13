// Game profile: what kind of game this is, from one player's view — the format, the
// settings that shape strategy, the phase and whether I am ahead. In a free-for-all the
// contact phase needs a real front (#132): an enemy stack that can take a territory of mine
// as the board stands, or most of my borders facing enemies — not one enemy territory beside me. Pure and deterministic;
// no I/O. The planner (rule 0p in planner.ts) reads it to pick a default goal and to tune
// its scoring; the plan echoes it.

import type { BoardState } from '../board.js';
import { carriesTeam } from '../teams.js';
import { armiesToTake } from './combat.js';
import { neighborsOf, type MapGraph } from './graph.js';

/** Ahead when my income is at least this many times the strongest opponent's estimated income. */
export const AHEAD_RATIO = 1.25;
/** Behind when my income is at most this many times the strongest opponent's estimated income. */
export const BEHIND_RATIO = 0.8;
/**
 * A player's strength in a free-for-all ranking (#167): its visible armies plus this many turns of
 * its income — what it can field over the next few turns.
 */
export const STRENGTH_INCOME_TURNS = 3;

export type GameFormat = '1v1' | 'ffa' | 'teams';
export type GamePhase = 'opening' | 'expansion' | 'contact' | 'late';
export type GameStanding = 'ahead' | 'even' | 'behind' | 'unknown';

/** One player of the game, as far as the profile needs it (GameFeed ids, like the board's). */
export interface ProfilePlayer {
  id: number;
  /** Its team; absent or -1 (`NO_TEAM`) in a no-team game. */
  team?: number;
  /** GameFeed state, e.g. `Playing`, `Eliminated`; absent counts as `Playing`. */
  state?: string;
  /** #178: an AI seat (`isAI`). */
  isAI?: boolean;
  /** #178: a human whose seat an AI now plays (`humanTurnedIntoAI`). */
  humanTurnedIntoAI?: boolean;
}

/** The settings the profile echoes; every one optional (off / unknown when absent). */
export interface ProfileSettings {
  /** Fraction (0.16) or percent (16). */
  luckModifier?: number;
  roundingMode?: string;
  /** Any card is in play. */
  cards?: boolean;
  localDeployments?: boolean;
  noSplit?: boolean;
  commanders?: boolean;
  /** GameFeed's `Fog` setting, e.g. `Foggy`, `NoFog`. */
  fog?: string;
  /** Kill rates in percent (default 60 / 70): whether an enemy stack can take a territory of mine (FFA contact). */
  offensiveKillRate?: number;
  defensiveKillRate?: number;
  /** Default true: one army stays behind on every attack. */
  oneArmyStandsGuard?: boolean;
}

export interface ProfileInput {
  graph: MapGraph;
  board: BoardState;
  me: number;
  /** Every player of the game; empty when unknown (the board's players stand in). */
  players: readonly ProfilePlayer[];
  settings?: ProfileSettings;
  /** The turn being played; `null` / absent when unknown. */
  turn?: number | null;
  /** Territories are still being picked. */
  picking?: boolean;
  /** My income this turn. */
  income: number;
  /**
   * Each visible opponent's estimated income (the planner's per-opponent deploy estimate);
   * `tracked` is its income tracked over several turns (`trackOpponents`), `null` / absent when
   * its track is too short to trust; `source` `'prior'` when the fog prior (#119) set it — a
   * floor of my own income, not a reading, which the standing note says.
   */
  estimates: ReadonlyArray<{ playerId: number; estimate: number; tracked?: number | null; source?: string }>;
  /**
   * Opponents with no territory in view (#94, `trackOpponents`): for how many turns, and the
   * armies they must have received since the game started (a lower bound). The 'unknown'
   * standing note names them.
   */
  unseen?: ReadonlyArray<{ playerId: number; turnsUnseen: number; turnsUnseenAtLeast?: boolean; earnedAtLeast: number }>;
  /** #178: the end-of-game settings the profile reads (`Game.endRules`). */
  endRules?: { aisSurrenderWhenOneHumanRemains?: boolean };
}

export interface GameProfile {
  format: GameFormat;
  /** Opponents still playing (teammates excluded). */
  opponents: number;
  settings: {
    /** Percent. */
    luck: number;
    rounding: string | null;
    cards: boolean;
    localDeployments: boolean;
    noSplit: boolean;
    commanders: boolean;
    fog: string | null;
  };
  phase: GamePhase;
  standing: GameStanding;
  /**
   * What the standing rests on: `visible` (most of the board is in view), `tracked` (the fog hides
   * most of it, but every opponent's income is tracked over several turns, #97), `null` when unknown.
   */
  standingSource: 'visible' | 'tracked' | null;
  /**
   * #167, a free-for-all only: every player in sight ranked by strength (visible armies +
   * {@link STRENGTH_INCOME_TURNS} × income; an opponent's figures are lower bounds under fog),
   * strongest first (ties: id). `leader` is the first; `myRank` is 1-based. `commonThreat` is the
   * leader when it is not me — the player the others combine against.
   */
  ranking?: FfaRanking;
  /** #178: humans still playing, me included (an AI seat, or a human an AI now plays, is not one). */
  humansAlive: number;
  /** #178: opponents still playing that an AI plays, by id. */
  aiOpponents: number[];
  /**
   * #178: with `AIsSurrenderWhenOneHumanRemains` on, the one other human still playing (not a
   * teammate): the AIs give up once one human is left, so the game ends with that player or me.
   * `null` otherwise.
   */
  endsWith: number | null;
  notes: string[];
}

export interface FfaRanking {
  leader: number;
  myRank: number;
  of: number;
  commonThreat: number | null;
  players: { playerId: number; armies: number; income: number; strength: number }[];
}

/** Player states that never held a seat: they did not start the game. */
const NEVER_SEATED = new Set(['Invited', 'Declined', 'RemovedByHost']);
const playing = (p: ProfilePlayer) => (p.state ?? 'Playing') === 'Playing';

function luckPercent(v: number | undefined): number {
  if (!v || v <= 0) return 0;
  return Math.round((v > 1 ? v : v * 100) * 100) / 100;
}

export function gameProfile(input: ProfileInput): GameProfile {
  const { graph: g, board, me } = input;
  const notes: string[] = [];
  const s = input.settings ?? {};

  // ---- who is playing, and on which side ----
  const owners = new Map<number, number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.armies !== null)
      owners.set(t.territoryId, t.owner.playerId);
  let players = input.players;
  if (!players.length) {
    players = [{ id: me }, ...[...new Set(owners.values())].filter((p) => p !== me).sort((a, b) => a - b).map((id) => ({ id }))];
    notes.push('No player list: the opponents are the players in sight on the board.');
  }
  const teams = players.some((p) => carriesTeam(p.team));
  const myTeam = players.find((p) => p.id === me)?.team;
  /** Players on my side (me, and my teammates in a team game). */
  const ally = (id: number) =>
    id === me || (teams && carriesTeam(myTeam) && players.find((p) => p.id === id)?.team === myTeam);
  const opponents = players.filter((p) => !ally(p.id) && playing(p)).length;
  const started = players.filter((p) => !NEVER_SEATED.has(p.state ?? 'Playing')).length;
  const format: GameFormat = teams ? 'teams' : opponents <= 1 ? '1v1' : 'ffa';
  // #178: who is human, and who the game ends with when the AIs surrender to the last human.
  const machine = (p: ProfilePlayer) => p.isAI === true || p.humanTurnedIntoAI === true;
  const humans = players.filter((p) => playing(p) && !machine(p));
  const humansAlive = humans.length;
  const aiOpponents = players.filter((p) => playing(p) && machine(p) && !ally(p.id)).map((p) => p.id).sort((a, b) => a - b);
  const otherHumans = humans.filter((p) => p.id !== me);
  let endsWith: number | null = null;
  if (input.endRules?.aisSurrenderWhenOneHumanRemains === true && aiOpponents.length && otherHumans.length === 1 && !ally(otherHumans[0]!.id)) {
    endsWith = otherHumans[0]!.id;
    notes.push(`AIs surrender once one human remains: the game ends with player ${endsWith} or me, whatever the AIs hold.`);
  }

  // ---- phase ----
  const mine = [...owners].filter(([, p]) => p === me).map(([t]) => t);
  const enemyAt = (t: number) => {
    const p = owners.get(t);
    return p !== undefined && !ally(p);
  };
  const touches = mine.some((t) => neighborsOf(g, t).some(enemyAt));
  // #132: in a free-for-all one enemy territory beside me is not contact — it switched the opening
  // rules off from turn 3 in most saved FFA plans. Contact there is an enemy stack that can take a
  // territory of mine as the board stands (its movable armies beside it, one player at a time,
  // against what taking it needs at the game's kill rates), or most of my borders facing enemies.
  // Short of that the phase stays expansion, so rule 4f keeps committing while neutrals are in reach.
  let contact = touches;
  if (touches && format === 'ffa') {
    const guard = s.oneArmyStandsGuard === false ? 0 : 1;
    const rates = {
      ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
      ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
    };
    const armies = new Map(
      board.territories.filter((t) => g.territoryById.has(t.territoryId)).map((t) => [t.territoryId, t.armies]),
    );
    const mineSet = new Set(mine);
    const threatened = mine.some((t) => {
      const take = armiesToTake(armies.get(t) ?? 0, rates);
      if (take === null) return false;
      const movable = new Map<number, number>();
      for (const n of neighborsOf(g, t)) {
        const p = owners.get(n);
        const a = armies.get(n);
        if (p === undefined || ally(p) || a === null || a === undefined) continue;
        movable.set(p, (movable.get(p) ?? 0) + Math.max(0, a - guard));
      }
      return [...movable.values()].some((m) => m >= take);
    });
    const borders = mine.filter((t) => neighborsOf(g, t).some((n) => !mineSet.has(n)));
    const facing = borders.filter((t) => neighborsOf(g, t).some(enemyAt)).length;
    contact = threatened || facing * 2 > borders.length;
  }
  const side = (p: number) => (teams ? (players.find((x) => x.id === p)?.team ?? p) : p);
  const bySide = new Map<string, number>();
  for (const p of owners.values()) {
    const key = teams && carriesTeam(players.find((x) => x.id === p)?.team) ? `team ${side(p)}` : `player ${p}`;
    bySide.set(key, (bySide.get(key) ?? 0) + 1);
  }
  const total = g.territoryById.size;
  const dominant = [...bySide].find(([, n]) => n > total / 2);
  let phase: GamePhase;
  if (input.picking || (input.turn !== null && input.turn !== undefined && input.turn <= 2)) phase = 'opening';
  else if (started >= 3 && opponents === 1) {
    phase = 'late';
    notes.push(`Late game: one opponent is left of the ${started} players who started.`);
  } else if (dominant) {
    phase = 'late';
    notes.push(`Late game: ${dominant[0]} holds ${dominant[1]} of the map's ${total} territories, over half.`);
  } else phase = contact ? 'contact' : 'expansion';

  // ---- standing ----
  let standing: GameStanding;
  const enemies = input.estimates.filter((e) => !ally(e.playerId)).sort((a, b) => b.estimate - a.estimate || a.playerId - b.playerId);
  const visible = new Map(board.territories.filter((t) => g.territoryById.has(t.territoryId)).map((t) => [t.territoryId, t]));
  const mineSet = new Set(mine);
  const notMine = [...g.territoryById.keys()].filter((t) => !mineSet.has(t));
  const foggedCount = notMine.filter((t) => {
    const st = visible.get(t);
    return !st || st.owner.kind === 'unknown' || st.armies === null;
  }).length;
  const strongest = enemies[0];
  // #94: an opponent out of sight is the most dangerous case; the 'unknown' note says what it has received.
  const unseen = (input.unseen ?? [])
    .filter((u) => !ally(u.playerId))
    .sort((a, b) => a.playerId - b.playerId)
    .map(
      (u) =>
        ` Player ${u.playerId} has been out of sight for ${u.turnsUnseenAtLeast ? 'at least ' : ''}${u.turnsUnseen} turn${u.turnsUnseen === 1 ? '' : 's'} and has received at least ${u.earnedAtLeast} armies: it could be banking up to roughly that, minus what its expansion cost.`,
    )
    .join('');
  let standingSource: GameProfile['standingSource'] = null;
  /** How the strongest estimate is described: the fog prior is a floor of my own income (#119). */
  const priorNote = `, a fog prior: assumed to earn at least my own income, so "ahead" is out of reach unless what it could earn on this board caps it`;
  const fromPrior = strongest?.source === 'prior';
  // #97: under fog, a standing from tracked income needs every opponent still playing to be in
  // sight with a trusted track (an unseen one could be anything).
  const unseenEnemies = (input.unseen ?? []).filter((u) => !ally(u.playerId));
  const trackedAll =
    enemies.length > 0 && enemies.length >= opponents && !unseenEnemies.length && enemies.every((e) => e.tracked !== undefined && e.tracked !== null);
  if (!strongest) {
    standing = 'unknown';
    notes.push(`Standing unknown: no opponent is in sight, so its income cannot be estimated.${unseen}`);
  } else if (notMine.length && foggedCount > notMine.length / 2 && trackedAll) {
    // #97: the fog hides most of the board, but every opponent in the game is in sight with an
    // income tracked over several turns — compare against that, and say it is a tracked figure.
    const ratio = strongest.estimate > 0 ? input.income / strongest.estimate : Infinity;
    standing = ratio >= AHEAD_RATIO ? 'ahead' : ratio <= BEHIND_RATIO ? 'behind' : 'even';
    standingSource = 'tracked';
    notes.push(
      `Standing ${standing} (tracked): my income ${input.income} against the strongest opponent, player ${strongest.playerId} (~${strongest.estimate}${fromPrior ? priorNote : ' tracked over several turns'})${
        standing === 'ahead' ? `, at least ${AHEAD_RATIO}×` : standing === 'behind' ? `, at most ${BEHIND_RATIO}×` : ''
      }. ${foggedCount} of the ${notMine.length} territories I do not hold are in the fog, so income it hides from its observed deploys is not counted.`,
    );
  } else if (notMine.length && foggedCount > notMine.length / 2) {
    standing = 'unknown';
    notes.push(
      `Standing unknown: ${foggedCount} of the ${notMine.length} territories I do not hold are in the fog, so the opponents' income is mostly unseen.${unseen}`,
    );
  } else {
    const ratio = strongest.estimate > 0 ? input.income / strongest.estimate : Infinity;
    standing = ratio >= AHEAD_RATIO ? 'ahead' : ratio <= BEHIND_RATIO ? 'behind' : 'even';
    standingSource = 'visible';
    notes.push(
      `Standing ${standing}: my income ${input.income} against the strongest opponent, player ${strongest.playerId} (~${strongest.estimate}${fromPrior ? priorNote : ' estimated'})${
        standing === 'ahead' ? `, at least ${AHEAD_RATIO}×` : standing === 'behind' ? `, at most ${BEHIND_RATIO}×` : ''
      }.`,
    );
  }

  // ---- the armies on the board overrule an income comparison ----
  // An opponent's visible armies are a lower bound on what it has, and mine are exact, so being
  // outnumbered in view is certain where an income estimate is not. Live, the standing read
  // "ahead (23 against ~12 tracked)" while I held 65 armies against 138 in view, and "unknown"
  // against 893.
  const armiesBy = new Map<number, number>();
  for (const t of board.territories)
    if (g.territoryById.has(t.territoryId) && t.owner.kind === 'player' && t.armies !== null)
      armiesBy.set(t.owner.playerId, (armiesBy.get(t.owner.playerId) ?? 0) + t.armies);
  const myArmies = armiesBy.get(me) ?? 0;
  const rival = [...armiesBy].filter(([p]) => !ally(p)).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  if (rival && rival[1] > 0 && mine.length) {
    const [rivalId, theirArmies] = rival;
    if (myArmies * 2 < theirArmies && standing !== 'behind') {
      notes.push(
        `Standing behind, whatever the incomes (it read ${standing}): my ${myArmies} visible armies are less than half of player ${rivalId}'s ${theirArmies} in view, and what it shows is the least it has.`,
      );
      standing = 'behind';
      standingSource ??= 'visible';
    } else if (standing === 'ahead' && myArmies < BEHIND_RATIO * theirArmies) {
      notes.push(
        `Not ahead: the income comparison says so, but my ${myArmies} visible armies are below ${BEHIND_RATIO}× player ${rivalId}'s ${theirArmies} in view. Standing even.`,
      );
      standing = 'even';
    }
  }

  // ---- #167: who leads a free-for-all ----
  let ranking: FfaRanking | undefined;
  if (format === 'ffa' && mine.length) {
    const incomeOf = new Map(input.estimates.filter((e) => !ally(e.playerId)).map((e) => [e.playerId, e.estimate]));
    const rows = [
      { playerId: me, armies: myArmies, income: input.income },
      ...[...armiesBy]
        .filter(([p]) => !ally(p))
        .map(([p, armies]) => ({ playerId: p, armies, income: incomeOf.get(p) ?? 0 })),
    ]
      .map((r) => ({ ...r, strength: r.armies + STRENGTH_INCOME_TURNS * r.income }))
      .sort((a, b) => b.strength - a.strength || a.playerId - b.playerId);
    const leader = rows[0]!.playerId;
    const myRank = rows.findIndex((r) => r.playerId === me) + 1;
    ranking = { leader, myRank, of: rows.length, commonThreat: leader === me ? null : leader, players: rows };
    notes.push(
      leader === me
        ? `FFA ranking: I lead ${rows.length} players in sight on strength (armies + ${STRENGTH_INCOME_TURNS} × income: ${rows[0]!.strength}${rows[1] ? ` against player ${rows[1].playerId}'s ${rows[1].strength}` : ''}); the others may combine against me.`
        : `FFA ranking: player ${leader} leads on strength (armies + ${STRENGTH_INCOME_TURNS} × income: ${rows[0]!.strength}); I am ${myRank} of ${rows.length} in sight (${rows[myRank - 1]!.strength}). Opponents' figures are lower bounds under fog.`,
    );
  }

  return {
    format,
    opponents,
    settings: {
      luck: luckPercent(s.luckModifier),
      rounding: s.roundingMode ?? null,
      cards: s.cards === true,
      localDeployments: s.localDeployments === true,
      noSplit: s.noSplit === true,
      commanders: s.commanders === true,
      fog: s.fog ?? null,
    },
    phase,
    standing,
    standingSource,
    ...(ranking ? { ranking } : {}),
    humansAlive,
    aiOpponents,
    endsWith,
    notes,
  };
}
