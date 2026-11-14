// #226 review (whole branch): the margin on an attack on a player uses armies that would sit idle,
// never the leftover rule 5 deployed for a comfortable margin, to hold, or to save toward a step.
// The boards are the golden corpus's seeded synthetic ones (made-up ids and players).
import { describe, expect, it } from 'vitest';
import { planTurn, type TurnPlan } from '../../src/analysis/planner.js';
import { syntheticInput } from './golden/corpus.js';

/** Synthetic boards where the margin used to take from a source rule 5 had just made comfortable. */
const BOARDS = [144, 154, 162, 376, 448, 696, 877, 1063, 1093, 1144, 1181, 1573, 1591, 1627, 1698, 1820, 1899, 1943, 1968];

const leftoverLine = (p: TurnPlan, src: string) =>
  p.rationale.find((x) => new RegExp(`^Deploy (the leftover \\d+|\\d+ of the leftover) to .*\\(#${src}\\):`).test(x));
const marginSources = (p: TurnPlan) =>
  p.rationale.flatMap((line) => {
    const m = /^Margin on the attack on .* from .*? \(#(\d+)\) \(#226\)/.exec(line);
    return m ? [m[1]!] : [];
  });

describe('#226 review: the margin leaves rule 5 its comfort and saving deploys', () => {
  it.each(BOARDS)('synthetic board %i: no margin from a border the leftover made comfortable or saves on', (i) => {
    const p = planTurn(syntheticInput(i));
    for (const src of marginSources(p)) expect(leftoverLine(p, src) ?? '').not.toMatch(/comfortable margin|save toward/);
  });

  it('a margin from the expansion stack the leftover went to still stands', () => {
    let found = 0;
    for (let i = 0; i < 400 && found === 0; i++) {
      const p = planTurn(syntheticInput(i));
      for (const src of marginSources(p)) if (/the stack working on the top expansion/.test(leftoverLine(p, src) ?? '')) found++;
    }
    expect(found).toBeGreaterThan(0);
  });
});
