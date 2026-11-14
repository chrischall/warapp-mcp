// What the award of picks tells the turn tools (#166): read once from my stored pick list on the
// first board after distribution (src/analysis/award.ts, src/pick-list.ts), then reused all game.
import { firstMoverOnTurn, isCyclicMoveOrder, readAward, type AwardReading, type AwardRole } from '../analysis/award.js';
import type { MapGraph } from '../analysis/graph.js';
import { openingIncome, PICK_HORIZON } from '../analysis/picks.js';
import type { BoardState, TerritoryState } from '../board.js';
import { FOG_LEVEL_NAMES, FOG_LEVEL_OWNER_ONLY, FOG_LEVEL_VISIBLE } from '../live.js';
import type { Game, Player } from '../normalize.js';
import { readFirstMover, resolveFirstMover, writeFirstMover, type FirstMover, type FirstMoverSource } from '../move-order.js';
import { readPickRecord, writeAward } from '../pick-list.js';
import { pickSettings } from './picks.js';

export interface AwardContext {
  reading: AwardReading;
  /** Two players: the other one. */
  opponent?: Player;
  /** Two players, `Cycle` move order (#127: not NoLuckCycle): who moves first on the turn being planned. */
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
  /** The territories that were pickable during distribution, when the pick record kept them. */
  pickable?: number[];
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
  // A record that keeps only the pickable territories has no list to read the award from.
  if (!record?.list) return undefined;
  let reading = record.award;
  if (reading === undefined) {
    // Only the first board shows what was granted: later I hold what I captured, too.
    if (turn !== 1) return undefined;
    const mine = board.territories.filter((t) => isMine(t, me.id)).map((t) => t.territoryId);
    reading = readAward({ list: record.list, mine, players: game.players.length });
    const state = new Map(board.territories.map((t) => [t.territoryId, t]));
    // A start the board shows as nobody's, mine or a neutral cannot be another player's: the list is not the one awarded from.
    if (reading?.opponentStarts.some((t) => contradicts(state.get(t), me.id))) reading = null;
    await writeAward(dataDir, game.id, me.id, reading);
  }
  if (!reading) return undefined;
  const pickable = record.pickable ? { pickable: record.pickable } : {};

  const duel = game.players.length === 2;
  const opponent = duel ? game.players.find((p) => p.id !== me.id) : undefined;
  const firstMover = duel ? firstMoverOnTurn({ role: reading.role, turn, moveOrder: game.settings?.moveOrder }) : null;
  if (!opponent) return { reading, firstMover, board, assumed: [], assumedArmies: null, ...pickable };

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
  return { reading, opponent, firstMover, board: assumed.length ? { ...board, territories } : board, assumed, assumedArmies, ...pickable };
}

/**
 * The opening threat model (#166): in a two-player game whose award proved every start the
 * opponent has, its income on `turn` as the pick advisor's opening simulation gives it from those
 * starts (`openingIncome`; my starts are never its captures), keyed by its GameFeed id, for the
 * planner's fog prior (`PlanGameContext.opening`). Only on turns 1..PICK_HORIZON + 1, the turns the
 * simulation covers; `undefined` otherwise. Neutral sizes are the ones `seen` (the board as war.app
 * showed it) gives, then the settings.
 */
export function openingThreat(
  a: AwardContext | undefined,
  game: Game,
  graph: MapGraph,
  seen: BoardState,
  turn: number | null,
): ReadonlyMap<number, number> | undefined {
  if (!a?.opponent || game.players.length !== 2 || !a.reading.allStartsKnown || !a.reading.opponentStarts.length) return undefined;
  if (turn === null || turn < 1 || turn > PICK_HORIZON + 1) return undefined;
  const neutralArmies = new Map<number, number>();
  for (const t of seen.territories) if (t.owner.kind === 'neutral' && t.armies !== null) neutralArmies.set(t.territoryId, t.armies);
  const income = openingIncome({
    graph,
    starts: a.reading.opponentStarts,
    settings: pickSettings(game.settings),
    taken: [...a.reading.granted, ...a.reading.unlisted],
    neutralArmies,
    ...(a.pickable ? { pickable: a.pickable } : {}),
  });
  return new Map([[a.opponent.id, income[turn - 1]!]]);
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
            "This is the community wiki's rule and the game client's help text, not verified live."
          : game.settings?.moveOrder === 'NoLuckCycle'
            ? '; under a no-luck cycle play speed, not the award, set who moves first: the game shows it (Game → Move Order), so pass it as `first_mover`.'
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

/** Who moves first, as warapp_plan_turn reports it: `null` when unknown. */
export interface FirstMoverView {
  who: 'you' | 'opponent';
  /** `explicit`: `first_mover` given; `award`: the award of picks; `remembered`: alternated from the turn in `from`. */
  source: FirstMoverSource | 'remembered';
  from?: { turn: number; source: FirstMoverSource };
}

/**
 * Who moves first on `turn` (#127): `first_mover` when given, else what this server knows — a
 * turn kept at `<dataDir>/move-order/` alternated, or the award of picks — in a two-player game
 * under a cyclic move order. What is newly known is kept for later turns. Never throws.
 */
export async function firstMoverFor(
  dataDir: string | undefined,
  game: Game,
  me: Player,
  turn: number | null,
  explicit: FirstMover | undefined,
  award: AwardContext | undefined,
): Promise<{ firstMover?: FirstMover; view: FirstMoverView | null; warnings: string[] }> {
  const cyclicDuel = game.players.length === 2 && isCyclicMoveOrder(game.settings?.moveOrder);
  const remembered = dataDir && cyclicDuel ? await readFirstMover(dataDir, game.id, me.id) : undefined;
  const { resolved, record, warnings } = resolveFirstMover({
    turn,
    cyclicDuel,
    ...(explicit ? { explicit } : {}),
    award: award?.firstMover ?? null,
    ...(remembered ? { remembered } : {}),
  });
  if (dataDir && record) await writeFirstMover(dataDir, game.id, me.id, record);
  if (!resolved) return { view: null, warnings };
  return {
    firstMover: resolved.firstMover,
    view: { who: resolved.firstMover === 'me' ? 'you' : 'opponent', source: resolved.source, ...(resolved.from ? { from: resolved.from } : {}) },
    warnings,
  };
}
