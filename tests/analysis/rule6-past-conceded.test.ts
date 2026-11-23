// Rule 6 when every route to a front crosses a conceded border (owner, 2026-11-22): golden synthetic board 246.
// Once #426 takes its last neutral (T14), no territory not mine is reachable without crossing a border the plan
// concedes, and the enemy lies past those borders. The idle stacks then had no target at all and stood deep
// inside (7 interior transfers vanished). They now walk up behind the conceded borders — never into one, and a
// stack already beside one waits there (#367).
import { describe, expect, it } from 'vitest';
import { planTurn } from '../../src/analysis/planner.js';
import { syntheticInput } from './golden/corpus.js';

describe('rule 6 with the only fronts past conceded borders', () => {
  const input = syntheticInput(246);
  const plan = planTurn(input);
  const conceded = new Set(
    plan.warnings.flatMap((w) => [...w.matchAll(/#(\d+)\) cannot be held[^:]*: conceded$/g)].map((m) => Number(m[1]))),
  );
  const idle = plan.moves.filter((m) => m.kind === 'transfer' && /idle interior armies/.test(m.reason));

  it('takes the last neutral (the #426 capture that left no other front)', () => {
    expect(plan.moves.some((m) => m.kind === 'attack' && m.to === 14)).toBe(true);
  });

  it('still walks idle interior stacks toward the conceded borders, never into one', () => {
    expect(conceded.size).toBeGreaterThan(0);
    expect(idle.length).toBeGreaterThan(0);
    for (const m of idle) expect(conceded.has(m.to)).toBe(false);
    expect(plan.rationale.join('\n')).toMatch(/no front is reachable without crossing a border the plan concedes: they walk up behind T13 \(#13\)/);
  });
});
