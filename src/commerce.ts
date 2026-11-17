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

/** Cities to build on one territory in a purchase order. */
export interface CityPurchase {
  territoryId: number;
  count: number;
}

/**
 * What a purchase order's cities cost, by the client's formula (`GameOrderPurchase`, client 6.08.0.2): per city,
 * CityBaseCost + (cities on that territory so far) × TerritoryCityCostIncrease + (my cities so far, everywhere — the
 * ones I own, then each earlier city of this order) × GlobalCityCostIncrease, the global count starting at 0 when its
 * increase is 0. `existing` gives the cities already on each territory, `myCities` all I own. `undefined` in a game
 * that allows no cities.
 */
export function cityPurchaseCost(
  rules: CommerceRules,
  order: readonly CityPurchase[],
  existing: ReadonlyMap<number, number>,
  myCities: number,
): number | undefined {
  if (rules.cityBaseCost === null) return undefined;
  let total = 0;
  let global = rules.globalCityCostIncrease === 0 ? 0 : whole(myCities);
  for (const { territoryId, count } of order) {
    let onTerritory = whole(existing.get(territoryId) ?? 0);
    for (let n = 0; n < count; n++) {
      total += rules.cityBaseCost + onTerritory * rules.territoryCityCostIncrease + global * rules.globalCityCostIncrease;
      onTerritory++;
      global++;
    }
  }
  return total;
}

/** One of my territories as the city advice weighs it. */
export interface CitySite {
  territoryId: number;
  /** No neighbour I do not hold: a city there is not on a front. */
  interior: boolean;
  cities: number;
}

/**
 * #332, advice only (never an order of the plan): the cheapest city I can place on an interior territory this turn,
 * and how many turns its income takes to repay its cost (`paysBackInTurns`, `worthIt` within `horizon` turns). A
 * city's gold comes out of this turn's deploy. `undefined` when the game allows no cities or pays nothing for them,
 * no interior territory is mine, or the gold does not cover one.
 */
export function cityAdvice(
  rules: CommerceRules,
  sites: readonly CitySite[],
  gold: number,
  horizon: number,
): { territoryId: number; cost: number; cityIncome: number; paysBackInTurns: number; worthIt: boolean; order: { territory: number; count: 1 } } | undefined {
  if (rules.cityBaseCost === null || !(rules.cityIncome > 0)) return undefined;
  const myCities = sites.reduce((n, s) => n + s.cities, 0);
  let best: { territoryId: number; cost: number } | undefined;
  for (const s of sites) {
    if (!s.interior) continue;
    const cost = cityPurchaseCost(rules, [{ territoryId: s.territoryId, count: 1 }], new Map([[s.territoryId, s.cities]]), myCities)!;
    if (!best || cost < best.cost || (cost === best.cost && s.territoryId < best.territoryId)) best = { territoryId: s.territoryId, cost };
  }
  if (!best || best.cost > gold) return undefined;
  const paysBackInTurns = Math.ceil(best.cost / rules.cityIncome);
  return {
    territoryId: best.territoryId,
    cost: best.cost,
    cityIncome: rules.cityIncome,
    paysBackInTurns,
    worthIt: paysBackInTurns <= horizon,
    order: { territory: best.territoryId, count: 1 },
  };
}
