import { describe, expect, it } from 'vitest';
import { commerceDeploy, type CommerceRules } from '../src/commerce.js';
import { submitCommerceCheck } from '../src/tools/commerce-deploy.js';

// #353 review: the submit refuses a deploy above the gold only when the gold was read from the board. The income
// model's figure leaves out gold saved from earlier turns, so there a different total is a warning, as before #332.
const rules: CommerceRules = { armyCostMultiplier: 0, cityBaseCost: null, territoryCityCostIncrease: 0, globalCityCostIncrease: 0, cityIncome: 0 };

describe('submitCommerceCheck (#332, #353 review)', () => {
  it('outside a commerce game: nothing to check, nothing uncertain', () => {
    expect(submitCommerceCheck(undefined)).toEqual({ uncertain: [] });
  });

  it('gold read from the board: enforced as the deploy budget', () => {
    const r = submitCommerceCheck(commerceDeploy(rules, 9, 7));
    expect(r).toEqual({ commerce: { gold: 9, armyCostMultiplier: 0 }, uncertain: [] });
  });

  it('gold from the income model: not enforced, and the reason says saved gold is not counted', () => {
    const r = submitCommerceCheck(commerceDeploy(rules, undefined, 7));
    expect(r.commerce).toBeUndefined();
    expect(r.uncertain).toHaveLength(1);
    expect(r.uncertain[0]).toMatch(/gold could not be read.*7.*saved from earlier turns/i);
  });
});
