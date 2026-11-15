// #240 review: evidence that an owner reinforces a territory must never make the plan worse at it
// than having no evidence at all. Over the golden corpus (every suite input, every DEFAULT_STRIDE-th
// synthetic board, plus the synthetic boards the review sweep found), every visible enemy territory
// next to mine is marked repulsed; for each one the plan attacks, the attack sends at least what the
// plan without the evidence sends, and carries no "assumes its owner does not reinforce" warning.
import { describe, expect, it } from 'vitest';
import { neighborsOf } from '../../src/analysis/graph.js';
import { planTurn, type PlanInput, type RepulsedTarget, type TurnPlan } from '../../src/analysis/planner.js';
import type { BoardState } from '../../src/board.js';
import { DEFAULT_STRIDE, SYNTHETIC_COUNT, suiteInputs, syntheticInput } from './golden/corpus.js';

/**
 * #272: the evidence's reinforcement each turn, above any deploy estimate, so every repulsed territory is
 * sized for its owner's whole deploy (the most it reinforced, never above the estimate) as #240 sized it.
 */
const REINFORCED = 1000;

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
              { turn: 1, armies: 1, before: 1, after: REINFORCED, kills: 0 },
              { turn: 2, armies: 1, before: REINFORCED, after: 2 * REINFORCED, kills: 0 },
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

// #240 review, second round. One territory at a time, every player territory the plan without the
// evidence attacks is marked repulsed, over every suite input and EVERY synthetic board (the stride
// above hid these). Two failures: (1) the plain plan already sent at least the sure size (defenders
// plus the owner's deploy), and with the evidence the territory is not attacked at all — the sure cost
// only demoted it in a ranking (rule 4e's fallback, the counter-attack ranking, the costs-nothing
// fallback), most often under No-Split, where the whole stack goes anyway; (2) a pass attacks it with
// a single attack below that sure size (the pressure pass's partial share, the guard-off one army,
// finish-off's own smaller estimate) while the #240 line says the attack "is sized for its owner's
// deploy there … or not made". A combined capture (several attacks on it) is exempt: its total is
// sized against the reinforced target.
function ownerOf(b: BoardState, t: number): number | undefined {
  const o = b.territories.find((x) => x.territoryId === t)?.owner;
  return o?.kind === 'player' ? o.playerId : undefined;
}

describe('#240 review: one repulsed territory at a time, across the whole corpus', () => {
  it('a repulsed target that fits is still attacked, and never with one attack below its sure size', () => {
    const inputs: [string, PlanInput][] = [
      ...suiteInputs().map((x, i): [string, PlanInput] => [`suite ${i}`, x]),
      ...Array.from({ length: SYNTHETIC_COUNT }, (_, i): [string, PlanInput] => [`synthetic ${i}`, syntheticInput(i)]),
    ];
    const dropped: string[] = [];
    const under: string[] = [];
    let marked = 0;
    for (const [name, input] of inputs) {
      const plain = planTurn(input);
      const hit = [...new Set(plain.moves.filter((m) => m.kind === 'attack').map((m) => m.to))].sort((a, b) => a - b);
      for (const t of hit) {
        const owner = ownerOf(input.board, t);
        if (owner === undefined || owner === input.me) continue;
        const p = planTurn({
          ...input,
          repulsed: [
            {
              territoryId: t,
              playerId: owner,
              attacks: [
                { turn: 1, armies: 1, before: 1, after: REINFORCED, kills: 0 },
                { turn: 2, armies: 1, before: REINFORCED, after: 2 * REINFORCED, kills: 0 },
              ],
            },
          ],
        });
        const line = p.rationale.find((l) => l.startsWith('My attacks on ') && l.includes(`(#${t}) failed`));
        if (!line) continue;
        marked++;
        const sure = Number(/defenders, (\d+) armies\), or not made/.exec(line)![1]);
        const before = sentOn(plain, t);
        const attacks = p.moves.filter((m) => m.kind === 'attack' && m.to === t);
        const sent = sentOn(p, t);
        if (before >= sure && sent === 0) dropped.push(`${name}: T${t} ${before} >= ${sure} -> 0`);
        if (attacks.length === 1 && sent < sure) under.push(`${name}: T${t} ${sent} < ${sure} (${attacks[0]!.reason.slice(0, 60)})`);
      }
    }
    expect(marked).toBeGreaterThan(500);
    expect(dropped).toEqual([]);
    expect(under).toEqual([]);
  }, 300_000);
});
