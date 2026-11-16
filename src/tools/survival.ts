// Surviving a wrong estimate (#275, pattern 1), as the tools show it: the broken-estimate tripwire
// (src/analysis/tripwire.ts) read over my board history and the survival side store (src/trend.ts), and
// the headroom table (src/analysis/headroom.ts) in a view. warapp_plan_turn writes the store;
// warapp_check_plan and warapp_submit_turn only read.
import { headroomTable, type HeadroomInput, type HeadroomRow } from '../analysis/headroom.js';
import type { EnemyDeployEstimate } from '../analysis/plan/shared.js';
import { symmetricStart, trackGame, type TurnBoard } from '../analysis/opponents.js';
import { activeTripwires, brokenEstimates, type Tripwire } from '../analysis/tripwire.js';
import type { MapGraph } from '../analysis/graph.js';
import type { SimSettings } from '../analysis/turn-sim.js';
import type { GameMap, GameSettings } from '../normalize.js';
import { readSurvival, writeSurvival, type Survival } from '../trend.js';
import { carriesTeam } from '../teams.js';
import { opponentCanHold } from './card-advice.js';
import { namer } from './common.js';

/** Headroom rows the compact view lists (the weakest first); the full view lists them all. */
export const HEADROOM_COMPACT = 10;

export interface TripwireRead {
  /** The opponents untrusted this turn, by player id. */
  tripwires: Tripwire[];
  /** This turn's estimate per opponent (what warapp_plan_turn keeps for the next turns' tripwire). */
  estimatesNow: Map<number, number>;
  /**
   * The marks warapp_plan_turn keeps: `tripwires`, or the stored marks unchanged while the teams are
   * unknown (none is applied then, and none is erased: one call that cannot read the teams must not
   * clear a mark the next call, with the teams read, still needs).
   */
  keep: Tripwire[];
  survival: Survival;
}

/**
 * The tripwires running on `turn`: the marks kept, and one from each observation on my latest two
 * boards that this turn's estimates (or the ones kept for the turns it reads) cannot explain. None while
 * the teams are unknown (`teamsKnown: false`: a game of 3+ seats whose teams could not be read, where an
 * opponent may be a teammate), and no observation once an opponent may hold an Airlift card (the card
 * clock); no capture or held attack once one may hold a Bomb. A static seat (#270) and a player with no
 * estimate this turn or kept are never read. While the teams are unknown the stored marks are kept unchanged (`keep`), never applied. Never throws.
 */
export async function readTripwires(a: {
  dataDir: string | undefined;
  gameId: number;
  me: number;
  turn: number | null;
  graph: MapGraph;
  /** My boards, oldest first, this turn's last. */
  boards: readonly TurnBoard[];
  settings: SimSettings;
  teams?: ReadonlyMap<number, number>;
  estimates: readonly EnemyDeployEstimate[];
  /** Players a Diplomacy card in force keeps at peace with me: no held attack of mine is read on them. */
  peace?: Iterable<number>;
  /** Whether the teams are known (`resolveTeams`); false: nothing is read. Default true. */
  teamsKnown?: boolean;
  /**
   * The game's settings and map: every player's start, credited to a stack no board ever showed (only
   * when the start was even, `symmetricStart`: never in a custom scenario); the Airlift card.
   */
  gameSettings?: GameSettings;
  map?: GameMap;
  /** #270: players out of the game whose seat no AI plays (`staticSeats`): never read. */
  staticSeats?: ReadonlySet<number> | ReadonlyMap<number, unknown>;
}): Promise<TripwireRead> {
  const estimatesNow = new Map(a.estimates.map((e) => [e.playerId, e.estimate]));
  const survival = a.dataDir ? await readSurvival(a.dataDir, a.gameId, a.me) : { estimates: new Map(), tripwires: [] };
  if (a.teamsKnown === false) return { tripwires: [], estimatesNow, survival, keep: [...survival.tripwires] };
  if (a.turn === null) return { tripwires: [], estimatesNow, survival, keep: [] };
  let fresh: ReturnType<typeof brokenEstimates> = [];
  try {
    // A start only when every player began alike (#275 review): a custom scenario sets each start by
    // hand, and unread distribution may be one, so the settings' territory limit × armies says nothing
    // of what a stack never seen began with — no start, and such a stack is not read.
    const start = symmetricStart(a.gameSettings) ? trackGame([], a.gameSettings, a.map).start : undefined;
    fresh = brokenEstimates({
      ...(start ? { start } : {}),
      graph: a.graph,
      boards: a.boards,
      me: a.me,
      settings: a.settings,
      ...(a.teams ? { teams: a.teams } : {}),
      ...(a.peace ? { peace: new Set(a.peace) } : {}),
      ...(opponentCanHold(a.gameSettings, 'Airlift', a.turn) ? { airlift: true } : {}),
      ...(opponentCanHold(a.gameSettings, 'Bomb', a.turn) ? { bomb: true } : {}),
      ...(a.staticSeats?.size ? { staticSeats: a.staticSeats } : {}),
      // The estimate the plan of that turn used when kept, else a stand-in: the most it was kept at or is
      // now (#275 review: today's figure alone under-counts an opponent whose estimate a bonus break has
      // lowered since). None for a player with no estimate now (a static seat is neutralized, #270): it is
      // not read. The stock bound reads only kept figures (`estimateKept`).
      estimateAt: (p, t) => {
        const now = estimatesNow.get(p);
        if (now === undefined) return undefined;
        const kept = survival.estimates.get(t)?.get(p);
        if (kept !== undefined) return kept;
        let most = now;
        for (const row of survival.estimates.values()) most = Math.max(most, row.get(p) ?? 0);
        return most;
      },
      estimateKept: (p, t) => survival.estimates.get(t)?.has(p) === true,
      // My Gift of a territory is no capture; with my card plays unrecorded, captures of mine are unknown.
      ...(!a.gameSettings || a.gameSettings.cards.includes('Gift') ? { gift: true } : {}),
    });
  } catch {
    // A board this reader cannot follow: no observation.
  }
  const tripwires = activeTripwires(survival.tripwires, fresh, a.turn);
  return { tripwires, estimatesNow, survival, keep: tripwires };
}

/** Keep this turn's estimates and the marks `read.keep` names (warapp_plan_turn only). Never throws. */
export async function keepTripwires(dataDir: string | undefined, gameId: number, me: number, turn: number | null, read: TripwireRead): Promise<void> {
  if (!dataDir || turn === null) return;
  await writeSurvival(dataDir, gameId, me, turn, { estimates: read.estimatesNow, tripwires: read.keep });
}

/** What an untrusted opponent is sized for: the larger of what tripped it and my own income. */
export const untrustedDeploy = (w: Tripwire, myIncome: number): number => Math.max(w.implied, Math.max(0, Math.floor(myIncome)));

const KIND_TEXT: Record<Tripwire['kind'], string> = {
  'fog-stack': 'a stack out of the fog',
  capture: 'a capture',
  'held-attack': 'an attack of yours it held',
};

/**
 * One warning per untrusted opponent, by id (the first warning of the answer). `sizedFor` is the figure
 * the plan or the stress test used for it (`untrustedDeploy` on the income they used), so the warning
 * never names another. `whatIf` is the caller's `enemy_deploy`: the planner then ignores the mark, and
 * the warning names that figure instead.
 */
export function tripwireWarnings(
  tripwires: readonly Tripwire[],
  sizedFor: (w: Tripwire) => number,
  estimateOf: (player: number) => number | undefined,
  whatIf?: number,
): string[] {
  return tripwires.map((w) => {
    const est = estimateOf(w.player);
    return (
      `Player ${w.player}'s deploy estimate${est !== undefined ? ` (${est})` : ''} is untrusted until turn ${w.until} (#275): on turn ${w.since} ` +
      `${KIND_TEXT[w.kind]} on territory ${w.territory} needed ${w.observed} armies where the estimate allowed ${w.allowed}, ` +
      `about ${w.implied} a turn. ` +
      (whatIf !== undefined
        ? `This what-if plan sizes every border for enemy_deploy ${whatIf} instead; without it, borders of your held ` +
          `bonuses facing it would be sized for ${sizedFor(w)} (the larger of that and your own income).`
        : `Borders of your held bonuses facing it are sized for ${sizedFor(w)} ` +
          '(the larger of that and your own income), and warapp_check_plan tries that deploy by default.')
    );
  });
}

/** The headroom table on these orders, never throwing (an empty table when the board cannot be carried out). */
export function safeHeadroom(input: HeadroomInput): HeadroomRow[] {
  try {
    return headroomTable(input);
  } catch {
    return [];
  }
}

/**
 * The headroom table as the tools show it: names beside ids, each row with whether it is below my income.
 * `mayBeTeammate` (the teams unknown, `resolveTeams`' `known: false`): every row says its opponent may be a teammate.
 */
export function headroomView(rows: readonly HeadroomRow[], map: GameMap, myIncome: number, full: boolean, mayBeTeammate = false) {
  const name = namer(map);
  const bonusName = new Map(map.bonuses.map((b) => [b.id, b.name]));
  return rows.slice(0, full ? rows.length : HEADROOM_COMPACT).map((r) => ({
    territory: name(r.territory),
    armies: r.armies,
    deploy: r.deploy,
    opponent: r.opponent,
    from: name(r.from),
    ...(r.firstMover ? { needsFirstMove: r.firstMover === 'me' ? ('you' as const) : ('opponent' as const) } : {}),
    belowMyIncome: r.deploy !== null && r.deploy < myIncome,
    bonuses: r.bonuses.map((b) => ({ id: b.id, name: bonusName.get(b.id) ?? String(b.id), value: b.value })),
    behind: r.behind.map(name),
    behindIncome: r.behindIncome,
    breach: { territories: r.breach.territories.map(name), income: r.breach.income },
    ...(mayBeTeammate ? { mayBeTeammate: true as const } : {}),
  }));
}

/**
 * #275 (c): a warning for each border of a held bonus that falls to a single deploy below my own income,
 * by id. A warning, never a refusal. `mayBeTeammate`: the teams are unknown, and the warning says so.
 */
export function headroomWarnings(rows: readonly HeadroomRow[], myIncome: number, mayBeTeammate = false): string[] {
  return rows
    .filter((r) => r.bonuses.length > 0 && r.deploy !== null && r.deploy < myIncome)
    .map(
      (r) =>
        `Territory ${r.territory} guards bonus${r.bonuses.length === 1 ? '' : 'es'} ${r.bonuses.map((b) => `${b.id} (+${b.value})`).join(', ')} ` +
        `and these orders leave it falling to a deploy of ${r.deploy} by player ${r.opponent}` +
        `${mayBeTeammate ? " (may be a teammate: this game's teams could not be read)" : ''} on territory ${r.from}` +
        `${r.firstMover ? ` (when ${r.firstMover === 'me' ? 'you move' : 'it moves'} first)` : ''}: below your own income of ${myIncome} (#275 headroom). ` +
        'An estimate is a floor; consider more armies there.',
    );
}

/** The opponents' teams for the tripwire and the headroom table, from the players' team fields. */
export function teamsOf(players: readonly { id: number; team?: number | null }[]): Map<number, number> | undefined {
  const m = new Map<number, number>();
  for (const p of players) if (carriesTeam(p.team)) m.set(p.id, p.team);
  return m.size ? m : undefined;
}
