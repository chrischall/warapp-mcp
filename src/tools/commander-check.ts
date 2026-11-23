// #274: the one commander check. warapp_submit_turn refuses on it, warapp_plan_turn's commander
// block and warning read it, and warapp_check_plan's `commander` reports it, so the three never
// disagree: the same opponents (`stressOpponents`, static seats out, #270), each reply sized at the
// larger of its estimate and my income (and enemy_deploy, a what-if floor; an untrusted opponent's at
// least at the figure its #275 tripwire gave it, as the stress test sizes it), both move orders, the
// free-for-all lead (#180), Order Priority and my Airlifts. No I/O: the callers load the boards.
import { z } from 'zod';
import type { BoardState } from '../board.js';
import { DEFAULT_DEFENSIVE_KILL_RATE, DEFAULT_OFFENSIVE_KILL_RATE } from '../analysis/combat.js';
import { defaultFoggedAttackers, foggedCommanderCheck, type FoggedCommanderCheck } from '../analysis/commander-fog.js';
import type { Game } from '../normalize.js';
import { isTeamGame } from '../teams.js';

/** The most fogged attackers a caller may ask for. */
const MAX_FOGGED_ATTACKERS = 8;
import { gameBaseIncome } from '../analysis/player.js';
import { commanderSafety, myCommanderTerritory, type CommanderAirlift, type CommanderSafety } from '../analysis/commander-safety.js';
import type { MapGraph } from '../analysis/graph.js';
import type { PlannerSettings } from '../analysis/index.js';
import { simulateTurn, type SimOrder } from '../analysis/turn-sim.js';
import type { CardPlayKind } from '../protocol/methods.js';
import type { stressOpponents } from './stress-opponents.js';

/**
 * Card plays that turn my territory over, which the commander check does not simulate (an Airlift it
 * does): played on a territory my commander stands on before or after my orders, they may lose it,
 * so the submit refuses them there unless accepted. A Bomb only hits a territory not mine.
 */
const UNSIMULATED_NEAR_COMMANDER: ReadonlySet<CardPlayKind> = new Set(['Blockade', 'EmergencyBlockade', 'Gift']);

export interface CommanderRisk {
  territory: number;
  armies: number;
  needs: number | null;
  /** The deploy each reply was sized at for this opponent, the larger of its estimate and my income. */
  replyDeploy: number;
  replies: number;
}

export interface CommanderCheckInput {
  graph: MapGraph;
  me: number;
  settings: PlannerSettings;
  /** `stressOpponents`' answer: its board (static seats neutral), opponents, estimates, teams and lead. */
  so: ReturnType<typeof stressOpponents>;
  income: number;
  deploys: { territoryId: number; armies: number }[];
  moves: SimOrder[];
  orderPriority: boolean;
  /** An enemy_deploy what-if: a floor on every reply, never below what the submit tries. */
  floor?: number;
  /**
   * #275: per untrusted opponent, the deploy its tripwire sizes it at (`untrustedDeploy`): a floor on its
   * replies, as warapp_check_plan's stress test tries it, so the one check never calls the commander
   * safe at a figure below the one the stress test lists.
   */
  untrusted?: ReadonlyMap<number, number>;
  /** Search for the smallest deploy that kills it (warapp_plan_turn's block); the others skip it. */
  killedBy?: boolean;
  /** My Airlifts, which run after the deploys and before the moves. */
  airlifts?: readonly CommanderAirlift[];
  /** The territories the other card plays sent with the orders target; those in {@link UNSIMULATED_NEAR_COMMANDER} are not simulated. */
  cardTargets?: readonly { kind: CardPlayKind; territory: number }[];
}

export interface CommanderCheck {
  safety: CommanderSafety;
  replyDeploy: number;
  risk?: CommanderRisk;
  text?: string;
  cards?: string[];
}

/** How every reply is sized, in words (the check_plan block and the plan's warning say it). */
export const COMMANDER_SIZING =
  "each reply sized at the larger of the opponent's estimate and your income (an untrusted opponent's at least at the figure its tripwire gave it, #275), both move orders tried";

/**
 * Whether these orders leave my commander takeable by a single-deploy reply. Undefined when my
 * commander is not on the board; `risk` and `text` only when a reply tried kills it, or when a card
 * play it does not simulate (a Blockade or a Gift) lands on a territory the commander stands on before
 * or after my orders (`cards` names them).
 */
export function commanderCheckOn(a: CommanderCheckInput): CommanderCheck | undefined {
  const { so } = a;
  // The opponent's own estimate, never an enemy_deploy override (that is `floor`).
  const sizeOf = (id: number) => Math.max(so.estimateOf(id), a.income, a.floor ?? 0, a.untrusted?.get(id) ?? 0);
  const sized = so.opponents.map((o) => ({ ...o, deploy: sizeOf(o.id) }));
  const safety = commanderSafety({
    graph: a.graph,
    board: so.board,
    me: a.me,
    deploys: a.deploys,
    moves: a.moves,
    opponents: sized,
    settings: a.settings,
    ...(so.teams.size ? { teams: so.teams } : {}),
    orderPriority: a.orderPriority,
    ...(a.settings.localDeployments ? { localDeployments: true, baseIncome: gameBaseIncome(a.settings) } : {}),
    ...(a.settings.localDeployments && (a.settings.bonusArmyPer ?? 0) > 0 ? { perTerritoryIncome: true } : {}),
    leader: so.leader,
    killedBy: a.killedBy ?? false,
    ...(a.airlifts?.length ? { airlifts: a.airlifts } : {}),
  });
  if (!safety) return undefined;
  const w = safety.worst;
  const opponent = w ? so.opponents.find((o) => o.id === w.opponent) : undefined;
  const replyDeploy = opponent ? sizeOf(opponent.id) : Math.max(a.income, a.floor ?? 0, ...so.opponents.map((o) => sizeOf(o.id)));
  const its = new Set([safety.from, safety.territory]);
  const cards = [
    ...new Set(
      (a.cardTargets ?? [])
        .filter((c) => UNSIMULATED_NEAR_COMMANDER.has(c.kind) && its.has(c.territory))
        .map((c) => `${c.kind === 'EmergencyBlockade' ? 'an Emergency Blockade' : c.kind === 'Gift' ? 'a Gift' : 'a Blockade'} of territory ${c.territory}`),
    ),
  ];
  const cardText = cards.length
    ? `These orders play ${cards.join(' and ')}, where your commander stands${
        safety.from === safety.territory ? '' : ' before or after your orders'
      }: that card play is not simulated by the commander check, and a territory blockaded or gifted is lost with the commander on it.`
    : '';
  if (safety.killers === 0 && !safety.lostUnanswered) {
    if (!cards.length) return { safety, replyDeploy };
    return {
      safety,
      replyDeploy,
      risk: { territory: safety.territory, armies: safety.armies, needs: null, replyDeploy, replies: 0 },
      text: cardText,
      cards,
    };
  }
  const where = `your commander on territory ${safety.territory}`;
  const untrustedOf = opponent ? a.untrusted?.get(opponent.id) : undefined;
  const partner = w?.partner !== undefined ? so.opponents.find((o) => o.id === w.partner) : undefined;
  const reply =
    w && opponent
      ? partner
        ? `player ${w.opponent} (deploying ${replyDeploy} on territory ${w.deployTo}) and player ${partner.id} (deploying ${sizeOf(partner.id)}${
            w.partnerDeployTo !== undefined ? ` on territory ${w.partnerDeployTo}` : ''
          }) striking it together kill it, as two opponents may gang up on the leader of a free-for-all`
        : `a single deploy of ${replyDeploy} by player ${w.opponent} on territory ${w.deployTo}${w.to !== undefined ? `, attacking territory ${w.to}` : ''}, kills it`
      : 'a single deploy kills it';
  const text = safety.lostUnanswered
    ? `These orders lose ${where} with nobody answering (an attack it goes along on fails).`
    : `These orders leave ${where} takeable: ${reply} (${safety.killers} of the replies tried, each sized at the larger of the opponent's estimate${
        opponent ? ` ${so.estimateOf(opponent.id)}` : ''
      }${untrustedOf !== undefined ? `, its untrusted figure ${untrustedOf} (#275)` : ''} and your income ${a.income}${a.floor !== undefined ? ` and enemy_deploy ${a.floor}` : ''}). ${
        safety.needs !== null
          ? `It needs ${safety.needs} armies there (${safety.armies} after your orders) to survive every one.`
          : 'No number of armies there holds it against every one.'
      }${a.airlifts?.length ? ' Your Airlifts are counted (they run after the deploys and before the moves).' : ''}${cardText ? ` ${cardText}` : ''}`;
  return {
    safety,
    replyDeploy,
    risk: { territory: safety.territory, armies: safety.armies, needs: safety.needs, replyDeploy, replies: safety.killers },
    text,
    ...(cards.length ? { cards } : {}),
  };
}

/**
 * #274: whether the border guess's draw may stand beside the plan's own orders: not when it leaves my
 * commander takeable where the plan's orders do not, nor by more replies (warapp_submit_turn would
 * refuse the guess's orders). Undefined checks (no commander on the board) keep it.
 */
export function guessKeepsCommander(plan: CommanderCheck | undefined, guess: CommanderCheck | undefined): boolean {
  if (!plan || !guess) return true;
  const fails = (c: CommanderCheck) => c.safety.lostUnanswered || c.safety.killers > 0;
  if (!fails(guess)) return true;
  if (!fails(plan)) return false;
  return guess.safety.killers <= plan.safety.killers && (!guess.safety.lostUnanswered || plan.safety.lostUnanswered);
}

/**
 * Part 5 (mega game): my commander after these orders (nobody answering) against `count` unknown
 * opponents in the fog striking it together (`src/analysis/commander-fog.ts`): every fogged territory
 * within two moves of where it ends may hide one, `stack` armies plus a whole deploy of `deploy` (my
 * income). A report beside the commander check, never a refusal. Undefined when `count` is 0, my
 * commander is not on the board, or no fogged territory is in reach.
 */
export function foggedCommanderOn(a: {
  graph: MapGraph;
  board: BoardState;
  me: number;
  settings: PlannerSettings;
  deploys: readonly { territoryId: number; armies: number }[];
  moves: readonly SimOrder[];
  count: number;
  stack: number;
  /** #529: per fogged territory, the armies a hidden player there may hold (default `stack` everywhere). */
  stackAt?: (t: number) => number;
  deploy: number;
}): FoggedReport | undefined {
  if (a.count <= 0 || myCommanderTerritory(a.board, a.me) === undefined) return undefined;
  const after = simulateTurn({
    graph: a.graph,
    board: a.board,
    deploys: a.deploys.map((d) => ({ player: a.me, territoryId: d.territoryId, armies: d.armies })),
    orders: [{ player: a.me, orders: a.moves.map((m) => ({ ...m })) }],
    moveOrder: [a.me],
    settings: a.settings,
  }).territories;
  const at = [...after].find(([, t]) => t.commander === a.me)?.[0];
  if (at === undefined) return undefined;
  const start = new Map(a.board.territories.map((t) => [t.territoryId, t]));
  const view = {
    mine: (t: number) => after.get(t)?.owner === a.me,
    fogged: (t: number) => {
      const st = start.get(t);
      return !st || st.owner.kind === 'unknown' || (st.armies === null && !(st.owner.kind === 'player' && st.owner.playerId === a.me));
    },
    armies: (t: number) => {
      const st = start.get(t);
      return st && st.owner.kind !== 'unknown' && st.armies !== null ? (after.get(t)?.armies ?? st.armies) : null;
    },
  };
  const c = foggedCommanderCheck(a.graph, view, at, after.get(at)!.armies, {
    count: a.count,
    stack: a.stackAt ?? a.stack,
    deploy: a.deploy,
    offensiveKillRate: a.settings.offensiveKillRate ?? DEFAULT_OFFENSIVE_KILL_RATE,
    defensiveKillRate: a.settings.defensiveKillRate ?? DEFAULT_DEFENSIVE_KILL_RATE,
  });
  return c ? { ...c, stack: a.stack, deploy: a.deploy, ...(a.stackAt ? { likelyOnly: true as const } : {}) } : undefined;
}

/** {@link foggedCommanderOn}'s answer: the check, the stack and deploy it assumed, and `likelyOnly` when the stack was per territory (#529). */
export type FoggedReport = FoggedCommanderCheck & { stack: number; deploy: number; likelyOnly?: true };

/** The fogged check in one sentence (check_plan's summary and the plan's warning). */
export function foggedCommanderText(c: FoggedReport): string {
  const n = c.attackers;
  const each = c.likelyOnly
    ? `each a deploy of ${c.deploy} plus ${c.stack} armies where a start could be or a player was last seen, else the territory's usual estimate`
    : `each ${c.stack} armies plus a deploy of ${c.deploy}`;
  return c.safe
    ? `Your commander on territory ${c.territory} holds against ${n} unknown opponent${n === 1 ? '' : 's'} the fog may hide within two moves (${each}) striking together.`
    : `Your commander on territory ${c.territory} (${c.armies} armies after your orders) could fall to ${n} unknown opponent${n === 1 ? '' : 's'} the fog may hide within two moves (territories ${c.from.map((f) => f.territory).join(', ')}; ${each}) striking together: it needs ${c.needs} there.`;
}

/** The `fogged_attackers` argument of warapp_plan_turn and warapp_check_plan (each tool describes its default). */
export const foggedAttackersArg = z.coerce.number().int().min(0).max(MAX_FOGGED_ATTACKERS).optional();

/**
 * The default `fogged_attackers` of warapp_plan_turn and warapp_check_plan, one rule for both (#531):
 * {@link defaultFoggedAttackers} on the game — 2 in a Commanders free-for-all of eight or more players
 * still playing under fog, else 0 (off).
 */
export function defaultFoggedCount(game: Pick<Game, 'settings' | 'players'>): number {
  const s = game.settings;
  return defaultFoggedAttackers({
    commanders: !!s?.commanders,
    fog: s?.fog !== undefined && s.fog !== 'NoFog',
    teams: isTeamGame(game.players),
    players: game.players.filter((p) => (p.state ?? 'Playing') === 'Playing').length,
  });
}

/** The most armies on one territory of mine on `board` (0 with none). */
export function myLargestStack(board: BoardState, me: number): number {
  return board.territories.reduce((n, t) => (t.owner.kind === 'player' && t.owner.playerId === me ? Math.max(n, t.armies ?? 0) : n), 0);
}
