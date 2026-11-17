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
