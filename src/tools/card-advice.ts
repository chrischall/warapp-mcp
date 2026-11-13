// The card advice warapp_plan_turn adds to a plan (#163): the game around the hand (team, fog,
// players), the team's hand, Order Delay's place, my Bomb and Emergency Blockade, the
// opponents' Bomb and Emergency Blockade when they can hold one, and the cards in effect
// (Diplomacy, Sanctions). Read-only; everything here is advice — no card play is added to the
// orders.

import { adviseOrderDelay, readActiveCards, type Card, type CardChoice, type CardGame } from '../cards.js';
import { bombAdvice, bombExposure, wallOffer, wallThreats, type CardBoard } from '../analysis/card-threats.js';
import type { TurnPlan } from '../analysis/planner.js';
import { inGameId } from '../live.js';
import type { Game, GameSettings, Player } from '../normalize.js';
import { cardClock } from '../strategy/card-clock.js';
import { carriesTeam } from '../teams.js';

const CARD_BOMB = 13;
const CARD_EMERGENCY_BLOCKADE = 3;

/** The game around my hand, for the card policy. */
export function cardGame(game: Pick<Game, 'players' | 'settings'>): CardGame {
  return {
    players: game.players.length,
    team: game.players.some((p) => carriesTeam(p.team)),
    ...(game.settings?.fog !== undefined ? { fog: game.settings.fog } : {}),
  };
}

/** My teammates (never me), by GameFeed player. Empty outside a team game. */
export const teammatesOf = (game: Pick<Game, 'players'>, me: Player): Player[] =>
  carriesTeam(me.team) ? game.players.filter((p) => p.id !== me.id && p.team === me.team) : [];

/**
 * The in-game ids whose cards are my hand: mine, and in a team game my teammates' (a team shares
 * one hand; how war.app keys it is unverified, #163).
 */
export const handOwners = (game: Pick<Game, 'players'>, me: Player): number[] => [
  inGameId(me),
  ...teammatesOf(game, me).flatMap((p) => {
    try {
      return [inGameId(p)];
    } catch {
      return []; // not a GameFeed player id: no in-game id to read cards under
    }
  }),
];

/** In a team game: the hand and the limit are the team's (said once in the plan's warnings). */
export const TEAM_HAND =
  "This is a team game: the hand and the card limit are the team's, shared with your teammates. The hand shown " +
  "gathers every card under you and your teammates on the live board; how war.app keys a team's hand is not yet " +
  'verified, so check the hand in the game before shedding cards.';

/** A card setting's `MultiplyAmount` (Blockade, Emergency Blockade), when the game sets one. */
function multiplier(settings: GameSettings | undefined, key: string): number | undefined {
  const r = settings?.raw[key];
  if (typeof r !== 'object' || r === null) return undefined;
  const m = Number((r as Record<string, unknown>).MultiplyAmount);
  return Number.isFinite(m) && m > 0 ? m : undefined;
}

/**
 * Whether an opponent can hold `card` this turn: the card is in play and the card clock lets it
 * be in a hand by `turn` (unknown turn: yes).
 */
function opponentCanHold(settings: GameSettings | undefined, card: string, turn: number | null): boolean {
  const entry = cardClock(settings)?.cards.find((c) => c.card === card);
  if (!entry) return false;
  const first = entry.firstPlayableTurn.fastest;
  return first !== null && (turn === null || turn >= first);
}

export interface CardAdviceView {
  /**
   * `before` is 1-based among the plan's moves (its `orders` moves, in order); `order` is the card
   * order to pass to warapp_submit_turn as is (#186: that placement is UNVERIFIED live).
   */
  orderDelay?: { card: string; before: number; attacks: number[]; order: { kind: 'card'; card: string; before: number } };
  bomb?: { target: number | null; kind: string | null; why: string };
  emergencyBlockade?: { territory: number; givesUp: number; wall: number; player: number; reach: number; kills: number };
  active?: Array<{ card: string; players?: number[]; target?: number; playedBy?: number; expiresAfterTurn?: number; untilTurn?: number }>;
}

export interface CardAdviceInput {
  game: Pick<Game, 'players' | 'settings'>;
  me: Player;
  turn: number | null;
  info: unknown;
  hand: readonly Card[];
  choice: CardChoice;
  plan: Pick<TurnPlan, 'deploys' | 'moves' | 'moveSlots' | 'enemyDeploy' | 'conceded'>;
  board: CardBoard['board'];
  graph: CardBoard['graph'];
  settings: CardBoard['settings'];
  /** A territory's label for the warnings. */
  label: (id: number) => string;
}

/**
 * The card advice and warnings for a plan. Pure apart from reading the decoded board; the plan's
 * orders are never changed.
 */
export function adviseCards(input: CardAdviceInput): { view: CardAdviceView; warnings: string[] } {
  const { game, me, turn, hand, choice, plan, label } = input;
  const view: CardAdviceView = {};
  const warnings: string[] = [];
  const gone = new Set([...choice.plays, ...choice.discards].map((c) => c.id));
  const holds = (type: number) => hand.some((c) => c.type === type && !gone.has(c.id));
  const friends = new Set(teammatesOf(game, me).map((p) => p.id));
  const cb: CardBoard = {
    graph: input.graph,
    board: input.board,
    me: me.id,
    friends,
    deploys: plan.deploys,
    moves: plan.moves,
    enemyDeploy: plan.enemyDeploy,
    ...(input.settings ? { settings: input.settings } : {}),
  };
  const moveLabel = (k: number) => {
    const m = plan.moves[k - 1]!;
    return `${label(m.from)} → ${label(m.to)}`;
  };

  // Order Delay: above every order that is not urgent, when an attack the opponent can answer is planned.
  const delay = adviseOrderDelay(hand, choice, plan.moves, plan.moveSlots);
  if (delay) {
    view.orderDelay = {
      card: delay.card.id,
      before: delay.before,
      attacks: delay.attacks,
      order: { kind: 'card', card: delay.card.id, before: delay.before },
    };
    warnings.push(
      `Play Order Delay above move ${delay.before}${delay.before <= plan.moves.length ? ` (${moveLabel(delay.before)})` : ''}: ` +
        `${delay.attacks.map(moveLabel).join(', ')} ${delay.attacks.length === 1 ? 'is an attack' : 'are attacks'} the opponent can answer first, ` +
        'and the orders after the card wait until the opponent has moved. Add `cards.advice.orderDelay.order` (the card with ' +
        '`before`) to the orders for warapp_submit_turn — placing the card among the moves is UNVERIFIED live until one ' +
        'commit uses it — or play it in the game client. Without `before`, warapp_submit_turn writes the card after every ' +
        'move (its verified position), where it delays nothing.',
    );
  }

  const cards = game.settings?.cards ?? [];
  // My Bomb: a target where halving the stack changes the turn, else hold it.
  if (holds(CARD_BOMB)) {
    const a = bombAdvice(cb);
    view.bomb = { target: a.target ?? null, kind: a.kind ?? null, why: a.why };
    warnings.push(`${a.target !== undefined ? a.why.replace(/^Bomb (\d+):/, (_, t) => `Bomb ${label(Number(t))}:`) : a.why} Bomb is played in the game client (warapp_submit_turn does not play it).`);
  }
  // An opponent's Bomb: the borders that hold only while unbombed.
  if (cards.includes('Bomb') && opponentCanHold(game.settings, 'Bomb', turn)) {
    const exposed = bombExposure(cb);
    if (exposed.length) {
      warnings.push(
        `If an opponent plays a Bomb, ${exposed
          .map((e) => `${label(e.territory)}${e.commander ? ' (your commander)' : ''} (${e.armies} → ${e.bombed}) falls to player ${e.player}'s ~${e.reach}`)
          .join('; ')}: a bomb halves a stack after the deploys and before any move. Spread the stack over two territories, ` +
          'or deploy one step back and move up (the bomb lands before the move).',
      );
    }
  }
  const ebMultiplier = multiplier(game.settings, 'EmergencyBlockadeCard');
  if (cards.includes('EmergencyBlockade') || cards.includes('Emergency Blockade')) {
    // An opponent's Emergency Blockade: planned attacks that would die against the wall.
    if (ebMultiplier !== undefined && opponentCanHold(game.settings, 'Emergency Blockade', turn)) {
      for (const w of wallThreats(cb, ebMultiplier)) {
        warnings.push(
          `The attack on ${label(w.target)} (${w.attackers} armies) would die against an Emergency Blockade: player ${w.player} can turn it ` +
            `into a neutral of (its armies + its deploy) × ${ebMultiplier} ≈ ${w.wall} before the attacks.`,
        );
      }
    }
    // My Emergency Blockade: a conceded border where the wall kills more than I give up.
    if (holds(CARD_EMERGENCY_BLOCKADE)) {
      const offer = ebMultiplier !== undefined ? wallOffer(cb, ebMultiplier, plan.conceded) : undefined;
      if (offer) {
        view.emergencyBlockade = offer;
        warnings.push(
          `Consider an Emergency Blockade on ${label(offer.territory)}: the plan concedes it, and its ${offer.givesUp} armies × ${ebMultiplier} make a ` +
            `wall of ${offer.wall} that player ${offer.player}'s ~${offer.reach} would lose ~${offer.kills} attacking — if it attacks; if not, ` +
            'the territory and its armies are given away. Play it in the game client (warapp_submit_turn does not play it).',
        );
      } else if (ebMultiplier === undefined) {
        warnings.push('You hold an Emergency Blockade, but the game does not say its multiplier, so no wall is sized for it.');
      }
    }
  }

  // The cards in effect (unverified decoding): Diplomacy protecting a player, Sanctions on me.
  const active = readActiveCards(input.info);
  if (active.length) {
    const byInGame = new Map(game.players.flatMap((p) => {
      try {
        return [[inGameId(p), p] as const];
      } catch {
        return [];
      }
    }));
    const feed = (id: number | undefined) => (id === undefined ? undefined : byInGame.get(id)?.id);
    view.active = active.map((a) => ({
      card: a.card,
      ...(a.players ? { players: a.players.map((p) => feed(p) ?? p) } : {}),
      ...(a.target !== undefined ? { target: feed(a.target) ?? a.target } : {}),
      ...(a.playedBy !== undefined ? { playedBy: feed(a.playedBy) ?? a.playedBy } : {}),
      ...(a.expiresAfterTurn !== undefined ? { expiresAfterTurn: a.expiresAfterTurn } : {}),
      ...(a.untilTurn !== undefined ? { untilTurn: a.untilTurn } : {}),
    }));
    const owner = (t: number) => {
      const o = input.board.territories.find((x) => x.territoryId === t)?.owner;
      return o?.kind === 'player' ? o.playerId : undefined;
    };
    for (const a of view.active) {
      const until = a.untilTurn !== undefined ? ` (until turn ${a.untilTurn})` : '';
      if (a.card === 'Diplomacy' && a.players?.includes(me.id)) {
        const other = a.players.find((p) => p !== me.id);
        const hit = plan.moves.filter((m) => m.kind === 'attack' && other !== undefined && owner(m.to) === other);
        warnings.push(
          `Diplomacy is in effect between you and player ${other}${until}: neither can attack the other.` +
            (hit.length ? ` The plan's attacks on ${hit.map((m) => label(m.to)).join(', ')} would do nothing — drop or redirect them.` : ''),
        );
      }
      if (a.card === 'Sanctions' && a.target === me.id) {
        const pct = (game.settings?.raw.SanctionsCard as Record<string, unknown> | undefined)?.Percentage;
        const cut = typeof pct === 'number' ? ` by ${Math.round(pct * 100)}%` : '';
        warnings.push(
          `Sanctions are on you${until}: your income is cut${cut}, which the modelled income does not apply — deploy what the game shows ` +
            '(warapp_submit_turn takes a lower total when Sanctions are in the game).',
        );
      }
    }
    warnings.push('Active cards are read from the live board by an unverified decoder (#163): check them in the game.');
  }
  return { view, warnings };
}
