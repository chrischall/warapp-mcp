// Is my commander takeable after my orders? (#274) Losing the commander ends the game, so this
// asks the stress test (stress.ts) one question only: of the single-deploy replies it tries, which
// take the territory my commander stands on once my orders have run, and how many armies would
// that territory need to survive every one of them. Pure and deterministic.
//
//   territory  where my commander stands after my orders run unanswered (my orders may take it along);
//   armies     the armies of mine there then (the commander not counted);
//   distance   moves from it to the nearest territory of an opponent or in the fog (null: none on the map);
//   killers    replies tried that kill it, each at the deploys given (the caller sizes them);
//   needs      the armies it needs there to survive every reply tried (luck-free under luck, as the
//              stress test resolves battles): found by adding armies on the commander's starting
//              territory (carried along when my orders move the commander from there) until no reply
//              kills it. `armies` when none does; null past {@link SEARCH_CAP};
//   killedBy   the smallest deploy, the same for every opponent, at which some single reply kills it
//              (null when none up to {@link SEARCH_CAP} does: no stack of theirs is in reach this turn;
//              also null with `killedBy: false`, which skips that search: warapp_submit_turn never reads it).
//
// Only the replies that strike the commander's territory are tried (`targets`), and never the
// look-ahead, so it is cheap enough to run inside warapp_submit_turn. What the stress test does not
// try (fog, a split deploy, cards, …) this does not either.

import type { BoardState } from '../board.js';
import { bfsDistances } from './graph.js';
import { stressPlan, type StressInput, type StressReply } from './stress.js';
import { simulateTurn } from './turn-sim.js';

/** Armies, or a deploy, past which the searches stop. */
export const SEARCH_CAP = 1_000_000;

export type CommanderSafetyInput = Omit<StressInput, 'targets' | 'lookAhead' | 'maxReplies'> & {
  /** Search for the smallest deploy that kills it (default true); false skips some 20–40 stress runs. */
  killedBy?: boolean;
};

export interface CommanderSafety {
  /** Where it stands after my orders, and where it stood before them. */
  territory: number;
  from: number;
  armies: number;
  distance: number | null;
  killers: number;
  /** The first reply tried that kills it (worst first, as the stress test ranks them). */
  worst?: StressReply;
  needs: number | null;
  killedBy: { deploy: number; opponent: number } | null;
  /** My orders lose it with nobody answering (an attack it goes along on fails). */
  lostUnanswered: boolean;
  /** `false` under luck or weighted rounding: battles resolved at their expectation. */
  exact: boolean;
}

/** The territory my commander stands on, if it is on the board. */
export function myCommanderTerritory(board: BoardState, me: number): number | undefined {
  return board.territories.find((t) => t.owner.kind === 'player' && t.owner.playerId === me && t.specialUnits?.some((u) => u.kind === 'commander' && u.playerId === me))
    ?.territoryId;
}

/** The smallest n in [lo, SEARCH_CAP] with `ok(n)`, for `ok` false then true; null when `ok(SEARCH_CAP)` is false. */
function smallest(lo: number, ok: (n: number) => boolean): number | null {
  if (ok(lo)) return lo;
  let bad = lo;
  let hi = Math.max(1, lo * 2);
  while (!ok(hi)) {
    bad = hi;
    if (hi >= SEARCH_CAP) return null;
    hi = Math.min(SEARCH_CAP, hi * 2);
  }
  while (hi - bad > 1) {
    const mid = Math.floor((bad + hi) / 2);
    if (ok(mid)) hi = mid;
    else bad = mid;
  }
  return hi;
}

export function commanderSafety(options: CommanderSafetyInput): CommanderSafety | undefined {
  const { killedBy: searchKilledBy = true, ...input } = options;
  const { graph, board, me } = input;
  const from = myCommanderTerritory(board, me);
  if (from === undefined) return undefined;

  // Where my orders leave it (they may take it along), with nobody answering.
  const after = simulateTurn({
    graph,
    board,
    deploys: input.deploys.map((d) => ({ player: me, territoryId: d.territoryId, armies: d.armies })),
    orders: [{ player: me, orders: input.moves.map((m) => ({ ...m })) }],
    moveOrder: [me],
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.teams ? { teams: input.teams } : {}),
    ...(input.orderPriority ? { orderPriority: [me] } : {}),
  }).territories;
  const ended = [...after].find(([, t]) => t.commander === me)?.[0];
  const lostUnanswered = ended === undefined;
  const territory = ended ?? from;
  const armies = lostUnanswered ? 0 : (after.get(territory)?.armies ?? 0);
  const at = [...new Set([from, territory])];
  const run = (over: Partial<StressInput>) => stressPlan({ ...input, ...over, targets: at, lookAhead: false });
  const kills = (r: ReturnType<typeof stressPlan>) => r.atRisk.commander;
  const report = run({});
  const killers = kills(report);

  // The armies that hold: more on the starting territory, carried along by the move that takes the commander.
  const carrier = territory === from ? -1 : input.moves.findIndex((m) => m.from === from && m.withCommander === true);
  const withExtra = (extra: number): Partial<StressInput> => ({
    deploys: [...input.deploys, { territoryId: from, armies: extra }],
    moves: input.moves.map((m, i) => (i === carrier ? { ...m, armies: m.armies + extra } : m)),
  });
  const extra = lostUnanswered ? null : killers === 0 ? 0 : smallest(1, (n) => kills(run(withExtra(n))) === 0);

  // The smallest deploy, the same for every opponent, that kills it.
  const killing = (d: number) => run({ opponents: input.opponents.map((o) => ({ ...o, deploy: d })) });
  const killedAt = searchKilledBy && input.opponents.length && !lostUnanswered ? smallest(0, (d) => kills(killing(d)) > 0) : null;
  const killer = killedAt === null ? undefined : killing(killedAt).replies.find((r) => r.commanderLost);

  // Moves to the nearest territory of an opponent (a teammate's is not one) or in the fog.
  const myTeam = input.teams?.get(me);
  const hostile = board.territories.filter(
    (t) =>
      t.owner.kind === 'unknown' ||
      t.armies === null ||
      (t.owner.kind === 'player' && t.owner.playerId !== me && (myTeam === undefined || input.teams?.get(t.owner.playerId) !== myTeam)),
  );
  const dist = bfsDistances(graph, [territory]);
  const reach = hostile.map((t) => dist.get(t.territoryId)).filter((d): d is number => d !== undefined);
  const worst = report.replies.find((r) => r.commanderLost);

  return {
    territory,
    from,
    armies,
    distance: reach.length ? Math.min(...reach) : null,
    killers,
    ...(worst ? { worst } : {}),
    needs: extra === null ? null : armies + extra,
    killedBy: killedAt === null || !killer ? null : { deploy: killedAt, opponent: killer.opponent },
    lostUnanswered,
    exact: report.exact,
  };
}
