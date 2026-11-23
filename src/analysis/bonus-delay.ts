// #505: on turns 1–4, or while #319's opening warning fires, orders that drop a capture the default plan
// makes toward the nearest bonus (rule 4f's, `planCloseness`) are told what it costs: when that bonus now
// finishes against when the default plan finishes it ("these orders finish bonus X on turn 4 instead of
// turn 3"). Advice only: never a refusal.
//
// Each finish turn is rule 4f's turns-to-finish read on the board after the turn: each set of orders
// (the default plan's, the given ones) is resolved with the turn simulator, mine alone (the rest of the
// board stands still, luck at its expectation), the next turn planned on the result at the income it
// leaves, and its `turnsOf` for the bonus read (`planCloseness`). A bonus complete after the turn finishes
// this turn. No I/O, ids ascending.
import type { BoardState } from '../board.js';
import { planCloseness, planTurn, type PlanInput, type TurnPlan } from './planner.js';
import { boardIncome } from './player.js';
import { simulateTurn, type SimSettings, type SimTerritory } from './turn-sim.js';

/** The last turn the check runs on without #319 firing. */
export const BONUS_DELAY_LAST_TURN = 4;

/** What a set of orders sent: the deploys and the attack and transfer orders. */
export interface GivenOrders {
  deploys: readonly { territoryId: number; armies: number }[];
  moves: readonly { from: number; to: number; armies: number }[];
}

export interface BonusDelay {
  bonusId: number;
  /** The bonus's name on the map. */
  bonus: string;
  /** The nearest bonus's missing members the default plan attacks and the given orders do not. */
  dropped: number[];
  /** The turn the default plan's orders finish the bonus on. */
  plannedTurn: number;
  /** The turn the given orders finish it on. */
  givenTurn: number;
  /** Whether #319 fired (else the turn is in 1–4). */
  spread: boolean;
}

const simSettingsOf = (s: NonNullable<PlanInput['settings']>): SimSettings => ({
  ...(s.offensiveKillRate !== undefined ? { offensiveKillRate: s.offensiveKillRate } : {}),
  ...(s.defensiveKillRate !== undefined ? { defensiveKillRate: s.defensiveKillRate } : {}),
  ...(s.luckModifier !== undefined ? { luckModifier: s.luckModifier } : {}),
  ...(s.roundingMode !== undefined ? { roundingMode: s.roundingMode } : {}),
  ...(s.oneArmyStandsGuard !== undefined ? { oneArmyStandsGuard: s.oneArmyStandsGuard } : {}),
  ...(s.multiAttack !== undefined ? { multiAttack: s.multiAttack } : {}),
});

const ownerOf = (owner: SimTerritory['owner']): BoardState['territories'][number]['owner'] =>
  typeof owner === 'number' ? { kind: 'player', playerId: owner } : owner === 'neutral' ? { kind: 'neutral' } : { kind: 'unknown' };

const landOf = (b: BoardState, me: number) =>
  new Set(b.territories.flatMap((t) => (t.owner.kind === 'player' && t.owner.playerId === me ? [t.territoryId] : [])));

/**
 * The turn `orders` finish `bonusId` on: this turn when it is held in full after them, else this turn
 * plus rule 4f's turns to finish on the board they leave (planned at the income they leave); `undefined`
 * when the next plan has no figure for it.
 */
function finishTurn(input: PlanInput, turn: number, bonusId: number, orders: GivenOrders, plan: (i: PlanInput) => TurnPlan): number | undefined {
  const r = simulateTurn({
    graph: input.graph,
    board: input.board,
    deploys: orders.deploys.map((d) => ({ player: input.me, territoryId: d.territoryId, armies: d.armies })),
    orders: [{ player: input.me, orders: orders.moves.map((m) => ({ from: m.from, to: m.to, armies: m.armies })) }],
    moveOrder: [input.me],
    settings: simSettingsOf(input.settings ?? {}),
  });
  const after: BoardState = {
    source: input.board.source,
    verified: false,
    territories: input.board.territories.map((t) => {
      const s = r.territories.get(t.territoryId);
      return s ? { ...t, owner: ownerOf(s.owner), armies: s.owner === 'unknown' ? t.armies : s.armies } : t;
    }),
  };
  const members = input.graph.map.bonuses.find((b) => b.id === bonusId)?.territoryIds ?? [];
  const held = landOf(after, input.me);
  if (members.length && members.every((t) => held.has(t))) return turn;
  const rules = { base: input.settings?.baseIncome ?? 0, per: 0 };
  const gain = boardIncome(input.graph, held, rules).total - boardIncome(input.graph, landOf(input.board, input.me), rules).total;
  const next = plan({
    ...input,
    board: after,
    previousBoard: input.board,
    income: Math.max(0, input.income + gain),
    turn: turn + 1,
    ...(input.game ? { game: { ...input.game, turn: turn + 1 } } : {}),
  });
  const turns = planCloseness(next)?.turns.get(bonusId);
  return turns === undefined ? undefined : turn + Math.max(1, turns);
}

/**
 * #505: whether `given` drops a capture `plan` (the default plan on `input`) makes toward rule 4f's
 * nearest bonus, on turns 1–{@link BONUS_DELAY_LAST_TURN} or while #319 fires, and finishes that bonus
 * later for it; `undefined` otherwise (no such capture dropped, no later finish, or no figure). Pure.
 */
export function bonusDelay(a: { input: PlanInput; plan: TurnPlan; given: GivenOrders; planner?: (i: PlanInput) => TurnPlan }): BonusDelay | undefined {
  const { input, plan, given } = a;
  const turn = input.turn ?? input.game?.turn;
  const c = planCloseness(plan);
  if (turn === undefined || turn === null || !c || c.nearest === undefined) return undefined;
  if (!(turn >= 1 && turn <= BONUS_DELAY_LAST_TURN) && !c.spread) return undefined;
  const missing = new Set(c.remaining.get(c.nearest) ?? []);
  const sent = new Set(given.moves.filter((m) => !landOf(input.board, input.me).has(m.to)).map((m) => m.to));
  const toward = new Set(plan.expected.captures.filter((t) => missing.has(t)));
  const dropped = [...new Set(plan.moves.filter((m) => toward.has(m.to) && !sent.has(m.to)).map((m) => m.to))].sort((x, y) => x - y);
  if (!dropped.length) return undefined;
  const planner = a.planner ?? planTurn;
  const planned = finishTurn(input, turn, c.nearest, { deploys: plan.deploys, moves: plan.moves }, planner);
  const givenTurn = finishTurn(input, turn, c.nearest, given, planner);
  if (planned === undefined || givenTurn === undefined || givenTurn <= planned) return undefined;
  const bonus = input.graph.map.bonuses.find((b) => b.id === c.nearest)?.name ?? `#${c.nearest}`;
  return { bonusId: c.nearest, bonus, dropped, plannedTurn: planned, givenTurn, spread: c.spread };
}

/** #505: the warning for a {@link BonusDelay}; none without one. Advice only, no names but the bonus's. */
export function bonusDelayWarning(d: BonusDelay | undefined): string | undefined {
  if (!d) return undefined;
  const ts = d.dropped.map((t) => `territory ${t}`).join(', ');
  return (
    `These orders finish bonus ${d.bonus} on turn ${d.givenTurn} instead of turn ${d.plannedTurn} (#505): they drop the default plan's ` +
    `capture${d.dropped.length === 1 ? '' : 's'} of ${ts} toward it, the nearest bonus to complete (rule 4f` +
    `${d.spread ? "; #319's opening warning fires" : ''}). Each turn is rule 4f's turns to finish on the board each set of orders ` +
    'leaves, the rest of the board standing still. Advice only: the orders are sent as given.'
  );
}
