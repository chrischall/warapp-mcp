import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { normalizeSettings } from '../src/normalize.js';
import { KNOWN_MODS, LOCAL_DEPLOYMENT_HELPER } from '../src/known-mods.js';
import { modsWarning } from '../src/tools/turn.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/gamefeed-settings-45736172.json', import.meta.url), 'utf8')) as {
  settings: unknown;
};

describe('known mods (#mega part 4)', () => {
  it('game 45736172 runs the Local Deployment Helper and Diplomacy 2', () => {
    const s = normalizeSettings(fixture.settings);
    expect(s.modIds).toEqual([191, LOCAL_DEPLOYMENT_HELPER]);
    expect(s.localDeployments).toBe(true);
    expect(s.minimumArmyBonus).toBe(15);
    expect(s.bonusArmyPer).toBe(1);
  });

  it('no mods, no warning', () => {
    expect(modsWarning(undefined)).toEqual([]);
    expect(modsWarning({ cards: [], raw: {}, mods: 0, modIds: [] })).toEqual([]);
  });

  it('mods whose ids did not read keep the general warning', () => {
    const [w] = modsWarning({ cards: [], raw: {}, mods: 2 });
    expect(w).toMatch(/runs 2 mods: a mod can change the rules/);
  });

  it('only the Local Deployment Helper: its note, no "rules may not hold"', () => {
    const w = modsWarning({ cards: [], raw: {}, mods: 1, modIds: [LOCAL_DEPLOYMENT_HELPER] });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/Local Deployment Helper \(mod 336\)/);
    expect(w[0]).toMatch(/no rule during a turn/);
    expect(w[0]).not.toMatch(/may not hold/);
    expect(KNOWN_MODS.get(LOCAL_DEPLOYMENT_HELPER)?.turnRules).toBe(false);
  });

  it('an unknown mod beside it: the helper note plus the warning naming the unknown id', () => {
    const w = modsWarning({ cards: [], raw: {}, mods: 2, modIds: [191, LOCAL_DEPLOYMENT_HELPER] });
    expect(w).toHaveLength(2);
    expect(w[0]).toMatch(/mod 191/);
    expect(w[0]).toMatch(/may not hold/);
    expect(w[0]).not.toMatch(/336/);
    expect(w[1]).toMatch(/mod 336/);
  });
});
