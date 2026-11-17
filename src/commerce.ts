// Commerce games (#332): players earn gold, not armies, and buy armies (and, where the game allows, cities) with it.
//
// Every formula here is the client's own, read from the bundle (client 6.08.0.2, `warlight.shared.GameSettings` and
// `GameOrderPurchase`; never run): docs/WEB-PROTOCOL.md "Commerce" names what is verified live.
//
// - The army price (`CommerceArmyCostMultiplier`, m): with m = 0 an army always costs 1 gold. With m > 0 armies are
//   bought in batches of m each turn: the first m cost 1 gold each, the next m 2 each, and so on. A deploy is the
//   purchase ("Armies are automatically purchased as you deploy"): its cost is goldForArmies(already deployed this
//   turn + n) − goldForArmies(already deployed).
// - A city on a territory: CityBaseCost + (cities already on that territory) × TerritoryCityCostIncrease + (cities I
//   already own everywhere, then each earlier city in the same order) × GlobalCityCostIncrease; the global count
//   starts at 0 when GlobalCityCostIncrease is 0. Each city pays CityIncome gold a turn.
import type { GameSettings } from './normalize.js';

/** A commerce game's settings, as GameFeed's `Commerce` object gives them (missing ones defaulted). */
export interface CommerceRules {
  /** CommerceArmyCostMultiplier: 0 = one gold per army; m > 0 = batches of m at rising prices. */
  armyCostMultiplier: number;
  /** CommerceCityBaseCost: what the first city costs; `null` when the game allows no cities. */
  cityBaseCost: number | null;
  territoryCityCostIncrease: number;
  globalCityCostIncrease: number;
  /** Gold a city pays each turn. */
  cityIncome: number;
}

/** The commerce rules of a game, or `undefined` outside a commerce game or when its settings were not read. */
export function commerceRules(s: Pick<GameSettings, 'commerce' | 'commerceRules'> | undefined): CommerceRules | undefined {
  if (!s?.commerce || !s.commerceRules) return undefined;
  const r = s.commerceRules;
  return {
    armyCostMultiplier: r.armyCostMultiplier ?? 0,
    cityBaseCost: r.cityBaseCost ?? null,
    territoryCityCostIncrease: r.territoryCityCostIncrease ?? 0,
    globalCityCostIncrease: r.globalCityCostIncrease ?? 0,
    cityIncome: r.cityIncome ?? 0,
  };
}

const whole = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0);

/** The armies `gold` buys in one turn at multiplier `m` (the client's GameSettings function). */
export function armiesForGold(gold: number, m: number): number {
  let left = whole(gold);
  const batch = whole(m);
  if (batch === 0) return left;
  let armies = 0;
  for (let price = 1; left > 0; price++) {
    const n = Math.min(batch, Math.floor(left / price));
    if (n === 0) break;
    armies += n;
    left -= n * price;
  }
  return armies;
}

/** What `armies` cost in one turn at multiplier `m` (the client's GameSettings function). */
export function goldForArmies(armies: number, m: number): number {
  let left = whole(armies);
  const batch = whole(m);
  if (batch === 0) return left;
  let gold = 0;
  for (let price = 1; left > 0; price++) {
    gold += price * Math.min(batch, left);
    left -= batch;
  }
  return gold;
}

/** What `gold` buys as this turn's deploy: the armies, their cost and the gold left (which carries over). */
export function deployBudget(gold: number, m: number): { gold: number; armies: number; cost: number; left: number } {
  const g = whole(gold);
  const armies = armiesForGold(g, m);
  const cost = goldForArmies(armies, m);
  return { gold: g, armies, cost, left: g - cost };
}

/** This turn's deploy in a commerce game: what the gold buys, and where the gold figure came from. */
export interface CommerceDeploy {
  /** `standing`: my gold as the live standing shows it; `model`: the income model's figure (the gold was unreadable). */
  source: 'standing' | 'model';
  gold: number;
  armies: number;
  cost: number;
  /** Gold left after buying the armies: it carries over to the next turn. */
  left: number;
  armyCostMultiplier: number;
}

/**
 * The armies this turn's gold buys: the standing's gold when read (it already holds what was saved and any Sanctions,
 * since war.app pays it), else the modelled income.
 */
export function commerceDeploy(rules: CommerceRules, standingGold: number | undefined, modelGold: number): CommerceDeploy {
  const source = standingGold !== undefined ? 'standing' : 'model';
  const b = deployBudget(standingGold ?? modelGold, rules.armyCostMultiplier);
  return { source, ...b, armyCostMultiplier: rules.armyCostMultiplier };
}
