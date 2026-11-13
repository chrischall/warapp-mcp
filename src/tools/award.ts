// What the award of picks tells the turn tools (#166): read once from my stored pick list on the
// first board after distribution (src/analysis/award.ts, src/pick-list.ts), then reused all game.
import { firstMoverOnTurn, readAward, type AwardReading, type AwardRole } from '../analysis/award.js';
import type { BoardState, TerritoryState } from '../board.js';
import { FOG_LEVEL_NAMES, FOG_LEVEL_OWNER_ONLY, FOG_LEVEL_VISIBLE } from '../live.js';
import type { Game, Player } from '../normalize.js';
import { readPickRecord, writeAward } from '../pick-list.js';

export interface AwardContext {
  reading: AwardReading;
  /** Two players: the other one. */
  opponent?: Player;
  /** Two players, cyclic move order: who moves first on the turn being planned. */
  firstMover: 'me' | 'opponent' | null;
  /**
   * The board to plan on. In a two-player game the opponent's starts that are still fogged carry
   * their owner (and, on turn 1, the starting armies); otherwise the board given.
   */
  board: BoardState;
  /** The fogged territories `board` gives the opponent, in list order. */
  assumed: number[];
  /** Armies each assumed territory is given (turn 1: the starting armies); `null` when only its owner is. */
  assumedArmies: number | null;
}

const isMine = (t: TerritoryState, me: number) => t.owner.kind === 'player' && t.owner.playerId === me;

/** The army count every territory of mine holds, when they all hold the same (the starting armies on turn 1). */
function uniformArmies(board: BoardState, me: number): number | null {
  const counts = new Set<number | null>();
  for (const t of board.territories) if (isMine(t, me)) counts.add(t.armies);
  const only = counts.size === 1 ? [...counts][0]! : null;
  return only !== null && only > 0 ? only : null;
}

/**
 * The award of `game` as `me` can read it, with the board to plan on; `undefined` when no pick
 * list is kept for this player, the list did not explain the start, or the first board has
 * passed unread. Reads the award (and keeps it) on turn 1; later turns reuse what was kept.
 * Never throws.
 */
export async function loadAward(
  dataDir: string | undefined,
  game: Game,
  me: Player,
  board: BoardState,
  turn: number | null,
): Promise<AwardContext | undefined> {
  if (!dataDir || turn === null || game.players.length < 2) return undefined;
  const record = await readPickRecord(dataDir, game.id, me.id);
  if (!record) return undefined;
  let reading = record.award;
  if (reading === undefined) {
    // Only the first board shows what was granted: later I hold what I captured, too.
    if (turn !== 1) return undefined;
    const mine = board.territories.filter((t) => isMine(t, me.id)).map((t) => t.territoryId);
    reading = readAward({ list: record.list, mine, players: game.players.length });
    const state = new Map(board.territories.map((t) => [t.territoryId, t]));
    // A start the board shows as nobody's, mine or a neutral cannot be another player's: the list is not the one awarded from.
    if (reading && reading.opponentStarts.some((t) => contradicts(state.get(t), me.id))) reading = null;
    await writeAward(dataDir, game.id, me.id, reading);
  }
  if (!reading) return undefined;

  const duel = game.players.length === 2;
  const opponent = duel ? game.players.find((p) => p.id !== me.id) : undefined;
  const firstMover = duel ? firstMoverOnTurn({ role: reading.role, turn, moveOrder: game.settings?.moveOrder }) : null;
  if (!opponent) return { reading, firstMover, board, assumed: [], assumedArmies: null };

  // A fogged start of the opponent's is its territory until the board shows otherwise. On turn 1
  // nobody has deployed, so it holds the starting armies; later only its owner is known.
  const assumedArmies = turn === 1 ? (uniformArmies(board, me.id) ?? game.settings?.initialPlayerArmiesPerTerritory ?? null) : null;
  const starts = new Set(reading.opponentStarts);
  const assumed: number[] = [];
  const territories = board.territories.map((t): TerritoryState => {
    if (!starts.has(t.territoryId) || t.owner.kind !== 'unknown') return t;
    assumed.push(t.territoryId);
    return {
      territoryId: t.territoryId,
      owner: { kind: 'player', playerId: opponent.id },
      armies: assumedArmies,
      fogLevel: FOG_LEVEL_NAMES[assumedArmies === null ? FOG_LEVEL_OWNER_ONLY : FOG_LEVEL_VISIBLE]!,
    };
  });
  const order = new Map(reading.opponentStarts.map((t, i) => [t, i]));
  assumed.sort((a, b) => order.get(a)! - order.get(b)!);
  return { reading, opponent, firstMover, board: assumed.length ? { ...board, territories } : board, assumed, assumedArmies };
}

/** On the first board: a territory the award calls another player's that the board shows as mine, a neutral or pickable. */
function contradicts(t: TerritoryState | undefined, me: number): boolean {
  if (!t || t.owner.kind === 'unknown') return false;
  return t.owner.kind !== 'player' || t.owner.playerId === me;
}

/** The one line a plan's warnings carry when its board holds territories the award gave an owner. */
export function assumedWarning(a: AwardContext): string[] {
  if (!a.assumed.length) return [];
  const many = a.assumed.length > 1;
  return [
    `Fogged territor${many ? 'ies' : 'y'} ${a.assumed.join(', ')} ${many ? 'are' : 'is'} planned as the opponent's` +
      (a.assumedArmies !== null ? ` (${a.assumedArmies} armies each, the starting armies)` : ' (armies unknown)') +
      `: your own pick list proves ${many ? 'they were' : 'it was'} its start (see \`award\`).`,
  ];
}


/** The award as a tool reports it: territories by `name`, and what it means in sentences (ids only). */
export function awardView<T>(
  a: AwardContext,
  game: Game,
  turn: number | null,
  name: (id: number) => T,
): {
  opponentStarts: T[];
  allStartsKnown: boolean;
  awarded: AwardRole | null;
  firstMover: 'you' | 'opponent' | null;
  opponentCommanderStart?: T | null;
  assumedOnBoard: T[];
  notes: string[];
} {
  const { reading } = a;
  const duel = game.players.length === 2;
  const whose = duel ? "the opponent's" : "another player's";
  const ids = (xs: readonly number[]) => xs.join(', ');
  const notes: string[] = [];
  if (reading.opponentStarts.length)
    notes.push(
      `Your pick list ranked territor${reading.opponentStarts.length === 1 ? 'y' : 'ies'} ${ids(reading.opponentStarts)} above a pick you were granted, ` +
        `so ${reading.opponentStarts.length === 1 ? 'it was' : 'they were'} taken first: ${whose} start${reading.opponentStarts.length === 1 ? '' : 's'}` +
        (reading.allStartsKnown ? ' (every start it has).' : '.'),
    );
  else notes.push('You were granted the top of your list, so the award shows no start of another player.');
  if (reading.unlisted.length)
    notes.push(`Your list ran out: territor${reading.unlisted.length === 1 ? 'y' : 'ies'} ${ids(reading.unlisted)} ${reading.unlisted.length === 1 ? 'was' : 'were'} given to you at random.`);
  if (a.assumed.length)
    notes.push(
      `Still fogged, territor${a.assumed.length === 1 ? 'y' : 'ies'} ${ids(a.assumed)} ${a.assumed.length === 1 ? 'is' : 'are'} planned as the opponent's` +
        (a.assumedArmies !== null ? ` with the ${a.assumedArmies} starting armies (nobody has deployed yet).` : ' (armies unknown).'),
    );
  if (duel && reading.role)
    notes.push(
      `Only the ${reading.role} awarded can be granted this set` +
        (a.firstMover
          ? `; under this game's ${game.settings?.moveOrder} move order the first awarded moves second on turn 1 and the order alternates, so ` +
            `${a.firstMover === 'me' ? 'you move' : 'the opponent moves'} first on turn ${turn} (an Order Priority or Order Delay card changes that). ` +
            'This is the community wiki\'s rule, not verified live.'
          : '.'),
    );
  const commanders = game.settings?.commanders === true;
  if (commanders && duel && reading.opponentFirstAward !== null)
    notes.push(
      `Territory ${reading.opponentFirstAward} was the opponent's first award, and a commander starts on its owner's first award: ` +
        `its commander ${turn === 1 ? 'is' : 'started'} there.`,
    );
  return {
    opponentStarts: reading.opponentStarts.map(name),
    allStartsKnown: reading.allStartsKnown,
    awarded: duel ? reading.role : null,
    firstMover: a.firstMover === null ? null : a.firstMover === 'me' ? 'you' : 'opponent',
    ...(commanders && duel ? { opponentCommanderStart: reading.opponentFirstAward === null ? null : name(reading.opponentFirstAward) } : {}),
    assumedOnBoard: a.assumed.map(name),
    notes,
  };
}
