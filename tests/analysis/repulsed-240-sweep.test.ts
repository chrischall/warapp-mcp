// #240 review: evidence that an owner reinforces a territory must never make the plan worse at it
// than having no evidence at all. Over the golden corpus (every suite input, every DEFAULT_STRIDE-th
// synthetic board, plus the synthetic boards the review sweep found), every visible enemy territory
// next to mine is marked repulsed; for each one the plan attacks, the attack sends at least what the
// plan without the evidence sends, and carries no "assumes its owner does not reinforce" warning.
import { describe, expect, it } from 'vitest';
import { neighborsOf } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type RepulsedTarget, type TurnPlan } from '../../src/analysis/planner.js';
import { DEFAULT_STRIDE, SYNTHETIC_COUNT, suiteInputs, syntheticInput } from './golden/corpus.js';

/** Synthetic boards the review sweep (stride 1) found, off the default stride. */
const FOUND = [197, 879, 1107];

function repulsedNextToMe(input: PlanInput): RepulsedTarget[] {
  const mineSet = new Set(
    input.board.territories.filter((t) => t.owner.kind === 'player' && t.owner.playerId === input.me).map((t) => t.territoryId),
  );
  return input.board.territories.flatMap((t) =>
    t.owner.kind === 'player' && t.owner.playerId !== input.me && t.armies !== null && neighborsOf(input.graph, t.territoryId).some((n) => mineSet.has(n))
      ? [
          {
            territoryId: t.territoryId,
            playerId: t.owner.playerId,
            attacks: [
              { turn: 1, armies: 1, before: 1, after: 2, kills: 0 },
              { turn: 2, armies: 1, before: 2, after: 3, kills: 0 },
            ],
          },
        ]
      : [],
  );
}

const sentOn = (p: TurnPlan, t: number) => p.moves.filter((m) => m.kind === 'attack' && m.to === t).reduce((s, m) => s + m.armies, 0);
const assumes = (p: TurnPlan, t: number) => p.warnings.some((w) => w.startsWith('Attack on enemy') && w.includes(`(#${t}) assumes`));

describe('#240 review: a repulsed target is never attacked with fewer armies, or a worse warning, than without the evidence', () => {
  it('holds across the golden corpus', () => {
    const inputs: [string, PlanInput][] = [
      ...suiteInputs().map((x, i): [string, PlanInput] => [`suite ${i}`, x]),
      ...Array.from({ length: SYNTHETIC_COUNT }, (_, i) => i)
        .filter((i) => i % DEFAULT_STRIDE === 0 || FOUND.includes(i))
        .map((i): [string, PlanInput] => [`synthetic ${i}`, syntheticInput(i)]),
    ];
    const problems: string[] = [];
    let checked = 0;
    for (const [name, input] of inputs) {
      const repulsed = repulsedNextToMe(input);
      if (!repulsed.length) continue;
      const plain = planTurn(input);
      const p = planTurn({ ...input, repulsed });
      for (const { territoryId: t } of repulsed) {
        // Only a territory the plan sizes as repulsed (its #240 rationale line) and attacks.
        if (!p.rationale.some((l) => l.startsWith('My attacks on ') && l.includes(`(#${t}) failed`))) continue;
        const sent = sentOn(p, t);
        if (sent === 0) continue;
        checked++;
        const before = sentOn(plain, t);
        if (before > sent) problems.push(`${name}: T${t} ${before} → ${sent}`);
        if (assumes(p, t)) problems.push(`${name}: T${t} sized for the deploy, still warned "assumes"`);
      }
    }
    expect(checked).toBeGreaterThan(50);
    expect(problems).toEqual([]);
  }, 120_000);
});
