// Surviving a wrong estimate (#275, pattern 1), as the tools show it: the broken-estimate tripwire
// (src/analysis/tripwire.ts) read over my board history and the survival side store (src/trend.ts), and
// the headroom table (src/analysis/headroom.ts) in a view. warapp_plan_turn writes the store;
// warapp_check_plan and warapp_submit_turn only read.
import { headroomTable, type HeadroomInput, type HeadroomRow } from '../analysis/headroom.js';
import type { EnemyDeployEstimate } from '../analysis/plan/shared.js';
import type { TurnBoard } from '../analysis/opponents.js';
import { activeTripwires, brokenEstimates, type Tripwire } from '../analysis/tripwire.js';
import type { MapGraph } from '../analysis/graph.js';
import type { SimSettings } from '../analysis/turn-sim.js';
import type { GameMap } from '../normalize.js';
import { readSurvival, writeSurvival, type Survival } from '../trend.js';
import { carriesTeam } from '../teams.js';
import { namer } from './common.js';

/** Headroom rows the compact view lists (the weakest first); the full view lists them all. */
export const HEADROOM_COMPACT = 10;

export interface TripwireRead {
  /** The opponents untrusted this turn, by player id. */
  tripwires: Tripwire[];
  /** This turn's estimate per opponent (what warapp_plan_turn keeps for the next turns' tripwire). */
  estimatesNow: Map<number, number>;
  survival: Survival;
}

/**
 * The tripwires running on `turn`: the marks kept, and one from each observation on my latest two
 * boards that this turn's estimates (or the ones kept for the turns it reads) cannot explain. Never throws.
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
}): Promise<TripwireRead> {
  const estimatesNow = new Map(a.estimates.map((e) => [e.playerId, e.estimate]));
  const survival = a.dataDir ? await readSurvival(a.dataDir, a.gameId, a.me) : { estimates: new Map(), tripwires: [] };
  if (a.turn === null) return { tripwires: [], estimatesNow, survival };
  let fresh: ReturnType<typeof brokenEstimates> = [];
  try {
    fresh = brokenEstimates({
      graph: a.graph,
      boards: a.boards,
      me: a.me,
      settings: a.settings,
      ...(a.teams ? { teams: a.teams } : {}),
      // The estimate the plan of that turn used when kept, else this turn's.
      estimateAt: (p, t) => survival.estimates.get(t)?.get(p) ?? estimatesNow.get(p) ?? 0,
    });
  } catch {
    // A board this reader cannot follow: no observation.
  }
  return { tripwires: activeTripwires(survival.tripwires, fresh, a.turn), estimatesNow, survival };
}

/** Keep this turn's estimates and the running marks (warapp_plan_turn only). Never throws. */
export async function keepTripwires(dataDir: string | undefined, gameId: number, me: number, turn: number | null, read: TripwireRead): Promise<void> {
  if (!dataDir || turn === null) return;
  await writeSurvival(dataDir, gameId, me, turn, { estimates: read.estimatesNow, tripwires: read.tripwires });
}

/** What an untrusted opponent is sized for: the larger of what tripped it and my own income. */
export const untrustedDeploy = (w: Tripwire, myIncome: number): number => Math.max(w.implied, Math.max(0, Math.floor(myIncome)));

const KIND_TEXT: Record<Tripwire['kind'], string> = {
  'fog-stack': 'a stack out of the fog',
  capture: 'a capture',
  'held-attack': 'an attack of yours it held',
};

/** One warning per untrusted opponent, by id (the first warning of the answer). */
export function tripwireWarnings(tripwires: readonly Tripwire[], myIncome: number, estimateOf: (player: number) => number | undefined): string[] {
  return tripwires.map((w) => {
    const est = estimateOf(w.player);
    return (
      `Player ${w.player}'s deploy estimate${est !== undefined ? ` (${est})` : ''} is untrusted until turn ${w.until} (#275): on turn ${w.since} ` +
      `${KIND_TEXT[w.kind]} on territory ${w.territory} needed ${w.observed} armies where the estimate allowed ${w.allowed}, ` +
      `about ${w.implied} a turn. Borders of your held bonuses facing it are sized for ${untrustedDeploy(w, myIncome)} ` +
      '(the larger of that and your own income), and warapp_check_plan tries that deploy by default.'
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

/** The headroom table as the tools show it: names beside ids, each row with whether it is below my income. */
export function headroomView(rows: readonly HeadroomRow[], map: GameMap, myIncome: number, full: boolean) {
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
  }));
}

/**
 * #275 (c): a warning for each border of a held bonus that falls to a single deploy below my own income,
 * by id. A warning, never a refusal.
 */
export function headroomWarnings(rows: readonly HeadroomRow[], myIncome: number): string[] {
  return rows
    .filter((r) => r.bonuses.length > 0 && r.deploy !== null && r.deploy < myIncome)
    .map(
      (r) =>
        `Territory ${r.territory} guards bonus${r.bonuses.length === 1 ? '' : 'es'} ${r.bonuses.map((b) => `${b.id} (+${b.value})`).join(', ')} ` +
        `and these orders leave it falling to a deploy of ${r.deploy} by player ${r.opponent} on territory ${r.from}` +
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
