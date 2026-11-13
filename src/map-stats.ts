// Per-map statistics from finished games (S6). Pure and deterministic: no I/O,
// ties on ascending id.
//
// A finished game is first reduced to a compact {@link GameRecord} (what the
// stats cache stores — ids, wins and turn numbers, never a name), and
// {@link mapStats} aggregates records per map: the most-picked starting
// territories, the win rate by starting bonus (the bonus a player's picks
// anchored), the turn of each player's first bonus completion, and the sample
// size. A rate on fewer than {@link MIN_SAMPLE} games is always flagged.
//
// The history shape is UNVERIFIED (docs/WARAPP-API.md "Board state"): records
// are read with the same loose parser as the planner's trend
// (`historyBoards`), and a game whose history does not parse still records its
// winner, with no starts.
import type { BoardState } from './board.js';
import type { Game, GameMap } from './normalize.js';
import { historyBoards } from './trend.js';

/** Below this many games a rate is reported only with a warning. */
export const MIN_SAMPLE = 5;

export interface PlayerRecord {
  /** GameFeed player id. */
  playerId: number;
  won: boolean;
  /** Territories the player held on the first board where any player held land. */
  starts: number[];
  /** The positive bonus holding most of the starts (ties: ascending id); null with no starts. */
  anchorBonusId: number | null;
  /**
   * The history entry number (completed turns) of the first board on which the
   * player held every territory of a positive bonus; null when never.
   */
  firstBonusTurn: number | null;
}

export interface GameRecord {
  gameId: number;
  mapId: number;
  /** Usable history boards read; 0 when the history did not parse. */
  turnsSeen: number;
  players: PlayerRecord[];
}

const byId = (a: number, b: number) => a - b;

const ownedBy = (board: BoardState, playerId: number): Set<number> =>
  new Set(
    board.territories
      .filter((t) => t.owner.kind === 'player' && t.owner.playerId === playerId)
      .map((t) => t.territoryId),
  );

/** Positive bonuses with territory members (superbonus members are not counted). */
const scoringBonuses = (map: GameMap) =>
  map.bonuses.filter((b) => b.value > 0 && b.territoryIds.length > 0).sort((a, b) => a.id - b.id);

/** Reduce a finished game (with `GetHistory`) to its stats record. Never throws on a bad history. */
export function recordFromGame(game: Game, map: GameMap): GameRecord {
  const boards = historyBoards(game.history, game.players);
  const start = boards.find(({ board }) => board.territories.some((t) => t.owner.kind === 'player'));
  const later = start ? boards.filter((b) => b.turn >= start.turn) : [];
  const bonuses = scoringBonuses(map);

  const players = [...game.players]
    .sort((a, b) => a.id - b.id)
    .map((p): PlayerRecord => {
      const starts = start ? [...ownedBy(start.board, p.id)].sort(byId) : [];
      let anchorBonusId: number | null = null;
      let best = 0;
      for (const b of bonuses) {
        const n = b.territoryIds.filter((t) => starts.includes(t)).length;
        if (n > best) {
          best = n;
          anchorBonusId = b.id;
        }
      }
      let firstBonusTurn: number | null = null;
      for (const { turn, board } of later) {
        const owned = ownedBy(board, p.id);
        if (bonuses.some((b) => b.territoryIds.every((t) => owned.has(t)))) {
          firstBonusTurn = turn;
          break;
        }
      }
      return { playerId: p.id, won: p.state === 'Won', starts, anchorBonusId, firstBonusTurn };
    });
  return { gameId: game.id, mapId: map.id, turnsSeen: boards.length, players };
}

export interface PickStat {
  territoryId: number;
  /** Players who started on it, across the sample. */
  picks: number;
  /** picks / games. */
  pickRate: number;
  /** Of those, players who went on to win. */
  winnerPicks: number;
}

export interface BonusWinRate {
  bonusId: number;
  /** Players whose picks anchored this bonus. */
  players: number;
  wins: number;
  winRate: number;
  /** True when fewer than {@link MIN_SAMPLE} players anchored it. */
  lowSample: boolean;
}

export interface FirstBonusStat {
  players: number;
  completed: number;
  neverCompleted: number;
  /** Median turn among players who completed one; null when none did. */
  median: number | null;
  byTurn: Array<{ turn: number; players: number }>;
  /** Median among winners who completed one; null when none did. */
  winnersMedian: number | null;
}

export interface MapStats {
  mapId: number;
  /** Finished games in the sample. */
  sampleSize: number;
  /** True when the sample is smaller than {@link MIN_SAMPLE} games. */
  lowSample: boolean;
  /** Present exactly when `lowSample`. */
  note?: string;
  mostPicked: PickStat[];
  winRateByStartingBonus: BonusWinRate[];
  firstBonusTurn: FirstBonusStat;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort(byId);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function statsFor(mapId: number, games: GameRecord[], top: number): MapStats {
  const picks = new Map<number, { picks: number; winnerPicks: number }>();
  const anchors = new Map<number, { players: number; wins: number }>();
  const turns: number[] = [];
  const winnerTurns: number[] = [];
  let players = 0;
  for (const g of games) {
    for (const p of g.players) {
      players++;
      for (const t of new Set(p.starts)) {
        const s = picks.get(t) ?? { picks: 0, winnerPicks: 0 };
        s.picks++;
        if (p.won) s.winnerPicks++;
        picks.set(t, s);
      }
      if (p.anchorBonusId !== null) {
        const a = anchors.get(p.anchorBonusId) ?? { players: 0, wins: 0 };
        a.players++;
        if (p.won) a.wins++;
        anchors.set(p.anchorBonusId, a);
      }
      if (p.firstBonusTurn !== null) {
        turns.push(p.firstBonusTurn);
        if (p.won) winnerTurns.push(p.firstBonusTurn);
      }
    }
  }
  const n = games.length;
  const lowSample = n < MIN_SAMPLE;
  const byTurn = new Map<number, number>();
  for (const t of turns) byTurn.set(t, (byTurn.get(t) ?? 0) + 1);
  const out: MapStats = {
    mapId,
    sampleSize: n,
    lowSample,
    mostPicked: [...picks.entries()]
      .sort(([ta, a], [tb, b]) => b.picks - a.picks || b.winnerPicks - a.winnerPicks || ta - tb)
      .slice(0, top)
      .map(([territoryId, s]) => ({ territoryId, picks: s.picks, pickRate: round2(s.picks / n), winnerPicks: s.winnerPicks })),
    winRateByStartingBonus: [...anchors.entries()]
      .sort(([ba, a], [bb, b]) => b.players - a.players || ba - bb)
      .map(([bonusId, a]) => ({
        bonusId,
        players: a.players,
        wins: a.wins,
        winRate: round2(a.wins / a.players),
        lowSample: a.players < MIN_SAMPLE,
      })),
    firstBonusTurn: {
      players,
      completed: turns.length,
      neverCompleted: players - turns.length,
      median: median(turns),
      byTurn: [...byTurn.entries()].sort(([a], [b]) => a - b).map(([turn, c]) => ({ turn, players: c })),
      winnersMedian: median(winnerTurns),
    },
  };
  if (lowSample) {
    out.note =
      `Only ${n} finished game${n === 1 ? '' : 's'} — fewer than ${MIN_SAMPLE}, so every rate here is ` +
      'anecdotal, not a trend.';
  }
  return out;
}

/**
 * Per-map statistics over finished-game records, ascending by map id. Duplicate
 * game ids count once (the first record wins).
 */
export function mapStats(games: readonly GameRecord[], opts: { top?: number } = {}): MapStats[] {
  const top = opts.top ?? 10;
  const seen = new Set<number>();
  const byMap = new Map<number, GameRecord[]>();
  for (const g of [...games].sort((a, b) => a.gameId - b.gameId)) {
    if (seen.has(g.gameId)) continue;
    seen.add(g.gameId);
    const list = byMap.get(g.mapId) ?? [];
    list.push(g);
    byMap.set(g.mapId, list);
  }
  return [...byMap.entries()].sort(([a], [b]) => a - b).map(([mapId, list]) => statsFor(mapId, list, top));
}
