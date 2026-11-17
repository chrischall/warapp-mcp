// #332: a commerce game's deploy this turn, for every tool that checks or plans a deploy total (warapp_plan_turn,
// warapp_submit_turn, warapp_check_plan): one computation, so the three never disagree.
import { commerceDeploy, commerceRules, type CommerceDeploy } from '../commerce.js';
import { inGameOf, standingGold } from '../live.js';
import type { Game, Player } from '../normalize.js';

/**
 * The armies my gold buys at the game's army price: from the standing's gold (`standingGold`) when it reads — it
 * already holds what was saved and any Sanctions, since war.app pays it — else from `modelGold` (the income model).
 * `undefined` outside a commerce game, or when its settings were not read.
 */
export function commerceDeployOf(game: Game, me: Player, info: unknown, modelGold: number): CommerceDeploy | undefined {
  const rules = commerceRules(game.settings);
  if (!rules) return undefined;
  const id = inGameOf(me);
  return commerceDeploy(rules, id === undefined ? undefined : standingGold(info, id), modelGold);
}

/**
 * What `warapp_submit_turn` checks a commerce deploy against (#353 review). Gold read from the board is authoritative,
 * so it is the deploy budget (`commerce`: deploying more than it buys is refused, error 597; less saves gold). Gold
 * from the income model leaves out what was saved on earlier turns, so it is not enforced: it adds an `uncertain`
 * reason instead, and a different total is a warning, as an uncertain income always was.
 */
export function submitCommerceCheck(c: CommerceDeploy | undefined): {
  commerce?: { gold: number; armyCostMultiplier: number };
  uncertain: string[];
} {
  if (!c) return { uncertain: [] };
  if (c.source === 'standing') return { commerce: { gold: c.gold, armyCostMultiplier: c.armyCostMultiplier }, uncertain: [] };
  return {
    uncertain: [
      `Your gold could not be read from the board, so the check uses the income model's ${c.gold}, which leaves out gold saved from earlier turns.`,
    ],
  };
}
