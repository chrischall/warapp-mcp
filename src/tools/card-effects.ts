// PLAN-TEAMS D3: the cards in effect on the live board that warapp_plan_turn and warapp_check_plan
// rely on — a Diplomacy card between me and a player (T9) and Sanctions on me — read by the
// unverified active-card decoder (`readActiveCards`, #163) and kept only when `cardsInEffect` is
// sure of them. Never throws: an unreadable board means no card.

import { cardsInEffect, sanctionedIncome, type CardsInEffect, type EffectPlayer } from '../analysis/cards-in-effect.js';
import { readActiveCards } from '../cards.js';
import { playersByInGameId } from '../live.js';
import type { Game, Player } from '../normalize.js';

/** {@link cardsInEffect} for `me` in `game` from a decoded LatestGameInfo; empty when nothing reads. */
export function boardCardsInEffect(game: Pick<Game, 'players' | 'settings'>, me: Pick<Player, 'id'>, turn: number | null, info: unknown): CardsInEffect {
  let active: ReturnType<typeof readActiveCards> = [];
  try {
    active = readActiveCards(info);
  } catch {
    active = [];
  }
  const players = new Map<number, EffectPlayer>();
  for (const [inGame, p] of playersByInGameId(game.players))
    players.set(inGame, { id: p.id, ...(p.team !== undefined ? { team: p.team } : {}), ...(p.state !== undefined ? { state: p.state } : {}) });
  return cardsInEffect({ active, players, me: me.id, turn, settings: game.settings });
}

/** The warning every plan relying on a decoded card carries. */
export const CARDS_IN_EFFECT_UNVERIFIED =
  'The cards in effect are read from the live board by an unverified decoder (#163, PLAN-TEAMS D3): check them in the game.';

/**
 * My income this turn under the Sanctions on me (the client bundle's rule), with the warning that says
 * so — or the income unchanged and why not, under Local Deployment (how the cut is taken from the
 * bonus pools is not modelled).
 */
export function sanctionMyIncome(
  income: number,
  effect: CardsInEffect,
  opts: { localDeployments?: boolean },
): { income: number; applied: boolean; warnings: string[] } {
  if (!effect.sanctionsOnMe.length) return { income, applied: false, warnings: [] };
  const pcts = effect.sanctionsOnMe.map((s) => s.percentage);
  const pctText = pcts.map((p) => `${Math.round(p * 100)}%`).join(' then ');
  const until = Math.max(...effect.sanctionsOnMe.map((s) => s.untilTurn));
  if (opts.localDeployments)
    return {
      income,
      applied: false,
      warnings: [
        `Sanctions are on you (${pctText}, until turn ${until}): under Local Deployment the plan does not know which pools the cut comes from, so it plans on ${income} — deploy what the game shows.`,
      ],
    };
  const cut = sanctionedIncome(income, pcts);
  return {
    income: cut,
    applied: true,
    warnings: [`Sanctions are on you (${pctText}, until turn ${until}): the plan's income is ${cut}, not ${income} (the client's rule, rounded to the nearest).`],
  };
}
