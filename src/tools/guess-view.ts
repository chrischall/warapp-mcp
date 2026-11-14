// warapp_plan_turn's `guess` (src/analysis/guess.ts): how it is shown, and the orders that carry it.

import type { BorderGuess } from '../analysis/guess.js';

type Named = { id: number; name: string };

/** One order of a plan's `orders`, as far as the guess needs it: only deploys are touched. */
type PlanOrder = { kind: string } & Record<string, unknown>;

const pct = (p: number) => `${Math.round(p * 100)}%`;
const r2 = (x: number) => Math.round(x * 100) / 100;

/** The guess for the tool: compact (borders by name with hold probability, losses, deploys, a sentence) or full. */
export function guessView(guess: BorderGuess, rung: string, name: (id: number) => Named, opponentName: string | null) {
  const label = (id: number) => `${name(id).name} (#${id})`;
  const deployed = guess.borders.map((b) => `${b.guessDeploy} on ${label(b.id)}`).join(', ');
  const odds = guess.borders
    .map((b) =>
      b.holdAloneProbability > b.holdProbability
        ? `${label(b.id)} holds everything ${pct(b.holdProbability)}, its stacks alone ${pct(b.holdAloneProbability)}`
        : `${label(b.id)} holds everything ${pct(b.holdProbability)}`,
    )
    .join('; ');
  const summary =
    `The opponent touches ${guess.borders.length} of your borders and the ${guess.budget} armies the plan deploys there ` +
    `cannot hold them all against its stacks plus its deploy of ${guess.enemyDeploy}: whichever split you fix, it can hit the ` +
    `border left short (worst case ${guess.fixedLoss} of ${guess.worthAtStake} worth at stake; the plan's split ${guess.planLoss}). ` +
    `Drawing the split at random, weighted by worth (${odds}), expects to lose ${r2(guess.mixedLoss)}. ` +
    `This turn's draw: ${deployed}. Optional — guessOrders carries it, orders keep the plan's split.`;
  const opponent = { id: guess.opponent, name: opponentName };
  const deploys = guess.deploys.map((d) => ({ territory: name(d.territoryId), armies: d.armies }));
  if (rung === 'compact')
    return {
      opponent,
      borders: guess.borders.map((b) => ({ ...name(b.id), holdProbability: b.holdProbability, holdAloneProbability: b.holdAloneProbability })),
      fixedLoss: guess.fixedLoss,
      mixedLoss: r2(guess.mixedLoss),
      planLoss: guess.planLoss,
      deploys,
      summary,
    };
  return {
    opponent,
    enemyDeploy: guess.enemyDeploy,
    budget: guess.budget,
    worthAtStake: guess.worthAtStake,
    borders: guess.borders.map((b) => ({ ...b, name: name(b.id).name })),
    fixedLoss: guess.fixedLoss,
    mixedLoss: guess.mixedLoss,
    planLoss: guess.planLoss,
    targets: guess.targets.map((t) => ({ ...name(t.id), probability: t.probability })),
    mix: guess.mix,
    allocation: guess.allocation,
    deploys,
    summary,
  };
}

/**
 * The plan's orders with the guess's deploys in place of the plan's: every deploy order replaced by
 * the guess's deploy list (same total), at the place the first deploy stood; every other order kept.
 */
export function guessOrdersOf<O extends PlanOrder>(orders: readonly O[], guess: BorderGuess): (O | { kind: 'deploy'; territory: number; armies: number })[] {
  const at = orders.findIndex((o) => o.kind === 'deploy');
  const rest = orders.filter((o) => o.kind !== 'deploy');
  const deploys = guess.deploys.map((d) => ({ kind: 'deploy' as const, territory: d.territoryId, armies: d.armies }));
  const index = at < 0 ? rest.length : orders.slice(0, at).filter((o) => o.kind !== 'deploy').length;
  return [...rest.slice(0, index), ...deploys, ...rest.slice(index)];
}
